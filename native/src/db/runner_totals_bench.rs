use super::Db;
use serde_json::json;
use std::{hint::black_box, path::Path, time::Instant};

#[test]
#[ignore]
fn runner_totals_benchmark() {
    let laps: usize = std::env::var("RUNNER_TOTALS_LAPS")
        .unwrap()
        .parse()
        .unwrap();
    let directory = std::env::temp_dir().join(format!("runner-totals-bench-{}", super::id()));
    let db = Db::open(Path::new(&directory.join("app.db"))).unwrap();
    db.conn.execute_batch("BEGIN").unwrap();
    for i in 0..150 {
        db.exec("INSERT INTO runners(id,name,status,queue_index,created_at,updated_at) VALUES(?,?,'waiting',?,0,0)", &[json!(format!("runner-{i:03}")), json!(format!("Runner {i:03}")), json!(i)]).unwrap();
    }
    for i in 0..laps {
        db.exec("INSERT INTO laps(id,runner_id,lap_number,started_at,finished_at,duration_ms,source,created_at,labels_json) VALUES(?,?,?,0,?,?,'spacebar',0,'[]')", &[json!(format!("lap-{i}")), json!(format!("runner-{:03}", i % 150)), json!(i / 150 + 1), json!(i as i64 * 61_001), json!(20_000 + (i % 60_000))]).unwrap();
    }
    db.conn.execute_batch("COMMIT").unwrap();
    black_box(db.race_snapshot().unwrap());
    let mut query = Vec::new();
    let mut state = Vec::new();
    let mut snapshot = Vec::new();
    for i in 0..60 {
        for mode in 0..3 {
            let runner = json!(format!("runner-{:03}", i % 150));
            db.exec("INSERT INTO laps(id,runner_id,lap_number,started_at,finished_at,duration_ms,source,created_at,labels_json) VALUES(?,?,(SELECT COUNT(*)+1 FROM laps WHERE runner_id=?),?,?,?,'spacebar',?,?)", &[json!("sample"), runner.clone(), runner, json!(0), json!(9_000_000_000_i64), json!(60_001), json!(0), json!("[]")]).unwrap();
            let start = Instant::now();
            match mode {
                0 => {
                    black_box(db.runners().unwrap());
                    query.push(start.elapsed().as_secs_f64() * 1000.0);
                }
                1 => {
                    black_box(db.race_snapshot().unwrap());
                    state.push(start.elapsed().as_secs_f64() * 1000.0);
                }
                _ => {
                    black_box(db.read_snapshot().unwrap().race_snapshot().unwrap());
                    snapshot.push(start.elapsed().as_secs_f64() * 1000.0);
                }
            }
            db.exec("DELETE FROM laps WHERE id='sample'", &[]).unwrap();
            black_box(db.race_snapshot().unwrap());
        }
    }
    // Keep the data size fixed; warming the original dataset is outside every timed sample.
    let mean = |v: &[f64]| v[10..].iter().sum::<f64>() / (v.len() - 10) as f64;
    println!(
        "RUNNER_TOTALS {}",
        json!({"laps":laps,"queryMs":mean(&query),"stateMs":mean(&state),"snapshotStateMs":mean(&snapshot),"querySamples":query,"stateSamples":state,"snapshotSamples":snapshot})
    );
    drop(db);
    std::fs::remove_dir_all(directory).unwrap();
}
