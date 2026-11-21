use super::ReadVersion;
use crate::db::{Db, Result, history_changes::Changes};
use axum::body::Bytes;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

/// Every full history this server built, as numbered versions, so a client that holds one can
/// fetch only the laps and events that changed since (`/api/history?since=<cursor>`).
pub(super) struct HistoryLog {
    /// Random per server start: a cursor from another laptop or an earlier run never matches.
    epoch: String,
    version: Option<ReadVersion>,
    seq: u64,
    current: Option<CurrentHistory>,
    /// Ids of laps and events that changed (or disappeared) on the way to each `seq`.
    steps: std::collections::VecDeque<(u64, Vec<String>, Vec<String>)>,
    deltas: std::collections::HashMap<u64, Bytes>,
    #[cfg(test)]
    incremental_refreshes: usize,
}
struct CurrentHistory {
    value: Arc<Value>,
    body: Arc<Mutex<Option<Bytes>>>,
    laps: Rows,
    events: Rows,
    lap_order: std::collections::HashMap<String, i64>,
    event_order: std::collections::HashMap<String, i64>,
    runners: std::collections::HashMap<i64, Value>,
}

pub(super) enum HistoryBody {
    Cached(Bytes),
    Full {
        value: Arc<Value>,
        body: Arc<Mutex<Option<Bytes>>>,
    },
}
impl HistoryBody {
    pub(super) fn bytes(self) -> Result<Bytes> {
        match self {
            Self::Cached(body) => Ok(body),
            Self::Full { value, body } => {
                let mut body = body.lock().unwrap();
                if body.is_none() {
                    *body = Some(
                        serde_json::to_vec(value.as_ref())
                            .map_err(|e| e.to_string())?
                            .into(),
                    );
                }
                Ok(body.as_ref().unwrap().clone())
            }
        }
    }
}
/// Row id to its position in the list and a fingerprint of its content.
type Rows = std::collections::HashMap<String, (usize, u64)>;
/// Older versions are dropped first; a client further behind gets the full history again.
const HISTORY_STEPS: usize = 1024;
const HISTORY_STEP_IDS: usize = 20_000;

fn index_rows(rows: &Value) -> Rows {
    use std::hash::{Hash, Hasher};
    rows.as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, row)| {
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            row.to_string().hash(&mut hasher);
            Some((row["id"].as_str()?.to_owned(), (index, hasher.finish())))
        })
        .collect()
}
fn touched(old: &Rows, new: &Rows) -> Vec<String> {
    let changed = new
        .iter()
        .filter(|(id, (_, hash))| old.get(*id).is_none_or(|(_, before)| before != hash))
        .map(|(id, _)| id.clone());
    let removed = old.keys().filter(|id| !new.contains_key(*id)).cloned();
    changed.chain(removed).collect()
}

