use serde::{Serialize, Serializer, ser::SerializeSeq};
use serde_json::Value;
use std::{
    cmp::Reverse,
    collections::{BTreeSet, HashMap},
    sync::Arc,
};

type Key = Reverse<(Option<i64>, i64)>;
const CHUNK: usize = 64;

struct Row {
    key: Key,
    value: Value,
}

#[derive(Clone, Default)]
pub(super) struct List(Vec<Arc<Vec<Arc<Row>>>>);

impl List {
    fn location(&self, key: Key) -> (usize, usize) {
        let chunk = self
            .0
            .partition_point(|rows| rows[0].key <= key)
            .saturating_sub(1);
        let position = self
            .0
            .get(chunk)
            .map_or(0, |rows| rows.partition_point(|row| row.key < key));
        (chunk, position)
    }
    fn insert(&mut self, row: Arc<Row>) {
        if self.0.is_empty() {
            self.0.push(Arc::new(vec![row]));
            return;
        }
        let (chunk, position) = self.location(row.key);
        let rows = Arc::make_mut(&mut self.0[chunk]);
        rows.insert(position, row);
        if rows.len() > CHUNK * 2 {
            let tail = rows.split_off(CHUNK);
            self.0.insert(chunk + 1, Arc::new(tail));
        }
    }
    fn remove(&mut self, key: Key) {
        let (chunk, position) = self.location(key);
        let rows = Arc::make_mut(&mut self.0[chunk]);
        assert_eq!(rows[position].key, key);
        rows.remove(position);
        if rows.is_empty() {
            self.0.remove(chunk);
        } else if let Some(next) = self.0.get(chunk + 1) {
            if self.0[chunk].len() + next.len() <= CHUNK * 2 {
                let next = self.0.remove(chunk + 1);
                Arc::make_mut(&mut self.0[chunk]).extend(next.iter().cloned());
            }
        }
    }
    fn position(&self, key: Key) -> usize {
        let (chunk, position) = self.location(key);
        self.0[..chunk].iter().map(|rows| rows.len()).sum::<usize>() + position
    }
}

impl Serialize for List {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(Some(self.0.iter().map(|rows| rows.len()).sum()))?;
        for row in self.0.iter().flat_map(|rows| rows.iter()) {
            seq.serialize_element(&row.value)?;
        }
        seq.end()
    }
}

#[derive(Default)]
pub(super) struct Rows {
    ids: HashMap<String, Arc<Row>>,
    rowids: HashMap<i64, String>,
}

impl Rows {
    pub(super) fn new(value: &mut Value, order: HashMap<String, i64>, time: &str) -> (Self, List) {
        let values = std::mem::take(value.as_array_mut().unwrap());
        let mut rows = Self::default();
        let mut list = List::default();
        for value in values {
            let id = value["id"].as_str().unwrap().to_owned();
            let rowid = order[&id];
            let row = Arc::new(Row {
                key: Reverse((value[time].as_i64(), rowid)),
                value,
            });
            rows.rowids.insert(rowid, id.clone());
            rows.ids.insert(id, row.clone());
            if list.0.last().is_none_or(|chunk| chunk.len() == CHUNK) {
                list.0.push(Default::default());
            }
            Arc::make_mut(list.0.last_mut().unwrap()).push(row);
        }
        (rows, list)
    }

    pub(super) fn touched(&self, new: &Self) -> Vec<String> {
        new.ids
            .iter()
            .filter(|(id, row)| self.ids.get(*id).is_none_or(|old| old.value != row.value))
            .map(|(id, _)| id.clone())
            .chain(
                self.ids
                    .keys()
                    .filter(|id| !new.ids.contains_key(*id))
                    .cloned(),
            )
            .collect()
    }

