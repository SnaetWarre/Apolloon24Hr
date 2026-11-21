//! Majority voting among the laptops (port of server/raft.ts and consensus.ts).
//!
//! - One leader per term orders every write and sends it to the others.
//! - A write counts once a majority stored it, so losing any one laptop never loses an
//!   acknowledged change.
//! - When the leader goes quiet, the others vote; only a laptop with the most complete log can
//!   win. A pre-vote first checks that an election could succeed, so a laptop that was merely cut
//!   off cannot disrupt a working group when it returns.
//! - A leader that cannot reach a majority stops accepting writes.
use super::{Config, Node, log, log::Member};
use crate::db::Result;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{atomic::Ordering, mpsc},
    time::{Duration, Instant},
};

const CLOCK_SYNC: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    Leader,
    Follower,
    Candidate,
}
impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Leader => "leader",
            Role::Follower => "follower",
            Role::Candidate => "candidate",
        }
    }
}

/// What a leader tells its followers about the group, so every laptop can show it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub host_id: String,
    pub reachable: bool,
    pub caught_up: bool,
    pub silent_ms: u64,
}

struct Progress {
    member: Member,
    match_seq: Option<i64>,
    last_ack: Option<Instant>,
    since: Instant,
    in_flight: bool,
    needs_resync: bool,
}

pub struct State {
    pub role: Role,
    pub leader: Option<Member>,
    last_contact: Option<Instant>,
    deadline: Instant,
    electing: bool,
    last_quorum: Instant,
    committed: i64,
    last_clock_sync: Option<Instant>,
    /// The leader address a full copy is being taken from.
    pub copying: Option<String>,
    pub joining: bool,
    pub resync_problem: Option<String>,
    group_view: Vec<View>,
    progress: HashMap<String, Progress>,
    removed_answer: Option<(Member, Instant)>,
    election_timeout: Duration,
}
impl State {
    pub fn new(cfg: &Config) -> Self {
        Self {
            role: Role::Follower,
            leader: None,
            last_contact: None,
            deadline: Instant::now() + cfg.election_timeout,
            electing: false,
            last_quorum: Instant::now(),
            committed: 0,
            last_clock_sync: None,
            copying: None,
            joining: false,
            resync_problem: None,
            group_view: Vec::new(),
            progress: HashMap::new(),
            removed_answer: None,
            election_timeout: cfg.election_timeout,
        }
    }
    fn reset_deadline(&mut self) {
        let jitter = rand_unit();
        self.deadline = Instant::now() + self.election_timeout.mul_f64(1.0 + jitter);
    }
    fn alive(&self) -> bool {
        self.role == Role::Leader
            || (self.leader.is_some()
                && self
                    .last_contact
                    .is_some_and(|at| at.elapsed() < self.election_timeout))
    }
}

fn rand_unit() -> f64 {
    (uuid::Uuid::new_v4().as_u128() % 1_000_000) as f64 / 1_000_000.0
}

