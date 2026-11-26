//! The maintenance round: remembering laptops, addresses and reachability, rejoining splits,
//! and linking compatible groups that hear each other on the network.
use super::{
    Node, activity, automatic_origin,
    join::{Options, Side, link_direction, list_names, normalize_url, runners_merge},
    log, log::Member, short_url,
};
use serde_json::{Value, json};
use std::time::Instant;

const MAX_KNOWN_PEERS: usize = 16;
const AUTO_LINK_FAILED_ROUNDS_SHOWN: u32 = 3;

impl Node {
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
        for beacon in self.group_beacons() {
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
        let beacons = self.group_beacons();
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
    pub(super) fn follow_split(&self, url: &str) -> bool {
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
