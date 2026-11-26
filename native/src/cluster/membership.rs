//! Taking a laptop into a group or out of it, welcoming one back, and going on alone.
use super::{
    BUSY_MESSAGE, Node, activity, automatic_origin, change_timing,
    join::{list_names, normalize_url},
    log, log::Member, short_url,
};
use crate::db::Result;
use serde_json::{Value, json};

impl Node {
    /// Before the leader takes in a laptop that is new to the group: the laptop that has been
    /// silent longest is taken out, when one has been silent long enough for that. Otherwise the
    /// group grows by a laptop that cannot vote and needs every other one for a majority. Its own
    /// write, so the group changes by one laptop at a time; when it fails the link is refused.
    pub fn make_room_for(&self, member: &Member) -> Result<()> {
        let known = self
            .members()
            .iter()
            .any(|m| m.host_id == member.host_id || m.url == member.url);
        if known {
            return Ok(());
        }
        // A change the others have not confirmed yet may be an earlier laptop being taken in: a
        // second one on top of it would change the group by two laptops at once.
        if !self.group_settled() {
            return Err(
                "De laptops zijn nog bezig met een vorige wijziging. Probeer het zo opnieuw."
                    .into(),
            );
        }
        let silent = {
            let st = self.raft.lock().unwrap();
            self.view(&st)
                .into_iter()
                .filter(|v| {
                    !v.reachable && v.silent_ms >= self.cfg.removable_after.as_millis() as u64
                })
                .max_by_key(|v| v.silent_ms)
        };
        if let Some(silent) = silent {
            self.write(
                "cluster.removeLaptop",
                &json!({"hostId": silent.host_id}),
                &automatic_origin(&self.cfg.name),
                None,
            )?;
        }
        Ok(())
    }

    /// The leader takes a laptop in, or records its new address; a replicated write. A laptop
    /// whose data was wiped comes back with a new id at its old address: the old id is replaced.
    pub fn add_member(&self, member: &Member, auto: Option<&str>) -> Result<()> {
        let me = self.self_member();
        let origin = automatic_origin(&self.cfg.name);
        let _writing = self.writing.lock().unwrap();
        let mut db = self.db.lock().unwrap();
        log::record(&mut db, "cluster.addMember", None, |db| {
            let stored = log::stored_members(db);
            if !stored.iter().any(|m| m == &me) {
                log::save_member(db, &me)?;
            }
            let known = stored.iter().find(|m| m.host_id == member.host_id).cloned();
            for old in &stored {
                if old.url == member.url
                    && old.host_id != member.host_id
                    && old.host_id != me.host_id
                    && member.host_id != me.host_id
                {
                    log::remove_member(db, &old.host_id)?;
                    change_timing(db, "release", &old.host_id, None)?;
                }
            }
            log::save_member(db, member)?;
            let mut removed: Vec<String> =
                serde_json::from_value(log::json_setting(db, "cluster_removed_json"))
                    .unwrap_or_default();
            if removed.contains(&member.host_id) {
                removed.retain(|r| r != &member.host_id);
                log::set_replicated(db, "cluster_removed_json", &json!(removed))?;
            }
            if let Some(with) = auto {
                let mut links: Vec<Value> = log::json_setting(db, "cluster_auto_links_json")
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                links.retain(|l| l["hostId"] != member.host_id.as_str());
                links.insert(
                    0,
                    json!({"hostId": member.host_id, "with": with, "at": crate::db::now()}),
                );
                links.truncate(16);
                log::set_replicated(db, "cluster_auto_links_json", &json!(links))?;
            }
            let name = member
                .name
                .clone()
                .unwrap_or_else(|| short_url(&member.url).to_owned());
            match known {
                None => activity(
                    db,
                    "cluster.addMember",
                    &match auto {
                        None => format!("{name} gekoppeld met Koppelen"),
                        Some(with) => format!("{name} vanzelf gekoppeld met {with}"),
                    },
                    &origin,
                )?,
                Some(known) if known.url != member.url => activity(
                    db,
                    "cluster.address",
                    &format!("{name} heeft een nieuw adres: {}", short_url(&member.url)),
                    &origin,
                )?,
                _ => {}
            }
            Ok(Value::Null)
        })?;
        Ok(())
    }

    /// A laptop of this group asking for votes while this one leads has a new address, or is
    /// missing from the list: the leader takes it (back) in.
    pub fn welcome_back(&self, host_id: &str, url: &str, cluster_id: &str) {
        if !self.is_leader()
            || self.busy().is_some()
            || cluster_id != self.cluster_id()
            || host_id == self.host_id
        {
            return;
        }
        let Some(address) = normalize_url(url) else {
            return;
        };
        let known = self.members().into_iter().find(|m| m.host_id == host_id);
        if known.as_ref().map(|m| &m.url) != Some(&address) {
            let _ = self.add_member(
                &Member {
                    host_id: host_id.into(),
                    url: address,
                    name: known.and_then(|m| m.name),
                },
                None,
            );
        }
    }
    /// Taken out of the group on purpose, and not linked again since.
    pub fn was_removed(&self, host_id: &str) -> bool {
        self.removed().iter().any(|r| r == host_id)
            && !self.members().iter().any(|m| m.host_id == host_id)
    }

