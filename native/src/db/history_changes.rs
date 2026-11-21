use std::collections::{BTreeSet, VecDeque};

const MAX_ROWS: usize = 4096;
const MAX_COMMITS: usize = 1024;
const MAX_RETAINED_ROWS: usize = 20_000;

#[derive(Clone, Default)]
pub(crate) struct Changes {
    pub laps: BTreeSet<i64>,
    pub events: BTreeSet<i64>,
    pub runners: BTreeSet<i64>,
    pub full: bool,
    seen: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pending_rollback_unknown_and_expired_changes_are_conservative() {
        let mut journal = Journal::default();
        journal.update("main", "laps", 7);
        assert!(journal.since(Some(0)).unwrap().laps.is_empty());
        journal.commit();
        assert_eq!(journal.since(Some(0)).unwrap().laps, BTreeSet::from([7]));
        journal.update("main", "laps", 8);
        journal.rollback();
        assert!(journal.since(Some(1)).unwrap().full);
        journal.update("main", "unrecognized", 1);
        journal.commit();
        assert!(journal.since(Some(2)).unwrap().full);
        for i in 0..MAX_COMMITS + 1 {
            journal.update("main", "laps", i as i64);
            journal.commit();
        }
        assert!(journal.since(Some(3)).is_none());
        let before = journal.generation;
        for i in 0..MAX_ROWS + 1 {
            journal.update("main", "laps", i as i64);
        }
        journal.commit();
        assert!(journal.since(Some(before)).unwrap().full);
    }
}
impl Changes {
    fn merge(&mut self, other: &Self) {
        self.full |= other.full;
        self.seen |= other.seen;
        self.laps.extend(&other.laps);
        self.events.extend(&other.events);
        self.runners.extend(&other.runners);
        if self.laps.len() + self.events.len() + self.runners.len() > MAX_ROWS || self.full {
            self.full = true;
            self.laps.clear();
            self.events.clear();
            self.runners.clear();
        }
    }
}

#[derive(Default)]
pub(crate) struct Journal {
    pub generation: u64,
    pending: Changes,
    commits: VecDeque<(u64, Changes)>,
    rows: usize,
    baseline: u64,
    updates: u64,
    gap: i128,
}
impl Journal {
    pub fn new(baseline: u64) -> Self {
        Self {
            baseline,
            ..Default::default()
        }
    }
    pub fn observe(&mut self, total: u64) {
        let gap = i128::from(total) - i128::from(self.baseline) - i128::from(self.updates);
        if gap != self.gap {
            self.gap = gap;
            self.record(Changes {
                full: true,
                ..Default::default()
            });
        }
    }
    pub fn update(&mut self, schema: &str, table: &str, rowid: i64) {
        self.updates = self.updates.wrapping_add(1);
        self.pending.seen = true;
        if self.pending.full {
            return;
        }
        if schema != "main" {
            self.pending.full = true;
            return;
        }
        match table {
            "laps" => {
                self.pending.laps.insert(rowid);
            }
            "race_events" => {
                self.pending.events.insert(rowid);
            }
            "runners" => {
                self.pending.runners.insert(rowid);
            }
            "race_state"
            | "handoff_history"
            | "activity_log"
            | "replication_log"
            | "forwarded_writes"
            | "cluster_members"
            | "cluster_member_names" => {}
            _ => self.pending.full = true,
        }
        if self.pending.laps.len() + self.pending.events.len() + self.pending.runners.len()
            > MAX_ROWS
        {
            self.pending = Changes {
                full: true,
                seen: true,
                ..Default::default()
            };
        }
    }
    pub fn commit(&mut self) {
        let mut changes = std::mem::take(&mut self.pending);
        changes.full |= !changes.seen;
        self.record(changes);
    }
    fn record(&mut self, changes: Changes) {
        self.generation = self.generation.wrapping_add(1);
        if self.generation == 0 {
            self.commits.clear();
            self.rows = 0;
        }
        self.rows += changes.laps.len() + changes.events.len() + changes.runners.len();
        self.commits.push_back((self.generation, changes));
        while self.commits.len() > MAX_COMMITS || self.rows > MAX_RETAINED_ROWS {
            let (_, old) = self.commits.pop_front().unwrap();
            self.rows -= old.laps.len() + old.events.len() + old.runners.len();
        }
    }
    pub fn rollback(&mut self) {
        self.pending = Changes {
            full: true,
            seen: true,
            ..Default::default()
        };
        self.commit();
    }
    pub fn since(&self, since: Option<u64>) -> Option<Changes> {
        let since = since?;
        let oldest = self
            .commits
            .front()
            .map_or(self.generation, |(seq, _)| seq.saturating_sub(1));
        if since < oldest || since > self.generation {
            return None;
        }
        let mut result = Changes::default();
        for (_, changes) in self.commits.iter().filter(|(seq, _)| *seq > since) {
            result.merge(changes);
        }
        Some(result)
    }
}
