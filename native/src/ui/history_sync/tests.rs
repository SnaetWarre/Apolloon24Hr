use super::*;
use rune::{Env, Runtime};

fn row(id: &str, finished: i64) -> Value {
    json!({"id":id,"runnerId":"runner","runnerName":"Runner","runnerNumber":"1","lapNumber":finished/60000,"finishedAt":finished,"durationMs":60000,"labels":[{"id":"team","name":"Team","kind":"speedteam","color":"#ffffff"}]})
}

fn full() -> Value {
    json!({"scope":"full","revision":1,"cursor":"epoch.1","laps":[row("a",180000),row("b",120000)],"events":[]})
}

fn delta(from: usize, laps: Value, events: Value) -> Value {
    json!({"delta":true,"revision":from+1,"since":format!("epoch.{from}"),"cursor":format!("epoch.{}",from+1),"changes":{"laps":laps,"events":events}})
}

fn change(count: usize, changed: Value, removed: Value) -> Value {
    json!({"count":count,"changed":changed,"removed":removed})
}

#[test]
fn sparse_merges_match_the_full_reference_for_inserts_edits_moves_and_removals() {
    let mut actual = full();
    let mut expected = actual.clone();
    let mut index = Index::new(&actual);
    let changes = [
        delta(
            1,
            change(2, json!([]), json!([])),
            change(0, json!([]), json!([])),
        ),
        delta(
            2,
            change(
                4,
                json!([[0, row("d", 300000)], [1, row("c", 240000)]]),
                json!([]),
            ),
            change(
                1,
                json!([[0,{"id":"event","type":"burgie_gepakt"}]]),
                json!([]),
            ),
        ),
        delta(
            3,
            change(4, json!([[2, row("a", 181000)]]), json!([])),
            change(1, json!([]), json!([])),
        ),
        delta(
            4,
            change(4, json!([[0, row("b", 360000)]]), json!([])),
            change(0, json!([]), json!(["event"])),
        ),
        delta(
            5,
            change(3, json!([]), json!(["d"])),
            change(0, json!([]), json!([])),
        ),
        delta(
            6,
            change(4, json!([[1, row("e", 270000)]]), json!([])),
            change(0, json!([]), json!([])),
        ),
        delta(
            7,
            change(0, json!([]), json!(["a", "b", "c", "e"])),
            change(0, json!([]), json!([])),
        ),
    ];
    for delta in changes {
        assert!(super::super::merge_history(&mut expected, &delta));
        assert!(index.apply(&mut actual, &delta).is_some());
        assert_eq!(
            serde_json::to_vec(&actual).unwrap(),
            serde_json::to_vec(&expected).unwrap()
        );
    }
}

#[test]
fn empty_and_identical_deltas_keep_rows_and_malformed_deltas_request_recovery() {
    let mut held = full();
    let mut index = Index::new(&held);
    let rows = held["laps"].as_array().unwrap().as_ptr();
    assert_eq!(
        index.apply(
            &mut held,
            &delta(
                1,
                change(2, json!([]), json!([])),
                change(0, json!([]), json!([]))
            )
        ),
        Some(false)
    );
    assert_eq!(held["laps"].as_array().unwrap().as_ptr(), rows);
    assert_eq!(
        index.apply(
            &mut held,
            &delta(
                2,
                change(2, json!([[0, row("a", 180000)]]), json!([])),
                change(0, json!([]), json!([]))
            )
        ),
        Some(false)
    );
    let current = held.clone();
    for bad in [
        delta(
            1,
            change(2, json!([]), json!([])),
            change(0, json!([]), json!([])),
        ),
        delta(
            3,
            change(3, json!([]), json!([])),
            change(0, json!([]), json!([])),
        ),
        delta(
            3,
            change(
                2,
                json!([[0, row("x", 1000)], [0, row("y", 2000)]]),
                json!([]),
            ),
            change(0, json!([]), json!([])),
        ),
        delta(
            3,
            change(2, json!([[2, row("x", 1000)]]), json!([])),
            change(0, json!([]), json!([])),
        ),
    ] {
        let mut held = current.clone();
        assert_eq!(Index::new(&held).apply(&mut held, &bad), None);
    }
}

