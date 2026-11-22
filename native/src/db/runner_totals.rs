use super::{Db, Result};
use rusqlite::hooks::Action;
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

macro_rules! ordered {
    () => { " GROUP BY r.id ORDER BY CASE r.status WHEN 'running' THEN 0 WHEN 'waiting' THEN 1 WHEN 'warming_up' THEN 2 WHEN 'ran' THEN 3 ELSE 4 END,r.queue_index,r.name" };
}
const FULL: &str = concat!(runner_select!(), ordered!());
const METADATA: &str = concat!(runner_fields!(), " FROM runners r", ordered!());
const FIELDS: [&str; 6] = [
    "lapCount",
    "bestLapMs",
    "slowestLapMs",
    "averageLapMs",
    "totalTimeMs",
    "lastLapMs",
];
type Totals = [Value; 6];

#[derive(Clone, Default)]
struct Dirty {
    full: bool,
    rows: BTreeSet<i64>,
}
impl Dirty {
    fn merge(&mut self, other: Self) {
        self.full |= other.full;
        self.rows.extend(other.rows);
        if self.full || self.rows.len() > 64 {
            self.full = true;
            self.rows.clear();
        }
    }
}

pub(super) struct Cache {
    entries: Option<Arc<HashMap<String, Totals>>>,
    pending: Dirty,
    committed: Dirty,
    baseline: u64,
    updates: u64,
    version: Option<(i64, i64)>,
    pub(super) append: bool,
    generation: u64,
    parent: Option<(std::sync::Arc<std::sync::Mutex<Cache>>, u64)>,
    #[cfg(test)]
    full_reads: usize,
    #[cfg(test)]
    runner_reads: usize,
}
impl Cache {
    pub(super) fn new(baseline: u64) -> Self {
        Self {
            entries: None,
            pending: Dirty::default(),
            committed: Dirty::default(),
            baseline,
            updates: 0,
            version: None,
            append: false,
            generation: 0,
            parent: None,
            #[cfg(test)]
            full_reads: 0,
            #[cfg(test)]
            runner_reads: 0,
        }
    }
    pub(super) fn update(&mut self, action: Action, schema: &str, table: &str, rowid: i64) {
        self.updates = self.updates.wrapping_add(1);
        if schema != "main" {
            return;
        }
        let mut dirty = Dirty::default();
        match table {
            "laps" if self.append && action == Action::SQLITE_INSERT => {
                dirty.rows.insert(rowid);
            }
            "laps" => dirty.full = true,
            "runners" if action != Action::SQLITE_UPDATE => dirty.full = true,
            _ => {}
        }
        self.pending.merge(dirty);
    }
    pub(super) fn commit(&mut self) {
        if self.pending.full || !self.pending.rows.is_empty() {
            self.generation = self.generation.wrapping_add(1);
        }
        self.committed.merge(std::mem::take(&mut self.pending));
    }
    pub(super) fn rollback(&mut self) {
        self.pending = Dirty::default();
    }
    pub(super) fn begin_write(&mut self, method: &str) {
        if method.starts_with("laps.")
            || matches!(
                method,
                "race.undoLastHandoff"
                    | "race.clear"
                    | "runners.importCsv"
                    | "runners.importXlsx"
                    | "runners.merge"
                    | "backups.applyRestore"
            )
        {
            self.pending.full = true;
            self.pending.rows.clear();
        }
    }
    fn observe(&mut self, db: &Db) -> Result<()> {
        let version = (db.data_version()?, db.schema_version()?);
        let total = db.conn.total_changes();
        let unknown = i128::from(total) - i128::from(self.baseline) != i128::from(self.updates);
        self.baseline = total;
        self.updates = 0;
        if unknown || self.version != Some(version) {
            self.entries = None;
            self.generation = self.generation.wrapping_add(1);
        }
        self.version = Some(version);
        Ok(())
    }
    pub(super) fn fork(db: &Db, version: (i64, i64)) -> Result<Self> {
        let mut source = db.runner_totals.lock().unwrap();
        source.observe(db)?;
        let mut snapshot = Self::new(0);
        if db.conn.is_autocommit() && source.version == Some(version) {
            snapshot.entries = source.entries.clone();
            snapshot.committed = source.committed.clone();
            snapshot.parent = Some((db.runner_totals.clone(), source.generation));
        }
        Ok(snapshot)
    }
    fn publish(&mut self) {
        let Some((parent, generation)) = &self.parent else {
            return;
        };
        let mut parent = parent.lock().unwrap();
        if parent.generation == *generation {
            parent.entries = self.entries.clone();
            parent.committed = Dirty::default();
            #[cfg(test)]
            {
                parent.full_reads += self.full_reads;
                parent.runner_reads += self.runner_reads;
                self.full_reads = 0;
                self.runner_reads = 0;
            }
        }
    }
}

