//! The post-race card route used by the PNG exporter. The story assets are shared with Electron.
use crate::db::{Db, Result, now};
use chrono::{Datelike, TimeZone, Timelike};
use chrono_tz::Europe::Brussels;
use serde_json::Value;
use std::{collections::BTreeMap, fmt::Write};

const HOUR: i64 = 3_600_000;
const PAGES: [&str; 4] = [
    include_str!("../web/wrapped/card-1.svg"),
    include_str!("../web/wrapped/card-2.svg"),
    include_str!("../web/wrapped/card-3.svg"),
    include_str!("../web/wrapped/card-4.svg"),
];

fn text(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
fn moment(millis: i64) -> chrono::DateTime<chrono_tz::Tz> {
    Brussels
        .timestamp_millis_opt(millis)
        .single()
        .unwrap_or_else(|| Brussels.timestamp_millis_opt(0).unwrap())
}
fn lap_time(ms: Option<i64>) -> String {
    ms.map(|ms| format!("{}:{:02}.{}", ms / 60000, ms / 1000 % 60, ms / 100 % 10))
        .unwrap_or_else(|| "–".into())
}
fn at(millis: i64) -> String {
    let time = moment(millis);
    let part = match time.hour() {
        0..=5 => "'s nachts",
        6..=11 => "'s ochtends",
        12..=17 => "'s middags",
        _ => "'s avonds",
    };
    format!("{} {part}", time.format("%H:%M"))
}
fn grouped(number: usize) -> String {
    let digits = number.to_string();
    if digits.len() < 4 {
        return digits;
    }
    let mut result = String::new();
    for (i, digit) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            result.push('.');
        }
        result.push(digit);
    }
    result
}
#[derive(Clone, Copy)]
struct Lap {
    finished: i64,
    started: i64,
    duration: i64,
    measured: bool,
}
impl Lap {
    fn read(value: &Value) -> Option<Self> {
        let duration = value["durationMs"].as_i64()?;
        Some(Self {
            finished: value["finishedAt"].as_i64()?,
            started: value["startedAt"].as_i64()?,
            duration,
            measured: (20_000..=600_000).contains(&duration) && value["source"] != "split",
        })
    }
}
fn fastest(laps: &[Lap]) -> Option<(usize, &Lap)> {
    laps.iter()
        .enumerate()
        .filter(|(_, lap)| lap.measured)
        .min_by_key(|(_, lap)| lap.duration)
}
fn runner_type(
    laps: &[Lap],
    faster_place: usize,
    timed: usize,
    fewer: usize,
    runners: usize,
) -> (&'static str, String, Option<(u32, u32)>) {
    if timed >= 5 && faster_place <= timed.div_ceil(10) {
        return (
            "Sprinter",
            "Je snelste ronde hoort bij de snelste 10% van de 24 uur".into(),
            None,
        );
    }
    if runners >= 5 && fewer * 10 >= runners * 9 {
        return (
            "Kilometervreter",
            "Niemand liep meer rondes dan jij".into(),
            None,
        );
    }
    let measured: Vec<_> = laps
        .iter()
        .filter(|lap| lap.measured)
        .map(|lap| lap.duration)
        .collect();
    if measured.len() >= 3 {
        let spread = measured.iter().max().unwrap() - measured.iter().min().unwrap();
        if spread <= 4_000 {
            return (
                "Metronoom",
                format!(
                    "Je rondes lagen nooit meer dan {} seconden uit elkaar",
                    ((spread + 500) / 1000).max(1)
                ),
                None,
            );
        }
    }
    for (title, from, to) in [("Nachtuil", 0, 6), ("Vroege vogel", 6, 10)] {
        let count = laps
            .iter()
            .filter(|lap| (from..to).contains(&moment(lap.finished).hour()))
            .count();
        if count * 2 >= laps.len() {
            let phrase = if count == laps.len() {
                if count == 1 {
                    "Je ronde was".into()
                } else {
                    format!("Al je {count} rondes waren")
                }
            } else {
                format!(
                    "{count} van je {} rondes {}",
                    laps.len(),
                    if count == 1 { "was" } else { "waren" }
                )
            };
            return (
                title,
                format!("{phrase} tussen {from:02}:00 en {to:02}:00"),
                Some((from, to)),
            );
        }
    }
    (
        "Teamspeler",
        "Elke ronde telt, en jij liep ze voor het team".into(),
        None,
    )
}

