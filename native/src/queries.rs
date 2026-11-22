//! Read contracts shared by the native operator UI and LAN clients.
use crate::db::{Db, Result, parse_labels};
use serde_json::{Value, json};
const HISTORY_LAPS: &str =
    "SELECT l.id,l.runner_id AS runnerId,r.runner_number AS runnerNumber,r.name AS runnerName,
    l.lap_number AS lapNumber,l.started_at AS startedAt,l.finished_at AS finishedAt,
    l.duration_ms AS durationMs,l.source,l.created_at AS createdAt,l.labels_json AS labels
    FROM laps l JOIN runners r ON r.id=l.runner_id";
const HISTORY_EVENTS: &str = "SELECT id,type,message,occurred_at AS occurredAt,runner_id AS runnerId,
    runner_number AS runnerNumber,runner_name AS runnerName,created_at AS createdAt FROM race_events";
impl Db {
    pub fn history(&self) -> Result<Value> {
        self.history_scope("full", None, 0)
    }

    pub fn history_scope(&self, scope: &str, runner: Option<&str>, limit: usize) -> Result<Value> {
        let mut args = Vec::new();
        let (filter, limit_sql, runner_id, reported_limit) = match scope {
            "full" => ("", "", None, None),
            "recent" => {
                let limit = limit.clamp(1, 1000);
                args.push(json!(limit));
                ("", " LIMIT ?", None, Some(limit))
            }
            "runner" => {
                let id = runner
                    .filter(|id| !id.is_empty())
                    .ok_or("Loper ontbreekt")?;
                args.push(json!(id));
                if limit == 0 { (" WHERE l.runner_id=?", "", Some(id), None) } else {
                let limit = limit.clamp(1, 1000);
                args.push(json!(limit));
                (" WHERE l.runner_id=?", " LIMIT ?", Some(id), Some(limit))
                }
            }
            _ => return Err("Onbekende geschiedenisselectie".into()),
        };
        let mut laps = self.rows(
            &format!(
                "{HISTORY_LAPS}{filter}
             ORDER BY l.finished_at DESC,l.rowid DESC{limit_sql}"
            ),
            &args,
        )?;
        for lap in &mut laps {
            lap["labels"] = parse_labels(&lap["labels"]);
        }
        let events = if runner_id.is_some() {
            Vec::new()
        } else {
            self.rows(
                &format!("{HISTORY_EVENTS} ORDER BY occurred_at DESC,rowid DESC LIMIT ?"),
                &[json!(
                    reported_limit.map(|n| n.min(100) as i64).unwrap_or(-1)
                )],
            )?
        };
        Ok(
            json!({"scope":scope,"runnerId":runner_id,"limit":reported_limit,"laps":laps,"events":events,"revision":self.revision}),
        )
    }
    pub(crate) fn history_rows(
        &self,
        table: &str,
        rowids: &std::collections::BTreeSet<i64>,
    ) -> Result<Vec<Value>> {
        let (select, rowid) = match table {
            "laps" => (HISTORY_LAPS, "l.rowid"),
            "race_events" => (HISTORY_EVENTS, "rowid"),
            "runners" => (
                "SELECT id,name,runner_number AS runnerNumber FROM runners",
                "rowid",
            ),
            _ => return Err("Onbekende geschiedenistabel".into()),
        };
        let select = select.replacen("SELECT ", &format!("SELECT {rowid} AS _rowid,"), 1);
        let ids: Vec<_> = rowids.iter().map(|id| json!(id)).collect();
        let mut result = Vec::new();
        for chunk in ids.chunks(500) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let mut rows = self.rows(
                &format!("{select} WHERE {rowid} IN ({placeholders})"),
                chunk,
            )?;
            if table == "laps" {
                for row in &mut rows {
                    row["labels"] = parse_labels(&row["labels"]);
                }
            }
            result.extend(rows);
        }
        Ok(result)
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