impl HistoryLog {
    pub(super) fn new() -> Self {
        Self {
            epoch: uuid::Uuid::new_v4().simple().to_string()[..12].to_owned(),
            version: None,
            seq: 0,
            current: None,
            steps: Default::default(),
            deltas: Default::default(),
            #[cfg(test)]
            incremental_refreshes: 0,
        }
    }
    fn cursor(&self) -> String {
        format!("{}.{}", self.epoch, self.seq)
    }
    pub(super) fn generation(&self, version: ReadVersion) -> Option<u64> {
        self.version
            .filter(|old| old.3 == version.3 && old.4 == version.4)
            .map(|old| old.2)
    }
    pub(super) fn is_current(&self, version: ReadVersion) -> bool {
        self.version == Some(version) && self.current.is_some()
    }
    pub(super) fn refresh(
        &mut self,
        db: &Db,
        version: ReadVersion,
        changes: Option<Changes>,
    ) -> Result<()> {
        if self.is_current(version) {
            return Ok(());
        }
        if let (Some(changes), Some(current)) = (changes, &mut self.current) {
            if !changes.full && current.runners_match(db, &changes)? {
                let lap_rows = db.history_rows("laps", &changes.laps)?;
                let event_rows = db.history_rows("race_events", &changes.events)?;
                let laps = current.patch("laps", &changes.laps, lap_rows);
                let events = current.patch("race_events", &changes.events, event_rows);
                #[cfg(test)]
                {
                    self.incremental_refreshes += 1;
                }
                self.seq += 1;
                let value = Arc::make_mut(&mut current.value);
                value["revision"] = json!(db.revision);
                value["cursor"] = json!(format!("{}.{}", self.epoch, self.seq));
                current.body = Default::default();
                self.steps.push_back((self.seq, laps, events));
                self.version = Some(version);
                self.prune();
                return Ok(());
            }
        }
        let mut value = db.history()?;
        let (laps, events) = (index_rows(&value["laps"]), index_rows(&value["events"]));
        let order = |table: &str| -> Result<std::collections::HashMap<String, i64>> {
            Ok(db
                .rows(&format!("SELECT rowid,id FROM {table}"), &[])?
                .into_iter()
                .map(|row| {
                    (
                        row["id"].as_str().unwrap().to_owned(),
                        row["rowid"].as_i64().unwrap(),
                    )
                })
                .collect())
        };
        let runners = db
            .rows(
                "SELECT rowid AS _rowid,id,name,runner_number AS runnerNumber FROM runners",
                &[],
            )?
            .into_iter()
            .map(|row| (row["_rowid"].as_i64().unwrap(), row))
            .collect();
        let lap_order = order("laps")?;
        let event_order = order("race_events")?;
        self.seq += 1;
        if let Some(old) = &self.current {
            self.steps.push_back((
                self.seq,
                touched(&old.laps, &laps),
                touched(&old.events, &events),
            ));
        }
        value["cursor"] = json!(self.cursor());
        self.current = Some(CurrentHistory {
            value: Arc::new(value),
            body: Default::default(),
            laps,
            events,
            lap_order,
            event_order,
            runners,
        });
        self.version = Some(version);
        self.prune();
        Ok(())
    }
    fn prune(&mut self) {
        let mut ids: usize = self.steps.iter().map(|(_, l, e)| l.len() + e.len()).sum();
        while self.steps.len() > HISTORY_STEPS || ids > HISTORY_STEP_IDS {
            let (_, l, e) = self.steps.pop_front().unwrap();
            ids -= l.len() + e.len();
        }
        self.deltas.clear();
    }
    pub(super) fn response(&mut self, cursor: Option<&str>) -> Result<HistoryBody> {
        if let Some(body) = cursor.and_then(|cursor| self.since(cursor)) {
            return Ok(HistoryBody::Cached(body));
        }
        let current = self.current.as_ref().ok_or("Geschiedenis ontbreekt")?;
        Ok(HistoryBody::Full {
            value: current.value.clone(),
            body: current.body.clone(),
        })
    }
    #[cfg(test)]
    fn full_body(&mut self) -> Result<Bytes> {
        self.response(None)?.bytes()
    }
    /// The changes since `cursor`, or `None` when this server cannot tell them apart from a
    /// full history (another epoch, or a version older than the steps it still keeps).
    pub(super) fn since(&mut self, cursor: &str) -> Option<Bytes> {
        let (epoch, seq) = cursor.rsplit_once('.')?;
        let since: u64 = seq.parse().ok()?;
        let oldest = self.steps.front().map_or(self.seq, |(seq, ..)| seq - 1);
        if epoch != self.epoch || since < oldest || since > self.seq {
            return None;
        }
        if let Some(body) = self.deltas.get(&since) {
            return Some(body.clone());
        }
        let current = self.current.as_ref()?;
        let changes = |pick: fn(&(u64, Vec<String>, Vec<String>)) -> &Vec<String>,
                       rows: &Rows,
                       list: &Value| {
            let ids: std::collections::BTreeSet<&String> = self
                .steps
                .iter()
                .filter(|step| step.0 > since)
                .flat_map(|step| pick(step))
                .collect();
            let mut changed: Vec<(usize, &Value)> = Vec::new();
            let mut removed = Vec::new();
            for id in ids {
                match rows.get(id) {
                    Some(&(index, _)) => changed.push((index, &list[index])),
                    None => removed.push(id),
                }
            }
            changed.sort_by_key(|(index, _)| *index);
            json!({"changed":changed,"removed":removed,"count":rows.len()})
        };
        let value = &current.value;
        let delta = json!({
            "scope": "full",
            "delta": true,
            "since": cursor,
            "cursor": self.cursor(),
            "revision": value["revision"],
            "changes": {
                "laps": changes(|step| &step.1, &current.laps, &value["laps"]),
                "events": changes(|step| &step.2, &current.events, &value["events"]),
            },
        });
        let body = Bytes::from(serde_json::to_vec(&delta).ok()?);
        self.deltas.insert(since, body.clone());
        Some(body)
    }
}

