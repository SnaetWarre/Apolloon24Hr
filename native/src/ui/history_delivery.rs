use serde_json::{Value, json};

fn row_index(row: &Value) -> Value {
    let mut indexed = json!({"id":row["id"]});
    let labels: Vec<_> = row["labels"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|label| label["imageUrl"].as_str().filter(|url| !url.is_empty()))
        .map(|url| json!({"imageUrl":url}))
        .collect();
    if !labels.is_empty() {
        indexed["labels"] = json!(labels);
    }
    indexed
}

pub(super) fn index(full: &Value) -> Value {
    let rows = |key: &str| {
        full[key]
            .as_array()
            .map(|rows| rows.iter().map(row_index).collect::<Vec<_>>())
    };
    json!({"revision":full["revision"],"cursor":full["cursor"],"laps":rows("laps"),"events":rows("events")})
}

pub(super) fn delta_index(delta: &Value) -> Value {
    let mut delta = delta.clone();
    for key in ["laps", "events"] {
        if let Some(changed) = delta["changes"][key]["changed"].as_array_mut() {
            for pair in changed {
                if let Some(pair) = pair.as_array_mut()
                    && pair.len() > 1
                {
                    pair[1] = row_index(&pair[1]);
                }
            }
        }
    }
    delta
}

pub(super) fn apply(held: &mut Value, pending: &mut Vec<Value>, reply: Value) -> bool {
    if reply.is_null() || reply["revision"].as_i64() < held["revision"].as_i64() {
        return false;
    }
    let mut changed = false;
    if reply["delta"] == true {
        if reply["cursor"] != held["cursor"]
            && !pending.iter().any(|r| r["cursor"] == reply["cursor"])
        {
            pending.push(reply);
        }
    } else if *held != reply {
        *held = reply;
        changed = true;
    }
    loop {
        pending.retain(|r| {
            r["revision"].as_i64() >= held["revision"].as_i64() && r["cursor"] != held["cursor"]
        });
        let Some(at) = pending.iter().position(|r| r["since"] == held["cursor"]) else {
            break;
        };
        let delta = pending.remove(at);
        changed |= super::merge_history(held, &delta);
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::Synced;

    fn full() -> Value {
        json!({"revision":1,"cursor":"epoch.1","laps":[{"id":"lap","labels":[{"imageUrl":"old.png"}],"payload":"x".repeat(100_000)}],"events":[]})
    }
    fn delta(seq: i64, id: &str) -> Value {
        json!({"delta":true,"revision":seq,"since":format!("epoch.{}",seq-1),"cursor":format!("epoch.{seq}"),"changes":{"laps":{"count":1,"removed":[if seq==2 {"lap"} else {"next"}],"changed":[[0,{"id":id,"labels":[{"imageUrl":"new.png"}]}]]},"events":{"count":0,"removed":[],"changed":[]}}})
    }

    #[test]
    fn full_payload_moves_and_transport_retains_only_identity_rows() {
        let mut synced = Synced::default();
        let reply = full();
        let payload = reply["laps"][0]["payload"].as_str().unwrap().as_ptr();
        let delivered = synced.take_history(reply).unwrap();
        assert_eq!(
            payload,
            delivered["laps"][0]["payload"].as_str().unwrap().as_ptr()
        );
        assert_eq!(
            synced.history["laps"],
            json!([{"id":"lap","labels":[{"imageUrl":"old.png"}]}])
        );
        let update = synced.take_history(delta(2, "next")).unwrap();
        assert_eq!(update["delta"], true);
        assert_eq!(
            synced.history["laps"],
            json!([{"id":"next","labels":[{"imageUrl":"new.png"}]}])
        );
        assert!(!super::super::image_urls(&Value::Null, &synced.history).contains("old.png"));
        assert!(super::super::image_urls(&Value::Null, &update).contains("new.png"));
    }

    #[test]
    fn reordered_deltas_and_full_recovery_keep_latest_history() {
        let mut synced = Synced::default();
        let mut held = synced.take_history(full()).unwrap();
        let mut pending = Vec::new();
        let next = synced.take_history(delta(2, "next")).unwrap();
        let later = synced.take_history(delta(3, "last")).unwrap();
        assert!(!apply(&mut held, &mut pending, later));
        assert!(apply(&mut held, &mut pending, next));
        assert_eq!(held["laps"][0]["id"], "last");
        assert_eq!(held["cursor"], "epoch.3");
        assert!(pending.is_empty());
        assert!(!apply(&mut held, &mut pending, full()));
        assert!(!apply(&mut held, &mut pending, Value::Null));
        let mut recovery = full();
        recovery["revision"] = json!(4);
        recovery["cursor"] = json!("new.1");
        assert!(apply(&mut held, &mut pending, recovery));
        assert_eq!(held["laps"][0]["id"], "lap");
    }

    #[test]
    fn invalid_delta_still_requests_full_recovery() {
        let mut synced = Synced::default();
        synced.take_history(full()).unwrap();
        let mut invalid = delta(2, "next");
        invalid["changes"]["laps"]["count"] = json!(0);
        assert!(synced.take_history(invalid).is_none());
        assert!(synced.history.is_null());
    }

    #[test]
    fn empty_replies_and_unchanged_image_paths_preserve_delivery_semantics() {
        let mut synced = Synced::default();
        assert_eq!(synced.take_history(Value::Null), Some(Value::Null));
        let empty = json!({"revision":0,"cursor":"epoch.0","laps":[],"events":[]});
        let mut held = Value::Null;
        let mut pending = Vec::new();
        assert!(apply(
            &mut held,
            &mut pending,
            synced.take_history(empty.clone()).unwrap()
        ));
        assert_eq!(held, empty);
        let complete = full();
        assert!(apply(
            &mut held,
            &mut pending,
            synced.take_history(complete.clone()).unwrap()
        ));
        assert_eq!(held, complete);
        let unchanged = json!({"delta":true,"revision":2,"since":"epoch.1","cursor":"epoch.2","changes":{"laps":{"count":1,"removed":[],"changed":[]},"events":{"count":0,"removed":[],"changed":[]}}});
        assert!(apply(
            &mut held,
            &mut pending,
            synced.take_history(unchanged).unwrap()
        ));
        assert_eq!(held["laps"], complete["laps"]);
        assert!(super::super::image_urls(&Value::Null, &synced.history).contains("old.png"));
    }
}
