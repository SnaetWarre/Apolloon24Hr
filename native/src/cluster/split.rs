//! Two splits of one group join again: the split that follows hands the changes it saved while
//! apart to the split that goes on, before it takes that split's copy. Nothing a majority
//! confirmed on either side is given up.
use super::log::{self, Entry, Statement};
use super::{Node, TIMING_PRESSES};
use crate::db::{Db, Result};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::time::Duration;

/// Which splits this group already took the changes of, and up to where: `[[key, seq], …]`.
const MERGED_SETTING: &str = "cluster_split_merged_json";
const MERGED_KEPT: usize = 8;
const MARKS_PER_REQUEST: i64 = 500;
/// Bookkeeping of the laptops themselves and the race clock: the split that goes on keeps its own.
const OWN_TABLES: [&str; 5] = [
    "race_state",
    "forwarded_writes",
    "cluster_members",
    "cluster_member_names",
    "replication_log",
];
/// Writes that replace everything; the split that goes on holds the Timing laptop and decides.
const WHOLE_EVENT_WRITES: [&str; 2] = ["race.clear", "backups.applyRestore"];

/// The table a replicated statement changes.
fn table(sql: &str) -> Option<String> {
    let lower = sql.to_ascii_lowercase();
    let mut words = lower
        .split(|c: char| c.is_whitespace() || c == '(')
        .filter(|w| !w.is_empty());
    let name = match words.next()? {
        "update" => words.find(|w| *w != "or" && !CONFLICT_WORDS.contains(w))?,
        "insert" | "replace" | "delete" => {
            words.find(|w| *w == "into" || *w == "from")?;
            words.next()?
        }
        _ => return None,
    };
    let name = name.rsplit('.').next()?;
    Some(name.trim_matches(|c| c == '"' || c == '`').to_owned())
}
const CONFLICT_WORDS: [&str; 5] = ["rollback", "abort", "replace", "fail", "ignore"];

fn strings(statement: &Statement) -> impl Iterator<Item = &str> {
    statement.params.iter().filter_map(Value::as_str)
}

/// True when the other split's statement must not run here.
fn stays_out(statement: &Statement, clocked: &HashSet<String>) -> bool {
    let Some(table) = table(&statement.sql) else {
        return true;
    };
    if OWN_TABLES.contains(&table.as_str()) {
        return true;
    }
    let sql = statement.sql.to_ascii_lowercase();
    if table == "settings" {
        return sql.contains("cluster_") || strings(statement).any(|p| p.starts_with("cluster_"));
    }
    if table == "runners" && strings(statement).any(|p| clocked.contains(p)) {
        // A runner the Timing laptop clocked meanwhile keeps the place Timing gave them.
        let places = sql.starts_with("delete")
            || sql
                .split_once(" set ")
                .map(|(_, rest)| rest.split(" where ").next().unwrap_or(rest))
                .is_some_and(|set| {
                    ["status", "queue_index", "hidden_at"]
                        .iter()
                        .any(|column| set.contains(column))
                });
        return places;
    }
    false
}

/// Runs one entry of the other split here, inside the write in progress. An entry that no
/// longer fits (its runner was removed here meanwhile) is left out as a whole.
fn replay(db: &Db, entry: &Entry, clocked: &HashSet<String>) -> bool {
    if entry.kind.starts_with("cluster.")
        || TIMING_PRESSES.contains(&entry.kind.as_str())
        || WHOLE_EVENT_WRITES.contains(&entry.kind.as_str())
    {
        return false;
    }
    // A lap correction that moves the running lap's start, or sits next to a runner or lap
    // Timing touched meanwhile, was made against a race clock that is not this one: it stays in
    // the backup instead of leaving half a correction.
    if entry.kind.starts_with("laps.")
        && entry.statements.iter().any(|statement| {
            table(&statement.sql).as_deref() == Some("race_state")
                || strings(statement).any(|p| clocked.contains(p))
        })
    {
        return false;
    }
    let captured = |db: &Db| {
        db.capture
            .borrow()
            .as_ref()
            .map_or(0, |c| c.statements.len())
    };
    let before = captured(db);
    if db.conn.execute_batch("SAVEPOINT other_split").is_err() {
        return false;
    }
    let ran = entry
        .statements
        .iter()
        .filter(|statement| !stays_out(statement, clocked))
        .try_for_each(|statement| {
            if !log::valid(statement) {
                return Err("only application data changes can be replicated".to_string());
            }
            db.exec(&statement.sql, &statement.params).map(|_| ())
        });
    if ran.is_err() {
        let _ = db
            .conn
            .execute_batch("ROLLBACK TO other_split; RELEASE other_split");
        if let Some(capture) = db.capture.borrow_mut().as_mut() {
            capture.statements.truncate(before);
        }
        return false;
    }
    let _ = db.conn.execute_batch("RELEASE other_split");
    captured(db) > before
}