fn chart(laps: &[Lap], first_hour: i64, show_hours: bool, highlight: Option<(u32, u32)>) -> String {
    let mut counts = [0; 24];
    for lap in laps {
        counts[((lap.finished - first_hour).div_euclid(HOUR)).clamp(0, 23) as usize] += 1;
    }
    let max = *counts.iter().max().unwrap_or(&1);
    let slot = (961.0 - 114.0) / 24.0;
    let mut out = String::new();
    for (i, count) in counts.into_iter().enumerate() {
        let middle = 114.0 + slot * (i as f64 + 0.5);
        let _ = write!(
            out,
            r#"<ellipse cx="{middle}" cy="1765.5" rx="14" ry="6.5" class="wrapped-story__dot"/>"#
        );
        if count > 0 {
            let height = (243.0 * f64::from(count) / f64::from(max)).max(30.0);
            let hour = moment(first_hour + i as i64 * HOUR).hour();
            let active =
                show_hours && highlight.is_some_and(|(from, to)| (from..to).contains(&hour));
            let extra = if active {
                " wrapped-story__bar--on"
            } else {
                ""
            };
            let _ = write!(
                out,
                r#"<rect x="{}" y="{}" width="30" height="{height}" rx="15" class="wrapped-story__bar{extra}"/>"#,
                middle - 15.0,
                1772.0 - height
            );
        }
    }
    if show_hours {
        for i in 0..=24 {
            let hour = moment(first_hour + i * HOUR).hour();
            if i == 0 || i == 24 || (hour.is_multiple_of(6) && i > 2 && i < 22) {
                let anchor = match i {
                    0 => "start",
                    24 => "end",
                    _ => "middle",
                };
                let _ = write!(
                    out,
                    r#"<text x="{}" y="1825" text-anchor="{anchor}" class="wrapped-story__hour">{hour:02}U</text>"#,
                    114.0 + slot * i as f64
                );
            }
        }
    }
    out
}
fn fill(template: &str, values: &BTreeMap<&str, String>) -> String {
    let mut out = String::new();
    let mut rest = template;
    while let Some((head, tail)) = rest.split_once("{{") {
        out.push_str(head);
        let (key, tail) = tail.split_once("}}").expect("complete card placeholder");
        out.push_str(&values[key]);
        rest = tail;
    }
    out.push_str(rest);
    out
}

