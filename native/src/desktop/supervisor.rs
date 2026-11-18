//! The local server as a child process (`apolloon-native --server`), as electron/main.ts forks
//! it: output to `server.log`, restarted with a back-off when it stops unexpectedly, and a
//! start that reports why it failed.
use super::startup_error::StartupFailure;
use std::collections::BTreeMap;
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const SERVER_LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;

static LOG: OnceLock<Mutex<Option<(PathBuf, std::fs::File)>>> = OnceLock::new();

pub fn timestamp() -> String {
    chrono::DateTime::from_timestamp_millis(crate::db::now())
        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

/// Opens `server.log`, started over once it grows past a few MB.
pub fn open_log(path: &Path) {
    let too_large = std::fs::metadata(path)
        .map(|m| m.len() > SERVER_LOG_MAX_BYTES)
        .unwrap_or(false);
    let _ = path.parent().map(std::fs::create_dir_all);
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(!too_large)
        .truncate(too_large)
        .open(path);
    match file {
        Ok(file) => {
            *LOG.get_or_init(|| Mutex::new(None)).lock().unwrap() = Some((path.to_path_buf(), file))
        }
        Err(error) => eprintln!("Server log unavailable: {error}"),
    }
}

pub fn log_path() -> Option<PathBuf> {
    LOG.get()?.lock().ok()?.as_ref().map(|(p, _)| p.clone())
}

fn write_log(bytes: &[u8]) {
    if let Some(lock) = LOG.get() {
        if let Some((_, file)) = lock.lock().unwrap().as_mut() {
            let _ = file.write_all(bytes);
        }
    }
}

/// Lines from the desktop app itself, among the server's.
pub fn desktop_log(message: &str) {
    println!("{message}");
    write_log(format!("[desktop {}] {message}\n", timestamp()).as_bytes());
}

/// The last lines of a log file; empty when there is none yet.
pub fn read_log_tail(path: &Path, lines: usize) -> String {
    let Ok(mut file) = std::fs::File::open(path) else {
        return String::new();
    };
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let length = size.min(16 * 1024);
    use std::io::Seek;
    let _ = file.seek(std::io::SeekFrom::Start(size - length));
    let mut buffer = Vec::new();
    let _ = file.read_to_end(&mut buffer);
    let text = String::from_utf8_lossy(&buffer);
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..]
        .join("\n")
        .trim()
        .to_string()
}

/// Delay before the next restart, doubling while it keeps crashing right after starting.
pub fn next_delay(previous: Duration, ran_for: Duration) -> Duration {
    if ran_for < Duration::from_secs(30) {
        (previous * 2).min(Duration::from_secs(30))
    } else {
        Duration::from_secs(1)
    }
}

#[derive(Default)]
struct Inner {
    child: Option<Child>,
    lifeline: Option<std::process::ChildStdin>,
    generation: u64,
    exit: Option<Option<i32>>,
    quitting: bool,
    error_tail: String,
}

#[derive(Clone, Default)]
pub struct Supervisor {
    inner: Arc<Mutex<Inner>>,
}

impl Supervisor {
    /// Starts the server and keeps it running until `stop` or `drop_server`.
    pub fn launch(&self, env: BTreeMap<String, String>, data_dir: PathBuf) -> Result<(), String> {
        self.launch_with(env, data_dir, Duration::from_secs(1))
    }

