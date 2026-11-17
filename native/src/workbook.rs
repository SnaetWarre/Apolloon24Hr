//! Six-sheet race workbook with editable prize formulas, matching the existing export.
use crate::db::{Db, Result};
use chrono::{DateTime, Offset, Timelike};
use rust_xlsxwriter::{Format, Formula, Workbook, Worksheet};
use serde_json::{Value, json};
const DAY: f64 = 86400000.0;
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn names(v: &Value) -> String {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v["name"].as_str())
        .collect::<Vec<_>>()
        .join(", ")
}
fn local(ms: i64) -> f64 {
    let offset = DateTime::from_timestamp_millis(ms)
        .map(|d| {
            d.with_timezone(&chrono_tz::Europe::Brussels)
                .offset()
                .fix()
                .local_minus_utc()
        })
        .unwrap_or(0);
    (ms as f64 + offset as f64 * 1000.0) / DAY + 25569.0
}
fn number(v: &Value) -> Value {
    if let Some(s) = v.as_str()
        && !s.is_empty()
        && s.chars().all(|c| c.is_ascii_digit())
        && let Ok(n) = s.parse::<f64>()
    {
        return json!(n);
    }
    v.clone()
}
fn write(sheet: &mut Worksheet, row: u32, col: u16, v: &Value, fmt: Option<&Format>) -> Result<()> {
    match v {
        Value::Null => {}
        Value::Number(n) => {
            let n = n.as_f64().ok_or("Ongeldig getal")?;
            if let Some(f) = fmt {
                sheet
                    .write_number_with_format(row, col, n, f)
                    .map_err(error)?;
            } else {
                sheet.write_number(row, col, n).map_err(error)?;
            }
        }
        _ => {
            sheet
                .write_string(row, col, v.as_str().unwrap_or(""))
                .map_err(error)?;
        }
    }
    Ok(())
}
fn row(sheet: &mut Worksheet, r: u32, values: Vec<Value>) -> Result<()> {
    for (c, v) in values.iter().enumerate() {
        write(sheet, r, c as u16, v, None)?;
    }
    Ok(())
}
fn header(sheet: &mut Worksheet, name: &str, titles: &[&str], widths: &[f64]) -> Result<()> {
    sheet.set_name(name).map_err(error)?;
    sheet.set_freeze_panes(1, 0).map_err(error)?;
    let bold = Format::new().set_bold();
    for (c, title) in titles.iter().enumerate() {
        sheet
            .write_string_with_format(0, c as u16, *title, &bold)
            .map_err(error)?;
    }
    for (c, width) in widths.iter().enumerate() {
        sheet.set_column_width(c as u16, *width).map_err(error)?;
    }
    Ok(())
}
fn formula(sheet: &mut Worksheet, r: u32, c: u16, f: String, format: &Format) -> Result<()> {
    sheet
        .write_formula_with_format(r, c, Formula::new(f), format)
        .map_err(error)?;
    Ok(())
}
impl Db {
    pub fn workbook(&self) -> Result<Vec<u8>> {
        let mut book = Workbook::new();
        let history = self.history()?;
        let runners = self.runners()?;
        let registrations = self.registrations()?;
        let mut laps = history["laps"]
            .as_array()
            .ok_or("Rondes ontbreken")?
            .clone();
        laps.sort_by_key(|l| l["finishedAt"].as_i64());
        let time = Format::new().set_num_format("dd/mm/yyyy hh:mm:ss");
        let duration = Format::new().set_num_format("[m]:ss.000");
        let seconds = Format::new().set_num_format("0.000");
        let points = Format::new().set_num_format("0.00");
        let plain = Format::new();
        {
            let s = book.add_worksheet();
            header(
                s,
                "Rondes",
                &[
                    "Binnen",
                    "Nummer",
                    "Naam",
                    "Ronde",
                    "Rondetijd",
                    "Labels",
                    "Historisch gemiddelde",
                    "Historisch snelste",
                ],
                &[20., 9., 26., 8., 11., 32., 21., 18.],
            )?;
            for (i, lap) in laps.iter().enumerate() {
                let r = i as u32 + 1;
                let runner = runners.iter().find(|v| v["id"] == lap["runnerId"]);
                row(
                    s,
                    r,
                    vec![
                        json!(local(lap["finishedAt"].as_i64().unwrap_or(0))),
                        number(&lap["runnerNumber"]),
                        lap["runnerName"].clone(),
                        lap["lapNumber"].clone(),
                        json!(lap["durationMs"].as_f64().unwrap_or(0.) / DAY),
                        json!(names(&lap["labels"])),
                    ],
                )?;
                write(
                    s,
                    r,
                    0,
                    &json!(local(lap["finishedAt"].as_i64().unwrap_or(0))),
                    Some(&time),
                )?;
                write(
                    s,
                    r,
                    4,
                    &json!(lap["durationMs"].as_f64().unwrap_or(0.) / DAY),
                    Some(&duration),
                )?;
                if let Some(runner) = runner {
                    for (c, key) in [(6, "historicalAvgMs"), (7, "historicalBestMs")] {
                        if let Some(ms) = runner[key].as_f64() {
                            write(s, r, c, &json!(ms / DAY), Some(&duration))?;
                        }
                    }
                }
            }
        }
        {
            let s = book.add_worksheet();
            header(
                s,
                "Gebeurtenissen",
                &["Tijdstip", "Bericht", "Nummer", "Naam"],
                &[20., 40., 9., 26.],
            )?;
            for (i, event) in history["events"]
                .as_array()
                .unwrap()
                .iter()
                .rev()
                .enumerate()
            {
                let r = i as u32 + 1;
                row(
                    s,
                    r,
                    vec![
                        Value::Null,
                        event["message"].clone(),
                        number(&event["runnerNumber"]),
                        event["runnerName"].clone(),
                    ],
                )?;
                write(
                    s,
                    r,
                    0,
                    &json!(local(event["occurredAt"].as_i64().unwrap_or(0))),
                    Some(&time),
                )?;
            }
        }
        let mut sorted = runners.clone();
        sorted.sort_by(
            |a, b| match (a["runnerNumber"].as_str(), b["runnerNumber"].as_str()) {
                (Some(a), Some(b)) => match (a.parse::<u64>(), b.parse::<u64>()) {
                    (Ok(a), Ok(b)) => a.cmp(&b),
                    _ => a.cmp(b),
                },
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                _ => a["name"].as_str().cmp(&b["name"].as_str()),
            },
        );
        {
            let s = book.add_worksheet();
            header(
                s,
                "Lopers",
                &[
                    "Nummer",
                    "Naam",
                    "Labels",
                    "Rondes gelopen",
                    "Snelste ronde",
                    "Gemiddelde ronde",
                    "Totale looptijd",
                    "Ingeschreven op",
                    "E-mail",
                    "Telefoon",
                    "Studiefase",
                    "Geschatte rondes",
                    "Geschat tempo",
                    "Snelste ronde (opgegeven)",
                    "Max rondes per blok",
                    "Beschikbare uren",
                    "Flexibiliteit",
                    "Categorieën",
                    "Toestemming gegevens",
                    "Opmerkingen",
                    "Notities",
                ],
                &[
                    9., 26., 24., 15., 14., 17., 15., 20., 30., 16., 16., 16., 15., 24., 19., 40.,
                    20., 30., 21., 40., 40.,
                ],
            )?;
            for (i, runner) in sorted.iter().enumerate() {
                let r = i as u32 + 1;
                let registration = &registrations[runner["id"].as_str().unwrap()];
                let mut cells = vec![
                    number(&runner["runnerNumber"]),
                    runner["name"].clone(),
                    json!(names(&runner["labels"])),
                    runner["lapCount"].clone(),
                    Value::Null,
                    Value::Null,
                    Value::Null,
                ];
                for key in [
                    "submittedAt",
                    "email",
                    "phone",
                    "studyPhase",
                    "estimatedLaps",
                    "estimatedPace",
                    "fastestLap",
                    "maxLapsPerBlock",
                    "availableHours",
                    "flexibility",
                    "categories",
                    "reuseConsent",
                    "remarks",
                ] {
                    cells.push(if registration[key].is_array() {
                        json!(
                            registration[key]
                                .as_array()
                                .unwrap()
                                .iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join(", ")
                        )
                    } else {
                        registration[key].clone()
                    });
                }
                cells.push(runner["notes"].clone());
                row(s, r, cells)?;
                for (c, key) in [(4, "bestLapMs"), (5, "averageLapMs"), (6, "totalTimeMs")] {
                    if c == 6 && runner["lapCount"] == 0 {
                        continue;
                    }
                    if let Some(ms) = runner[key].as_f64() {
                        write(s, r, c, &json!(ms / DAY), Some(&duration))?;
                    }
                }
            }
        }
        let parts = [
            ("00-04u", 1.3),
            ("04-08u", 1.8),
            ("08-12u", 1.8),
            ("12-16u", 1.3),
            ("16-20u", 1.0),
            ("20-24u", 1.0),
        ];
        let mut totals = std::collections::HashMap::<String, f64>::new();
        for lap in &laps {
            let hour = DateTime::from_timestamp_millis(lap["startedAt"].as_i64().unwrap_or(0))
                .unwrap()
                .with_timezone(&chrono_tz::Europe::Brussels)
                .hour() as usize;
            let ms = lap["durationMs"].as_f64().unwrap_or(0.);
            let coefficient = if ms >= 20000. && lap["source"] != "split" {
                1. + (85. - ms / 1000.).max(0.) * 0.125
            } else {
                1.
            };
            *totals
                .entry(lap["runnerId"].as_str().unwrap().into())
                .or_default() += 20. * coefficient * parts[hour / 4].1;
        }
        {
            let s = book.add_worksheet();
            header(
                s,
                "Puntenlijst",
                &["Plaats", "Nummer", "Naam", "Labels", "Rondes", "Punten"],
                &[8., 9., 26., 24., 8., 10.],
            )?;
            let mut ranked: Vec<_> = sorted
                .iter()
                .filter(|r| r["lapCount"].as_i64().unwrap_or(0) > 0)
                .collect();
            ranked.sort_by(|a, b| {
                totals
                    .get(b["id"].as_str().unwrap())
                    .unwrap_or(&0.)
                    .total_cmp(totals.get(a["id"].as_str().unwrap()).unwrap_or(&0.))
                    .then_with(|| b["lapCount"].as_i64().cmp(&a["lapCount"].as_i64()))
            });
            let last = ranked.len() + 1;
            for (i, runner) in ranked.iter().enumerate() {
                let r = i as u32 + 1;
                let n = r + 1;
                row(
                    s,
                    r,
                    vec![
                        Value::Null,
                        number(&runner["runnerNumber"]),
                        runner["name"].clone(),
                        json!(names(&runner["labels"])),
                        runner["lapCount"].clone(),
                    ],
                )?;
                formula(s, r, 0, format!("RANK(F{n},$F$2:$F${last})"), &plain)?;
                if runner["runnerNumber"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty())
                {
                    formula(
                        s,
                        r,
                        5,
                        format!("SUMIF('Punten per ronde'!$A:$A,B{n},'Punten per ronde'!$I:$I)"),
                        &points,
                    )?;
                } else {
                    write(
                        s,
                        r,
                        5,
                        &json!(totals.get(runner["id"].as_str().unwrap()).unwrap_or(&0.)),
                        Some(&points),
                    )?;
                }
            }
        }
        {
            let s = book.add_worksheet();
            header(
                s,
                "Punten per ronde",
                &[
                    "Nummer",
                    "Naam",
                    "Ronde",
                    "Gestart",
                    "Rondetijd (s)",
                    "Dagdeel",
                    "Tijdcoëfficiënt",
                    "Dagdeelfactor",
                    "Punten",
                ],
                &[9., 26., 8., 20., 14., 10., 15., 14., 10.],
            )?;
            for (i, lap) in laps.iter().enumerate() {
                let r = i as u32 + 1;
                let n = r + 1;
                let start = lap["startedAt"].as_i64().unwrap_or(0);
                let hour = DateTime::from_timestamp_millis(start)
                    .unwrap()
                    .with_timezone(&chrono_tz::Europe::Brussels)
                    .hour() as usize;
                row(
                    s,
                    r,
                    vec![
                        number(&lap["runnerNumber"]),
                        lap["runnerName"].clone(),
                        lap["lapNumber"].clone(),
                        Value::Null,
                        Value::Null,
                        json!(parts[hour / 4].0),
                    ],
                )?;
                write(s, r, 3, &json!(local(start)), Some(&time))?;
                write(
                    s,
                    r,
                    4,
                    &json!(lap["durationMs"].as_f64().unwrap_or(0.) / 1000.),
                    Some(&seconds),
                )?;
                if lap["durationMs"].as_i64().unwrap_or(0) >= 20000 && lap["source"] != "split" {
                    formula(
                        s,
                        r,
                        6,
                        format!(
                            "IF(E{n}>='Puntenregels'!$B$5,1,1+'Puntenregels'!$B$6*('Puntenregels'!$B$5-E{n}))"
                        ),
                        &seconds,
                    )?;
                } else {
                    write(s, r, 6, &json!(1), None)?;
                }
                formula(
                    s,
                    r,
                    7,
                    format!(
                        "INDEX('Puntenregels'!$D$9:$D$14,MATCH(F{n},'Puntenregels'!$A$9:$A$14,0))"
                    ),
                    &plain,
                )?;
                formula(s, r, 8, format!("'Puntenregels'!$B$4*G{n}*H{n}"), &points)?;
            }
        }
        {
            let s = book.add_worksheet();
            s.set_name("Puntenregels").map_err(error)?;
            row(s, 0, vec![json!("Puntenregels")])?;
            row(
                s,
                1,
                vec![json!(
                    "Punten per ronde = basispunten × tijdcoëfficiënt × dagdeelfactor"
                )],
            )?;
            for (r, title, value) in [
                (3, "Basispunten per ronde", 20.),
                (4, "Referentietijd (s)", 85.),
                (5, "Factor tijdcoëfficiënt (per seconde sneller)", 0.125),
            ] {
                row(s, r, vec![json!(title), json!(value)])?;
            }
            row(
                s,
                7,
                vec![
                    json!("Dagdeel"),
                    json!("Van (uur)"),
                    json!("Tot (uur)"),
                    json!("Factor"),
                ],
            )?;
            for (i, (name, factor)) in parts.iter().enumerate() {
                row(
                    s,
                    i as u32 + 8,
                    vec![json!(name), json!(i * 4), json!((i + 1) * 4), json!(factor)],
                )?;
            }
            for (index,note) in [
                "Tijdcoëfficiënt = 1 + factor × (referentietijd − rondetijd). Een ronde trager dan de referentietijd krijgt 1.",
                "Het dagdeel hangt af van het uur waarop de ronde startte, in Belgische tijd.",
                "Een dubbele druk (korter dan 20 s) en de tweede helft van een gesplitste ronde krijgen coëfficiënt 1.",
                "Verander een getal in kolom B of een factor in kolom D: Punten per ronde en Puntenlijst rekenen opnieuw."
            ].iter().enumerate(){row(s,index as u32+15,vec![json!(note)])?;}
            s.set_column_width(0, 44.).map_err(error)?;
            for (column, width) in [(1, 11.), (2, 10.), (3, 8.)] {
                s.set_column_width(column, width).map_err(error)?;
            }
            let bold = Format::new().set_bold();
            s.write_string_with_format(0, 0, "Puntenregels", &bold)
                .map_err(error)?;
            for (column, title) in ["Dagdeel", "Van (uur)", "Tot (uur)", "Factor"]
                .iter()
                .enumerate()
            {
                s.write_string_with_format(7, column as u16, *title, &bold)
                    .map_err(error)?;
            }
        }
        book.save_to_buffer().map_err(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn excel_times_follow_brussels_in_summer_and_winter() {
        for (date, hours) in [("2026-01-01T12:00:00Z", 1.), ("2026-07-01T12:00:00Z", 2.)] {
            let ms = DateTime::parse_from_rfc3339(date)
                .unwrap()
                .timestamp_millis();
            let utc = ms as f64 / DAY + 25569.;
            assert!((local(ms) - utc - hours / 24.).abs() < 1e-9);
        }
    }
}
