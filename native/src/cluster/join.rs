//! Joining a group, going on alone, taking a laptop out, and the maintenance round that brings
//! splits of a group back together (port of the joining half of server/cluster.ts and
//! shared/linking.ts).
use super::{
    BUSY_MESSAGE, Node, activity, automatic_origin, change_timing, log, log::Member, short_url,
};
use crate::db::Result;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

const INVITE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_KNOWN_PEERS: usize = 16;
const AUTO_LINK_FAILED_ROUNDS_SHOWN: u32 = 3;

#[derive(Default, Clone)]
pub struct Options {
    /// Not pressed here (an invite, or linking by itself).
    pub asked: bool,
    /// A laptop of this group joined that group already: this one follows it.
    pub follow: bool,
    /// Joining another split of this group; the rest of this split follows.
    pub split: Option<String>,
    pub auto_linked_with: Option<String>,
}

/// What a group tells about itself when two groups link (shared/linking.ts LinkSide).
#[derive(Clone, Debug)]
pub struct Side {
    pub cluster_id: String,
    pub race_started: bool,
    pub race_running: bool,
    pub runners: i64,
    pub changed: bool,
    pub laptops: i64,
}
impl Side {
    fn of(status: &Value) -> Self {
        Self {
            cluster_id: status["clusterId"].as_str().unwrap_or("").into(),
            race_started: status["raceStarted"] == true,
            race_running: status["raceRunning"] == true,
            runners: status["runners"].as_i64().unwrap_or(0),
            changed: status["changed"] == true,
            laptops: status["members"]
                .as_array()
                .map(|m| m.len() as i64)
                .or(status["laptops"].as_i64())
                .unwrap_or(1),
        }
    }
}

/// Before the race (it started on neither side), the joining side's runners merge into the other group.
pub fn runners_merge(a: &Side, b: &Side) -> bool {
    !a.race_started && !b.race_started
}
fn race_keeps(a: &Side, b: &Side) -> Option<&'static str> {
    if a.race_running && !b.race_running {
        Some("running")
    } else if a.race_started && !b.race_started {
        Some("started")
    } else {
        None
    }
}
/// Which way Koppelen links two groups; both sides work it out alike, so a press on both at once
/// links them one way. `join`: this side takes the other's data; `invite`: the other side is asked
/// over; `there`: press on the other laptop.
pub fn link_direction(own: &Side, other: &Side) -> &'static str {
    let merging = runners_merge(own, other);
    let before_race = || {
        if other.changed != own.changed {
            other.changed
        } else if other.laptops != own.laptops {
            other.laptops > own.laptops
        } else if other.runners != own.runners {
            other.runners > own.runners
        } else {
            other.cluster_id < own.cluster_id
        }
    };
    let other_keeps = if merging {
        before_race()
    } else if race_keeps(other, own).is_some() {
        true
    } else if race_keeps(own, other).is_some() {
        false
    } else if other.runners != own.runners {
        other.runners > own.runners
    } else {
        before_race()
    };
    if other_keeps {
        "join"
    } else if merging || other.runners == 0 {
        "invite"
    } else {
        "there"
    }
}

fn runner_label(count: i64) -> String {
    format!("{count} {}", if count == 1 { "loper" } else { "lopers" })
}
fn list_names(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} en {last}", rest.join(", ")),
    }
}

impl Node {
    fn own_side(&self) -> Side {
        let mut status = self.status();
        status["laptops"] = json!(self.members().len());
        Side::of(&status)
    }

    fn not_joined() -> Value {
        json!({"backupFile": null, "merged": false})
    }

