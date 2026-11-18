//! Desktop integrations of the native app, ported from electron/*.ts: start screen and start
//! errors, the supervised local server, single instance, window state, keep-awake and close
//! confirmation during the race, logs and diagnostics, network setup and updates.
#![allow(dead_code)]
#[cfg(feature = "desktop")]
pub mod chrome;
pub mod config;
#[cfg(feature = "desktop")]
pub mod installer;
pub mod net_setup;
pub mod race_guard;
pub mod startup_error;
pub mod supervisor;
pub mod updates;
pub mod window_state;

use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

pub fn version() -> &'static str {
    env!("APOLLOON_VERSION")
}

/// Where the database, `.env`, `server.log`, `window-state.json` and backups live.
pub struct Paths {
    pub data: PathBuf,
    pub db: PathBuf,
}

pub fn paths() -> Paths {
    let absolute = |p: PathBuf| {
        if p.is_absolute() {
            p
        } else {
            std::env::current_dir().unwrap_or_default().join(p)
        }
    };
    if let Some(db) = std::env::var_os("APOLLOON_NATIVE_DATA").map(PathBuf::from) {
        let db = absolute(db);
        return Paths {
            data: db.parent().map(PathBuf::from).unwrap_or_default(),
            db,
        };
    }
    if config::packaged() {
        let data = config::user_data_dir();
        return Paths {
            db: data.join("data/app.db"),
            data,
        };
    }
    let data = absolute(PathBuf::from(".native-data"));
    Paths {
        db: data.join("app.db"),
        data,
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Phase {
    Starting {
        status: String,
        since: std::time::Instant,
    },
    Failed(startup_error::StartupMessage),
    Ready,
}

pub struct Desktop {
    pub phase: Phase,
    pub ask_close: bool,
    pub quit_confirmed: bool,
    pub full_screen: bool,
    pub focused: bool,
    pub updates: updates::Flow,
    pub last_install: Option<(String, bool)>,
    staged: Option<PathBuf>,
    url: String,
    data: PathBuf,
    env: std::collections::BTreeMap<String, String>,
}

static DESKTOP: OnceLock<Mutex<Desktop>> = OnceLock::new();
static SUPERVISOR: OnceLock<supervisor::Supervisor> = OnceLock::new();
type Hook = Box<dyn Fn(Request) + Send + Sync>;
static HOOK: OnceLock<Hook> = OnceLock::new();

/// What a background thread asks of the window.
pub enum Request {
    Wake,
    Show,
    Quit,
}

pub fn set_hook(hook: Hook) {
    let _ = HOOK.set(hook);
}
fn request(r: Request) {
    if let Some(hook) = HOOK.get() {
        hook(r);
    }
}

/// The desktop state; None in headless runs, tests and `--server`.
pub fn with<R>(f: impl FnOnce(&mut Desktop) -> R) -> Option<R> {
    DESKTOP.get().map(|d| f(&mut d.lock().unwrap()))
}

fn set_phase(phase: Phase) {
    with(|d| d.phase = phase);
    request(Request::Wake);
}

/// Prepares the desktop app: returns false when another instance runs (it was brought forward).
#[cfg(feature = "desktop")]
pub fn boot() -> bool {
    if !rune::single_instance("be.apolloon.telsysteem") {
        return false;
    }
    let paths = paths();
    let _ = std::fs::create_dir_all(&paths.data);
    supervisor::open_log(&paths.data.join("server.log"));
    let mut env = std::collections::BTreeMap::new();
    if let Ok(path) = config::ensure_env_file(&paths.data) {
        env = config::parse_env_text(&std::fs::read_to_string(path).unwrap_or_default());
    }
    if !env.contains_key("PORT") {
        if let Ok(port) = std::env::var("PORT") {
            env.insert("PORT".into(), port);
        }
    }
    let address = config::resolve_server_address(&env);
    env.insert("PORT".into(), address.port.to_string());
    env.insert("PUBLIC_APP_PORT".into(), address.public_port.to_string());
    env.insert(
        "APOLLOON_NATIVE_DATA".into(),
        paths.db.display().to_string(),
    );
    env.insert("APOLLOON_APP_VERSION".into(), version().into());
    let web = config::current_web_dir();
    let web = if web.is_absolute() {
        web
    } else {
        std::env::current_dir().unwrap_or_default().join(web)
    };
    env.insert("APOLLOON_WEB_DIR".into(), web.display().to_string());
    // The window's own requests go to this port too (ui.rs reads PORT).
    unsafe { std::env::set_var("PORT", address.port.to_string()) };
    let note = paths.data.join("update-install.json");
    let last_install = std::fs::read_to_string(&note).ok().and_then(|text| {
        let _ = std::fs::remove_file(&note);
        updates::install_outcome(Some(&text), version())
    });
    if let Some((v, ok)) = &last_install {
        supervisor::desktop_log(&if *ok {
            format!("Updated to {}", version())
        } else {
            format!("Update to {v} did not install; still {}", version())
        });
    }
    let _ = DESKTOP.set(Mutex::new(Desktop {
        phase: Phase::Starting {
            status: "Apolloon starten…".into(),
            since: std::time::Instant::now(),
        },
        ask_close: false,
        quit_confirmed: false,
        full_screen: false,
        focused: true,
        updates: updates::Flow::new(config::packaged()),
        last_install,
        staged: None,
        url: address.url,
        data: paths.data,
        env,
    }));
    let _ = SUPERVISOR.set(supervisor::Supervisor::default());
    std::thread::spawn(open_app);
    // The start screen shows after half a second, and its note after eight.
    std::thread::spawn(|| {
        for wait in [520, 7_500] {
            std::thread::sleep(std::time::Duration::from_millis(wait));
            request(Request::Wake);
        }
    });
    true
}

/// Starts the server and waits for it (openApp); a failure shows the error screen.
fn open_app() {
    let Some((url, env, data)) = with(|d| (d.url.clone(), d.env.clone(), d.data.clone())) else {
        return;
    };
    let supervisor = SUPERVISOR.get().unwrap();
    with(|d| {
        d.phase = Phase::Starting {
            status: "Databank openen…".into(),
            since: match &d.phase {
                Phase::Starting { since, .. } => *since,
                _ => std::time::Instant::now(),
            },
        }
    });
    request(Request::Wake);
    let port = env["PORT"].parse().unwrap_or(5173);
    let result = supervisor
        .launch(env, data.clone())
        .map_err(|text| startup_error::StartupFailure::Other { text })
        .and_then(|()| supervisor.wait_for_server(&url, port, std::time::Duration::from_secs(20)));
    match result {
        Ok(()) => {
            race_guard::watch(url, |active| {
                supervisor::desktop_log(if active {
                    "Race running: keeping the screen awake"
                } else {
                    "Race stopped"
                });
                request(Request::Wake);
            });
            set_phase(Phase::Ready);
            start_update_checks();
        }
        Err(failure) => {
            supervisor::desktop_log(&format!("Start failed: {failure}"));
            // No restarts behind the question: a retry starts the server once, from the beginning.
            supervisor.drop_server();
            let log = data.join("server.log").display().to_string();
            set_phase(Phase::Failed(startup_error::describe(&failure, &log)));
            request(Request::Show);
        }
    }
}

pub fn retry_start() {
    set_phase(Phase::Starting {
        status: "Opnieuw proberen…".into(),
        since: std::time::Instant::now() - std::time::Duration::from_secs(1),
    });
    std::thread::spawn(open_app);
}

/// Stops the server for good; called once the window really closes.
pub fn shut_down() {
    if let Some(s) = SUPERVISOR.get() {
        s.stop();
    }
}

pub fn data_dir() -> Option<PathBuf> {
    with(|d| d.data.clone())
}

/// Opens a folder in the system's file manager (the data folder: log, database, backups).
pub fn open_folder(path: &std::path::Path) -> Result<(), String> {
    let program = if cfg!(windows) {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program)
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// What the person who supports this laptop needs to know, for "Diagnose kopiëren".
pub fn diagnostics() -> Value {
    let data = data_dir().unwrap_or_else(|| paths().data);
    json!({
        "appVersion": version(),
        "runtime": "rust",
        "os": format!("{} {} {}", std::env::consts::OS, os_release(), std::env::consts::ARCH),
        "dataPath": data.display().to_string(),
        "logTail": supervisor::read_log_tail(&data.join("server.log"), 60),
    })
}

fn os_release() -> String {
    std::fs::read_to_string("/proc/sys/kernel/osrelease")
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// Every six hours from ten seconds after the start; APOLLOON_UPDATE_CHECK=0 turns it off.
fn start_update_checks() {
    static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if std::env::var("APOLLOON_UPDATE_CHECK").as_deref() == Ok("0")
        || STARTED.swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        return;
    }
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(
            updates::FIRST_CHECK_DELAY_SECS,
        ));
        loop {
            check_for_update();
            std::thread::sleep(std::time::Duration::from_secs(updates::CHECK_INTERVAL_SECS));
        }
    });
}

