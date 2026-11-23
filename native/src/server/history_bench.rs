use super::*;
use crate::server::{Host, read_version};
use std::time::Instant;

fn cpu_us() -> u64 {
    #[cfg(unix)]
    {
        let mut time = std::mem::MaybeUninit::<libc::timespec>::uninit();
        assert_eq!(
            unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, time.as_mut_ptr()) },
            0
        );
        let time = unsafe { time.assume_init() };
        time.tv_sec as u64 * 1_000_000 + time.tv_nsec as u64 / 1000
    }
    #[cfg(not(unix))]
    {
        0
    }
}

fn wait_for_leader(node: &crate::cluster::Node) {
    let deadline = Instant::now() + std::time::Duration::from_secs(5);
    while !node.is_leader() {
        assert!(Instant::now() < deadline, "leader election timed out");
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

fn replicated_config() -> crate::cluster::Config {
    let mut config =
        crate::cluster::Config::test("http://127.0.0.1:5173".into(), "history regression");
    config.maintenance = std::time::Duration::from_secs(60);
    config
}

#[test]
#[ignore = "release-mode history refresh measurement"]
fn history_refresh_timing() {
    let db = Arc::new(Mutex::new(seeded()));
    let host = Host::with_cluster(db.clone(), 5173, None);
    measure_handoffs(db, host);
}

fn seeded() -> Db {
    let db = Db::open(std::path::Path::new(":memory:")).unwrap();
    db.conn.execute_batch("BEGIN").unwrap();
    for i in 0..40 {
        db.exec("INSERT INTO runners(id,runner_number,name,status,queue_index,status_since,created_at,updated_at) VALUES(?,?,?,?,?,0,0,0)",
            &[json!(format!("bench-{i}")), json!((i+1).to_string()), json!(format!("Bench {i:02}")), json!(if i == 0 { "running" } else { "waiting" }), json!(i)]).unwrap();
    }
    for i in 0..2255 {
        db.exec("INSERT INTO laps(id,runner_id,lap_number,started_at,finished_at,duration_ms,source,created_at,labels_json) VALUES(?,?,?,?,?,20000,'timing',0,?)",
            &[json!(format!("seed-{i}")), json!(format!("bench-{}",i%40)), json!(i/40+1), json!(i*60000), json!(i*60000+20000), json!([{ "id":"label", "name":"Bench", "color":"#123456", "icon":"", "kind":"team" }]).to_string().into()]).unwrap();
    }
    db.exec("UPDATE race_state SET active_runner_id='bench-0',active_started_at=200000000,race_started_at=1,race_finished_at=NULL,active_labels_json='[]' WHERE id=1", &[]).unwrap();
    db.conn.execute_batch("COMMIT").unwrap();
    db
}

fn measure_handoffs(db: Arc<Mutex<Db>>, host: Host) {
    {
        let db = db.lock().unwrap();
        let mut log = host.history.lock().unwrap();
        log.refresh(&db, read_version(&db).unwrap(), None).unwrap();
        let full = log.response(None).unwrap().bytes().unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&full).unwrap()["laps"]
                .as_array()
                .unwrap()
                .len(),
            2255
        );
    }
    for retained in [false, true] {
        for i in 0..8 {
            let (cursor, old) = {
                let mut log = host.history.lock().unwrap();
                (log.cursor(), retained.then(|| log.response(None).unwrap()))
            };
            let (snapshot, version, changes, operation) = {
                let mut db = db.lock().unwrap();
                let race = db.race().unwrap();
                let operation = match i {
                    6 => "race.undoLastHandoff",
                    7 => "laps.delete",
                    _ => "race.handoff",
                };
                let args = if i == 7 {
                    json!({"lapId":"seed-2000"})
                } else {
                    json!({"activeRunnerId":race["activeRunnerId"],"activeStartedAt":race["activeStartedAt"],"pressedAt":200021000+(i+if retained {8}else{0})*21000})
                };
                let args = if i == 7 && retained {
                    json!({"lapId":"seed-2001"})
                } else {
                    args
                };
                db.mutation(operation, &args).unwrap();
                let version = read_version(&db).unwrap();
                let changes = db
                    .history_changes_since(host.history.lock().unwrap().generation(version))
                    .unwrap();
                assert!(!changes.full);
                (db.read_snapshot().unwrap(), version, changes, operation)
            };
            let mut log = host.history.lock().unwrap();
            let before = log.incremental_refreshes;
            let cpu = cpu_us();
            let start = Instant::now();
            log.refresh(&snapshot, version, Some(changes)).unwrap();
            let refresh = start.elapsed();
            let cpu = cpu_us() - cpu;
            let start = Instant::now();
            let delta = log.response(Some(&cursor)).unwrap();
            let response = start.elapsed();
            let start = Instant::now();
            let full = log.response(None).unwrap();
            let full_response = start.elapsed();
            assert_eq!(log.incremental_refreshes, before + 1);
            drop(log);
            let start = Instant::now();
            let full = full.bytes().unwrap();
            let serialize = start.elapsed();
            eprintln!(
                "HISTORY_BENCH retained={retained} operation={operation} refresh_us={} cpu_us={cpu} delta_us={} full_response_us={} serialize_outside_us={}",
                refresh.as_micros(),
                response.as_micros(),
                full_response.as_micros(),
                serialize.as_micros()
            );
            assert!(!full.is_empty());
            assert!(!delta.bytes().unwrap().is_empty());
            if let Some(old) = old {
                assert!(!old.bytes().unwrap().is_empty());
            }
        }
    }
}

