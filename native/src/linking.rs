//! Registration merge used to bring pre-race event data together.
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Person {
    pub id: String,
    pub name: String,
    pub email: String,
    pub phone: String,
    pub number: Option<String>,
}

fn identity(person: &Person) -> (String, String, String) {
    let name = person
        .name
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    let email = person.email.trim().to_lowercase();
    let phone = person
        .phone
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '.' && *c != '-')
        .collect::<String>()
        .to_lowercase();
    (name, email, phone)
}

#[derive(Debug, PartialEq, Eq)]
pub struct MergePlan {
    /// Each existing person is paired at most once, even when names/contact details repeat.
    pub matched: Vec<(String, String)>,
    pub add: Vec<(String, Option<String>)>,
}

pub fn plan_merge(existing: &[Person], incoming: &[Person]) -> MergePlan {
    let mut people: HashMap<_, VecDeque<_>> = HashMap::new();
    let mut numbers: std::collections::HashSet<String> =
        existing.iter().filter_map(|p| p.number.clone()).collect();
    for person in existing {
        people
            .entry(identity(person))
            .or_default()
            .push_back(person.id.clone());
    }
    let mut plan = MergePlan {
        matched: Vec::new(),
        add: Vec::new(),
    };
    for person in incoming {
        if let Some(id) = people
            .get_mut(&identity(person))
            .and_then(VecDeque::pop_front)
        {
            plan.matched.push((person.id.clone(), id));
        } else {
            let number = person
                .number
                .clone()
                .filter(|n| !n.is_empty() && numbers.insert(n.clone()));
            plan.add.push((person.id.clone(), number));
        }
    }
    plan
}

/// Zero completed laps can still mean the first runner is currently on the track.
pub fn may_merge(race_started_at: Option<i64>, race_finished_at: Option<i64>, laps: u64) -> bool {
    race_started_at.is_none() && race_finished_at.is_none() && laps == 0
}