/// The runners the Timing presses after `seq` touched here.
fn clocked_since(db: &Db, seq: i64) -> Result<HashSet<String>> {
    let kinds = TIMING_PRESSES
        .iter()
        .map(|k| format!("'{k}'"))
        .collect::<Vec<_>>()
        .join(",");
    let rows = db.rows(
        &format!("SELECT statements_json FROM replication_log WHERE seq>? AND type IN ({kinds})"),
        &[json!(seq)],
    )?;
    let mut clocked = HashSet::new();
    for row in rows {
        let statements: Vec<Statement> =
            serde_json::from_str(row["statements_json"].as_str().unwrap_or("[]"))
                .unwrap_or_default();
        for statement in &statements {
            // Ids only: a label or race snapshot (JSON) names no runner or lap.
            clocked.extend(
                strings(statement)
                    .filter(|p| !p.starts_with(['[', '{']))
                    .map(str::to_owned),
            );
        }
    }
    Ok(clocked)
}

impl Node {
    /// The last entry of the other split's `marks` (`[[seq, id], …]`) this laptop also holds.
    pub fn common_entry(&self, marks: &Value) -> Option<i64> {
        let db = self.db.lock().unwrap();
        marks
            .as_array()?
            .iter()
            .filter_map(|mark| Some((mark[0].as_i64()?, mark[1].as_str()?)))
            .filter(|(seq, id)| log::entry_id(&db, *seq).as_deref() == Some(*id))
            .map(|(seq, _)| seq)
            .max()
    }

    /// The leader adds what another split of this group saved after the two parted, as one
    /// write, and answers once a majority holds it. Entries it took before are not run twice.
    pub fn merge_split(&self, request: &Value) -> std::result::Result<Value, (bool, String)> {
        let refused = |message: &str| (false, message.to_owned());
        let (Some(split), Some(fork_seq), Some(fork_id)) = (
            request["split"].as_str(),
            request["forkSeq"].as_i64(),
            request["forkId"].as_str(),
        ) else {
            return Err(refused("invalid_request"));
        };
        let entries: Vec<Entry> = serde_json::from_value(request["entries"].clone())
            .map_err(|_| refused("invalid_request"))?;
        let key = format!("{split}:{fork_id}");
        let (seq, taken) = {
            let mut db = self.db.lock().unwrap();
            if log::entry_id(&db, fork_seq).as_deref() != Some(fork_id) {
                return Err(refused("unknown_fork"));
            }
            let mut merged: Vec<(String, i64)> =
                serde_json::from_value(log::json_setting(&db, MERGED_SETTING)).unwrap_or_default();
            let done = merged
                .iter()
                .find(|(k, _)| *k == key)
                .map_or(fork_seq, |(_, seq)| *seq);
            let fresh: Vec<&Entry> = entries.iter().filter(|e| e.seq > done).collect();
            let mut taken = 0;
            if let Some(last) = fresh.last() {
                let clocked = clocked_since(&db, fork_seq).map_err(|e| (false, e))?;
                merged.retain(|(k, _)| *k != key);
                merged.push((key, last.seq));
                if merged.len() > MERGED_KEPT {
                    merged.remove(0);
                }
                log::record(&mut db, "split.merge", None, |db| {
                    taken = fresh
                        .iter()
                        .filter(|entry| replay(db, entry, &clocked))
                        .count();
                    log::set_replicated(db, MERGED_SETTING, &json!(merged))?;
                    Ok(Value::Null)
                })
                .map_err(|e| (false, e))?;
            }
            (log::head(&db).seq, taken)
        };
        if !self.wait_for_commit(seq) {
            return Err((true, super::NOT_CONFIRMED_MESSAGE.into()));
        }
        Ok(json!({"ok": true, "taken": taken}))
    }