fn totals(runner: &Value) -> Totals {
    std::array::from_fn(|i| runner[FIELDS[i]].clone())
}

pub(super) fn runners(db: &Db) -> Result<Vec<Value>> {
    // A prepared cluster write may be read and then rolled back. Cache only committed reads.
    let mut cache = db.runner_totals.lock().unwrap();
    let snapshot = cache.parent.is_some();
    if !db.conn.is_autocommit() && !snapshot {
        drop(cache);
        return db.rows(FULL, &[]);
    }
    if !snapshot {
        cache.observe(db)?;
    }
    let dirty = std::mem::take(&mut cache.committed);
    let mut entries = cache.entries.take();
    if dirty.full {
        entries = None;
    }
    if let Some(entries) = &mut entries {
        if !dirty.rows.is_empty() {
            let args: Vec<_> = dirty.rows.iter().map(|row| json!(row)).collect();
            let rows = db.rows(
                &format!(
                    "SELECT runner_id AS id FROM laps WHERE rowid IN ({})",
                    vec!["?"; args.len()].join(",")
                ),
                &args,
            )?;
            if rows.len() != args.len() {
                let rows = rebuild(db, &mut cache)?;
                cache.publish();
                return Ok(rows);
            }
            for row in rows {
                Arc::make_mut(entries).remove(row["id"].as_str().unwrap_or_default());
            }
        }
    }
    let result = if let Some(mut entries) = entries {
        let mut runners = db.rows(METADATA, &[])?;
        for runner in &mut runners {
            let id = runner["id"].as_str().unwrap_or_default().to_owned();
            if !entries.contains_key(&id) {
                let row = db.one(
                    concat!(runner_select!(), " WHERE r.id=? GROUP BY r.id"),
                    &[json!(id)],
                )?;
                Arc::make_mut(&mut entries).insert(id.clone(), totals(&row));
                #[cfg(test)]
                {
                    cache.runner_reads += 1;
                }
            }
            let object = runner.as_object_mut().unwrap();
            for (key, value) in FIELDS.iter().zip(&entries[&id]) {
                object.insert((*key).to_owned(), value.clone());
            }
        }
        cache.entries = Some(entries);
        runners
    } else {
        rebuild(db, &mut cache)?
    };
    if !snapshot && Some((db.data_version()?, db.schema_version()?)) != cache.version {
        cache.entries = None;
        return db.rows(FULL, &[]);
    }
    cache.publish();
    Ok(result)
}

fn rebuild(db: &Db, cache: &mut Cache) -> Result<Vec<Value>> {
    let runners = db.rows(FULL, &[])?;
    cache.entries = Some(Arc::new(
        runners
            .iter()
            .map(|r| (r["id"].as_str().unwrap_or_default().to_owned(), totals(r)))
            .collect(),
    ));
    #[cfg(test)]
    {
        cache.full_reads += 1;
    }
    Ok(runners)
}

#[cfg(test)]
#[path = "runner_totals_tests.rs"]
mod tests;
