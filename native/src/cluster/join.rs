//! Joining a group, and the linking decision both sides work out alike (port of the joining
//! half of server/cluster.ts and shared/linking.ts).
use super::{BUSY_MESSAGE, Node, log::Member, short_url};
use crate::db::Result;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

const INVITE_TIMEOUT: Duration = Duration::from_secs(30);

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
    pub(super) fn of(status: &Value) -> Self {
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
pub(super) fn list_names(names: &[String]) -> String {
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
    pub fn accept_invite(&self, request: &Value, signed: bool) -> Result<bool> {
        // Only a laptop of this group may tell this one to follow it. Once the race started here,
        // nobody else moves this laptop either: joining another group is a press on this laptop.
        if !signed
            && (request["split"].is_string()
                || request["follow"].is_string()
                || self.own_side().race_started)
        {
            return Err("Deze laptops horen bij een andere groep.".into());
        }
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
    pub(super) fn join_once(&self, url: &str, cluster_id: &str, options: Options) -> Result<Value> {
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
        if let Some(key) = answer.body["groupKey"].as_str() {
            self.adopt_group_key(key);
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
