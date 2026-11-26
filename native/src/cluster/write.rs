use super::{
    NO_LEADER_MESSAGE, NOT_CONFIRMED_MESSAGE, Node, REMOVED_MESSAGE, TIMING_PRESSES, activity,
    change_timing, join, log, log::Member, probe, raft, short_url,
};
use crate::db::{Db, Result};
use serde_json::{Value, json};
use std::{
    sync::mpsc,
    time::{Duration, Instant},
};

impl Node {
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
        let started = Instant::now();
        let deadline = started + self.cfg.write_deadline;
        // A press on the Timing laptop is never given up: once an election had time to end
        // and no majority answers, the laptop goes on alone and stores the press.
        let mut alone_at = (TIMING_PRESSES.contains(&method) && self.times_here())
            .then(|| started + self.cfg.election_timeout);
        loop {
            let target = self.write_target(alone_at.map_or(deadline, |at| at.min(deadline)));
            let message = match target {
                Some(target) => {
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
                        Err(Failure { message, .. }) => message,
                    }
                }
                None => self.no_leader_message().to_owned(),
            };
            if alone_at.is_some_and(|at| Instant::now() >= at) {
                if self.press_goes_alone() {
                    alone_at = None;
                    continue;
                }
                alone_at = Some(Instant::now() + self.cfg.election_timeout);
            }
            if Instant::now() >= deadline {
                return Err(message);
            }
            std::thread::sleep(Duration::from_millis(50));
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
        // A press on the Timing laptop is always stored here as well: that laptop goes on alone
        // when it is cut off, and a lap clocked in the seconds before must still be there.
        let keep = TIMING_PRESSES.contains(&method)
            && self
                .timing()
                .is_some_and(|t| t["hostId"] == self.host_id.as_str());
        let _writing = self.writing.lock().unwrap();
        let mut attempts = 0;
        let (result, prepared, seq) = loop {
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
                break (result, None, log::head(&db).seq);
            }
            if safety_reason.is_some() && log::head(&db).id != before && attempts < 20 {
                continue;
            }
            // The write runs and is taken back: it reaches this laptop's data, and its screens,
            // only once a majority holds it, or (a kept press) while it goes round.
            let (mut result, mut prepared) = self
                .run_write(&mut db, method, input, origin, request, false)
                .map_err(Failure::refused)?;
            // A write too large for one message reaches a follower only inside a full copy of
            // the leader's data, so the leader has to store it first.
            if prepared.as_ref().is_some_and(|p| !p.fits_one_message()) {
                (result, prepared) = self
                    .run_write(&mut db, method, input, origin, request, true)
                    .map_err(Failure::refused)?;
            }
            if safety_reason.is_some() {
                result["safetyBackup"] = safety.unwrap_or(Value::Null);
                result["safetyHostUrl"] = json!(self.self_url());
                result["safetyHostName"] = json!(self.cfg.name);
            }
            break (result, prepared, log::head(&db).seq);
        };
        let (confirmed, seq) = match prepared {
            Some(prepared) if keep => {
                let seq = prepared.entry.seq;
                let trace = (method == "race.handoff")
                    .then(|| (input.clone(), result["lapId"].as_str().map(str::to_owned)));
                let stored = move || {
                    if let Some((input, lap)) = trace {
                        crate::latency::handoff("local_commit", &input, lap.as_deref());
                    }
                };
                (self.confirm_kept(prepared, stored), seq)
            }
            Some(prepared) => {
                let seq = prepared.entry.seq;
                (self.confirm(prepared), seq)
            }
            None => (self.wait_for_commit(seq), seq),
        };
        if !confirmed {
            return Err(Failure {
                message: NOT_CONFIRMED_MESSAGE.into(),
                retry: true,
            });
        }
        Ok((result, seq))
    }

    fn run_write(
        &self,
        db: &mut Db,
        method: &str,
        input: &Value,
        origin: &str,
        request: &str,
        keep: bool,
    ) -> Result<(Value, Option<log::Prepared>)> {
        if method.starts_with("cluster.") {
            return log::record_or_prepare(db, method, Some(request), keep, |db| {
                self.apply_cluster(db, method, input, origin)
            });
        }
        *db.capture.borrow_mut() = Some(log::Capture {
            statements: Vec::new(),
            request_id: Some(request.to_owned()),
        });
        let result = db.mutation_run(method, input, origin, keep);
        db.capture.borrow_mut().take();
        result
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
        let (send, receive) = mpsc::channel();
        let node = self.arc();
        let url = leader.url.clone();
        std::thread::spawn(move || {
            let answer = node.post(
                &url,
                "/api/cluster/write",
                &body,
                node.cfg.commit_timeout + Duration::from_secs(1),
            );
            let _ = send.send(answer);
        });
        let answer = loop {
            match receive.recv_timeout(Duration::from_millis(50)) {
                Ok(answer) => break answer.map_err(|_| retry())?,
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err(retry()),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    let leader_changed = self
                        .raft
                        .lock()
                        .unwrap()
                        .leader
                        .as_ref()
                        .is_some_and(|current| current.host_id != leader.host_id);
                    if leader_changed {
                        return Err(retry());
                    }
                }
            }
        };
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