impl CurrentHistory {
    fn runners_match(&self, db: &Db, changes: &Changes) -> Result<bool> {
        let rows = db.history_rows("runners", &changes.runners)?;
        Ok(rows.len() == changes.runners.len()
            && rows
                .iter()
                .all(|row| self.runners.get(&row["_rowid"].as_i64().unwrap()) == Some(row)))
    }
    fn patch(
        &mut self,
        table: &str,
        rowids: &std::collections::BTreeSet<i64>,
        mut rows: Vec<Value>,
    ) -> Vec<String> {
        if rowids.is_empty() {
            return Vec::new();
        }
        let (key, time, order, index) = if table == "laps" {
            ("laps", "finishedAt", &mut self.lap_order, &mut self.laps)
        } else {
            (
                "events",
                "occurredAt",
                &mut self.event_order,
                &mut self.events,
            )
        };
        let mut ids: std::collections::BTreeSet<String> = order
            .iter()
            .filter(|(_, rowid)| rowids.contains(rowid))
            .map(|(id, _)| id.clone())
            .collect();
        for row in &rows {
            ids.insert(row["id"].as_str().unwrap().to_owned());
        }
        let list = Arc::make_mut(&mut self.value)[key].as_array_mut().unwrap();
        let mut touched = Vec::new();
        for id in &ids {
            let before = index.get(id).map(|(position, _)| &list[*position]);
            let after = rows.iter().find(|row| row["id"] == *id).map(|row| {
                let mut row = row.clone();
                row.as_object_mut().unwrap().shift_remove("_rowid");
                row
            });
            if before != after.as_ref() {
                touched.push(id.clone());
            }
        }
        list.retain(|row| !ids.contains(row["id"].as_str().unwrap()));
        order.retain(|id, _| !ids.contains(id));
        for row in &mut rows {
            let rowid = row
                .as_object_mut()
                .unwrap()
                .shift_remove("_rowid")
                .unwrap()
                .as_i64()
                .unwrap();
            order.insert(row["id"].as_str().unwrap().to_owned(), rowid);
        }
        list.extend(rows);
        list.sort_by(|a, b| {
            b[time].as_i64().cmp(&a[time].as_i64()).then_with(|| {
                order[b["id"].as_str().unwrap()].cmp(&order[a["id"].as_str().unwrap()])
            })
        });
        let mut previous = std::mem::take(index);
        for (position, row) in list.iter().enumerate() {
            let id = row["id"].as_str().unwrap();
            let hash = if ids.contains(id) {
                index_rows(&json!([row])).remove(id).unwrap().1
            } else {
                previous.remove(id).unwrap().1
            };
            index.insert(id.to_owned(), (position, hash));
        }
        touched
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::read_version;

    #[test]
    fn shared_full_answers_remain_immutable_across_an_incremental_refresh() {
        let db = Db::open(std::path::Path::new(":memory:")).unwrap();
        let mut log = HistoryLog::new();
        assert!(log.response(None).is_err());
        log.refresh(&db, read_version(&db).unwrap(), None).unwrap();
        let cursor = log.cursor();
        let old = log.response(None).unwrap();
        let same = log.response(None).unwrap();
        db.exec("INSERT INTO race_events(id,type,message,occurred_at,created_at) VALUES('event','burgie_gepakt','new',1,1)", &[]).unwrap();
        let version = read_version(&db).unwrap();
        let changes = db.history_changes_since(log.generation(version));
        log.refresh(&db, version, changes).unwrap();
        assert_eq!(log.incremental_refreshes, 1);
        let current = log.response(None).unwrap().bytes().unwrap();
        let old = old.bytes().unwrap();
        let same = same.bytes().unwrap();
        assert_eq!(old.as_ptr(), same.as_ptr());
        let old: Value = serde_json::from_slice(&old).unwrap();
        let current: Value = serde_json::from_slice(&current).unwrap();
        assert_eq!(old["events"], json!([]));
        assert_eq!(old["cursor"], cursor);
        assert_eq!(current["events"][0]["message"], "new");
        assert_ne!(old["cursor"], current["cursor"]);
        let delta = log.response(Some(&cursor)).unwrap().bytes().unwrap();
        let delta: Value = serde_json::from_slice(&delta).unwrap();
        assert_eq!(
            delta["changes"]["events"]["changed"][0][1],
            current["events"][0]
        );
    }

    fn check(
        db: &Db,
        incremental: &mut HistoryLog,
        full: &mut HistoryLog,
        cursors: &mut Vec<String>,
    ) {
        let version = read_version(db).unwrap();
        let changes = db.history_changes_since(incremental.generation(version));
        incremental.refresh(db, version, changes).unwrap();
        full.refresh(db, version, None).unwrap();
        assert_eq!(incremental.full_body().unwrap(), full.full_body().unwrap());
        for cursor in cursors.iter() {
            assert_eq!(
                incremental.since(cursor),
                full.since(cursor),
                "cursor {cursor}"
            );
        }
        cursors.push(incremental.cursor());
    }

    #[test]
    fn incremental_and_full_answers_match_handoffs_undo_edits_deletes_and_rename() {
        let mut db = Db::open(std::path::Path::new(":memory:")).unwrap();
        let runners: Vec<_> = ["One", "Two", "Three"]
            .into_iter()
            .map(|name| {
                db.mutation("runners.create", &json!({"name":name,"status":"waiting"}))
                    .unwrap()["id"]
                    .clone()
            })
            .collect();
        let (mut incremental, mut full) = (HistoryLog::new(), HistoryLog::new());
        full.epoch = incremental.epoch.clone();
        let mut cursors = Vec::new();
        check(&db, &mut incremental, &mut full, &mut cursors);
        assert_eq!(
            incremental.current.as_ref().unwrap().value["laps"],
            json!([])
        );
        assert!(incremental.since("foreign.1").is_none());
        let start = crate::db::now() - 120_000;
        for i in 0..3 {
            let race = db.race().unwrap();
            db.mutation("race.handoff", &json!({"activeRunnerId":race["activeRunnerId"],"activeStartedAt":race["activeStartedAt"],"pressedAt":start+i*21_000})).unwrap();
            check(&db, &mut incremental, &mut full, &mut cursors);
        }
        let race = db.race().unwrap();
        db.mutation("race.undoLastHandoff", &json!({"activeRunnerId":race["activeRunnerId"],"activeStartedAt":race["activeStartedAt"]})).unwrap();
        check(&db, &mut incremental, &mut full, &mut cursors);
        let race = db.race().unwrap();
        db.mutation("race.handoff", &json!({"activeRunnerId":race["activeRunnerId"],"activeStartedAt":race["activeStartedAt"],"pressedAt":start+42_000})).unwrap();
        check(&db, &mut incremental, &mut full, &mut cursors);
        db.mutation("events.burgieGepakt", &json!({})).unwrap();
        check(&db, &mut incremental, &mut full, &mut cursors);
        db.exec("UPDATE race_events SET message='edited',occurred_at=1", &[])
            .unwrap();
        check(&db, &mut incremental, &mut full, &mut cursors);
        let lap = db.history().unwrap()["laps"][0]["id"].clone();
        db.mutation("laps.split", &json!({"lapId":lap,"runnerId":runners[1]}))
            .unwrap();
        check(&db, &mut incremental, &mut full, &mut cursors);
        db.mutation("laps.move", &json!({"lapId":lap,"runnerId":runners[2]}))
            .unwrap();
        check(&db, &mut incremental, &mut full, &mut cursors);
        db.mutation("laps.delete", &json!({"lapId":lap})).unwrap();
        check(&db, &mut incremental, &mut full, &mut cursors);
        assert!(incremental.incremental_refreshes >= 10);
        let count = incremental.incremental_refreshes;
        db.mutation(
            "runners.update",
            &json!({"id":runners[1],"fields":{"name":"Renamed"}}),
        )
        .unwrap();
        check(&db, &mut incremental, &mut full, &mut cursors);
        assert_eq!(incremental.incremental_refreshes, count);
        db.exec("DELETE FROM race_events", &[]).unwrap();
        check(&db, &mut incremental, &mut full, &mut cursors);
        db.conn
            .execute_batch("BEGIN; DELETE FROM laps; ROLLBACK;")
            .unwrap();
        check(&db, &mut incremental, &mut full, &mut cursors);
        db.exec("UPDATE labels SET name=name", &[]).unwrap();
        check(&db, &mut incremental, &mut full, &mut cursors);
        db.exec(
            "INSERT OR REPLACE INTO settings VALUES('test_history','value')",
            &[],
        )
        .unwrap();
        check(&db, &mut incremental, &mut full, &mut cursors);
        db.conn
            .execute_batch("CREATE TABLE untracked(id TEXT PRIMARY KEY) WITHOUT ROWID")
            .unwrap();
        check(&db, &mut incremental, &mut full, &mut cursors);
        let count = incremental.incremental_refreshes;
        db.conn.execute_batch("BEGIN; UPDATE laps SET duration_ms=duration_ms+1; INSERT INTO untracked VALUES('new'); COMMIT;").unwrap();
        check(&db, &mut incremental, &mut full, &mut cursors);
        assert_eq!(incremental.incremental_refreshes, count);
        db.conn.execute_batch("BEGIN; UPDATE laps SET duration_ms=duration_ms+1; CREATE TABLE unknown(id); COMMIT;").unwrap();
        check(&db, &mut incremental, &mut full, &mut cursors);
        assert_eq!(incremental.incremental_refreshes, count);
        let count = incremental.incremental_refreshes;
        check(&db, &mut incremental, &mut full, &mut cursors);
        assert_eq!(incremental.incremental_refreshes, count);
    }

    #[test]
    fn a_failed_incremental_query_does_not_partially_change_the_cache() {
        let db = Db::open(std::path::Path::new(":memory:")).unwrap();
        let mut log = HistoryLog::new();
        log.refresh(&db, read_version(&db).unwrap(), None).unwrap();
        let before = log.full_body().unwrap();
        let version = log.version;
        db.conn
            .execute_batch("ALTER TABLE race_events RENAME TO hidden_events")
            .unwrap();
        let mut changes = Changes::default();
        changes.laps.insert(1);
        changes.events.insert(1);
        assert!(
            log.refresh(&db, read_version(&db).unwrap(), Some(changes))
                .is_err()
        );
        assert_eq!(log.version, version);
        assert_eq!(log.full_body().unwrap(), before);
        assert!(db.history_rows("unknown", &Default::default()).is_err());
        assert!(
            db.history_rows("laps", &Default::default())
                .unwrap()
                .is_empty()
        );
        db.conn
            .execute_batch("ALTER TABLE hidden_events RENAME TO race_events")
            .unwrap();
        log.refresh(&db, read_version(&db).unwrap(), None).unwrap();
        assert_eq!(log.current.as_ref().unwrap().value["events"], json!([]));
    }

    #[test]
    fn untracked_external_writes_force_a_full_refresh() {
        let path =
            std::env::temp_dir().join(format!("apolloon-history-{}.sqlite", uuid::Uuid::new_v4()));
        {
            let db = Db::open(&path).unwrap();
            let mut log = HistoryLog::new();
            log.refresh(&db, read_version(&db).unwrap(), None).unwrap();
            let before = db.change_token();
            let other = rusqlite::Connection::open(&path).unwrap();
            other.execute("INSERT INTO runners(id,name,created_at,updated_at) VALUES('external','External',0,0)", []).unwrap();
            let version = read_version(&db).unwrap();
            assert_ne!(before, db.change_token());
            assert!(log.generation(version).is_none());
            let copy = db.read_snapshot().unwrap();
            log.refresh(
                &copy,
                version,
                db.history_changes_since(log.generation(version)),
            )
            .unwrap();
            assert_eq!(log.incremental_refreshes, 0);
            assert_eq!(log.current.as_ref().unwrap().runners.len(), 1);
        }
        std::fs::remove_file(path).unwrap();
    }
}