#[test]
#[ignore = "release-mode replicated history refresh measurement"]
fn replicated_history_refresh_timing() {
    {
        let mut control = seeded();
        let generation = control.history_generation();
        *control.capture.borrow_mut() = Some(Default::default());
        let race = control.race().unwrap();
        let (_, prepared) = control.mutation_run("race.handoff", &json!({"activeRunnerId":race["activeRunnerId"],"activeStartedAt":race["activeStartedAt"],"pressedAt":200021000}), "bench", false).unwrap();
        assert!(prepared.is_some());
        let changes = control.history_changes_since(Some(generation)).unwrap();
        assert!(!changes.full);
        assert_eq!(control.history_generation(), generation);
        assert_eq!(
            control.history().unwrap()["laps"].as_array().unwrap().len(),
            2255
        );
        eprintln!(
            "HISTORY_ROLLBACK_CONTROL full={} laps_unchanged=true",
            changes.full
        );
    }
    let db = Arc::new(Mutex::new(seeded()));
    let host = Host::with_cluster(db.clone(), 5173, Some(replicated_config()));
    let node = host.cluster.as_ref().unwrap();
    node.action("cluster.openTiming", &json!({"takeOver":true}), "bench")
        .unwrap();
    wait_for_leader(node);
    {
        let writer = db.lock().unwrap();
        host.history
            .lock()
            .unwrap()
            .refresh(&writer, read_version(&writer).unwrap(), None)
            .unwrap();
    }
    for i in 0..5 {
        let old = host.history.lock().unwrap().response(None).unwrap();
        let race = db.lock().unwrap().race().unwrap();
        node.action("race.handoff", &json!({"activeRunnerId":race["activeRunnerId"],"activeStartedAt":race["activeStartedAt"],"pressedAt":200021000+i*21000}), "bench").unwrap();
        let (snapshot, version, changes) = {
            let writer = db.lock().unwrap();
            let version = read_version(&writer).unwrap();
            let changes = writer
                .history_changes_since(host.history.lock().unwrap().generation(version))
                .unwrap();
            (writer.read_snapshot().unwrap(), version, changes)
        };
        let start = Instant::now();
        let full = snapshot.history().unwrap();
        let db_read = start.elapsed();
        std::hint::black_box(full);
        let mut log = host.history.lock().unwrap();
        let count = log.incremental_refreshes;
        let full = changes.full;
        assert!(!full);
        let cpu = cpu_us();
        let start = Instant::now();
        log.refresh(&snapshot, version, Some(changes)).unwrap();
        let elapsed = start.elapsed();
        let cpu = cpu_us() - cpu;
        assert_eq!(log.incremental_refreshes, count + 1);
        eprintln!(
            "HISTORY_REPLICATED full={full} incremental={} refresh_us={} cpu_us={cpu} full_db_read_us={}",
            log.incremental_refreshes - count,
            elapsed.as_micros(),
            db_read.as_micros()
        );
        drop(log);
        std::hint::black_box(old.bytes().unwrap());
    }
    node.stop();
}

