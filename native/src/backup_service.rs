//! One serialized backup queue per host, with a cancellable five-minute scheduler.
use crate::{
    backups,
    db::{Db, Result, now},
};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Arc, Condvar, Mutex},
    thread::{self, JoinHandle},
    time::Duration,
};
#[derive(Default)]
struct Status {
    pending: usize,
    next: Option<i64>,
    failure: Option<(i64, String)>,
    damaged: Value,
}
pub struct Service {
    path: Option<PathBuf>,
    enabled: bool,
    interval: Duration,
    status: Arc<Mutex<Status>>,
    serial: Arc<Mutex<()>>,
    stop: Arc<(Mutex<bool>, Condvar)>,
    worker: Mutex<Option<JoinHandle<()>>>,
}
fn millis(key: &str, default: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|n| *n > 0)
        .unwrap_or(default)
}
fn run(path: &std::path::Path, reason: &str, status: &Mutex<Status>) -> Result<Value> {
    status.lock().unwrap().pending += 1;
    let result = backups::create_reason(path, reason).and_then(|record| {
        prune(path)?;
        Ok(record)
    });
    let mut state = status.lock().unwrap();
    state.pending -= 1;
    match &result {
        Ok(_) => state.failure = None,
        Err(e) => state.failure = Some((now(), e.clone())),
    };
    result
}
impl Service {
    pub fn new(path: Option<PathBuf>) -> Self {
        let enabled = path.is_some() && std::env::var("BACKUP_ENABLED").as_deref() != Ok("false");
        let interval = Duration::from_millis(millis("BACKUP_INTERVAL_MS", 300000));
        let initial = Duration::from_millis(millis("BACKUP_INITIAL_DELAY_MS", 10000));
        Self::configured(path, enabled, initial, interval)
    }
    fn configured(
        path: Option<PathBuf>,
        enabled: bool,
        initial: Duration,
        interval: Duration,
    ) -> Self {
        let status = Arc::new(Mutex::new(Status {
            damaged: path
                .as_ref()
                .map(|p| crate::startup::damaged(p))
                .unwrap_or(Value::Null),
            ..Status::default()
        }));
        let serial = Arc::new(Mutex::new(()));
        let stop = Arc::new((Mutex::new(false), Condvar::new()));
        let worker = if enabled {
            let path = path.clone().unwrap();
            let status = status.clone();
            let serial = serial.clone();
            let stop = stop.clone();
            Some(thread::spawn(move || {
                let mut delay = initial;
                loop {
                    status.lock().unwrap().next = Some(now() + delay.as_millis() as i64);
                    let stopped = stop.0.lock().unwrap();
                    let (stopped, _) = stop
                        .1
                        .wait_timeout_while(stopped, delay, |stopped| !*stopped)
                        .unwrap();
                    if *stopped {
                        break;
                    }
                    drop(stopped);
                    status.lock().unwrap().next = None;
                    {
                        let _guard = serial.lock().unwrap();
                        if *stop.0.lock().unwrap() {
                            break;
                        }
                        if let Err(e) = run(&path, "scheduled", &status) {
                            eprintln!("Automatische backup mislukt: {e}");
                        }
                    }
                    delay = interval;
                }
                status.lock().unwrap().next = None;
            }))
        } else {
            None
        };
        Self {
            path,
            enabled,
            interval,
            status,
            serial,
            stop,
            worker: Mutex::new(worker),
        }
    }
    pub fn create(&self) -> Result<Value> {
        let path = self
            .path
            .as_ref()
            .ok_or("Een database op schijf is nodig voor backups")?;
        let _guard = self.serial.lock().unwrap();
        run(path, "manual", &self.status)
    }
    pub fn recover(
        &self,
        db: &Arc<Mutex<Db>>,
        method: &str,
        input: &Value,
        port: u16,
    ) -> Result<Value> {
        let _guard = self.serial.lock().unwrap();
        self.status.lock().unwrap().pending += 1;
        let result = crate::recovery::perform(db, method, input).map(|mut result| {
            result["safetyHostUrl"] = crate::host::info(port)["url"].clone();
            result
        });
        let maintenance = if result.is_ok() {
            self.path.as_ref().map(|path| prune(path)).transpose()
        } else {
            Ok(None)
        };
        let mut state = self.status.lock().unwrap();
        state.pending -= 1;
        if let Err(error) = maintenance {
            state.failure = Some((now(), format!("Oude backups opruimen mislukt: {error}")));
            eprintln!("Oude backups opruimen mislukt na voltooid herstel: {error}");
        } else if result.is_ok() {
            state.failure = None;
        }
        result
    }

