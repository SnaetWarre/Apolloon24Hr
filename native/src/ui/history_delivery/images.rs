use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Default)]
pub(in crate::ui) struct Images {
    rows: HashMap<(String, String), Vec<String>>,
    references: HashMap<String, usize>,
    pending: HashSet<String>,
}

impl Images {
    fn remove(&mut self, kind: &str, id: &str) {
        for url in self
            .rows
            .remove(&(kind.into(), id.into()))
            .into_iter()
            .flatten()
        {
            let count = self.references.get_mut(&url).unwrap();
            *count -= 1;
            if *count == 0 {
                self.references.remove(&url);
                self.pending.remove(&url);
            }
        }
    }

    fn put(&mut self, kind: &str, row: &Value, loaded: &HashSet<String>) {
        let Some(id) = row["id"].as_str() else { return };
        self.remove(kind, id);
        let urls: Vec<String> = row["labels"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|label| label["imageUrl"].as_str().filter(|url| !url.is_empty()))
            .map(str::to_owned)
            .collect();
        for url in &urls {
            *self.references.entry(url.clone()).or_default() += 1;
            if !loaded.contains(url) {
                self.pending.insert(url.clone());
            }
        }
        if !urls.is_empty() {
            self.rows.insert((kind.into(), id.into()), urls);
        }
    }

    pub(in crate::ui) fn accept(&mut self, reply: &Value, loaded: &HashSet<String>) {
        if reply["delta"] != true {
            *self = Self::default();
        }
        for kind in ["laps", "events"] {
            if reply["delta"] == true {
                for id in reply["changes"][kind]["removed"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                {
                    self.remove(kind, id);
                }
                for pair in reply["changes"][kind]["changed"]
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    self.put(kind, &pair[1], loaded);
                }
            } else {
                for row in reply[kind].as_array().into_iter().flatten() {
                    self.put(kind, row, loaded);
                }
            }
        }
    }

    pub(in crate::ui) fn pending(&self) -> impl Iterator<Item = String> + '_ {
        self.pending.iter().cloned()
    }

    pub(in crate::ui) fn loaded(&mut self, url: &str) {
        self.pending.remove(url);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn failed_images_retry_until_the_last_reference_is_removed_or_loaded() {
        let mut images = Images::default();
        let mut loaded = HashSet::new();
        images.accept(&json!({"laps":[{"id":"a","labels":[{"imageUrl":"old"}]},{"id":"b","labels":[{"imageUrl":"old"}]}]}), &loaded);
        assert_eq!(images.pending().collect::<Vec<_>>(), vec!["old"]);
        for id in ["a", "b"] {
            images.accept(
                &json!({"delta":true,"changes":{"laps":{"removed":[id],"changed":[]}}}),
                &loaded,
            );
            assert_eq!(images.pending().count(), usize::from(id == "a"));
        }
        let edit = json!({"delta":true,"changes":{"laps":{"changed":[[0,{"id":"b","labels":[{"imageUrl":"new"}]}]]}}});
        images.accept(&edit, &loaded);
        images.loaded("new");
        loaded.insert("new".to_owned());
        images.accept(&edit, &loaded);
        assert_eq!(images.pending().count(), 0);
        images.accept(&json!({"laps":[],"events":[]}), &loaded);
        assert!(images.references.is_empty());
        images.accept(&json!({"error":"unavailable"}), &loaded);
        assert_eq!(images.pending().count(), 0);
    }
}