    fn wait_while_joining(&self) {
        let deadline = Instant::now() + INVITE_TIMEOUT / 2;
        while self.busy().is_some() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// The laptop at `raw`, checked to be another laptop that can be linked with this one.
    fn other_laptop(&self, raw: &str) -> Result<(String, Value)> {
        let url = normalize_url(raw).ok_or("Vul het adres van een andere laptop in.")?;
        if url == self.self_url() {
            return Err("Vul het adres van een andere laptop in.".into());
        }
        let status = self
            .fetch_status(&url)
            .map_err(|_| format!("{url} is niet bereikbaar. Controleer het adres en de kabel."))?;
        if status["enabled"] != true {
            return Err("Op die laptop staat laptops koppelen uit.".into());
        }
        if status["hostId"] == self.host_id.as_str() {
            return Err("Dat adres is deze laptop zelf.".into());
        }
        if status["appVersion"] != super::APP_VERSION
            || status["schemaVersion"] != super::SCHEMA_VERSION
        {
            return Err(format!(
                "Die laptop draait een andere versie ({}). Installeer overal dezelfde versie.",
                status["appVersion"].as_str().unwrap_or("onbekend")
            ));
        }
        Ok((url, status))
    }

    fn press_there_message(&self, url: &str, status: &Value) -> String {
        let other = short_url(url);
        let own = self.own_side();
        let why = match race_keeps(&own, &Side::of(status)) {
            Some("running") => format!("Op deze laptop loopt de race, op {other} niet."),
            Some(_) => format!("Op deze laptop is de race al gestart, op {other} nog niet."),
            None => format!(
                "Op deze laptop staan {}, op {other} {}.",
                runner_label(own.runners),
                runner_label(status["runners"].as_i64().unwrap_or(0))
            ),
        };
        format!(
            "{why} Druk op Koppelen op {other}: die neemt dan de gegevens van deze laptop over."
        )
    }

    /// Koppelen, pressed on this laptop next to the laptop at `raw`.
    pub fn link_with(&self, raw: &str) -> Result<Value> {
        self.wait_while_joining();
        let (url, status) = self.other_laptop(raw)?;
        if status["clusterId"] == self.cluster_id().as_str() {
            // Already linked, for example because Koppelen was pressed on the other laptop too.
            if status["members"]
                .as_array()
                .is_some_and(|m| m.iter().any(|m| m["hostId"] == self.host_id.as_str()))
            {
                return Ok(Self::not_joined());
            }
            return self.join_group(&url, Options::default());
        }
        match link_direction(&self.own_side(), &Side::of(&status)) {
            "join" => self.join_once(
                &url,
                status["clusterId"].as_str().unwrap_or(""),
                Options::default(),
            ),
            "there" => Err(self.press_there_message(&url, &status)),
            _ => {
                let answer = self
                    .post(
                        &url,
                        "/api/cluster/invite",
                        &json!({"url": self.self_url(), "clusterId": self.cluster_id()}),
                        INVITE_TIMEOUT,
                    )
                    .map_err(|_| "Koppelen mislukt.".to_string())?;
                if answer.status != 200 {
                    return Err(answer.body["error"]
                        .as_str()
                        .unwrap_or("Koppelen mislukt.")
                        .into());
                }
                Ok(json!({"backupFile": null, "merged": answer.body["merged"] == true}))
            }
        }
    }

    /// Another laptop pressed Koppelen next to this one and keeps its data, or a laptop of this
    /// group joined another group (`follow`) or another split (`split`): this laptop joins too.
    pub fn accept_invite(&self, request: &Value) -> Result<bool> {
        self.wait_while_joining();
        let url = request["url"].as_str().unwrap_or("");
        let cluster_id = request["clusterId"].as_str().unwrap_or("");
        if request["split"].is_string() {
            self.follow_split(url);
            return Ok(false);
        }
        if self.cluster_id() == cluster_id {
            return Ok(false);
        }
        let following = request["follow"].as_str() == Some(&self.cluster_id());
        let options = Options {
            asked: !following,
            follow: following,
            split: None,
            auto_linked_with: request["autoLinkedWith"].as_str().map(str::to_owned),
        };
        self.join_once(url, cluster_id, options)
            .map(|result| result["merged"] == true)
    }

    /// A press on both laptops at once starts two joins; the second waits for the first.
    fn join_once(&self, url: &str, cluster_id: &str, options: Options) -> Result<Value> {
        match self.join_group(url, options) {
            Ok(result) => Ok(result),
            Err(error) => {
                self.wait_while_joining();
                if self.cluster_id() == cluster_id {
                    Ok(Self::not_joined())
                } else {
                    Err(error)
                }
            }
        }
    }

    /// Joins the group of the laptop at `raw`, replacing this laptop's data with the group's.
    /// Before the race this laptop's runners and labels go into that group first; the rest of
    /// this laptop's group follows.
    pub fn join_group(&self, raw: &str, options: Options) -> Result<Value> {
        let (url, status) = self.other_laptop(raw)?;
        let own = self.own_side();
        let there = Side::of(&status);
        let other_cluster = there.cluster_id != own.cluster_id;
        if other_cluster && !options.follow && link_direction(&own, &there) != "join" {
            return Err(self.press_there_message(&url, &status));
        }
        let merging = other_cluster
            && !options.follow
            && runners_merge(&own, &there)
            && (own.runners > 0 || own.changed);
        if options.asked && !merging && own.runners > 0 {
            return Err("Op die laptop staan intussen lopers. Druk daar op Koppelen.".into());
        }
        if !self.start_joining() {
            return Err(BUSY_MESSAGE.into());
        }
        let followers: Vec<Member> =
            if (other_cluster && !options.follow) || options.split.is_some() {
                self.members()
                    .into_iter()
                    .filter(|m| m.host_id != self.host_id)
                    .collect()
            } else {
                Vec::new()
            };
        let mut joined = None;
        let outcome = (|| {
            if merging {
                self.merge_into(&url)?;
            }
            let deadline = Instant::now() + self.cfg.write_deadline;
            let mut group = Some((url.clone(), status.clone()));
            loop {
                if let Some((group_url, group_status)) = &group {
                    if let Ok(leader) =
                        serde_json::from_value::<Member>(group_status["leader"].clone())
                    {
                        let leader_url = if group_status["hostId"] == leader.host_id.as_str() {
                            group_url.clone()
                        } else {
                            leader.url.clone()
                        };
                        // Another split of this group first takes what this split saved while apart.
                        let handed = options.split.is_none() || self.hand_over_split(&leader_url);
                        if handed
                            && let Some((term, backup)) = self
                                .join_through(&leader_url, options.auto_linked_with.as_deref())?
                        {
                            joined = Some((
                                term,
                                Member {
                                    url: leader_url,
                                    ..leader
                                },
                            ));
                            let mut notes = self.notes.lock().unwrap();
                            notes.rejoined = None;
                            notes.follow_error = None;
                            return Ok(json!({"backupFile": backup, "merged": merging}));
                        }
                    }
                }
                if Instant::now() >= deadline {
                    return Err(
                        "Die laptops kiezen net een hoofdlaptop. Probeer het zo opnieuw."
                            .to_string(),
                    );
                }
                std::thread::sleep(Duration::from_millis(100));
                group = self.group_status(&url, &status);
            }
        })();
        let succeeded = joined.is_some();
        self.finish_joining(joined);
        if succeeded {
            for member in followers {
                let node = self.arc();
                let body = json!({
                    "url": url,
                    "clusterId": status["clusterId"],
                    "autoLinkedWith": options.auto_linked_with,
                    "split": options.split,
                    "follow": if other_cluster { Some(own.cluster_id.clone()) } else { None },
                });
                std::thread::spawn(move || {
                    let _ = node.post(&member.url, "/api/cluster/invite", &body, INVITE_TIMEOUT);
                });
            }
        }
        outcome
    }

    /// Sends this laptop's runners and labels to the other group, which adds them in one write of
    /// its leader (`runners.merge`) and answers once a majority of that group holds them.
    fn merge_into(&self, url: &str) -> Result<()> {
        let data = {
            let db = self.db.lock().unwrap();
            json!({
                "from": self.cfg.name,
                "runners": db.rows("SELECT * FROM runners", &[])?,
                "labels": db.rows("SELECT * FROM labels", &[])?,
                "labelImages": db.rows("SELECT * FROM label_images", &[])?,
                "runnerLabels": db.rows("SELECT * FROM runner_labels", &[])?,
            })
        };
        let answer = self.post(
            url,
            "/api/action/runners.merge",
            &data,
            self.cfg.write_deadline + self.cfg.commit_timeout + Duration::from_secs(1),
        );
        match answer {
            Ok(a) if a.status == 200 => Ok(()),
            Ok(a) => Err(format!(
                "De lopers van deze laptop konden niet mee naar die groep: {}",
                a.body["error"]["message"]
                    .as_str()
                    .unwrap_or("onbekende fout")
            )),
            Err(_) => Err(format!(
                "De lopers van deze laptop konden niet mee naar die groep: {} antwoordt niet",
                short_url(url)
            )),
        }
    }

    /// Asks the leader to take this laptop in, then copies its data. None when that laptop no
    /// longer leads or does not answer, so the join can go to the next leader.
    fn join_through(
        &self,
        leader_url: &str,
        auto: Option<&str>,
    ) -> Result<Option<(i64, Option<String>)>> {
        let mut body = json!(self.self_member());
        if let Some(auto) = auto {
            body["autoLinkedWith"] = json!(auto);
        }
        let Ok(answer) = self.post(
            leader_url,
            "/api/cluster/members",
            &body,
            Duration::from_secs(3),
        ) else {
            return Ok(None);
        };
        if answer.status != 200 {
            if answer.body["code"] == "not_leader" {
                return Ok(None);
            }
            return Err(answer.body["error"]
                .as_str()
                .unwrap_or("Koppelen mislukt.")
                .into());
        }
        match self.copy_from(leader_url, "pre-join") {
            Ok(copied) => Ok(Some(copied)),
            Err(error) => {
                let still = self.fetch_status(leader_url).ok();
                if still.is_some_and(|s| s["role"] == "leader" && s["busy"].is_null()) {
                    Err(error)
                } else {
                    Ok(None)
                }
            }
        }
    }

    /// The status of the group `known` belongs to, from `url` or another laptop of that group.
    fn group_status(&self, url: &str, known: &Value) -> Option<(String, Value)> {
        let mut candidates = vec![url.to_owned()];
        for member in known["members"].as_array().into_iter().flatten() {
            if let Some(other) = member["url"].as_str() {
                if member["hostId"] != self.host_id.as_str() && other != url {
                    candidates.push(other.to_owned());
                }
            }
        }
        candidates.into_iter().find_map(|candidate| {
            let status = self.fetch_status(&candidate).ok()?;
            (status["clusterId"] == known["clusterId"] && status["leader"].is_object())
                .then_some((candidate, status))
        })
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

    // ---------- Maintenance ----------

    fn known_peers(&self) -> Vec<(String, String)> {
        serde_json::from_value::<serde_json::Map<String, Value>>(log::json_setting(
            &self.db.lock().unwrap(),
            "cluster_known_peers_json",
        ))
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(k, v)| Some((k, v.as_str()?.to_owned())))
        .collect()
    }
    /// Laptops that once belonged to the group are remembered, also after going on alone, so two
    /// splits find each other again.
    fn remember_peers(&self) {
        let mut peers = self.known_peers();
        let cluster_id = self.cluster_id();
        let mut add = |host: String, url: String| {
            peers.retain(|(h, _)| h != &host);
            peers.push((host, url));
        };
        for member in self.members() {
            if member.host_id != self.host_id {
                add(member.host_id, member.url);
            }
        }
        for beacon in self.beacons() {
            if beacon["clusterId"] == cluster_id.as_str() {
                if let (Some(h), Some(u)) = (beacon["hostId"].as_str(), beacon["url"].as_str()) {
                    add(h.into(), u.into());
                }
            }
        }
        let start = peers.len().saturating_sub(MAX_KNOWN_PEERS);
        let map: serde_json::Map<String, Value> = peers[start..]
            .iter()
            .map(|(h, u)| (h.clone(), json!(u)))
            .collect();
        let _ = log::set_local(
            &self.db.lock().unwrap(),
            "cluster_known_peers_json",
            &Value::Object(map).to_string(),
        );
    }

    pub(super) fn maintain(&self) {
        self.remember_peers();
        if self.busy().is_some() {
            return;
        }
        if self.is_leader() {
            self.refresh_addresses();
            self.log_reachability();
        }
        if !self.is_leader() && self.status()["state"] != "no-majority" {
            if self.leader_alive() {
                self.notes.lock().unwrap().follow_error = None;
            }
            return;
        }
        let mut urls: Vec<String> = self.known_peers().into_iter().map(|(_, u)| u).collect();
        urls.dedup();
        for url in urls {
            if self.follow_split(&url) {
                return;
            }
        }
        self.notes.lock().unwrap().follow_error = None;
        if self.is_leader() {
            self.auto_link();
        } else if self.timing_waits_alone() {
            let _ = self.continue_alone(None, false);
        }
    }

    /// The leader stores the addresses and names the laptops announce now (a new DHCP lease, a
    /// renamed computer), so they also hold when announcements stop.
    fn refresh_addresses(&self) {
        let stored = log::stored_members(&self.db.lock().unwrap());
        if stored.is_empty() {
            return;
        }
        let me = self.self_member();
        if stored.iter().find(|m| m.host_id == me.host_id) != Some(&me) {
            let _ = self.add_member(&me, None);
        }
        let beacons = self.beacons();
        for member in stored.iter().filter(|m| m.host_id != me.host_id) {
            let Some(beacon) = beacons
                .iter()
                .find(|b| b["hostId"] == member.host_id.as_str())
            else {
                continue;
            };
            let url = beacon["url"]
                .as_str()
                .and_then(normalize_url)
                .unwrap_or_else(|| member.url.clone());
            let name = beacon["name"]
                .as_str()
                .map(str::to_owned)
                .or(member.name.clone());
            if url != member.url || name != member.name {
                let _ = self.add_member(
                    &Member {
                        host_id: member.host_id.clone(),
                        url,
                        name,
                    },
                    None,
                );
            }
        }
    }

    /// Lists in Beheer › Activiteit the laptops this leader stopped hearing from, and the ones
    /// that came back. Only with a majority, when the entry can be saved.
    fn log_reachability(&self) {
        if !self.leader_alive() {
            return;
        }
        let reachable: std::collections::HashMap<String, bool> = {
            let st = self.raft.lock().unwrap();
            self.view(&st)
                .into_iter()
                .map(|v| (v.host_id, v.reachable))
                .collect()
        };
        let listed: Vec<String> = serde_json::from_value(log::json_setting(
            &self.db.lock().unwrap(),
            "cluster_unreachable_json",
        ))
        .unwrap_or_default();
        let group = self.members();
        let mut next = Vec::new();
        let mut changes = Vec::new();
        {
            let mut silent = self.silent_since.lock().unwrap();
            for member in &group {
                let name = if member.host_id == self.host_id {
                    self.cfg.name.clone()
                } else {
                    member
                        .name
                        .clone()
                        .unwrap_or_else(|| short_url(&member.url).to_owned())
                };
                if member.host_id == self.host_id || reachable.get(&member.host_id) == Some(&true) {
                    silent.remove(&member.host_id);
                    if listed.contains(&member.host_id) {
                        changes.push(format!("{name} is weer bereikbaar"));
                    }
                    continue;
                }
                let since = *silent
                    .entry(member.host_id.clone())
                    .or_insert_with(Instant::now);
                if listed.contains(&member.host_id) {
                    next.push(member.host_id.clone());
                } else if since.elapsed() >= self.cfg.unreachable_listed_after {
                    next.push(member.host_id.clone());
                    changes.push(format!("{name} is niet bereikbaar"));
                }
            }
            silent.retain(|id, _| group.iter().any(|m| &m.host_id == id));
        }
        if changes.is_empty() && next.len() == listed.len() {
            return;
        }
        let origin = automatic_origin(&self.cfg.name);
        // A write on its way to the other laptops goes first; the next round lists the change.
        let Ok(_writing) = self.writing.try_lock() else {
            return;
        };
        let _ = log::record(
            &mut self.db.lock().unwrap(),
            "cluster.reachability",
            None,
            |db| {
                log::set_replicated(db, "cluster_unreachable_json", &json!(next))?;
                for summary in &changes {
                    activity(db, "cluster.reachability", summary, &origin)?;
                }
                Ok(Value::Null)
            },
        );
    }

    /// The laptops of this group that linked by themselves, by name.
    pub(super) fn auto_link_notes(&self, statuses: &[Value]) -> Vec<Value> {
        let links = log::json_setting(&self.db.lock().unwrap(), "cluster_auto_links_json");
        links
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|link| {
                let member = statuses.iter().find(|m| m["hostId"] == link["hostId"])?;
                let name = member["name"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| short_url(member["url"].as_str().unwrap_or("")).to_owned());
                Some(json!({"hostId": link["hostId"], "with": link["with"], "at": link["at"], "name": name, "self": member["self"]}))
            })
            .collect()
    }