    pub fn status(&self) -> Result<Value> {
        let records = match &self.path {
            Some(path) => backups::list(path)?,
            None => json!([]),
        };
        let records = records.as_array().unwrap();
        let state = self.status.lock().unwrap();
        let bytes = self
            .path
            .as_ref()
            .map(|p| {
                [p.clone(), PathBuf::from(format!("{}-wal", p.display()))]
                    .iter()
                    .filter_map(|p| std::fs::metadata(p).ok().map(|m| m.len()))
                    .sum::<u64>()
            })
            .unwrap_or(0);
        let free = self
            .path
            .as_ref()
            .and_then(|path| path.parent())
            .and_then(|path| fs2::available_space(path).ok());
        let minimum = millis("BACKUP_MIN_FREE_BYTES", 2147483648);
        Ok(
            json!({"enabled":self.enabled,"inProgress":state.pending>0,"intervalMs":self.interval.as_millis() as u64,"nextScheduledAt":state.next,"retainedCount":records.len(),"latest":records.first(),"lastError":state.failure.as_ref().map(|v|&v.1),"lastFailureAt":state.failure.as_ref().map(|v|v.0),"diskFreeBytes":free,"minimumFreeBytes":minimum,"diskLow":free.is_some_and(|bytes|bytes<minimum),"databaseBytes":bytes,"damagedDatabase":state.damaged}),
        )
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        *self.stop.0.lock().unwrap() = true;
        self.stop.1.notify_all();
        if let Some(worker) = self.worker.lock().unwrap().take() {
            let _ = worker.join();
        }
    }
}
pub fn retained(records: &[Value]) -> HashSet<String> {
    let mut sorted = records.to_vec();
    sorted.sort_by_key(|r| std::cmp::Reverse(r["createdAt"].as_i64().unwrap_or(0)));
    let since = sorted
        .first()
        .and_then(|r| r["createdAt"].as_i64())
        .unwrap_or(0)
        - 30 * 3600000;
    let mut keep = HashSet::new();
    let (mut scheduled, mut manual, mut safety) = (0, 0, 0);
    let mut hours = HashSet::new();
    for record in sorted {
        let name = record["fileName"].as_str().unwrap_or("");
        let at = record["createdAt"].as_i64().unwrap_or(0);
        let retain = if record["scheduled"] == true {
            scheduled += 1;
            let hourly = at > since && hours.insert(at / 3600000);
            scheduled <= 48 || hourly
        } else if name.contains("-manual-") {
            manual += 1;
            manual <= 20
        } else {
            safety += 1;
            safety <= 20
        };
        if retain {
            keep.insert(name.to_owned());
        }
    }
    keep
}
fn prune(path: &std::path::Path) -> Result<()> {
    let records = backups::list(path)?;
    let records = records.as_array().unwrap();
    let keep = retained(records);
    for record in records {
        let name = record["fileName"].as_str().unwrap();
        if !keep.contains(name) {
            std::fs::remove_file(backups::file(path, name)?).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retention_keeps_manual_and_safety_copies_separately_and_hourly_history() {
        let mut records = Vec::new();
        for n in 0..80 {
            records.push(json!({"fileName":format!("apolloon-{n}-scheduled-abc.sqlite"),"createdAt":n*300000,"scheduled":true}));
        }
        for n in 0..25 {
            for reason in ["manual", "pre-restore"] {
                records.push(json!({"fileName":format!("apolloon-{n}-{reason}-abc.sqlite"),"createdAt":n,"scheduled":false}));
            }
        }
        let keep = retained(&records);
        assert_eq!(keep.iter().filter(|s| s.contains("-manual-")).count(), 20);
        assert_eq!(
            keep.iter().filter(|s| s.contains("-pre-restore-")).count(),
            20
        );
        assert!(keep.len() > 88);
        assert!(keep.contains("apolloon-11-scheduled-abc.sqlite"));
        assert!(!keep.contains("apolloon-0-manual-abc.sqlite"));
    }
}

#[cfg(test)]
mod scheduling_tests {
    use super::*;
    #[test]
    fn scheduled_backups_are_verified_and_stopping_wakes_the_waiter() {
        let root = std::env::temp_dir().join(format!("apolloon-scheduled-{}", crate::db::id()));
        let path = root.join("app.db");
        let _db = Db::open(&path).unwrap();
        let service = Service::configured(
            Some(path.clone()),
            true,
            Duration::from_millis(10),
            Duration::from_secs(3600),
        );
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while !service.status().unwrap()["latest"]["scheduled"]
            .as_bool()
            .unwrap_or(false)
        {
            assert!(std::time::Instant::now() < deadline);
            thread::sleep(Duration::from_millis(10));
        }
        let status = service.status().unwrap();
        assert_eq!(status["retainedCount"], 1);
        assert!(status["lastError"].is_null());
        let started = std::time::Instant::now();
        drop(service);
        assert!(started.elapsed() < Duration::from_secs(1));
        let record = backups::list(&path).unwrap()[0].clone();
        assert!(backups::preview(&path, record["fileName"].as_str().unwrap()).is_ok());
        drop(_db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
