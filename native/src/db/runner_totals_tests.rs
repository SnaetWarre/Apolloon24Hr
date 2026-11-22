use super::*;
use crate::cluster::log;
use std::path::{Path, PathBuf};

fn database() -> Db {
    Db::open(Path::new(":memory:")).unwrap()
}
fn create(db: &mut Db, name: &str) -> String {
    db.mutation("runners.create", &json!({"name":name,"status":"waiting"})).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}
fn equivalent(db: &Db) -> Vec<Value> {
    let full = db.with_runner_labels(db.rows(FULL, &[]).unwrap()).unwrap();
    let cached = db.runners().unwrap();
    assert_eq!(serde_json::to_vec(&cached).unwrap(), serde_json::to_vec(&full).unwrap());
    cached
}
fn press(db: &Db, at: i64, next: Value) -> Value {
    let race = db.race().unwrap();
    json!({"activeRunnerId":race["activeRunnerId"],"activeStartedAt":race["activeStartedAt"],"pressedAt":at,"nextRunnerId":next})
}
fn reads(db: &Db) -> (usize, usize) {
    let cache = db.runner_totals.lock().unwrap();
    (cache.full_reads, cache.runner_reads)
}

#[test]
fn empty_data_and_tied_metadata_keep_the_full_query_order() {
    let mut db = database();
    assert!(equivalent(&db).is_empty());
    create(&mut db, "Same");
    create(&mut db, "Same");
    db.exec("UPDATE runners SET status='registered',queue_index=NULL", &[]).unwrap();
    let expected = equivalent(&db);
    assert_eq!(equivalent(&db), expected);
}
fn replay(leader: &mut Db, followers: &mut [Db], method: &str, input: Value) {
    *leader.capture.borrow_mut() = Some(Default::default());
    let (_, prepared) = leader
        .mutation_run(method, &input, "test", false)
        .unwrap_or_else(|e| panic!("{method} {input}: {e}"));
    equivalent(leader);
    let entry = prepared.unwrap().entry;
    log::apply_own(leader, &entry).unwrap();
    let expected = equivalent(leader);
    for follower in followers {
        log::apply_own(follower, &entry).unwrap();
        assert_eq!(equivalent(follower), expected);
    }
}

#[test]
fn only_the_appended_runner_is_recomputed_and_metadata_stays_live() {
    let mut db = database();
    let a = create(&mut db, "Same");
    create(&mut db, "Same");
    equivalent(&db);
    assert_eq!(reads(&db), (1, 0));
    let token = db.change_token();
    equivalent(&db);
    assert_eq!(db.change_token(), token, "reads must not create writes or push notifications");
    db.mutation(
        "runners.update",
        &json!({"id":a,"fields":{"notes":"changed","labels":["Speedteam"]}}),
    )
    .unwrap();
    equivalent(&db);
    assert_eq!(reads(&db), (1, 0));
    let input = press(&db, 1_000_000, json!(a));
    db.mutation("race.startNext", &input).unwrap();
    equivalent(&db);
    let input = press(&db, 1_060_000, Value::Null);
    db.mutation("race.handoff", &input).unwrap();
    equivalent(&db);
    assert_eq!(reads(&db), (1, 1));
}

#[test]
fn append_boundaries_outliers_tied_last_laps_and_sql_number_types_match() {
    let mut db = database();
    let id = create(&mut db, "Bounds");
    equivalent(&db);
    for (i, duration) in [
        json!(0),
        json!(1),
        json!(19_999),
        json!(20_000),
        json!(60_001),
        json!(600_000),
        json!(600_001),
        json!(-1),
        json!(42_000.5),
    ]
    .into_iter()
    .enumerate()
    {
        db.exec(
            super::super::HANDOFF_LAP_INSERT,
            &[
                json!(format!("lap-{i}")),
                json!(id),
                json!(id),
                json!(0),
                json!(42),
                duration,
                json!(0),
                json!("[]"),
            ],
        )
        .unwrap();
        equivalent(&db);
    }
    assert_eq!(reads(&db), (1, 9));
}

