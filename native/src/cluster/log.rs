//! The replication log (port of server/db/replication.ts, append-rules.ts and
//! forwarded-writes.ts). Every write is stored as the SQL it ran, in the same transaction as the
//! write itself, so a laptop replaying the log ends up with the same rows.
use crate::db::{Db, Result, err, now};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Entries kept for laptops that fall briefly behind; one further behind takes a full copy.
const LOG_RETENTION: i64 = 5_000;
pub const MAX_ENTRIES: i64 = 500;
const MAX_BATCH_BYTES: usize = 4 * 1024 * 1024;
const MAX_ENTRY_BYTES: usize = 16 * 1024 * 1024;
/// Forwarded write results are kept this long, so a repeat at the next leader is applied once.
const FORWARDED_KEEP_MS: i64 = 10 * 60_000;

/// Event tables in foreign-key insert order, plus the log itself.
const REPLICATED_TABLES: [&str; 13] = [
    "label_images",
    "labels",
    "runners",
    "runner_labels",
    "race_state",
    "laps",
    "handoff_history",
    "race_events",
    "activity_log",
    "cluster_members",
    "cluster_member_names",
    "forwarded_writes",
    "replication_log",
];
/// Settings that describe this laptop, not the event: never replicated, never replaced by a copy.
const LOCAL_SETTINGS: [&str; 7] = [
    "host_id",
    "replication_cluster_id",
    "cluster_epoch",
    "cluster_voted_for",
    "cluster_clock_offset_ms",
    "cluster_known_peers_json",
    super::key::SETTING,
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Statement {
    pub sql: String,
    pub params: Vec<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub seq: i64,
    pub id: String,
    pub epoch: i64,
    #[serde(rename = "type")]
    pub kind: String,
    pub statements: Vec<Statement>,
    pub created_at: i64,
}

/// The statements of the write in progress, and the id of the forwarded request it answers.
#[derive(Default, Debug)]
pub struct Capture {
    pub statements: Vec<Statement>,
    pub request_id: Option<String>,
}
impl Capture {
    pub fn record(&mut self, sql: &str, params: &[Value]) {
        self.statements.push(Statement {
            sql: sql.to_owned(),
            params: params.to_vec(),
        });
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Head {
    pub seq: i64,
    pub id: Option<String>,
    pub epoch: i64,
}

pub fn setting(db: &Db, key: &str) -> Option<String> {
    db.rows("SELECT value FROM settings WHERE key=?", &[json!(key)])
        .ok()?
        .first()?["value"]
        .as_str()
        .map(str::to_owned)
}
/// A setting of this laptop only: written past the capture, so it never replicates.
pub fn set_local(db: &Db, key: &str, value: &str) -> Result<()> {
    db.conn
        .execute(
            "INSERT OR REPLACE INTO settings(key,value) VALUES(?1,?2)",
            rusqlite::params![key, value],
        )
        .map_err(err)?;
    Ok(())
}
/// A group setting; call inside a recorded write.
pub fn set_replicated(db: &Db, key: &str, value: &Value) -> Result<()> {
    db.exec(
        "INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)",
        &[json!(key), json!(value.to_string())],
    )?;
    Ok(())
}
pub fn json_setting(db: &Db, key: &str) -> Value {
    setting(db, key)
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(Value::Null)
}

pub fn term(db: &Db) -> i64 {
    setting(db, "cluster_epoch")
        .and_then(|v| v.parse().ok())
        .filter(|v: &i64| *v > 0)
        .unwrap_or(0)
}

pub fn head(db: &Db) -> Head {
    db.rows(
        "SELECT seq,id,epoch FROM replication_log ORDER BY seq DESC LIMIT 1",
        &[],
    )
    .ok()
    .and_then(|rows| rows.into_iter().next())
    .map(|row| Head {
        seq: row["seq"].as_i64().unwrap_or(0),
        id: row["id"].as_str().map(str::to_owned),
        epoch: row["epoch"].as_i64().unwrap_or(0),
    })
    .unwrap_or_default()
}

pub fn entry_id(db: &Db, seq: i64) -> Option<String> {
    db.rows("SELECT id FROM replication_log WHERE seq=?", &[json!(seq)])
        .ok()?
        .first()?["id"]
        .as_str()
        .map(str::to_owned)
}

/// The term entry `seq` was written in, while this log still holds it.
pub fn entry_term(db: &Db, seq: i64) -> Option<i64> {
    db.rows("SELECT epoch FROM replication_log WHERE seq=?", &[json!(seq)])
        .ok()?
        .first()?["epoch"]
        .as_i64()
}

fn oldest(db: &Db) -> Option<i64> {
    db.rows("SELECT MIN(seq) AS seq FROM replication_log", &[])
        .ok()?
        .first()?["seq"]
        .as_i64()
}

/// True once someone changed the event data (more than the laptops' own bookkeeping).
pub fn has_event_changes(db: &Db) -> bool {
    db.one("SELECT EXISTS (SELECT 1 FROM replication_log WHERE type NOT LIKE 'cluster.%') OR COALESCE((SELECT MIN(seq) FROM replication_log),1)>1 AS changed", &[])
        .map(|row| row["changed"] == 1)
        .unwrap_or(false)
}

/// The entries after `seq` that fit in one message, at least one; None when the next one alone is too large.
pub fn entries_after(db: &Db, seq: i64) -> Option<Vec<Entry>> {
    let rows = db
        .rows(
            "SELECT seq,id,epoch,type,statements_json,created_at FROM replication_log WHERE seq>? ORDER BY seq LIMIT ?",
            &[json!(seq), json!(MAX_ENTRIES)],
        )
        .ok()?;
    let mut entries = Vec::new();
    let mut bytes = 0;
    for row in rows {
        let raw = row["statements_json"].as_str().unwrap_or("[]");
        let size = raw.len() + 512;
        if entries.is_empty() && size > MAX_ENTRY_BYTES {
            return None;
        }
        if !entries.is_empty() && bytes + size > MAX_BATCH_BYTES {
            break;
        }
        bytes += size;
        entries.push(Entry {
            seq: row["seq"].as_i64()?,
            id: row["id"].as_str()?.to_owned(),
            epoch: row["epoch"].as_i64()?,
            kind: row["type"].as_str()?.to_owned(),
            statements: serde_json::from_str(raw).ok()?,
            created_at: row["created_at"].as_i64()?,
        });
    }
    Some(entries)
}

fn insert(db: &Db, entry: &Entry) -> Result<()> {
    db.conn
        .execute(
            "INSERT INTO replication_log(seq,id,epoch,type,statements_json,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                entry.seq,
                entry.id,
                entry.epoch,
                entry.kind,
                serde_json::to_string(&entry.statements).map_err(err)?,
                entry.created_at
            ],
        )
        .map_err(err)?;
    if entry.seq % 500 == 0 {
        db.conn
            .execute(
                "DELETE FROM replication_log WHERE seq<=?1",
                [entry.seq - LOG_RETENTION],
            )
            .map_err(err)?;
    }
    Ok(())
}

/// Ends a recorded write inside its transaction: remembers the forwarded request's result and
/// appends what ran to the log. Returns the new entry, if anything changed.
pub fn seal(db: &Db, kind: &str, result: &Value) -> Result<Option<Entry>> {
    let Some(mut capture) = db.capture.borrow_mut().take() else {
        return Ok(None);
    };
    if capture.statements.is_empty() {
        return Ok(None);
    }
    if let Some(request) = capture.request_id.take() {
        let at = now();
        for (sql, params) in [
            (
                "DELETE FROM forwarded_writes WHERE created_at<?",
                vec![json!(at - FORWARDED_KEEP_MS)],
            ),
            (
                "INSERT OR REPLACE INTO forwarded_writes(request_id,result_json,created_at) VALUES(?,?,?)",
                vec![json!(request), json!(result.to_string()), json!(at)],
            ),
        ] {
            db.exec(sql, &params)?;
            capture.record(sql, &params);
        }
    }
    let seq = head(db).seq + 1;
    let entry = Entry {
        seq,
        id: crate::db::id(),
        epoch: term(db),
        kind: kind.to_owned(),
        statements: capture.statements,
        created_at: now(),
    };
    insert(db, &entry)?;
    Ok(Some(entry))
}

/// Appends an entry that changes nothing. A new leader starts with one, so that its term has an
/// entry a majority can store (see `advance_commit`).
pub fn append_empty(db: &Db, kind: &str) -> Result<()> {
    insert(
        db,
        &Entry {
            seq: head(db).seq + 1,
            id: crate::db::id(),
            epoch: term(db),
            kind: kind.to_owned(),
            statements: Vec::new(),
            created_at: now(),
        },
    )
}

/// The saved answer to a forwarded write that already ran.
pub fn forwarded_result(db: &Db, request: &str) -> Option<Value> {
    let row = db
        .rows(
            "SELECT result_json FROM forwarded_writes WHERE request_id=?",
            &[json!(request)],
        )
        .ok()?
        .into_iter()
        .next()?;
    serde_json::from_str(row["result_json"].as_str()?).ok()
}

/// A write the leader ran and took back: it reaches the leader's own data only once enough
/// laptops stored it.
#[derive(Clone, Debug)]
pub struct Prepared {
    pub entry: Entry,
    /// The laptops in the group once this write is applied; a majority of them must store it.
    pub voters: Vec<String>,
}
impl Prepared {
    /// Call inside the write's transaction, after `seal`.
    pub fn new(db: &Db, entry: Entry) -> Self {
        Self {
            entry,
            voters: stored_members(db).into_iter().map(|m| m.host_id).collect(),
        }
    }
    /// False when a follower could only get this write with a full copy of the database.
    pub fn fits_one_message(&self) -> bool {
        serde_json::to_string(&self.entry.statements)
            .is_ok_and(|raw| raw.len() + 512 <= MAX_ENTRY_BYTES)
    }
}

/// Runs `action` as one replicated write of type `kind`, like a mutation. With `keep` false the
/// write is taken back and returned for `apply_own`.
pub fn record_or_prepare(
    db: &mut Db,
    kind: &str,
    request: Option<&str>,
    keep: bool,
    action: impl FnOnce(&Db) -> Result<Value>,
) -> Result<(Value, Option<Prepared>)> {
    let transaction =
        rusqlite::Transaction::new_unchecked(&db.conn, rusqlite::TransactionBehavior::Immediate)
            .map_err(err)?;
    *db.capture.borrow_mut() = Some(Capture {
        statements: Vec::new(),
        request_id: request.map(str::to_owned),
    });
    let outcome =
        action(db).and_then(|result| seal(db, kind, &result).map(|entry| (result, entry)));
    db.capture.borrow_mut().take();
    let (result, entry) = outcome?;
    if !keep {
        // Dropping the transaction takes the write back.
        return Ok((result, entry.map(|entry| Prepared::new(db, entry))));
    }
    transaction.commit().map_err(err)?;
    db.revision += 1;
    Ok((result, None))
}
pub fn record(
    db: &mut Db,
    kind: &str,
    request: Option<&str>,
    action: impl FnOnce(&Db) -> Result<Value>,
) -> Result<Value> {
    record_or_prepare(db, kind, request, true, action).map(|(result, _)| result)
}

/// The leader stores a write of its own that enough laptops hold.
pub fn apply_own(db: &mut Db, entry: &Entry) -> Result<()> {
    apply(db, std::slice::from_ref(entry))
}

pub(super) fn valid(statement: &Statement) -> bool {
    let sql = statement.sql.trim_start().to_ascii_lowercase();
    ["insert", "update", "delete", "replace"]
        .iter()
        .any(|verb| sql.starts_with(verb))
        && !sql.contains("replication_log")
        && statement
            .params
            .iter()
            .all(|p| p.is_null() || p.is_string() || p.is_number() || p.is_boolean())
}

/// Replays the leader's entries, which must continue this log without gaps.
fn apply(db: &mut Db, entries: &[Entry]) -> Result<()> {
    if entries.is_empty() {
        return Ok(());
    }
    let transaction =
        rusqlite::Transaction::new_unchecked(&db.conn, rusqlite::TransactionBehavior::Immediate)
            .map_err(err)?;
    let mut expected = head(db).seq + 1;
    for entry in entries {
        if entry.seq != expected {
            return Err(format!(
                "replication gap: expected {expected}, received {}",
                entry.seq
            ));
        }
        for statement in &entry.statements {
            if !valid(statement) {
                return Err("only application data changes can be replicated".into());
            }
            db.exec(&statement.sql, &statement.params)?;
        }
        insert(db, entry)?;
        expected += 1;
    }
    let laps: Vec<String> = if crate::latency::enabled() {
        entries.iter().filter(|e| e.kind == "race.handoff").flat_map(|e| e.statements.iter())
            .filter(|s| s.sql.starts_with("INSERT INTO laps("))
            .filter_map(|s| s.params.first().and_then(Value::as_str).map(str::to_owned)).collect()
    } else { Vec::new() };
    let _trace = if laps.is_empty() { None } else {
        Some(crate::latency::commit_context(laps.iter().map(|id| (id.clone(), id.clone())).collect()))
    };
    transaction.commit().map_err(err)?;
    for lap in laps { crate::latency::emit("replica_apply", &lap, Some(&lap)); }
    db.revision += 1;
    Ok(())
}

/// Stores a leader's entries that follow (`prev_seq`, `prev_id`); the reason when they do not fit.
pub fn append_from_leader(
    db: &mut Db,
    prev_seq: i64,
    prev_id: Option<&str>,
    entries: &[Entry],
) -> std::result::Result<(), &'static str> {
    let head_seq = head(db).seq;
    if prev_seq > head_seq {
        return Err("behind");
    }
    if prev_seq > 0 && entry_id(db, prev_seq).as_deref() != prev_id {
        return Err("diverged");
    }
    let covered = entries.last().map_or(prev_seq, |e| e.seq);
    if head_seq > covered {
        return Err("diverged");
    }
    for entry in entries {
        if entry.seq <= head_seq && entry_id(db, entry.seq).as_deref() != Some(&entry.id) {
            return Err("diverged");
        }
    }
    let fresh: Vec<Entry> = entries
        .iter()
        .filter(|e| e.seq > head_seq)
        .cloned()
        .collect();
    apply(db, &fresh).map_err(|_| "diverged")
}

/// True when a follower at (`after`, `after_id`) holds a prefix of this log that is still kept.
pub fn can_continue_from(db: &Db, after: i64, after_id: Option<&str>) -> bool {
    if after > head(db).seq {
        return false;
    }
    if after == 0 {
        return oldest(db).is_none_or(|seq| seq <= 1);
    }
    entry_id(db, after).as_deref() == after_id
}

/// A consistent copy of the whole database, for a laptop that joins or re-syncs.
pub fn serialize(db: &Db) -> Result<Vec<u8>> {
    let path = std::env::temp_dir().join(format!("apolloon-image-{}.sqlite", crate::db::id()));
    db.conn
        .execute("VACUUM INTO ?1", [path.to_string_lossy()])
        .map_err(err)?;
    let bytes = std::fs::read(&path).map_err(err);
    let _ = std::fs::remove_file(&path);
    bytes
}

/// Replaces this laptop's event data and log with a leader's image; its own settings stay.
pub fn install(db: &mut Db, image: &[u8]) -> Result<String> {
    let path = std::env::temp_dir().join(format!("apolloon-incoming-{}.sqlite", crate::db::id()));
    std::fs::write(&path, image).map_err(err)?;
    let outcome = (|| {
        let cluster_id = {
            let incoming = rusqlite::Connection::open(&path).map_err(err)?;
            let check: String = incoming
                .query_row("PRAGMA quick_check", [], |r| r.get(0))
                .map_err(err)?;
            if check != "ok" {
                return Err(format!("De ontvangen database is beschadigd ({check})."));
            }
            let version: i64 = incoming
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .map_err(err)?;
            if version != 17 {
                return Err(format!(
                    "De ontvangen database heeft schema {version}, deze laptop 17."
                ));
            }
            incoming
                .query_row(
                    "SELECT value FROM settings WHERE key='replication_cluster_id'",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .map_err(|_| "De ontvangen database heeft geen cluster-id.".to_string())?
        };
        db.conn
            .execute("ATTACH DATABASE ?1 AS incoming", [path.to_string_lossy()])
            .map_err(err)?;
        let copied = (|| {
            let transaction = rusqlite::Transaction::new_unchecked(
                &db.conn,
                rusqlite::TransactionBehavior::Immediate,
            )
            .map_err(err)?;
            db.conn
                .execute_batch("PRAGMA defer_foreign_keys=ON")
                .map_err(err)?;
            for table in REPLICATED_TABLES.iter().rev() {
                db.conn
                    .execute(&format!("DELETE FROM main.\"{table}\""), [])
                    .map_err(err)?;
            }
            for table in REPLICATED_TABLES {
                let columns = db
                    .rows(&format!("PRAGMA main.table_info(\"{table}\")"), &[])?
                    .iter()
                    .map(|c| format!("\"{}\"", c["name"].as_str().unwrap_or("")))
                    .collect::<Vec<_>>()
                    .join(",");
                db.conn
                    .execute(
                        &format!("INSERT INTO main.\"{table}\"({columns}) SELECT {columns} FROM incoming.\"{table}\""),
                        [],
                    )
                    .map_err(err)?;
            }
            let local = LOCAL_SETTINGS
                .iter()
                .map(|k| format!("'{k}'"))
                .collect::<Vec<_>>()
                .join(",");
            db.conn
                .execute_batch(&format!(
                    "DELETE FROM main.settings WHERE key NOT IN ({local});
                     INSERT INTO main.settings(key,value) SELECT key,value FROM incoming.settings WHERE key NOT IN ({local});"
                ))
                .map_err(err)?;
            set_local(db, "replication_cluster_id", &cluster_id)?;
            transaction.commit().map_err(err)
        })();
        let _ = db.conn.execute("DETACH DATABASE incoming", []);
        copied.map(|_| cluster_id)
    })();
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
    if outcome.is_ok() {
        db.revision += 1;
    }
    outcome
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub host_id: String,
    pub url: String,
    #[serde(default)]
    pub name: Option<String>,
}

pub fn stored_members(db: &Db) -> Vec<Member> {
    db.rows("SELECT m.host_id,m.url,n.name FROM cluster_members m LEFT JOIN cluster_member_names n ON n.host_id=m.host_id ORDER BY m.added_at,m.host_id", &[])
        .unwrap_or_default()
        .into_iter()
        .filter_map(|row| {
            Some(Member {
                host_id: row["host_id"].as_str()?.to_owned(),
                url: row["url"].as_str()?.to_owned(),
                name: row["name"].as_str().map(str::to_owned),
            })
        })
        .collect()
}
pub fn save_member(db: &Db, member: &Member) -> Result<()> {
    db.exec("INSERT INTO cluster_members(host_id,url,added_at) VALUES(?,?,?) ON CONFLICT(host_id) DO UPDATE SET url=excluded.url", &[json!(member.host_id), json!(member.url), json!(now())])?;
    if let Some(name) = &member.name {
        db.exec(
            "INSERT OR REPLACE INTO cluster_member_names(host_id,name) VALUES(?,?)",
            &[json!(member.host_id), json!(name)],
        )?;
    }
    Ok(())
}
pub fn remove_member(db: &Db, host_id: &str) -> Result<()> {
    db.exec(
        "DELETE FROM cluster_members WHERE host_id=?",
        &[json!(host_id)],
    )?;
    db.exec(
        "DELETE FROM cluster_member_names WHERE host_id=?",
        &[json!(host_id)],
    )?;
    Ok(())
}
