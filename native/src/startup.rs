//! Quarantine unreadable SQLite files and prepare compatible event data before starting the server.
mod schema;

use crate::db::{Db, Result, err, id, now};
use rusqlite::{Connection, Error, ErrorCode, OpenFlags};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
fn damage(path: &Path) -> Result<Option<String>> {
    if !path.exists() {
        return Ok(None);
    }
    let probe = (|| -> rusqlite::Result<String> {
        let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let mut stmt = db.prepare("PRAGMA quick_check")?;
        let messages = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(messages.join("; "))
    })();
    match probe {
        Ok(check) if check == "ok" => Ok(None),
        Ok(check) => Ok(Some(check)),
        Err(Error::SqliteFailure(code, message))
            if matches!(
                code.code,
                ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase
            ) =>
        {
            Ok(Some(message.unwrap_or_else(|| code.to_string())))
        }
        Err(error) => Err(err(error)),
    }
}
pub fn open(path: &Path) -> Result<Db> {
    let Some(problem) = damage(path)? else {
        if path.try_exists().map_err(err)?
            && let Some(version) = schema::prepare(path)?
        {
            let target = put_aside(path, "retired", now())?;
            eprintln!(
                "Databank van vóór Apolloon 4.0 (schema {version}) bewaard als {}. Gestart met een lege databank.",
                target.display()
            );
        }
        return Db::open(path);
    };
    let time = now();
    let target = put_aside(path, "damaged", time)?;
    let db = Db::open(path)?;
    let record =
        json!({"fileName":target.file_name().unwrap().to_string_lossy(),"putAsideAt":time});
    db.exec(
        "INSERT OR REPLACE INTO settings(key,value) VALUES('damaged_database_json',?)",
        &[json!(record.to_string())],
    )?;
    eprintln!(
        "Databank beschadigd ({problem}); bewaard als {}. Gestart met een lege databank.",
        target.display()
    );
    Ok(db)
}

