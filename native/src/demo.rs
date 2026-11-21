use crate::db::{Db, Result, id, now};
use serde_json::{Value, json};

impl Db {
    pub fn load_demo(&self) -> Result<Value> {
        if !self.rows("SELECT 1 FROM runners LIMIT 1", &[])?.is_empty()
            || !self.rows("SELECT 1 FROM laps LIMIT 1", &[])?.is_empty()
        {
            return Err("Oefenrace laden kan alleen zonder lopers en zonder rondes. Wis eerst de wedstrijd via Systeem & herstel.".into());
        }
        let end = now() - 30_000;
        let durations: Vec<i64> = (0..120).map(|i| 82_000 + (i * 7919 % 39_000)).collect();
        let start = end - durations.iter().sum::<i64>();
        let labels = self.labels(None)?;
        let mut runners = Vec::new();
        for i in 0..30 {
            let runner = self.create_runner(&json!({
                "name":format!("Demo Sterrenloper {:02}", i + 1),
                "runnerNumber":format!("D{:02}", i + 1),
                "status":"registered",
                "notes":"Fictieve loper voor de oefenrace — geen echte inschrijving.",
                "targetLaps":12,
                "historicalAvgMs":100_000,
                "historicalBestMs":85_000
            }))?;
            let rid = runner["id"].clone();
            if !labels.is_empty() {
                self.exec(
                    "INSERT INTO runner_labels(runner_id,label_id) VALUES(?,?)",
                    &[rid.clone(), labels[i % labels.len()]["id"].clone()],
                )?;
            }
            runners.push(rid);
        }
        let mut at = start;
        for (i, duration) in durations.iter().enumerate() {
            let rid = &runners[i % runners.len()];
            let labels = self.labels(rid.as_str())?;
            self.exec("INSERT INTO laps(id,runner_id,lap_number,started_at,finished_at,duration_ms,source,created_at,labels_json) VALUES(?,?,?,?,?,?,'spacebar',?,?)", &[json!(id()), rid.clone(), json!(i / 30 + 1), json!(at), json!(at + duration), json!(duration), json!(at + duration), json!(labels)])?;
            at += duration;
        }
        for (i, rid) in runners.iter().enumerate() {
            let status = if i == 0 {
                "running"
            } else if i < 7 {
                "waiting"
            } else if i < 10 {
                "warming_up"
            } else {
                "ran"
            };
            self.exec(
                "UPDATE runners SET status=?,status_since=?,queue_index=? WHERE id=?",
                &[
                    json!(status),
                    json!(end),
                    if status == "waiting" {
                        json!(i - 1)
                    } else {
                        Value::Null
                    },
                    rid.clone(),
                ],
            )?;
        }
        self.exec("UPDATE race_state SET active_runner_id=?,active_started_at=?,race_started_at=?,race_finished_at=NULL,active_labels_json=? WHERE id=1", &[runners[0].clone(), json!(end), json!(start), json!(self.labels(runners[0].as_str())?)])?;
        Ok(json!({"runners":30,"laps":120}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Db {
        Db::open(std::path::Path::new(":memory:")).unwrap()
    }
    #[test]
    fn seeds_plausible_laps_and_refuses_to_overwrite() {
        let mut db = db();
        let before = now();
        assert_eq!(
            db.mutation("demo.load", &json!({})).unwrap(),
            json!({"runners":30,"laps":120})
        );
        assert_eq!(db.runners().unwrap().len(), 30);
        let laps = db
            .rows("SELECT * FROM laps ORDER BY started_at", &[])
            .unwrap();
        assert_eq!(laps.len(), 120);
        for lap in &laps {
            assert_eq!(
                lap["finished_at"].as_i64().unwrap() - lap["started_at"].as_i64().unwrap(),
                lap["duration_ms"].as_i64().unwrap()
            );
            assert!((82_000..121_000).contains(&lap["duration_ms"].as_i64().unwrap()));
        }
        for pair in laps.windows(2) {
            assert_eq!(pair[0]["finished_at"], pair[1]["started_at"]);
        }
        assert!(laps[119]["finished_at"].as_i64().unwrap() >= before - 31_000);
        assert!(laps[119]["finished_at"].as_i64().unwrap() <= now());
        assert!(
            db.mutation("demo.load", &json!({}))
                .unwrap_err()
                .contains("zonder lopers")
        );
        assert_eq!(db.runners().unwrap().len(), 30);
    }
    #[test]
    fn demo_writes_replay_identically_on_a_linked_laptop() {
        let mut leader = db();
        let mut follower = db();
        crate::cluster::log::install(
            &mut follower,
            &crate::cluster::log::serialize(&leader).unwrap(),
        )
        .unwrap();
        *leader.capture.borrow_mut() = Some(Default::default());
        leader.mutation("demo.load", &json!({})).unwrap();
        let capture = leader.capture.borrow_mut().take().unwrap();
        assert!(!capture.statements.is_empty());
        for statement in capture.statements {
            follower.exec(&statement.sql, &statement.params).unwrap();
        }
        assert_eq!(leader.runners().unwrap(), follower.runners().unwrap());
        assert_eq!(leader.race().unwrap(), follower.race().unwrap());
        assert_eq!(
            leader.rows("SELECT * FROM laps ORDER BY id", &[]).unwrap(),
            follower
                .rows("SELECT * FROM laps ORDER BY id", &[])
                .unwrap()
        );
    }
    #[test]
    fn refuses_a_runner_without_laps_and_laps_without_runners() {
        let mut db = db();
        db.mutation("runners.create", &json!({"name":"Bestaande loper"}))
            .unwrap();
        assert!(db.mutation("demo.load", &json!({})).is_err());
        let mut db = self::db();
        db.conn.execute_batch("PRAGMA foreign_keys=OFF; INSERT INTO laps(id,runner_id,lap_number,started_at,finished_at,duration_ms,source,created_at) VALUES('orphan','missing',1,1,90001,90000,'spacebar',90001)").unwrap();
        assert!(db.mutation("demo.load", &json!({})).is_err());
    }
}
