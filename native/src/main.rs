#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod activity;
mod backup_service;
mod backups;
mod cluster;
mod db;
mod desktop;
mod discovery;
mod exports;
mod host;
mod labels;
mod lap_shift;
mod linking;
mod logo;
mod management;
mod queries;
mod recovery;
mod runner_import;
mod runner_profile;
mod server;
mod settings;
mod startup;
#[cfg(feature = "desktop")]
mod theme;
#[cfg(feature = "desktop")]
mod ui;
mod workbook;
mod wrapped;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
fn database() -> db::Result<Arc<Mutex<db::Db>>> {
    let path = std::env::var_os("APOLLOON_NATIVE_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| desktop::paths().db);
    startup::open(&path).map(|db| Arc::new(Mutex::new(db)))
}
fn port() -> db::Result<u16> {
    std::env::var("PORT")
        .unwrap_or_else(|_| "5174".into())
        .parse()
        .map_err(|_| "PORT moet een geldig poortnummer zijn".into())
}
fn app() -> db::Result<()> {
    let server_only = std::env::args().any(|s| s == "--server");
    if server_only {
        desktop::supervisor::exit_on_panic();
        desktop::supervisor::follow_lifeline();
        return server::serve(database()?, port()?);
    }
    #[cfg(feature = "desktop")]
    {
        let headless = std::env::args().any(|arg| {
            [
                "--snap", "--tree", "--script", "--trace", "--strip", "--video", "--help",
            ]
            .contains(&arg.as_str())
        });
        // In-process server only when asked (APOLLOON_NATIVE_INPROCESS=1); otherwise the desktop
        // app supervises it as a child process (desktop/supervisor.rs), as Electron does.
        let inprocess = std::env::var_os("APOLLOON_NATIVE_INPROCESS").is_some();
        let _server = if std::env::var_os("APOLLOON_NATIVE_URL").is_none() && !headless && inprocess {
            Some(server::start(database()?, port()?)?)
        } else {
            None
        };
        if std::env::var_os("APOLLOON_NATIVE_URL").is_none() && !headless && !inprocess && !desktop::boot() {
            // Another Apolloon runs; it was brought forward.
            return Ok(());
        }
        ui::run();
        desktop::shut_down();
        if desktop::attached_window_failed() {
            return Err("Apolloon-venster is onverwacht gestopt".into());
        }
        Ok(())
    }
    #[cfg(not(feature = "desktop"))]
    Err("Build with the desktop feature or pass --server".into())
}
fn main() {
    if let Err(error) = app() {
        eprintln!("Apolloon: {error}");
        std::process::exit(1);
    }
}