pub fn card(db: &Db, id: &str) -> Result<String> {
    let history = db.history()?;
    let race = db.race()?;
    let mut grouped_laps: BTreeMap<&str, Vec<Lap>> = BTreeMap::new();
    for value in history["laps"].as_array().into_iter().flatten() {
        if let (Some(runner), Some(lap)) = (value["runnerId"].as_str(), Lap::read(value)) {
            grouped_laps.entry(runner).or_default().push(lap);
        }
    }
    let mut html = String::from(include_str!("../web/wrapped/head.html"));
    let Some(laps) = grouped_laps.get_mut(id) else {
        html.push_str(r#"<p class="wrapped-missing">Geen loper met rondes gevonden voor deze kaart.</p><script>document.documentElement.dataset.wrappedReady = 'missing';</script>"#);
        return Ok(html);
    };
    laps.reverse(); // History is newest first. Equal fastest times use the first lap.
    let count = laps.len();
    let quickest = fastest(laps).map(|(i, lap)| (i, *lap));
    let laps = laps.clone();
    let fewer = grouped_laps
        .values()
        .filter(|other| other.len() < count)
        .count();
    let timed: Vec<_> = grouped_laps
        .values()
        .filter_map(|runner| fastest(runner).map(|(_, lap)| lap.duration))
        .collect();
    let place = quickest
        .map(|(_, lap)| 1 + timed.iter().filter(|&&other| other < lap.duration).count())
        .unwrap_or(usize::MAX);
    let (kind, description, highlight) =
        runner_type(&laps, place, timed.len(), fewer, grouped_laps.len());
    let person = db.one(
        "SELECT name FROM runners WHERE id=?",
        &[serde_json::json!(id)],
    )?;
    let name = person["name"].as_str().unwrap_or("");
    let mut names = name.split_whitespace();
    let first = names.next().unwrap_or("");
    let last = names.collect::<Vec<_>>().join(" ");
    let durations: Vec<_> = laps
        .iter()
        .filter(|lap| lap.measured)
        .map(|lap| lap.duration)
        .collect();
    let average = (!durations.is_empty()).then(|| {
        let size = durations.len() as i64;
        (durations.iter().sum::<i64>() + size / 2) / size
    });
    let start = race["raceStartedAt"].as_i64();
    let year = moment(
        race["raceFinishedAt"]
            .as_i64()
            .or(start)
            .unwrap_or_else(now),
    )
    .year();
    let first_hour = start
        .unwrap_or_else(|| {
            grouped_laps
                .values()
                .flatten()
                .map(|lap| lap.started)
                .min()
                .unwrap_or(0)
        })
        .div_euclid(HOUR)
        * HOUR;
    let percent = 100 * fewer / grouped_laps.len();
    let values = BTreeMap::from([
        ("FIRST", text(first)),
        ("FIRST_UPPER", text(&first.to_uppercase())),
        ("LAST", text(&last)),
        ("LAPS", count.to_string()),
        (
            "LAP_UNIT",
            if count == 1 { "RONDE" } else { "RONDES" }.into(),
        ),
        ("FASTEST", lap_time(quickest.map(|(_, lap)| lap.duration))),
        ("AVERAGE", lap_time(average)),
        (
            "FASTEST_NUMBER",
            quickest
                .map(|(i, _)| (i + 1).to_string())
                .unwrap_or_default(),
        ),
        (
            "FASTEST_AT",
            quickest
                .map(|(_, lap)| text(&at(lap.finished)))
                .unwrap_or_default(),
        ),
        ("PLACE", place.to_string()),
        ("TYPE", text(&kind.to_uppercase())),
        ("TYPE_TEXT", text(&description)),
        ("METERS", (count * 520).to_string()),
        ("METERS_FORMATTED", grouped(count * 520)),
        (
            "BEATEN",
            if percent > 0 {
                format!("meer dan {percent}% van alle lopers")
            } else {
                String::new()
            },
        ),
        (
            "CHART",
            chart(&laps, first_hour, start.is_some(), highlight),
        ),
    ]);
    let labels = [
        format!("Wrapped van {name}"),
        format!("{count} rondes"),
        format!("Snelste ronde {}", values["FASTEST"]),
        format!("Looptype {kind}"),
    ];
    html.push_str(r#"<div class="wrapped-page">"#);
    for (i, template) in PAGES.iter().enumerate() {
        if i == 2 && quickest.is_none() {
            continue;
        }
        let _ = write!(
            html,
            r#"<section class="wrapped-story wrapped-story--{}" aria-label="{}"><span class="brand-mark wrapped-story__logo" role="img" aria-label="Apolloon"></span><svg class="wrapped-story__text" viewBox="0 0 1080 1920" aria-hidden="true"><text x="507.8" y="204.2" class="wrapped-bebas" font-size="45.33">24 urenloop - <tspan class="wrapped-racing" font-size="40" dy="-2.8">WRAPPED</tspan><tspan dy="2.8"> - {year}</tspan></text>{}</svg></section>"#,
            i + 1,
            text(&labels[i]),
            fill(template, &values)
        );
    }
    html.push_str(r#"</div><script type="module" src="/wrapped/ready.js"></script>"#);
    Ok(html)
}