impl crate::db::Db {
    /// Called inside the event write transaction. The destination retains its queue and settings.
    pub fn merge_registrations(
        &self,
        input: &serde_json::Value,
    ) -> crate::db::Result<serde_json::Value> {
        use crate::db::{id, now};
        use serde_json::{Value, json};
        let race = self.race()?;
        let lap_count = self.one("SELECT COUNT(*) AS count FROM laps", &[])?["count"]
            .as_u64()
            .ok_or("Ongeldig aantal rondes")?;
        if !race["activeRunnerId"].is_null()
            || !race["activeStartedAt"].is_null()
            || !may_merge(
                race["raceStartedAt"].as_i64(),
                race["raceFinishedAt"].as_i64(),
                lap_count,
            )
        {
            return Err("Lopers samenvoegen kan alleen voor de race.".into());
        }

        let rows = |key: &str, limit: usize| {
            input[key]
                .as_array()
                .filter(|rows| rows.len() <= limit && rows.iter().all(Value::is_object))
                .ok_or_else(|| format!("Ongeldige koppelgegevens: {key}"))
        };
        let incoming = rows("runners", 100_000)?;
        let labels = rows("labels", 10_000)?;
        let images = rows("labelImages", 10_000)?;
        let memberships = rows("runnerLabels", 1_000_000)?;
        fn field<'a>(row: &'a Value, field: &str) -> crate::db::Result<&'a str> {
            row[field]
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| format!("Ongeldig koppelveld: {field}"))
        }
        fn person(row: &Value) -> crate::db::Result<Person> {
            let profile: Value = row["registration_json"]
                .as_str()
                .and_then(|raw| serde_json::from_str(raw).ok())
                .unwrap_or_default();
            Ok(Person {
                id: field(row, "id")?.into(),
                name: field(row, "name")?.into(),
                email: profile["email"].as_str().unwrap_or("").into(),
                phone: profile["phone"].as_str().unwrap_or("").into(),
                number: row["runner_number"].as_str().map(str::to_owned),
            })
        }
        let local = self.rows(
            "SELECT id,name,runner_number,registration_json FROM runners ORDER BY created_at,id",
            &[],
        )?;
        let existing = local
            .iter()
            .map(person)
            .collect::<crate::db::Result<Vec<_>>>()?;
        let incoming_people = incoming
            .iter()
            .map(person)
            .collect::<crate::db::Result<Vec<_>>>()?;
        let source = incoming_people
            .iter()
            .zip(incoming)
            .map(|(person, row)| (person.id.as_str(), row))
            .collect::<HashMap<_, _>>();
        if source.len() != incoming.len() {
            return Err("Dubbele loper-ID in koppelgegevens".into());
        }

        let timestamp = json!(now());
        let mut added_labels = 0;
        let mut label_ids = HashMap::new();
        let mut source_images = HashMap::new();
        for row in images {
            source_images.insert(field(row, "id")?, row);
        }
        for row in labels {
            let source_id = field(row, "id")?;
            let name = field(row, "name")?.trim();
            if label_ids.contains_key(source_id) {
                return Err("Dubbele label-ID in koppelgegevens".into());
            }
            let matching = self.rows(
                "SELECT id FROM labels WHERE name=? COLLATE NOCASE",
                &[json!(crate::labels::canonical(name))],
            )?;
            let target = if let Some(label) = matching.first() {
                label["id"].clone()
            } else {
                if let Some(image) = row["image_url"]
                    .as_str()
                    .and_then(|url| url.strip_prefix("/api/label-images/"))
                    .and_then(|image_id| source_images.get(image_id))
                {
                    let mime = field(image, "mime")?;
                    if !["image/png", "image/webp"].contains(&mime) {
                        return Err("Ongeldig logo in koppelgegevens".into());
                    }
                    self.exec("INSERT OR IGNORE INTO label_images(id,mime,data_base64,created_at) VALUES(?,?,?,?)",
                        &[image["id"].clone(), json!(mime), json!(field(image,"data_base64")?), timestamp.clone()])?;
                }
                let target = if self
                    .rows("SELECT id FROM labels WHERE id=?", &[json!(source_id)])?
                    .is_empty()
                {
                    json!(source_id)
                } else {
                    json!(id())
                };
                self.exec("INSERT INTO labels(id,name,color,icon,kind,image_url,target_laps,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    &[target.clone(),json!(name),row["color"].clone(),row["icon"].clone(),row["kind"].clone(),row["image_url"].clone(),row["target_laps"].clone(),row["sort_order"].clone(),timestamp.clone(),timestamp.clone()])?;
                added_labels += 1;
                target
            };
            label_ids.insert(source_id, target);
        }

        let plan = plan_merge(&existing, &incoming_people);
        let mut runner_ids = HashMap::new();
        for (source_id, target) in &plan.matched {
            runner_ids.insert(source_id.as_str(), json!(target));
        }
        let mut occupied_ids = existing
            .iter()
            .map(|p| p.id.clone())
            .collect::<std::collections::HashSet<_>>();
        for (source_id, number) in &plan.add {
            let row = source[source_id.as_str()];
            let target = if occupied_ids.insert(source_id.clone()) {
                source_id.clone()
            } else {
                id()
            };
            self.exec("INSERT INTO runners(id,runner_number,name,target_laps,historical_avg_ms,historical_best_ms,registration_source,notes,registration_json,status,status_since,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'registered',?,?,?)",
                &[json!(target),json!(number),row["name"].clone(),row["target_laps"].clone(),row["historical_avg_ms"].clone(),row["historical_best_ms"].clone(),row["registration_source"].clone(),row["notes"].clone(),row["registration_json"].clone(),timestamp.clone(),row["created_at"].clone(),timestamp.clone()])?;
            runner_ids.insert(source_id.as_str(), json!(target));
        }
        for link in memberships {
            let runner = runner_ids
                .get(field(link, "runner_id")?)
                .ok_or("Onbekende loper in labelkoppeling")?;
            let label = label_ids
                .get(field(link, "label_id")?)
                .ok_or("Onbekend label in labelkoppeling")?;
            self.exec(
                "INSERT OR IGNORE INTO runner_labels(runner_id,label_id) VALUES(?,?)",
                &[runner.clone(), label.clone()],
            )?;
        }
        Ok(json!({"added":plan.add.len(),"same":plan.matched.len(),"labels":added_labels}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn person(id: &str, name: &str, email: &str, phone: &str, number: &str) -> Person {
        Person {
            id: id.into(),
            name: name.into(),
            email: email.into(),
            phone: phone.into(),
            number: Some(number.into()),
        }
    }
    #[test]
    fn matches_identity_once_and_keeps_people_with_colliding_numbers() {
        let existing = vec![person(
            "a",
            "Zoë  Jans",
            "ZOE@example.org",
            "+32 123-45",
            "7",
        )];
        let incoming = vec![
            person("b", " zoë jans ", "zoe@example.org", "+32.123 45", "7"),
            person("c", "Zoë Jans", "zoe@example.org", "+32 12345", "7"),
            person("d", "Other", "other@example.org", "123", "7"),
        ];
        assert_eq!(
            plan_merge(&existing, &incoming),
            MergePlan {
                matched: vec![("b".into(), "a".into())],
                add: vec![("c".into(), None), ("d".into(), None)]
            }
        );
    }
    #[test]
    fn merge_preserves_people_membership_and_queue_and_refuses_an_active_first_lap() {
        use crate::db::Db;
        use serde_json::json;
        let mut db = Db::open(std::path::Path::new(":memory:")).unwrap();
        let zoe = db
            .mutation(
                "runners.create",
                &json!({"name":"Zoë", "runnerNumber":"7", "status":"waiting"}),
            )
            .unwrap();
        let data = json!({
            "from": "Laptop B",
            "runners": [
                {"id":"duplicate", "name":" zoë ", "runner_number":"27", "registration_source":"manual", "created_at":1},
                {"id":"other", "name":"Jan", "runner_number":"7", "registration_source":"import", "created_at":1}
            ],
            "labels":[{"id":"remote","name":"Club","color":"#123456","icon":"CL","kind":"custom"}],
            "labelImages":[],
            "runnerLabels":[{"runner_id":"duplicate","label_id":"remote"},{"runner_id":"other","label_id":"remote"}]
        });
        let mut bad_data = data.clone();
        bad_data["runnerLabels"][1]["label_id"] = json!("missing");
        assert!(db.mutation("runners.merge", &bad_data).is_err());
        assert_eq!(db.runners().unwrap().len(), 1);
        assert!(
            !db.labels(None)
                .unwrap()
                .iter()
                .any(|label| label["name"] == "Club")
        );

        assert_eq!(
            db.mutation("runners.merge", &data).unwrap(),
            json!({"added":1,"same":1,"labels":1})
        );
        let local = db.runner(zoe["id"].as_str().unwrap()).unwrap();
        assert_eq!(local["runnerNumber"], "7");
        assert_eq!(local["status"], "waiting");
        assert_eq!(local["labels"][0]["name"], "Club");
        let added = db.runner("other").unwrap();
        assert!(added["runnerNumber"].is_null());
        assert_eq!(added["labels"][0]["name"], "Club");
        assert_eq!(
            db.mutation("runners.merge", &data).unwrap(),
            json!({"added":0,"same":2,"labels":0})
        );

        db.mutation(
            "race.handoff",
            &json!({"activeRunnerId":null,"activeStartedAt":null}),
        )
        .unwrap();
        assert!(db.history().unwrap()["laps"].as_array().unwrap().is_empty());
        assert!(db.mutation("runners.merge", &data).is_err());
    }

    #[test]
    fn an_active_first_lap_is_not_a_prerace_database() {
        assert!(may_merge(None, None, 0));
        assert!(!may_merge(Some(123), None, 0));
        assert!(!may_merge(Some(123), Some(456), 0));
        assert!(!may_merge(None, None, 1));
    }
}
