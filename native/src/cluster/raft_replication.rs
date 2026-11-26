//! Leader-side replication, write confirmation, follower append handling and full copies.
use super::{Progress, Role, State};
use crate::{
    cluster::{Node, log, log::Member},
    db::Result,
};
use serde_json::{Value, json};
use std::{
    sync::mpsc,
    time::{Duration, Instant},
};

/// Longest a write waiting for the majority goes without looking again.
const WAIT_STEP: Duration = Duration::from_millis(5);

impl Node {
    // Leader side: send each follower what it is missing, and learn how far it got.

    pub(super) fn replicate_to_all(&self, st: &mut State) {
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
                node.raft_changed.notify_all();
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
                // A follower may already hold the write this leader is still sending round.
                let ahead = st.pending.as_ref().filter(|p| p.entry.seq == prev_seq);
                let prev_id = if prev_seq == 0 {
                    None
                } else if let Some(pending) = ahead {
                    Some(pending.entry.id.clone())
                } else {
                    log::entry_id(&db, prev_seq)
                };
                let mut entries = if p.match_seq.is_none() || p.needs_resync || ahead.is_some() {
                    Some(Vec::new())
                } else {
                    log::entries_after(&db, prev_seq)
                };
                let resync =
                    p.needs_resync || (prev_seq > 0 && prev_id.is_none()) || entries.is_none();
                if let (false, Some(entries), Some(pending)) =
                    (resync, entries.as_mut(), &st.pending)
                {
                    if prev_seq + entries.len() as i64 == head && pending.entry.seq == head + 1 {
                        entries.push(pending.entry.clone());
                    }
                }
                let group = log_group(&db);
                drop(db);
                let request = self.append_request(
                    &st,
                    group,
                    term,
                    prev_seq,
                    prev_id,
                    entries.unwrap_or_default(),
                    resync,
                );
                (p.member.url.clone(), request)
            };
            if crate::latency::enabled() {
                let entries: Vec<log::Entry> =
                    serde_json::from_value(request["entries"].clone()).unwrap_or_default();
                for lap in log::handoff_laps(&entries) {
                    crate::latency::emit("replica_send", &lap, Some(&lap));
                }
            }
            let answer = self.post(
                &url,
                "/api/cluster/peer",
                &json!({"type":"append","body":request}),
                self.cfg.election_timeout.max(Duration::from_secs(2)),
            );
            let mut st = self.raft.lock().unwrap();
            // An answer to a request of an earlier leadership says nothing about this one.
            if st.role != Role::Leader || self.term() != term {
                return;
            }
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
            // This laptop itself answered: it has the address the other one was last seen at.
            if answer["reason"] == "self" {
                if let Some(p) = st.progress.get_mut(host_id) {
                    p.match_seq = None;
                }
                return;
            }
            let their_term = answer["term"].as_i64().unwrap_or(0);
            if their_term > self.term() {
                self.become_follower(&mut st, their_term, None);
                return;
            }
            let head_seq = answer["head"]["seq"].as_i64().unwrap_or(0);
            let head_id = answer["head"]["id"].as_str().map(str::to_owned);
            let newest = st
                .pending
                .as_ref()
                .map_or_else(|| log::head(&self.db.lock().unwrap()).seq, |p| p.entry.seq);
            let Some(p) = st.progress.get_mut(host_id) else {
                return;
            };
            p.last_ack = Some(Instant::now());
            if answer["ok"] == true {
                p.match_seq = Some(head_seq);
                p.needs_resync = false;
                self.advance_commit(&mut st);
                self.raft_changed.notify_all();
                if head_seq >= newest {
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

    #[allow(clippy::too_many_arguments)]
    fn append_request(
        &self,
        st: &State,
        (cluster_id, split): (String, Value),
        term: i64,
        prev_seq: i64,
        prev_id: Option<String>,
        entries: Vec<log::Entry>,
        resync: bool,
    ) -> Value {
        json!({
            "clusterId": cluster_id,
            "term": term,
            "leaderId": self.host_id,
            "leaderUrl": self.self_url(),
            "prevSeq": prev_seq,
            "prevId": prev_id,
            "entries": entries,
            "resync": resync,
            "group": self.view(st),
            "split": if split.is_string() { split } else { json!("") },
        })
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
        // A majority holding an entry of an earlier term proves nothing: a laptop that led in
        // between can still win and replace it. Once an entry of this term is on a majority, no
        // such laptop can win, and everything before that entry is confirmed with it.
        let db = self.db.lock().unwrap();
        if log::entry_term(&db, committed) == Some(log::term(&db)) {
            st.committed = st.committed.max(committed);
        }
    }

    /// Sends a write round and stores it here once a majority of the laptops hold it. False when
    /// that fails in time or leadership is lost: the write is then in this laptop's data nowhere.
    pub(in crate::cluster) fn confirm(&self, prepared: log::Prepared) -> bool {
        let (seq, id) = (prepared.entry.seq, prepared.entry.id.clone());
        let deadline = Instant::now() + self.cfg.commit_timeout;
        if prepared.voters.len() <= 1 {
            return log::apply_own(&mut self.db.lock().unwrap(), &prepared.entry).is_ok();
        }
        {
            let mut st = self.raft.lock().unwrap();
            let db = self.db.lock().unwrap();
            if st.role != Role::Leader
                || log::term(&db) != prepared.entry.epoch
                || log::head(&db).seq + 1 != seq
            {
                return false;
            }
            drop(db);
            st.pending = Some(prepared);
        }
        loop {
            let mut st = self.raft.lock().unwrap();
            let Some(pending) = st.pending.as_ref().filter(|p| p.entry.id == id) else {
                return false;
            };
            if st.role != Role::Leader {
                return false;
            }
            let holders = pending
                .voters
                .iter()
                .filter(|voter| {
                    **voter == self.host_id
                        || st
                            .progress
                            .get(*voter)
                            .and_then(|p| p.match_seq)
                            .is_some_and(|stored| stored >= seq)
                })
                .count();
            if holders > pending.voters.len() / 2 {
                let entry = st.pending.take().map(|p| p.entry);
                let stored = entry
                    .as_ref()
                    .is_some_and(|e| log::apply_own(&mut self.db.lock().unwrap(), e).is_ok());
                if stored {
                    self.advance_commit(&mut st);
                    return true;
                }
            } else if Instant::now() < deadline {
                self.replicate_to_all(&mut st);
                // Woken as soon as another laptop answers; the short wait only bounds a miss.
                let _ = self.raft_changed.wait_timeout(st, WAIT_STEP).unwrap();
                continue;
            }
            // Another laptop may hold this write. A later election decides whether it counts, so
            // what this laptop stores next at that place (a Timing press) gets a new term.
            let term = self.term() + 1;
            self.become_follower(&mut st, term, None);
            return false;
        }
    }

    /// A Timing press on the Timing laptop. It goes to the others while this laptop stores its
    /// own copy, so a slow disk here alone does not hold it up. Confirmed once a majority stored
    /// it on disk, this laptop counting once its own copy is there. That copy is stored whatever
    /// the others do: a Timing laptop that is cut off goes on alone with every press it clocked.
    pub(in crate::cluster) fn confirm_kept(
        &self,
        prepared: log::Prepared,
        stored: impl FnOnce() + Send + 'static,
    ) -> bool {
        let seq = prepared.entry.seq;
        let deadline = Instant::now() + self.cfg.commit_timeout;
        let needed = prepared.voters.len() / 2 + 1;
        // Each laptop's answer, this one included, comes straight here: counting it does not
        // wait for locks that this laptop's own copy may hold up.
        let (answers, holders) = mpsc::channel::<(String, bool)>();
        {
            let mut st = self.raft.lock().unwrap();
            let (head, term, group) = {
                let db = self.db.lock().unwrap();
                (log::head(&db), log::term(&db), log_group(&db))
            };
            if st.role != Role::Leader || term != prepared.entry.epoch || head.seq + 1 != seq {
                return false;
            }
            for lap in log::handoff_laps(std::slice::from_ref(&prepared.entry)) {
                crate::latency::emit("replica_send", &lap, Some(&lap));
            }
            // Each laptop that holds everything before the press gets it at once; the usual
            // rounds bring it to the others.
            for member in self.others() {
                let request = self.append_request(
                    &st,
                    group.clone(),
                    term,
                    head.seq,
                    head.id.clone(),
                    vec![prepared.entry.clone()],
                    false,
                );
                if !prepared.voters.contains(&member.host_id)
                    || st.progress.get(&member.host_id).and_then(|p| p.match_seq) != Some(head.seq)
                {
                    continue;
                }
                let (node, answers) = (self.arc(), answers.clone());
                std::thread::spawn(move || node.send_kept(&member, term, seq, &request, &answers));
            }
            st.pending = Some(prepared.clone());
        }
        // The own copy takes the database before this returns, so no later write can take its
        // place in the log.
        let (held, holding) = mpsc::channel::<()>();
        let (node, own) = (self.arc(), answers);
        let entry = prepared.entry;
        std::thread::spawn(move || {
            let stored_here = {
                let mut db = node.db.lock().unwrap();
                let _ = held.send(());
                #[cfg(test)]
                std::thread::sleep(*node.slow_disk.lock().unwrap());
                log::apply_own(&mut db, &entry).is_ok()
            };
            let mut st = node.raft.lock().unwrap();
            if st.pending.as_ref().is_some_and(|p| p.entry.id == entry.id) {
                st.pending = None;
                if stored_here {
                    node.advance_commit(&mut st);
                } else {
                    // As in `confirm`: another laptop may hold it, and a later election decides.
                    let term = node.term() + 1;
                    node.become_follower(&mut st, term, None);
                }
            }
            drop(st);
            if stored_here {
                stored();
            }
            let _ = own.send((node.host_id.clone(), stored_here));
            node.raft_changed.notify_all();
        });
        let _ = holding.recv();
        let mut holding = std::collections::HashSet::new();
        let mut here = None;
        while holding.len() < needed && here.is_none() {
            match holders.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok((host, stored)) => {
                    if host == self.host_id {
                        here = Some(stored);
                    }
                    if stored {
                        holding.insert(host);
                    }
                }
                Err(_) => break,
            }
        }
        if holding.len() >= needed {
            return true;
        }
        // Once this laptop holds it the usual rounds take over, also reaching a laptop that was
        // behind. Not confirmed in time: before the press is tried again it is in this laptop's
        // data.
        let here = here.or_else(|| {
            holders
                .iter()
                .find(|(host, _)| *host == self.host_id)
                .map(|(_, stored)| stored)
        });
        here == Some(true) && self.wait_for_commit_until(seq, deadline)
    }

    /// Sends a kept press to a laptop that holds everything before it, and answers whether that
    /// laptop stored it.
    fn send_kept(
        &self,
        member: &Member,
        term: i64,
        seq: i64,
        request: &Value,
        answers: &mpsc::Sender<(String, bool)>,
    ) {
        let answer = self.post(
            &member.url,
            "/api/cluster/peer",
            &json!({"type":"append","body":request}),
            self.cfg.election_timeout.max(Duration::from_secs(2)),
        );
        let head = answer
            .ok()
            .filter(|a| a.status == 200 && a.body["ok"] == true && a.body["term"].as_i64() == Some(term))
            .and_then(|a| a.body["head"]["seq"].as_i64());
        let _ = answers.send((member.host_id.clone(), head.is_some_and(|h| h >= seq)));
        let mut st = self.raft.lock().unwrap();
        let leading = st.role == Role::Leader && self.term() == term;
        if let Some(p) = st.progress.get_mut(&member.host_id).filter(|_| leading)
            && let Some(head) = head
        {
            p.match_seq = p.match_seq.max(Some(head));
            p.last_ack = Some(Instant::now());
        }
        if leading && head.is_some() {
            self.advance_commit(&mut st);
        }
        drop(st);
        self.raft_changed.notify_all();
    }

    /// True once a majority stored entry `seq`; false when that fails in time or leadership is lost.
    pub fn wait_for_commit(&self, seq: i64) -> bool {
        self.wait_for_commit_until(seq, Instant::now() + self.cfg.commit_timeout)
    }
    fn wait_for_commit_until(&self, seq: i64, deadline: Instant) -> bool {
        if self.members().len() == 1 {
            return true;
        }
        {
            let mut st = self.raft.lock().unwrap();
            if st.role != Role::Leader {
                return false;
            }
            self.replicate_to_all(&mut st);
            self.advance_commit(&mut st);
        }
        loop {
            let st = self.raft.lock().unwrap();
            if st.role != Role::Leader {
                return false;
            }
            if st.committed >= seq {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            let (mut st, _) = self.raft_changed.wait_timeout(st, WAIT_STEP).unwrap();
            self.replicate_to_all(&mut st);
        }
    }
    /// True while this laptop leads and a majority holds its whole log.
    pub fn log_settled(&self) -> bool {
        self.settled(&self.raft.lock().unwrap())
    }
    fn settled(&self, st: &State) -> bool {
        st.role == Role::Leader
            && (self.members().len() == 1
                || st.committed >= log::head(&self.db.lock().unwrap()).seq)
    }
    /// Waits up to three seconds for that. What the others still miss is sent to them right away,
    /// not at the next sign of life, so taking in a laptop does not wait for one.
    pub fn group_settled(&self) -> bool {
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut st = self.raft.lock().unwrap();
        loop {
            if self.settled(&st) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            if st.role == Role::Leader {
                self.replicate_to_all(&mut st);
            }
            st = self.raft_changed.wait_timeout(st, WAIT_STEP).unwrap().0;
        }
    }

    // Follower side.

    /// Stores a leader's append; answers with this log's head so the leader knows what to send next.
    pub(in crate::cluster) fn handle_append(&self, request: &Value, remote: Option<std::net::IpAddr>) -> Value {
        if crate::latency::enabled() {
            let entries: Vec<log::Entry> =
                serde_json::from_value(request["entries"].clone()).unwrap_or_default();
            for lap in log::handoff_laps(&entries) {
                crate::latency::emit("append_received", &lap, Some(&lap));
            }
        }
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
        // A term that could not be stored: an earlier leader would still be believed later.
        if self.term() < their_term {
            return answer(self.term(), false, Some("term-not-stored"), head(self));
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
            term,
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
    pub(in crate::cluster) fn copy_from(&self, url: &str, reason: &str) -> Result<(i64, Option<String>)> {
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
}

/// The group and split an append names.
fn log_group(db: &crate::db::Db) -> (String, Value) {
    (
        log::setting(db, "replication_cluster_id").unwrap_or_default(),
        log::json_setting(db, "cluster_split_json")["id"].clone(),
    )
}