impl Node {
    pub(super) fn start_raft(&self) {
        {
            let mut st = self.raft.lock().unwrap();
            st.reset_deadline();
            if self.members().len() == 1 {
                self.change_role(&mut st, Role::Leader, None);
            }
        }
        let weak = self.weak.clone();
        let every = self.cfg.heartbeat;
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(every);
                let Some(node) = weak.upgrade() else { break };
                if node.stopped.load(Ordering::Relaxed) {
                    break;
                }
                node.tick();
            }
        });
    }

    pub fn term(&self) -> i64 {
        log::term(&self.db.lock().unwrap())
    }
    fn set_term(&self, term: i64) {
        if term != self.term() {
            let _ = log::set_local(&self.db.lock().unwrap(), "cluster_epoch", &term.to_string());
        }
    }
    fn voted_for(&self, term: i64) -> Option<String> {
        let raw = log::setting(&self.db.lock().unwrap(), "cluster_voted_for")?;
        let (voted_term, host) = raw.split_once(':')?;
        (voted_term.parse::<i64>().ok() == Some(term) && !host.is_empty()).then(|| host.to_owned())
    }
    fn record_vote(&self, term: i64, host_id: &str) {
        let _ = log::set_local(
            &self.db.lock().unwrap(),
            "cluster_voted_for",
            &format!("{term}:{host_id}"),
        );
    }
    fn others(&self) -> Vec<Member> {
        self.members()
            .into_iter()
            .filter(|m| m.host_id != self.host_id)
            .collect()
    }
    pub fn majority(&self) -> usize {
        self.members().len() / 2 + 1
    }
    pub fn is_leader(&self) -> bool {
        self.raft.lock().unwrap().role == Role::Leader
    }
    /// True while a leader is known and was heard from within an election timeout.
    pub fn leader_alive(&self) -> bool {
        self.raft.lock().unwrap().alive()
    }
    pub fn last_contact(&self) -> Option<Instant> {
        self.raft.lock().unwrap().last_contact
    }
    /// The laptop that last said this one was taken out of the group, within `within`.
    pub fn removed_by(&self, within: Duration) -> Option<Member> {
        self.raft
            .lock()
            .unwrap()
            .removed_answer
            .as_ref()
            .filter(|(_, at)| at.elapsed() < within)
            .map(|(m, _)| m.clone())
    }
    /// The leader's view of the others, or what the leader last told this follower.
    pub(super) fn view(&self, st: &State) -> Vec<View> {
        if st.role != Role::Leader {
            return st.group_view.clone();
        }
        let head = log::head(&self.db.lock().unwrap()).seq;
        self.others()
            .into_iter()
            .map(|member| {
                let progress = st.progress.get(&member.host_id);
                let reachable = progress
                    .and_then(|p| p.last_ack)
                    .is_some_and(|at| at.elapsed() < self.cfg.election_timeout);
                let silent_ms = match progress {
                    Some(p) if !reachable => {
                        p.last_ack.unwrap_or(p.since).elapsed().as_millis() as u64
                    }
                    _ => 0,
                };
                View {
                    host_id: member.host_id,
                    reachable,
                    caught_up: reachable
                        && progress.and_then(|p| p.match_seq).unwrap_or(-1) >= head,
                    silent_ms,
                }
            })
            .collect()
    }

    fn change_role(&self, st: &mut State, next: Role, leader: Option<Member>) -> bool {
        if next != Role::Follower && (st.joining || st.copying.is_some()) {
            return false;
        }
        let allowed = match st.role {
            Role::Follower => true,
            Role::Candidate => next != Role::Candidate,
            Role::Leader => next == Role::Follower,
        };
        if !allowed {
            return false;
        }
        let was = st.role;
        st.role = next;
        if next == Role::Leader {
            st.leader = Some(self.self_member());
            st.last_contact = Some(Instant::now());
            st.last_quorum = Instant::now();
            st.committed = 0;
            st.resync_problem = None;
            st.progress.clear();
            st.group_view.clear();
            self.set_discovery_leader(true);
            self.replicate_to_all(st);
            return true;
        }
        self.set_discovery_leader(false);
        if next == Role::Follower && leader.is_some() {
            if st.leader.as_ref().map(|l| &l.host_id) != leader.as_ref().map(|l| &l.host_id) {
                self.clock.reset();
            }
            st.leader = leader;
            st.last_contact = Some(Instant::now());
        } else {
            st.leader = None;
        }
        if next == Role::Follower {
            st.reset_deadline();
        }
        if was == Role::Leader {
            st.progress.clear();
        }
        true
    }
    fn set_discovery_leader(&self, leader: bool) {
        if let Ok(discovery) = self.discovery.try_lock() {
            if let Some(discovery) = discovery.as_ref() {
                discovery.leader.store(leader, Ordering::Relaxed);
            }
        }
    }
    fn become_follower(&self, st: &mut State, term: i64, leader: Option<Member>) {
        self.set_term(term);
        self.change_role(st, Role::Follower, leader);
    }

    fn tick(&self) {
        let members = self.members().len();
        let mut st = self.raft.lock().unwrap();
        if st.joining {
            return;
        }
        if st.role == Role::Leader {
            if members == 1 {
                st.last_quorum = Instant::now();
                return;
            }
            self.replicate_to_all(&mut st);
            let reachable = 1 + self.view(&st).iter().filter(|v| v.reachable).count();
            if reachable >= members / 2 + 1 {
                st.last_quorum = Instant::now();
                st.last_contact = Some(Instant::now());
            } else if st.last_quorum.elapsed() > self.cfg.election_timeout {
                let term = self.term();
                self.become_follower(&mut st, term, None);
            }
            return;
        }
        if members == 1 {
            self.change_role(&mut st, Role::Leader, None);
            return;
        }
        if let Some(leader) = st.leader.clone().filter(|_| st.alive()) {
            if st
                .last_clock_sync
                .is_none_or(|at| at.elapsed() > CLOCK_SYNC)
            {
                st.last_clock_sync = Some(Instant::now());
                let node = self.arc();
                std::thread::spawn(move || node.sync_clock(&leader));
            }
        }
        if Instant::now() >= st.deadline && !st.electing && !st.joining && st.copying.is_none() {
            st.electing = true;
            let node = self.arc();
            std::thread::spawn(move || node.run_election());
        }
    }

    fn sync_clock(&self, leader: &Member) {
        let raw = || crate::db::now() - super::clock::offset();
        let sent = raw();
        let Ok(answer) = self.request(
            reqwest::Method::GET,
            &format!("{}/api/time", leader.url),
            None,
            Duration::from_secs(1),
        ) else {
            return;
        };
        let received = raw();
        let Some(reference) = answer.body["serverNowMs"].as_i64() else {
            return;
        };
        if let Some(offset) = self
            .clock
            .observe(super::clock::offset(), reference, sent, received)
        {
            super::clock::set_offset(offset);
            let _ = log::set_local(
                &self.db.lock().unwrap(),
                "cluster_clock_offset_ms",
                &offset.to_string(),
            );
        }
    }

    fn vote_request(&self, pre_vote: bool, term: i64) -> Value {
        let head = log::head(&self.db.lock().unwrap());
        json!({
            "clusterId": self.cluster_id(),
            "preVote": pre_vote,
            "term": term,
            "candidateId": self.host_id,
            "candidateUrl": self.self_url(),
            "lastSeq": head.seq,
            "lastTerm": head.epoch,
            "split": self.split()["id"],
        })
    }

    fn run_election(&self) {
        let pre = self.ask_for_votes(&self.vote_request(true, self.term() + 1));
        let mut st = self.raft.lock().unwrap();
        let proceed = st.role == Role::Follower
            && !st.alive()
            && pre + 1 >= self.majority()
            && !st.joining
            && st.copying.is_none();
        if !proceed {
            st.electing = false;
            if st.role != Role::Leader {
                st.reset_deadline();
            }
            return;
        }
        let term = self.term() + 1;
        self.set_term(term);
        self.record_vote(term, &self.host_id);
        self.change_role(&mut st, Role::Candidate, None);
        drop(st);
        let votes = self.ask_for_votes(&self.vote_request(false, term));
        let mut st = self.raft.lock().unwrap();
        let candidate = st.role == Role::Candidate && self.term() == term;
        let won = candidate
            && votes + 1 >= self.majority()
            && self.change_role(&mut st, Role::Leader, None);
        if !won && st.role == Role::Candidate && self.term() == term {
            self.change_role(&mut st, Role::Follower, None);
        }
        st.electing = false;
        if st.role != Role::Leader {
            st.reset_deadline();
        }
    }

    fn ask_for_votes(&self, request: &Value) -> usize {
        let peers = self.others();
        let quorum = (peers.len() + 1) / 2 + 1;
        let (send, answers) = mpsc::channel();
        let body = json!({"type":"vote","body":request});
        for member in peers {
            let (node, send, body) = (self.arc(), send.clone(), body.clone());
            std::thread::spawn(move || {
                let answer = node
                    .post(
                        &member.url,
                        "/api/cluster/peer",
                        &body,
                        node.cfg.election_timeout,
                    )
                    .ok()
                    .filter(|a| a.status == 200)
                    .map(|a| a.body);
                let _ = send.send((member, answer));
            });
        }
        drop(send);
        let mut granted = 0;
        let mut someone_leads = false;
        for (member, answer) in answers {
            let Some(answer) = answer else { continue };
            let mut st = self.raft.lock().unwrap();
            let term = answer["term"].as_i64().unwrap_or(0);
            if answer["removed"] == true {
                st.removed_answer = Some((member, Instant::now()));
                continue;
            }
            let leader: Option<Member> = serde_json::from_value(answer["leader"].clone()).ok();
            if leader.as_ref().is_some_and(|l| l.host_id != self.host_id) && term >= self.term() {
                self.become_follower(&mut st, term, None);
                someone_leads = true;
            } else if term > self.term() {
                self.become_follower(&mut st, term, None);
            } else if answer["granted"] == true {
                granted += 1;
                if !someone_leads && granted + 1 >= quorum {
                    return granted;
                }
            }
        }
        if someone_leads { 0 } else { granted }
    }

    /// Answers another laptop's (pre-)vote request.
    pub(super) fn handle_vote(&self, request: &Value) -> Value {
        let mut st = self.raft.lock().unwrap();
        let term = self.term();
        let refuse = |term: i64| json!({"term": term, "granted": false});
        if st.joining || request["clusterId"].as_str() != Some(&self.cluster_id()) {
            return refuse(term);
        }
        if st.alive() {
            if let Some(leader) = &st.leader {
                return json!({"term": term, "granted": false, "leader": leader});
            }
        }
        let candidate = request["candidateId"].as_str().unwrap_or("");
        if !self.members().iter().any(|m| m.host_id == candidate) {
            return refuse(term);
        }
        let head = log::head(&self.db.lock().unwrap());
        let last_term = request["lastTerm"].as_i64().unwrap_or(0);
        let last_seq = request["lastSeq"].as_i64().unwrap_or(0);
        let up_to_date =
            last_term > head.epoch || (last_term == head.epoch && last_seq >= head.seq);
        let asked = request["term"].as_i64().unwrap_or(0);
        if request["preVote"] == true {
            return json!({"term": term, "granted": up_to_date && asked > term});
        }
        if asked < term {
            return refuse(term);
        }
        if asked > term {
            self.become_follower(&mut st, asked, None);
        }
        let previous = self.voted_for(asked);
        if !up_to_date || previous.is_some_and(|p| p != candidate) {
            return refuse(self.term());
        }
        self.record_vote(asked, candidate);
        st.reset_deadline();
        json!({"term": self.term(), "granted": true})
    }

    // Leader side: send each follower what it is missing, and learn how far it got.

    fn replicate_to_all(&self, st: &mut State) {
        let others = self.others();
        st.progress
            .retain(|id, _| others.iter().any(|m| &m.host_id == id));
        for member in others {
            let progress = st
                .progress
                .entry(member.host_id.clone())
                .or_insert_with(|| Progress {
                    member: member.clone(),
                    match_seq: None,
                    last_ack: None,
                    since: Instant::now(),
                    in_flight: false,
                    needs_resync: false,
                });
            progress.member = member.clone();
            if progress.in_flight || st.role != Role::Leader {
                continue;
            }
            progress.in_flight = true;
            let node = self.arc();
            let term = self.term();
            std::thread::spawn(move || {
                node.replicate_to(&member.host_id, term);
                if let Some(p) = node.raft.lock().unwrap().progress.get_mut(&member.host_id) {
                    p.in_flight = false;
                }
            });
        }
    }

    fn replicate_to(&self, host_id: &str, term: i64) {
        for _ in 0..20 {
            let (url, request) = {
                let st = self.raft.lock().unwrap();
                if st.role != Role::Leader || self.term() != term {
                    return;
                }
                let Some(p) = st.progress.get(host_id) else {
                    return;
                };
                let db = self.db.lock().unwrap();
                let head = log::head(&db).seq;
                let prev_seq = p.match_seq.unwrap_or(head);
                let prev_id = if prev_seq == 0 {
                    None
                } else {
                    log::entry_id(&db, prev_seq)
                };
                let entries = if p.match_seq.is_none() || p.needs_resync {
                    Some(Vec::new())
                } else {
                    log::entries_after(&db, prev_seq)
                };
                let resync =
                    p.needs_resync || (prev_seq > 0 && prev_id.is_none()) || entries.is_none();
                let split = log::json_setting(&db, "cluster_split_json")["id"].clone();
                let cluster_id = log::setting(&db, "replication_cluster_id").unwrap_or_default();
                drop(db);
                let url = p.member.url.clone();
                // A laptop last seen at the address this one has now is not reached by it.
                if url == self.self_url() {
                    return;
                }
                let request = json!({
                    "clusterId": cluster_id,
                    "term": term,
                    "leaderId": self.host_id,
                    "leaderUrl": self.self_url(),
                    "prevSeq": prev_seq,
                    "prevId": prev_id,
                    "entries": entries.unwrap_or_default(),
                    "resync": resync,
                    "group": self.view(&st),
                    "split": if split.is_string() { split } else { json!("") },
                });
                (url, request)
            };
            let answer = self.post(
                &url,
                "/api/cluster/peer",
                &json!({"type":"append","body":request}),
                self.cfg.election_timeout.max(Duration::from_secs(2)),
            );
            let mut st = self.raft.lock().unwrap();
            let answer = match answer {
                Ok(a) if a.status == 200 => a.body,
                Ok(_) => return,
                Err(_) => {
                    if let Some(p) = st.progress.get_mut(host_id) {
                        p.match_seq = None;
                    }
                    return;
                }
            };
            let their_term = answer["term"].as_i64().unwrap_or(0);
            if their_term > self.term() {
                self.become_follower(&mut st, their_term, None);
                return;
            }
            let head_seq = answer["head"]["seq"].as_i64().unwrap_or(0);
            let head_id = answer["head"]["id"].as_str().map(str::to_owned);
            let Some(p) = st.progress.get_mut(host_id) else {
                return;
            };
            p.last_ack = Some(Instant::now());
            if answer["ok"] == true {
                p.match_seq = Some(head_seq);
                p.needs_resync = false;
                self.advance_commit(&mut st);
                if head_seq >= log::head(&self.db.lock().unwrap()).seq {
                    return;
                }
                continue;
            }
            let reason = answer["reason"].as_str().unwrap_or("");
            if reason == "behind"
                && log::can_continue_from(&self.db.lock().unwrap(), head_seq, head_id.as_deref())
            {
                p.match_seq = Some(head_seq);
                continue;
            }
            p.match_seq = None;
            p.needs_resync = reason == "behind" || reason == "diverged";
            return;
        }
    }

    fn advance_commit(&self, st: &mut State) {
        let mut matched = vec![log::head(&self.db.lock().unwrap()).seq];
        for member in self.others() {
            matched.push(
                st.progress
                    .get(&member.host_id)
                    .and_then(|p| p.match_seq)
                    .unwrap_or(0),
            );
        }
        matched.sort_unstable_by(|a, b| b.cmp(a));
        let committed = matched.get(self.majority() - 1).copied().unwrap_or(0);
        st.committed = st.committed.max(committed);
    }

    /// True once a majority stored entry `seq`; false when that fails in time or leadership is lost.
    pub fn wait_for_commit(&self, seq: i64) -> bool {
        if self.members().len() == 1 {
            return true;
        }
        let deadline = Instant::now() + self.cfg.commit_timeout;
        {
            let mut st = self.raft.lock().unwrap();
            if st.role != Role::Leader {
                return false;
            }
            self.replicate_to_all(&mut st);
            self.advance_commit(&mut st);
        }
        loop {
            {
                let st = self.raft.lock().unwrap();
                if st.role != Role::Leader {
                    return false;
                }
                if st.committed >= seq {
                    return true;
                }
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(5));
            let mut st = self.raft.lock().unwrap();
            self.replicate_to_all(&mut st);
        }
    }
    /// True while this laptop leads and a majority holds its whole log.
    pub fn log_settled(&self) -> bool {
        let st = self.raft.lock().unwrap();
        st.role == Role::Leader
            && (self.members().len() == 1
                || st.committed >= log::head(&self.db.lock().unwrap()).seq)
    }
    pub fn group_settled(&self) -> bool {
        let deadline = Instant::now() + Duration::from_secs(3);
        while !self.log_settled() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        self.log_settled()
    }

    // Follower side.

    /// Stores a leader's append; answers with this log's head so the leader knows what to send next.
    pub(super) fn handle_append(&self, request: &Value, remote: Option<std::net::IpAddr>) -> Value {
        let leader_id = request["leaderId"].as_str().unwrap_or("");
        let leader_url = self.leader_address(
            leader_id,
            request["leaderUrl"].as_str().unwrap_or(""),
            remote,
        );
        let mut st = self.raft.lock().unwrap();
        let head = |node: &Node| {
            let h = log::head(&node.db.lock().unwrap());
            json!({"seq": h.seq, "id": h.id})
        };
        let term = self.term();
        let answer = |term: i64, ok: bool, reason: Option<&str>, head: Value| json!({"term": term, "ok": ok, "reason": reason, "head": head});
        if st.joining {
            return answer(term, false, Some("joining"), head(self));
        }
        if leader_id == self.host_id {
            return answer(term, false, Some("self"), head(self));
        }
        let their_term = request["term"].as_i64().unwrap_or(0);
        if their_term < term {
            return answer(term, false, Some("stale-term"), head(self));
        }
        let leader = Member {
            host_id: leader_id.to_owned(),
            url: leader_url,
            name: None,
        };
        if st.role != Role::Follower
            || st.leader.as_ref().map(|l| &l.host_id) != Some(&leader.host_id)
            || their_term > term
        {
            self.become_follower(&mut st, their_term, Some(leader.clone()));
        }
        st.leader = Some(leader.clone());
        st.last_contact = Some(Instant::now());
        st.group_view = serde_json::from_value(request["group"].clone()).unwrap_or_default();
        st.reset_deadline();
        let term = self.term();
        if st.copying.is_some() {
            return answer(term, false, Some("resyncing"), head(self));
        }
        if request["resync"] == true {
            self.start_resync(&mut st, &leader.url);
            return answer(term, false, Some("resyncing"), head(self));
        }
        let entries: Vec<log::Entry> = match serde_json::from_value(request["entries"].clone()) {
            Ok(entries) => entries,
            Err(_) => return answer(term, false, Some("invalid"), head(self)),
        };
        let outcome = log::append_from_leader(
            &mut self.db.lock().unwrap(),
            request["prevSeq"].as_i64().unwrap_or(0),
            request["prevId"].as_str(),
            &entries,
        );
        match outcome {
            Ok(()) => {
                st.resync_problem = None;
                answer(term, true, None, head(self))
            }
            Err(reason) => {
                if reason == "diverged" {
                    self.start_resync(&mut st, &leader.url);
                }
                answer(term, false, Some(reason), head(self))
            }
        }
    }

    fn start_resync(&self, st: &mut State, url: &str) {
        if st.copying.is_some() {
            return;
        }
        st.copying = Some(url.to_owned());
        let node = self.arc();
        let url = url.to_owned();
        std::thread::spawn(move || {
            if let Err(error) = node.copy_while_marked(&url, "pre-resync") {
                let problem = format!("Bijwerken vanaf de hoofdlaptop mislukt: {error}");
                eprintln!("{problem}");
                node.raft.lock().unwrap().resync_problem = Some(problem);
            }
        });
    }

    /// Replaces this laptop's data with a full copy from `url`, after a backup of what it had.
    /// Returns the leader's term and the backup's file name.
    pub(super) fn copy_from(&self, url: &str, reason: &str) -> Result<(i64, Option<String>)> {
        {
            let mut st = self.raft.lock().unwrap();
            if st.copying.is_some() {
                return Err("Deze laptop haalt al een kopie op.".into());
            }
            st.copying = Some(url.to_owned());
        }
        self.copy_while_marked(url, reason)
    }
    fn copy_while_marked(&self, url: &str, reason: &str) -> Result<(i64, Option<String>)> {
        let outcome = (|| {
            let answer = self.request(
                reqwest::Method::GET,
                &format!("{url}/api/cluster/snapshot"),
                None,
                Duration::from_secs(60),
            );
            let answer = answer.map_err(|_| "geen antwoord".to_string())?;
            if answer.status != 200 {
                return Err(answer.body["error"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| {
                        format!("Database ophalen mislukt (HTTP {}).", answer.status)
                    }));
            }
            use base64::Engine;
            let image = base64::engine::general_purpose::STANDARD
                .decode(answer.body["image"].as_str().unwrap_or(""))
                .map_err(|e| e.to_string())?;
            let term = answer.epoch.or(answer.body["term"].as_i64()).unwrap_or(0);
            let path = crate::backups::database_path(&self.db.lock().unwrap()).ok();
            let backup = match path {
                Some(path) => Some(
                    crate::backups::create_reason(&path, reason)?["fileName"]
                        .as_str()
                        .unwrap_or("")
                        .to_owned(),
                ),
                // An in-memory database (tests) has no folder for backups.
                None => None,
            };
            log::install(&mut self.db.lock().unwrap(), &image)?;
            Ok((term, backup))
        })();
        let mut st = self.raft.lock().unwrap();
        st.copying = None;
        if let Ok((term, _)) = &outcome {
            st.resync_problem = None;
            if *term > self.term() {
                self.set_term(*term);
            }
        }
        outcome
    }

    /// Becomes leader of a group of one; only when the operator (or the Timing laptop) goes on alone.
    pub(super) fn take_over_alone(&self) -> bool {
        let mut st = self.raft.lock().unwrap();
        if st.joining || st.copying.is_some() || st.role == Role::Leader {
            return false;
        }
        let term = self.term() + 1;
        self.set_term(term);
        self.record_vote(term, &self.host_id);
        if st.role == Role::Candidate {
            self.change_role(&mut st, Role::Follower, None);
        }
        self.change_role(&mut st, Role::Leader, None)
    }
    /// Stops taking part in this laptop's own group while it joins another one.
    pub(super) fn start_joining(&self) -> bool {
        let mut st = self.raft.lock().unwrap();
        if st.joining || st.copying.is_some() {
            return false;
        }
        st.joining = true;
        if st.role != Role::Follower {
            let term = self.term();
            self.become_follower(&mut st, term, None);
        }
        true
    }
    /// After joining, follow the leader the copy came from; after a failed join, carry on as before.
    pub(super) fn finish_joining(&self, next: Option<(i64, Member)>) {
        let mut st = self.raft.lock().unwrap();
        st.joining = false;
        if let Some((term, leader)) = next {
            let term = term.max(self.term());
            self.become_follower(&mut st, term, Some(leader));
        }
    }
}
