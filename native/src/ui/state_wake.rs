use serde_json::Value;
use std::collections::VecDeque;

#[derive(Default)]
pub(super) struct Wakes {
    pub ordinary: Option<rune::Waker>,
    pub urgent: Option<rune::Waker>,
    revisions: VecDeque<Revision>,
}

struct Revision {
    epoch: String,
    queued: u64,
    applied: Option<u64>,
}

#[derive(Debug, PartialEq)]
pub(super) enum Request {
    Urgent,
    Ordinary(&'static str),
}

fn version(snapshot: &Value) -> Option<(&str, u64)> {
    let epoch = snapshot["changeToken"].as_str()?.split('.').next()?;
    if epoch.is_empty() { return None; }
    Some((epoch, snapshot["revision"].as_u64()?))
}

impl Wakes {
    fn revision(&mut self, epoch: &str, revision: u64) -> &mut Revision {
        if let Some(index) = self.revisions.iter().position(|seen| seen.epoch == epoch) {
            let seen = self.revisions.remove(index).unwrap();
            self.revisions.push_back(seen);
        } else {
            if self.revisions.len() == 16 { self.revisions.pop_front(); }
            self.revisions.push_back(Revision { epoch: epoch.into(), queued: revision, applied: None });
        }
        self.revisions.back_mut().unwrap()
    }

    pub fn applied(&mut self, snapshot: &Value) {
        if let Some((epoch, revision)) = version(snapshot) {
            let seen = self.revision(epoch, revision);
            seen.queued = seen.queued.max(revision);
            seen.applied = Some(seen.applied.unwrap_or(0).max(revision));
        }
    }

    pub fn request(&mut self, snapshot: &Value, partial: bool) -> Request {
        if partial || snapshot.is_null() { return Request::Ordinary("recovery_only"); }
        if snapshot["unchanged"] == true { return Request::Ordinary("unchanged"); }
        let Some((epoch, revision)) = version(snapshot) else { return Request::Ordinary("unversioned"); };
        if let Some(seen) = self.revisions.iter().find(|seen| seen.epoch == epoch) {
            if revision < seen.queued { return Request::Ordinary("older_revision"); }
            if seen.applied.is_some_and(|applied| revision <= applied) {
                return Request::Ordinary("already_applied_revision");
            }
            if revision == seen.queued { return Request::Ordinary("duplicate_revision"); }
        }
        self.revision(epoch, revision).queued = revision;
        Request::Urgent
    }
}

#[cfg(test)]
#[path = "state_wake_tests.rs"]
mod tests;
