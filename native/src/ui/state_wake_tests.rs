use super::*;
use serde_json::json;
use crate::ui::{Update, Updates, poll, init_with_url};
use std::sync::{Arc, Mutex, atomic::{AtomicUsize, Ordering}};

fn snapshot(epoch: &str, revision: u64) -> Value {
    json!({"revision":revision,"changeToken":format!("{epoch}.{revision}.0"),"latencyLap":"lap"})
}

#[test]
fn revision_identity_ignores_delivery_metadata_and_accepts_new_epochs() {
    let mut wakes = Wakes::default();
    let first = snapshot("a", 10);
    assert_eq!(wakes.request(&first, false), Request::Urgent);
    let mut duplicate = first.clone();
    duplicate["serverNowMs"] = json!(100);
    duplicate["changeToken"] = json!("a.10.999");
    assert_eq!(wakes.request(&duplicate, false), Request::Ordinary("duplicate_revision"));
    assert_eq!(wakes.request(&snapshot("a", 9), false), Request::Ordinary("older_revision"));
    wakes.applied(&first);
    assert_eq!(wakes.request(&first, false), Request::Ordinary("already_applied_revision"));
    assert_eq!(wakes.request(&snapshot("a", 11), false), Request::Urgent);
    wakes.applied(&first);
    assert_eq!(wakes.request(&snapshot("a", 11), false), Request::Ordinary("duplicate_revision"));
    assert_eq!(wakes.request(&snapshot("b", 1), false), Request::Urgent);
    assert_eq!(wakes.request(&first, false), Request::Ordinary("older_revision"));
}

#[test]
fn empty_recovery_unchanged_and_invalid_updates_do_not_consume_a_revision() {
    let mut wakes = Wakes::default();
    assert_eq!(wakes.request(&Value::Null, true), Request::Ordinary("recovery_only"));
    assert_eq!(wakes.request(&Value::Null, false), Request::Ordinary("recovery_only"));
    let mut unchanged = snapshot("a", 1);
    unchanged["unchanged"] = json!(true);
    assert_eq!(wakes.request(&unchanged, false), Request::Ordinary("unchanged"));
    for invalid in [json!({}), json!({"revision":1}), json!({"revision":-1,"changeToken":"a.1"}), json!({"revision":1,"changeToken":""})] {
        assert_eq!(wakes.request(&invalid, false), Request::Ordinary("unversioned"));
    }
    assert_eq!(wakes.request(&snapshot("a", 1), true), Request::Ordinary("recovery_only"));
    assert_eq!(wakes.request(&snapshot("a", 1), false), Request::Urgent);
    for n in 0..32 { wakes.request(&snapshot(&format!("epoch-{n}"), 0), false); }
    assert_eq!(wakes.revisions.len(), 16);
}

#[test]
fn b4_4_duplicate_during_build_and_following_recovery_request_urgency_once() {
    let urgent = Arc::new(AtomicUsize::new(0));
    let ordinary = Arc::new(AtomicUsize::new(0));
    let u = urgent.clone();
    let o = ordinary.clone();
    let wakes = Wakes { ordinary: Some(Arc::new(move || { o.fetch_add(1, Ordering::SeqCst); })),
        urgent: Some(Arc::new(move || { u.fetch_add(1, Ordering::SeqCst); })), ..Default::default() };
    let (sender, receiver) = std::sync::mpsc::channel();
    let updates = Updates { sender, wake: Arc::new(Mutex::new(wakes)) };
    let state = snapshot("a", 10);
    updates.send(Update { snapshot: state.clone(), ..Default::default() }).unwrap();
    assert_eq!(urgent.load(Ordering::SeqCst), 1);
    updates.send(Update { snapshot: state.clone(), outcome: Some(("race.handoff".into(), Ok(json!({"lapId":"lap"})))), ..Default::default() }).unwrap();
    updates.send(Update { partial: true, recovery: json!({"available":true}), ..Default::default() }).unwrap();
    assert_eq!(urgent.load(Ordering::SeqCst), 1);
    assert_eq!(ordinary.load(Ordering::SeqCst), 2);
    let mut app = init_with_url("http://127.0.0.1:0".into());
    app.rx = receiver;
    app.transport_wake = updates.wake.clone();
    app.urgent_state_wake = app.transport_wake.lock().unwrap().urgent.clone();
    app.busy = true;
    poll(&mut app, 0.0, &mut rune::Tx::default());
    assert_eq!(app.snapshot["revision"], 10);
    assert_eq!(app.recovery["available"], true);
    assert!(!app.busy, "duplicate state still delivers the command outcome");
    updates.send(Update { snapshot: state, ..Default::default() }).unwrap();
    assert_eq!(urgent.load(Ordering::SeqCst), 1);
    assert_eq!(ordinary.load(Ordering::SeqCst), 3);
    updates.send(Update { snapshot: snapshot("a", 11), ..Default::default() }).unwrap();
    assert_eq!(urgent.load(Ordering::SeqCst), 2);
}

#[test]
fn disabled_urgency_keeps_every_wake_and_error_outcome_ordinary() {
    let count = Arc::new(AtomicUsize::new(0));
    let called = count.clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    let updates = Updates { sender, wake: Arc::new(Mutex::new(Wakes {
        ordinary: Some(Arc::new(move || { called.fetch_add(1, Ordering::SeqCst); })), ..Default::default()
    })) };
    updates.send(Update { snapshot: snapshot("a", 1), ..Default::default() }).unwrap();
    updates.send(Update { outcome: Some(("race.handoff".into(), Err("offline".into()))), ..Default::default() }).unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 2);
    assert!(updates.wake.lock().unwrap().revisions.is_empty());
    let mut app = init_with_url("http://127.0.0.1:0".into());
    app.rx = receiver;
    app.busy = true;
    poll(&mut app, 0.0, &mut rune::Tx::default());
    assert!(!app.busy);
    assert_eq!(app.timing_page.error, "offline");
}

#[test]
fn concurrent_transport_copies_request_urgency_once_without_losing_deliveries() {
    let count = Arc::new(AtomicUsize::new(0));
    let called = count.clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    let updates = Updates { sender, wake: Arc::new(Mutex::new(Wakes {
        urgent: Some(Arc::new(move || { called.fetch_add(1, Ordering::SeqCst); })), ..Default::default()
    })) };
    let threads: Vec<_> = (0..2).map(|_| {
        let updates = updates.clone();
        std::thread::spawn(move || {
            for _ in 0..16 { updates.send(Update { snapshot: snapshot("a", 1), ..Default::default() }).unwrap(); }
        })
    }).collect();
    for thread in threads { thread.join().unwrap(); }
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_eq!(receiver.try_iter().count(), 32);
}