    /// Joins the laptop at `url` when it leads another split of this group that wins. True when it tried.
    fn follow_split(&self, url: &str) -> bool {
        let Ok(status) = self.fetch_status(url) else {
            return false;
        };
        if status["enabled"] != true
            || status["clusterId"] != self.cluster_id().as_str()
            || status["role"] != "leader"
        {
            return false;
        }
        let split = status["split"]["id"].as_str().unwrap_or("").to_owned();
        if split == self.split()["id"].as_str().unwrap_or("")
            || self.busy().is_some()
            || !self.other_group_wins(&status)
        {
            return false;
        }
        let laps = |node: &Node| -> Vec<String> {
            node.db
                .lock()
                .unwrap()
                .rows("SELECT id FROM laps", &[])
                .unwrap_or_default()
                .into_iter()
                .filter_map(|r| r["id"].as_str().map(str::to_owned))
                .collect()
        };
        let before = laps(self);
        match self.join_group(
            url,
            Options {
                split: Some(split),
                ..Options::default()
            },
        ) {
            Ok(result) => {
                let kept: std::collections::HashSet<String> = laps(self).into_iter().collect();
                let lost = before.iter().filter(|id| !kept.contains(*id)).count();
                let name = status["hostName"]
                    .as_str()
                    .unwrap_or(short_url(url))
                    .to_owned();
                self.notes.lock().unwrap().rejoined =
                    Some(rejoined_message(&name, lost, result["backupFile"].as_str()));
            }
            Err(error) => self.notes.lock().unwrap().follow_error = Some(error),
        }
        true
    }