#[test]
fn randomized_mutations_match_full_sql_on_leader_and_replayed_followers() {
    let mut leader = database();
    let ids: Vec<_> = (0..8).map(|i| create(&mut leader, &format!("Runner {i}"))).collect();
    log::set_local(&leader, "replication_cluster_id", "totals-test").unwrap();
    let image = log::serialize(&leader).unwrap();
    let mut followers = [database(), database()];
    for follower in &mut followers {
        log::install(follower, &image).unwrap();
        equivalent(follower);
    }
    equivalent(&leader);
    let mut seed = 0x51a7_3b91_u64;
    let mut at = 1_000_000_i64;
    for step in 0..240 {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        let laps = leader
            .rows("SELECT id,runner_id,duration_ms FROM laps ORDER BY rowid", &[])
            .unwrap();
        match seed % 10 {
            0 if leader.race_snapshot().unwrap()["nextUndo"].is_string() => {
                let input = press(&leader, at, Value::Null);
                replay(&mut leader, &mut followers, "race.undoLastHandoff", input);
            }
            1..=3 if !laps.is_empty() => {
                let lap = &laps[(seed as usize / 10) % laps.len()];
                let target = ids.iter().find(|id| lap["runner_id"] != **id).unwrap();
                let method = match seed % 3 {
                    0 => "laps.delete",
                    1 => "laps.move",
                    _ => "laps.split",
                };
                let method = if method == "laps.split" && lap["duration_ms"].as_i64().unwrap() < 2 {
                    "laps.delete"
                } else {
                    method
                };
                replay(&mut leader, &mut followers, method, json!({"lapId":lap["id"],"runnerId":target}));
            }
            4 => {
                replay(
                    &mut leader,
                    &mut followers,
                    "runners.importCsv",
                    json!({"csvText":format!("nummer,naam,avg\n999,Imported {step},1:30")}),
                );
            }
            _ => {
                let race = leader.race().unwrap();
                let target = ids
                    .iter()
                    .cycle()
                    .skip(seed as usize % ids.len())
                    .find(|id| race["activeRunnerId"] != ***id)
                    .unwrap()
                    .clone();
                let status = leader.runner(&target).unwrap()["status"].clone();
                if status != "waiting" {
                    replay(
                        &mut leader,
                        &mut followers,
                        "runners.setStatus",
                        json!({"id":target,"status":"waiting"}),
                    );
                }
                at += [0, 1, 19_999, 20_000, 60_001, 600_000, 600_001][step % 7];
                let input = press(&leader, at, json!(target));
                replay(&mut leader, &mut followers, "race.handoff", input);
            }
        }
        equivalent(&leader.read_snapshot().unwrap());
    }
    assert!(reads(&leader).1 > 30, "ordinary replicated laps must hit the incremental path");
    assert!(reads(&leader).0 > 10, "corrections and imports retain the full fallback");
}