#[test]
fn replicated_handoffs_undo_and_lap_edits_refresh_incrementally() {
    let db = Arc::new(Mutex::new(seeded()));
    let host = Host::with_cluster(db.clone(), 5173, Some(replicated_config()));
    let node = host.cluster.as_ref().unwrap();
    node.action("cluster.openTiming", &json!({"takeOver":true}), "test")
        .unwrap();
    wait_for_leader(node);
    let (mut incremental, mut full) = (HistoryLog::new(), HistoryLog::new());
    full.epoch = incremental.epoch.clone();
    let mut cursors = Vec::new();
    let check = |incremental: &mut HistoryLog,
                 full: &mut HistoryLog,
                 cursors: &mut Vec<String>,
                 expected_increment: usize| {
        let writer = db.lock().unwrap();
        let version = read_version(&writer).unwrap();
        let changes = writer.history_changes_since(incremental.generation(version));
        if expected_increment == 1 {
            assert!(
                !changes.as_ref().unwrap().full,
                "refresh count {}",
                incremental.incremental_refreshes
            );
        }
        let snapshot = writer.read_snapshot().unwrap();
        let before = incremental.incremental_refreshes;
        incremental.refresh(&snapshot, version, changes).unwrap();
        full.refresh(&snapshot, version, None).unwrap();
        assert_eq!(
            incremental.incremental_refreshes,
            before + expected_increment
        );
        assert_eq!(incremental.full_body().unwrap(), full.full_body().unwrap());
        for cursor in cursors.iter() {
            assert_eq!(incremental.since(cursor), full.since(cursor));
        }
        cursors.push(incremental.cursor());
    };
    check(&mut incremental, &mut full, &mut cursors, 0);
    let mut lap = Value::Null;
    for (i, method) in [
        "race.handoff",
        "race.undoLastHandoff",
        "race.handoff",
        "laps.move",
        "laps.delete",
    ]
    .into_iter()
    .enumerate()
    {
        let race = db.lock().unwrap().race().unwrap();
        let input = match method {
            "laps.move" => json!({"lapId":lap,"runnerId":"bench-3"}),
            "laps.delete" => json!({"lapId":lap}),
            _ => {
                json!({"activeRunnerId":race["activeRunnerId"],"activeStartedAt":race["activeStartedAt"],"pressedAt":200021000+i as i64*21000})
            }
        };
        let result = node.action(method, &input, "test").unwrap();
        if method == "race.handoff" {
            lap = result["lapId"].clone();
            assert!(lap.is_string());
        }
        check(&mut incremental, &mut full, &mut cursors, 1);
        let writer = db.lock().unwrap();
        let count = writer
            .rows("SELECT COUNT(*) AS n FROM laps WHERE id=?", &[lap.clone()])
            .unwrap()[0]["n"]
            .as_i64()
            .unwrap();
        assert_eq!(
            count,
            if matches!(method, "race.undoLastHandoff" | "laps.delete") {
                0
            } else {
                1
            }
        );
    }
    node.action(
        "runners.update",
        &json!({"id":"bench-3","fields":{"name":"Renamed"}}),
        "test",
    )
    .unwrap();
    check(&mut incremental, &mut full, &mut cursors, 0);
    node.stop();
}
