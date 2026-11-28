use super::*;
use rune::{Env, Runtime};

fn state(page: usize) -> State {
    let mut s = init_with_url("http://127.0.0.1:0".into());
    s.page = page;
    s.clock = 59_999;
    s.connected = true;
    s.snapshot = json!({"race":{"raceStartedAt":0,"activeStartedAt":0,"activeRunnerId":"a"},
        "runners":[{"id":"a","name":"Alpha","lapCount":2,"averageLapMs":60_000}],
        "labels":[{"id":"team","name":"Team","kind":"group","color":"#ffffff"}],
        "settings":{"competitions":[["team"]]}});
    s.history = json!({"laps":[{"id":"lap","runnerId":"a","runnerName":"Alpha","durationMs":60_000,"finishedAt":0,"labels":[{"id":"team","name":"Team","kind":"group"}]}]});
    s
}

fn runtime(s: State) -> Runtime<State> {
    Runtime::new(s, |s, _| view(s), (1366.0, 768.0), Env { system_dark: false, scale: 1.0 })
}

fn output(rt: &mut Runtime<State>) -> Vec<u8> {
    for _ in 0..3 { rt.frame(1.0); }
    serde_json::to_vec(&rt.elements().iter().map(|e| json!([
        e.key,e.role,e.label,e.text,e.target,format!("{:?}",e.fill),format!("{:?}",e.text_color)
    ])).collect::<Vec<_>>()).unwrap()
}

#[test]
fn ticking_public_panels_match_a_fresh_full_build_after_data_and_layout_changes() {
    for page in [5, 6] {
        let edits: Vec<fn(&mut State)> = vec![
            |s| s.clock = 60_000,
            |s| s.clock = 3_600_000,
            |s| s.snapshot["runners"][0]["name"] = json!("Changed"),
            |s| { s.history["laps"][0]["durationMs"] = json!(70_000); s.history_version += 1; },
            |s| { s.public_screens.ranking_label = Some("team".into()); s.public_screens.ranking_changed = true; },
            |s| s.public_screens.settings.apply_query(s.page, "thema=licht&zoom=125"),
            |s| s.snapshot["settings"]["competitions"] = json!([]),
            |s| { s.snapshot = Value::Null; s.history = Value::Null; s.history_version += 1; },
            |s| { s.history = json!({"error":"unavailable"}); s.history_version += 1; },
        ];
        let mut cached = runtime(state(page));
        output(&mut cached);
        for (at, edit) in edits.iter().enumerate() {
            cached.update(|s, _| edit(s));
            let mut fresh = state(page);
            for edit in &edits[..=at] { edit(&mut fresh); }
            assert_eq!(output(&mut cached), output(&mut runtime(fresh)), "page {page}, edit {at}");
        }
    }
}

#[test]
fn clock_ticks_keep_arrivals_but_new_laps_still_arrive() {
    let mut s = state(5);
    assert!(poll(&mut s, true, 59_999));
    assert!(s.public_screens.new_laps.is_empty());
    assert!(!poll(&mut s, false, 60_000));
    assert!(s.public_screens.new_laps.is_empty());
    s.history["laps"].as_array_mut().unwrap().push(json!({"id":"new","runnerId":"a","durationMs":70_000,"finishedAt":60_000}));
    s.history_version += 1;
    assert!(poll(&mut s, true, 60_000));
    assert!(s.public_screens.new_laps.contains("new"));
}