    /// The Timing laptop goes on alone by itself once it has been without a majority for a while.
    fn timing_waits_alone(&self) -> bool {
        if self
            .timing()
            .is_none_or(|t| t["hostId"] != self.host_id.as_str())
            || self.removed_by(self.electing_grace()).is_some()
        {
            return false;
        }
        let since = self
            .last_contact()
            .unwrap_or(self.started)
            .max(self.started);
        since.elapsed() >= self.cfg.auto_alone_after && self.status()["state"] == "no-majority"
    }

    /// Of two splits that meet again, which one carries on: the one that reaches the Timing
    /// laptop (the one that took it last), then more laps, the later split, more laptops, the
    /// later term and the host id. Both sides work it out alike.
    fn other_group_wins(&self, other: &Value) -> bool {
        let own = self.status();
        let order = |s: &Value| {
            [
                if s["timing"]["reachable"] == true {
                    s["timing"]["gen"].as_i64().unwrap_or(0)
                } else {
                    0
                },
                s["laps"].as_i64().unwrap_or(0),
                s["split"]["rank"].as_i64().unwrap_or(0),
                s["members"].as_array().map_or(0, |m| m.len() as i64),
                s["term"].as_i64().unwrap_or(0),
            ]
        };
        let (ours, theirs) = (order(&own), order(other));
        match ours.iter().zip(&theirs).find(|(a, b)| a != b) {
            Some((a, b)) => b > a,
            None => other["hostId"].as_str().unwrap_or("") > own["hostId"].as_str().unwrap_or(""),
        }
    }

