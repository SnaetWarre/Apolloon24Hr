//! Verified SQLite snapshots. An incomplete copy is never exposed in the inventory.
use crate::db::{Db, Result, id, now};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn directory(database: &Path) -> Result<PathBuf> {
    database
        .parent()
        .map(|p| {
            if p.file_name().is_some_and(|n| n == "data") {
                p.parent().unwrap_or(p).join("backups")
            } else {
                p.join("backups")
            }
        })
        .ok_or("Databasepad ontbreekt".into())
}
fn safe_name(name: &str) -> bool {
    name.starts_with("apolloon-")
        && name.ends_with(".sqlite")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !name.contains("..")
}
pub fn database_path(db: &Db) -> Result<PathBuf> {
    db.conn
        .path()
        .filter(|p| !p.is_empty() && *p != ":memory:")
        .map(PathBuf::from)
        .ok_or("Een database op schijf is nodig voor backups".into())
}
pub fn list(database: &Path) -> Result<Value> {
    let dir = directory(database)?;
    if !dir.exists() {
        return Ok(json!([]));
    }
    let mut records = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(err)? {
        let entry = entry.map_err(err)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !safe_name(&name) || !entry.file_type().map_err(err)?.is_file() {
            continue;
        }
        let metadata = entry.metadata().map_err(err)?;
        let created = metadata
            .modified()
            .map_err(err)?
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(err)?
            .as_millis() as i64;
        records.push(json!({"fileName":name,"createdAt":created,"sizeBytes":metadata.len(),"scheduled":name.contains("-scheduled-")}));
    }
    records.sort_by_key(|r| std::cmp::Reverse(r["createdAt"].as_i64().unwrap_or(0)));
    Ok(json!(records))
}
#[cfg(test)]
pub fn create(database: &Path) -> Result<Value> {
    create_reason(database, "manual")
}
pub fn create_reason(database: &Path, reason: &str) -> Result<Value> {
    if !["manual", "scheduled", "pre-restore", "pre-clear"].contains(&reason) {
        return Err("Ongeldige backupreden".into());
    }
    let dir = directory(database)?;
    std::fs::create_dir_all(&dir).map_err(err)?;
    let created = now();
    let stamp = chrono::DateTime::from_timestamp_millis(created)
        .ok_or("Ongeldige backuptijd")?
        .format("%Y%m%dT%H%M%S%3fZ")
        .to_string();
    let name = format!("apolloon-{stamp}-{reason}-{}.sqlite", &id()[..8]);
    let temporary = dir.join(format!(".{name}.partial"));
    let destination = dir.join(&name);
    let result = (|| {
        let source =
            Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(err)?;
        source
            .backup(rusqlite::MAIN_DB, &temporary, None)
            .map_err(err)?;
        let copy = Connection::open_with_flags(&temporary, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(err)?;
        let check: String = copy
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .map_err(err)?;
        if check != "ok" {
            return Err("Backupcontrole mislukt".into());
        }
        let mut violations = copy.prepare("PRAGMA foreign_key_check").map_err(err)?;
        if violations
            .query([])
            .map_err(err)?
            .next()
            .map_err(err)?
            .is_some()
        {
            return Err("Backup bevat ongeldige verwijzingen".into());
        }
        drop(violations);
        drop(copy);
        std::fs::File::open(&temporary)
            .map_err(err)?
            .sync_all()
            .map_err(err)?;
        std::fs::rename(&temporary, &destination).map_err(err)?;
        Ok(
            json!({"fileName":name,"createdAt":created,"sizeBytes":std::fs::metadata(destination).map_err(err)?.len(),"scheduled":reason=="scheduled"}),
        )
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}
pub fn preview(database: &Path, name: &str) -> Result<Value> {
    if !safe_name(name) {
        return Err("Ongeldige backupnaam".into());
    }
    let records = list(database)?;
    let record = records
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["fileName"] == name)
        .ok_or("Deze backup bestaat niet meer")?;
    crate::recovery::read(&directory(database)?.join(name))?;
    let copy = Connection::open_with_flags(
        directory(database)?.join(name),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(err)?;
    let count = |table: &str| {
        copy.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| {
            r.get::<_, i64>(0)
        })
        .map_err(err)
    };
    let race: (Option<i64>, Option<i64>) = copy
        .query_row(
            "SELECT race_started_at,race_finished_at FROM race_state WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(err)?;
    let last: Option<i64> = copy
        .query_row("SELECT MAX(finished_at) FROM laps", [], |r| r.get(0))
        .map_err(err)?;
    Ok(
        json!({"fileName":name,"createdAt":record["createdAt"],"runners":count("runners")?,"laps":count("laps")?,"lastLapAt":last,"raceStartedAt":race.0,"raceFinishedAt":race.1}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn backup_remains_independent_and_rejects_path_traversal() {
        let root = std::env::temp_dir().join(format!("apolloon-backup-{}", id()));
        let path = root.join("app.db");
        let mut db = Db::open(&path).unwrap();
        db.mutation("runners.create", &json!({"name":"Before"}))
            .unwrap();
        let record = create(&path).unwrap();
        db.mutation("runners.create", &json!({"name":"After"}))
            .unwrap();
        let name = record["fileName"].as_str().unwrap();
        assert_eq!(preview(&path, name).unwrap()["runners"], 1);
        assert_eq!(list(&path).unwrap().as_array().unwrap().len(), 1);
        assert!(preview(&path, "../app.db").is_err());
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}

pub fn file(database: &Path, name: &str) -> Result<PathBuf> {
    if !safe_name(name) {
        return Err("Ongeldige backupnaam".into());
    }
    let records = list(database)?;
    if !records
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["fileName"] == name)
    {
        return Err("Deze backup bestaat niet meer".into());
    }
    Ok(directory(database)?.join(name))
}
