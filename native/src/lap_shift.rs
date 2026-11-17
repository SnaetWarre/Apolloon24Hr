//! Move a handoff while preserving the combined duration and subsequent undo state.
use crate::db::{Db, Result, now, required};
use serde_json::{Value, json};
impl Db {
    pub fn shift_handoff(&self, input: &Value) -> Result<Value> {
        let lap_id = required(input, "lapId")?;
        let from = input["from"]
            .as_i64()
            .ok_or("Ongeldige oorspronkelijke wisseltijd")?;
        let to = input["to"]
            .as_i64()
            .filter(|n| *n >= 0)
            .ok_or("Ongeldige nieuwe wisseltijd")?;
        let lap = self.one(
            "SELECT id,runner_id,finished_at,duration_ms FROM laps WHERE id=?",
            &[json!(lap_id)],
        )?;
        if lap["finished_at"] != from {
            return Err("Deze wissel is intussen veranderd. Bekijk hem opnieuw.".into());
        }
        let shift = to.checked_sub(from).ok_or("Ongeldige wisseltijd")?;
        if shift == 0 {
            return Ok(json!({"ok":true}));
        }
        if shift.abs() > 15000 {
            return Err("Een wissel schuift hoogstens 15 seconden.".into());
        }
        let next = self
            .rows(
                "SELECT id,runner_id,duration_ms FROM laps WHERE started_at=? AND id<>? LIMIT 1",
                &[json!(from), json!(lap_id)],
            )?
            .into_iter()
            .next();
        let mut race = self.race()?;
        let running = if next.is_none() && race["activeStartedAt"] == from {
            race["activeRunnerId"].clone()
        } else {
            Value::Null
        };
        if next.is_none() && running.is_null() {
            return Err("Na deze ronde begon niemand een nieuwe ronde.".into());
        }
        let duration = lap["duration_ms"].as_i64().ok_or("Ongeldige rondetijd")?;
        let next_ms = next
            .as_ref()
            .and_then(|n| n["duration_ms"].as_i64())
            .unwrap_or_else(|| now() - from);
        if duration + shift < duration.min(20000) || next_ms - shift < next_ms.min(20000) {
            return Err("Zo wordt een ronde korter dan 20 seconden.".into());
        }
        self.exec(
            "UPDATE laps SET finished_at=?,duration_ms=? WHERE id=?",
            &[json!(to), json!(duration + shift), json!(lap_id)],
        )?;
        let next_runner = if let Some(next) = next {
            self.exec(
                "UPDATE laps SET started_at=?,duration_ms=? WHERE id=?",
                &[json!(to), json!(next_ms - shift), next["id"].clone()],
            )?;
            next["runner_id"].clone()
        } else {
            race["activeStartedAt"] = json!(to);
            self.write_race(&race)?;
            running
        };
        self.exec(
            "UPDATE runners SET status_since=? WHERE status_since=? AND id IN (?,?)",
            &[
                json!(to),
                json!(from),
                lap["runner_id"].clone(),
                next_runner,
            ],
        )?;
        for row in self.rows(
            "SELECT id,payload_json FROM handoff_history WHERE undone=0",
            &[],
        )? {
            let mut payload: Value =
                serde_json::from_str(row["payload_json"].as_str().ok_or("Ongeldige undo")?)
                    .map_err(|e| e.to_string())?;
            if payload["raceState"]["activeStartedAt"] == from {
                payload["raceState"]["activeStartedAt"] = json!(to);
                self.exec(
                    "UPDATE handoff_history SET payload_json=? WHERE id=?",
                    &[json!(payload.to_string()), row["id"].clone()],
                )?;
            }
        }
        Ok(json!({"ok":true}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Db {
        let path = std::path::Path::new(":memory:");
        Db::open(path).unwrap()
    }
    fn runner(db: &mut Db, name: &str) -> Value {
        db.mutation("runners.create", &json!({"name":name,"status":"waiting"}))
            .unwrap()["id"]
            .clone()
    }
    fn press(db: &mut Db, at: i64) {
        let race = db.race().unwrap();
        db.mutation("race.handoff",&json!({"activeRunnerId":race["activeRunnerId"],"activeStartedAt":race["activeStartedAt"],"pressedAt":at})).unwrap();
    }
    #[test]
    fn shift_preserves_two_laps_and_updates_undo_snapshot() {
        let mut db = fixture();
        let a = runner(&mut db, "A");
        runner(&mut db, "B");
        runner(&mut db, "C");
        let start = now() - 19000;
        press(&mut db, start);
        press(&mut db, start + 6000);
        press(&mut db, start + 12000);
        let history = db.history().unwrap();
        let lap = history["laps"]
            .as_array()
            .unwrap()
            .iter()
            .find(|l| l["runnerId"] == a)
            .unwrap();
        let input = json!({"lapId":lap["id"],"from":start+6000,"to":start+7000});
        // Already-short laps cannot be made shorter, so this change must be refused atomically.
        assert!(db.mutation("laps.moveHandoff", &input).is_err());
        assert_eq!(db.history().unwrap(), history);
        // Make both laps realistic without waiting in real time.
        db.exec("UPDATE laps SET duration_ms=60000", &[]).unwrap();
        db.mutation("laps.moveHandoff", &input).unwrap();
        let laps = db.history().unwrap()["laps"].as_array().unwrap().clone();
        assert_eq!(
            laps.iter()
                .map(|l| l["durationMs"].as_i64().unwrap())
                .sum::<i64>(),
            120000
        );
        let race = db.race().unwrap();
        db.mutation("race.undoLastHandoff",&json!({"activeRunnerId":race["activeRunnerId"],"activeStartedAt":race["activeStartedAt"]})).unwrap();
        assert_eq!(db.race().unwrap()["activeStartedAt"], start + 7000);
    }
    #[test]
    fn stale_correction_cannot_move_a_press_twice() {
        let mut db = fixture();
        runner(&mut db, "A");
        runner(&mut db, "B");
        let start = now() - 19000;
        press(&mut db, start);
        press(&mut db, start + 5000);
        db.exec("UPDATE laps SET duration_ms=60000", &[]).unwrap();
        let lap = db.history().unwrap()["laps"][0]["id"].clone();
        let input = json!({"lapId":lap,"from":start+5000,"to":start+4000});
        db.mutation("laps.moveHandoff", &input).unwrap();
        let before = db.race().unwrap();
        assert!(db.mutation("laps.moveHandoff", &input).is_err());
        assert_eq!(db.race().unwrap(), before);
    }
}
