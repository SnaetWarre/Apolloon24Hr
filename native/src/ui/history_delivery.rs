use serde_json::{Value, json};
mod images;
pub(super) use images::Images;

#[derive(Debug, Default, PartialEq)]
pub(super) struct Delivery {
    /// Acceptance order, independent of clock or image fetch completion.
    pub(super) sequence: u64,
    pub(super) body: Value,
}

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

pub(super) fn apply(
    held: &mut Value,
    sequence: &mut u64,
    pending: &mut Vec<Delivery>,
    index: &mut super::history_sync::Index,
    version: &mut u64,
    reply: Delivery,
) -> Option<bool> {
    if reply.body.is_null() || reply.sequence <= *sequence {
        return Some(false);
    }
    if reply.body["delta"] != true {
        *sequence = reply.sequence - 1;
    }
    pending.push(reply);
    let mut changed = false;
    loop {
        pending.retain(|r| r.sequence > *sequence);
        let Some(at) = pending.iter().position(|r| r.sequence == *sequence + 1) else {
            break;
        };
        let reply = pending.remove(at);
        *sequence = reply.sequence;
        let body = reply.body;
        if body["revision"].as_i64() < held["revision"].as_i64()
            && super::same_run(&body["cursor"], &held["cursor"])
        {
            continue;
        }
        if body["delta"] == true {
            let Some(real_change) = index.apply(held, &body) else {
                *held = Value::Null;
                *index = Default::default();
                *version = version.wrapping_add(1);
                pending.clear();
                return None;
            };
            changed |= real_change;
            if real_change {
                *version = version.wrapping_add(1);
            }
        } else {
            let real_change = held["laps"] != body["laps"]
                || held["events"] != body["events"]
                || held["error"] != body["error"];
            changed |= *held != body;
            *held = body;
            if real_change {
                *index = super::history_sync::Index::new(held);
                *version = version.wrapping_add(1);
            }
        }
    }
    Some(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::Synced;

    fn apply(
        held: &mut Value,
        sequence: &mut u64,
        pending: &mut Vec<Delivery>,
        reply: Delivery,
    ) -> bool {
        let mut index = super::super::history_sync::Index::new(held);
        super::apply(held, sequence, pending, &mut index, &mut 0, reply).unwrap()
    }

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
            delivered.body["laps"][0]["payload"]
                .as_str()
                .unwrap()
                .as_ptr()
        );
        assert_eq!(
            synced.history["laps"],
            json!([{"id":"lap","labels":[{"imageUrl":"old.png"}]}])
        );
        let update = synced.take_history(delta(2, "next")).unwrap();
        assert_eq!(update.body["delta"], true);
        assert_eq!(
            synced.history["laps"],
            json!([{"id":"next","labels":[{"imageUrl":"new.png"}]}])
        );
        assert!(!super::super::image_urls(&Value::Null, &synced.history).contains("old.png"));
        assert!(super::super::image_urls(&Value::Null, &update.body).contains("new.png"));
    }

    #[test]
    fn reordered_deltas_and_full_recovery_keep_latest_history() {
        let mut synced = Synced::default();
        let initial = synced.take_history(full()).unwrap();
        let mut sequence = initial.sequence;
        let mut held = initial.body;
        let mut pending = Vec::new();
        let next = synced.take_history(delta(2, "next")).unwrap();
        let later = synced.take_history(delta(3, "last")).unwrap();
        assert!(!apply(&mut held, &mut sequence, &mut pending, later));
        assert!(apply(&mut held, &mut sequence, &mut pending, next));
        assert_eq!(held["laps"][0]["id"], "last");
        assert_eq!(held["cursor"], "epoch.3");
        assert!(pending.is_empty());
        assert!(!apply(
            &mut held,
            &mut sequence,
            &mut pending,
            synced.take_history(full()).unwrap()
        ));
        assert!(!apply(
            &mut held,
            &mut sequence,
            &mut pending,
            Delivery::default()
        ));
        let mut recovery = full();
        recovery["revision"] = json!(4);
        recovery["cursor"] = json!("new.1");
        assert!(apply(
            &mut held,
            &mut sequence,
            &mut pending,
            synced.take_history(recovery).unwrap()
        ));
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
    fn overtaken_full_reply_cannot_rewind_the_base_for_a_new_epoch_delta() {
        let mut synced = Synced::default();
        let old = synced.take_history(full()).unwrap();
        let mut recovery = full();
        recovery["cursor"] = json!("new.1");
        let newest = synced.take_history(recovery.clone()).unwrap();
        let mut held = Value::Null;
        let mut pending = Vec::new();
        let mut sequence = 0;
        assert!(apply(&mut held, &mut sequence, &mut pending, newest));
        assert!(!apply(&mut held, &mut sequence, &mut pending, old));
        assert_eq!(held, recovery);
        let mut next = delta(2, "next");
        next["since"] = json!("new.1");
        next["cursor"] = json!("new.2");
        let next = synced.take_history(next).unwrap();
        assert!(apply(&mut held, &mut sequence, &mut pending, next));
        assert_eq!(held["cursor"], "new.2");
        assert_eq!(held["laps"][0]["id"], "next");
        assert!(pending.is_empty());
    }

    #[test]
    fn empty_replies_and_unchanged_image_paths_preserve_delivery_semantics() {
        let mut synced = Synced::default();
        assert_eq!(synced.take_history(Value::Null), Some(Delivery::default()));
        let empty = json!({"revision":0,"cursor":"epoch.0","laps":[],"events":[]});
        let mut held = Value::Null;
        let mut pending = Vec::new();
        let mut sequence = 0;
        assert!(apply(
            &mut held,
            &mut sequence,
            &mut pending,
            synced.take_history(empty.clone()).unwrap()
        ));
        assert_eq!(held, empty);
        let complete = full();
        assert!(apply(
            &mut held,
            &mut sequence,
            &mut pending,
            synced.take_history(complete.clone()).unwrap()
        ));
        assert_eq!(held, complete);
        let unchanged = json!({"delta":true,"revision":2,"since":"epoch.1","cursor":"epoch.2","changes":{"laps":{"count":1,"removed":[],"changed":[]},"events":{"count":0,"removed":[],"changed":[]}}});
        assert!(!apply(
            &mut held,
            &mut sequence,
            &mut pending,
            synced.take_history(unchanged).unwrap()
        ));
        assert_eq!(held["laps"], complete["laps"]);
        assert!(super::super::image_urls(&Value::Null, &synced.history).contains("old.png"));
    }
}