fn put_aside(path: &Path, kind: &str, time: i64) -> Result<PathBuf> {
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("app");
    let target = path.with_file_name(format!("{stem}.{kind}-{time}-{}.sqlite", &id()[..8]));
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let source = PathBuf::from(format!("{}{suffix}", path.display()));
        if !source.exists() {
            continue;
        }
        let destination = PathBuf::from(format!("{}{suffix}", target.display()));
        if let Err(error) = std::fs::rename(&source, &destination) {
            for (source, destination) in moved.iter().rev() {
                let _ = std::fs::rename(destination, source);
            }
            return Err(format!(
                "De databank kon niet veilig opzij worden gezet: {error}"
            ));
        }
        moved.push((source, destination));
    }
    Ok(target)
}
pub fn damaged(path: &Path) -> Value {
    let Ok(db) = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return Value::Null;
    };
    db.query_row(
        "SELECT value FROM settings WHERE key='damaged_database_json'",
        [],
        |r| r.get::<_, String>(0),
    )
    .ok()
    .and_then(|s| serde_json::from_str(&s).ok())
    .unwrap_or(Value::Null)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn damaged_bytes_are_preserved_and_old_backup_is_available_for_restore() {
        let root = std::env::temp_dir().join(format!("apolloon-damaged-{}", id()));
        let path = root.join("data/app.db");
        let mut db = Db::open(&path).unwrap();
        db.mutation("runners.create", &json!({"name":"Saved"}))
            .unwrap();
        let record = crate::backups::create(&path).unwrap();
        drop(db);
        let corrupt = b"this is the damaged database, preserve all of these bytes";
        std::fs::write(&path, corrupt).unwrap();
        let db = open(&path).unwrap();
        assert!(db.runners().unwrap().is_empty());
        let note = damaged(&path);
        assert_eq!(
            std::fs::read(
                path.parent()
                    .unwrap()
                    .join(note["fileName"].as_str().unwrap())
            )
            .unwrap(),
            corrupt
        );
        let db = std::sync::Arc::new(std::sync::Mutex::new(db));
        crate::recovery::perform(
            &db,
            "backups.restore",
            &json!({"fileName":record["fileName"]}),
        )
        .unwrap();
        assert_eq!(db.lock().unwrap().runners().unwrap()[0]["name"], "Saved");
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn a_newer_schema_is_refused_and_never_quarantined() {
        let root = std::env::temp_dir().join(format!("apolloon-new-schema-{}", id()));
        let path = root.join("app.db");
        std::fs::create_dir_all(&root).unwrap();
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE test(id INTEGER); PRAGMA user_version=18;")
            .unwrap();
        drop(db);
        assert!(open(&path).is_err());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_retired_database_is_preserved_while_startup_creates_a_new_event() {
        let root = std::env::temp_dir().join(format!("apolloon-retired-{}", id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("app.db");
        let old = Connection::open(&path).unwrap();
        old.execute_batch(
            "CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO settings VALUES('schema_version','12'),('host_id','old-host');
             CREATE TABLE runners(id TEXT PRIMARY KEY, name TEXT);
             INSERT INTO runners VALUES('anna','Anna');",
        )
        .unwrap();
        drop(old);
        let before = std::fs::read(&path).unwrap();
        let fresh = open(&path).unwrap();
        assert!(fresh.runners().unwrap().is_empty());
        let archived = std::fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|file| {
                file.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("app.retired-")
            })
            .unwrap();
        assert_eq!(std::fs::read(archived).unwrap(), before);
        drop(fresh);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn kept_schema_repairs_old_columns_and_keeps_laps_and_a_verified_original() {
        let root = std::env::temp_dir().join(format!("apolloon-repair-{}", id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("app.db");
        let old = Connection::open(&path).unwrap();
        old.execute_batch(
            "CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO settings VALUES('schema_version','13');
             CREATE TABLE runners(id TEXT PRIMARY KEY, name TEXT NOT NULL, legacy TEXT);
             INSERT INTO runners VALUES('anna','Anna','former column');
             CREATE TABLE queue_entries(runner_id TEXT PRIMARY KEY, status TEXT NOT NULL,
               queue_index INTEGER, status_since INTEGER, hidden_at INTEGER);
             INSERT INTO queue_entries VALUES('anna','waiting',3,120,NULL);
             CREATE TABLE laps(id TEXT PRIMARY KEY, runner_id TEXT NOT NULL, lap_number INTEGER NOT NULL,
               started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
               source TEXT NOT NULL, created_at INTEGER NOT NULL,
               FOREIGN KEY (runner_id) REFERENCES runners(id) ON DELETE CASCADE);
             INSERT INTO laps VALUES('lap','anna',1,100,200,100,'spacebar',200);
             CREATE INDEX idx_laps_finished ON laps(created_at);
             CREATE TABLE temporary_teams(id TEXT PRIMARY KEY);",
        ).unwrap();
        drop(old);
        let db = open(&path).unwrap();
        let runner = db
            .one(
                "SELECT id, name, status, queue_index, status_since, registration_source, created_at FROM runners",
                &[],
            )
            .unwrap();
        assert_eq!(runner["id"], "anna");
        assert_eq!(runner["name"], "Anna");
        assert_eq!(runner["status"], "waiting");
        assert_eq!(runner["queue_index"], 3);
        assert_eq!(runner["status_since"], 120);
        assert_eq!(runner["registration_source"], "manual");
        assert!(runner["created_at"].as_i64().unwrap() > 0);
        assert_eq!(
            db.one("SELECT runner_id, labels_json FROM laps", &[])
                .unwrap(),
            json!({"runner_id":"anna","labels_json":"[]"})
        );
        assert!(db.rows("PRAGMA foreign_key_check", &[]).unwrap().is_empty());
        assert_eq!(
            db.one("SELECT value FROM settings WHERE key='schema_version'", &[])
                .unwrap()["value"],
            "17"
        );
        assert_eq!(
            db.one("PRAGMA index_info(idx_laps_finished)", &[]).unwrap()["name"],
            "finished_at"
        );
        assert!(
            db.rows(
                "SELECT name FROM sqlite_schema WHERE name='temporary_teams'",
                &[]
            )
            .unwrap()
            .is_empty()
        );
        assert!(
            db.rows("SELECT * FROM labels", &[]).unwrap().is_empty(),
            "never seed event data on migration"
        );
        let backup = std::fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|file| {
                file.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("app.pre-repair-")
            })
            .unwrap();
        let original = Connection::open(backup).unwrap();
        assert_eq!(
            original
                .query_row("SELECT legacy FROM runners", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "former column"
        );
        assert_eq!(
            original
                .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        drop(original);
        drop(db);
        let reopened = open(&path).unwrap();
        assert_eq!(reopened.runners().unwrap()[0]["name"], "Anna");
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_repair_leaves_schema_and_runner_rows_untouched() {
        let root = std::env::temp_dir().join(format!("apolloon-failed-repair-{}", id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("app.db");
        let old = Connection::open(&path).unwrap();
        old.execute_batch(
            "PRAGMA user_version=17;
             CREATE TABLE runners(id TEXT PRIMARY KEY, name TEXT, status TEXT);
             INSERT INTO runners VALUES('anna','Anna','sprinting');",
        )
        .unwrap();
        drop(old);
        assert!(
            open(&path)
                .err()
                .unwrap()
                .contains("CHECK constraint failed")
        );
        let unchanged = Connection::open(&path).unwrap();
        assert_eq!(
            unchanged
                .query_row("SELECT status FROM runners", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "sprinting"
        );
        assert_eq!(
            unchanged
                .query_row(
                    "SELECT count(*) FROM sqlite_schema WHERE type='table'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        drop(unchanged);
        std::fs::remove_dir_all(root).unwrap();
    }
}
