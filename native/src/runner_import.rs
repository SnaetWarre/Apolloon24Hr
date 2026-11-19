//! CSV and Excel imports preserve operator edits and distinguish people sharing a bib or email.
use crate::db::{Db, Result};
use base64::Engine;
use calamine::{Data, Reader, Xlsx};
use chrono::{Datelike, Timelike};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    io::Cursor,
};

type Row = Vec<(String, String)>;
fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn canonical(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
fn column(row: &Row, names: &[&str]) -> String {
    for name in names {
        if let Some((_, v)) = row.iter().find(|(k, v)| {
            k.trim()
                .to_lowercase()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join("_")
                == *name
                && !v.trim().is_empty()
        }) {
            return v.trim().into();
        }
    }
    String::new()
}
fn form(row: &Row, prefix: &str) -> String {
    row.iter()
        .find(|(k, _)| k.trim().to_lowercase().starts_with(&prefix.to_lowercase()))
        .map(|(_, v)| v.trim().into())
        .unwrap_or_default()
}
fn choices(s: &str) -> Vec<String> {
    s.split([',', ';', '\n'])
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .collect()
}
fn duration(s: &str) -> Option<i64> {
    if s.trim().is_empty() {
        return None;
    }
    let parts = s.split(':').collect::<Vec<_>>();
    if parts.len() > 3 {
        return None;
    }
    let seconds = parts.into_iter().try_fold(0.0, |n, s| {
        (if s.trim().is_empty() { "0" } else { s.trim() })
            .replace(',', ".")
            .parse::<f64>()
            .ok()
            .map(|v| n * 60.0 + v)
    })?;
    (seconds.is_finite() && (seconds * 1000.0).abs() <= i64::MAX as f64)
        .then_some((seconds * 1000.0).round() as i64)
}
fn registration(row: &Row) -> Value {
    let mut r = json!({});
    for (k, p) in [
        ("submittedAt", "Tijdstempel"),
        ("email", "E-mailadres"),
        ("phone", "GSM-nummer"),
        ("studyPhase", "Studiefase"),
        ("estimatedLaps", "Ik schat in totaal"),
        ("estimatedPace", "Ik schat een gemiddelde"),
        ("maxLapsPerBlock", "Maximum aantal rondjes"),
        ("reuseConsent", "Ik geef hierbij toestemming"),
        ("flexibility", "Hoe flexibel ben jij"),
        ("remarks", "Nog iets dat wij best kunnen weten"),
        ("fastestLap", "Wat was de tijd van jouw snelste"),
    ] {
        r[k] = json!(form(row, p));
    }
    if text(&r["submittedAt"]).is_empty() {
        r["submittedAt"] = json!(form(row, "Tijdsstempel"));
    }
    r["availableHours"] = json!(choices(&form(row, "Ik ben volgende uren beschikbaar")));
    r["categories"] = json!(choices(&form(row, "Behoor je tot")));
    r
}
fn form_labels(r: &Value) -> Vec<String> {
    let mut labels = Vec::new();
    for category in r["categories"].as_array().unwrap() {
        let label = match text(category).to_lowercase().as_str() {
            "eerstejaars" => "1ste jaar",
            "hilok gent" => "HILOK",
            "kinesia antwerpen" => "Kinesia",
            "mesacosa" => "Mesacosa",
            "vrouw" => "Dames",
            "ik ben alumni aan de faculteit faber" => "Anciens",
            _ => continue,
        };
        if !labels.contains(&label.to_string()) {
            labels.push(label.to_string());
        }
    }
    let phase = text(&r["studyPhase"]).to_lowercase();
    let phase = match phase.as_str() {
        "1ste bach" => "1ste jaar",
        "2de bach" | "3de bach" | "1ste master" | "2de master" => phase.as_str(),
        _ => "",
    };
    if !phase.is_empty() && !labels.contains(&phase.to_string()) {
        labels.push(phase.to_string());
    }
    labels
}
fn same_submission(a: &str, b: &str) -> bool {
    fn parts(s: &str) -> Option<Vec<u32>> {
        let p = s
            .trim()
            .split(['/', '-', ' ', ':'])
            .map(str::parse::<u32>)
            .collect::<std::result::Result<Vec<_>, _>>()
            .ok()?;
        (p.len() == 6).then_some(p)
    }
    match (parts(a), parts(b)) {
        (Some(a), Some(b)) => {
            ((a[0] == b[0] && a[1] == b[1]) || (a[0] == b[1] && a[1] == b[0])) && a[2..] == b[2..]
        }
        _ => a.trim() == b.trim(),
    }
}
fn excel_cell(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::DateTime(d) => {
            let Some(date) = d.as_datetime() else {
                return cell.to_string();
            };
            if date.year() < 1900 || d.as_f64() < 1.0 {
                if date.second() == 0 && date.hour() * 3600 + date.minute() * 60 > 600 {
                    return format!("{}:{:02}", date.hour(), date.minute());
                }
                date.format("%H:%M:%S").to_string()
            } else {
                date.format("%d/%m/%Y %H:%M:%S").to_string()
            }
        }
        _ => cell.to_string(),
    }
}
fn rows(method: &str, input: &Value) -> Result<(Vec<String>, Vec<Vec<String>>)> {
    if method == "runners.importXlsx" {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(text(&input["dataBase64"]))
            .map_err(|_| "Het Excel-bestand kon niet gelezen worden.")?;
        let mut book = Xlsx::new(Cursor::new(bytes))
            .map_err(|_| "Het Excel-bestand kon niet gelezen worden.")?;
        let sheet = book
            .worksheet_range_at(0)
            .ok_or("Het Excel-bestand is leeg.")?
            .map_err(|_| "Het Excel-bestand kon niet gelezen worden.")?;
        let mut rows = sheet
            .rows()
            .map(|r| r.iter().map(excel_cell).collect::<Vec<_>>());
        let headers = rows.next().ok_or("Het Excel-bestand is leeg.")?;
        return Ok((headers, rows.collect()));
    }
    let raw = text(&input["csvText"])
        .trim()
        .trim_start_matches('\u{feff}');
    if raw.trim().is_empty() {
        return Err("Het CSV-bestand is leeg.".into());
    }
    // Choose the consistent delimiter with the most header fields. Quoted delimiters are ignored.
    let delimiter = [b',', b';', b'\t', b'|']
        .into_iter()
        .max_by_key(|d| {
            let mut reader = csv::ReaderBuilder::new()
                .delimiter(*d)
                .flexible(true)
                .from_reader(raw.as_bytes());
            reader.headers().map(|h| h.len()).unwrap_or(0)
        })
        .unwrap();
    // csv deliberately tolerates unfinished quotes; Papa rejects these before importing any rows.
    let mut quoted = false;
    let mut at_start = true;
    let mut bytes = raw.bytes().peekable();
    while let Some(b) = bytes.next() {
        if quoted {
            if b == b'"' {
                if bytes.peek() == Some(&b'"') {
                    bytes.next();
                } else {
                    quoted = false;
                }
            }
        } else if b == delimiter || b == b'\n' || b == b'\r' {
            at_start = true;
        } else {
            if at_start && b == b'"' {
                quoted = true;
            }
            at_start = false;
        }
    }
    if quoted {
        return Err("Het CSV-bestand kon niet gelezen worden: Quoted field unterminated".into());
    }
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .flexible(true)
        .from_reader(raw.as_bytes());
    let headers = reader
        .headers()
        .map_err(|e| format!("Het CSV-bestand kon niet gelezen worden: {e}"))?
        .iter()
        .map(str::to_owned)
        .collect();
    let records = reader
        .records()
        .map(|r| {
            r.map(|r| r.iter().map(str::to_owned).collect())
                .map_err(|e| format!("Het CSV-bestand kon niet gelezen worden: {e}"))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok((headers, records))
}
impl Db {
    fn import_upsert(
        &self,
        mut input: Value,
        earlier: &HashSet<String>,
    ) -> Result<(bool, String, bool)> {
        let number = text(&input["runnerNumber"]).to_owned();
        let name = text(&input["name"]).to_owned();
        let all = self.rows(
            "SELECT id,name,runner_number,registration_json FROM runners ORDER BY rowid",
            &[],
        )?;
        let holder = all.iter().find(|r| r["runner_number"] == number);
        let is_form = input.get("registration").is_some();
        let existing = if is_form {
            let email = text(&input["registration"]["email"]);
            let usable = email.split('@').count() == 2
                && email
                    .split('@')
                    .all(|s| !s.is_empty() && !s.chars().any(char::is_whitespace));
            let profiles = all
                .iter()
                .map(|r| {
                    (
                        r,
                        serde_json::from_str::<Value>(text(&r["registration_json"]))
                            .unwrap_or(Value::Null),
                    )
                })
                .collect::<Vec<_>>();
            profiles
                .iter()
                .find(|(r, p)| {
                    usable
                        && text(&p["email"]).to_lowercase() == email.to_lowercase()
                        && canonical(text(&r["name"])) == canonical(&name)
                })
                .map(|(r, _)| *r)
                .or_else(|| {
                    profiles
                        .iter()
                        .find(|(_, p)| {
                            !text(&input["registration"]["submittedAt"]).is_empty()
                                && p["submittedAt"] == input["registration"]["submittedAt"]
                        })
                        .map(|(r, _)| *r)
                })
                .or_else(|| holder.filter(|r| r["name"] == name))
        } else {
            holder
                .filter(|r| {
                    r["name"] == name
                        || (r["registration_json"].is_null() && !earlier.contains(text(&r["id"])))
                })
                .or_else(|| {
                    all.iter().find(|r| {
                        r["name"] == name
                            && r["registration_json"].is_null()
                            && !earlier.contains(text(&r["id"]))
                    })
                })
        };
        if let Some(existing) = existing {
            let rid = text(&existing["id"]).to_owned();
            input.as_object_mut().unwrap().remove("status");
            let taken = !is_form && holder.is_some_and(|r| r["id"] != existing["id"]);
            if is_form {
                for k in ["runnerNumber", "notes", "labels"] {
                    input.as_object_mut().unwrap().remove(k);
                }
                if let Ok(old) = serde_json::from_str::<Value>(text(&existing["registration_json"]))
                {
                    if same_submission(
                        text(&old["submittedAt"]),
                        text(&input["registration"]["submittedAt"]),
                    ) {
                        input.as_object_mut().unwrap().remove("name");
                        for k in ["email", "phone", "availableHours"] {
                            input["registration"][k] = old[k].clone();
                        }
                    }
                }
            } else if taken {
                input.as_object_mut().unwrap().remove("runnerNumber");
            }
            self.manage("runners.update", &json!({"id":rid,"fields":input}))?;
            Ok((false, rid, taken))
        } else {
            let taken = holder.is_some();
            if taken {
                input["runnerNumber"] = Value::Null;
            }
            let runner = self.create_runner(&input)?;
            Ok((true, text(&runner["id"]).into(), taken))
        }
    }
    pub fn import_runners(&self, method: &str, input: &Value) -> Result<Value> {
        let (headers, records) = rows(method, input)?;
        let is_form = headers
            .iter()
            .any(|h| h.trim().to_lowercase().starts_with("e-mailadres"));
        let mut summary = json!({"created":0,"updated":0,"skipped":0,"errors":[]});
        let mut errors = Vec::new();
        let mut earlier = HashSet::new();
        let mut number_rows = HashMap::new();
        for (index, values) in records.iter().enumerate() {
            let row_number = index + 2;
            let row = headers
                .iter()
                .enumerate()
                .map(|(i, k)| (k.clone(), values.get(i).cloned().unwrap_or_default()))
                .collect::<Row>();
            let extra = values.iter().skip(headers.len()).collect::<Vec<_>>();
            if extra.iter().any(|v| !v.trim().is_empty()) {
                errors.push(format!(
                    "Rij {row_number}: meer waarden dan kolommen, genegeerd: {}",
                    extra
                        .into_iter()
                        .map(|s| s.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            if row.iter().all(|(_, v)| v.trim().is_empty()) {
                continue;
            }
            let mut number = column(
                &row,
                &["runner_number", "lopersnummer", "nummer", "number", "bib"],
            );
            if number.is_empty() && is_form {
                number = row_number.to_string();
            }
            let name = column(
                &row,
                &["name", "naam", "runner_name", "loper", "voornaam_+_naam"],
            );
            if number.is_empty() || name.is_empty() {
                summary["skipped"] = json!(summary["skipped"].as_u64().unwrap() + 1);
                errors.push(format!(
                    "Rij {row_number}: {} ontbreekt",
                    if is_form {
                        "naam"
                    } else {
                        "lopersnummer en naam"
                    }
                ));
                continue;
            }
            let mut input = json!({"runnerNumber":number,"name":name,"status":"registered","registrationSource":"import"});
            if is_form {
                let r = registration(&row);
                input["labels"] = json!(form_labels(&r));
                input["registration"] = r;
            } else {
                let mut labels = Vec::new();
                for aliases in [
                    &["labels", "label", "categorie", "categories", "type"][..],
                    &["zustervereniging", "vereniging", "club"][..],
                    &["team", "speedteam"][..],
                    &["jaar", "groep"][..],
                ] {
                    for label in column(&row, aliases).split([',', ';', '|']).map(str::trim) {
                        if !label.is_empty()
                            && !["nee", "neen", "geen", "n/a", "na", "none", "-", "ja"]
                                .contains(&label.to_lowercase().as_str())
                        {
                            labels.push(label.to_string());
                        }
                    }
                }
                if !labels.is_empty() {
                    input["labels"] = json!(labels);
                }
                for (k, aliases) in [
                    (
                        "historicalAvgMs",
                        &["historical_avg", "gemiddelde", "avg", "average"][..],
                    ),
                    (
                        "historicalBestMs",
                        &["historical_best", "snelste", "best", "fastest"][..],
                    ),
                ] {
                    if let Some(ms) = duration(&column(&row, aliases)) {
                        input[k] = json!(ms);
                    }
                }
            }
            self.conn
                .execute_batch("SAVEPOINT import_row")
                .map_err(crate::db::err)?;
            match self.import_upsert(input, &earlier) {
                Ok((created, rid, taken)) => {
                    self.conn
                        .execute_batch("RELEASE import_row")
                        .map_err(crate::db::err)?;
                    let k = if created { "created" } else { "updated" };
                    summary[k] = json!(summary[k].as_u64().unwrap() + 1);
                    earlier.insert(rid);
                    if taken {
                        let reason = number_rows
                            .get(&number)
                            .map(|n| format!("staat ook op rij {n}"))
                            .unwrap_or_else(|| "is al in gebruik".into());
                        errors.push(format!(
                            "Rij {row_number}: nummer {number} {reason}, {name} kreeg geen nummer"
                        ));
                    } else {
                        number_rows.entry(number).or_insert(row_number);
                    }
                }
                Err(e) => {
                    self.conn
                        .execute_batch("ROLLBACK TO import_row; RELEASE import_row")
                        .map_err(crate::db::err)?;
                    summary["skipped"] = json!(summary["skipped"].as_u64().unwrap() + 1);
                    errors.push(format!("Rij {row_number}: {e}"));
                }
            }
        }
        summary["errors"] = json!(errors);
        Ok(summary)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Db {
        Db::open(std::path::Path::new(":memory:")).unwrap()
    }
    fn import(db: &mut Db, csv: &str) -> Value {
        db.mutation("runners.importCsv", &json!({"csvText":csv}))
            .unwrap()
    }
    fn answer(time: &str, name: &str) -> String {
        format!(
            "Tijdstempel,E-mailadres,Voornaam + naam,GSM-nummer,Studiefase,Behoor je tot,Ik schat in totaal,Ik ben volgende uren beschikbaar\n{time},club@example.be,{name},0471,1ste bach,Vrouw,12,20-21u"
        )
    }
    #[test]
    fn repeated_forms_keep_operator_changes_but_new_answers_update_contact() {
        let mut db = db();
        let csv = answer("01/10/2026 10:00:00", "Zoë Peeters");
        assert_eq!(import(&mut db, &csv)["created"], 1);
        let rid = db.runners().unwrap()[0]["id"].clone();
        db.mutation("runners.update",&json!({"id":rid,"fields":{"runnerNumber":"42","notes":"Operatornote","labels":["Speedteam"],"name":"Zoë  Peeters","registrationDetails":{"phone":"0499","availableHours":["22-23u"]}}})).unwrap();
        db.mutation(
            "runners.setStatus",
            &json!({"id":rid,"status":"warming_up"}),
        )
        .unwrap();
        assert_eq!(
            import(&mut db, &answer("10/1/2026 10:00:00", "Zoë Peeters"))["updated"],
            1
        );
        let runner = db.runner(text(&rid)).unwrap();
        assert_eq!(runner["runnerNumber"], "42");
        assert_eq!(runner["notes"], "Operatornote");
        assert_eq!(runner["status"], "warming_up");
        assert_eq!(runner["name"], "Zoë  Peeters");
        assert_eq!(db.registrations().unwrap()[text(&rid)]["phone"], "0499");
        assert_eq!(
            db.registrations().unwrap()[text(&rid)]["availableHours"],
            json!(["22-23u"])
        );
        assert_eq!(
            import(&mut db, &answer("03/10/2026 10:00:00", "Zoë Peeters"))["updated"],
            1
        );
        assert_eq!(db.registrations().unwrap()[text(&rid)]["phone"], "0471");
        assert_eq!(
            db.registrations().unwrap()[text(&rid)]["availableHours"],
            json!(["20-21u"])
        );
        assert_eq!(
            db.runner(text(&rid)).unwrap()["labels"][0]["name"],
            "Speedteam"
        );
    }
    #[test]
    fn shared_email_and_duplicate_numbers_never_collapse_different_people() {
        let mut db = db();
        let csv = format!(
            "{}\n01/10/2026 11:00:00,club@example.be,Jan,0472,2de bach,,8,21-22u",
            answer("01/10/2026 10:00:00", "Zoë")
        );
        assert_eq!(import(&mut db, &csv)["created"], 2);
        let summary = import(
            &mut db,
            "nummer;naam;gemiddelde\n2;Other Person;1:20\n2;Another Person;1:15",
        );
        assert_eq!(summary["created"], 2);
        assert_eq!(summary["errors"].as_array().unwrap().len(), 2);
        assert_eq!(db.runners().unwrap().len(), 4);
        let repeated = import(&mut db, "nummer;naam\n2;Other Person\n2;Another Person");
        assert_eq!(repeated["updated"], 2);
        assert_eq!(db.runners().unwrap().len(), 4);
        assert_eq!(
            db.runners()
                .unwrap()
                .iter()
                .find(|r| r["name"] == "Other Person")
                .unwrap()["historicalAvgMs"],
            80000
        );
    }
    #[test]
    fn optional_plain_fields_preserve_live_queue_and_labels_and_report_bad_rows() {
        let mut db = db();
        import(
            &mut db,
            "nummer,naam,labels,snelste\n17,Runner,Dames,1:02.5",
        );
        let rid = db.runners().unwrap()[0]["id"].clone();
        db.mutation("runners.setStatus", &json!({"id":rid,"status":"waiting"}))
            .unwrap();
        let summary = import(
            &mut db,
            "nummer,naam,labels,snelste\n17,Runner\n18,\n19,New,,1:10,extra",
        );
        assert_eq!(summary["created"], 1);
        assert_eq!(summary["updated"], 1);
        assert_eq!(summary["skipped"], 1);
        assert_eq!(summary["errors"].as_array().unwrap().len(), 2);
        let runner = db.runner(text(&rid)).unwrap();
        assert_eq!(runner["status"], "waiting");
        assert_eq!(runner["historicalBestMs"], 62500);
        assert_eq!(runner["labels"][0]["name"], "Dames");
    }
    #[test]
    fn xlsx_dates_and_times_take_the_same_import_path_as_csv() {
        use rust_xlsxwriter::{ExcelDateTime, Format, Workbook};
        let mut book = Workbook::new();
        let sheet = book.add_worksheet();
        for (col, header) in [
            "Tijdstempel",
            "E-mailadres",
            "Voornaam + naam",
            "Wat was de tijd van jouw snelste",
        ]
        .iter()
        .enumerate()
        {
            sheet.write_string(0, col as u16, *header).unwrap();
        }
        let date = ExcelDateTime::from_ymd(2026, 10, 4)
            .unwrap()
            .and_hms(18, 14, 44)
            .unwrap();
        sheet
            .write_datetime_with_format(
                1,
                0,
                &date,
                &Format::new().set_num_format("dd/mm/yyyy hh:mm:ss"),
            )
            .unwrap();
        sheet.write_string(1, 1, "zoe@example.be").unwrap();
        sheet.write_string(1, 2, "Zoë").unwrap();
        sheet
            .write_datetime_with_format(
                1,
                3,
                &ExcelDateTime::from_hms(1, 20, 0).unwrap(),
                &Format::new().set_num_format("h:mm"),
            )
            .unwrap();
        let bytes = book.save_to_buffer().unwrap();
        let mut db = db();
        let summary = db
            .mutation(
                "runners.importXlsx",
                &json!({"dataBase64":base64::engine::general_purpose::STANDARD.encode(bytes)}),
            )
            .unwrap();
        assert_eq!(summary["created"], 1);
        let rid = db.runners().unwrap()[0]["id"].clone();
        let profile = db.registrations().unwrap();
        assert_eq!(profile[text(&rid)]["submittedAt"], "04/10/2026 18:14:44");
        assert_eq!(profile[text(&rid)]["fastestLap"], "1:20");
        assert!(
            db.mutation("runners.importXlsx", &json!({"dataBase64":"invalid"}))
                .is_err()
        );
        assert_eq!(db.runners().unwrap().len(), 1);
    }
}
