//! Port of electron/race-guard.ts: follows the race through the local server's health check,
//! keeps the laptop and screen awake while it runs, and says whether closing needs a question.
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const CHECK_INTERVAL: Duration = Duration::from_secs(5);
static RACE_ACTIVE: AtomicBool = AtomicBool::new(false);

/// True while the race runs, as the local server last reported it.
pub fn is_race_active() -> bool {
    RACE_ACTIVE.load(Ordering::SeqCst)
}

/// `race.active` from `/api/health`; None when the answer has no such boolean.
pub fn race_active(health: &Value) -> Option<bool> {
    health["race"]["active"].as_bool()
}

/// The new state when it changed. An unreadable answer keeps the last known state.
pub fn observe(current: bool, health: Option<&Value>) -> Option<bool> {
    health
        .and_then(race_active)
        .filter(|active| *active != current)
}

#[derive(Debug, PartialEq, Eq)]
pub enum Close {
    /// Save the window state and close.
    Proceed,
    /// Ask "De wedstrijd loopt nog. Toch afsluiten?" first.
    Ask,
}

pub fn on_close(race_active: bool, confirmed: bool) -> Close {
    if confirmed || !race_active {
        Close::Proceed
    } else {
        Close::Ask
    }
}

/// Starts the watcher thread once; `on_change` runs on each change (for the log).
pub fn watch(base_url: String, on_change: impl Fn(bool) + Send + 'static) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(2))
            .build();
        let mut awake = KeepAwake::default();
        loop {
            let health = client
                .as_ref()
                .ok()
                .and_then(|c| c.get(format!("{base_url}/api/health")).send().ok())
                .and_then(|r| r.json::<Value>().ok());
            if let Some(active) = observe(is_race_active(), health.as_ref()) {
                RACE_ACTIVE.store(active, Ordering::SeqCst);
                awake.set(active);
                on_change(active);
            }
            std::thread::sleep(CHECK_INTERVAL);
        }
    });
}

/// Keeps the display and the system awake while held.
#[derive(Default)]
pub struct KeepAwake {
    on: bool,
    child: Option<std::process::Child>,
    #[cfg(windows)]
    stop: Option<std::sync::mpsc::Sender<()>>,
}

impl KeepAwake {
    pub fn set(&mut self, on: bool) {
        if on == self.on {
            return;
        }
        self.on = on;
        if !on {
            if let Some(mut child) = self.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            #[cfg(windows)]
            {
                self.stop = None;
            }
            return;
        }
        let pid = std::process::id().to_string();
        #[cfg(target_os = "linux")]
        {
            // The inhibitor holds while `tail` waits for this process, so it never outlives the app.
            self.child = std::process::Command::new("systemd-inhibit")
                .args([
                    "--what=sleep:idle",
                    "--who=Apolloon Telsysteem",
                    "--why=De wedstrijd loopt",
                    "--mode=block",
                    "tail",
                    &format!("--pid={pid}"),
                    "-f",
                    "/dev/null",
                ])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .ok();
        }
        #[cfg(target_os = "macos")]
        {
            self.child = std::process::Command::new("caffeinate")
                .args(["-d", "-i", "-w", &pid])
                .spawn()
                .ok();
        }
        #[cfg(windows)]
        {
            let _ = pid;
            // The request belongs to the thread that made it, so one thread holds it.
            #[link(name = "kernel32")]
            unsafe extern "system" {
                fn SetThreadExecutionState(flags: u32) -> u32;
            }
            const CONTINUOUS: u32 = 0x8000_0000;
            const SYSTEM: u32 = 0x1;
            const DISPLAY: u32 = 0x2;
            let (stop, wait) = std::sync::mpsc::channel::<()>();
            std::thread::spawn(move || unsafe {
                SetThreadExecutionState(CONTINUOUS | SYSTEM | DISPLAY);
                let _ = wait.recv();
                SetThreadExecutionState(CONTINUOUS);
            });
            self.stop = Some(stop);
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
        let _ = pid;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn race_changes_follow_health_and_unreadable_answers_keep_the_state() {
        let running = json!({"race":{"active":true}});
        assert_eq!(observe(false, Some(&running)), Some(true));
        assert_eq!(observe(true, Some(&running)), None);
        assert_eq!(observe(true, Some(&json!({"race":{"active":"yes"}}))), None);
        assert_eq!(observe(true, None), None);
        assert_eq!(
            observe(true, Some(&json!({"race":{"active":false}}))),
            Some(false)
        );
    }
    #[test]
    fn closing_asks_only_while_the_race_runs_and_not_after_confirmation() {
        assert_eq!(on_close(false, false), Close::Proceed);
        assert_eq!(on_close(true, false), Close::Ask);
        assert_eq!(on_close(true, true), Close::Proceed);
    }
}
