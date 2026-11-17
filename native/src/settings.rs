use crate::db::{Db, Result};
use serde_json::{Value, json};
use std::collections::HashSet;
fn key(team: &Value) -> String {
    let mut ids = team
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    ids.sort();
    ids.join(".")
}
impl Db {
    fn existing_teams(&self, ids: &Value) -> Result<Value> {
        let labels = self.labels(None)?;
        let mut seen = HashSet::new();
        Ok(json!(
            ids.as_array()
                .into_iter()
                .flatten()
                .filter(|id| id.is_string()
                    && labels.iter().any(|l| l["id"] == **id)
                    && seen.insert((*id).clone()))
                .cloned()
                .collect::<Vec<_>>()
        ))
    }
    pub fn competitions(&self) -> Result<Value> {
        let raw = self
            .rows(
                "SELECT value FROM settings WHERE key='competitions_json'",
                &[],
            )?
            .first()
            .and_then(|r| r["value"].as_str())
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .unwrap_or(json!([]));
        let Some(groups) = raw.as_array() else {
            return Ok(json!([]));
        };
        if groups.iter().any(|g| {
            g.as_array().is_none_or(|a| {
                a.len() < 2 || a.iter().any(|id| id.as_str().is_none_or(str::is_empty))
            })
        }) {
            return Ok(json!([]));
        }
        let mut seen = HashSet::new();
        let mut groups_out = Vec::new();
        for group in groups {
            let teams = self.existing_teams(group)?;
            if teams.as_array().unwrap().len() >= 2 && seen.insert(key(&teams)) {
                groups_out.push(teams);
                if groups_out.len() == 6 {
                    break;
                }
            }
        }
        Ok(json!(groups_out))
    }
    pub fn competition_mutation(&self, method: &str, input: &Value) -> Result<Value> {
        let raw = input["labelIds"]
            .as_array()
            .filter(|a| {
                a.len() >= 2
                    && a.len() <= 100
                    && a.iter()
                        .all(|id| id.as_str().is_some_and(|s| !s.is_empty()))
            })
            .ok_or("Een competitie heeft minstens twee ploegen nodig.")?;
        let teams = self.existing_teams(&json!(raw))?;
        let target = key(&teams);
        let mut current = self.competitions()?.as_array().unwrap().clone();
        if method == "settings.addCompetition" {
            if teams.as_array().unwrap().len() < 2 {
                return Err("Een competitie heeft minstens twee bestaande ploegen nodig.".into());
            }
            if !current.iter().any(|c| key(c) == target) {
                if current.len() >= 6 {
                    return Err("Er passen 6 competities op het Competitiescherm.".into());
                }
                current.push(teams);
            }
        } else {
            current.retain(|c| key(c) != target);
        }
        self.exec(
            "INSERT OR REPLACE INTO settings(key,value) VALUES('competitions_json',?)",
            &[json!(
                serde_json::to_string(&current).map_err(crate::db::err)?
            )],
        )?;
        self.settings()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn competitions_are_unordered_unique_and_drop_deleted_teams() {
        let mut db = Db::open(std::path::Path::new(":memory:")).unwrap();
        let labels = db.labels(None).unwrap();
        let a = labels[0]["id"].clone();
        let b = labels[1]["id"].clone();
        let c = labels[2]["id"].clone();
        db.mutation("settings.addCompetition", &json!({"labelIds":[a,b,c]}))
            .unwrap();
        db.mutation("settings.addCompetition", &json!({"labelIds":[c,b,a,a]}))
            .unwrap();
        assert_eq!(
            db.settings().unwrap()["competitions"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        db.mutation("labels.delete", &json!({"id":c})).unwrap();
        assert_eq!(db.settings().unwrap()["competitions"][0], json!([a, b]));
        db.mutation("settings.removeCompetition", &json!({"labelIds":[b,a,c]}))
            .unwrap();
        assert_eq!(db.settings().unwrap()["competitions"], json!([]));
        assert!(
            db.mutation(
                "settings.addCompetition",
                &json!({"labelIds":[a,"missing"]})
            )
            .is_err()
        );
    }
}
