use super::*;
use rune::{Env, Runtime};

fn state() -> State {
    let mut s = init_with_url("http://127.0.0.1:0".into());
    s.page = 1;
    s.connected = true;
    s.clock = 0;
    s.snapshot = json!({"runners":[
        {"id":"a","name":"Alpha","runnerNumber":"1","status":"waiting","statusSince":0,"queueIndex":0,"lapCount":3,"estimatedPace":"1:10"},
        {"id":"b","name":"Beta","runnerNumber":"2","status":"warming_up","statusSince":0},
        {"id":"c","name":"Gamma","status":"registered"}
    ]});
    s.queue_page.registrations = json!({"c":{"availableHours":["00-12u","12-24u"],"phone":"0123456789"}});
    s
}

fn full(s: &State, _: &mut Cx<State>) -> El {
    col().key("queue-page").pb(24.0)
        .child(board(s))
        .child(available_now(s).mt(12.0))
}

fn runtime(s: State, view: fn(&State, &mut Cx<State>) -> El) -> Runtime<State> {
    Runtime::new(s, view, (1366.0, 1080.0), Env { system_dark: false, scale: 1.0 })
}

fn output(rt: &mut Runtime<State>) -> Vec<u8> {
    for _ in 0..3 { rt.frame(1.0); }
    serde_json::to_vec(&rt.elements().iter().map(|e| json!([
        e.key,e.role,e.label,e.text,e.target,format!("{:?}",e.fill),format!("{:?}",e.text_color)
    ])).collect::<Vec<_>>()).unwrap()
}

#[test]
fn ticks_cards_orders_and_boundaries_match_full_rebuild_byte_for_byte() {
    let edits: Vec<fn(&mut State)> = vec![
        |s| s.clock = 59_999,
        |s| s.clock = 60_000,
        |s| s.clock = 599_999,
        |s| s.clock = 600_000,
        |s| s.clock = 3_599_999,
        |s| s.clock = 3_600_000,
        |s| { s.snapshot["runners"][0]["name"] = json!("Changed"); s.snapshot["runners"][0]["labels"] = json!([{"name":"Team","color":"#ffffff"}]); },
        |s| { s.snapshot["runners"][1]["status"] = json!("waiting"); s.snapshot["runners"][1]["queueIndex"] = json!(-1); },
        |s| { s.snapshot["runners"].as_array_mut().unwrap().swap(0, 1); s.queue_page.filter = TextEdit::new("Alpha"); },
        |s| { s.queue_page.filter = TextEdit::new(""); s.dark = !s.dark; s.connected = false; },
        |s| { s.snapshot["runners"][0]["status"] = json!("ran"); s.queue_page.ran_open = true; },
        |s| s.clock = 35_999_999,
        |s| s.clock = 36_000_000,
        |s| { s.clock += 3_600_000; s.queue_page.available_search = TextEdit::new("Gamma"); },
        |s| s.snapshot = json!({"error":"unavailable"}),
        |s| s.snapshot = Value::Null,
    ];
    let mut cached = runtime(state(), |s, _| page(s));
    assert_eq!(output(&mut cached), output(&mut runtime(state(), full)));
    for (at, edit) in edits.iter().enumerate() {
        cached.update(|s, _| edit(s));
        let mut fresh = state();
        for edit in &edits[..=at] { edit(&mut fresh); }
        let actual: Vec<Value> = serde_json::from_slice(&output(&mut cached)).unwrap();
        let expected: Vec<Value> = serde_json::from_slice(&output(&mut runtime(fresh, full))).unwrap();
        assert_eq!(actual.len(), expected.len(), "edit {at}");
        for (index, (a, b)) in actual.iter().zip(&expected).enumerate() {
            assert_eq!(a, b, "edit {at}, element {index}");
        }
    }
}

#[test]
fn unchanged_ticks_reuse_queue_order_and_data_changes_replace_it() {
    let mut s = state();
    let positions = board_data(&s).positions;
    for now in [100, 999, 1000, 59_999, 60_000, 600_000] {
        s.clock = now;
        assert!(std::rc::Rc::ptr_eq(&positions, &board_data(&s).positions));
    }
    s.snapshot["runners"][0]["name"] = json!("Changed");
    assert!(!std::rc::Rc::ptr_eq(&positions, &board_data(&s).positions));
    s.snapshot = Value::Null;
    assert!(board_data(&s).positions.is_empty());
}
