//! Quarantine unreadable SQLite files without treating permission/locking failures as corruption.
use crate::db::{Db, Result, id, now};
use rusqlite::{Connection, Error, ErrorCode, OpenFlags};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
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
        return Db::open(path);
    };
    let time = now();
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("app");
    let target = path.with_file_name(format!("{stem}.damaged-{time}-{}.sqlite", &id()[..8]));
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
                "De beschadigde databank kon niet veilig opzij worden gezet: {error}"
            ));
        }
        moved.push((source, destination));
    }
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
}