    /// Other groups heard on the network, one entry each.
    pub(super) fn nearby_groups(&self, group: &[Member]) -> Vec<Value> {
        let cluster_id = self.cluster_id();
        let mut groups: Vec<(String, Value)> = Vec::new();
        for beacon in self.beacons() {
            let host = beacon["hostId"].as_str().unwrap_or("");
            let beacon_cluster = beacon["clusterId"].as_str().unwrap_or("").to_owned();
            if group.iter().any(|m| m.host_id == host) || beacon_cluster == cluster_id {
                continue;
            }
            let compatible = beacon["appVersion"] == super::APP_VERSION
                && beacon["schemaVersion"] == super::SCHEMA_VERSION;
            let leader = beacon["leader"] == true;
            match groups.iter_mut().find(|(id, _)| id == &beacon_cluster) {
                Some((_, known)) => {
                    if leader && known["throughLeader"] != true {
                        known["url"] = beacon["url"].clone();
                        known["name"] = beacon["name"].clone();
                        known["throughLeader"] = json!(true);
                    }
                    for key in ["laptops", "runners"] {
                        let field = if key == "laptops" {
                            "groupSize"
                        } else {
                            "runners"
                        };
                        known[key] = json!(
                            known[key]
                                .as_i64()
                                .unwrap_or(0)
                                .max(beacon[field].as_i64().unwrap_or(0))
                        );
                    }
                    for key in ["changed", "raceStarted", "raceRunning"] {
                        known[key] = json!(known[key] == true || beacon[key] == true);
                    }
                    known["compatible"] = json!(known["compatible"] == true && compatible);
                }
                None => groups.push((
                    beacon_cluster.clone(),
                    json!({
                        "url": beacon["url"], "name": beacon["name"], "throughLeader": leader,
                        "laptops": beacon["groupSize"].as_i64().unwrap_or(1),
                        "runners": beacon["runners"].as_i64().unwrap_or(0),
                        "changed": beacon["changed"] == true,
                        "raceStarted": beacon["raceStarted"] == true,
                        "raceRunning": beacon["raceRunning"] == true,
                        "appVersion": beacon["appVersion"], "compatible": compatible,
                    }),
                )),
            }
        }
        if groups.is_empty() {
            return Vec::new();
        }
        let own = self.own_side_quick(group.len());
        let mut out: Vec<Value> = groups
            .into_iter()
            .map(|(id, mut g)| {
                let mut side = Side::of(&g);
                side.cluster_id = id;
                g["link"] = json!(link_direction(&own, &side));
                g.as_object_mut().unwrap().remove("throughLeader");
                g
            })
            .collect();
        out.sort_by(|a, b| {
            b["runners"]
                .as_i64()
                .cmp(&a["runners"].as_i64())
                .then_with(|| a["url"].as_str().cmp(&b["url"].as_str()))
        });
        out
    }
    /// This laptop's side without building a whole status (status() itself calls nearby_groups).
    fn own_side_quick(&self, laptops: usize) -> Side {
        let db = self.db.lock().unwrap();
        let (race_started, race_running, _, runners) = Node::race_progress(&db);
        Side {
            cluster_id: log::setting(&db, "replication_cluster_id").unwrap_or_default(),
            race_started,
            race_running,
            runners,
            changed: log::has_event_changes(&db) || runners > 0 || race_started,
            laptops: laptops as i64,
        }
    }