    pub(super) fn patch(
        &mut self,
        list: &mut List,
        rowids: &BTreeSet<i64>,
        rows: Vec<Value>,
        time: &str,
    ) -> Vec<String> {
        let mut ids: BTreeSet<String> = rowids
            .iter()
            .filter_map(|rowid| self.rowids.get(rowid).cloned())
            .collect();
        let mut after = HashMap::new();
        for mut value in rows {
            let rowid = value
                .as_object_mut()
                .unwrap()
                .shift_remove("_rowid")
                .unwrap()
                .as_i64()
                .unwrap();
            let id = value["id"].as_str().unwrap().to_owned();
            ids.insert(id.clone());
            after.insert(
                id,
                Arc::new(Row {
                    key: Reverse((value[time].as_i64(), rowid)),
                    value,
                }),
            );
        }
        let mut touched = Vec::new();
        for id in ids {
            let old = self.ids.get(&id);
            let new = after.get(&id);
            if old.map(|row| &row.value) != new.as_ref().map(|row| &row.value) {
                touched.push(id.clone());
            }
            if let Some(old) = self.ids.remove(&id) {
                list.remove(old.key);
                self.rowids.remove(&old.key.0.1);
            }
        }
        for (id, new) in after {
            list.insert(new.clone());
            self.rowids.insert(new.key.0.1, id.clone());
            self.ids.insert(id, new);
        }
        touched
    }

    pub(super) fn changes(&self, list: &List, ids: BTreeSet<&String>) -> Value {
        let mut changed = Vec::new();
        let mut removed = Vec::new();
        for id in ids {
            match self.ids.get(id) {
                Some(row) => changed.push((list.position(row.key), &row.value)),
                None => removed.push(id),
            }
        }
        changed.sort_by_key(|(position, _)| *position);
        serde_json::json!({"changed":changed,"removed":removed,"count":self.ids.len()})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn growing_chunks_split_and_keep_descending_time_and_rowid_order() {
        let (mut rows, mut list) =
            Rows::new(&mut serde_json::json!([]), Default::default(), "time");
        for i in 0..400 {
            rows.patch(
                &mut list,
                &BTreeSet::from([i]),
                vec![json!({"_rowid":i,"id":i.to_string(),"time":i%13})],
                "time",
            );
        }
        assert!(list.0.len() > 1);
        assert!(
            list.0
                .iter()
                .all(|chunk| !chunk.is_empty() && chunk.len() <= CHUNK * 2)
        );
        let mut expected: Vec<_> = (0..400)
            .map(|i| ((i % 13, i), json!({"id":i.to_string(),"time":i%13})))
            .collect();
        expected.sort_by_key(|(key, _)| Reverse(*key));
        assert_eq!(
            serde_json::to_value(&list).unwrap(),
            json!(
                expected
                    .into_iter()
                    .map(|(_, value)| value)
                    .collect::<Vec<_>>()
            )
        );
    }

    #[test]
    fn patches_share_untouched_chunks_and_keep_old_rows_and_positions() {
        let mut value = json!(
            (0..640)
                .rev()
                .map(|i| json!({"id":i.to_string(),"time":i/4}))
                .collect::<Vec<_>>()
        );
        let order = (0..640).map(|i| (i.to_string(), i)).collect();
        let (mut rows, mut list) = Rows::new(&mut value, order, "time");
        let old = list.clone();
        let old_body = serde_json::to_vec(&old).unwrap();
        let changed = rows.patch(
            &mut list,
            &BTreeSet::from([0]),
            vec![json!({"_rowid":0,"id":"0","time":1000})],
            "time",
        );
        assert_eq!(changed, vec!["0"]);
        assert!(Arc::ptr_eq(&old.0[3], &list.0[3]));
        assert!(Arc::ptr_eq(&old.0[3][0], &list.0[3][0]));
        assert_eq!(serde_json::to_vec(&old).unwrap(), old_body);
        let current = serde_json::to_value(&list).unwrap();
        assert_eq!(current[0]["id"], "0");
        for (position, value) in current.as_array().unwrap().iter().enumerate() {
            let row = &rows.ids[value["id"].as_str().unwrap()];
            assert_eq!(list.position(row.key), position);
        }
        rows.patch(&mut list, &(0..640).collect(), Vec::new(), "time");
        assert!(list.0.is_empty());
        assert!(rows.ids.is_empty());
        assert!(rows.rowids.is_empty());
        assert!(
            rows.patch(&mut list, &BTreeSet::from([900]), Vec::new(), "time")
                .is_empty()
        );
        rows.patch(
            &mut list,
            &BTreeSet::from([900]),
            vec![json!({"_rowid":900,"id":"new","time":null})],
            "time",
        );
        assert_eq!(
            serde_json::to_value(&list).unwrap(),
            json!([{"id":"new","time":null}])
        );
    }
}