    /// Before this laptop follows the split led at `leader_url`: sends that leader what this
    /// split saved since the two parted. False when that leader could not take it now, so the
    /// join waits; true when it holds everything, or when it cannot place them (the logs no longer meet): then the
    /// backup is what keeps this split's work, as before.
    pub(super) fn hand_over_split(&self, leader_url: &str) -> bool {
        let split = self.split()["id"].as_str().unwrap_or("").to_owned();
        let mut below = i64::MAX;
        let fork = loop {
            let marks: Vec<Value> = {
                let db = self.db.lock().unwrap();
                db.rows(
                    "SELECT seq,id FROM replication_log WHERE seq<? ORDER BY seq DESC LIMIT ?",
                    &[json!(below), json!(MARKS_PER_REQUEST)],
                )
                .unwrap_or_default()
                .into_iter()
                .map(|row| json!([row["seq"], row["id"]]))
                .collect()
            };
            let Some(lowest) = marks.last().and_then(|mark| mark[0].as_i64()) else {
                return true;
            };
            let Ok(answer) = self.post(
                leader_url,
                "/api/cluster/split/common",
                &json!({"marks": marks}),
                Duration::from_secs(3),
            ) else {
                return false;
            };
            if answer.status != 200 {
                return false;
            }
            if let Some(seq) = answer.body["seq"].as_i64() {
                break seq;
            }
            below = lowest;
        };
        let Some(fork_id) = log::entry_id(&self.db.lock().unwrap(), fork) else {
            return true;
        };
        let mut after = fork;
        loop {
            let Some(entries) = log::entries_after(&self.db.lock().unwrap(), after) else {
                return true;
            };
            let Some(last) = entries.last() else {
                return true;
            };
            after = last.seq;
            let answer = self.post(
                leader_url,
                "/api/cluster/split/merge",
                &json!({"split": split, "forkSeq": fork, "forkId": fork_id, "entries": entries}),
                self.cfg.write_deadline + self.cfg.commit_timeout + Duration::from_secs(1),
            );
            match answer {
                Ok(a) if a.status == 200 => {}
                // That leader cannot place these changes at all: the backup keeps them.
                Ok(a) if a.body["code"] == "refused" => return true,
                _ => return false,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn statement(sql: &str, params: Value) -> Statement {
        Statement {
            sql: sql.into(),
            params: params.as_array().cloned().unwrap_or_default(),
        }
    }

    #[test]
    fn a_lap_correction_next_to_what_timing_clocked_meanwhile_stays_out() {
        let db = Db::open(std::path::Path::new(":memory:")).unwrap();
        db.exec(
            "INSERT INTO runners(id,name,status,created_at,updated_at) VALUES('zoe','Zoë','ran',0,0)",
            &[],
        )
        .unwrap();
        *db.capture.borrow_mut() = Some(Default::default());
        let correction = |lap: &str| Entry {
            seq: 2,
            id: lap.into(),
            epoch: 1,
            kind: "laps.split".into(),
            statements: vec![
                statement(
                    "UPDATE laps SET finished_at=?,duration_ms=? WHERE id=?",
                    json!([50, 50, "undone"]),
                ),
                statement(
                    "INSERT INTO laps(id,runner_id,lap_number,started_at,finished_at,duration_ms,source,created_at) VALUES(?,?,?,?,?,?,?,?)",
                    json!([lap, "zoe", 1, 50, 100, 50, "manual", 0]),
                ),
            ],
            created_at: 0,
        };
        let laps = |db: &Db| db.one("SELECT COUNT(*) AS n FROM laps", &[]).unwrap()["n"].clone();
        // Timing undid the handoff of lap `undone`: its split would leave a second half alone.
        assert!(!replay(&db, &correction("half"), &["undone".to_owned()].into()));
        assert_eq!(laps(&db), 0);
        assert!(replay(&db, &correction("other"), &HashSet::new()));
        assert_eq!(laps(&db), 1);
    }

    #[test]
    fn the_other_split_keeps_its_work_but_not_the_clock_or_a_clocked_runners_place() {
        let clocked: HashSet<String> = ["wout".to_owned()].into();
        let out = |sql: &str, params: Value| stays_out(&statement(sql, params), &clocked);
        assert_eq!(
            table("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)").unwrap(),
            "settings"
        );
        assert_eq!(table("DELETE FROM \"laps\" WHERE id=?").unwrap(), "laps");
        assert_eq!(
            table("UPDATE OR IGNORE runners SET name=?").unwrap(),
            "runners"
        );
        // Runners, laps and ordinary settings come along.
        assert!(!out(
            "INSERT INTO runners(id,name) VALUES(?,?)",
            json!(["mila", "Mila"])
        ));
        assert!(!out(
            "UPDATE runners SET name=?,updated_at=? WHERE id=?",
            json!(["Wout V.", 1, "wout"])
        ));
        assert!(!out(
            "UPDATE runners SET status=?,status_since=? WHERE id=?",
            json!(["waiting", 1, "mila"])
        ));
        assert!(!out("DELETE FROM laps WHERE id=?", json!(["lap"])));
        assert!(!out(
            "INSERT OR REPLACE INTO settings(key,value) VALUES('public_record_mode',?)",
            json!(["hour"])
        ));
        // The race clock, the laptops' bookkeeping and the place of a runner Timing clocked stay.
        assert!(out(
            "UPDATE race_state SET active_runner_id=? WHERE id=1",
            json!(["mila"])
        ));
        assert!(out(
            "INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)",
            json!(["cluster_timing_json", "{}"])
        ));
        assert!(out(
            "INSERT INTO cluster_members(host_id,url,added_at) VALUES(?,?,?)",
            json!(["h", "u", 1])
        ));
        assert!(out(
            "UPDATE runners SET status=?,queue_index=NULL,status_since=?,hidden_at=NULL WHERE id=?",
            json!(["registered", 1, "wout"])
        ));
        assert!(out("DELETE FROM runners WHERE id=?", json!(["wout"])));
    }
}
