//! Download contracts used by Analyse and external race-analysis tools.
use crate::db::{Db, Result};
use chrono::{DateTime, SecondsFormat};
use serde_json::{Value, json};
const LAP_COLUMNS: &[&str] = &[
    "timestamp",
    "runner_number",
    "name",
    "lap_number",
    "lap_time_ms",
    "lap_time_readable",
    "labels",
    "historical_avg_ms",
    "historical_best_ms",
    "source",
];
const EVENT_COLUMNS: &[&str] = &[
    "timestamp",
    "type",
    "message",
    "runner_id",
    "runner_number",
    "runner_name",
    "created_at",
];
fn timestamp(v: &Value) -> Result<String> {
    DateTime::from_timestamp_millis(v.as_i64().ok_or("Ongeldige tijd")?)
        .map(|d| d.to_rfc3339_opts(SecondsFormat::Millis, true))
        .ok_or("Ongeldige tijd".into())
}
fn string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        _ => v.to_string(),
    }
}
fn duration(ms: i64) -> String {
    let ms = ms.max(0);
    let s = ms / 1000;
    if s >= 3600 {
        format!(
            "{}:{:02}:{:02}.{:03}",
            s / 3600,
            (s / 60) % 60,
            s % 60,
            ms % 1000
        )
    } else {
        format!("{}:{:02}.{:03}", s / 60, s % 60, ms % 1000)
    }
}
fn cell(value: &str) -> String {
    let formula = value.starts_with(['=', '+', '-', '@', '\t', '\r']);
    let escaped = if formula {
        format!("'{value}")
    } else {
        value.to_owned()
    };
    if formula
        || escaped.contains([',', '"', '\r', '\n'])
        || escaped.starts_with(' ')
        || escaped.ends_with(' ')
    {
        format!("\"{}\"", escaped.replace('"', "\"\""))
    } else {
        escaped
    }
}
pub fn csv(columns: &[&str], rows: Vec<Vec<String>>) -> String {
    let header = columns.join(",");
    if rows.is_empty() {
        return format!("\u{feff}{header}\n");
    }
    let mut lines = vec![header];
    for row in rows {
        lines.push(row.iter().map(|v| cell(v)).collect::<Vec<_>>().join(","));
    }
    format!("\u{feff}{}", lines.join("\r\n"))
}
pub struct Download {
    pub mime: &'static str,
    pub name: String,
    pub body: Vec<u8>,
}
impl Db {
    pub fn download(&self, file: &str, port: u16) -> Result<Download> {
        if file == "race.xlsx" {
            return Ok(Download {
                mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                name: "apolloon-race.xlsx".into(),
                body: self.workbook()?,
            });
        }
        let history = self.history()?;
        let body = match file {
            "laps.json" => {
                serde_json::to_vec(&json!({"laps":history["laps"]})).map_err(|e| e.to_string())?
            }
            "events.json" => serde_json::to_vec(&json!({"events":history["events"]}))
                .map_err(|e| e.to_string())?,
            "current-state.json" => {
                let mut snapshot = self.snapshot(port)?;
                snapshot["laps"] = history["laps"].clone();
                snapshot["events"] = history["events"].clone();
                serde_json::to_vec(&snapshot).map_err(|e| e.to_string())?
            }
            "laps.csv" => {
                let runners = self.runners()?;
                let mut rows = Vec::new();
                for lap in history["laps"]
                    .as_array()
                    .ok_or("Rondes ontbreken")?
                    .iter()
                    .rev()
                {
                    let runner = runners.iter().find(|r| r["id"] == lap["runnerId"]);
                    let labels = lap["labels"]
                        .as_array()
                        .ok_or("Labels ontbreken")?
                        .iter()
                        .filter_map(|l| l["name"].as_str())
                        .collect::<Vec<_>>()
                        .join(", ");
                    rows.push(vec![
                        timestamp(&lap["finishedAt"])?,
                        string(&lap["runnerNumber"]),
                        string(&lap["runnerName"]),
                        string(&lap["lapNumber"]),
                        string(&lap["durationMs"]),
                        duration(lap["durationMs"].as_i64().unwrap_or(0)),
                        labels,
                        runner
                            .map(|r| string(&r["historicalAvgMs"]))
                            .unwrap_or_default(),
                        runner
                            .map(|r| string(&r["historicalBestMs"]))
                            .unwrap_or_default(),
                        string(&lap["source"]),
                    ]);
                }
                csv(LAP_COLUMNS, rows).into_bytes()
            }
            "events.csv" => {
                let mut rows = Vec::new();
                for event in history["events"]
                    .as_array()
                    .ok_or("Gebeurtenissen ontbreken")?
                    .iter()
                    .rev()
                {
                    rows.push(vec![
                        timestamp(&event["occurredAt"])?,
                        string(&event["type"]),
                        string(&event["message"]),
                        string(&event["runnerId"]),
                        string(&event["runnerNumber"]),
                        string(&event["runnerName"]),
                        timestamp(&event["createdAt"])?,
                    ]);
                }
                csv(EVENT_COLUMNS, rows).into_bytes()
            }
            _ => return Err("Export bestaat niet".into()),
        };
        Ok(Download {
            mime: if file.ends_with(".csv") {
                "text/csv; charset=utf-8"
            } else {
                "application/json; charset=utf-8"
            },
            name: format!("apolloon-{file}"),
            body,
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn csv_preserves_unicode_quotes_multiline_names_and_formula_escaping() {
        assert_eq!(
            csv(
                &["name"],
                vec![
                    vec!["Zoë".into()],
                    vec!["=X\nY".into()],
                    vec!["A, \"B\"".into()]
                ]
            ),
            "\u{feff}name\r\nZoë\r\n\"'=X\nY\"\r\n\"A, \"\"B\"\"\""
        );
        assert_eq!(csv(&["name"], vec![]), "\u{feff}name\n");
    }
    #[test]
    fn export_downloads_are_complete_and_unknown_names_are_refused() {
        let db = Db::open(std::path::Path::new(":memory:")).unwrap();
        let download = db.download("current-state.json", 1234).unwrap();
        let state: Value = serde_json::from_slice(&download.body).unwrap();
        assert_eq!(state["laps"], json!([]));
        assert_eq!(state["events"], json!([]));
        assert!(state["runners"].is_array());
        assert_eq!(download.name, "apolloon-current-state.json");
        assert!(db.download("../../app.db", 1234).is_err());
    }
}