    /// Checked before a laptop is taken out: never the leader, never one that still answers.
    pub(super) fn check_removable(&self, host_id: &str) -> Result<()> {
        if !self.members().iter().any(|m| m.host_id == host_id) {
            return Err("Deze laptop hoort al niet meer bij de groep.".into());
        }
        if !self.log_settled() {
            return Err(
                "De laptops zijn nog bezig met een vorige wijziging. Probeer het zo opnieuw."
                    .into(),
            );
        }
        let st = self.raft.lock().unwrap();
        let removable = self.view(&st).iter().any(|v| {
            v.host_id == host_id
                && !v.reachable
                && v.silent_ms >= self.cfg.removable_after.as_millis() as u64
        });
        if !removable {
            return Err(
                "Deze laptop is niet lang genoeg onbereikbaar om uit de groep te halen.".into(),
            );
        }
        Ok(())
    }

    /// Makes this laptop a group of one when the others are gone. Only without a majority, and
    /// only on the Timing laptop unless Timing is taken over in the same step. Starts a new split.
    pub fn continue_alone(&self, origin: Option<&str>, take_over_timing: bool) -> Result<Value> {
        self.go_alone(origin, take_over_timing, false)
    }

    /// A press on the Timing laptop that no majority can store: the laptop goes on alone now,
    /// as it would by itself a little later, so the press is kept with its own time.
    pub(super) fn press_goes_alone(&self) -> bool {
        self.times_here()
            && self.removed_by(self.electing_grace()).is_none()
            && !self.majority_answers()
            && self.go_alone(None, false, true).is_ok()
    }

    /// Asks every other laptop of the group at once; true when enough answer for a majority.
    fn majority_answers(&self) -> bool {
        let others: Vec<Member> = self
            .members()
            .into_iter()
            .filter(|m| m.host_id != self.host_id)
            .collect();
        let cluster_id = self.cluster_id();
        let answers = std::thread::scope(|scope| {
            let asked: Vec<_> = others
                .iter()
                .map(|member| {
                    let cluster_id = &cluster_id;
                    scope.spawn(move || {
                        self.request(
                            reqwest::Method::GET,
                            &format!("{}/api/cluster/status", member.url),
                            None,
                            self.cfg.election_timeout,
                        )
                        .is_ok_and(|a| a.status == 200 && a.body["clusterId"] == cluster_id.as_str())
                    })
                })
                .collect();
            asked
                .into_iter()
                .filter_map(|answer| answer.join().ok())
                .filter(|answered| *answered)
                .count()
        });
        answers + 1 >= self.majority()
    }

    fn go_alone(&self, origin: Option<&str>, take_over_timing: bool, press: bool) -> Result<Value> {
        if self.is_leader() && !press {
            return Err("Deze laptop werkt al.".into());
        }
        if self.busy().is_some() {
            return Err(BUSY_MESSAGE.into());
        }
        if press {
            // A leader that lost the others starts over as the leader of a group of one.
            self.step_down();
        } else if self.status()["state"] != "no-majority" {
            return Err(
                "Er zijn nog genoeg laptops bereikbaar; die kiezen zelf een hoofdlaptop.".into(),
            );
        }
        let timing = self.timing();
        let takes_over = timing
            .as_ref()
            .is_some_and(|t| t["hostId"] != self.host_id.as_str());
        if takes_over && !take_over_timing {
            let name = self.timing_name(timing.as_ref().unwrap());
            return Err(format!(
                "Timing staat open op {name}: alleen daar kan je alleen verder werken. Wacht tot het netwerk terug is, of klok verder op {name}."
            ));
        }
        let others: Vec<String> = self
            .members()
            .into_iter()
            .filter(|m| m.host_id != self.host_id)
            .map(|m| m.name.unwrap_or_else(|| short_url(&m.url).to_owned()))
            .collect();
        let timing_name = timing.as_ref().map(|t| self.timing_name(t));
        if !self.take_over_alone() {
            return Err(BUSY_MESSAGE.into());
        }
        let me = self.self_member();
        let origin = origin
            .map(str::to_owned)
            .unwrap_or_else(|| automatic_origin(&self.cfg.name));
        let name = self.cfg.name.clone();
        let _writing = self.writing.lock().unwrap();
        let mut db = self.db.lock().unwrap();
        log::record(&mut db, "cluster.continueAlone", None, |db| {
            db.exec(
                "DELETE FROM cluster_members WHERE host_id!=?",
                &[json!(me.host_id)],
            )?;
            db.exec(
                "DELETE FROM cluster_member_names WHERE host_id!=?",
                &[json!(me.host_id)],
            )?;
            log::save_member(db, &me)?;
            let rank = log::json_setting(db, "cluster_split_json")["rank"]
                .as_i64()
                .unwrap_or(0);
            log::set_replicated(
                db,
                "cluster_split_json",
                &json!({"id": crate::db::id(), "rank": rank + 1}),
            )?;
            if takes_over {
                change_timing(db, "take-over", &me.host_id, Some(&name))?;
            }
            let left = if others.is_empty() {
                String::new()
            } else {
                format!(
                    "; {} {} uit de groep gehaald",
                    list_names(&others),
                    if others.len() == 1 { "is" } else { "zijn" }
                )
            };
            let took = match (&timing_name, takes_over) {
                (Some(t), true) => format!("; Timing overgenomen van {t}"),
                _ => String::new(),
            };
            activity(
                db,
                "cluster.continueAlone",
                &format!("Alleen verder gewerkt op {name}{left}{took}"),
                &origin,
            )?;
            Ok(Value::Null)
        })?;
        drop(db);
        let mut notes = self.notes.lock().unwrap();
        notes.rejoined = None;
        notes.follow_error = None;
        Ok(json!({"ok": true}))
    }
}
