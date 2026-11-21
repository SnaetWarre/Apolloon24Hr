//! Linked laptops: majority voting, the replicated log, joining a group, passing writes made on
//! any laptop to the leader, and the status the screens show. Port of server/cluster.ts,
//! consensus.ts, raft.ts, peers.ts, clock.ts and server/db/{replication,forwarded-writes,merge}.ts.
//!
//! Peers talk JSON over plain HTTP (`/api/cluster/*`) instead of the reference's WebSocket; the
//! messages and their meaning are the same, the bytes are not (mixed TS/Rust groups are not a goal).
pub mod clock;
mod join;
pub mod log;
mod probe;
mod raft;
pub mod routes;
#[cfg(test)]
pub(crate) mod tests;

use crate::db::{Db, Result};
use log::Member;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, OnceLock, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

/// The longest role name a laptop can get in Groep maken.
pub const ROLE_MAX: usize = 24;
pub const APP_VERSION: &str = env!("APOLLOON_PEER_VERSION");
pub const SCHEMA_VERSION: i64 = 17;

pub const NO_LEADER_MESSAGE: &str = "Niet opgeslagen: er zijn te weinig laptops bereikbaar. Controleer of de andere laptops aan staan en aan het netwerk hangen.";
pub const REMOVED_MESSAGE: &str = "Niet opgeslagen: deze laptop is uit de groep gehaald. Klik in Beheer › Systeem & herstel op Opnieuw koppelen.";
pub const NOT_CONFIRMED_MESSAGE: &str = "Niet bevestigd: deze wijziging staat nog niet op een tweede laptop. Controleer of de andere laptops aan staan en probeer opnieuw.";
const BUSY_MESSAGE: &str = "Deze laptop wordt al gekoppeld of bijgewerkt. Probeer het zo opnieuw.";
/// Presses on the Timing screen, refused on a laptop while Timing is open on another one.
const TIMING_PRESSES: [&str; 4] = [
    "race.startNext",
    "race.handoff",
    "race.undoLastHandoff",
    "race.finish",
];

#[derive(Clone, Debug)]
pub struct Config {
    pub self_url: String,
    pub name: String,
    pub heartbeat: Duration,
    pub election_timeout: Duration,
    pub commit_timeout: Duration,
    /// How long a write may wait while the laptops choose a new leader.
    pub write_deadline: Duration,
    pub maintenance: Duration,
    /// The Timing laptop without a majority this long goes on alone by itself.
    pub auto_alone_after: Duration,
    /// A laptop silent this long can be taken out of the group.
    pub removable_after: Duration,
    /// A laptop silent this long is listed in Beheer › Activiteit, so a short hiccup stays out of it.
    pub unreachable_listed_after: Duration,
    pub auto_link: bool,
}
fn env_ms(key: &str, default: u64) -> Duration {
    Duration::from_millis(
        std::env::var(key)
            .ok()
            .and_then(|v| v.parse().ok())
            .filter(|v| *v > 0)
            .unwrap_or(default),
    )
}
impl Config {
    /// `CLUSTER_ENABLED=true` turns linking on, as in the reference.
    pub fn from_env(port: u16) -> Option<Self> {
        if std::env::var("CLUSTER_ENABLED").as_deref() != Ok("true") {
            return None;
        }
        Some(Self {
            self_url: std::env::var("CLUSTER_SELF_URL")
                .ok()
                .unwrap_or_else(|| crate::host::info(port)["url"].as_str().unwrap_or("").into()),
            name: crate::host::name(),
            heartbeat: env_ms("CLUSTER_HEARTBEAT_MS", 150),
            election_timeout: env_ms("CLUSTER_ELECTION_TIMEOUT_MS", 1_500),
            commit_timeout: env_ms("CLUSTER_COMMIT_TIMEOUT_MS", 4_000),
            write_deadline: env_ms("CLUSTER_WRITE_DEADLINE_MS", 12_000),
            maintenance: Duration::from_secs(5),
            auto_alone_after: env_ms("CLUSTER_AUTO_ALONE_MS", 15_000),
            removable_after: env_ms("CLUSTER_REMOVABLE_AFTER_MS", 30_000),
            unreachable_listed_after: Duration::from_secs(5),
            auto_link: std::env::var("CLUSTER_AUTO_LINK").as_deref() != Ok("false"),
        })
    }
    /// Short timings for in-process tests.
    #[cfg(test)]
    pub fn test(self_url: String, name: &str) -> Self {
        Self {
            self_url,
            name: name.into(),
            heartbeat: Duration::from_millis(40),
            election_timeout: Duration::from_millis(500),
            commit_timeout: Duration::from_millis(3_000),
            write_deadline: Duration::from_millis(8_000),
            maintenance: Duration::from_millis(300),
            auto_alone_after: Duration::from_secs(3_600),
            removable_after: Duration::from_millis(800),
            unreachable_listed_after: Duration::from_millis(300),
            auto_link: false,
        }
    }
}

