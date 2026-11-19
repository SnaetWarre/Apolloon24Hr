//! The group test in Beheer › Systeem & herstel: a test mark goes through the replicated log
//! like any other change, every laptop is asked when its own copy has it, and the mark is
//! removed again the same way. The mark is a setting, so it never shows on a screen and never
//! counts as race data.
use super::{Node, log};
use crate::db::{Db, Result};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

/// Each test has its own key, so two tests started at once never touch each other's mark.
fn key(id: &str) -> String {
    format!("cluster_probe:{id}")
}
/// How long a laptop may take to show a change before the test calls it not reached.
const WAIT: Duration = Duration::from_secs(3);
/// How often a laptop is asked again: fine enough to time in milliseconds, light on a race laptop.
const EVERY: Duration = Duration::from_millis(25);

/// The leader's half of `cluster.probe`: set this test's mark, or remove it again.
pub(super) fn apply(db: &Db, input: &Value) -> Result<Value> {
    let id = input["id"].as_str().ok_or("Test ontbreekt")?;
    if input["remove"] == true {
        db.exec("DELETE FROM settings WHERE key=?", &[json!(key(id))])?;
    } else {
        log::set_replicated(db, &key(id), &json!(true))?;
    }
    Ok(json!({"ok": true}))
}

impl Node {
    /// `/api/cluster/probe?id=`: whether this laptop holds that test's mark, and its last change.
    pub fn probe_here(&self, id: &str) -> Value {
        let db = self.db.lock().unwrap();
        json!({
            "hostId": self.host_id,
            "has": log::setting(&db, &key(id)).is_some(),
            "logHead": log::head(&db).seq,
        })
    }

    /// Asks one laptop until `done` holds for its answer; the milliseconds since `since`, or None.
    fn watch_one(
        &self,
        url: &str,
        local: bool,
        id: &str,
        want: bool,
        since: Instant,
    ) -> (Option<u64>, Option<i64>) {
        // Counted from when the asking starts: a slow write must not use up a laptop's time.
        let deadline = Instant::now() + WAIT;
        let mut head = None;
        loop {
            let answer = if local {
                Some(self.probe_here(id))
            } else {
                self.request(
                    reqwest::Method::GET,
                    &format!("{url}/api/cluster/probe?id={id}"),
                    None,
                    Duration::from_millis(800),
                )
                .ok()
                .filter(|a| a.status == 200)
                .map(|a| a.body)
            };
            if let Some(answer) = answer {
                head = answer["logHead"].as_i64().or(head);
                if answer["has"] == want {
                    return (Some(since.elapsed().as_millis() as u64), head);
                }
            }
            if Instant::now() >= deadline {
                return (None, head);
            }
            std::thread::sleep(EVERY);
        }
    }

    /// Every laptop in the group at once.
    fn watch_all(
        &self,
        members: &[Value],
        skip: &[bool],
        id: &str,
        want: bool,
        since: Instant,
    ) -> Vec<(Option<u64>, Option<i64>)> {
        std::thread::scope(|scope| {
            let watches: Vec<_> = members
                .iter()
                .zip(skip)
                .map(|(m, &skip)| {
                    let url = m["url"].as_str().unwrap_or("").to_owned();
                    let local = m["self"] == true;
                    scope.spawn(move || {
                        if skip {
                            (None, None)
                        } else {
                            self.watch_one(&url, local, id, want, since)
                        }
                    })
                })
                .collect();
            watches
                .into_iter()
                .map(|w| w.join().unwrap_or((None, None)))
                .collect()
        })
    }

    /// `cluster.testGroup`: add the mark, see it arrive everywhere, remove it, see it go everywhere.
    pub(super) fn test_group(&self, origin: &str) -> Result<Value> {
        let status = self.status();
        let members = status["members"].as_array().cloned().unwrap_or_default();
        let id = crate::db::id();

        let added_at = Instant::now();
        self.write("cluster.probe", &json!({"id": id}), origin, None)?;
        let saved_ms = added_at.elapsed().as_millis() as u64;
        // A laptop the group already cannot reach is not waited for.
        let offline: Vec<bool> = members.iter().map(|m| m["reachable"] != true).collect();
        let added = self.watch_all(&members, &offline, &id, true, added_at);
        let missed: Vec<bool> = added.iter().map(|(ms, _)| ms.is_none()).collect();

        let removed_at = Instant::now();
        // A failed removal keeps what was measured: no laptop is then reported as having lost
        // the mark, and the leftover setting is harmless.
        let removal = self.write(
            "cluster.probe",
            &json!({"id": id, "remove": true}),
            origin,
            None,
        );
        let missed = if removal.is_ok() {
            missed
        } else {
            vec![true; members.len()]
        };
        let removed = self.watch_all(&members, &missed, &id, false, removed_at);

        let laptops: Vec<Value> = members
            .iter()
            .zip(added.iter().zip(&removed))
            .map(|(m, ((added_ms, _), (removed_ms, head)))| {
                // A laptop that never had the mark has no mark to lose either.
                let removed_ms = added_ms.and(*removed_ms);
                json!({
                    "hostId": m["hostId"],
                    "name": m["name"],
                    "url": m["url"],
                    "self": m["self"],
                    "leader": m["leader"],
                    "addedMs": added_ms,
                    "removedMs": removed_ms,
                    "logHead": head,
                    "ok": added_ms.is_some() && removed_ms.is_some(),
                })
            })
            .collect();
        let reached = laptops.iter().filter(|l| l["ok"] == true).count();
        let heads: Vec<i64> = laptops
            .iter()
            .filter_map(|l| l["logHead"].as_i64())
            .collect();
        let in_step = heads.len() == laptops.len() && heads.windows(2).all(|w| w[0] == w[1]);
        Ok(json!({
            "ok": reached == laptops.len(),
            "reached": reached,
            "total": laptops.len(),
            "savedMs": saved_ms,
            "inStep": in_step,
            "laptops": laptops,
            "at": crate::db::now(),
        }))
    }
}
