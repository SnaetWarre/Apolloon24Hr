//! Administrative mutations run inside Db::mutation's transaction.
use crate::db::{Db, Result, id, now, required};
use serde_json::{Value, json};
impl Db {
    pub fn settings(&self) -> Result<Value> {
        let mode = self
            .rows(
                "SELECT value FROM settings WHERE key='public_record_mode'",
                &[],
            )?
            .first()
            .map(|r| r["value"].clone())
            .unwrap_or(json!("day"));
        let mode = if ["off", "day", "two_hour", "hour"].contains(&mode.as_str().unwrap_or("")) {
            mode
        } else {
            json!("day")
        };
        let competitions = self.competitions()?;
        Ok(json!({"publicRecordMode":mode,"competitions":competitions}))
    }
    pub fn manage(&self, method: &str, input: &Value) -> Result<Value> {
        match method {
            "settings.addCompetition" | "settings.removeCompetition" => {
                self.competition_mutation(method, input)
            }
            "laps.moveHandoff" => self.shift_handoff(input),
            "runners.update" => {
                let runner = required(input, "id")?;
                self.one("SELECT id FROM runners WHERE id=?", &[json!(runner)])?;
                let fields = input["fields"].as_object().ok_or("Velden ontbreken")?;
                for (key, column) in [
                    ("name", "name"),
                    ("runnerNumber", "runner_number"),
                    ("notes", "notes"),
                    ("registrationSource", "registration_source"),
                    ("targetLaps", "target_laps"),
                    ("historicalAvgMs", "historical_avg_ms"),
                    ("historicalBestMs", "historical_best_ms"),
                ] {
                    if let Some(value) = fields.get(key) {
                        if key == "registrationSource"
                            && ![Some("manual"), Some("import")].contains(&value.as_str())
                        {
                            return Err("Ongeldige inschrijvingsbron".into());
                        }
                        if key == "name" && value.as_str().is_none_or(|v| v.trim().is_empty()) {
                            return Err("Naam is verplicht".into());
                        }
                        if ["targetLaps", "historicalAvgMs", "historicalBestMs"].contains(&key)
                            && !value.is_null()
                            && value.as_u64().is_none()
                        {
                            return Err("Een positief geheel getal is vereist".into());
                        }
                        self.exec(
                            &format!("UPDATE runners SET {column}=?,updated_at=? WHERE id=?"),
                            &[value.clone(), json!(now()), json!(runner)],
                        )?;
                    }
                }
                if let Some(labels) = fields.get("labels") {
                    self.set_labels(runner, labels)?;
                }
                self.update_registration(runner, &input["fields"])?;
                if fields.contains_key("status") {
                    return Err("Verplaats lopers via de wachtrij".into());
                }
                self.runner(runner)
            }
            m if m.starts_with("labels.") => self.label_mutation(method, input),
            "settings.updatePublicRecordMode" => {
                let mode = required(input, "publicRecordMode")?;
                if !["off", "day", "two_hour", "hour"].contains(&mode) {
                    return Err("Ongeldige recordmodus".into());
                }
                self.exec(
                    "INSERT OR REPLACE INTO settings(key,value) VALUES('public_record_mode',?)",
                    &[json!(mode)],
                )?;
                self.settings()
            }
            "laps.move" | "laps.split" | "laps.delete" => self.correct_lap(method, input),
            "events.burgieGepakt" => {
                let time = now();
                let recent=self.rows("SELECT id,type,message,occurred_at AS occurredAt,runner_id AS runnerId,runner_number AS runnerNumber,runner_name AS runnerName FROM race_events WHERE type='burgie_gepakt' AND occurred_at>? ORDER BY occurred_at DESC LIMIT 1",&[json!(time-5000)])?;
                if let Some(event) = recent.first() {
                    return Ok(event.clone());
                }
                let race = self.race()?;
                let runner = self
                    .rows(
                        "SELECT id,name,runner_number AS number FROM runners WHERE id=?",
                        &[race["activeRunnerId"].clone()],
                    )?
                    .into_iter()
                    .next()
                    .unwrap_or(Value::Null);
                let event = id();
                self.exec("INSERT INTO race_events(id,type,message,occurred_at,runner_id,runner_number,runner_name,created_at) VALUES(?,'burgie_gepakt','Burgie gepakt',?,?,?,?,?)",&[json!(event),json!(time),runner["id"].clone(),runner["number"].clone(),runner["name"].clone(),json!(time)])?;
                Ok(json!({"id":event,"type":"burgie_gepakt","message":"Burgie gepakt","occurredAt":time,"runnerId":runner["id"],"runnerNumber":runner["number"],"runnerName":runner["name"]}))
            }
            _ => Err(format!("Nog niet gemigreerde actie: {method}")),
        }
    }
    pub fn set_labels(&self, runner: &str, labels: &Value) -> Result<()> {
        let values = labels.as_array().ok_or("Labels moeten een lijst zijn")?;
        self.exec(
            "DELETE FROM runner_labels WHERE runner_id=?",
            &[json!(runner)],
        )?;
        for value in values {
            let name = value
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .ok_or("Ongeldig label")?;
            let found = self.rows(
                "SELECT id FROM labels WHERE id=? OR name=? COLLATE NOCASE",
                &[json!(name), json!(crate::labels::canonical(name))],
            )?;
            let label = if let Some(label) = found.first() {
                label["id"].clone()
            } else {
                if uuid::Uuid::parse_str(name).is_ok() {
                    continue;
                }
                self.manage(
                    "labels.create",
                    &json!({"name":crate::labels::canonical(name)}),
                )?["id"]
                    .clone()
            };
            self.exec(
                "INSERT OR IGNORE INTO runner_labels(runner_id,label_id) VALUES(?,?)",
                &[json!(runner), label],
            )?;
        }
        Ok(())
    }
    fn renumber(&self, runner: &Value) -> Result<()> {
        self.exec("UPDATE laps SET lap_number=(SELECT COUNT(*) FROM laps earlier WHERE earlier.runner_id=laps.runner_id AND (earlier.started_at<laps.started_at OR (earlier.started_at=laps.started_at AND earlier.id<=laps.id))) WHERE runner_id=?",std::slice::from_ref(runner))?;
        Ok(())
    }
    fn correct_lap(&self, method: &str, input: &Value) -> Result<Value> {
        let lap_id = required(input, "lapId")?;
        let lap=self.one("SELECT id,runner_id,started_at,finished_at,duration_ms,created_at,labels_json FROM laps WHERE id=?",&[json!(lap_id)])?;
        if method == "laps.delete" {
            self.exec("DELETE FROM laps WHERE id=?", &[json!(lap_id)])?;
            self.renumber(&lap["runner_id"])?;
            return Ok(json!({"ok":true}));
        }
        let runner = required(input, "runnerId")?;
        self.one("SELECT id FROM runners WHERE id=?", &[json!(runner)])?;
        let labels = if lap["runner_id"] == runner {
            lap["labels_json"].clone()
        } else {
            json!(crate::db::historical_labels(&json!(
                self.labels(Some(runner))?
            )))
        };
        if method == "laps.move" {
            if lap["runner_id"] == runner {
                return Err("Deze ronde staat al op die loper".into());
            }
            self.exec(
                "UPDATE laps SET runner_id=?,labels_json=? WHERE id=?",
                &[json!(runner), labels, json!(lap_id)],
            )?;
        } else {
            let duration = lap["duration_ms"].as_i64().ok_or("Ongeldige rondetijd")?;
            if duration < 2 {
                return Err("Ronde is te kort om te splitsen".into());
            }
            let first = (duration + 1) / 2;
            let middle = lap["started_at"].as_i64().unwrap_or(0) + first;
            let second = id();
            self.exec(
                "UPDATE laps SET finished_at=?,duration_ms=?,source='split' WHERE id=?",
                &[json!(middle), json!(first), json!(lap_id)],
            )?;
            self.exec("INSERT INTO laps(id,runner_id,lap_number,started_at,finished_at,duration_ms,source,created_at,labels_json) VALUES(?,?,0,?,?,?,'split',?,?)",&[json!(second),json!(runner),json!(middle),lap["finished_at"].clone(),json!(duration-first),lap["created_at"].clone(),labels])?;
            for handoff in self.rows(
                "SELECT id,payload_json FROM handoff_history WHERE undone=0",
                &[],
            )? {
                let mut payload: Value =
                    serde_json::from_str(handoff["payload_json"].as_str().ok_or("Ongeldige undo")?)
                        .map_err(|e| e.to_string())?;
                if let Some(ids) = payload["lapIds"].as_array_mut()
                    && ids.contains(&json!(lap_id))
                {
                    ids.push(json!(second));
                    self.exec(
                        "UPDATE handoff_history SET payload_json=? WHERE id=?",
                        &[json!(payload.to_string()), handoff["id"].clone()],
                    )?;
                }
            }
        }
        self.renumber(&lap["runner_id"])?;
        self.renumber(&json!(runner))?;
        Ok(json!({"ok":true}))
    }
}
