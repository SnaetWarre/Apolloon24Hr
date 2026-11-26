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
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{atomic::Ordering, mpsc},
    time::{Duration, Instant},
};

#[path = "raft_replication.rs"]
mod replication;

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
    /// The write this leader is sending round; it is not in the leader's own data yet.
    pending: Option<log::Prepared>,
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
            pending: None,
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

/// The answers to a (pre-)vote request: votes given, and laptops that did not answer at all.
struct Votes {
    granted: usize,
    silent: usize,
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
    /// False when the term could not be stored: this laptop then still has the old one.
    fn set_term(&self, term: i64) -> bool {
        term == self.term()
            || log::set_local(&self.db.lock().unwrap(), "cluster_epoch", &term.to_string()).is_ok()
    }
    fn voted_for(&self, term: i64) -> Option<String> {
        let raw = log::setting(&self.db.lock().unwrap(), "cluster_voted_for")?;
        let (voted_term, host) = raw.split_once(':')?;
        (voted_term.parse::<i64>().ok() == Some(term) && !host.is_empty()).then(|| host.to_owned())
    }
    /// False when the vote could not be stored. A vote that is not on disk does not count: this
    /// laptop could give it a second time in the same term, and two laptops would lead.
    fn record_vote(&self, term: i64, host_id: &str) -> bool {
        log::set_local(
            &self.db.lock().unwrap(),
            "cluster_voted_for",
            &format!("{term}:{host_id}"),
        )
        .is_ok()
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
        st.pending = None;
        self.raft_changed.notify_all();
        if next == Role::Leader {
            st.leader = Some(self.self_member());
            st.last_contact = Some(Instant::now());
            st.last_quorum = Instant::now();
            st.committed = 0;
            st.resync_problem = None;
            st.progress.clear();
            st.group_view.clear();
            // The first entry of a leadership won by vote: nothing from an earlier term counts as
            // confirmed until a majority holds it. A laptop going on alone was not elected and
            // gets no such entry: if it stops before the split is stored, it must not outrank
            // the group it is still in.
            if was == Role::Candidate {
                let _ = log::append_empty(&self.db.lock().unwrap(), "cluster.newLeader");
            }
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
        let could_run =
            st.role == Role::Follower && !st.alive() && !st.joining && st.copying.is_none();
        if !could_run || pre.granted + 1 < self.majority() {
            st.electing = false;
            if could_run && pre.granted + pre.silent + 1 >= self.majority() {
                // Only laptops that are off kept the pre-vote short. Asking again is harmless (a
                // pre-vote changes no term and no vote), so ask again at the next tick: a laptop
                // restarted in the meantime is asked within one heartbeat of answering.
                st.deadline = Instant::now();
            } else if st.role != Role::Leader {
                st.reset_deadline();
            }
            return;
        }
        let term = self.term() + 1;
        if !self.set_term(term) || !self.record_vote(term, &self.host_id) {
            st.electing = false;
            st.reset_deadline();
            return;
        }
        self.change_role(&mut st, Role::Candidate, None);
        drop(st);
        let votes = self.ask_for_votes(&self.vote_request(false, term)).granted;
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

    fn ask_for_votes(&self, request: &Value) -> Votes {
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
        let mut silent = 0;
        let mut someone_leads = false;
        for (member, answer) in answers {
            let Some(answer) = answer else {
                silent += 1;
                continue;
            };
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
                    return Votes { granted, silent };
                }
            }
        }
        if someone_leads {
            Votes {
                granted: 0,
                silent: 0,
            }
        } else {
            Votes { granted, silent }
        }
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
        if self.term() != asked || !self.record_vote(asked, candidate) {
            return refuse(self.term());
        }
        st.reset_deadline();
        json!({"term": self.term(), "granted": true})
    }

    /// Becomes leader of a group of one; only when the operator (or the Timing laptop) goes on alone.
    pub(super) fn take_over_alone(&self) -> bool {
        let mut st = self.raft.lock().unwrap();
        if st.joining || st.copying.is_some() || st.role == Role::Leader {
            return false;
        }
        let term = self.term() + 1;
        if !self.set_term(term) || !self.record_vote(term, &self.host_id) {
            return false;
        }
        if st.role == Role::Candidate {
            self.change_role(&mut st, Role::Follower, None);
        }
        self.change_role(&mut st, Role::Leader, None)
    }
    pub(super) fn step_down(&self) {
        let mut st = self.raft.lock().unwrap();
        if st.role == Role::Leader {
            let term = self.term();
            self.become_follower(&mut st, term, None);
        }
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