fn flush_update_log(flow: &mut updates::Flow) {
    for line in flow.log.drain(..) {
        supervisor::desktop_log(&line);
    }
}

/// Beheer › Systeem "Nu controleren" (apolloon:check-update). Blocks for the check and download.
pub fn check_for_update() -> Value {
    let Some(previous) = with(|d| {
        let previous = d.updates.status.clone();
        d.updates.begin_check().then_some(previous)
    }) else {
        return Value::Null;
    };
    let Some(previous) = previous else {
        return update_status();
    };
    request(Request::Wake);
    let result = updates::check_release(version(), crate::db::now());
    let download = with(|d| {
        let r = d.updates.finish_check(&previous, result, crate::db::now());
        flush_update_log(&mut d.updates);
        r
    })
    .flatten();
    request(Request::Wake);
    #[cfg(feature = "desktop")]
    if let Some(update) = download {
        let cache = data_dir().unwrap_or_default().join("updates");
        let result = installer::download(&update, &cache, &|percent| {
            with(|d| d.updates.progress(percent));
            request(Request::Wake);
        });
        with(|d| {
            d.staged = result.as_ref().ok().cloned();
            d.updates.downloaded(result.map(|_| ()), crate::db::now());
            flush_update_log(&mut d.updates);
        });
        request(Request::Wake);
    }
    #[cfg(not(feature = "desktop"))]
    let _ = download;
    update_status()
}

