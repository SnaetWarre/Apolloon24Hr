//! Bring databases from Apolloon 4.0 onwards to the current schema before serving requests.
use crate::db::{Result, err, id};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    time::{Duration, SystemTime},
};

const MINIMUM_SCHEMA: i64 = 13;
const SCHEMA_VERSION: i64 = 17;

struct Object {
    table: String,
    name: String,
    sql: String,
}

fn objects(conn: &Connection, kind: &str) -> Result<BTreeMap<String, Object>> {
    let mut stmt = conn
        .prepare("SELECT tbl_name, name, sql FROM sqlite_schema WHERE type=?1 AND sql IS NOT NULL AND name NOT GLOB 'sqlite_*'")
        .map_err(err)?;
    stmt.query_map([kind], |row| {
        let object = Object {
            table: row.get(0)?,
            name: row.get(1)?,
            sql: row.get(2)?,
        };
        Ok((object.name.clone(), object))
    })
    .map_err(err)?
    .collect::<rusqlite::Result<_>>()
    .map_err(err)
}

fn quote(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn normalized(sql: &str) -> String {
    let mut literal = false;
    sql.chars()
        .filter_map(|c| {
            if c == '\'' {
                literal = !literal;
            }
            if literal || c == '\'' {
                Some(c)
            } else if c.is_whitespace() || c == '"' {
                None
            } else {
                Some(c.to_ascii_lowercase())
            }
        })
        .collect()
}

fn table_body(sql: &str) -> &str {
    sql.find('(').map_or(sql, |start| &sql[start..])
}

fn columns(conn: &Connection, table: &str) -> Result<BTreeSet<String>> {
    let mut stmt = conn
        .prepare("SELECT name FROM pragma_table_info(?1)")
        .map_err(err)?;
    stmt.query_map([table], |row| row.get(0))
        .map_err(err)?
        .collect::<rusqlite::Result<_>>()
        .map_err(err)
}

fn rebuild(conn: &Connection, reference: &Connection, table: &Object) -> Result<()> {
    let old = columns(conn, &table.name)?;
    let temp = quote(&format!("apolloon_rebuilt_{}", id()));
    let dest = quote(&table.name);
    conn.execute_batch(&format!("CREATE TABLE {temp} {}", table_body(&table.sql)))
        .map_err(err)?;
    let mut stmt = reference
        .prepare("SELECT name, \"notnull\", dflt_value FROM pragma_table_info(?1) ORDER BY cid")
        .map_err(err)?;
    let expected = stmt
        .query_map([&table.name], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, bool>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(err)?;
    let mut names = Vec::new();
    let mut values = Vec::new();
    for (name, required, default) in expected {
        let column = quote(&name);
        let fallback = default.as_deref().or(match name.as_str() {
            "created_at" | "updated_at" => Some("CAST(unixepoch('subsec') * 1000 AS INTEGER)"),
            _ => None,
        });
        values.push(match (old.contains(&name), required, fallback) {
            (true, true, Some(value)) => format!("COALESCE({column}, {value})"),
            (true, _, _) => column.clone(),
            (false, _, value) => value.unwrap_or("NULL").to_owned(),
        });
        names.push(column);
    }
    conn.execute_batch(&format!(
        "INSERT INTO {temp} ({}) SELECT {} FROM {dest}; DROP TABLE {dest}; ALTER TABLE {temp} RENAME TO {dest};",
        names.join(", "),
        values.join(", "),
    ))
    .map_err(err)
}

fn save_before_repair(path: &Path) -> Result<()> {
    let stem = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("app");
    let time = chrono::DateTime::<chrono::Utc>::from(SystemTime::now());
    let date = time.format("%Y-%m-%d");
    let backup = path.with_file_name(format!("{stem}.pre-repair-{date}.sqlite"));
    if backup.try_exists().map_err(err)? {
        return Ok(());
    }
    let pending = backup.with_extension(format!("{}.partial", id()));
    let result = (|| {
        let source =
            Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(err)?;
        source
            .backup(rusqlite::MAIN_DB, &pending, None)
            .map_err(err)?;
        let copy =
            Connection::open_with_flags(&pending, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(err)?;
        let check: String = copy
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .map_err(err)?;
        if check != "ok" {
            return Err(format!("Controle van de migratiebackup mislukt: {check}"));
        }
        drop(copy);
        std::fs::rename(&pending, &backup).map_err(err)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(pending);
    }
    result
}

/// Returns the version to archive when the file is from before Apolloon 4.0.
pub(super) fn prepare(path: &Path) -> Result<Option<i64>> {
    let mut conn =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(err)?;
    conn.busy_timeout(Duration::from_secs(5)).map_err(err)?;
    conn.pragma_update(None, "foreign_keys", false)
        .map_err(err)?;
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(err)?;
    let tables = objects(&transaction, "table")?;
    let pragma: i64 = transaction
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(err)?;
    let stored = if tables.contains_key("settings") {
        transaction
            .query_row(
                "SELECT value FROM settings WHERE key='schema_version'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(err)?
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(0)
    } else {
        0
    };
    let version = pragma.max(stored);
    if version > SCHEMA_VERSION {
        return Err(format!(
            "Schema {version} is nieuwer dan deze Apolloon-versie ({SCHEMA_VERSION})."
        ));
    }
    if tables.is_empty() {
        return Ok(None);
    }
    if version < MINIMUM_SCHEMA {
        return Ok(Some(version));
    }

    let reference = Connection::open_in_memory().map_err(err)?;
    reference
        .execute_batch(include_str!("../schema.sql"))
        .map_err(err)?;
    let expected_tables = objects(&reference, "table")?;
    let expected_indexes = objects(&reference, "index")?;
    let outdated: Vec<&Object> = expected_tables
        .values()
        .filter(|table| {
            tables.get(&table.name).is_some_and(|present| {
                normalized(table_body(&present.sql)) != normalized(table_body(&table.sql))
            })
        })
        .collect();
    if version < SCHEMA_VERSION || !outdated.is_empty() {
        save_before_repair(path)?;
    }
    for table in outdated {
        rebuild(&transaction, &reference, table)?;
    }
    for table in expected_tables
        .values()
        .filter(|table| !tables.contains_key(&table.name))
    {
        transaction.execute_batch(&table.sql).map_err(err)?;
    }
    if version < 14 && tables.contains_key("queue_entries") {
        transaction.execute_batch(
            "UPDATE runners
               SET status=q.status, queue_index=q.queue_index, status_since=q.status_since, hidden_at=q.hidden_at
              FROM queue_entries q WHERE q.runner_id=runners.id;
             DROP TABLE queue_entries;",
        ).map_err(err)?;
    }
    let indexes = objects(&transaction, "index")?;
    for index in indexes.values().filter(|index| {
        expected_tables.contains_key(&index.table) && !expected_indexes.contains_key(&index.name)
    }) {
        transaction
            .execute_batch(&format!("DROP INDEX {}", quote(&index.name)))
            .map_err(err)?;
    }
    for index in expected_indexes.values().filter(|index| {
        indexes
            .get(&index.name)
            .is_none_or(|present| normalized(&present.sql) != normalized(&index.sql))
    }) {
        transaction
            .execute_batch(&format!(
                "DROP INDEX IF EXISTS {}; {}",
                quote(&index.name),
                index.sql
            ))
            .map_err(err)?;
    }
    transaction.execute_batch(
        "DELETE FROM runner_labels WHERE label_id IN (SELECT id FROM labels WHERE kind='temporary_team');
         DELETE FROM labels WHERE kind='temporary_team';
         DROP TABLE IF EXISTS temporary_team_members; DROP TABLE IF EXISTS temporary_teams;",
    ).map_err(err)?;
    if pragma != SCHEMA_VERSION {
        transaction
            .pragma_update(None, "user_version", SCHEMA_VERSION)
            .map_err(err)?;
    }
    if stored != SCHEMA_VERSION {
        transaction
            .execute(
                "INSERT OR REPLACE INTO settings(key,value) VALUES ('schema_version',?1)",
                [SCHEMA_VERSION.to_string()],
            )
            .map_err(err)?;
    }
    let missing_parents: i64 = transaction
        .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .map_err(err)?;
    if missing_parents > 0 {
        eprintln!("Databank bevat {missing_parents} verwijzingen naar ontbrekende rijen.");
    }
    transaction.commit().map_err(err)?;
    Ok(None)
}
