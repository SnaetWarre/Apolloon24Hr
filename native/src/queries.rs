//! Read contracts shared by the native operator UI and LAN clients.
use crate::db::{Db, Result};
use serde_json::{Value, json};
impl Db {
    pub fn history_scope(&self, scope: &str, runner: Option<&str>, limit: usize) -> Result<Value> {
        let mut history = self.history()?;
        match scope {
            "full" => {}
            "recent" => {
                let limit = limit.clamp(1, 1000);
                history["laps"].as_array_mut().unwrap().truncate(limit);
                history["events"]
                    .as_array_mut()
                    .unwrap()
                    .truncate(limit.min(100));
                history["limit"] = json!(limit);
            }
            "runner" => {
                let runner = runner
                    .filter(|id| !id.is_empty())
                    .ok_or("Loper ontbreekt")?;
                history["laps"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|lap| lap["runnerId"] == runner);
                history["events"] = json!([]);
                history["runnerId"] = json!(runner);
            }
            _ => return Err("Onbekende geschiedenisselectie".into()),
        }
        history["scope"] = json!(scope);
        Ok(history)
    }
    pub fn registrations(&self) -> Result<Value> {
        let mut output = serde_json::Map::new();
        for row in self.rows(
            "SELECT id,registration_json FROM runners WHERE registration_json IS NOT NULL",
            &[],
        )? {
            let Some(raw) = row["registration_json"].as_str() else {
                continue;
            };
            let Ok(mut registration) = serde_json::from_str::<Value>(raw) else {
                continue;
            };
            if !registration.is_object() {
                continue;
            }
            let string_fields = [
                "submittedAt",
                "email",
                "phone",
                "studyPhase",
                "estimatedLaps",
                "estimatedPace",
                "maxLapsPerBlock",
                "reuseConsent",
                "flexibility",
                "remarks",
            ];
            if string_fields
                .iter()
                .any(|key| !registration[key].is_string())
                || ["availableHours", "categories"].iter().any(|key| {
                    registration[key]
                        .as_array()
                        .is_none_or(|v| v.iter().any(|s| !s.is_string()))
                })
            {
                continue;
            }
            if registration.get("fastestLap").is_none() {
                registration["fastestLap"] = json!("");
            }
            if !registration["fastestLap"].is_string() {
                continue;
            }
            output.insert(row["id"].as_str().unwrap().into(), registration);
        }
        Ok(Value::Object(output))
    }
    pub fn activity(&self, input: &Value) -> Result<Value> {
        use unicode_normalization::UnicodeNormalization;
        let fold = |text: &str| {
            text.nfd()
                .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
                .collect::<String>()
                .to_lowercase()
        };
        let needle = fold(input["search"].as_str().unwrap_or("").trim());
        let limit = input["limit"].as_u64().unwrap_or(200).clamp(1, 500) as usize;
        let before = &input["before"];
        let mut rows=self.rows("SELECT id,occurred_at AS occurredAt,action,summary,origin FROM activity_log WHERE (occurred_at,id)<(?,?) AND (? OR action NOT IN ('runners.setStatus','runners.reorder')) ORDER BY occurred_at DESC,id DESC",&[json!(before["occurredAt"].as_i64().unwrap_or(9_007_199_254_740_991)),json!(before["id"].as_str().unwrap_or("")),json!(input["queueMoves"].as_bool().unwrap_or(true))])?;
        rows.retain(|r| {
            needle.is_empty()
                || fold(r["summary"].as_str().unwrap_or("")).contains(&needle)
                || fold(r["origin"].as_str().unwrap_or("")).contains(&needle)
        });
        rows.truncate(limit);
        Ok(json!(rows))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn activity_cursor_keeps_rows_with_the_same_timestamp_and_filters_before_limit() {
        let db = Db::open(std::path::Path::new(":memory:")).unwrap();
        for (id, action, summary) in [
            ("a", "runners.update", "Zoë gewijzigd"),
            ("b", "runners.setStatus", "Zoë klaar"),
            ("c", "runners.update", "Céline gewijzigd"),
        ] {
            db.exec(
                "INSERT INTO activity_log VALUES(?,1000,?,?, 'Timing')",
                &[json!(id), json!(action), json!(summary)],
            )
            .unwrap();
        }
        let first = db.activity(&json!({"limit":1})).unwrap();
        assert_eq!(first[0]["id"], "c");
        let next = db
            .activity(&json!({"limit":2,"before":{"occurredAt":1000,"id":"c"}}))
            .unwrap();
        assert_eq!(next[0]["id"], "b");
        assert_eq!(next[1]["id"], "a");
        let zoe = db
            .activity(&json!({"limit":1,"queueMoves":false,"search":"ZOE"}))
            .unwrap();
        assert_eq!(zoe[0]["id"], "a");
    }
    #[test]
    fn malformed_historical_labels_are_ignored_and_missing_fields_are_expanded() {
        let labels = crate::db::parse_labels(&json!(
            r##"[null,{}, {"id":"x","name":"Team","color":"#fff","icon":"T","kind":"group"}]"##
        ));
        assert_eq!(labels.as_array().unwrap().len(), 1);
        assert!(labels[0]["imageUrl"].is_null());
        assert!(labels[0]["targetLaps"].is_null());
        assert!(labels[0]["sortOrder"].is_null());
        assert_eq!(crate::db::parse_labels(&json!("damaged JSON")), json!([]));
    }
}
