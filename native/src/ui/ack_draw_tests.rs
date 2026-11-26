use super::*;
use crate::ui::{Updates, state_wake::Wakes};
use serde_json::json;
use std::sync::{Mutex, mpsc};

fn answer(method: &str, result: Result<serde_json::Value, String>) -> Update {
    Update { partial: true, outcome: Some((method.into(), result)), ..Default::default() }
}

#[test]
fn only_successful_early_handoff_with_a_lap_qualifies() {
    assert_eq!(lap(&answer("race.handoff", Ok(json!({"lapId":"saved"})))), Some("saved"));
    for update in [Update::default(), answer("race.handoff", Err("refused".into())),
        answer("race.startNext", Ok(json!({"lapId":"saved"}))),
        answer("race.handoff", Ok(json!({"lapId":null}))),
        answer("race.handoff", Ok(json!({"lapId":""}))),
        Update { partial: false, ..answer("race.handoff", Ok(json!({"lapId":"saved"}))) },
    ] { assert_eq!(lap(&update), None); }
}

#[test]
fn confirmed_ack_is_queued_once_before_its_wake_and_state_and_errors_stay_ordinary() {
    let (sender, receiver) = mpsc::channel();
    let receiver = Arc::new(Mutex::new(receiver));
    let delivered = receiver.clone();
    let laps = Arc::new(Mutex::new(Vec::new()));
    let recorded = laps.clone();
    let ordinary = Arc::new(Mutex::new(0));
    let count = ordinary.clone();
    let mut wakes = Wakes::default();
    wakes.ack = Some(Arc::new(move |id| {
            let update = delivered.lock().unwrap().try_recv().expect("ACK must be enqueued before admission");
            assert_eq!(lap(&update), Some(id.as_str()));
            recorded.lock().unwrap().push(id);
        }));
    wakes.ordinary = Some(Arc::new(move || *count.lock().unwrap() += 1));
    let updates = Updates { sender, wake: Arc::new(Mutex::new(wakes)) };
    updates.send(answer("race.handoff", Ok(json!({"lapId":"saved"})))).unwrap();
    updates.send(Update { snapshot: json!({"revision":1,"latencyLap":"saved"}), ..Default::default() }).unwrap();
    updates.send(answer("race.handoff", Err("failed".into()))).unwrap();
    assert_eq!(*laps.lock().unwrap(), ["saved"]);
    assert_eq!(*ordinary.lock().unwrap(), 2);
    assert_eq!(receiver.lock().unwrap().try_iter().count(), 2);
}

#[test]
fn no_native_ack_hook_keeps_the_existing_delivery_path() {
    let (sender, receiver) = mpsc::channel();
    let updates = Updates { sender, wake: Arc::new(Mutex::new(Wakes::default())) };
    updates.send(answer("race.handoff", Ok(json!({"lapId":"saved"})))).unwrap();
    assert_eq!(lap(&receiver.try_recv().unwrap()), Some("saved"));
}
