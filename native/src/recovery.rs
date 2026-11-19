//! Restore only event data: laptop identity, group bookkeeping and the activity log survive.
use crate::db::{Db, Result};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex},
};
const TABLES: &[&str] = &[
    "label_images",
    "labels",
    "runners",
    "runner_labels",
    "race_state",
    "laps",
    "handoff_history",
    "race_events",
];
const EVENT_KEYS: &[&str] = &["public_record_mode", "competitions_json"];
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn validate_race(race: &Value, partial: bool) -> Result<()> {
    if !race.is_object() {
        return Err("Ongeldige racetoestand in backup".into());
    }
    for key in ["activeStartedAt", "raceStartedAt", "raceFinishedAt"] {
        if let Some(value) = race.get(key) {
            if !value.is_null() && value.as_i64().is_none_or(|n| n < 0) {
                return Err("Ongeldige tijd in backup".into());
            }
        } else if !partial {
            return Err("Racetijd ontbreekt in backup".into());
        }
    }
    if let Some(active) = race.get("activeRunnerId")
        && !active.is_null()
        && !active.is_string()
    {
        return Err("Ongeldige actieve loper".into());
    }
    if !partial
        && (race["activeRunnerId"].is_null() != race["activeStartedAt"].is_null()
            || (race["raceStartedAt"].is_null()
                && (!race["activeRunnerId"].is_null() || !race["raceFinishedAt"].is_null()))
            || (!race["raceFinishedAt"].is_null() && !race["activeRunnerId"].is_null()))
    {
        return Err("De racetoestand in deze backup is beschadigd".into());
    }
    Ok(())
}
fn validate_undo(raw: &Value) -> Result<()> {
    let payload: Value =
        serde_json::from_str(raw.as_str().ok_or("Ongeldige undo in backup")?).map_err(err)?;
    if let Some(kind) = payload.get("kind")
        && kind != "finish"
        && kind != "handoff"
    {
        return Err("Ongeldige undoactie".into());
    }
    validate_race(&payload["raceState"], true)?;
    for key in ["queueEntries", "lapIds"] {
        if payload.get(key).is_some_and(|v| !v.is_array()) {
            return Err("Ongeldige undolijst".into());
        }
    }
    for lap in payload["lapIds"].as_array().into_iter().flatten() {
        if !lap.is_string() {
            return Err("Ongeldige undoronde".into());
        }
    }
    for runner in payload["queueEntries"].as_array().into_iter().flatten() {
        if !runner["runnerId"].is_string()
            || !["registered", "warming_up", "waiting", "running", "ran"]
                .contains(&runner["status"].as_str().unwrap_or(""))
        {
            return Err("Ongeldige loper in undo".into());
        }
        for key in ["queueIndex", "statusSince", "hiddenAt"] {
            if let Some(v) = runner.get(key)
                && !v.is_null()
                && !v.is_number()
            {
                return Err("Ongeldige wachtrij in undo".into());
            }
        }
    }
    Ok(())
}
/// The backup is opened read-only, checked and decoded before a live transaction starts.
pub fn read(path: &Path) -> Result<Value> {
    let copy = Db {
        conn: rusqlite::Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(err)?,
        revision: 0,
        capture: Default::default(),
    };
    if copy.one("PRAGMA quick_check", &[])?["quick_check"] != "ok"
        || !copy.rows("PRAGMA foreign_key_check", &[])?.is_empty()
    {
        return Err("Deze backup is beschadigd".into());
    }
    let reference = Db::open(Path::new(":memory:"))?;
    let mut tables = BTreeMap::new();
    for table in TABLES {
        let source = copy.rows(&format!("PRAGMA table_info(\"{table}\")"), &[])?;
        let expected = reference.rows(&format!("PRAGMA table_info(\"{table}\")"), &[])?;
        if source != expected {
            return Err(format!(
                "Deze backup komt van een andere versie van Apolloon ({table})"
            ));
        }
        tables.insert(
            *table,
            copy.rows(&format!("SELECT * FROM \"{table}\""), &[])?,
        );
    }
    let mut data = json!({"tables":tables,"settings":copy.rows("SELECT key,value FROM settings WHERE key IN ('public_record_mode','competitions_json')",&[])?});
    validate(&mut data)?;
    Ok(data)
}
fn validate(data: &mut Value) -> Result<()> {
    for table in TABLES {
        if !data["tables"][*table].is_array() {
            return Err("Backuptabel ontbreekt".into());
        }
    }
    let race = data["tables"]["race_state"].as_array_mut().unwrap();
    if race.len() != 1 || race[0]["id"] != 1 {
        return Err("De backup heeft geen geldige race".into());
    }
    let race = &mut race[0];
    // Legacy setup finishes are repaired the same way as the existing importer.
    if race["race_started_at"].is_null()
        && !race["race_finished_at"].is_null()
        && race["active_runner_id"].is_null()
    {
        race["race_started_at"] = race["race_finished_at"].clone();
    }
    validate_race(
        &json!({"activeRunnerId":race["active_runner_id"],"activeStartedAt":race["active_started_at"],"raceStartedAt":race["race_started_at"],"raceFinishedAt":race["race_finished_at"]}),
        false,
    )?;
    let active = race["active_runner_id"].clone();
    let running: Vec<_> = data["tables"]["runners"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["status"] == "running")
        .collect();
    if running.len() != usize::from(!active.is_null())
        || running.first().is_some_and(|r| r["id"] != active)
    {
        return Err("De loper op de piste klopt niet met de race".into());
    }
    for lap in data["tables"]["laps"].as_array().unwrap() {
        if !["spacebar", "split", "manual", "handoff", "import", "timing"]
            .contains(&lap["source"].as_str().unwrap_or(""))
        {
            return Err("Ongeldige rondebron in backup".into());
        }
    }
    for entry in data["tables"]["handoff_history"].as_array().unwrap() {
        validate_undo(&entry["payload_json"])?;
    }
    Ok(())
}
impl Db {
    pub fn restore_event_data(&self, input: &Value) -> Result<Value> {
        let mut input = input.clone();
        validate(&mut input)?;
        for table in TABLES.iter().rev() {
            self.exec(&format!("DELETE FROM \"{table}\""), &[])?;
        }
        for table in TABLES {
            let columns: Vec<_> = self
                .rows(&format!("PRAGMA table_info(\"{table}\")"), &[])?
                .into_iter()
                .map(|r| r["name"].as_str().unwrap().to_owned())
                .collect();
            let sql = format!(
                "INSERT INTO \"{table}\" ({}) VALUES ({})",
                columns
                    .iter()
                    .map(|c| format!("\"{c}\""))
                    .collect::<Vec<_>>()
                    .join(","),
                vec!["?"; columns.len()].join(",")
            );
            for row in input["tables"][*table].as_array().unwrap() {
                self.exec(
                    &sql,
                    &columns.iter().map(|c| row[c].clone()).collect::<Vec<_>>(),
                )?;
            }
        }
        for key in EVENT_KEYS {
            self.exec("DELETE FROM settings WHERE key=?", &[json!(key)])?;
        }
        for setting in input["settings"]
            .as_array()
            .ok_or("Backupinstellingen ontbreken")?
        {
            if EVENT_KEYS.contains(&setting["key"].as_str().unwrap_or("")) {
                self.exec(
                    "INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)",
                    &[setting["key"].clone(), setting["value"].clone()],
                )?;
            }
        }
        Ok(
            json!({"runners":input["tables"]["runners"].as_array().unwrap().len(),"laps":input["tables"]["laps"].as_array().unwrap().len()}),
        )
    }
    pub fn clear_race(&self, input: &Value) -> Result<Value> {
        let laps = self.one("SELECT COUNT(*) AS n FROM laps", &[])?["n"].clone();
        let runners = if input["runners"] == true {
            self.one("SELECT COUNT(*) AS n FROM runners", &[])?["n"].clone()
        } else {
            json!(0)
        };
        for table in ["laps", "handoff_history", "race_events"] {
            self.exec(&format!("DELETE FROM {table}"), &[])?;
        }
        self.exec("UPDATE race_state SET active_runner_id=NULL,active_started_at=NULL,race_started_at=NULL,race_finished_at=NULL,active_labels_json=NULL WHERE id=1",&[])?;
        self.exec("UPDATE runners SET status='registered',queue_index=NULL,status_since=?,hidden_at=NULL WHERE status<>'registered' OR queue_index IS NOT NULL OR hidden_at IS NOT NULL",&[json!(crate::db::now())])?;
        if input["runners"] == true {
            self.exec("DELETE FROM runner_labels", &[])?;
            self.exec("DELETE FROM runners", &[])?;
        }
        Ok(json!({"laps":laps,"runners":runners}))
    }
}
/// Keep the verified safety copy aligned with the exact revision replaced.
pub fn perform(db: &Arc<Mutex<Db>>, method: &str, input: &Value) -> Result<Value> {
    let path = crate::backups::database_path(&db.lock().unwrap())?;
    let restored = if method == "backups.restore" {
        Some(read(&crate::backups::file(
            &path,
            input["fileName"].as_str().ok_or("Backup ontbreekt")?,
        )?)?)
    } else {
        None
    };
    for _ in 0..20 {
        let revision = {
            let db = db.lock().unwrap();
            if !db
                .rows("SELECT host_id FROM cluster_members", &[])?
                .is_empty()
            {
                return Err("Herstel in een gekoppelde groep vereist de replicatie-runtime".into());
            }
            db.revision
        };
        let safety = crate::backups::create_reason(
            &path,
            if restored.is_some() {
                "pre-restore"
            } else {
                "pre-clear"
            },
        )?;
        let mut db = db.lock().unwrap();
        if db.revision != revision {
            continue;
        }
        let mut result = if let Some(data) = &restored {
            db.mutation("backups.applyRestore", data)?
        } else {
            db.mutation("race.clear", input)?
        };
        result["safetyBackup"] = safety["fileName"].clone();
        result["safetyHostName"] = json!(
            std::env::var("CLUSTER_LAPTOP_NAME")
                .or_else(|_| std::env::var("HOSTNAME"))
                .unwrap_or_else(|_| "deze laptop".into())
        );
        result["safetyHostUrl"] = json!("http://127.0.0.1:5174");
        return Ok(result);
    }
    Err("De gegevens veranderen nog. Probeer het terugzetten opnieuw.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        root: std::path::PathBuf,
        path: std::path::PathBuf,
        db: Arc<Mutex<Db>>,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("apolloon-recovery-{}", crate::db::id()));
            let path = root.join("data/app.db");
            let db = Arc::new(Mutex::new(Db::open(&path).unwrap()));
            Self { root, path, db }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    fn press(db: &mut Db, method: &str) {
        let race = db.race().unwrap();
        db.mutation(method,&json!({"activeRunnerId":race["activeRunnerId"],"activeStartedAt":race["activeStartedAt"]})).unwrap();
    }
    #[test]
    fn clear_and_restore_bring_back_the_track_queue_laps_and_settings() {
        let f = Fixture::new();
        {
            let mut db = f.db.lock().unwrap();
            for name in ["A", "B"] {
                db.mutation("runners.create", &json!({"name":name,"status":"waiting"}))
                    .unwrap();
            }
            press(&mut db, "race.handoff");
            press(&mut db, "race.handoff");
            db.exec(
                "INSERT OR REPLACE INTO settings VALUES('public_record_mode','hour')",
                &[],
            )
            .unwrap();
            db.exec(
                "INSERT OR REPLACE INTO settings VALUES('host_id','local-identity')",
                &[],
            )
            .unwrap();
        }
        let audit_before =
            f.db.lock()
                .unwrap()
                .rows("SELECT id FROM activity_log", &[])
                .unwrap();
        let before = f.db.lock().unwrap().race().unwrap();
        let history = f.db.lock().unwrap().history().unwrap();
        let cleared = perform(&f.db, "race.clear", &json!({})).unwrap();
        assert_eq!(cleared["laps"], 1);
        assert!(f.db.lock().unwrap().race().unwrap()["activeRunnerId"].is_null());
        assert!(
            f.db.lock()
                .unwrap()
                .runners()
                .unwrap()
                .iter()
                .all(|r| r["status"] == "registered")
        );
        let restored = perform(
            &f.db,
            "backups.restore",
            &json!({"fileName":cleared["safetyBackup"]}),
        )
        .unwrap();
        assert_eq!(restored["laps"], 1);
        assert!(
            restored["safetyBackup"]
                .as_str()
                .unwrap()
                .contains("pre-restore")
        );
        let db = f.db.lock().unwrap();
        assert_eq!(db.race().unwrap(), before);
        assert_eq!(db.history().unwrap()["laps"], history["laps"]);
        assert_eq!(db.settings().unwrap()["publicRecordMode"], "hour");
        assert_eq!(
            db.one("SELECT value FROM settings WHERE key='host_id'", &[])
                .unwrap()["value"],
            "local-identity"
        );
        let audit_after = db.rows("SELECT id FROM activity_log", &[]).unwrap();
        assert_eq!(audit_after.len(), audit_before.len() + 2);
        assert!(audit_before.iter().all(|entry| audit_after.contains(entry)));
    }
    #[test]
    fn damaged_backup_is_refused_before_any_live_data_changes() {
        let f = Fixture::new();
        {
            let mut db = f.db.lock().unwrap();
            db.mutation("runners.create", &json!({"name":"A","status":"waiting"}))
                .unwrap();
            press(&mut db, "race.handoff");
            press(&mut db, "race.handoff");
        }
        let record = crate::backups::create(&f.path).unwrap();
        let name = record["fileName"].as_str().unwrap();
        let backup =
            rusqlite::Connection::open(crate::backups::file(&f.path, name).unwrap()).unwrap();
        backup
            .execute("UPDATE laps SET source='bad-source'", [])
            .unwrap();
        drop(backup);
        let before = f.db.lock().unwrap().snapshot(5174).unwrap();
        assert!(perform(&f.db, "backups.restore", &json!({"fileName":name})).is_err());
        assert_eq!(f.db.lock().unwrap().snapshot(5174).unwrap(), before);
    }
    #[test]
    fn invalid_undo_and_track_mismatch_are_refused() {
        let f = Fixture::new();
        {
            let mut db = f.db.lock().unwrap();
            db.mutation("runners.create", &json!({"name":"A","status":"waiting"}))
                .unwrap();
            press(&mut db, "race.handoff");
        }
        let record = crate::backups::create(&f.path).unwrap();
        let path = crate::backups::file(&f.path, record["fileName"].as_str().unwrap()).unwrap();
        let backup = rusqlite::Connection::open(&path).unwrap();
        backup
            .execute("UPDATE handoff_history SET payload_json='{}'", [])
            .unwrap();
        drop(backup);
        assert!(read(&path).is_err());
        let record = crate::backups::create(&f.path).unwrap();
        let path = crate::backups::file(&f.path, record["fileName"].as_str().unwrap()).unwrap();
        let backup = rusqlite::Connection::open(&path).unwrap();
        backup
            .execute("UPDATE runners SET status='waiting'", [])
            .unwrap();
        drop(backup);
        assert!(read(&path).is_err());
    }
    #[test]
    fn all_clear_keeps_labels_and_safety_backup_and_can_be_undone_by_restoring() {
        let f = Fixture::new();
        f.db.lock()
            .unwrap()
            .mutation("runners.create", &json!({"name":"A"}))
            .unwrap();
        let labels = f.db.lock().unwrap().labels(None).unwrap();
        let result = perform(&f.db, "race.clear", &json!({"runners":true})).unwrap();
        assert_eq!(result["runners"], 1);
        assert!(f.db.lock().unwrap().runners().unwrap().is_empty());
        assert_eq!(f.db.lock().unwrap().labels(None).unwrap(), labels);
        perform(
            &f.db,
            "backups.restore",
            &json!({"fileName":result["safetyBackup"]}),
        )
        .unwrap();
        assert_eq!(f.db.lock().unwrap().runners().unwrap().len(), 1);
    }
}