#[test]
fn transport_queue_preserves_acceptance_order_and_resets_after_a_bad_delta() {
    let mut synced = Synced::default();
    synced.take_history(full()).unwrap();
    let push = delta(
        1,
        change(3, json!([[0, row("c", 240000)]]), json!([])),
        change(0, json!([]), json!([])),
    );
    let reply = synced.take_history(push.clone()).unwrap();
    assert_eq!(reply, push);
    assert!(synced.history.get("laps").is_none());
    let (sender, receiver) = mpsc::channel();
    let mut state = init_with_url("http://127.0.0.1:0".into());
    state.rx = receiver;
    for revision in [2, 1] {
        sender
            .send(Update {
                snapshot: json!({"revision":revision}),
                history_changes: Some(synced.pending.clone()),
                ..Default::default()
            })
            .unwrap();
    }
    poll(&mut state, 0.0, &mut Tx::default());
    assert_eq!(state.snapshot["revision"], 2);
    assert_eq!(state.history["laps"].as_array().unwrap().len(), 3);
    let version = state.history_version;
    synced
        .take_history(delta(
            2,
            change(3, json!([]), json!([])),
            change(0, json!([]), json!([])),
        ))
        .unwrap();
    sender
        .send(Update {
            partial: true,
            history_changes: Some(synced.pending.clone()),
            ..Default::default()
        })
        .unwrap();
    poll(&mut state, 0.0, &mut Tx::default());
    assert_eq!(state.history_version, version);
    synced
        .take_history(delta(
            3,
            change(99, json!([]), json!([])),
            change(0, json!([]), json!([])),
        ))
        .unwrap();
    sender
        .send(Update {
            partial: true,
            history_changes: Some(synced.pending.clone()),
            ..Default::default()
        })
        .unwrap();
    poll(&mut state, 0.0, &mut Tx::default());
    assert!(synced.pending.lock().unwrap().reset);
    assert_eq!(
        synced.state_path(Some("token"), None),
        "/api/state?history=1"
    );
    assert!(
        synced
            .take_history(delta(
                4,
                change(99, json!([]), json!([])),
                change(0, json!([]), json!([]))
            ))
            .is_none()
    );
    let mut recovered = full();
    recovered["revision"] = json!(5);
    recovered["cursor"] = json!("epoch.5");
    synced.take_history(recovered).unwrap();
    assert!(!synced.pending.lock().unwrap().reset);
}

fn state(history: Value, page: usize) -> State {
    let mut s = init_with_url("http://127.0.0.1:0".into());
    s.page = page;
    s.clock = 600000;
    s.snapshot = json!({"revision":1,"race":{"raceStartedAt":0,"raceFinishedAt":600000},"labels":[{"id":"team","name":"Team","kind":"speedteam","color":"#ffffff"}],"runners":[{"id":"runner","name":"Runner","runnerNumber":"1","notes":"before"}]});
    s.history = history;
    s.history_index = Index::new(&s.history);
    s.history_version = 1;
    s
}

fn output(rt: &mut Runtime<State>) -> Vec<u8> {
    for _ in 0..3 {
        rt.frame(1.0);
    }
    let elements: Vec<_> = rt
        .elements()
        .into_iter()
        .map(|e| {
            json!([
                e.key,
                e.role,
                e.label,
                e.text,
                e.target,
                format!("{:?}", e.fill),
                format!("{:?}", e.text_color)
            ])
        })
        .collect();
    serde_json::to_vec(&elements).unwrap()
}

#[test]
fn rendered_derived_output_is_byte_identical_after_incremental_and_full_history() {
    for page in [3, 4] {
        let view = |s: &State, _: &mut Cx<State>| {
            if s.page == 3 {
                col()
                    .child(analysis_page::header_meta(s))
                    .child(analysis_page::page(s))
            } else {
                tactics_page::page(s)
            }
        };
        let mut incremental = Runtime::new(
            state(full(), page),
            view,
            (1366.0, 1080.0),
            Env {
                system_dark: false,
                scale: 1.0,
            },
        );
        output(&mut incremental);
        for push in [
            delta(
                1,
                change(2, json!([]), json!([])),
                change(0, json!([]), json!([])),
            ),
            delta(
                2,
                change(3, json!([[0, row("c", 240000)]]), json!([])),
                change(0, json!([]), json!([])),
            ),
            delta(
                3,
                change(3, json!([[2, row("b", 121000)]]), json!([])),
                change(0, json!([]), json!([])),
            ),
        ] {
            let mut expected = incremental.state.history.clone();
            assert!(super::super::merge_history(&mut expected, &push));
            incremental.update(|s, _| {
                if s.history_index.apply(&mut s.history, &push).unwrap() {
                    s.history_version += 1;
                }
                s.snapshot["runners"][0]["notes"] = json!("after");
            });
            let mut fresh = state(expected, page);
            fresh.snapshot = incremental.state.snapshot.clone();
            let mut full = Runtime::new(
                fresh,
                view,
                (1366.0, 1080.0),
                Env {
                    system_dark: false,
                    scale: 1.0,
                },
            );
            assert_eq!(output(&mut incremental), output(&mut full), "page {page}");
        }
    }
}

#[test]
fn delta_images_are_collected_without_retained_laps() {
    let push = json!({"delta":true,"changes":{"laps":{"changed":[[0,{"id":"new","labels":[{"imageUrl":"/images/new.png"}]}]]}}});
    assert!(image_urls(&Value::Null, &push).contains("/images/new.png"));
}