    /// Which group this laptop links with by itself, and why it waits when it does not.
    fn auto_link_plan(&self, nearby: &[Value]) -> (Option<Value>, Option<String>) {
        if !self.cfg.auto_link {
            return (None, None);
        }
        let own = self.own_side_quick(self.members().len());
        let candidates: Vec<&Value> = nearby
            .iter()
            .filter(|g| {
                g["compatible"] == true
                    && g["link"] == "join"
                    && (own.runners == 0 || runners_merge(&own, &Side::of(g)))
            })
            .collect();
        let with_runners: Vec<&&Value> = candidates
            .iter()
            .filter(|g| g["runners"].as_i64().unwrap_or(0) > 0)
            .collect();
        if with_runners.len() > 1 {
            let names: Vec<String> = with_runners
                .iter()
                .map(|g| {
                    g["name"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| short_url(g["url"].as_str().unwrap_or("")).to_owned())
                })
                .collect();
            return (
                None,
                Some(format!(
                    "Niet vanzelf gekoppeld: {} hebben elk lopers. Druk zelf op Koppelen naast de juiste laptop.",
                    list_names(&names)
                )),
            );
        }
        (
            with_runners
                .first()
                .map(|g| (**g).clone())
                .or(candidates.first().map(|g| (*g).clone())),
            None,
        )
    }
    pub(super) fn auto_link_waiting(&self, nearby: &[Value]) -> Option<String> {
        let (target, waiting) = self.auto_link_plan(nearby);
        if waiting.is_some() {
            return waiting;
        }
        let notes = self.notes.lock().unwrap();
        let (url, rounds, message) = notes.auto_link_failure.as_ref()?;
        (target?["url"].as_str() == Some(url) && *rounds >= AUTO_LINK_FAILED_ROUNDS_SHOWN)
            .then(|| message.clone())
    }
    /// The leader of a group links it with the group the plan picks, the way Koppelen would.
    fn auto_link(&self) {
        let (target, _) = self.auto_link_plan(&self.nearby_groups(&self.members()));
        let Some(target) = target else {
            self.notes.lock().unwrap().auto_link_failure = None;
            return;
        };
        let url = target["url"].as_str().unwrap_or("").to_owned();
        let name = target["name"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| short_url(&url).to_owned());
        let fail = |message: String| {
            let mut notes = self.notes.lock().unwrap();
            let rounds = match &notes.auto_link_failure {
                Some((u, r, _)) if u == &url => r + 1,
                _ => 1,
            };
            notes.auto_link_failure = Some((url.clone(), rounds, message));
        };
        let Ok(status) = self.fetch_status(&url) else {
            fail(format!(
                "Niet vanzelf gekoppeld: {name} is te zien op het netwerk, maar {} antwoordt niet. Staat Apolloon op die laptop toegelaten in de firewall?",
                short_url(&url)
            ));
            return;
        };
        if !status["leader"].is_object()
            || !status["busy"].is_null()
            || !self.is_leader()
            || self.busy().is_some()
        {
            return;
        }
        let with = status["hostName"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| short_url(&url).to_owned());
        let options = Options {
            asked: true,
            auto_linked_with: Some(with),
            ..Options::default()
        };
        match self.join_once(&url, status["clusterId"].as_str().unwrap_or(""), options) {
            Ok(_) => self.notes.lock().unwrap().auto_link_failure = None,
            Err(reason) => fail(format!("Vanzelf koppelen met {name} lukt niet: {reason}")),
        }
    }
}