pub fn update_status() -> Value {
    with(|d| d.updates.status.to_json()).unwrap_or_else(|| json!({"state":"idle","checkedAt":null}))
}

/// Handles the actions owned by the desktop process. The updater's state lives with the window,
/// while the HTTP server can run in a separate process.
pub fn control(method: &str, input: &Value) -> Option<Result<Value, String>> {
    Some(match method {
        "update.status" => Ok(json!({
            "status": update_status(),
            "lastInstall": with(|d| d.last_install.clone()).flatten()
                .map(|(version, ok)| json!({"version":version,"ok":ok})),
        })),
        "update.check" if DESKTOP.get().is_some() => {
            std::thread::spawn(check_for_update);
            Ok(json!({"started":true}))
        }
        #[cfg(feature = "desktop")]
        "update.install" if DESKTOP.get().is_some() => Ok(json!({"problem": install_update()})),
        "update.check" | "update.install" => Err("Open deze actie in de desktopapp op deze laptop.".into()),
        "desktop.diagnostics" => Ok(diagnostics()),
        "desktop.openUrl" => {
            open_folder(std::path::Path::new(input["url"].as_str().unwrap_or("")))
                .map(|_| json!({"ok":true}))
        }
        _ => return None,
    })
}

#[cfg(feature = "desktop")]
fn create_update_backup(url: &str) -> Result<(), String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .and_then(|client| client.post(format!("{url}/api/action/backups.create")).json(&json!({})).send())
        .map_err(|error| error.to_string())?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!("server antwoordde {}", response.status().as_u16()))
    }
}

/// Beheer › Systeem "Installeren" (apolloon:install-update): null when the app restarts into
/// the new version, else the reason it did not.
#[cfg(feature = "desktop")]
pub fn install_update() -> Option<String> {
    let url = with(|d| d.url.clone())?;
    let mut flow = with(|d| {
        let in_app = d.updates.in_app;
        std::mem::replace(&mut d.updates, updates::Flow::new(in_app))
    })?;
    let staged = with(|d| d.staged.clone()).flatten();
    let data = data_dir().unwrap_or_default();
    let result = flow.install(
        &race_guard::is_race_active,
        || create_update_backup(&url),
        |update| {
            let staged = staged.ok_or("het pakket is niet gedownload")?;
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            installer::apply(&staged, exe.parent().ok_or("geen installatiemap")?)?;
            std::fs::write(
                data.join("update-install.json"),
                json!({"version":update.version,"from":version()}).to_string(),
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        },
    );
    with(|d| {
        flush_update_log(&mut flow);
        d.updates = flow;
    });
    request(Request::Wake);
    if result.is_none() {
        // The executable on disk was replaced. Wait for this process to release the instance
        // before Rune lets the new executable open.
        let exe = std::env::current_exe().ok().map(|e| {
            e.with_file_name(if cfg!(windows) {
                "apolloon-native.exe"
            } else {
                "apolloon-native"
            })
        });
        let relaunch = exe.ok_or_else(|| std::io::Error::other("geen installatiepad")).and_then(|exe| {
            std::process::Command::new(exe)
                .env("RUNE_RELAUNCH_AFTER", std::process::id().to_string())
                .spawn()
        });
        if let Err(error) = relaunch {
            supervisor::desktop_log(&format!("Relaunch failed: {error}"));
            return Some("De update is geplaatst. Sluit Apolloon en open het opnieuw om ze te gebruiken.".into());
        }
        shut_down();
        request(Request::Quit);
    }
    result
}

/// The race question on closing was answered "Blijven".
pub fn quit_cancelled() {
    with(|d| {
        d.updates.quit_cancelled();
        flush_update_log(&mut d.updates);
    });
}

#[cfg(all(test, feature = "desktop"))]
#[test]
fn updater_backup_request_creates_a_verified_copy() {
    let dir = std::env::temp_dir().join(format!("apolloon-update-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let database = dir.join("app.db");
    let db = std::sync::Arc::new(Mutex::new(crate::db::Db::open(&database).unwrap()));
    let socket = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = socket.local_addr().unwrap().port();
    drop(socket);
    {
        let _server = crate::server::start(db, port).unwrap();
        create_update_backup(&format!("http://127.0.0.1:{port}")).unwrap();
        let files = crate::backups::list(&database).unwrap();
        let backups = files.as_array().unwrap();
        assert_eq!(backups.len(), 1);
        let name = backups[0]["fileName"].as_str().unwrap();
        assert!(crate::backups::preview(&database, name).is_ok());
    }
    std::fs::remove_dir_all(dir).unwrap();
}
