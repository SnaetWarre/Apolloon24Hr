//! Human-readable audit entries are committed atomically with the changes they describe.
use crate::db::Db;
use chrono::{Datelike, Timelike};
use serde_json::{Value, json};
fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn runner_text(r: &Value) -> String {
    if s(&r["name"]).is_empty() {
        return "Loper".into();
    }
    if !s(&r["runnerNumber"]).is_empty() {
        format!("#{} {}", s(&r["runnerNumber"]), s(&r["name"]))
    } else {
        s(&r["name"]).into()
    }
}
fn runner(db: &Db, id: &str) -> String {
    if id.is_empty() {
        return "Loper".into();
    }
    db.one(
        "SELECT name,runner_number AS runnerNumber FROM runners WHERE id=?",
        &[json!(id)],
    )
    .map(|r| runner_text(&r))
    .unwrap_or_else(|_| "Loper".into())
}
fn moment(ms: i64) -> String {
    let Some(d) = chrono::DateTime::from_timestamp_millis(ms) else {
        return String::new();
    };
    let d = d.with_timezone(&chrono_tz::Europe::Brussels);
    format!(
        "{} {:02}:{:02}",
        ["ma", "di", "wo", "do", "vr", "za", "zo"][d.weekday().num_days_from_monday() as usize],
        d.hour(),
        d.minute()
    )
}
fn lap(db: &Db, id: &str) -> String {
    let Ok(l)=db.one("SELECT l.lap_number,l.duration_ms,l.finished_at,r.name,r.runner_number AS runnerNumber FROM laps l JOIN runners r ON r.id=l.runner_id WHERE l.id=?",&[json!(id)]) else{return "Ronde".into();};
    let time = l["duration_ms"].as_i64().unwrap_or(0).max(0);
    format!(
        "Ronde {} van {} ({}:{:02}.{:03}, {})",
        l["lap_number"],
        runner_text(&l),
        time / 60000,
        time / 1000 % 60,
        time % 1000,
        moment(l["finished_at"].as_i64().unwrap_or(0))
    )
}
fn profile(db: &Db, id: &str) -> Vec<(&'static str, Value)> {
    let Ok(r) = db.runner(id) else {
        return Vec::new();
    };
    let p = db.registrations().unwrap_or(Value::Null);
    let p = &p[id];
    let mut labels = r["labels"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|l| s(&l["id"]).to_owned())
        .collect::<Vec<_>>();
    labels.sort();
    vec![
        ("naam", r["name"].clone()),
        ("nummer", r["runnerNumber"].clone()),
        ("doel", r["targetLaps"].clone()),
        ("gemiddelde", r["historicalAvgMs"].clone()),
        ("beste tijd", r["historicalBestMs"].clone()),
        ("notities", r["notes"].clone()),
        ("telefoon", json!(s(&p["phone"]))),
        ("e-mail", json!(s(&p["email"]))),
        (
            "uren",
            p["availableHours"]
                .as_array()
                .map(|v| json!(v))
                .unwrap_or(json!([])),
        ),
        ("labels", json!(labels)),
    ]
}
pub struct Prepared {
    method: String,
    input: Value,
    runner: String,
    label: String,
    lap: String,
    profile: Vec<(&'static str, Value)>,
    race: Value,
    undo_laps: Vec<String>,
    newest_event: Value,
    lap_runner: String,
    competition: String,
}
impl Prepared {
    pub fn new(db: &Db, method: &str, input: &Value) -> Self {
        let id = input["id"]
            .as_str()
            .or(input["labelId"].as_str())
            .unwrap_or("");
        let race = if method.starts_with("race.") {
            db.race().unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        let mut undo_laps = Vec::new();
        if method == "race.undoLastHandoff" {
            if let Ok(entry)=db.one("SELECT payload_json FROM handoff_history WHERE undone=0 ORDER BY created_at DESC,rowid DESC LIMIT 1",&[]) {
                if let Ok(payload)=serde_json::from_str::<Value>(s(&entry["payload_json"])) {for id in payload["lapIds"].as_array().into_iter().flatten(){if !db.rows("SELECT id FROM laps WHERE id=?",&[id.clone()]).unwrap_or_default().is_empty(){undo_laps.push(lap(db,s(id)));}}}
            }
        }
        let title = input["labelIds"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|id| {
                db.label(s(id))
                    .ok()
                    .map(|l| s(&l["name"]).to_owned())
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>()
            .join(" vs ");
        Self {
            method: method.into(),
            input: input.clone(),
            runner: runner(
                db,
                if method.starts_with("labels.") {
                    s(&input["runnerId"])
                } else {
                    id
                },
            ),
            label: db
                .label(id)
                .ok()
                .map(|l| s(&l["name"]).to_owned())
                .unwrap_or_default(),
            lap: if method.starts_with("laps.") {
                lap(db, s(&input["lapId"]))
            } else {
                String::new()
            },
            lap_runner: if method == "laps.split" {
                db.one(
                    "SELECT runner_id FROM laps WHERE id=?",
                    &[input["lapId"].clone()],
                )
                .ok()
                .map(|l| s(&l["runner_id"]).to_owned())
                .unwrap_or_default()
            } else {
                String::new()
            },
            profile: if method == "runners.update" {
                profile(db, id)
            } else {
                Vec::new()
            },
            race,
            undo_laps,
            newest_event: if method == "events.burgieGepakt" {
                db.rows(
                    "SELECT id FROM race_events ORDER BY occurred_at DESC LIMIT 1",
                    &[],
                )
                .ok()
                .and_then(|v| v.first().map(|v| v["id"].clone()))
                .unwrap_or(Value::Null)
            } else {
                Value::Null
            },
            competition: title,
        }
    }
    pub fn summary(self, db: &Db, result: &Value) -> Option<String> {
        let v = &self.input;
        let runner = self.runner;
        let label = self.label;
        let lap = self.lap;
        Some(match self.method.as_str() {
            "race.handoff" => return None,
            "race.startNext" => if self.race["raceStartedAt"].is_null() {
                "Wedstrijd gestart"
            } else {
                "Volgende loper gestart"
            }
            .into(),
            "race.finish" => "Wedstrijd beëindigd".into(),
            "race.undoLastHandoff" => {
                if !self.race["raceFinishedAt"].is_null() {
                    "Wedstrijd heropend (beëindigen ongedaan gemaakt)".into()
                } else if self.undo_laps.is_empty() {
                    "Laatste wissel ongedaan gemaakt".into()
                } else {
                    format!(
                        "Laatste wissel ongedaan gemaakt ({} verwijderd)",
                        self.undo_laps.join(" en ")
                    )
                }
            }
            "race.clear" => {
                if v["runners"] == true {
                    format!(
                        "Alles gewist: race en lopers ({} rondes, {} lopers)",
                        result["laps"], result["runners"]
                    )
                } else {
                    format!("Race gewist na de testrun ({} rondes)", result["laps"])
                }
            }
            "laps.move" => format!(
                "{lap} naar {} verplaatst",
                crate::activity::runner(db, s(&v["runnerId"]))
            ),
            "laps.split" => {
                let second = crate::activity::runner(db, s(&v["runnerId"]));
                let original = self.lap_runner == s(&v["runnerId"]);
                if original {
                    format!("{lap} gesplitst in twee rondes van {second}")
                } else {
                    format!("{lap} gesplitst: de tweede helft is voor {second}")
                }
            }
            "laps.moveHandoff" => {
                let shift = v["to"].as_i64().unwrap_or(0) - v["from"].as_i64().unwrap_or(0);
                let seconds = format!("{:.3}", shift.abs() as f64 / 1000.0)
                    .trim_end_matches('0')
                    .trim_end_matches('.')
                    .replace('.', ",");
                format!(
                    "{lap}: wissel {seconds} s {} gezet",
                    if shift < 0 { "vroeger" } else { "later" }
                )
            }
            "laps.delete" => format!("{lap} verwijderd"),
            "events.burgieGepakt" => {
                if !self.newest_event.is_null() && result["id"] == self.newest_event {
                    "Burgie gepakt opnieuw gedrukt, telt één keer"
                } else {
                    "Burgie gepakt"
                }
                .into()
            }
            "runners.merge" => {
                let same = result["same"].as_u64().unwrap_or(0);
                let labels = result["labels"].as_u64().unwrap_or(0);
                let added_labels = match labels {
                    0 => String::new(),
                    1 => ", 1 nieuw label".into(),
                    _ => format!(", {labels} nieuwe labels"),
                };
                let verb = if same == 1 { "stond" } else { "stonden" };
                format!(
                    "Lopers van {} samengevoegd bij het koppelen: {} nieuw, {same} {verb} er al{added_labels}",
                    s(&v["from"]), result["added"]
                )
            }
            "runners.create" => format!("{} toegevoegd", runner_text(result)),
            "runners.update" => {
                let after = profile(db, s(&v["id"]));
                let changes = self
                    .profile
                    .into_iter()
                    .filter(|(key, value)| after.iter().any(|(k, v)| k == key && v != value))
                    .map(|(k, _)| k)
                    .collect::<Vec<_>>();
                format!(
                    "{runner} aangepast ({})",
                    if changes.is_empty() {
                        "niets gewijzigd".into()
                    } else {
                        changes.join(", ")
                    }
                )
            }
            "runners.delete" => format!("{runner} verwijderd"),
            "runners.setStatus" => format!(
                "{runner}: {}",
                match s(&v["status"]) {
                    "registered" => "terug naar ingeschreven",
                    "warming_up" => "naar opwarming",
                    "waiting" => "naar de wachtrij",
                    "running" => "op de piste",
                    "ran" => "heeft gelopen",
                    other => other,
                }
            ),
            "runners.reorder" => "Wachtrij herschikt".into(),
            "runners.hide" => format!("{runner} verborgen in de wachtrij"),
            "runners.unhide" => format!("{runner} terug zichtbaar in de wachtrij"),
            "runners.importCsv" | "runners.importXlsx" => format!(
                "Inschrijvingen geïmporteerd: {} nieuw, {} bijgewerkt",
                result["created"], result["updated"]
            ),
            "labels.create" => format!("Label {} toegevoegd", s(&v["name"])),
            "labels.update" => {
                let names = v["fields"]
                    .as_object()
                    .into_iter()
                    .flat_map(|v| v.keys())
                    .map(|key| match key.as_str() {
                        "name" => "naam",
                        "color" => "kleur",
                        "icon" => "icoon",
                        "kind" => "soort",
                        "imageUrl" => "logo",
                        "sortOrder" => "volgorde",
                        other => other,
                    })
                    .collect::<Vec<_>>();
                format!(
                    "Label {label} aangepast ({})",
                    if names.is_empty() {
                        "niets".into()
                    } else {
                        names.join(", ")
                    }
                )
            }
            "labels.delete" => format!("Label {label} verwijderd"),
            "labels.addRunner" => format!("{runner} toegevoegd aan label {label}"),
            "labels.removeRunner" => format!("{runner} uit label {label} gehaald"),
            "labels.uploadImage" | "labels.uploadFile" => "Logo opgeladen".into(),
            "settings.updatePublicRecordMode" => format!(
                "Records op de publieke schermen: {}",
                match s(&v["publicRecordMode"]) {
                    "off" => "uit",
                    "day" => "per dag",
                    "two_hour" => "per 2 uur",
                    "hour" => "per uur",
                    _ => "",
                }
            ),
            "settings.addCompetition" => format!(
                "Competitie {} op het Competitiescherm gezet",
                self.competition
            ),
            "settings.removeCompetition" => format!(
                "Competitie {} van het Competitiescherm gehaald",
                self.competition
            ),
            "backups.applyRestore" => format!(
                "Backup{} teruggezet ({} lopers, {} rondes)",
                v["backupCreatedAt"]
                    .as_i64()
                    .map(|t| format!(" van {}", moment(t)))
                    .unwrap_or_default(),
                result["runners"],
                result["laps"]
            ),
            other => other.into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn audit_describes_real_profile_changes_and_leaves_handoffs_in_lap_history() {
        let mut db = Db::open(std::path::Path::new(":memory:")).unwrap();
        let r = db
            .mutation(
                "runners.create",
                &json!({"name":"Zoë","runnerNumber":"17","status":"waiting"}),
            )
            .unwrap();
        assert_eq!(
            db.activity(&json!({})).unwrap()[0]["summary"],
            "#17 Zoë toegevoegd"
        );
        db.mutation("runners.update",&json!({"id":r["id"],"fields":{"name":"Zoë","notes":"changed","registrationDetails":{"phone":"0471"}}})).unwrap();
        assert!(
            db.activity(&json!({}))
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v["summary"] == "#17 Zoë aangepast (notities, telefoon)")
        );
        db.mutation(
            "race.handoff",
            &json!({"activeRunnerId":null,"activeStartedAt":null}),
        )
        .unwrap();
        assert_eq!(
            db.activity(&json!({})).unwrap().as_array().unwrap().len(),
            2
        );
        assert!(
            db.mutation(
                "runners.update",
                &json!({"id":r["id"],"fields":{"name":""}})
            )
            .is_err()
        );
        assert_eq!(
            db.activity(&json!({})).unwrap().as_array().unwrap().len(),
            2
        );
    }
}
