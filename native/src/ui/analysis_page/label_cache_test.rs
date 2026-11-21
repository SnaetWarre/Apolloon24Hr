use super::*;

fn reference(s: &State) -> Vec<Value> {
    let mut labels: Vec<Value> = Vec::new();
    for label in laps(s)
        .into_iter()
        .flat_map(|lap| lap["labels"].as_array().into_iter().flatten())
        .chain(s.snapshot["labels"].as_array().into_iter().flatten())
    {
        match labels
            .iter_mut()
            .find(|held| st(held, "id") == st(label, "id"))
        {
            Some(held) => *held = label.clone(),
            None => labels.push(label.clone()),
        }
    }
    labels.sort_by(compare_labels);
    labels
}

#[test]
fn cached_labels_match_last_occurrence_and_current_overrides_byte_for_byte() {
    let mut s = init_with_url("http://127.0.0.1:0".into());
    s.history = json!({"laps":[
        {"labels":[{"id":"a","name":"Latest","kind":"group"},
            {"id":"b","name":"Same","kind":"group"}]},
        {"labels":[{"id":"a","name":"Oldest","kind":"group"},
            {"id":"c","name":"Same","kind":"group"}]}
    ]});
    for current in [
        json!([]),
        json!([{"id":"a","name":"Current","kind":"speedteam"}]),
    ] {
        s.snapshot["labels"] = current;
        assert_eq!(
            serde_json::to_vec(analysis_labels(&s).as_ref()).unwrap(),
            serde_json::to_vec(&reference(&s)).unwrap()
        );
    }
    let held = analysis_labels(&s);
    s.snapshot["runners"] = json!([{"notes":"unrelated"}]);
    assert!(Rc::ptr_eq(&held, &analysis_labels(&s)));
    s.history["laps"][0]["labels"][1]["name"] = json!("Edited");
    s.history_version += 1;
    let edited = analysis_labels(&s);
    assert!(!Rc::ptr_eq(&held, &edited));
    assert_eq!(*edited, reference(&s));
    s.snapshot["labels"][0]["name"] = json!("Renamed");
    assert!(!Rc::ptr_eq(&edited, &analysis_labels(&s)));
    assert_eq!(*analysis_labels(&s), reference(&s));
}

#[test]
fn empty_and_error_histories_keep_the_same_cached_labels() {
    let mut s = init_with_url("http://127.0.0.1:0".into());
    for history in [
        Value::Null,
        json!({"laps":[]}),
        json!({"error":"unavailable"}),
    ] {
        s.history = history;
        s.history_version += 1;
        let labels = analysis_labels(&s);
        assert!(labels.is_empty());
        assert!(Rc::ptr_eq(&labels, &analysis_labels(&s)));
    }
    s.history = json!({"laps":[{"labels":[null,{"id":"","name":"Malformed"}]}]});
    s.history_version += 1;
    assert_eq!(*analysis_labels(&s), reference(&s));
}