    fn launch_with(
        &self,
        env: BTreeMap<String, String>,
        data_dir: PathBuf,
        delay: Duration,
    ) -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let _ = std::fs::create_dir_all(&data_dir);
        let mut child = Command::new(exe)
            .arg("--server")
            .envs(&env)
            .env("APOLLOON_SUPERVISED", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start server: {e}"))?;
        write_log(
            format!(
                "\n--- server start {} ({}) ---\n",
                timestamp(),
                super::version()
            )
            .as_bytes(),
        );
        // The server ends when this pipe closes, also when the desktop app crashes (lifeline).
        let lifeline = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let generation = {
            let mut inner = self.inner.lock().unwrap();
            inner.generation += 1;
            inner.exit = None;
            inner.child = Some(child);
            inner.lifeline = lifeline;
            inner.generation
        };
        if let Some(out) = stdout {
            std::thread::spawn(move || {
                for line in std::io::BufReader::new(out)
                    .split(b'\n')
                    .map_while(Result::ok)
                {
                    println!("{}", String::from_utf8_lossy(&line));
                    write_log(&[line.as_slice(), b"\n"].concat());
                }
            });
        }
        if let Some(err) = stderr {
            let inner = self.inner.clone();
            std::thread::spawn(move || {
                for line in std::io::BufReader::new(err)
                    .split(b'\n')
                    .map_while(Result::ok)
                {
                    eprintln!("{}", String::from_utf8_lossy(&line));
                    write_log(&[line.as_slice(), b"\n"].concat());
                    let mut inner = inner.lock().unwrap();
                    inner.error_tail.push_str(&String::from_utf8_lossy(&line));
                    inner.error_tail.push('\n');
                    let cut = inner.error_tail.len().saturating_sub(4000);
                    let cut = (cut..inner.error_tail.len())
                        .find(|i| inner.error_tail.is_char_boundary(*i))
                        .unwrap_or(0);
                    inner.error_tail.drain(..cut);
                }
            });
        }
        let this = self.clone();
        let started = Instant::now();
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_millis(200));
                let mut inner = this.inner.lock().unwrap();
                if inner.generation != generation {
                    return;
                }
                let Some(child) = inner.child.as_mut() else {
                    return;
                };
                let Ok(Some(status)) = child.try_wait() else {
                    continue;
                };
                inner.exit = Some(status.code());
                inner.child = None;
                inner.lifeline = None;
                if inner.quitting {
                    return;
                }
                drop(inner);
                desktop_log(&format!(
                    "Server exited with code {:?}; restarting in {} ms",
                    status.code(),
                    delay.as_millis()
                ));
                std::thread::sleep(delay);
                let inner = this.inner.lock().unwrap();
                // A failed start that is being retried has replaced or dropped this server already.
                if inner.quitting || inner.generation != generation {
                    return;
                }
                drop(inner);
                if let Err(error) =
                    this.launch_with(env, data_dir, next_delay(delay, started.elapsed()))
                {
                    desktop_log(&error);
                }
                return;
            }
        });
        Ok(())
    }

    /// Waits until the server answers; says why when it stopped or did not answer in time.
    pub fn wait_for_server(
        &self,
        url: &str,
        port: u16,
        timeout: Duration,
    ) -> Result<(), StartupFailure> {
        let deadline = Instant::now() + timeout;
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(1))
            .build()
            .map_err(|e| StartupFailure::Other {
                text: e.to_string(),
            })?;
        while Instant::now() < deadline {
            {
                let inner = self.inner.lock().unwrap();
                if let Some(code) = inner.exit {
                    return Err(StartupFailure::ServerExited {
                        exit_code: code,
                        error_output: inner.error_tail.clone(),
                        port,
                    });
                }
            }
            if client
                .get(format!("{url}/api/health"))
                .send()
                .is_ok_and(|r| r.status().is_success())
            {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        Err(StartupFailure::ServerTimeout {
            seconds: timeout.as_secs(),
            port,
        })
    }

    /// Stops a server that failed to start, without the automatic restart, so a retry starts clean.
    pub fn drop_server(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.generation += 1;
        inner.lifeline = None;
        if let Some(mut child) = inner.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        inner.exit = None;
        inner.error_tail.clear();
    }

    pub fn stop(&self) {
        self.inner.lock().unwrap().quitting = true;
        self.drop_server();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restarts_back_off_while_crashing_right_after_start() {
        let s = Duration::from_secs;
        assert_eq!(next_delay(s(1), s(2)), s(2));
        assert_eq!(next_delay(s(20), s(2)), s(30));
        assert_eq!(next_delay(s(16), s(60)), s(1));
    }
    #[test]
    fn log_tail_keeps_the_last_lines() {
        let path = std::env::temp_dir().join(format!("apolloon-tail-{}.log", std::process::id()));
        std::fs::write(
            &path,
            (1..=100).map(|i| format!("line {i}\n")).collect::<String>(),
        )
        .unwrap();
        assert_eq!(read_log_tail(&path, 2), "line 99\nline 100");
        assert_eq!(read_log_tail(&path.with_extension("missing"), 2), "");
        std::fs::remove_file(path).unwrap();
    }
}

/// In the server process: exit once the desktop app that started it is gone.
pub fn follow_lifeline() {
    if std::env::var_os("APOLLOON_SUPERVISED").is_none() {
        return;
    }
    std::thread::spawn(|| {
        let _ = std::io::copy(&mut std::io::stdin(), &mut std::io::sink());
        std::process::exit(0);
    });
}