fn rejoined_message(name: &str, lost: usize, backup: Option<&str>) -> String {
    let backup = backup
        .map(|b| format!("de backup {b}"))
        .unwrap_or_else(|| "een backup".into());
    let joined = format!("Deze laptop werkte even apart en volgt nu weer de groep van {name}.");
    if lost == 0 {
        return format!("{joined} Wat ze apart bewaarde, staat in {backup}.");
    }
    let laps = if lost == 1 {
        "1 ronde die alleen hier geklokt was, zit".to_string()
    } else {
        format!("{lost} rondes die alleen hier geklokt waren, zitten")
    };
    format!(
        "{joined} Let op: {laps} niet in de race. Je vindt ze in {backup}; zet ze er zo nodig bij in Beheer › Rondes."
    )
}

/// `http://host:port` from what an operator typed (`host`, `host:port` or a full URL).
pub fn normalize_url(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let with_scheme = if raw.contains("://") {
        raw.to_owned()
    } else {
        format!("http://{raw}")
    };
    let url = reqwest::Url::parse(&with_scheme).ok()?;
    if url.scheme() != "http" || url.host_str().is_none() {
        return None;
    }
    Some(url.origin().ascii_serialization())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn side(
        id: &str,
        runners: i64,
        changed: bool,
        laptops: i64,
        started: bool,
        running: bool,
    ) -> Side {
        Side {
            cluster_id: id.into(),
            race_started: started,
            race_running: running,
            runners,
            changed,
            laptops,
        }
    }
    #[test]
    fn both_sides_pick_the_same_direction_for_a_simultaneous_press() {
        let cases = [
            (
                side("a", 0, false, 1, false, false),
                side("b", 0, false, 1, false, false),
            ),
            (
                side("a", 3, true, 1, false, false),
                side("b", 0, false, 1, false, false),
            ),
            (
                side("a", 3, true, 1, false, false),
                side("b", 5, true, 2, false, false),
            ),
            (
                side("a", 3, true, 1, true, true),
                side("b", 50, true, 1, true, false),
            ),
            (
                side("a", 0, false, 1, false, false),
                side("b", 9, true, 1, true, true),
            ),
        ];
        for (a, b) in cases {
            let (ab, ba) = (link_direction(&a, &b), link_direction(&b, &a));
            // Exactly one side joins; the other invites or must be pressed there.
            assert!((ab == "join") != (ba == "join"), "{a:?} {b:?}: {ab} / {ba}");
        }
        // A running race is never replaced by a spare laptop with more runners.
        let racing = side("a", 3, true, 1, true, true);
        let spare = side("b", 50, true, 1, false, false);
        assert_eq!(link_direction(&spare, &racing), "join");
        assert_eq!(link_direction(&racing, &spare), "there");
    }
    #[test]
    fn addresses_are_normalized() {
        assert_eq!(
            normalize_url("192.168.1.20:5173").as_deref(),
            Some("http://192.168.1.20:5173")
        );
        assert_eq!(
            normalize_url(" http://10.0.0.2:80/ ").as_deref(),
            Some("http://10.0.0.2")
        );
        assert_eq!(normalize_url(""), None);
    }
}
