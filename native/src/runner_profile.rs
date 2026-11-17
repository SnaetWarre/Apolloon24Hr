//! Runner profiles use the same stored registration shape as the existing database.
use crate::db::{Db, Result, id, now, required};
use serde_json::{Value, json};
fn registration(base: &Value, details: &Value) -> Result<Value> {
    let mut value = if base.is_null() {
        json!({"submittedAt":"","email":"","phone":"","studyPhase":"","estimatedLaps":"","estimatedPace":"","maxLapsPerBlock":"","availableHours":[],"reuseConsent":"","flexibility":"","remarks":"","categories":[],"fastestLap":""})
    } else {
        base.clone()
    };
    if !value.is_object() {
        return Err("Ongeldige inschrijving".into());
    }
    if !details.is_null() {
        let details = details.as_object().ok_or("Ongeldige contactgegevens")?;
        for (key, max) in [("email", 320), ("phone", 100)] {
            if let Some(v) = details.get(key) {
                let s = v.as_str().ok_or("Ongeldige contactgegevens")?.trim();
                if s.len() > max {
                    return Err("Contactgegevens zijn te lang".into());
                }
                value[key] = json!(s);
            }
        }
        if let Some(hours) = details.get("availableHours") {
            let hours = hours
                .as_array()
                .filter(|h| h.len() <= 200)
                .ok_or("Ongeldige beschikbaarheid")?;
            let mut unique = Vec::new();
            for hour in hours {
                let hour = hour
                    .as_str()
                    .filter(|s| !s.trim().is_empty() && s.len() <= 100)
                    .ok_or("Ongeldig uur")?
                    .trim();
                if !unique.contains(&json!(hour)) {
                    unique.push(json!(hour));
                }
            }
            value["availableHours"] = json!(unique);
        }
    }
    for key in [
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
    ] {
        if !value[key].is_string() {
            return Err(format!("Ongeldig inschrijvingsveld: {key}"));
        }
    }
    for key in ["availableHours", "categories"] {
        if value[key]
            .as_array()
            .is_none_or(|a| a.iter().any(|v| !v.is_string()))
        {
            return Err(format!("Ongeldig inschrijvingsveld: {key}"));
        }
    }
    if value.get("fastestLap").is_none() {
        value["fastestLap"] = json!("");
    }
    if !value["fastestLap"].is_string() {
        return Err("Ongeldige snelste ronde".into());
    }
    let has_answers = value.as_object().unwrap().values().any(|v| {
        v.as_str().is_some_and(|s| !s.trim().is_empty())
            || v.as_array().is_some_and(|a| !a.is_empty())
    });
    Ok(if has_answers {
        json!(value.to_string())
    } else {
        Value::Null
    })
}
impl Db {
    pub fn runner(&self, id: &str) -> Result<Value> {
        self.runners()?
            .into_iter()
            .find(|r| r["id"] == id)
            .ok_or("Loper niet gevonden".into())
    }
    pub fn create_runner(&self, input: &Value) -> Result<Value> {
        let name = required(input, "name")?.trim();
        if name.is_empty() {
            return Err("Naam is verplicht".into());
        }
        let status = input["status"].as_str().unwrap_or("registered");
        if !["registered", "warming_up", "waiting"].contains(&status) {
            return Err("Start een nieuwe loper via het timingscherm".into());
        }
        let source = input["registrationSource"].as_str().unwrap_or("manual");
        if !["manual", "import"].contains(&source) {
            return Err("Ongeldige inschrijvingsbron".into());
        }
        for key in ["targetLaps", "historicalAvgMs", "historicalBestMs"] {
            if !input[key].is_null() && input[key].as_u64().is_none() {
                return Err("Een positief geheel getal is vereist".into());
            }
        }
        let number = match input.get("runnerNumber") {
            Some(v) if !v.is_null() => {
                let s = v.as_str().ok_or("Ongeldig lopersnummer")?.trim();
                if s.is_empty() { Value::Null } else { json!(s) }
            }
            _ => Value::Null,
        };
        let runner = input["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(id);
        let time = now();
        let registration = registration(&input["registration"], &input["registrationDetails"])?;
        self.exec("INSERT INTO runners(id,runner_number,name,target_laps,historical_avg_ms,historical_best_ms,registration_source,notes,registration_json,status,queue_index,status_since,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,CASE WHEN ?='waiting' THEN (SELECT COALESCE(MAX(queue_index),-1)+1 FROM runners WHERE status='waiting') ELSE NULL END,?,?,?)",&[json!(runner),number,json!(name),input["targetLaps"].clone(),input["historicalAvgMs"].clone(),input["historicalBestMs"].clone(),json!(source),json!(input["notes"].as_str().unwrap_or("").trim()),registration,json!(status),json!(status),json!(input["statusSince"].as_i64().unwrap_or(time)),json!(time),json!(time)])?;
        self.set_labels(&runner, input.get("labels").unwrap_or(&json!([])))?;
        self.runner(&runner)
    }
    pub fn update_registration(&self, runner: &str, input: &Value) -> Result<()> {
        if input.get("registration").is_none() && input.get("registrationDetails").is_none() {
            return Ok(());
        }
        let current = self.one(
            "SELECT registration_json FROM runners WHERE id=?",
            &[json!(runner)],
        )?;
        let base = if let Some(value) = input.get("registration") {
            value.clone()
        } else {
            current["registration_json"]
                .as_str()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or(Value::Null)
        };
        let next = registration(&base, &input["registrationDetails"])?;
        self.exec(
            "UPDATE runners SET registration_json=?,updated_at=? WHERE id=?",
            &[next, json!(now()), json!(runner)],
        )?;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn profile_contact_edits_preserve_answers_and_deduplicate_hours() {
        let mut db = Db::open(std::path::Path::new(":memory:")).unwrap();
        let runner=db.mutation("runners.create",&json!({"name":"  Zoë  ","runnerNumber":" 17 ","historicalBestMs":65000,"labels":["Dames"],"registrationDetails":{"email":" zoe@example.test ","availableHours":["20-21u","20-21u"]}})).unwrap();
        assert_eq!(runner["name"], "Zoë");
        assert_eq!(runner["runnerNumber"], "17");
        assert_eq!(runner["historicalBestMs"], 65000);
        assert_eq!(runner["labels"].as_array().unwrap().len(), 1);
        db.mutation(
            "runners.update",
            &json!({"id":runner["id"],"fields":{"registrationDetails":{"phone":"12345"}}}),
        )
        .unwrap();
        let registrations = db.registrations().unwrap();
        let profile = &registrations[runner["id"].as_str().unwrap()];
        assert_eq!(profile["email"], "zoe@example.test");
        assert_eq!(profile["phone"], "12345");
        assert_eq!(profile["availableHours"], json!(["20-21u"]));
    }
    #[test]
    fn invalid_registration_rolls_back_name_and_labels() {
        let mut db = Db::open(std::path::Path::new(":memory:")).unwrap();
        let runner = db.mutation("runners.create", &json!({"name":"A"})).unwrap();
        assert!(db.mutation("runners.update",&json!({"id":runner["id"],"fields":{"name":"Changed","labels":["new"],"registrationDetails":{"availableHours":[42]}}})).is_err());
        assert_eq!(
            db.runner(runner["id"].as_str().unwrap()).unwrap()["name"],
            "A"
        );
        assert!(
            !db.labels(None)
                .unwrap()
                .iter()
                .any(|label| label["name"] == "new")
        );
    }
}