/// What Beheer says besides the live state (cluster.ts rejoinedNotice / followError).
#[derive(Default)]
struct Notes {
    rejoined: Option<String>,
    follow_error: Option<String>,
    auto_link_failure: Option<(String, u32, String)>,
}

pub struct Node {
    pub(crate) db: Arc<Mutex<Db>>,
    pub(crate) cfg: Config,
    pub(crate) host_id: String,
    raft: Mutex<raft::State>,
    notes: Mutex<Notes>,
    /// Test hook: a pulled network cable. Requests to and from other laptops fail.
    pub isolated: AtomicBool,
    stopped: AtomicBool,
    started: Instant,
    clock: clock::Samples,
    client: OnceLock<reqwest::blocking::Client>,
    discovery: Mutex<Option<Arc<crate::discovery::Discovery>>>,
    weak: Weak<Node>,
    /// Since when this laptop, leading, has not heard from each other laptop.
    silent_since: Mutex<HashMap<String, Instant>>,
}

/// An answer from another laptop: its HTTP status and JSON body.
pub(crate) struct Answer {
    pub status: u16,
    pub body: Value,
    pub epoch: Option<i64>,
}

impl Node {
    pub fn start(db: Arc<Mutex<Db>>, cfg: Config) -> Result<Arc<Self>> {
        let host_id = {
            let db = db.lock().unwrap();
            let host_id = match log::setting(&db, "host_id") {
                Some(id) => id,
                None => {
                    let id = crate::db::id();
                    log::set_local(&db, "host_id", &id)?;
                    id
                }
            };
            if log::setting(&db, "replication_cluster_id").is_none() {
                log::set_local(&db, "replication_cluster_id", &host_id)?;
            }
            if let Some(offset) =
                log::setting(&db, "cluster_clock_offset_ms").and_then(|v| v.parse().ok())
            {
                clock::set_offset(offset);
            }
            host_id
        };
        // reqwest's blocking client must be built outside an async runtime.
        let client = std::thread::spawn(|| {
            reqwest::blocking::Client::builder()
                .pool_max_idle_per_host(0)
                .connect_timeout(Duration::from_millis(500))
                .build()
        })
        .join()
        .map_err(|_| "HTTP-client kon niet starten".to_string())?
        .map_err(|e| e.to_string())?;
        let node = Arc::new_cyclic(|weak| Self {
            db,
            raft: Mutex::new(raft::State::new(&cfg)),
            cfg,
            host_id,
            notes: Mutex::default(),
            isolated: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            started: Instant::now(),
            clock: clock::Samples::default(),
            client: OnceLock::from(client),
            discovery: Mutex::new(None),
            weak: weak.clone(),
            silent_since: Mutex::default(),
        });
        node.start_raft();
        let weak = Arc::downgrade(&node);
        let every = node.cfg.maintenance;
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(every);
                let Some(node) = weak.upgrade() else { break };
                if node.stopped.load(Ordering::Relaxed) {
                    break;
                }
                node.maintain();
            }
        });
        Ok(node)
    }
    pub fn set_discovery(&self, discovery: Arc<crate::discovery::Discovery>) {
        *self.discovery.lock().unwrap() = Some(discovery);
    }
    /// Stops voting, replicating and answering; a laptop switched off.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Relaxed);
        self.isolated.store(true, Ordering::Relaxed);
    }
    fn arc(&self) -> Arc<Node> {
        self.weak.upgrade().expect("node alive")
    }
    pub(crate) fn offline(&self) -> bool {
        self.isolated.load(Ordering::Relaxed) || self.stopped.load(Ordering::Relaxed)
    }

    // ---------- Peers ----------

    pub(crate) fn request(
        &self,
        method: reqwest::Method,
        url: &str,
        body: Option<&Value>,
        timeout: Duration,
    ) -> Result<Answer> {
        if self.offline() {
            return Err("isolated".into());
        }
        let mut request = self
            .client
            .get()
            .ok_or("geen HTTP-client")?
            .request(method, url)
            .header("x-apolloon-app-version", APP_VERSION)
            .header("x-apolloon-schema-version", SCHEMA_VERSION.to_string())
            .timeout(timeout);
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().map_err(|e| e.to_string())?;
        let status = response.status().as_u16();
        let epoch = response
            .headers()
            .get("x-apolloon-epoch")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok());
        let body = response.json().unwrap_or(Value::Null);
        Ok(Answer {
            status,
            body,
            epoch,
        })
    }
    pub(crate) fn post(
        &self,
        url: &str,
        path: &str,
        body: &Value,
        timeout: Duration,
    ) -> Result<Answer> {
        self.request(
            reqwest::Method::POST,
            &format!("{url}{path}"),
            Some(body),
            timeout,
        )
    }
    pub(crate) fn fetch_status(&self, url: &str) -> Result<Value> {
        let answer = self.request(
            reqwest::Method::GET,
            &format!("{url}/api/cluster/status"),
            None,
            Duration::from_secs(3),
        )?;
        if answer.status != 200 || !answer.body.is_object() {
            return Err(format!("HTTP {}", answer.status));
        }
        Ok(answer.body)
    }

    // ---------- The group ----------

    pub fn self_member(&self) -> Member {
        Member {
            host_id: self.host_id.clone(),
            url: self.cfg.self_url.clone(),
            name: Some(self.cfg.name.clone()),
        }
    }
    pub fn cluster_id(&self) -> String {
        log::setting(&self.db.lock().unwrap(), "replication_cluster_id")
            .unwrap_or_else(|| self.host_id.clone())
    }
    /// The group from the replicated table; a laptop that never joined one is a group of one.
    pub fn members(&self) -> Vec<Member> {
        let mut stored = log::stored_members(&self.db.lock().unwrap());
        let beacons = self.beacons();
        for member in &mut stored {
            if let Some(url) = beacons
                .iter()
                .find(|b| b["hostId"] == member.host_id.as_str())
                .and_then(|b| b["url"].as_str())
            {
                member.url = url.to_owned();
            }
        }
        if stored.iter().any(|m| m.host_id == self.host_id) {
            stored
        } else {
            let mut all = vec![self.self_member()];
            all.extend(stored);
            all
        }
    }
    pub fn split(&self) -> Value {
        let split = log::json_setting(&self.db.lock().unwrap(), "cluster_split_json");
        if split["id"].is_string() {
            split
        } else {
            json!({"id":"","rank":0})
        }
    }
    fn timing(&self) -> Option<Value> {
        let timing = log::json_setting(&self.db.lock().unwrap(), "cluster_timing_json");
        timing["hostId"].is_string().then_some(timing)
    }
    /// The role each laptop got in Groep maken (Timing, Wachtrij, ...), by host id.
    fn roles(&self) -> HashMap<String, String> {
        serde_json::from_value(log::json_setting(
            &self.db.lock().unwrap(),
            "cluster_roles_json",
        ))
        .unwrap_or_default()
    }
    fn removed(&self) -> Vec<String> {
        serde_json::from_value(log::json_setting(
            &self.db.lock().unwrap(),
            "cluster_removed_json",
        ))
        .unwrap_or_default()
    }

    /// What this laptop is doing to its own data, if anything.
    pub fn busy(&self) -> Option<&'static str> {
        let st = self.raft.lock().unwrap();
        if st.joining {
            Some("joining")
        } else if st.copying.is_some() {
            Some("resyncing")
        } else {
            None
        }
    }

    fn electing_grace(&self) -> Duration {
        self.cfg.election_timeout * 5
    }
    fn group_state(&self, writable: bool, statuses: &[Value]) -> &'static str {
        if statuses.len() == 1 {
            return if writable { "solo" } else { "electing" };
        }
        if self.busy().is_some() {
            return "electing";
        }
        if !writable {
            let since = self
                .last_contact()
                .unwrap_or(self.started)
                .max(self.started);
            return if since.elapsed() < self.electing_grace() {
                "electing"
            } else {
                "no-majority"
            };
        }
        if statuses
            .iter()
            .all(|m| m["reachable"] == true && m["caughtUp"] == true)
        {
            "healthy"
        } else {
            "degraded"
        }
    }

    /// Facts about this laptop's race for linking: started (a lap, a start or an active first
    /// lap) and running (started and not finished). Stricter than the reference's ten-lap
    /// threshold: any lap or start counts, so a practice run is never silently merged away.
    fn race_progress(db: &Db) -> (bool, bool, i64, i64) {
        let row = db
            .one("SELECT active_started_at, race_started_at, race_finished_at, (SELECT COUNT(*) FROM laps) AS laps, (SELECT COUNT(*) FROM runners) AS runners FROM race_state WHERE id=1", &[])
            .unwrap_or_default();
        let laps = row["laps"].as_i64().unwrap_or(0);
        let started = !row["race_started_at"].is_null()
            || !row["active_started_at"].is_null()
            || !row["race_finished_at"].is_null()
            || laps > 0;
        (
            started,
            started && row["race_finished_at"].is_null(),
            laps,
            row["runners"].as_i64().unwrap_or(0),
        )
    }

    /// `/api/cluster/status`, and `cluster` in `/api/state`.
    pub fn status(&self) -> Value {
        let busy = self.busy();
        let (role, leader, view, term) = {
            let st = self.raft.lock().unwrap();
            (st.role, st.leader.clone(), self.view(&st), self.term())
        };
        let writable = busy.is_none() && self.leader_alive();
        let group = self.members();
        let names = self.heard_names();
        let roles = self.roles();
        let removable_after = self.cfg.removable_after.as_millis() as u64;
        let statuses: Vec<Value> = group
            .iter()
            .map(|member| {
                let is_self = member.host_id == self.host_id;
                let is_leader = leader.as_ref().is_some_and(|l| l.host_id == member.host_id);
                let seen = view.iter().find(|v| v.host_id == member.host_id);
                let reachable = is_self || if is_leader { writable } else { seen.is_some_and(|s| s.reachable) };
                json!({
                    "hostId": member.host_id,
                    "url": if is_self { self.cfg.self_url.clone() } else { member.url.clone() },
                    "name": if is_self { Some(self.cfg.name.clone()) } else { names.get(&member.host_id).cloned().or(member.name.clone()) },
                    "self": is_self,
                    "role": roles.get(&member.host_id).cloned(),
                    "leader": is_leader && writable,
                    "reachable": reachable,
                    "caughtUp": (is_leader && writable) || seen.is_some_and(|s| s.caught_up) || group.len() == 1,
                    "removable": writable && !is_self && !is_leader && seen.is_some_and(|s| !s.reachable && s.silent_ms >= removable_after),
                })
            })
            .collect();
        let state = self.group_state(writable, &statuses);
        let removed_from = if writable {
            None
        } else {
            self.removed_by(self.electing_grace())
        };
        let timing = self.timing().map(|timing| {
            let member = statuses.iter().find(|m| m["hostId"] == timing["hostId"]);
            json!({
                "hostId": timing["hostId"],
                "name": member.map(|m| m["name"].clone()).filter(|n| !n.is_null()).unwrap_or(timing["name"].clone()),
                "gen": timing["gen"],
                "self": timing["hostId"] == self.host_id.as_str(),
                "reachable": member.is_some_and(|m| m["self"] == true || (writable && m["reachable"] == true)),
            })
        });
        let nearby = self.nearby_groups(&group);
        let waiting = self.auto_link_waiting(&nearby);
        let notes = self.notes.lock().unwrap();
        let last_error = notes
            .follow_error
            .clone()
            .or_else(|| self.raft.lock().unwrap().resync_problem.clone());
        let notice = notes.rejoined.clone();
        drop(notes);
        let db = self.db.lock().unwrap();
        let (race_started, race_running, laps, runners) = Self::race_progress(&db);
        let changed = log::has_event_changes(&db) || runners > 0 || race_started;
        let head = log::head(&db).seq;
        drop(db);
        json!({
            "enabled": true,
            "hostId": self.host_id,
            "hostName": self.cfg.name,
            "clusterId": self.cluster_id(),
            "appVersion": APP_VERSION,
            "schemaVersion": SCHEMA_VERSION,
            "role": role.as_str(),
            "term": term,
            "state": state,
            "leader": if writable { leader.map(|l| json!(l)) } else { None },
            "majority": group.len() / 2 + 1,
            "writable": writable,
            "busy": busy,
            "selfUrl": self.cfg.self_url,
            "logHead": head,
            "runners": runners,
            "changed": changed,
            "raceStarted": race_started,
            "raceRunning": race_running,
            "memberUrls": statuses.iter().filter(|m| m["self"] != true).map(|m| m["url"].clone()).collect::<Vec<_>>(),
            "members": statuses,
            "nearby": nearby,
            "autoLink": {"enabled": self.cfg.auto_link, "waiting": waiting, "linked": self.auto_link_notes(&statuses)},
            "removedFrom": removed_from.map(|m| json!({"url": m.url, "name": m.name})),
            "timing": timing,
            "split": self.split(),
            "laps": laps,
            "lastError": last_error,
            "notice": notice,
            "backup": null,
        })
    }

    /// Computer names heard on the network now, by host id.
    fn heard_names(&self) -> HashMap<String, String> {
        self.beacons()
            .into_iter()
            .filter_map(|b| {
                Some((
                    b["hostId"].as_str()?.to_owned(),
                    b["name"].as_str()?.to_owned(),
                ))
            })
            .collect()
    }
    fn beacons(&self) -> Vec<Value> {
        self.discovery
            .lock()
            .unwrap()
            .as_ref()
            .map(|d| d.nearby())
            .unwrap_or_default()
    }

    // ---------- Writes ----------

    /// Every `/api/action/{method}` on a laptop with linking on.
    pub fn action(&self, method: &str, input: &Value, origin: &str) -> Result<Value> {
        match method {
            "cluster.joinGroup" | "cluster.join" => {
                let url = input["url"].as_str().unwrap_or("").trim().to_owned();
                if input["rejoin"] == true {
                    self.join_group(&url, join::Options::default())
                } else {
                    self.link_with(&url)
                }
            }
            "cluster.continueAlone" => {
                self.continue_alone(Some(origin), input["takeOverTiming"] == true)
            }
            "cluster.openTiming" => {
                if let Some(claim) = self.timing_claim(input["takeOver"] == true) {
                    self.write("cluster.saveTiming", &claim, origin, None)?;
                }
                Ok(json!({"ok":true}))
            }
            // Restore reads the backup on this laptop; the leader keeps a safety copy and replaces the data everywhere.
            "backups.restore" => {
                let path = crate::backups::database_path(&self.db.lock().unwrap())?;
                let file = crate::backups::file(
                    &path,
                    input["fileName"].as_str().ok_or("Backup ontbreekt")?,
                )?;
                let data = crate::recovery::read(&file)?;
                self.write("backups.applyRestore", &data, origin, None)
            }
            "cluster.testGroup" => self.test_group(origin),
            "cluster.removeLaptop" | "cluster.removeMember" => {
                self.group_settled();
                self.write("cluster.removeLaptop", input, origin, None)
            }
            _ => {
                if TIMING_PRESSES.contains(&method) {
                    self.assert_timing_here()?;
                }
                self.write(method, input, origin, None)
            }
        }
    }

    fn no_leader_message(&self) -> &'static str {
        if self.removed_by(self.electing_grace()).is_some() {
            REMOVED_MESSAGE
        } else {
            NO_LEADER_MESSAGE
        }
    }

    /// Where a write goes: here, the leader, or nowhere because no leader turned up in time.
    fn write_target(&self, deadline: Instant) -> Option<Member> {
        loop {
            if self.busy().is_none() && self.leader_alive() {
                let st = self.raft.lock().unwrap();
                if st.role == raft::Role::Leader {
                    return Some(self.self_member());
                }
                if let Some(leader) = st.leader.clone() {
                    return Some(leader);
                }
            }
            if Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// A replicated write, made here or passed to the leader; waits out an election.
    pub fn write(
        &self,
        method: &str,
        input: &Value,
        origin: &str,
        request: Option<String>,
    ) -> Result<Value> {
        let request = request.unwrap_or_else(crate::db::id);
        let deadline = Instant::now() + self.cfg.write_deadline;
        loop {
            let Some(target) = self.write_target(deadline) else {
                return Err(self.no_leader_message().into());
            };
            let outcome = if target.host_id == self.host_id {
                self.commit_local(method, input, origin, &request)
                    .map(|(v, _)| v)
            } else {
                self.forward(&target, method, input, origin, &request)
            };
            match outcome {
                Ok(value) => return Ok(value),
                Err(Failure {
                    message,
                    retry: false,
                }) => return Err(message),
                Err(Failure {
                    message,
                    retry: true,
                }) => {
                    if Instant::now() >= deadline {
                        return Err(message);
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }

    /// The leader runs a write and waits until a majority stored it.
    pub(crate) fn commit_local(
        &self,
        method: &str,
        input: &Value,
        origin: &str,
        request: &str,
    ) -> std::result::Result<(Value, i64), Failure> {
        // Checks that read the group view happen before the database is locked (lock order: raft, then db).
        if method == "cluster.removeLaptop" {
            self.check_removable(input["hostId"].as_str().unwrap_or(""))
                .map_err(Failure::refused)?;
        }
        // A restore or clear first keeps a verified safety copy on the leader of exactly the state it replaces.
        let safety_reason = match method {
            "backups.applyRestore" => Some("pre-restore"),
            "race.clear" => Some("pre-clear"),
            _ => None,
        };
        let mut attempts = 0;
        let (result, seq) = loop {
            attempts += 1;
            let mut safety = None;
            let mut before = None;
            if let Some(reason) = safety_reason {
                let path = {
                    let db = self.db.lock().unwrap();
                    before = log::head(&db).id;
                    crate::backups::database_path(&db).ok()
                };
                if let Some(path) = path {
                    let backup =
                        crate::backups::create_reason(&path, reason).map_err(Failure::refused)?;
                    safety = Some(backup["fileName"].clone());
                }
            }
            let mut db = self.db.lock().unwrap();
            if let Some(result) = log::forwarded_result(&db, request) {
                break (result, log::head(&db).seq);
            }
            if safety_reason.is_some() && log::head(&db).id != before && attempts < 20 {
                continue;
            }
            {
                let result = if method.starts_with("cluster.") {
                    let kind = method.to_owned();
                    log::record(&mut db, &kind, Some(request), |db| {
                        self.apply_cluster(db, method, input, origin)
                    })
                } else {
                    *db.capture.borrow_mut() = Some(log::Capture {
                        statements: Vec::new(),
                        request_id: Some(request.to_owned()),
                    });
                    let result = db.mutation_from(method, input, origin);
                    db.capture.borrow_mut().take();
                    result
                };
                let mut result = result.map_err(Failure::refused)?;
                if safety_reason.is_some() {
                    result["safetyBackup"] = safety.unwrap_or(Value::Null);
                    result["safetyHostUrl"] = json!(self.cfg.self_url);
                    result["safetyHostName"] = json!(self.cfg.name);
                }
                break (result, log::head(&db).seq);
            }
        };
        if !self.wait_for_commit(seq) {
            return Err(Failure {
                message: NOT_CONFIRMED_MESSAGE.into(),
                retry: true,
            });
        }
        Ok((result, seq))
    }

    /// Passes a write to the leader, then waits until this laptop's copy has it.
    fn forward(
        &self,
        leader: &Member,
        method: &str,
        input: &Value,
        origin: &str,
        request: &str,
    ) -> std::result::Result<Value, Failure> {
        let body =
            json!({"method": method, "input": input, "origin": origin, "requestId": request});
        let retry = || Failure {
            message: self.no_leader_message().into(),
            retry: true,
        };
        let answer = self
            .post(
                &leader.url,
                "/api/cluster/write",
                &body,
                self.cfg.commit_timeout + Duration::from_secs(1),
            )
            .map_err(|_| retry())?;
        match (answer.status, answer.body["code"].as_str()) {
            (200, _) => {
                let seq = answer.body["seq"].as_i64().unwrap_or(0);
                let deadline = Instant::now() + Duration::from_secs(2);
                while log::head(&self.db.lock().unwrap()).seq < seq && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Ok(answer.body["result"].clone())
            }
            (_, Some("refused")) => Err(Failure::refused(
                answer.body["error"]
                    .as_str()
                    .unwrap_or("Opslaan mislukt")
                    .to_owned(),
            )),
            (_, Some("unavailable")) => Err(Failure {
                message: answer.body["error"]
                    .as_str()
                    .unwrap_or(NOT_CONFIRMED_MESSAGE)
                    .to_owned(),
                retry: true,
            }),
            _ => Err(retry()),
        }
    }

    /// The `cluster.*` writes the leader runs inside a replicated transaction.
    fn apply_cluster(&self, db: &Db, method: &str, input: &Value, origin: &str) -> Result<Value> {
        match method {
            "cluster.saveTiming" => {
                let host_id = input["hostId"].as_str().ok_or("Laptop ontbreekt")?;
                let event = if input["takeOver"] == true {
                    "take-over"
                } else {
                    "claim"
                };
                change_timing(db, event, host_id, input["name"].as_str())?;
                Ok(log::json_setting(db, "cluster_timing_json"))
            }
            "cluster.removeLaptop" => {
                let host_id = input["hostId"].as_str().ok_or("Laptop ontbreekt")?;
                let member = log::stored_members(db)
                    .into_iter()
                    .find(|m| m.host_id == host_id)
                    .ok_or("Deze laptop hoort al niet meer bij de groep.")?;
                log::remove_member(db, host_id)?;
                change_timing(db, "release", host_id, None)?;
                let mut removed: Vec<String> =
                    serde_json::from_value(log::json_setting(db, "cluster_removed_json"))
                        .unwrap_or_default();
                removed.retain(|r| r != host_id);
                removed.insert(0, host_id.to_owned());
                log::set_replicated(db, "cluster_removed_json", &json!(removed))?;
                let name = member
                    .name
                    .clone()
                    .unwrap_or_else(|| short_url(&member.url).to_owned());
                activity(
                    db,
                    "cluster.removeMember",
                    &format!("{name} uit de groep gehaald"),
                    origin,
                )?;
                Ok(json!({"name": name}))
            }
            "cluster.setRole" => {
                let host_id = input["hostId"].as_str().ok_or("Laptop ontbreekt")?;
                let member = log::stored_members(db)
                    .into_iter()
                    .find(|m| m.host_id == host_id)
                    .ok_or("Deze laptop hoort niet bij de groep.")?;
                let role: String = input["role"]
                    .as_str()
                    .unwrap_or("")
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ");
                if role.chars().count() > ROLE_MAX {
                    return Err(format!("Een rol heeft hoogstens {ROLE_MAX} tekens.").into());
                }
                let mut roles: HashMap<String, String> =
                    serde_json::from_value(log::json_setting(db, "cluster_roles_json"))
                        .unwrap_or_default();
                if role.is_empty() {
                    roles.remove(host_id);
                } else {
                    roles.insert(host_id.to_owned(), role.clone());
                }
                log::set_replicated(db, "cluster_roles_json", &json!(roles))?;
                let name = member
                    .name
                    .clone()
                    .unwrap_or_else(|| short_url(&member.url).to_owned());
                let summary = if role.is_empty() {
                    format!("Rol van {name} gewist")
                } else {
                    format!("{name} is nu {role}")
                };
                activity(db, "cluster.setRole", &summary, origin)?;
                Ok(json!({"hostId": host_id, "name": name, "role": (!role.is_empty()).then_some(role)}))
            }
            "cluster.probe" => probe::apply(db, input),
            _ => Err("Onbekende groepsactie".into()),
        }
    }
}

pub(crate) struct Failure {
    pub message: String,
    pub retry: bool,
}
impl Failure {
    fn refused(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retry: false,
        }
    }
}

pub(crate) fn short_url(url: &str) -> &str {
    url.trim_start_matches("http://")
        .trim_start_matches("https://")
}

/// Lists a change in the group in Beheer › Activiteit, inside the write that makes it.
fn activity(db: &Db, action: &str, summary: &str, origin: &str) -> Result<()> {
    db.exec(
        "INSERT INTO activity_log(id,occurred_at,action,summary,origin) VALUES(?,?,?,?,?)",
        &[
            json!(crate::db::id()),
            json!(crate::db::now()),
            json!(action),
            json!(summary),
            json!(origin),
        ],
    )?;
    Ok(())
}
fn automatic_origin(name: &str) -> String {
    format!("Vanzelf · laptop {name} ({})", crate::host::address())
}

/// The Timing laptop after an event (cluster.ts nextTiming): claim, take-over or release. Claims
/// and take-overs raise `gen`, so of two splits that meet again the one that took Timing last wins.
fn change_timing(db: &Db, event: &str, host_id: &str, name: Option<&str>) -> Result<()> {
    let current = log::json_setting(db, "cluster_timing_json");
    if let Some(next) = next_timing(&current, event, host_id, name) {
        log::set_replicated(db, "cluster_timing_json", &next)?;
    }
    Ok(())
}
fn next_timing(current: &Value, event: &str, host_id: &str, name: Option<&str>) -> Option<Value> {
    let generation = current["gen"].as_i64().unwrap_or(0);
    let holder = current["hostId"].as_str();
    if event == "release" {
        return (holder == Some(host_id))
            .then(|| json!({"hostId":null,"name":null,"gen":generation}));
    }
    if holder == Some(host_id) || (holder.is_some() && event == "claim") {
        return None;
    }
    Some(json!({"hostId":host_id,"name":name,"gen":generation + 1}))
}

impl Node {
    /// What opening Timing here saves: nothing when it is open here already, or elsewhere and not taken over.
    fn timing_claim(&self, take_over: bool) -> Option<Value> {
        let current = log::json_setting(&self.db.lock().unwrap(), "cluster_timing_json");
        let event = if take_over { "take-over" } else { "claim" };
        next_timing(&current, event, &self.host_id, Some(&self.cfg.name))?;
        if current["hostId"].is_null() && !self.leader_alive() {
            return None;
        }
        Some(json!({"hostId": self.host_id, "name": self.cfg.name, "takeOver": take_over}))
    }
    fn timing_name(&self, timing: &Value) -> String {
        timing["hostId"]
            .as_str()
            .and_then(|id| self.heard_names().get(id).cloned())
            .or_else(|| timing["name"].as_str().map(str::to_owned))
            .unwrap_or_else(|| "de Timing-laptop".into())
    }
    /// Clocking here while Timing is open on another laptop is refused.
    fn assert_timing_here(&self) -> Result<()> {
        match self.timing() {
            Some(timing) if timing["hostId"] != self.host_id.as_str() => Err(format!(
                "Timing staat open op {}. Neem Timing over om hier te klokken.",
                self.timing_name(&timing)
            )),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod timing_tests {
    use serde_json::json;
    #[test]
    fn timing_is_claimed_once_taken_over_with_a_new_generation_and_released_by_its_holder() {
        let none = json!(null);
        let a = super::next_timing(&none, "claim", "a", Some("A")).unwrap();
        assert_eq!(a["gen"], 1);
        assert!(super::next_timing(&a, "claim", "b", None).is_none());
        let b = super::next_timing(&a, "take-over", "b", Some("B")).unwrap();
        assert_eq!(
            (b["hostId"].as_str(), b["gen"].as_i64()),
            (Some("b"), Some(2))
        );
        assert!(super::next_timing(&b, "release", "a", None).is_none());
        let released = super::next_timing(&b, "release", "b", None).unwrap();
        assert!(released["hostId"].is_null());
        assert_eq!(
            super::next_timing(&released, "claim", "c", None).unwrap()["gen"],
            3
        );
    }
}
