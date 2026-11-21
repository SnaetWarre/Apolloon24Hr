use super::*;
use std::collections::HashSet;
mod order;
#[cfg(test)]
mod tests;

#[derive(Default)]
pub(super) struct Pending {
    pub reset: bool,
}

#[derive(Default)]
struct Rows {
    order: order::Order,
}

impl Rows {
    fn new(rows: &Value) -> Self {
        let mut order = order::Order::default();
        for (index, row) in rows.as_array().into_iter().flatten().enumerate() {
            if let Some(id) = row["id"].as_str() {
                order.insert(index, id.to_owned());
            }
        }
        Self { order }
    }

    fn apply(&mut self, held: &mut Value, change: &Value) -> Option<bool> {
        let rows = held.as_array_mut()?;
        let removed = change["removed"].as_array()?;
        let changes = change["changed"].as_array()?;
        let count = usize::try_from(change["count"].as_u64()?).ok()?;
        if removed.is_empty() && changes.is_empty() {
            return (count == rows.len()).then_some(false);
        }
        let mut incoming = Vec::with_capacity(changes.len());
        let mut ids = HashSet::new();
        let mut slots = HashSet::new();
        for pair in changes {
            let index = usize::try_from(pair[0].as_u64()?).ok()?;
            let id = pair[1]["id"].as_str()?;
            if index >= count || !ids.insert(id) || !slots.insert(index) {
                return None;
            }
            incoming.push((index, id, &pair[1]));
        }
        incoming.sort_by_key(|(index, _, _)| *index);
        if removed.is_empty()
            && count == rows.len()
            && incoming
                .iter()
                .all(|(slot, id, _)| self.order.position(id) == Some(*slot))
        {
            let mut changed = false;
            for (slot, _, row) in incoming {
                if rows[slot] != *row {
                    rows[slot] = row.clone();
                    changed = true;
                }
            }
            return Some(changed);
        }
        if removed.is_empty()
            && count == rows.len() + incoming.len()
            && incoming
                .iter()
                .enumerate()
                .all(|(i, (slot, id, _))| i == *slot && self.order.position(id).is_none())
        {
            for (slot, id, _) in &incoming {
                self.order.insert(*slot, (*id).to_owned());
            }
            rows.splice(0..0, incoming.into_iter().map(|(_, _, row)| row.clone()));
            return Some(true);
        }
        let mut discard: HashSet<&str> =
            removed.iter().map(Value::as_str).collect::<Option<_>>()?;
        discard.extend(incoming.iter().map(|(_, id, _)| *id));
        let mut old: Vec<usize> = discard
            .iter()
            .filter_map(|id| self.order.position(id))
            .collect();
        old.sort_unstable();
        if rows.len().checked_sub(old.len())? + incoming.len() != count {
            return None;
        }
        let changed = !old.is_empty() || !incoming.is_empty();
        for index in &old {
            if *index >= rows.len() {
                return None;
            }
        }
        for id in discard {
            self.order.remove(id);
        }
        for index in old.into_iter().rev() {
            rows.remove(index);
        }
        for (slot, id, row) in incoming {
            self.order.insert(slot, id.to_owned());
            rows.insert(slot, row.clone());
        }
        Some(changed)
    }
}

#[derive(Default)]
pub(super) struct Index {
    laps: Rows,
    events: Rows,
}

impl Index {
    pub fn new(history: &Value) -> Self {
        Self {
            laps: Rows::new(&history["laps"]),
            events: Rows::new(&history["events"]),
        }
    }

    pub fn apply(&mut self, held: &mut Value, delta: &Value) -> Option<bool> {
        if delta["cursor"] == held["cursor"] {
            return Some(false);
        }
        if delta["since"] != held["cursor"] {
            return None;
        }
        let laps = self
            .laps
            .apply(&mut held["laps"], &delta["changes"]["laps"])?;
        let events = self
            .events
            .apply(&mut held["events"], &delta["changes"]["events"])?;
        held["cursor"] = delta["cursor"].clone();
        held["revision"] = delta["revision"].clone();
        Some(laps || events)
    }
}