struct FileDb {
    db: Db,
    directory: PathBuf,
}
impl FileDb {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!("runner-totals-{}", crate::db::id()));
        Self {
            db: Db::open(&directory.join("app.db")).unwrap(),
            directory,
        }
    }
}
impl Drop for FileDb {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

#[test]
fn wal_snapshots_reuse_totals_without_publishing_over_newer_laps() {
    let mut f = FileDb::new();
    let id = create(&mut f.db, "Snapshot");
    let input = press(&f.db, 1_000_000, json!(id));
    f.db.mutation("race.startNext", &input).unwrap();
    equivalent(&f.db.read_snapshot().unwrap());
    let old = f.db.read_snapshot().unwrap();
    let before = reads(&f.db);
    let input = press(&f.db, 1_060_001, Value::Null);
    f.db.mutation("race.handoff", &input).unwrap();
    assert_eq!(equivalent(&old)[0]["lapCount"], 0);
    assert_eq!(equivalent(&f.db.read_snapshot().unwrap())[0]["lapCount"], 1);
    assert_eq!(reads(&f.db), (before.0, before.1 + 1));
    equivalent(&f.db.read_snapshot().unwrap());
    assert_eq!(reads(&f.db), (before.0, before.1 + 1));
}

#[test]
fn rollback_savepoints_external_edits_truncation_and_replacement_are_safe() {
    let mut f = FileDb::new();
    let a = create(&mut f.db, "A");
    let b = create(&mut f.db, "B");
    let input = press(&f.db, 1_000_000, json!(a));
    f.db.mutation("race.startNext", &input).unwrap();
    let input = press(&f.db, 1_060_001, Value::Null);
    f.db.mutation("race.handoff", &input).unwrap();
    let original = equivalent(&f.db);
    f.db.conn
        .execute_batch("BEGIN; SAVEPOINT edit; UPDATE laps SET duration_ms=20000")
        .unwrap();
    equivalent(&f.db);
    f.db.conn.execute_batch("ROLLBACK TO edit; RELEASE edit; COMMIT").unwrap();
    assert_eq!(equivalent(&f.db), original);
    f.db.conn.execute_batch("BEGIN; UPDATE laps SET duration_ms=600000").unwrap();
    equivalent(&f.db);
    f.db.conn.execute_batch("ROLLBACK").unwrap();
    assert_eq!(equivalent(&f.db), original);
    let other = rusqlite::Connection::open(f.directory.join("app.db")).unwrap();
    other.execute("UPDATE laps SET runner_id=?,duration_ms=19999", [&b]).unwrap();
    equivalent(&f.db);
    f.db.exec(
        "INSERT OR REPLACE INTO laps SELECT id,?,lap_number,started_at,finished_at,20000,source,created_at,labels_json FROM laps",
        &[json!(a)],
    )
    .unwrap();
    equivalent(&f.db);
    f.db.conn.execute_batch("DELETE FROM laps").unwrap();
    assert!(equivalent(&f.db).iter().all(|r| r["lapCount"] == 0 && r["bestLapMs"].is_null()));
    assert!(f.db.mutation("runners.update", &json!({"id":a,"fields":{"name":""}})).is_err());
    equivalent(&f.db);
    f.db.conn.execute_batch("DROP TABLE laps").unwrap();
    assert!(f.db.runners().is_err());
    f.db.conn.execute_batch(include_str!("../schema.sql")).unwrap();
    equivalent(&f.db);
}

#[test]
fn startup_restore_and_cluster_image_install_use_full_totals() {
    let mut f = FileDb::new();
    let id = create(&mut f.db, "Restored");
    let input = press(&f.db, 1_000_000, json!(id));
    f.db.mutation("race.startNext", &input).unwrap();
    let input = press(&f.db, 1_600_001, Value::Null);
    f.db.mutation("race.handoff", &input).unwrap();
    let expected = equivalent(&f.db);
    assert_eq!(expected[0]["lapCount"], 1);
    let backup = crate::recovery::read(&f.directory.join("app.db")).unwrap();
    f.db.mutation("race.clear", &json!({})).unwrap();
    equivalent(&f.db);
    f.db.mutation("backups.applyRestore", &backup).unwrap();
    assert_eq!(equivalent(&f.db), expected);
    assert_eq!(equivalent(&Db::open(&f.directory.join("app.db")).unwrap()), expected);
    log::set_local(&f.db, "replication_cluster_id", "installed").unwrap();
    let image = log::serialize(&f.db).unwrap();
    let mut receiver = database();
    create(&mut receiver, "Obsolete");
    equivalent(&receiver);
    log::install(&mut receiver, &image).unwrap();
    assert_eq!(equivalent(&receiver), expected);
}
