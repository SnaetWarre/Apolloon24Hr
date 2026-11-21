//! Tactiek (route /tactics): src/components/TacticsView.tsx and src/components/tactics/**,
//! styles in src/styles/tactics.css. Live laps against a target schedule and last year's Quivr
//! reference, plus the historical deep dive. Charts are drawn with Rune shapes on the same
//! geometry Chart.js uses (title band, tick labels, nice ticks, grace).
use super::chart_axis::{LabelSlot, visible_labels};
use super::*;
use rune::{Color, LineCap, Shape, TextStyle, canvas, el, oklch};
use std::collections::HashMap;
use std::rc::Rc;

const HOURS: usize = 24;
const APOLLOON: i64 = 1;
const VTK: i64 = 4;
const BUNDLED_NAME: &str = "Quivr 2025";
const BUNDLED_JSON: &str = include_str!("../../../public/reference/quivr-2025-lap-times.json");

// ---------- Historical data (src/lib/tactics.ts) ----------

#[derive(Clone, Debug)]
pub(super) struct Team {
    id: i64,
    name: String,
    /// Lap finishes in ms since the start, sorted and unique.
    cum: Vec<f64>,
    /// Lap durations in ms.
    dur: Vec<f64>,
}

#[derive(Clone, Debug)]
pub(super) struct Race {
    teams: Vec<Team>,
}

impl Race {
    fn team(&self, id: i64) -> Option<&Team> {
        self.teams.iter().find(|t| t.id == id)
    }
}

/// `parseHistoricalRace`, with the same Dutch errors.
pub(super) fn parse_race(text: &str) -> Result<Race, String> {
    let parsed: Value = serde_json::from_str(text)
        .map_err(|_| "Het bestand bevat geen geldige JSON.".to_string())?;
    let entries = match &parsed {
        Value::Array(a) => a.clone(),
        Value::Object(o) => o
            .get("teams")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    if entries.is_empty() {
        return Err("Het bestand bevat geen teams.".into());
    }
    let mut seen = std::collections::HashSet::new();
    let mut teams = Vec::new();
    for (i, entry) in entries.iter().enumerate() {
        if !entry.is_object() {
            return Err(format!("Team {} heeft geen geldig formaat.", i + 1));
        }
        let id = match &entry["teamId"] {
            Value::Number(n) => n.as_f64(),
            Value::String(s) => s.trim().parse::<f64>().ok(),
            _ => None,
        }
        .filter(|v| v.fract() == 0.0 && *v > 0.0)
        .ok_or_else(|| format!("Team {} heeft geen geldig teamnummer.", i + 1))?
            as i64;
        if !seen.insert(id) {
            return Err(format!("Team {id} staat meer dan één keer in het bestand."));
        }
        let Some(raw) = entry["lapTimes"].as_array() else {
            return Err(format!("Team {id} heeft geen lijst met rondetijden."));
        };
        let name = entry["teamName"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("Team {id}"));
        let mut cum = Vec::with_capacity(raw.len());
        for (lap, v) in raw.iter().enumerate() {
            let t = match v {
                Value::Number(n) => n.as_f64(),
                Value::String(s) => s.trim().parse::<f64>().ok(),
                _ => None,
            }
            .filter(|t| t.is_finite() && *t >= 0.0)
            .ok_or_else(|| format!("Team {id}, ronde {} heeft geen geldige tijd.", lap + 1))?;
            cum.push(t);
        }
        cum.sort_by(|a, b| a.total_cmp(b));
        cum.dedup();
        let dur = cum
            .iter()
            .enumerate()
            .map(|(i, t)| if i == 0 { *t } else { t - cum[i - 1] })
            .collect();
        teams.push(Team { id, name, cum, dur });
    }
    teams.sort_by_key(|t| t.id);
    Ok(Race { teams })
}

fn bundled() -> &'static Result<Race, String> {
    static RACE: std::sync::OnceLock<Result<Race, String>> = std::sync::OnceLock::new();
    RACE.get_or_init(|| parse_race(BUNDLED_JSON))
}

fn upper_bound(v: &[f64], max: f64) -> usize {
    v.partition_point(|x| *x <= max)
}

fn median(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut v = values.to_vec();
    v.sort_by(|a, b| a.total_cmp(b));
    let m = v.len() / 2;
    Some(if v.len() % 2 == 1 {
        v[m]
    } else {
        (v[m - 1] + v[m]) / 2.0
    })
}

fn quantile(values: &[f64], p: f64) -> Option<f64> {
    let mut v: Vec<f64> = values.iter().copied().filter(|x| x.is_finite()).collect();
    if v.is_empty() {
        return None;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    let pos = p.clamp(0.0, 1.0) * (v.len() - 1) as f64;
    let (lo, hi) = (pos.floor() as usize, pos.ceil() as usize);
    let f = pos - lo as f64;
    Some(v[lo] * (1.0 - f) + v[hi] * f)
}

fn std_dev(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    (values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / values.len() as f64).sqrt()
}

fn valid_pace(p: Option<f64>) -> f64 {
    p.filter(|p| p.is_finite() && *p > 0.0).unwrap_or(1.0)
}

fn hourly_historical_paces(team: Option<&Team>) -> Vec<Option<f64>> {
    let Some(team) = team else {
        return vec![None; HOURS];
    };
    let mut by_hour = vec![Vec::new(); HOURS];
    for (i, t) in team.cum.iter().enumerate() {
        let h = ((t / 3_600_000.0).floor().max(0.0) as usize).min(HOURS - 1);
        if team.dur[i] > 0.0 {
            by_hour[h].push(team.dur[i] / 1000.0);
        }
    }
    by_hour.iter().map(|d| median(d)).collect()
}

/// `buildTargetPaces`.
fn build_target_paces(target_laps: f64, reference: Option<&Team>) -> Vec<f64> {
    let safe = target_laps.max(1.0);
    let constant = (HOURS as f64 * 3600.0) / safe;
    let paces = hourly_historical_paces(reference);
    let valid: Vec<f64> = paces
        .iter()
        .flatten()
        .copied()
        .filter(|p| *p > 0.0)
        .collect();
    let central = median(&valid).unwrap_or(constant);
    let filled: Vec<f64> = paces.iter().map(|p| p.unwrap_or(central)).collect();
    if reference.is_none() {
        return filled;
    }
    let capacity: f64 = filled.iter().map(|p| 3600.0 / p).sum();
    let scale = capacity / safe;
    filled.iter().map(|p| p * scale).collect()
}

fn target_laps_at(paces: &[f64], elapsed: f64) -> f64 {
    let e = elapsed.clamp(0.0, HOURS as f64);
    let mut laps = 0.0;
    let mut h = 0usize;
    while (h as f64) < e.ceil() {
        let covered = (e - h as f64).min(1.0);
        laps += covered * 3600.0 / valid_pace(paces.get(h).copied());
        h += 1;
    }
    laps
}

fn projected_laps(done: f64, elapsed: f64, paces: &[f64], offset: f64) -> f64 {
    let e = elapsed.clamp(0.0, HOURS as f64);
    let mut laps = done;
    let first = e.floor() as usize;
    for h in first..HOURS {
        let remaining = if h == first {
            1.0 - (e - h as f64)
        } else {
            1.0
        };
        if remaining <= 0.0 {
            continue;
        }
        let pace = if offset == 0.0 {
            valid_pace(paces.get(h).copied())
        } else {
            (paces.get(h).copied().unwrap_or(1.0) + offset).max(1.0)
        };
        laps += remaining * 3600.0 / pace;
    }
    laps
}

fn historical_laps_at(team: Option<&Team>, elapsed: f64) -> Option<f64> {
    team.map(|t| upper_bound(&t.cum, elapsed.max(0.0) * 3_600_000.0) as f64)
}

fn interpolated(sorted: &[f64], at: f64) -> f64 {
    let done = upper_bound(sorted, at);
    if done >= sorted.len() {
        return done as f64;
    }
    let prev = if done > 0 { sorted[done - 1] } else { 0.0 };
    done as f64 + (at - prev) / (sorted[done] - prev)
}

fn pace_uncertainty(d: &[f64]) -> f64 {
    let n = d.len();
    if n < 2 {
        return 0.0;
    }
    let avg = d.iter().sum::<f64>() / n as f64;
    let var = d.iter().map(|v| (v - avg).powi(2)).sum::<f64>() / (n - 1) as f64;
    (var / n as f64).sqrt()
}

fn durations_in_window(team: &Team, from: f64, to: f64) -> Vec<f64> {
    team.dur
        .iter()
        .enumerate()
        .filter(|(i, _)| {
            let h = team.cum[*i] / 3_600_000.0;
            h >= from && h < to
        })
        .map(|(_, d)| d / 1000.0)
        .collect()
}

// ---------- Live laps ----------

#[derive(Clone, Copy)]
struct Lap {
    finished: f64,
    dur: f64,
}

fn valid_laps(s: &State, start: f64, min_s: f64, max_s: f64) -> Vec<Lap> {
    let mut v: Vec<Lap> = laps(s)
        .iter()
        .filter_map(|l| {
            Some(Lap {
                finished: l["finishedAt"].as_f64()?,
                dur: l["durationMs"].as_f64()?,
            })
        })
        .filter(|l| l.finished >= start && l.dur >= min_s * 1000.0 && l.dur <= max_s * 1000.0)
        .collect();
    v.sort_by(|a, b| a.finished.total_cmp(&b.finished));
    v
}

// ---------- Formatting (tacticsFormat.ts) ----------

fn group(int: i64) -> String {
    let digits = int.abs().to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push('.');
        }
        out.push(c);
    }
    if int < 0 { format!("-{out}") } else { out }
}

/// `toLocaleString('nl-BE', { maximumFractionDigits: digits })` (and a minimum when `fixed`).
fn nl(v: f64, digits: usize, fixed: bool) -> String {
    let factor = 10f64.powi(digits as i32);
    let r = (v * factor).round() / factor;
    let int = r.trunc() as i64;
    let mut frac = format!("{:.*}", digits, (r - r.trunc()).abs());
    frac = frac
        .trim_start_matches('0')
        .trim_start_matches('.')
        .to_string();
    if !fixed {
        frac = frac.trim_end_matches('0').to_string();
    }
    let sign = if r < 0.0 && int == 0 { "-" } else { "" };
    if frac.is_empty() || digits == 0 {
        format!("{sign}{}", group(int))
    } else {
        format!("{sign}{},{frac}", group(int))
    }
}

fn signed_laps(d: Option<f64>) -> String {
    match d.filter(|d| d.is_finite()) {
        None => "Geen referentie".into(),
        Some(d) => {
            let r = (d * 10.0).round() / 10.0;
            format!("{}{}", if r > 0.0 { "+" } else { "" }, nl(r, 1, false))
        }
    }
}

fn signed_number(v: f64) -> String {
    let r = v.round();
    format!("{}{}", if r > 0.0 { "+" } else { "" }, nl(r, 0, false))
}

/// `formatDurationMs` for seconds: m:ss.mmm.
fn pace(seconds: Option<f64>) -> String {
    let Some(seconds) = seconds.filter(|s| s.is_finite()) else {
        return "Geen data".into();
    };
    let ms = (seconds * 1000.0).floor().max(0.0) as i64;
    let (whole, frac) = (ms / 1000, ms % 1000);
    let (h, m, s) = (whole / 3600, (whole % 3600) / 60, whole % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}.{frac:03}")
    } else {
        format!("{m}:{s:02}.{frac:03}")
    }
}

fn signed_gap(seconds: f64) -> String {
    if !seconds.is_finite() {
        return "—".into();
    }
    let sign = if seconds > 0.0 {
        "+"
    } else if seconds < 0.0 {
        "-"
    } else {
        ""
    };
    let total = seconds.abs().round() as i64;
    if total < 60 {
        return format!("{sign}{total} s");
    }
    let (h, m, r) = (total / 3600, (total % 3600) / 60, total % 60);
    if h > 0 {
        format!("{sign}{h}:{m:02}:{r:02}")
    } else {
        format!("{sign}{m}:{r:02}")
    }
}

fn race_hour(hours: f64) -> String {
    let total = (hours * 60.0).round().max(0.0) as i64;
    let (h, m) = (total / 60, total % 60);
    if m > 0 {
        format!("{h}u{m:02}")
    } else {
        format!("{h}u")
    }
}

fn brussels_hm(ms: f64) -> (u32, u32) {
    use chrono::Timelike;
    chrono::DateTime::from_timestamp_millis(ms as i64)
        .map(|d| d.with_timezone(&chrono_tz::Europe::Brussels))
        .map(|d| (d.hour(), d.minute()))
        .unwrap_or((0, 0))
}

fn race_clock(start: f64, hour: f64) -> String {
    let (h, m) = brussels_hm(start + hour * 3_600_000.0);
    format!("{h:02}:{m:02}")
}

fn hour_window(start: f64, hour: usize) -> String {
    format!(
        "{}-{}",
        race_clock(start, hour as f64),
        race_clock(start, hour as f64 + 1.0)
    )
}

fn clock_ms(ms: f64) -> String {
    use chrono::Timelike;
    chrono::DateTime::from_timestamp_millis(ms as i64)
        .map(|d| d.with_timezone(&chrono_tz::Europe::Brussels))
        .map(|d| {
            format!(
                "{:02}:{:02}:{:02}.{:03}",
                d.hour(),
                d.minute(),
                d.second(),
                (ms as i64).rem_euclid(1000)
            )
        })
        .unwrap_or_else(|| "—".into())
}

/// Race-hour ranges between midnight and 06:00 Brussels time.
fn night_ranges(start: f64) -> Vec<(f64, f64)> {
    let (h, m) = brussels_hm(start);
    let first = (24.0 - h as f64 - m as f64 / 60.0) % 24.0;
    [first - 24.0, first]
        .iter()
        .map(|mid| (mid.max(0.0), (mid + 6.0).min(24.0)))
        .filter(|(a, b)| b > a)
        .collect()
}

// ---------- Page state ----------

/// Number fields; `HOUR + i` is the target pace of race hour i.
const TARGET: usize = 0;
const RECENT: usize = 1;
const MIN_S: usize = 2;
const MAX_S: usize = 3;
const LAP_LEN: usize = 4;
const T_FROM: usize = 5;
const T_TO: usize = 6;
const N_FROM: usize = 7;
const N_TO: usize = 8;
const DIAG_SLOW: usize = 9;
const DIAG_JUMP: usize = 10;
const DIAG_IMPROVEMENT: usize = 11;
const DRAFT_FROM: usize = 12;
const DRAFT_TO: usize = 13;
const DRAFT_CLOSE: usize = 14;
const DRAFT_FAR: usize = 15;
const DRAFT_MIN: usize = 16;
const DRAFT_MAX: usize = 17;
const HOUR: usize = 18;
const FIELDS: usize = HOUR + HOURS;

#[derive(Clone, Copy, PartialEq)]
enum Window {
    Full,
    Recent(f64),
    Custom(f64, f64),
}

pub(super) struct Page {
    section: u8,
    custom: Option<(Race, String)>,
    error: Option<String>,
    vals: [f64; HOUR],
    edits: Vec<TextEdit>,
    dirty: Vec<bool>,
    scenario_edited: bool,
    profile: u8,
    paces: Vec<f64>,
    paces_edited: bool,
    view: u8,
    baseline: u8,
    hidden: [bool; 4],
    window: Window,
    open: Option<String>,
    hour_open: bool,
    analysis_open: bool,
    suspicious_open: bool,
    widths: HashMap<&'static str, f32>,
    selection: Option<(f32, f32)>,
    brush: Option<(u8, f64, f64, f64)>,
    first: i64,
    second: i64,
    deep: u8,
    detail: Option<i64>,
    improving_second: bool,
}

impl Default for Page {
    fn default() -> Self {
        let own = bundled().as_ref().ok().and_then(|r| r.team(APOLLOON));
        let target = own.map(|t| t.cum.len() as f64).unwrap_or(800.0);
        let vals = [
            target, 20.0, 55.0, 140.0, 530.0, 0.0, 24.0, 3.0, 9.0, 90.0, 8.0, 15.0, 0.0, 24.0, 8.0,
            15.0, 55.0, 140.0,
        ];
        let mut edits: Vec<TextEdit> = vals.iter().map(|v| TextEdit::new(fmt_num(*v))).collect();
        edits.extend((0..HOURS).map(|_| TextEdit::new("")));
        Page {
            section: 0,
            custom: None,
            error: None,
            vals,
            edits,
            dirty: vec![false; FIELDS],
            scenario_edited: false,
            profile: if own.is_some() { 1 } else { 0 },
            paces: Vec::new(),
            paces_edited: false,
            view: 0,
            baseline: 1,
            hidden: [false; 4],
            window: Window::Full,
            open: None,
            hour_open: false,
            analysis_open: false,
            suspicious_open: false,
            widths: HashMap::new(),
            selection: None,
            brush: None,
            first: APOLLOON,
            second: VTK,
            deep: 0,
            detail: None,
            improving_second: false,
        }
    }
}

fn fmt_num(v: f64) -> String {
    if v.fract() == 0.0 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

fn race_data(p: &Page) -> (Option<&Race>, String, Option<String>) {
    if let Some((race, name)) = &p.custom {
        return (Some(race), name.clone(), p.error.clone());
    }
    match bundled() {
        Ok(r) => (Some(r), BUNDLED_NAME.into(), p.error.clone()),
        Err(e) => (
            None,
            BUNDLED_NAME.into(),
            p.error.clone().or(Some(e.clone())),
        ),
    }
}

fn reference_team(p: &Page) -> Option<&Team> {
    let (race, _, _) = race_data(p);
    match p.profile {
        1 => race.and_then(|r| r.team(APOLLOON)),
        2 => race.and_then(|r| r.team(VTK)),
        _ => None,
    }
}

fn target_paces(p: &Page) -> Vec<f64> {
    if p.paces_edited && p.paces.len() == HOURS {
        p.paces.clone()
    } else {
        build_target_paces(p.vals[TARGET], reference_team(p))
    }
}

fn bounds(p: &Page, id: usize) -> (f64, f64) {
    match id {
        TARGET | LAP_LEN => (1.0, f64::INFINITY),
        DRAFT_FROM => (0.0, p.vals[DRAFT_TO] - 1.0),
        DRAFT_TO => (p.vals[DRAFT_FROM] + 1.0, 24.0),
        DRAFT_CLOSE => (1.0, p.vals[DRAFT_FAR] - 1.0),
        DRAFT_FAR => (p.vals[DRAFT_CLOSE] + 1.0, 120.0),
        DRAFT_MIN => (1.0, p.vals[DRAFT_MAX] - 1.0),
        DRAFT_MAX => (p.vals[DRAFT_MIN] + 1.0, 300.0),
        DIAG_SLOW => (10.0, 300.0),
        DIAG_JUMP | DIAG_IMPROVEMENT => (1.0, 60.0),
        RECENT => (5.0, 100.0),
        MIN_S => (10.0, p.vals[MAX_S]),
        MAX_S => (p.vals[MIN_S], 300.0),
        T_FROM => (0.0, p.vals[T_TO] - 1.0),
        T_TO => (p.vals[T_FROM] + 1.0, 24.0),
        N_FROM => (0.0, p.vals[N_TO] - 1.0),
        N_TO => (p.vals[N_FROM] + 1.0, 24.0),
        _ => (30.0, 300.0),
    }
}

fn value(p: &Page, id: usize) -> f64 {
    if id >= HOUR {
        target_paces(p)[id - HOUR].round()
    } else {
        p.vals[id]
    }
}

fn set_value(p: &mut Page, id: usize, v: f64) {
    match id {
        TARGET => {
            p.scenario_edited = true;
            p.paces_edited = false;
            p.vals[TARGET] = v;
        }
        _ if id >= HOUR => {
            let mut paces = target_paces(p);
            paces[id - HOUR] = v;
            p.paces = paces;
            p.scenario_edited = true;
            p.paces_edited = true;
        }
        _ => p.vals[id] = v,
    }
}

/// `NumberInput` onChange: a typed value already in range applies at once.
fn typed(p: &mut Page, id: usize) {
    p.dirty[id] = true;
    let text = p.edits[id].text.trim().to_string();
    let (min, max) = bounds(p, id);
    if let Ok(v) = text.parse::<f64>() {
        if !text.is_empty() && v >= min && v <= max && v != value(p, id) {
            set_value(p, id, v);
        }
    }
}

/// `NumberInput` commit (blur or Enter): correct to min..max.
fn commit(p: &mut Page, id: usize) {
    p.dirty[id] = false;
    let text = p.edits[id].text.trim().to_string();
    if let Ok(v) = text.parse::<f64>() {
        if v.is_finite() {
            let (min, max) = bounds(p, id);
            let v = v.max(min).min(max);
            if v != value(p, id) {
                set_value(p, id, v);
            }
        }
    }
    let shown = fmt_num(value(p, id));
    p.edits[id].replace_text(shown);
}

/// Called every poll: commits a draft once its field lost focus and keeps idle fields in step.
pub(super) fn refresh(s: &mut State) -> bool {
    if s.page != 4 {
        return false;
    }
    let mut changed = false;
    let p = &mut s.tactics;
    for id in 0..FIELDS {
        if p.edits[id].focused {
            continue;
        }
        if p.dirty[id] {
            commit(p, id);
            changed = true;
        }
        let shown = fmt_num(value(p, id));
        if p.edits[id].text != shown {
            p.edits[id].replace_text(shown);
            changed = true;
        }
    }
    changed
}

/// A chosen reference file (`storeHistoricalRace`).
pub(super) fn load_file(s: &mut State, name: String, bytes: Vec<u8>) {
    let text = String::from_utf8_lossy(&bytes).to_string();
    match parse_race(&text) {
        Ok(race) => {
            if let Err(error) = store_reference(Some((&name, &text))) {
                s.tactics.error = Some(format!("Het bronbestand kon niet worden bewaard: {error}"));
                return;
            }
            s.tactics.custom = Some((race, name));
            s.tactics.error = None;
            reset_diagnostics(&mut s.tactics);
            if !s.tactics.scenario_edited {
                apply_reference_default(&mut s.tactics);
            }
        }
        Err(e) => s.tactics.error = Some(e),
    }
}

pub(super) fn restore_reference(p: &mut Page) {
    if let Some((name, source)) = stored_reference()
        && let Ok(race) = parse_race(&source)
    {
        p.custom = Some((race, name));
        apply_reference_default(p);
        reset_diagnostics(p);
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn reference_path() -> std::path::PathBuf {
    crate::desktop::paths().data.join("historical-race.json")
}

#[cfg(not(target_arch = "wasm32"))]
fn stored_reference() -> Option<(String, String)> {
    serde_json::from_slice(&std::fs::read(reference_path()).ok()?).ok()
}

#[cfg(not(target_arch = "wasm32"))]
fn store_reference(reference: Option<(&str, &str)>) -> Result<(), String> {
    let path = reference_path();
    if let Some(reference) = reference {
        let data = serde_json::to_vec(&reference).map_err(|e| e.to_string())?;
        let folder = path.parent().expect("reference path has a parent");
        std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
        let temp = path.with_extension("tmp");
        std::fs::write(&temp, data)
            .and_then(|_| std::fs::rename(temp, path))
            .map_err(|e| e.to_string())
    } else {
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

#[cfg(target_arch = "wasm32")]
const REFERENCE_KEY: &str = "apolloon.kobe-tactics.historical-race.v1";
#[cfg(target_arch = "wasm32")]
const REFERENCE_NAME_KEY: &str = "apolloon.kobe-tactics.historical-race-name.v1";

#[cfg(target_arch = "wasm32")]
fn stored_reference() -> Option<(String, String)> {
    let storage = web_sys::window()?.local_storage().ok()??;
    let source = storage.get_item(REFERENCE_KEY).ok()??;
    let name = storage
        .get_item(REFERENCE_NAME_KEY)
        .ok()
        .flatten()
        .unwrap_or_else(|| "Geïmporteerde resultaten".into());
    Some((name, source))
}

#[cfg(target_arch = "wasm32")]
fn store_reference(reference: Option<(&str, &str)>) -> Result<(), String> {
    let storage = web_sys::window()
        .and_then(|w| w.local_storage().ok().flatten())
        .ok_or("Browseropslag is niet beschikbaar.")?;
    let result = if let Some((name, source)) = reference {
        storage
            .set_item(REFERENCE_KEY, source)
            .and_then(|_| storage.set_item(REFERENCE_NAME_KEY, name))
    } else {
        storage
            .remove_item(REFERENCE_KEY)
            .and_then(|_| storage.remove_item(REFERENCE_NAME_KEY))
    };
    result.map_err(|_| "Browseropslag is niet beschikbaar of zit vol.".into())
}

fn apply_reference_default(p: &mut Page) {
    let (race, _, _) = race_data(p);
    if let Some(n) = race
        .and_then(|r| r.team(APOLLOON))
        .map(|t| t.cum.len() as f64)
    {
        p.vals[TARGET] = n;
        p.profile = 1;
    }
}

fn clear_reference(s: &mut State) {
    if let Err(error) = store_reference(None) {
        s.tactics.error = Some(format!(
            "Het bronbestand kon niet worden verwijderd: {error}"
        ));
        return;
    }
    s.tactics.custom = None;
    s.tactics.error = None;
    reset_diagnostics(&mut s.tactics);
    if !s.tactics.scenario_edited {
        apply_reference_default(&mut s.tactics);
    }
}

// ---------- Tokens ----------

struct Ink {
    text: Color,
    ink2: Color,
    ink3: Color,
    line: Color,
    line2: Color,
    card: Color,
    surface2: Color,
    surface3: Color,
    brand: Color,
    brand_wash: Color,
    go_ink: Color,
    stop_ink: Color,
    warn_ink: Color,
    warn_wash: Color,
    warn_line: Color,
    go_wash: Color,
    chart_text: Color,
    muted: Color,
    grid: Color,
    live: Color,
    target: Color,
    own: Color,
    rival: Color,
    strong: Color,
    neutral: Color,
    dark: bool,
}

fn ink(dark: bool) -> Ink {
    let t = tok::theme(dark);
    let c = tok::tones(dark);
    let h = |v: &str| rune::color::hex(v).unwrap();
    Ink {
        text: t.text,
        ink2: c.ink2,
        ink3: c.ink3,
        line: t.card_border,
        line2: c.line2,
        card: t.card,
        surface2: c.surface2,
        surface3: c.surface3,
        brand: oklch(0.57, 0.2, 264.0),
        brand_wash: if dark {
            oklch(0.263, 0.036, 250.9)
        } else {
            oklch(0.963, 0.015, 248.0)
        },
        go_ink: if dark {
            oklch(0.772, 0.188, 145.5)
        } else {
            oklch(0.4479, 0.1083, 151.33)
        },
        stop_ink: if dark {
            oklch(0.734, 0.163, 25.8)
        } else {
            oklch(0.505, 0.19, 27.5)
        },
        warn_ink: c.warn_ink,
        warn_wash: c.warn_wash,
        warn_line: c.warn_line,
        go_wash: c.go_wash,
        chart_text: h(if dark { "#BDBDBD" } else { "#52525B" }),
        muted: h(if dark { "#8C8C8C" } else { "#71717A" }),
        grid: h(if dark { "#2A2A2A" } else { "#EDEDEF" }),
        live: h(if dark { "#3D9BF0" } else { "#0D78D3" }),
        target: h(if dark { "#7A7A7A" } else { "#A1A1AA" }),
        own: h(if dark { "#A78BFA" } else { "#7C3AED" }),
        rival: h(if dark { "#E3B341" } else { "#C2680B" }),
        strong: h(if dark { "#ECECEC" } else { "#18181B" }),
        neutral: h(if dark { "#6F6F6F" } else { "#A1A1AA" }),
        dark,
    }
}

fn team_color(k: &Ink, id: i64, index: usize) -> Color {
    match id {
        1 => k.live,
        4 => k.rival,
        _ => {
            let alt = [
                "#009E73", "#D55E00", "#CC79A7", "#7F3FBF", "#8B4513", "#64748b",
            ];
            rune::color::hex(alt[index % alt.len()]).unwrap()
        }
    }
}

fn font(size: f32, weight: f32) -> TextStyle {
    TextStyle::new(size, weight)
}

fn t(v: impl Into<String>, size: f32, weight: f32, color: Color) -> El {
    text(v.into()).font(font(size, weight)).color(color)
}

/// `.panel`.
fn panel(k: &Ink) -> El {
    col()
        .min_w(0.0)
        .padding(16.0)
        .radius(8.0)
        .fill(k.card)
        .border(1.0, k.line)
}

/// `TacticsSectionHeader` (kicker hidden by CSS): h2 and a quiet paragraph, 12 below.
fn section_header(k: &Ink, title: &str, body: &str) -> El {
    col()
        .min_w(0.0)
        .mb(12.0)
        .child(
            text(title.to_string())
                .font(font(14.0, 600.0).lh(17.5))
                .color(k.text)
                .wrap()
                .min_w(0.0)
                .mb(4.0),
        )
        .child(
            text(body.to_string())
                .font(font(14.0, 400.0).lh(21.0))
                .color(k.ink3)
                .wrap()
                .min_w(0.0),
        )
}

/// `.segmented-control`.
fn segmented(
    k: &Ink,
    key: &str,
    label: &str,
    options: &[&str],
    active: Option<usize>,
    on: Rc<dyn Fn(&mut State, usize)>,
) -> El {
    let mut g = row()
        .role("group")
        .label(label.to_string())
        .gap(2.0)
        // 2 px inside the 1 px border (a border here takes no room of its own).
        .padding(3.0)
        .radius(6.0)
        .border(1.0, k.line)
        .fill(k.surface2);
    for (i, o) in options.iter().enumerate() {
        let on = on.clone();
        let is = active == Some(i);
        let mut b = row()
            .key(format!("{key}-{i}"))
            .role("button")
            .label(o.to_string())
            .checked(is)
            .focusable(true)
            .h(26.0)
            .px(10.0)
            .center_y()
            .radius(4.0)
            .press(k.surface3)
            .on_press(move |s: &mut State| on(s, i))
            .child(t(*o, 13.0, 500.0, if is { k.text } else { k.ink2 }));
        if is {
            b = b.fill(k.card).border(1.0, k.line2);
        }
        g = g.child(b);
    }
    g
}

/// `select.input`: a closed box with a chevron; the open list drops below it.
#[allow(clippy::too_many_arguments)]
fn select(
    s: &State,
    k: &Ink,
    key: &'static str,
    label: &str,
    options: Vec<(String, bool)>,
    selected: usize,
    h: f32,
    size: f32,
    on: Rc<dyn Fn(&mut State, usize)>,
) -> El {
    let open = s.tactics.open.as_deref() == Some(key);
    let current = options
        .get(selected)
        .map(|o| o.0.clone())
        .unwrap_or_default();
    let chevron =
        canvas(Shape::new().stroke(vec![[1.0, 1.5], [5.0, 5.5], [9.0, 1.5]], 1.6, k.text))
            .size(10.0, 7.0);
    let mut b = row()
        .key(key)
        .role("combobox")
        .label(label.to_string())
        .expanded(open)
        .focusable(true)
        .h(h)
        .pl(14.0)
        .pr(10.0)
        .gap(8.0)
        .center_y()
        .radius(6.0)
        .fill(k.card)
        .border(1.0, if open { k.brand } else { k.line2 })
        .on_press(move |s: &mut State| {
            s.tactics.open = if s.tactics.open.as_deref() == Some(key) {
                None
            } else {
                Some(key.into())
            };
        })
        .child(
            t(current, size, 400.0, k.text)
                .grow(1.0)
                .truncate()
                .min_w(0.0),
        )
        .child(chevron);
    if open {
        let mut list = col()
            .absolute(0.0, h + 2.0)
            .w_full()
            .py(4.0)
            .radius(6.0)
            .fill(k.card)
            .border(1.0, k.line2)
            .raise();
        for (i, (o, enabled)) in options.into_iter().enumerate() {
            let on = on.clone();
            let mut item = row()
                .key(format!("{key}-opt-{i}"))
                .role("option")
                .checked(i == selected)
                .h(26.0)
                .px(12.0)
                .center_y()
                .child(t(o, size, 400.0, if enabled { k.text } else { k.ink3 }));
            if enabled {
                item = item.hover(k.surface3).on_press(move |s: &mut State| {
                    s.tactics.open = None;
                    on(s, i);
                });
            } else {
                item = item.disabled(true);
            }
            list = list.child(item);
        }
        b = b.child(list);
    }
    b
}

/// `NumberInput` with the `.input` look.
fn num_input(s: &State, k: &Ink, id: usize, label: &str, style: TextStyle, h: f32) -> El {
    let focused = s.tactics.edits[id].focused;
    // `.input`: 10 px across, the line centred in the control.
    let line = (style.size * 1.2).round();
    text_input(&s.tactics.edits[id], style.lh(line))
        .single_line()
        .key(format!("tac-num-{id}"))
        .label(label.to_string())
        .h(h)
        .py(((h - line) / 2.0).max(0.0))
        .px(10.0)
        .radius(6.0)
        .fill(k.card)
        .color(k.text)
        .border(1.0, if focused { k.brand } else { k.line2 })
        .on_edit(move |s: &mut State| &mut s.tactics.edits[id])
        .on_input_change(move |s: &mut State, _| typed(&mut s.tactics, id))
        .on_submit(move |s: &mut State, _| commit(&mut s.tactics, id))
}

/// `label > span + input` in `.tactics-control-grid`.
fn field(k: &Ink, label: &str, control: El) -> El {
    col()
        .gap(6.0)
        .min_w(0.0)
        .child(
            text(label.to_string())
                .font(font(13.5, 600.0).lh(20.25))
                .color(k.ink2)
                .wrap()
                .min_w(0.0),
        )
        .child(control)
}

/// `.disclosure` chevron: right when closed, down when open.
fn chevron(color: Color, open: bool) -> El {
    let pts = if open {
        vec![[1.0, 2.5], [5.0, 6.5], [9.0, 2.5]]
    } else {
        vec![[3.0, 0.5], [7.0, 4.5], [3.0, 8.5]]
    };
    canvas(Shape::new().stroke(pts, 1.5, color))
        .size(10.0, 9.0)
        .mx(2.0)
}

fn ghost_button(k: &Ink, key: &str, label: &str, f: impl Fn(&mut State) + 'static) -> El {
    row()
        .key(key.to_string())
        .role("button")
        .label(label.to_string())
        .focusable(true)
        .h(34.0)
        .px(12.0)
        .center_y()
        .radius(6.0)
        .border(1.0, k.line2)
        .hover(k.surface3)
        .on_press(f)
        .child(t(label, 13.5, 500.0, k.text))
}

/// `.stat-panel.tactics-stat` inside `.stats-grid--analysis`.
fn stat(
    k: &Ink,
    label: &str,
    value: &str,
    unit: Option<&str>,
    detail: &str,
    tone: Option<bool>,
) -> El {
    let color = match tone {
        Some(true) => k.go_ink,
        Some(false) => k.stop_ink,
        None => k.text,
    };
    // `strong`: 2 px down, clamp(20px, 1.7vw, 24px) on a 1.2 line; the unit sits on its baseline.
    let mut v = row().mt(2.0).items_end().gap(5.0).child(
        text(value.to_string())
            .font(font(23.2, 550.0).lh(27.84))
            .color(color),
    );
    if let Some(u) = unit {
        v = v.child(t(u, 14.0, 500.0, k.ink3).mb(4.0));
    }
    col()
        .grow(1.0)
        .w(0.0)
        .min_w(0.0)
        .gap(2.0)
        .px(16.0)
        // 12 px padding; the label's first line sits 2 px lower in a 1.5 line box than here.
        .pt(14.0)
        .pb(13.0)
        .child(
            text(label.to_string())
                .font(font(12.5, 400.0).lh(18.75))
                .color(k.ink3)
                .truncate()
                .min_w(0.0),
        )
        .child(v)
        .child(
            text(detail.to_string())
                .font(font(12.5, 400.0).lh(18.75))
                .color(k.ink3)
                .wrap()
                .min_w(0.0),
        )
}

fn stats_grid(k: &Ink, label: &str, stats: Vec<El>) -> El {
    let n = stats.len();
    let mut g = row()
        .role("region")
        .label(label.to_string())
        .min_w(0.0)
        .radius(8.0)
        .fill(k.card)
        .border(1.0, k.line)
        .clip_rounded(8.0);
    for (i, st) in stats.into_iter().enumerate() {
        g = g.child(st.h_full());
        if i + 1 < n {
            g = g.child(el().w(1.0).fill(k.line).self_stretch());
        }
    }
    g
}

fn status_badge(
    _k: &Ink,
    label: &str,
    fill: Color,
    color: Color,
    h: f32,
    size: f32,
    weight: f32,
) -> El {
    row()
        .h(h)
        .px(6.0)
        .center_y()
        .radius(4.0)
        .fill(fill)
        .child(t(label, size, weight, color))
}

// ---------- Charts ----------

struct Series {
    label: String,
    color: Color,
    width: f32,
    dash: Option<(f32, f32)>,
    points: Vec<(f64, Option<f64>)>,
    dots: f32,
    hidden: bool,
}

struct ChartSpec {
    key: &'static str,
    height: f32,
    x_min: f64,
    x_max: f64,
    x_ticks: Vec<(f64, Vec<String>)>,
    x_title: Option<String>,
    y_title: String,
    y_fmt: Box<dyn Fn(f64) -> String>,
    grace: f64,
    begin_at_zero: bool,
    zero_line: bool,
    legend: bool,
    series: Vec<Series>,
    bands: Vec<(f64, f64)>,
    now: Option<f64>,
    scatter: Option<(Vec<(f64, f64)>, Color)>,
}

/// Chart.js `niceNum`-based linear ticks (`generateTicks`), max 11 ticks.
fn nice_ticks(min: f64, max: f64) -> (f64, f64, f64) {
    fn nice(range: f64, round: bool) -> f64 {
        let exp = range.log10().floor();
        let f = range / 10f64.powf(exp);
        let n = if round {
            if f < 1.5 {
                1.0
            } else if f < 3.0 {
                2.0
            } else if f < 7.0 {
                5.0
            } else {
                10.0
            }
        } else if f <= 1.0 {
            1.0
        } else if f <= 2.0 {
            2.0
        } else if f <= 5.0 {
            5.0
        } else {
            10.0
        };
        n * 10f64.powf(exp)
    }
    let (min, max) = if (max - min).abs() < 1e-9 {
        (min - 1.0, max + 1.0)
    } else {
        (min, max)
    };
    let mut spacing = nice(nice(max - min, false) / 10.0, true);
    let spaces = (max / spacing).ceil() - (min / spacing).floor();
    if spaces > 10.0 {
        spacing = nice(spaces * spacing / 10.0, true);
    }
    (
        (min / spacing).floor() * spacing,
        (max / spacing).ceil() * spacing,
        spacing,
    )
}

fn dashed(points: &[[f32; 2]], on: f32, off: f32) -> Vec<Vec<[f32; 2]>> {
    let mut out = Vec::new();
    let mut cur: Vec<[f32; 2]> = Vec::new();
    let mut phase = 0.0f32;
    let mut drawing = true;
    for w in points.windows(2) {
        let (a, b) = (w[0], w[1]);
        let len = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
        let mut pos = 0.0;
        while pos < len {
            let limit = if drawing { on } else { off };
            let step = (limit - phase).min(len - pos);
            let p0 = [
                a[0] + (b[0] - a[0]) * pos / len.max(1e-6),
                a[1] + (b[1] - a[1]) * pos / len.max(1e-6),
            ];
            pos += step;
            phase += step;
            let p1 = [
                a[0] + (b[0] - a[0]) * pos / len.max(1e-6),
                a[1] + (b[1] - a[1]) * pos / len.max(1e-6),
            ];
            if drawing {
                if cur.is_empty() {
                    cur.push(p0);
                }
                cur.push(p1);
            }
            if phase >= limit - 1e-4 {
                phase = 0.0;
                if drawing && cur.len() > 1 {
                    out.push(std::mem::take(&mut cur));
                }
                cur.clear();
                drawing = !drawing;
            }
        }
    }
    if cur.len() > 1 {
        out.push(cur);
    }
    out
}

fn approx_w(text: &str, size: f32) -> f32 {
    text.chars()
        .map(|c| match c {
            '1' | 'i' | 'l' | '.' | ',' | ':' | ' ' => 0.42,
            'u' | 'r' | 't' | 's' => 0.52,
            _ => 0.6,
        })
        .sum::<f32>()
        * size
}

fn chart(s: &State, k: &Ink, spec: ChartSpec) -> El {
    let w = s
        .tactics
        .widths
        .get(spec.key)
        .copied()
        .unwrap_or(700.0)
        .max(200.0);
    let h = spec.height;
    // Y range from visible data.
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for sr in spec.series.iter().filter(|sr| !sr.hidden) {
        for (x, y) in &sr.points {
            if let Some(y) = y {
                if *x >= spec.x_min - 1e-9 && *x <= spec.x_max + 1e-9 {
                    lo = lo.min(*y);
                    hi = hi.max(*y);
                }
            }
        }
    }
    if let Some((pts, _)) = &spec.scatter {
        for (_, y) in pts {
            lo = lo.min(*y);
            hi = hi.max(*y);
        }
    }
    if !lo.is_finite() {
        lo = 0.0;
        hi = 1.0;
    }
    if spec.begin_at_zero {
        lo = lo.min(0.0);
    }
    let g = (hi - lo).abs() * spec.grace;
    let (y_min, y_max, step) = nice_ticks(
        lo - if spec.begin_at_zero && lo == 0.0 {
            0.0
        } else {
            g
        },
        hi + g,
    );
    let mut ticks = Vec::new();
    let mut v = y_min;
    while v <= y_max + step * 1e-6 {
        ticks.push(if v.abs() < step * 1e-6 { 0.0 } else { v });
        v += step;
    }
    let label_w = ticks
        .iter()
        .map(|v| approx_w(&(spec.y_fmt)(*v), 12.0))
        .fold(0.0f32, f32::max);
    let legend_h = if spec.legend { 32.0 } else { 0.0 };
    let x_lines = spec.x_ticks.first().map(|t| t.1.len()).unwrap_or(1) as f32;
    let left = 22.0 + label_w + 11.0;
    let right = 20.0;
    let top = legend_h + 7.0;
    let bottom = x_lines * 14.4 + 11.0 + if spec.x_title.is_some() { 22.0 } else { 0.0 };
    let pw = (w - left - right).max(10.0);
    let ph = (h - top - bottom).max(10.0);
    let span = (spec.x_max - spec.x_min).max(1e-6);
    let px = |x: f64| left + ((x - spec.x_min) / span) as f32 * pw;
    let py = |y: f64| top + ph - ((y - y_min) / (y_max - y_min).max(1e-9)) as f32 * ph;

    let mut back = Shape::new();
    for (a, b) in &spec.bands {
        let (x0, x1) = (px(*a).max(left), px(*b).min(left + pw));
        if x1 > x0 {
            back = back.fill(
                vec![[x0, top], [x1, top], [x1, top + ph], [x0, top + ph]],
                k.surface2,
            );
        }
    }
    for (x, _) in &spec.x_ticks {
        let xx = px(*x);
        back = back.line([xx, top], [xx, top + ph + 8.0], 1.0, LineCap::Butt, k.grid);
    }
    for v in &ticks {
        let yy = py(*v);
        let zero = spec.zero_line && *v == 0.0;
        back = back.line(
            [left - 8.0, yy],
            [left + pw, yy],
            if zero { 1.5 } else { 1.0 },
            LineCap::Butt,
            if zero { k.line2 } else { k.grid },
        );
    }
    if let Some(now) = spec.now {
        let xx = px(now);
        if xx >= left && xx <= left + pw {
            for seg in dashed(&[[xx, top], [xx, top + ph]], 3.0, 3.0) {
                back = back.stroke(seg, 1.0, k.muted);
            }
        }
    }
    let mut shape = back;
    if let Some((pts, color)) = &spec.scatter {
        for (x, y) in pts {
            let (xx, yy) = (px(*x), py(*y));
            shape = shape.line([xx, yy], [xx + 0.01, yy], 4.0, LineCap::Round, *color);
        }
    }
    // Chart.js draws the first dataset on top: paint in reverse.
    for sr in spec.series.iter().rev().filter(|sr| !sr.hidden) {
        let mut runs: Vec<Vec<[f32; 2]>> = vec![Vec::new()];
        for (x, y) in &sr.points {
            match y {
                Some(y) if *x >= spec.x_min - span * 0.02 && *x <= spec.x_max + span * 0.02 => {
                    runs.last_mut().unwrap().push([px(*x), py(*y)])
                }
                Some(_) => {}
                None => runs.push(Vec::new()),
            }
        }
        for run in runs.iter().filter(|r| !r.is_empty()) {
            let clipped: Vec<[f32; 2]> = run
                .iter()
                .map(|p| [p[0].clamp(left, left + pw), p[1]])
                .collect();
            match sr.dash.filter(|_| sr.width > 0.0) {
                Some((on, off)) => {
                    for seg in dashed(&clipped, on, off) {
                        shape = shape.stroke(seg, sr.width, sr.color);
                    }
                }
                None if sr.width > 0.0 && clipped.len() > 1 => {
                    shape = shape.stroke(clipped.clone(), sr.width, sr.color)
                }
                None => {}
            }
            if sr.dots > 0.0 {
                for p in &clipped {
                    shape = shape.line(
                        *p,
                        [p[0] + 0.01, p[1]],
                        sr.dots * 2.0 + 3.0,
                        LineCap::Round,
                        k.card,
                    );
                    shape = shape.line(
                        *p,
                        [p[0] + 0.01, p[1]],
                        sr.dots * 2.0,
                        LineCap::Round,
                        sr.color,
                    );
                }
            }
        }
    }
    let mut card = el()
        .key(format!("tac-chart-{}", spec.key))
        // The chart redraws to the width it measures: that lands at once, never drifts.
        .instant_changes()
        .w_full()
        .h(h)
        .min_w(0.0)
        .child(canvas(shape).size(w, h).absolute(0.0, 0.0));
    let key = spec.key;
    card = card.on_layout(move |s: &mut State, r| {
        let old = s.tactics.widths.get(key).copied().unwrap_or(0.0);
        if (old - r[2]).abs() > 0.5 {
            s.tactics.widths.insert(key, r[2]);
        }
    });
    let slots: Vec<_> = spec
        .x_ticks
        .iter()
        .map(|(x, lines)| LabelSlot::new(px(*x), lines.iter().map(String::as_str), font(12.0, 400.0)))
        .collect();
    for i in visible_labels(&slots) {
        let slot = &slots[i];
        let mut c = col()
            .w(slot.width)
            .items_center()
            .absolute(slot.x - slot.width / 2.0, top + ph + 11.0);
        for l in &spec.x_ticks[i].1 {
            c = c.child(
                row()
                    .h(14.4)
                    .center_y()
                    .child(t(l.clone(), 12.0, 400.0, k.muted)),
            );
        }
        card = card.child(c);
    }
    for v in &ticks {
        card = card.child(
            row()
                .w(left - 11.0 - 22.0 + 20.0)
                .h(14.4)
                .justify_end()
                .center_y()
                .absolute(2.0, py(*v) - 7.2)
                .child(t((spec.y_fmt)(*v), 12.0, 400.0, k.muted)),
        );
    }
    card = card.child(
        row()
            .w(ph)
            .h(16.0)
            .justify_center()
            .center_y()
            .absolute(11.0 - ph / 2.0, top + ph / 2.0 - 8.0)
            .rotate(-std::f32::consts::FRAC_PI_2)
            .child(t(spec.y_title.clone(), 12.0, 500.0, k.muted)),
    );
    if let Some(xt) = &spec.x_title {
        card = card.child(
            row()
                .w(pw)
                .h(16.0)
                .justify_center()
                .absolute(left, h - 18.0)
                .child(t(xt.clone(), 12.0, 500.0, k.muted)),
        );
    }
    for (a, b) in &spec.bands {
        let x0 = px(*a).max(left);
        if px(*b) > x0 && x0 < left + pw - 20.0 {
            card = card.child(t("nacht", 11.0, 500.0, k.muted).absolute(x0 + 8.0, top + 6.0));
        }
    }
    if let Some(now) = spec.now {
        let xx = px(now);
        if xx >= left && xx <= left + pw {
            let x = if xx > left + pw - 30.0 {
                xx - 20.0
            } else {
                xx + 5.0
            };
            card = card.child(t("nu", 11.0, 600.0, k.muted).absolute(x, top + 6.0));
        }
    }
    if spec.legend {
        let mut lg = row()
            .gap(10.0)
            .center_y()
            .justify_center()
            .w(w)
            .h(32.0)
            .absolute(0.0, 0.0);
        if let Some((_, c)) = &spec.scatter {
            lg = lg.child(legend_item(k, c.alpha(0.35), "", None));
        }
        for sr in &spec.series {
            lg = lg.child(legend_item(k, sr.color, &sr.label, sr.dash));
        }
        card = card.child(lg);
    }
    card
}

fn legend_item(k: &Ink, color: Color, label: &str, _dash: Option<(f32, f32)>) -> El {
    row()
        .gap(10.0)
        .center_y()
        .child(
            el().size(14.0, 12.0)
                .fill(color.alpha(0.5))
                .border(2.0, color),
        )
        .child(t(label, 12.0, 500.0, k.chart_text))
}

fn hour_ticks(
    step: f64,
    min: f64,
    max: f64,
    lines: impl Fn(f64) -> Vec<String>,
) -> Vec<(f64, Vec<String>)> {
    let mut v = Vec::new();
    let mut x = (min / step - 1e-9).ceil() * step;
    while x <= max + 1e-9 {
        let r = (x * 1000.0).round() / 1000.0;
        v.push((r, lines(r)));
        x += step;
    }
    v
}

fn plain_hour_ticks() -> Vec<(f64, Vec<String>)> {
    hour_ticks(2.0, 0.0, 24.0, |x| vec![format!("{}u", x as i64)])
}

// ---------- Page ----------

pub(super) fn page(s: &State) -> El {
    let k = ink(s.dark);
    let p = &s.tactics;
    let mut nav = row().role("navigation").label("Tactiekonderdeel").gap(20.0);
    for (i, name) in ["Live race & doelverloop", "Analyse vorig jaar"]
        .iter()
        .enumerate()
    {
        let active = p.section == i as u8;
        nav = nav.child(
            col()
                .key(format!("tac-section-{i}"))
                .role("button")
                .label(name.to_string())
                .checked(active)
                .focusable(true)
                .h(38.0)
                .on_press(move |s: &mut State| {
                    s.tactics.section = i as u8;
                    s.tactics.open = None;
                })
                .child(row().grow(1.0).center_y().child(t(
                    *name,
                    13.5,
                    500.0,
                    if active { k.text } else { k.ink3 },
                )))
                .child(el().h(2.0).w_full().mb(-1.0).fill(if active {
                    k.text
                } else {
                    k.text.alpha(0.0)
                })),
        );
    }
    let mut page = col().gap(0.0).pt(0.0).pb(24.0).min_w(0.0);
    if s.history["laps"].is_null() && s.history.get("error").is_some() {
        page = page.child(
            t(
                format!(
                    "De live racegegevens konden niet worden geladen: {}",
                    s.history["error"].as_str().unwrap_or("")
                ),
                13.0,
                500.0,
                k.warn_ink,
            )
            .role("alert"),
        );
    }
    page = page
        .child(col().child(nav).child(el().h(1.0).w_full().fill(k.line)))
        .child(el().h(16.0));
    page.child(if p.section == 0 {
        live(s, &k)
    } else {
        historical(s, &k)
    })
}

fn live(s: &State, k: &Ink) -> El {
    let p = &s.tactics;
    let race = &s.snapshot["race"];
    let Some(start) = race["raceStartedAt"].as_f64() else {
        return panel(k)
            .min_h(260.0)
            .items_center()
            .justify_center()
            .gap(4.0)
            .child(shell::icon("tactics", s.dark, 3, 28.0).mb(12.0))
            .child(t("Live race", 12.5, 400.0, k.ink3))
            .child(t("Start eerst de wedstrijd", 14.0, 600.0, k.text))
            .child(t(
                "Zodra de race gestart is, verschijnen de live vergelijking en het doelverloop hier automatisch.",
                13.5,
                400.0,
                k.ink3,
            ));
    };
    let (hist, source, hist_error) = race_data(p);
    let own = hist.and_then(|r| r.team(APOLLOON));
    let rival = hist.and_then(|r| r.team(VTK));
    let now = race["raceFinishedAt"].as_f64().unwrap_or(s.clock as f64);
    let elapsed = ((now - start) / 3_600_000.0).clamp(0.0, HOURS as f64);
    let (min_s, max_s, recent) = (p.vals[MIN_S], p.vals[MAX_S], p.vals[RECENT] as usize);
    let clean = valid_laps(s, start, min_s, max_s);
    let all_count = laps(s).len();
    let suspicious = all_count.saturating_sub(clean.len());
    let paces = target_paces(p);
    let expected = target_laps_at(&paces, elapsed);
    let recent_d: Vec<f64> = clean
        .iter()
        .skip(clean.len().saturating_sub(recent.max(1)))
        .map(|l| l.dur / 1000.0)
        .collect();
    let current = median(&recent_d);
    let spread = pace_uncertainty(&recent_d);
    let n = clean.len() as f64;
    let range = (
        projected_laps(n, elapsed, &paces, spread),
        projected_laps(n, elapsed, &paces, 0.0),
        projected_laps(n, elapsed, &paces, -spread),
    );
    let recent_projection = current.map(|c| projected_laps(n, elapsed, &vec![c; HOURS], 0.0));
    let own_now = historical_laps_at(own, elapsed);
    let rival_now = historical_laps_at(rival, elapsed);

    let mut stack = col().gap(16.0).min_w(0.0);
    if hist.is_none() {
        stack = stack.child(reference_notice(s, k, hist_error.as_deref(), false));
    }
    stack = stack.child(stats_grid(
        k,
        "Live tactiek kerncijfers",
        vec![
            stat(
                k,
                "Rondes nu",
                &clean.len().to_string(),
                None,
                &format!("{} onderweg", race_hour(elapsed)),
                None,
            ),
            stat(
                k,
                "Verschil met planning",
                &signed_laps(Some(n - expected)),
                Some("rondes"),
                &format!("{} verwacht op dit moment", nl(expected, 1, true)),
                None,
            ),
            stat(
                k,
                "Verwachte eindstand",
                &nl(range.1.round(), 0, false),
                None,
                &format!(
                    "{}–{} bij ±{} s op het tempo",
                    range.0.round(),
                    range.2.round(),
                    nl(spread, 1, true)
                ),
                None,
            ),
            stat(
                k,
                &format!("Tempo laatste {recent}"),
                &pace(current),
                None,
                &match recent_projection {
                    Some(r) => format!("{} rondes bij dit tempo", r.round()),
                    None => format!(
                        "{suspicious} verdachte ronde{} genegeerd",
                        if suspicious == 1 { "" } else { "s" }
                    ),
                },
                None,
            ),
            stat(
                k,
                "Apolloon vorig jaar",
                &signed_laps(own_now.map(|o| n - o)),
                Some("rondes"),
                &format!("Verschil op hetzelfde moment in {source}"),
                None,
            ),
            stat(
                k,
                "VTK vorig jaar",
                &signed_laps(rival_now.map(|o| n - o)),
                Some("rondes"),
                &format!("Verschil op hetzelfde moment in {source}"),
                None,
            ),
        ],
    ));
    let forecast = panel(k)
        .grow(1.0)
        .w(0.0)
        .child(section_header(
            k,
            "Live tegenover doel en vorig jaar",
            "Hoeveel rondes je voor of achter staat, en per uur waar het verschil ontstaat.",
        ))
        .child(timeline(s, k, &clean, start, elapsed, &paces, own, rival));
    stack = stack.child(
        row()
            .gap(16.0)
            .items_start()
            .min_w(0.0)
            .child(forecast)
            .child(scenario(s, k, own.is_some(), rival.is_some())),
    );
    stack = stack.child(hour_editor(s, k, start, elapsed, &paces));
    stack = stack.child(analysis_details(
        s, k, &clean, start, elapsed, &paces, own, rival,
    ));
    if let Some(race) = hist {
        stack = stack.child(dataset_manager(
            k,
            &source,
            race.teams.len(),
            hist_error.as_deref(),
        ));
    }
    stack
}

fn scenario(s: &State, k: &Ink, has_own: bool, has_rival: bool) -> El {
    let p = &s.tactics;
    let group_label = |v: &str| {
        text(v.to_string())
            .font(font(13.0, 600.0).lh(19.5))
            .color(k.ink3)
            .mt(8.0)
    };
    let goal = font(22.0, 600.0);
    col()
        .w(320.0)
        .min_w(320.0)
        .padding(16.0)
        .radius(8.0)
        .fill(k.card)
        .border(1.0, k.line)
        .child(section_header(
            k,
            "Doelverloop",
            "Einddoel en verloop als basis. Per uur aanpassen kan onder de grafiek.",
        ))
        .child(
            col()
                .gap(12.0)
                .mb(16.0)
                .child(group_label("Doelstelling"))
                .child(field(
                    k,
                    &format!(
                        "Rondes na 24 uur, gemiddeld {}",
                        pace(Some(86_400.0 / p.vals[TARGET].max(1.0)))
                    ),
                    num_input(
                        s,
                        k,
                        TARGET,
                        &format!(
                            "Rondes na 24 uur, gemiddeld {}",
                            pace(Some(86_400.0 / p.vals[TARGET].max(1.0)))
                        ),
                        goal,
                        34.0,
                    ),
                ))
                .child(field(
                    k,
                    "Verloop als basis",
                    select(
                        s,
                        k,
                        "tac-profile",
                        "Verloop als basis",
                        vec![
                            ("Gelijkmatig tempo".into(), true),
                            ("Apolloon vorig jaar".into(), has_own),
                            ("VTK vorig jaar".into(), has_rival),
                        ],
                        p.profile as usize,
                        34.0,
                        13.5,
                        Rc::new(|s: &mut State, i| {
                            s.tactics.scenario_edited = true;
                            s.tactics.paces_edited = false;
                            s.tactics.profile = i as u8;
                        }),
                    ),
                ))
                .child(group_label("Geldige rondes"))
                .child(field(
                    k,
                    "Rondes voor huidig tempo",
                    num_input(
                        s,
                        k,
                        RECENT,
                        "Rondes voor huidig tempo",
                        font(13.5, 400.0),
                        34.0,
                    ),
                ))
                .child(
                    row()
                        .gap(8.0)
                        .child(
                            field(
                                k,
                                "Kortste (s)",
                                num_input(s, k, MIN_S, "Kortste (s)", font(13.5, 400.0), 34.0),
                            )
                            .grow(1.0)
                            .w(0.0),
                        )
                        .child(
                            field(
                                k,
                                "Langste (s)",
                                num_input(s, k, MAX_S, "Langste (s)", font(13.5, 400.0), 34.0),
                            )
                            .grow(1.0)
                            .w(0.0),
                        ),
                ),
        )
}

#[allow(clippy::too_many_arguments)]
fn timeline(
    s: &State,
    k: &Ink,
    clean: &[Lap],
    start: f64,
    elapsed: f64,
    paces: &[f64],
    own: Option<&Team>,
    rival: Option<&Team>,
) -> El {
    let p = &s.tactics;
    let has = [true, true, own.is_some(), rival.is_some()];
    let baseline = if !has[p.baseline as usize] {
        1
    } else {
        p.baseline as usize
    };
    let labels = [
        "Apolloon live",
        "Doelverloop",
        "Apolloon vorig jaar",
        "VTK vorig jaar",
    ];
    let short = [
        "Apolloon live",
        "het doel",
        "Apolloon vorig jaar",
        "VTK vorig jaar",
    ];
    let colors = [k.live, k.target, k.own, k.rival];
    let (w_min, w_max) = match p.window {
        Window::Full => (0.0, 24.0),
        Window::Custom(a, b) => (a, b),
        Window::Recent(h) => {
            let end = elapsed.max(h).min(24.0);
            (end - h, end)
        }
    };
    // Series values per minute or per hour.
    let offsets: Vec<f64> = clean
        .iter()
        .map(|l| l.finished - start)
        .filter(|o| *o >= 0.0)
        .collect();
    let last = offsets.last().copied().unwrap_or(-1.0);
    let values = |key: usize, ms: f64| -> Option<f64> {
        match key {
            0 => (ms <= last).then(|| interpolated(&offsets, ms)),
            1 => Some(target_laps_at(paces, ms / 3_600_000.0)),
            2 => own.map(|t| interpolated(&t.cum, ms)),
            _ => rival.map(|t| interpolated(&t.cum, ms)),
        }
    };
    let mut series = Vec::new();
    for key in (0..4).filter(|k| has[*k]) {
        let points: Vec<(f64, Option<f64>)> = if p.view == 1 {
            (0..HOURS)
                .map(|h| {
                    let y = match key {
                        0 => (h as f64 + 1.0 <= elapsed).then(|| {
                            clean
                                .iter()
                                .filter(|l| {
                                    ((l.finished - start) / 3_600_000.0).floor() as usize == h
                                        && l.finished >= start
                                })
                                .count() as f64
                        }),
                        1 => Some(3600.0 / valid_pace(paces.get(h).copied())),
                        2 | 3 => (if key == 2 { own } else { rival }).map(|t| {
                            (upper_bound(&t.cum, (h as f64 + 1.0) * 3_600_000.0)
                                - upper_bound(&t.cum, h as f64 * 3_600_000.0))
                                as f64
                        }),
                        _ => None,
                    };
                    (h as f64 + 0.5, y)
                })
                .collect()
        } else {
            (0..=HOURS * 60)
                .map(|m| {
                    let ms = m as f64 * 60_000.0;
                    let v = values(key, ms);
                    let y = if p.view == 2 {
                        v
                    } else {
                        v.zip(values(baseline, ms)).map(|(a, b)| a - b)
                    };
                    (m as f64 / 60.0, y)
                })
                .collect()
        };
        series.push(Series {
            label: labels[key].into(),
            color: colors[key],
            width: if key == 0 { 3.0 } else { 2.0 },
            dash: (key == 1).then_some((6.0, 5.0)),
            points,
            dots: if p.view == 1 { 3.5 } else { 0.0 },
            hidden: p.hidden[key],
        });
    }
    let sparks: Vec<(Color, Vec<(f64, f64)>)> = {
        let vis: Vec<&Series> = series.iter().filter(|s| !s.hidden).collect();
        let ys: Vec<f64> = vis
            .iter()
            .flat_map(|s| s.points.iter().filter_map(|p| p.1))
            .collect();
        if ys.is_empty() {
            Vec::new()
        } else {
            let lo = ys.iter().copied().fold(f64::INFINITY, f64::min);
            let hi = ys.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            let r = (hi - lo).max(1e-6);
            vis.iter()
                .map(|sr| {
                    (
                        sr.color,
                        sr.points
                            .iter()
                            .enumerate()
                            .filter(|(i, p)| p.1.is_some() && (sr.points.len() < 100 || i % 5 == 0))
                            .map(|(_, p)| (p.0 / 24.0, (p.1.unwrap() - lo) / r))
                            .collect(),
                    )
                })
                .collect()
        }
    };
    let is_gap = p.view == 0;
    let step = {
        let span = w_max - w_min;
        if span >= 12.0 {
            2.0
        } else if span >= 6.0 {
            1.0
        } else if span >= 3.0 {
            0.5
        } else if span >= 1.5 {
            0.25
        } else {
            1.0 / 6.0
        }
    };
    let now = (elapsed < 24.0).then_some(elapsed);
    let nights = night_ranges(start);
    let spec = ChartSpec {
        key: "timeline",
        height: 420.0,
        x_min: w_min,
        x_max: w_max,
        x_ticks: hour_ticks(step, w_min, w_max, |x| {
            vec![race_hour(x), race_clock(start, x)]
        }),
        x_title: None,
        y_title: if is_gap {
            format!("Rondes t.o.v. {}", short[baseline])
        } else if p.view == 1 {
            "Rondes per uur".into()
        } else {
            "Rondes".into()
        },
        y_fmt: Box::new(move |v| lap_value(v, is_gap)),
        grace: if is_gap { 0.12 } else { 0.06 },
        begin_at_zero: false,
        zero_line: is_gap,
        legend: false,
        series,
        bands: nights.clone(),
        now,
        scatter: None,
    };
    let chart_w = s.tactics.widths.get("timeline").copied().unwrap_or(700.0);

    // Toolbar.
    let views = segmented(
        k,
        "tac-view",
        "Weergave",
        &["Voor of achter", "Rondes per uur", "Totaal"],
        Some(p.view as usize),
        Rc::new(|s: &mut State, i| s.tactics.view = i as u8),
    );
    let preset = match p.window {
        Window::Full => Some(0),
        Window::Recent(h) if h == 3.0 => Some(1),
        Window::Recent(_) => Some(2),
        Window::Custom(..) => None,
    };
    let presets = segmented(
        k,
        "tac-window",
        "Tijdvenster",
        &["Hele race", "Laatste 3 u", "Laatste uur"],
        preset,
        Rc::new(|s: &mut State, i| {
            s.tactics.window = match i {
                0 => Window::Full,
                1 => Window::Recent(3.0),
                _ => Window::Recent(1.0),
            }
        }),
    );
    let mut first = row().gap(16.0).center_y().child(views);
    if is_gap {
        let opts: Vec<usize> = (1..4).filter(|i| has[*i]).collect();
        let sel = opts.iter().position(|i| *i == baseline).unwrap_or(0);
        let opts2 = opts.clone();
        first = first.child(
            row()
                .gap(8.0)
                .center_y()
                .child(t("Nullijn", 13.0, 500.0, k.ink3))
                .child(
                    select(
                        s,
                        k,
                        "tac-baseline",
                        "Nullijn",
                        opts.iter()
                            .map(|i| (labels[*i].to_string(), true))
                            .collect(),
                        sel,
                        28.0,
                        13.0,
                        Rc::new(move |s: &mut State, i| s.tactics.baseline = opts2[i] as u8),
                    )
                    .w(170.0),
                ),
        );
    }
    let toolbar = if chart_w >= 820.0 {
        row()
            .gap(16.0)
            .center_y()
            .child(first)
            .child(el().grow(1.0))
            .child(presets)
    } else {
        col()
            .gap(8.0)
            .child(first)
            .child(row().child(el().grow(1.0)).child(presets))
    };
    let mut legend = row()
        .role("group")
        .label("Lijnen tonen of verbergen")
        .gap(4.0);
    for key in (0..4).filter(|k| has[*k]) {
        let on = !p.hidden[key];
        let mut item = row()
            .key(format!("tac-legend-{key}"))
            .role("button")
            .label(labels[key].to_string())
            .checked(on)
            .focusable(true)
            .h(26.0)
            .px(8.0)
            .gap(8.0)
            .center_y()
            .radius(4.0)
            .hover(k.surface2)
            .opacity(if on { 1.0 } else { 0.45 })
            .on_press(move |s: &mut State| s.tactics.hidden[key] = !s.tactics.hidden[key]);
        let sw = if !on {
            el().size(16.0, 3.0).radius(2.0).fill(k.line2)
        } else if key == 1 {
            row()
                .size(16.0, 3.0)
                .gap(3.0)
                .child(el().size(5.0, 3.0).fill(colors[key]))
                .child(el().size(5.0, 3.0).fill(colors[key]))
                .child(el().size(2.0, 3.0).fill(colors[key]))
        } else {
            el().size(16.0, 3.0).radius(2.0).fill(colors[key])
        };
        item = item.child(sw).child(t(labels[key], 13.0, 500.0, k.ink2));
        if is_gap && key == baseline {
            item = item.child(t("nullijn", 12.0, 400.0, k.ink3));
        }
        legend = legend.child(item);
    }
    let left = 22.0 + 20.0 + 11.0 + 4.0;
    let plot_left = left;
    let plot_right = 20.0;
    let span = w_max - w_min;
    let mut plot = chart(s, k, spec)
        .role("img")
        .label(if is_gap {
            format!(
                "Rondes voor of achter op {}, van {} tot {}",
                short[baseline],
                race_hour(w_min),
                race_hour(w_max)
            )
        } else {
            format!(
                "{}, van {} tot {}",
                if p.view == 1 {
                    "Rondes per race-uur"
                } else {
                    "Cumulatieve rondes"
                },
                race_hour(w_min),
                race_hour(w_max)
            )
        })
        .on_drag(move |s: &mut State, d: &mut rune::Drag, _| {
            let pw = (d.w - plot_left - plot_right).max(1.0);
            let x = d.x.clamp(plot_left, plot_left + pw);
            match d.phase {
                rune::Phase::Down => {
                    if d.clicks >= 2 {
                        s.tactics.window = Window::Full;
                        s.tactics.selection = None;
                    } else if d.x >= plot_left && d.x <= plot_left + pw {
                        s.tactics.selection = Some((x, x));
                    }
                }
                rune::Phase::Move => {
                    if let Some(sel) = &mut s.tactics.selection {
                        sel.1 = x;
                    }
                }
                rune::Phase::Up => {
                    if let Some((a, b)) = s.tactics.selection.take() {
                        if (b - a).abs() >= 8.0 && !d.cancelled() {
                            let h = |px: f32| w_min + ((px - plot_left) / pw) as f64 * span;
                            s.tactics.window = custom_window(h(a.min(b)), h(a.max(b)));
                        }
                    }
                }
            }
        });
    if let Some((a, b)) = p.selection {
        plot = plot.child(
            el().absolute(a.min(b), 7.0)
                .size((b - a).abs(), 360.0)
                .fill(k.brand_wash.alpha(0.7))
                .border(1.0, k.brand),
        );
    }
    col()
        .gap(12.0)
        .min_w(0.0)
        .child(toolbar)
        .child(legend)
        .child(plot)
        .child(brush(s, k, start, w_min, w_max, &nights, now, sparks))
}

fn custom_window(min: f64, max: f64) -> Window {
    let a = min.min(max).clamp(0.0, 24.0 - 0.25);
    let b = max.max(a + 0.25).clamp(0.25, 24.0);
    if a <= 0.0 && b >= 24.0 {
        Window::Full
    } else {
        Window::Custom(a, b)
    }
}

fn lap_value(v: f64, signed: bool) -> String {
    let r = (v * 10.0).round() / 10.0;
    let txt = nl(r.abs(), 1, false);
    if !signed || r == 0.0 {
        return if r < 0.0 { format!("−{txt}") } else { txt };
    }
    format!("{}{txt}", if r > 0.0 { "+" } else { "−" })
}

#[allow(clippy::too_many_arguments)]
fn brush(
    s: &State,
    k: &Ink,
    start: f64,
    w_min: f64,
    w_max: f64,
    nights: &[(f64, f64)],
    now: Option<f64>,
    sparks: Vec<(Color, Vec<(f64, f64)>)>,
) -> El {
    let chart_w = s.tactics.widths.get("timeline").copied().unwrap_or(700.0);
    let (pl, pr) = (57.0, 20.0);
    let tw = (chart_w - pl - pr).max(10.0);
    let zoomed = w_min > 0.0 || w_max < 24.0;
    let x = |h: f64| (h / 24.0) as f32 * tw;
    let mut shape = Shape::new();
    for (a, b) in nights {
        shape = shape.fill(
            vec![[x(*a), 0.0], [x(*b), 0.0], [x(*b), 44.0], [x(*a), 44.0]],
            k.surface2,
        );
    }
    for (c, pts) in &sparks {
        let line: Vec<[f32; 2]> = pts
            .iter()
            .map(|(fx, fy)| {
                [
                    *fx as f32 * tw,
                    3.0 + (37.0 - *fy as f32 * 34.0) * 38.0 / 40.0,
                ]
            })
            .collect();
        if line.len() > 1 {
            shape = shape.stroke(line, 1.5, *c);
        }
    }
    if let Some(n) = now {
        for seg in dashed(&[[x(n), 0.0], [x(n), 44.0]], 3.0, 3.0) {
            shape = shape.stroke(seg, 1.0, k.ink3);
        }
    }
    if zoomed {
        let veil = k.card.alpha(0.55);
        shape = shape
            .fill(
                vec![[0.0, 0.0], [x(w_min), 0.0], [x(w_min), 44.0], [0.0, 44.0]],
                veil,
            )
            .fill(
                vec![[x(w_max), 0.0], [tw, 0.0], [tw, 44.0], [x(w_max), 44.0]],
                veil,
            );
    }
    let mut window = el()
        .key("tac-brush-window")
        .role("slider")
        .label("Zichtbaar tijdvenster")
        .focusable(true)
        .absolute(x(w_min), 0.0)
        .size(x(w_max) - x(w_min), 42.0)
        .radius(5.0);
    if zoomed {
        window = window
            .fill(k.brand.alpha(0.1))
            .border(1.0, k.brand)
            .child(
                el().size(4.0, 16.0)
                    .radius(2.0)
                    .fill(k.brand)
                    .absolute(-2.0, 13.0),
            )
            .child(
                el().size(4.0, 16.0)
                    .radius(2.0)
                    .fill(k.brand)
                    .absolute(x(w_max) - x(w_min) - 2.0, 13.0),
            );
    }
    let track = el()
        .key("tac-brush")
        .h(44.0)
        .w_full()
        .radius(6.0)
        .fill(k.card)
        .border(1.0, k.line)
        .clip_rounded(6.0)
        .child(canvas(shape).size(tw, 44.0).absolute(0.0, 0.0))
        .child(window)
        .on_drag(move |s: &mut State, d: &mut rune::Drag, _| {
            let hour = |px: f32| ((px / d.w.max(1.0)) as f64 * 24.0).clamp(0.0, 24.0);
            let (h0, h) = (hour(d.start_x), hour(d.x));
            let (wmin, wmax) = match s.tactics.window {
                Window::Full => (0.0, 24.0),
                Window::Custom(a, b) => (a, b),
                Window::Recent(r) => {
                    let e = (w_max).max(r);
                    (e - r, e)
                }
            };
            match d.phase {
                rune::Phase::Down => {
                    let mode = if (h0 - wmin).abs() * d.w as f64 / 24.0 <= 6.0 {
                        1
                    } else if (h0 - wmax).abs() * d.w as f64 / 24.0 <= 6.0 {
                        2
                    } else if h0 > wmin && h0 < wmax {
                        0
                    } else {
                        3
                    };
                    s.tactics.brush = Some((mode, h0, wmin, wmax));
                }
                rune::Phase::Move => {
                    if let Some((mode, origin, a, b)) = s.tactics.brush {
                        let delta = h - origin;
                        s.tactics.window = match mode {
                            0 => {
                                let m = (a + delta).clamp(0.0, 24.0 - (b - a));
                                custom_window(m, m + (b - a))
                            }
                            1 => custom_window(h.clamp(0.0, b - 0.25), b),
                            2 => custom_window(a, h.clamp(a + 0.25, 24.0)),
                            _ if delta.abs() >= 0.25 => custom_window(origin.min(h), origin.max(h)),
                            _ => s.tactics.window,
                        };
                    }
                }
                rune::Phase::Up => {
                    if let Some((mode, origin, a, b)) = s.tactics.brush.take() {
                        let span = b - a;
                        if mode == 3 && d.dx.abs() < 2.0 && (a > 0.0 || b < 24.0) {
                            let m = (origin - span / 2.0).clamp(0.0, 24.0 - span);
                            s.tactics.window = custom_window(m, m + span);
                        }
                    }
                }
            }
        });
    col().gap(6.0).pl(pl).pr(pr).child(track).child(
        row()
            .gap(16.0)
            .center_y()
            .child(
                row()
                    .gap(6.0)
                    .center_y()
                    .child(t(
                        format!(
                            "{} {}–{}",
                            if zoomed { "Ingezoomd op" } else { "Hele race" },
                            race_hour(w_min),
                            race_hour(w_max)
                        ),
                        12.5,
                        400.0,
                        k.ink2,
                    ))
                    .child(t(
                        format!("{}–{}", race_clock(start, w_min), race_clock(start, w_max)),
                        12.0,
                        400.0,
                        k.ink3,
                    )),
            )
            .child(el().grow(1.0))
            .child(t(
                if zoomed {
                    "Versleep het venster, of dubbelklik op de grafiek om uit te zoomen."
                } else {
                    "Sleep over de grafiek of over deze strook om in te zoomen."
                },
                12.5,
                400.0,
                k.ink3,
            )),
    )
}

fn hour_editor(s: &State, k: &Ink, start: f64, elapsed: f64, _paces: &[f64]) -> El {
    let p = &s.tactics;
    let open = p.hour_open;
    let mut d = col()
        .min_w(0.0)
        .px(16.0)
        .pt(12.0)
        .pb(if open { 16.0 } else { 12.0 })
        .radius(8.0)
        .fill(k.card)
        .border(1.0, k.line)
        .role("group")
        .child(
            row()
                .key("tac-hour-toggle")
                .role("button")
                .label("Doeltempo per uur aanpassen")
                .expanded(open)
                .focusable(true)
                .py(6.0)
                .gap(8.0)
                .center_y()
                .on_press(|s: &mut State| s.tactics.hour_open = !s.tactics.hour_open)
                .child(chevron(k.ink3, open))
                .child(t("Doeltempo per uur aanpassen", 14.0, 550.0, k.text)),
        );
    if !open {
        return d;
    }
    d = d.child(
        row()
            .my(12.0)
            .gap(12.0)
            .center_y()
            .child(
                col()
                    .grow(1.0)
                    .gap(2.0)
                    .child(t("Doeltempo per race-uur", 14.0, 600.0, k.text))
                    .child(t(
                        "Seconden per ronde. Wijzig een uur om het scenario meteen door te rekenen.",
                        13.5,
                        400.0,
                        k.ink3,
                    )),
            )
            .child(ghost_button(k, "tac-recompute", "Herbereken uit profiel", |s: &mut State| {
                s.tactics.paces_edited = false;
            })),
    );
    let mut grid = col().gap(8.0);
    for r in 0..2 {
        let mut line = row().gap(8.0);
        for c in 0..12 {
            let h = r * 12 + c;
            let id = HOUR + h;
            let focused = p.edits[id].focused;
            let past = h as f64 + 1.0 <= elapsed;
            line = line.child(
                col()
                    .grow(1.0)
                    .w(0.0)
                    .min_w(0.0)
                    .gap(4.0)
                    .padding(8.0)
                    .radius(6.0)
                    .fill(if past { k.surface2 } else { k.card })
                    .border(1.0, if focused { k.brand } else { k.line })
                    .child(
                        t(hour_window(start, h), 11.5, 600.0, k.ink3)
                            .truncate()
                            .min_w(0.0),
                    )
                    .child(
                        row()
                            .gap(4.0)
                            .center_y()
                            .child(
                                col()
                                    .grow(1.0)
                                    .min_w(0.0)
                                    .child(
                                        text_input(&p.edits[id], font(17.0, 600.0))
                                            .key(format!("tac-num-{id}"))
                                            .label(hour_window(start, h))
                                            .h(28.0)
                                            .color(k.text)
                                            .on_edit(move |s: &mut State| &mut s.tactics.edits[id])
                                            .on_input_change(move |s: &mut State, _| {
                                                typed(&mut s.tactics, id)
                                            })
                                            .on_submit(move |s: &mut State, _| {
                                                commit(&mut s.tactics, id)
                                            }),
                                    )
                                    .child(el().h(1.0).w_full().fill(if focused {
                                        k.brand
                                    } else {
                                        k.line2
                                    })),
                            )
                            .child(t("s", 11.5, 400.0, k.ink3)),
                    ),
            );
        }
        grid = grid.child(line);
    }
    d.child(grid)
}

#[allow(clippy::too_many_arguments)]
fn analysis_details(
    s: &State,
    k: &Ink,
    clean: &[Lap],
    start: f64,
    elapsed: f64,
    paces: &[f64],
    own: Option<&Team>,
    rival: Option<&Team>,
) -> El {
    let p = &s.tactics;
    let open = p.analysis_open;
    let mut d = col()
        .min_w(0.0)
        .mt(8.0)
        .pt(12.0)
        .child(el().h(1.0).w_full().fill(k.line).absolute(0.0, 0.0))
        .child(
            row()
                .key("tac-analysis-toggle")
                .role("button")
                .label("Tempotrends, vergelijking & rondecontrole")
                .expanded(open)
                .focusable(true)
                .pt(6.0)
                .pb(12.0)
                .gap(8.0)
                .center_y()
                .on_press(|s: &mut State| s.tactics.analysis_open = !s.tactics.analysis_open)
                .child(chevron(k.ink3, open))
                .child(t(
                    "Tempotrends, vergelijking & rondecontrole",
                    14.0,
                    550.0,
                    k.text,
                )),
        );
    if !open {
        return d;
    }
    // Hourly pace comparison.
    let own_p = hourly_historical_paces(own);
    let rival_p = hourly_historical_paces(rival);
    let mut live_by_hour = vec![Vec::new(); HOURS];
    for l in clean {
        let h = ((l.finished - start) / 3_600_000.0).floor();
        if h >= 0.0 && (h as usize) < HOURS {
            live_by_hour[h as usize].push(l.dur / 1000.0);
        }
    }
    let hourly = |v: Vec<Option<f64>>| -> Vec<(f64, Option<f64>)> {
        v.into_iter()
            .enumerate()
            .map(|(h, y)| (h as f64 + 0.5, y))
            .collect()
    };
    let pace_series = vec![
        Series {
            label: "Werkelijk live".into(),
            color: k.live,
            width: 4.0,
            dash: None,
            points: hourly(live_by_hour.iter().map(|d| median(d)).collect()),
            dots: 3.0,
            hidden: false,
        },
        Series {
            label: "Doeltempo".into(),
            color: k.target,
            width: 2.0,
            dash: Some((8.0, 6.0)),
            points: hourly(paces.iter().map(|p| Some(*p)).collect()),
            dots: 3.0,
            hidden: false,
        },
        Series {
            label: "Apolloon vorig jaar".into(),
            color: k.own,
            width: 2.0,
            dash: None,
            points: hourly(own_p),
            dots: 3.0,
            hidden: false,
        },
        Series {
            label: "VTK vorig jaar".into(),
            color: k.rival,
            width: 2.0,
            dash: None,
            points: hourly(rival_p),
            dots: 3.0,
            hidden: false,
        },
    ];
    let shared = |key: &'static str,
                  title: &str,
                  series: Vec<Series>,
                  f: Box<dyn Fn(f64) -> String>| ChartSpec {
        key,
        height: 420.0,
        x_min: 0.0,
        x_max: 24.0,
        x_ticks: plain_hour_ticks(),
        x_title: Some("Uren sinds de start".into()),
        y_title: title.into(),
        y_fmt: f,
        grace: 0.0,
        begin_at_zero: false,
        zero_line: false,
        legend: true,
        series,
        bands: Vec::new(),
        now: None,
        scatter: None,
    };
    d = d.child(
        panel(k)
            .child(section_header(
                k,
                "Gepland en werkelijk tempo per uur",
                "Lager is sneller. Zo zie je per uur waar het plan gewonnen of verloren wordt.",
            ))
            .child(chart(
                s,
                k,
                shared(
                    "pace",
                    "Mediaan rondetijd",
                    pace_series,
                    Box::new(|v| pace(Some(v))),
                ),
            )),
    );
    // Quarter-hour trend.
    let mut live_q = Vec::new();
    let mut own_q = Vec::new();
    let mut rival_q = Vec::new();
    for q in 0..96 {
        let h = q as f64 * 0.25;
        let d: Vec<f64> = clean
            .iter()
            .filter(|l| {
                let lh = (l.finished - start) / 3_600_000.0;
                lh >= h && lh < h + 0.25
            })
            .map(|l| l.dur / 1000.0)
            .collect();
        let x = h + 0.125;
        live_q.push((x, if h <= elapsed { median(&d) } else { None }));
        own_q.push((
            x,
            own.and_then(|t| median(&durations_in_window(t, h, h + 0.25))),
        ));
        rival_q.push((
            x,
            rival.and_then(|t| median(&durations_in_window(t, h, h + 0.25))),
        ));
    }
    let span_gaps = |v: Vec<(f64, Option<f64>)>| -> Vec<(f64, Option<f64>)> {
        v.into_iter().filter(|p| p.1.is_some()).collect()
    };
    d = d.child(
        panel(k)
            .child(section_header(
                k,
                "Live tempo tegenover vorig jaar",
                "Mediaan per kwartier, tegenover Apolloon en VTK vorig jaar.",
            ))
            .child(chart(
                s,
                k,
                shared(
                    "trend",
                    "Mediaan rondetijd per kwartier",
                    vec![
                        Series {
                            label: "Apolloon live".into(),
                            color: k.live,
                            width: 4.0,
                            dash: None,
                            points: span_gaps(live_q),
                            dots: 0.0,
                            hidden: false,
                        },
                        Series {
                            label: "Apolloon vorig jaar".into(),
                            color: k.own,
                            width: 2.0,
                            dash: Some((7.0, 5.0)),
                            points: span_gaps(own_q),
                            dots: 0.0,
                            hidden: false,
                        },
                        Series {
                            label: "VTK vorig jaar".into(),
                            color: k.rival,
                            width: 2.0,
                            dash: Some((7.0, 5.0)),
                            points: span_gaps(rival_q),
                            dots: 0.0,
                            hidden: false,
                        },
                    ],
                    Box::new(|v| pace(Some(v))),
                ),
            )),
    );
    // Time gap on VTK.
    let gap = rival_time_gap(clean, start, elapsed, paces, rival);
    let mut gap_panel = panel(k).child(section_header(
        k,
        "Werkelijk en voorspeld verschil met VTK vorig jaar",
        "Verschil in seconden bij gelijke rondeafstand: Apolloon min VTK vorig jaar. Vanaf nu rekent de stippellijn met het doeltempo per uur.",
    ));
    if gap.is_empty() {
        gap_panel = gap_panel.child(
            t(
                "Geen VTK-referentie beschikbaar voor deze berekening.",
                13.5,
                400.0,
                k.ink3,
            )
            .padding(16.0),
        );
    } else {
        let actual: Vec<(f64, Option<f64>)> = gap
            .iter()
            .filter(|g| !g.2)
            .map(|g| (g.0, Some(g.1)))
            .collect();
        let mut predicted: Vec<(f64, Option<f64>)> = actual.last().copied().into_iter().collect();
        predicted.extend(gap.iter().filter(|g| g.2).map(|g| (g.0, Some(g.1))));
        gap_panel = gap_panel.child(chart(
            s,
            k,
            shared(
                "gap",
                "Tijdskloof op VTK",
                vec![
                    Series {
                        label: "Werkelijke tijdskloof".into(),
                        color: k.strong,
                        width: 3.0,
                        dash: None,
                        points: actual,
                        dots: 0.0,
                        hidden: false,
                    },
                    Series {
                        label: "Voorspeld met doelschema".into(),
                        color: k.live,
                        width: 3.0,
                        dash: Some((8.0, 6.0)),
                        points: predicted,
                        dots: 0.0,
                        hidden: false,
                    },
                    Series {
                        label: "Gelijke stand".into(),
                        color: k.neutral,
                        width: 1.0,
                        dash: Some((5.0, 5.0)),
                        points: vec![(0.0, Some(0.0)), (24.0, Some(0.0))],
                        dots: 0.0,
                        hidden: false,
                    },
                ],
                Box::new(signed_gap),
            ),
        ));
    }
    d = d.child(gap_panel);
    d.child(
        panel(k)
            .child(
                row()
                    .gap(12.0)
                    .items_start()
                    .child(
                        section_header(
                            k,
                            "Laatste rondes",
                            "Alle rondes, ook die buiten de geldige grenzen vallen en dus niet meetellen.",
                        )
                        .grow(1.0)
                        .w(0.0),
                    )
                    .child(status_badge(k, "Live gegevens", k.surface2, k.ink2, 20.0, 12.0, 500.0)),
            )
            .child(recent_laps(s, k)),
    )
}

/// `buildLiveRivalTimeGap`: (hour, gap seconds, predicted).
fn rival_time_gap(
    clean: &[Lap],
    start: f64,
    elapsed: f64,
    paces: &[f64],
    rival: Option<&Team>,
) -> Vec<(f64, f64, bool)> {
    let Some(rival) = rival else {
        return Vec::new();
    };
    if clean.is_empty() {
        return Vec::new();
    }
    let e = elapsed.clamp(0.0, 24.0);
    let mut curve: Vec<(f64, f64)> = vec![(0.0, 0.0)];
    curve.extend(
        clean
            .iter()
            .enumerate()
            .map(|(i, l)| (((l.finished - start) / 1000.0).max(0.0), i as f64 + 1.0)),
    );
    let done = clean.len() as f64;
    let target_now = target_laps_at(paces, e);
    let step = 5.0 / 60.0;
    let mut h = e;
    while h <= 24.0001 {
        curve.push((h * 3600.0, done + target_laps_at(paces, h) - target_now));
        h += step;
    }
    curve.sort_by(|a, b| a.0.total_cmp(&b.0));
    // Trimmed cumulative seconds of the rival.
    let mut cum: Vec<f64> = rival.cum.iter().map(|t| t / 1000.0).collect();
    if cum.len() >= 6 {
        let last = cum[cum.len() - 1] - cum[cum.len() - 2];
        let earlier: Vec<f64> = rival.dur[..rival.dur.len() - 1]
            .iter()
            .map(|d| d / 1000.0)
            .collect();
        if median(&earlier).is_some_and(|m| last > m * 2.5) {
            cum.pop();
        }
    }
    let progress = |ts: f64| -> f64 {
        let next = upper_bound(&cum, ts);
        if next == 0 {
            return ts / cum[0];
        }
        if next >= cum.len() {
            let tail = &cum[cum.len().saturating_sub(21)..];
            let d: Vec<f64> = tail.windows(2).map(|w| w[1] - w[0]).collect();
            let pace = median(&d).unwrap_or(1.0);
            return cum.len() as f64 + (ts - cum[cum.len() - 1]) / pace;
        }
        let (a, b) = (cum[next - 1], cum[next]);
        next as f64 + (ts - a) / (b - a)
    };
    let timestamp = |prog: f64| -> f64 {
        if prog <= 0.0 {
            return 0.0;
        }
        match curve.iter().position(|p| p.1 >= prog) {
            Some(0) => curve[0].0,
            None => {
                let l = curve[curve.len() - 1];
                let pv = curve[curve.len().saturating_sub(2)];
                let pace = (l.0 - pv.0) / (l.1 - pv.1).max(0.001);
                l.0 + (prog - l.1) * pace
            }
            Some(i) => {
                let (a, b) = (curve[i - 1], curve[i]);
                let f = (prog - a.1) / (b.1 - a.1).max(0.001);
                a.0 + f * (b.0 - a.0)
            }
        }
    };
    let mut out = Vec::new();
    let mut h = 0.0;
    while h <= 24.0001 {
        let ts = h * 3600.0;
        out.push((h, timestamp(progress(ts)) - ts, h > e));
        h += step;
    }
    out
}

fn table(
    k: &Ink,
    heads: &[&str],
    widths: &[f32],
    rows: Vec<(Vec<El>, bool)>,
    highlight: Color,
) -> El {
    let cell = |w: f32, c: El| row().grow(w).w(0.0).min_w(0.0).px(12.0).center_y().child(c);
    let mut head = row().h(36.0).border_sides([0.0, 0.0, 1.0, 0.0], k.line);
    for (h, w) in heads.iter().zip(widths) {
        head = head.child(cell(*w, t(*h, 12.5, 600.0, k.ink3)));
    }
    let mut tb = col().min_w(0.0).child(head);
    for (cells, selected) in rows {
        let mut r = row().h(40.0);
        if selected {
            r = r.fill(highlight);
        }
        for (c, w) in cells.into_iter().zip(widths) {
            r = r.child(cell(*w, c));
        }
        tb = tb.child(r.border_sides([0.0, 0.0, 1.0, 0.0], k.line));
    }
    tb
}

fn recent_laps(s: &State, k: &Ink) -> El {
    let p = &s.tactics;
    let (min_s, max_s) = (p.vals[MIN_S], p.vals[MAX_S]);
    let mut all: Vec<&Value> = laps(s);
    all.sort_by(|a, b| {
        b["finishedAt"]
            .as_f64()
            .unwrap_or(0.0)
            .total_cmp(&a["finishedAt"].as_f64().unwrap_or(0.0))
    });
    let bad = |l: &Value| {
        let d = l["durationMs"].as_f64().unwrap_or(0.0) / 1000.0;
        d < min_s || d > max_s
    };
    let lap_rows = |list: Vec<&Value>| -> El {
        let rows = list
            .into_iter()
            .map(|l| {
                let warn = bad(l);
                (
                    vec![
                        t(
                            clock_ms(l["finishedAt"].as_f64().unwrap_or(0.0)),
                            13.5,
                            400.0,
                            k.text,
                        ),
                        t(l["runnerName"].as_str().unwrap_or(""), 13.5, 700.0, k.text)
                            .truncate()
                            .min_w(0.0),
                        t(l["lapNumber"].to_string(), 13.5, 400.0, k.text),
                        t(
                            pace(l["durationMs"].as_f64().map(|d| d / 1000.0)),
                            13.5,
                            400.0,
                            k.text,
                        ),
                        if warn {
                            status_badge(k, "Nakijken", k.warn_wash, k.warn_ink, 22.0, 12.5, 600.0)
                        } else {
                            status_badge(k, "Geldig", k.go_wash, k.go_ink, 22.0, 12.5, 600.0)
                        },
                    ],
                    false,
                )
            })
            .collect();
        col()
            .max_h(360.0)
            .scroll(ScrollSpec {
                stick_bottom: false,
            })
            .radius(6.0)
            .border(1.0, k.line)
            .clip_rounded(6.0)
            .child(table(
                k,
                &["Moment", "Loper", "Ronde", "Tijd", "Controle"],
                &[1.2, 1.6, 0.7, 1.0, 1.0],
                rows,
                k.brand_wash,
            ))
    };
    let suspicious: Vec<&Value> = all.iter().copied().filter(|l| bad(l)).collect();
    let mut out = col()
        .gap(12.0)
        .child(lap_rows(all.iter().copied().take(30).collect()));
    if !suspicious.is_empty() {
        let open = p.suspicious_open;
        let mut d = col()
            .padding(12.0)
            .radius(6.0)
            .fill(k.warn_wash)
            .border(1.0, k.warn_line)
            .child(
                row()
                    .key("tac-suspicious")
                    .role("button")
                    .expanded(open)
                    .focusable(true)
                    .gap(8.0)
                    .center_y()
                    .on_press(|s: &mut State| {
                        s.tactics.suspicious_open = !s.tactics.suspicious_open
                    })
                    .child(chevron(k.ink3, open))
                    .child(t(
                        format!("Alle {} verdachte rondes bekijken", suspicious.len()),
                        14.0,
                        600.0,
                        k.warn_ink,
                    )),
            );
        if open {
            d = d.child(lap_rows(suspicious).mt(8.0));
        }
        out = out.child(d);
    }
    out
}

fn file_button(k: &Ink, label: &str) -> El {
    row()
        .key(format!("tac-file-{label}"))
        .role("button")
        .label(label.to_string())
        .focusable(true)
        .h(34.0)
        .px(12.0)
        .center_y()
        .radius(6.0)
        .fill(k.card)
        .border(1.0, k.line2)
        .hover(k.surface3)
        .on_press_tx(|s: &mut State, tx: &mut Tx| super::choose_reference(s, tx))
        .child(t(label, 13.5, 500.0, k.text))
}

fn dataset_manager(k: &Ink, source: &str, teams: usize, error: Option<&str>) -> El {
    let mut info = col()
        .grow(1.0)
        .w(0.0)
        .min_w(0.0)
        .child(t("Referentiedata", 12.5, 400.0, k.ink3).mb(2.0))
        .child(t(source, 14.0, 600.0, k.text).truncate().min_w(0.0).my(4.0))
        .child(t(
            format!("{teams} teams ingelezen en lokaal bewaard op deze laptop."),
            13.5,
            400.0,
            k.ink3,
        ));
    if let Some(e) = error {
        info = info.child(t(e, 13.0, 500.0, k.warn_ink).role("alert").mt(6.0));
    }
    panel(k).child(
        row().gap(12.0).items_start().child(info).child(
            row()
                .gap(8.0)
                .child(file_button(k, "Ander bestand kiezen"))
                .child(ghost_button(
                    k,
                    "tac-restore",
                    "Quivr 2025 herstellen",
                    clear_reference,
                )),
        ),
    )
}

fn reference_notice(_s: &State, k: &Ink, error: Option<&str>, expanded: bool) -> El {
    let mut info = col()
        .grow(1.4)
        .w(0.0)
        .min_w(0.0)
        .child(t("Eenmalige instelling", 12.5, 400.0, k.ink3).mb(2.0))
        .child(t("Laad de officiële resultaten van vorig jaar", 14.0, 600.0, k.text).my(4.0))
        .child(
            t(
                "De huidige race komt automatisch uit Apolloon. Alleen de historische organisatordata moet één keer gekozen worden en blijft daarna op deze laptop bewaard.",
                13.5,
                400.0,
                k.ink3,
            )
            .wrap()
            .min_w(0.0),
        );
    if let Some(e) = error {
        info = info.child(t(e, 13.0, 500.0, k.warn_ink).role("alert").mt(6.0));
    }
    let mut p = panel(k).child(
        row()
            .gap(20.0)
            .center_y()
            .child(info)
            .child(file_button(k, "Resultaten vorig jaar kiezen")),
    );
    if expanded {
        p = p.min_h(260.0).justify_center();
    }
    p
}

// ---------- Historical deep dive ----------

fn historical(s: &State, k: &Ink) -> El {
    let p = &s.tactics;
    let (race, source, error) = race_data(p);
    let Some(race) = race else {
        return reference_notice(s, k, error.as_deref(), true);
    };
    let first = race.team(p.first).or(race.teams.first()).unwrap();
    let second = race.team(p.second).or(race.teams.get(1)).unwrap_or(first);
    let names: Vec<(String, bool)> = race.teams.iter().map(|t| (t.name.clone(), true)).collect();
    let ids: Rc<Vec<i64>> = Rc::new(race.teams.iter().map(|t| t.id).collect());
    let pos = |id: i64| race.teams.iter().position(|t| t.id == id).unwrap_or(0);
    let (ids1, ids2) = (ids.clone(), ids.clone());
    let controls = panel(k)
        .child(section_header(
            k,
            "Analyse van vorig jaar",
            "Bekijk eerst de volledige editie op zichzelf. Dezezelfde gegevens worden daarna automatisch als referentie gebruikt in de live sectie.",
        ))
        .child(
            row()
                .gap(12.0)
                .child(
                    field(
                        k,
                        "Eerste team",
                        select(s, k, "tac-first", "Eerste team", names.clone(), pos(first.id), 34.0, 13.5,
                            Rc::new(move |s: &mut State, i| { s.tactics.first = ids1[i]; reset_diagnostics(&mut s.tactics); })),
                    )
                    .grow(0.6)
                    .w(0.0),
                )
                .child(
                    field(
                        k,
                        "Tweede team",
                        select(s, k, "tac-second", "Tweede team", names.clone(), pos(second.id), 34.0, 13.5,
                            Rc::new(move |s: &mut State, i| { s.tactics.second = ids2[i]; reset_diagnostics(&mut s.tactics); })),
                    )
                    .grow(0.6)
                    .w(0.0),
                )
                .child(
                    row()
                        .grow(1.4)
                        .w(0.0)
                        .min_w(0.0)
                        .child(el().w(1.0).fill(k.line).self_stretch())
                        .child(
                            col()
                                .pl(16.0)
                                .gap(2.0)
                                .justify_center()
                                .min_w(0.0)
                                .child(t("Bronbestand", 13.5, 600.0, k.ink2))
                                .child(t(&source, 14.0, 700.0, k.text).truncate().min_w(0.0))
                                .child(t(format!("{} teams beschikbaar", race.teams.len()), 12.5, 400.0, k.ink3)),
                        ),
                ),
        );
    let sections = [
        ("Alle teams", "Rangschikking en spreiding"),
        ("Tempo A vs. B", "Kwartieren, consistentie en nacht"),
        ("Raceverloop", "Tijdskloof en gewonnen rondes"),
        ("Diagnostiek", "Rondetijden en break-even"),
        ("Volgeffect", "Nabijheid en statistiek"),
    ];
    let mut nav = row()
        .role("navigation")
        .label("Verdiepende historische analyse")
        .radius(8.0)
        .fill(k.card)
        .border(1.0, k.line)
        .clip_rounded(8.0);
    for (i, (label, detail)) in sections.iter().enumerate() {
        let active = p.deep == i as u8;
        let mut b = col()
            .key(format!("tac-deep-{i}"))
            .role("button")
            .label(label.to_string())
            .checked(active)
            .focusable(true)
            .grow(1.0)
            .w(0.0)
            .min_w(0.0)
            .gap(2.0)
            .px(12.0)
            .py(11.0)
            .hover(k.surface2)
            .press(k.surface3)
            .on_press(move |s: &mut State| {
                s.tactics.deep = i as u8;
                if i == 3 {
                    reset_diagnostics(&mut s.tactics);
                }
            })
            .child(t(*label, 14.0, 700.0, k.text))
            .child(t(*detail, 12.0, 400.0, k.ink3).truncate().min_w(0.0));
        if active {
            b = b.fill(k.brand_wash).child(
                el().h(3.0)
                    .w_full()
                    .fill(k.brand)
                    .absolute(0.0, 0.0)
                    .mt(0.0),
            );
        }
        nav = nav.child(b);
        if i + 1 < sections.len() {
            nav = nav.child(el().w(1.0).fill(k.line).self_stretch());
        }
    }
    let body = match p.deep {
        0 => overview_section(s, k, race, first, second),
        1 => tempo_section(s, k, first, second),
        2 => race_section(s, k, first, second),
        3 => diagnostics(s, k, first, second),
        _ => drafting(s, k, first, second),
    };
    col()
        .gap(16.0)
        .min_w(0.0)
        .child(controls)
        .child(nav)
        .child(body)
        .child(dataset_manager(
            k,
            &source,
            race.teams.len(),
            error.as_deref(),
        ))
}

fn reset_diagnostics(p: &mut Page) {
    let (race, _, _) = race_data(p);
    let values = race
        .into_iter()
        .flat_map(|race| {
            [race.team(p.first), race.team(p.second)]
                .into_iter()
                .flatten()
                .flat_map(|team| team.dur.iter().map(|ms| ms / 1000.0))
        })
        .collect::<Vec<_>>();
    let threshold = (quantile(&values, 0.9).unwrap_or(90.0) / 5.0).round() * 5.0;
    p.vals[DIAG_SLOW] = threshold;
    p.edits[DIAG_SLOW].replace_text(fmt_num(threshold));
    p.improving_second = false;
}

struct DiagnosticLap {
    number: usize,
    hour: f64,
    seconds: f64,
    change: Option<f64>,
}

fn diagnostic_laps(team: &Team, slow: f64, jump: f64) -> (Vec<DiagnosticLap>, Vec<DiagnosticLap>) {
    let mut slow_laps = Vec::new();
    let mut jumps = Vec::new();
    for (i, (&end, &duration)) in team.cum.iter().zip(&team.dur).enumerate() {
        let lap = || DiagnosticLap {
            number: i + 1,
            hour: end / 3_600_000.0,
            seconds: duration / 1000.0,
            change: None,
        };
        if duration / 1000.0 > slow {
            slow_laps.push(lap());
        }
        if i >= 5 {
            let baseline = team.dur[i - 5..i].iter().sum::<f64>() / 5.0;
            let change = (duration - baseline) / 1000.0;
            if change.abs() > jump {
                jumps.push(DiagnosticLap {
                    change: Some(change),
                    ..lap()
                });
            }
        }
    }
    slow_laps.sort_by(|a, b| b.seconds.total_cmp(&a.seconds));
    jumps.sort_by(|a, b| {
        b.change
            .unwrap_or_default()
            .abs()
            .total_cmp(&a.change.unwrap_or_default().abs())
    });
    (slow_laps, jumps)
}

fn diagnostics(s: &State, k: &Ink, first: &Team, second: &Team) -> El {
    let p = &s.tactics;
    let input = |id, title| {
        field(
            k,
            title,
            num_input(s, k, id, title, font(13.5, 400.0), 34.0),
        )
        .grow(1.0)
        .w(0.0)
    };
    let controls = panel(k)
        .child(section_header(k, "Bekijk de rondetijden", "Selecteer rondes op duur. Tempoverschillen vergelijken met de vijf vorige rondes."))
        .child(row().gap(12.0).child(input(DIAG_SLOW, "Rondeduur vanaf (s)")).child(input(DIAG_JUMP, "Tempoverschil vanaf (s)")));
    let mut totals = Vec::new();
    let mut series = Vec::new();
    let mut tables = row().gap(16.0);
    for (i, team) in [first, second].into_iter().enumerate() {
        let (slow_laps, jumps) = diagnostic_laps(team, p.vals[DIAG_SLOW], p.vals[DIAG_JUMP]);
        let mut column = col().gap(14.0).grow(1.0).w(0.0).min_w(0.0);
        for (title, laps, is_jump) in [
            ("Rondes vanaf gekozen duur", &slow_laps, false),
            ("Tempoverschillen", &jumps, true),
        ] {
            let name = format!("{title} {}", team.name);
            totals.push(stat(k, &name, &laps.len().to_string(), None, "", None));
            series.push(Series {
                label: name.clone(),
                color: team_color(k, team.id, i),
                width: 0.0,
                dash: None,
                points: laps
                    .iter()
                    .map(|lap| (lap.hour, Some(lap.seconds)))
                    .collect(),
                dots: if is_jump { 3.0 } else { 5.0 },
                hidden: false,
            });
            let rows = laps
                .iter()
                .take(10)
                .map(|lap| {
                    (
                        vec![
                            t(lap.number.to_string(), 13.0, 500.0, k.text),
                            t(format!("{:.2} u", lap.hour), 13.0, 400.0, k.ink2),
                            t(format!("{:.1} s", lap.seconds), 13.0, 400.0, k.text),
                            t(
                                lap.change
                                    .map(|change| format!("{change:+.1} s"))
                                    .unwrap_or("—".into()),
                                13.0,
                                400.0,
                                k.ink2,
                            ),
                        ],
                        false,
                    )
                })
                .collect();
            column = column.child(t(name, 14.0, 600.0, k.text)).child(table(
                k,
                &["Ronde", "Race-uur", "Duur", "Verschil"],
                &[1.0; 4],
                rows,
                k.card,
            ));
        }
        tables = tables.child(column);
    }
    let timeline = panel(k)
        .child(section_header(
            k,
            "Rondeduur en tempoverschillen",
            "De punten tonen de geselecteerde rondes op de tijdlijn.",
        ))
        .child(chart(
            s,
            k,
            ChartSpec {
                key: "historical-diagnostics",
                height: 280.0,
                x_min: 0.0,
                x_max: 24.0,
                x_ticks: plain_hour_ticks(),
                x_title: None,
                y_title: "Rondeduur (s)".into(),
                y_fmt: Box::new(|v| format!("{v:.0}")),
                grace: 0.05,
                begin_at_zero: false,
                zero_line: false,
                legend: true,
                series,
                bands: vec![],
                now: None,
                scatter: None,
            },
        ));
    let (improving, target) = if p.improving_second {
        (second, first)
    } else {
        (first, second)
    };
    let average = improving.dur.iter().sum::<f64>() / improving.dur.len().max(1) as f64 / 1000.0;
    let required = 86_400.0 / target.cum.len().max(1) as f64;
    let difference = average - required;
    let max = p.vals[DIAG_IMPROVEMENT].min((average - 5.0).max(0.0));
    let points = (0..=(max * 2.0).floor() as usize)
        .filter_map(|step| {
            let gain = step as f64 / 2.0;
            (average > gain).then(|| (gain, Some((86_400.0 / (average - gain)).floor())))
        })
        .collect();
    let calculator = panel(k)
        .child(section_header(k, "Break-even calculator", "Bereken hoe snel een team gemiddeld moet lopen om het aantal rondes van het andere team te halen."))
        .child(row().gap(12.0)
            .child(field(k, "Welk team verbetert?", select(
                s, k, "tac-improving", "Welk team verbetert?",
                vec![(first.name.clone(), true), (second.name.clone(), true)], usize::from(p.improving_second),
                34.0, 13.5, Rc::new(|s: &mut State, i| s.tactics.improving_second = i == 1),
            )).grow(1.0).w(0.0))
            .child(input(DIAG_IMPROVEMENT, "Maximale verbetering (s)"))
            .child(stat(k, "Benodigd voor break-even", &format!("{required:.1} s"), None,
                &format!("{difference:+.1} s per ronde"), None).grow(1.0).w(0.0)))
        .child(chart(s, k, ChartSpec {
            key: "historical-break-even", height: 260.0, x_min: 0.0, x_max: max.max(1.0),
            x_ticks: (0..=5).map(|i| { let value = i as f64 * max.max(1.0) / 5.0; (value, vec![format!("{value:.1}")]) }).collect(),
            x_title: Some("Verbetering per ronde (s)".into()), y_title: "Rondes".into(),
            y_fmt: Box::new(|v| format!("{v:.0}")), grace: 0.05, begin_at_zero: false,
            zero_line: false, legend: true, bands: vec![], now: None, scatter: None,
            series: vec![
                Series { label: improving.name.clone(), color: team_color(k, improving.id, 0), width: 2.0, dash: None, points, dots: 0.0, hidden: false },
                Series { label: target.name.clone(), color: team_color(k, target.id, 1), width: 2.0, dash: Some((5.0, 5.0)), points: vec![(0.0, Some(target.cum.len() as f64)), (max.max(1.0), Some(target.cum.len() as f64))], dots: 0.0, hidden: false },
            ],
        }));
    col()
        .gap(16.0)
        .child(controls)
        .child(stats_grid(k, "Diagnostiek", totals))
        .child(timeline)
        .child(panel(k).child(tables))
        .child(calculator)
}

fn clean_passages(team: &Team, page: &Page) -> Vec<(f64, f64)> {
    let [start, end] = [page.vals[DRAFT_FROM] * 3600.0, page.vals[DRAFT_TO] * 3600.0];
    let mut laps = team
        .cum
        .iter()
        .zip(&team.dur)
        .map(|(time, duration)| (time / 1000.0, duration / 1000.0))
        .filter(|(time, _)| (start..=end).contains(time))
        .collect::<Vec<_>>();
    let durations = laps.iter().map(|lap| lap.1).collect::<Vec<_>>();
    let center = median(&durations).unwrap_or_default();
    let q1 = quantile(&durations, 0.25).unwrap_or(center);
    let q3 = quantile(&durations, 0.75).unwrap_or(center);
    let range = q3 - q1;
    let deviations = durations
        .iter()
        .map(|duration| (duration - center).abs())
        .collect::<Vec<_>>();
    let mad = median(&deviations).unwrap_or_default() * 1.4826;
    let mut min = (q1 - 3.0 * range).max(page.vals[DRAFT_MIN]);
    let mut max = (q3 + 3.0 * range).min(page.vals[DRAFT_MAX]);
    if mad > 0.0 {
        min = min.max(center - 4.0 * mad);
        max = max.min(center + 4.0 * mad);
    }
    laps.retain(|(_, duration)| (min..=max).contains(duration));
    laps
}

fn nearest_passages(focus: &[(f64, f64)], other: &[(f64, f64)]) -> Vec<(f64, f64)> {
    if other.is_empty() {
        return Vec::new();
    }
    focus
        .iter()
        .map(|&(time, duration)| {
            let index = other.partition_point(|lap| lap.0 <= time);
            let previous = index
                .checked_sub(1)
                .and_then(|i| other.get(i))
                .map_or(f64::INFINITY, |lap| time - lap.0);
            let next = other.get(index).map_or(f64::INFINITY, |lap| time - lap.0);
            (
                if previous.abs() <= next.abs() {
                    previous
                } else {
                    next
                },
                duration,
            )
        })
        .collect()
}

/// Two-sided Mann–Whitney probability, with the same tie correction as the reference.
fn rank_probability(a: &[f64], b: &[f64]) -> Option<f64> {
    if a.is_empty() || b.is_empty() {
        return None;
    }
    let mut ranked = a
        .iter()
        .map(|v| (*v, true))
        .chain(b.iter().map(|v| (*v, false)))
        .collect::<Vec<_>>();
    ranked.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut rank_sum = 0.0;
    let mut ties = 0.0;
    let mut start = 0;
    while start < ranked.len() {
        let end = start + ranked[start..].partition_point(|item| item.0 == ranked[start].0);
        let count = (end - start) as f64;
        ties += count.powi(3) - count;
        rank_sum += (start + 1 + end) as f64 / 2.0
            * ranked[start..end].iter().filter(|item| item.1).count() as f64;
        start = end;
    }
    let (a, b, n) = (a.len() as f64, b.len() as f64, ranked.len() as f64);
    let variance = a * b / (n * (n - 1.0)) * (n.powi(3) - n - ties) / 12.0;
    if variance <= 0.0 {
        return Some(1.0);
    }
    let z = ((rank_sum - a * (a + 1.0) / 2.0 - a * b / 2.0) / variance.sqrt()).abs()
        / std::f64::consts::SQRT_2;
    let t = 1.0 / (1.0 + 0.3275911 * z);
    let polynomial = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t
        + 0.254829592)
        * t;
    Some((polynomial * (-z * z).exp()).clamp(0.0, 1.0))
}

fn drafting(s: &State, k: &Ink, first: &Team, second: &Team) -> El {
    let mut controls = row().gap(12.0);
    for (id, title) in [
        (DRAFT_FROM, "Van race-uur"),
        (DRAFT_TO, "Tot race-uur"),
        (DRAFT_CLOSE, "Dichtbij tot (s)"),
        (DRAFT_FAR, "Ver weg vanaf (s)"),
        (DRAFT_MIN, "Minimum ronde (s)"),
        (DRAFT_MAX, "Maximum ronde (s)"),
    ] {
        controls = controls.child(
            field(
                k,
                title,
                num_input(s, k, id, title, font(13.5, 400.0), 34.0),
            )
            .grow(1.0)
            .w(0.0),
        );
    }
    let first_laps = clean_passages(first, &s.tactics);
    let second_laps = clean_passages(second, &s.tactics);
    let edges = [0.0, 5.0, 10.0, 15.0, 20.0, 30.0, f64::INFINITY];
    let mut scatter = Vec::new();
    let mut bins = Vec::new();
    let mut rows = Vec::new();
    let mut max_gap: f64 = 5.0;
    for (i, (team, focused, other)) in [
        (first, &first_laps, &second_laps),
        (second, &second_laps, &first_laps),
    ]
    .into_iter()
    .enumerate()
    {
        let passages = nearest_passages(focused, other);
        let color = team_color(k, team.id, i);
        max_gap = passages
            .iter()
            .fold(max_gap, |max, (gap, _)| max.max(gap.abs()));
        scatter.push(Series {
            label: team.name.clone(),
            color,
            width: 0.0,
            dash: None,
            points: passages
                .iter()
                .map(|&(gap, duration)| (gap, Some(duration)))
                .collect(),
            dots: 2.0,
            hidden: false,
        });
        let points = edges
            .windows(2)
            .enumerate()
            .map(|(i, edge)| {
                let times = passages
                    .iter()
                    .filter(|(gap, _)| (edge[0]..edge[1]).contains(&gap.abs()))
                    .map(|(_, d)| *d)
                    .collect::<Vec<_>>();
                (
                    i as f64,
                    if times.len() >= 4 {
                        median(&times)
                    } else {
                        None
                    },
                )
            })
            .collect();
        bins.push(Series {
            label: team.name.clone(),
            color,
            width: 2.0,
            dash: None,
            points,
            dots: 3.0,
            hidden: false,
        });
        let collect = |test: &dyn Fn(f64) -> bool| {
            passages
                .iter()
                .filter(|(gap, _)| test(*gap))
                .map(|(_, d)| *d)
                .collect::<Vec<_>>()
        };
        let close = s.tactics.vals[DRAFT_CLOSE];
        let far = s.tactics.vals[DRAFT_FAR];
        let near = collect(&|gap| gap.abs() <= close);
        let behind = collect(&|gap| gap > 0.0 && gap <= close);
        let ahead = collect(&|gap| gap < 0.0 && -gap <= close);
        let far = collect(&|gap| gap.abs() >= far);
        for (name, a, b) in [
            ("Dichtbij vs. ver weg", &near, &far),
            ("Achteraan dichtbij vs. ver weg", &behind, &far),
            ("Vooraan dichtbij vs. ver weg", &ahead, &far),
            ("Achteraan vs. vooraan dichtbij", &behind, &ahead),
        ] {
            let p = rank_probability(a, b);
            let effect = median(b).zip(median(a)).map(|(b, a)| b - a);
            let cell = |value: String| t(value, 13.0, 400.0, k.text);
            rows.push((
                vec![
                    cell(team.name.clone()),
                    cell(name.into()),
                    cell(format!("{} / {}", a.len(), b.len())),
                    cell(effect.map(|v| format!("{v:+.2} s")).unwrap_or("—".into())),
                    cell(p.map(|v| format!("{v:.4}")).unwrap_or("—".into())),
                ],
                p.is_some_and(|v| v < 0.05),
            ));
        }
    }
    let graph = |key, title: &str, caption: &str, points, x_min, x_max, ticks, zero_line| {
        panel(k)
            .child(section_header(k, title, caption))
            .child(chart(
                s,
                k,
                ChartSpec {
                    key,
                    height: 280.0,
                    x_min,
                    x_max,
                    x_ticks: ticks,
                    x_title: None,
                    y_title: "Rondeduur (s)".into(),
                    y_fmt: Box::new(|v| format!("{v:.0}")),
                    grace: 0.05,
                    begin_at_zero: false,
                    zero_line,
                    legend: true,
                    series: points,
                    bands: vec![],
                    now: None,
                    scatter: None,
                },
            ))
    };
    let gap_ticks = (-4..=4)
        .map(|i| {
            let gap = i as f64 * max_gap / 4.0;
            (gap, vec![format!("{gap:.0} s")])
        })
        .collect();
    let bin_ticks = ["0–5 s", "5–10 s", "10–15 s", "15–20 s", "20–30 s", "30 s+"]
        .into_iter()
        .enumerate()
        .map(|(i, name)| (i as f64, vec![name.into()]))
        .collect();
    col().gap(16.0)
        .child(panel(k).child(section_header(k, "Loopt een team sneller vlak bij het andere team?", "Elke passage wordt gekoppeld aan de dichtstbijzijnde passage van het andere team.")).child(controls))
        .child(graph("historical-drafting-scatter", "Rondetijd volgens positie tegenover de andere ploeg", "Negatief is voorop. Positief is achterop.", scatter, -max_gap, max_gap, gap_ticks, false))
        .child(graph("historical-drafting-proximity", "Mediaan rondetijd volgens afstand tot de andere ploeg", "Een mediaan verschijnt vanaf vier rondes in de categorie.", bins, 0.0, 5.0, bin_ticks, false))
        .child(panel(k).child(section_header(k, "Wilcoxon-rangsom met tiecorrectie", "Een positief effect betekent dat de eerste situatie sneller was.")).child(
            table(k, &["Team", "Vergelijking", "Rondes", "Effect", "p"], &[1.0, 3.0, 0.8, 0.7, 0.7], rows, k.brand_wash)))
}

fn overview_section(s: &State, k: &Ink, race: &Race, first: &Team, second: &Team) -> El {
    struct Sum {
        id: i64,
        name: String,
        laps: usize,
        med: f64,
        p10: f64,
        p90: f64,
        sd: f64,
    }
    let mut sums: Vec<Sum> = race
        .teams
        .iter()
        .map(|t| {
            let d: Vec<f64> = t.dur.iter().map(|d| d / 1000.0).collect();
            Sum {
                id: t.id,
                name: t.name.clone(),
                laps: t.cum.len(),
                med: median(&d).unwrap_or(0.0),
                p10: quantile(&d, 0.1).unwrap_or(0.0),
                p90: quantile(&d, 0.9).unwrap_or(0.0),
                sd: std_dev(&d),
            }
        })
        .collect();
    sums.sort_by(|a, b| b.laps.cmp(&a.laps).then(a.id.cmp(&b.id)));
    let a = sums.iter().find(|x| x.id == first.id).unwrap();
    let b = sums.iter().find(|x| x.id == second.id).unwrap();
    let stats = stats_grid(
        k,
        "Historische kerncijfers",
        vec![
            stat(
                k,
                &first.name,
                &format!("{} rondes", a.laps),
                None,
                &format!("Mediaan {}", pace(Some(a.med))),
                None,
            ),
            stat(
                k,
                &second.name,
                &format!("{} rondes", b.laps),
                None,
                &format!("Mediaan {}", pace(Some(b.med))),
                None,
            ),
            stat(
                k,
                "Verschil na 24u",
                &signed_number(a.laps as f64 - b.laps as f64),
                None,
                &format!("{} tegenover {}", first.name, second.name),
                None,
            ),
            stat(
                k,
                "Meest consistent",
                if a.sd <= b.sd {
                    &first.name
                } else {
                    &second.name
                },
                None,
                "Laagste spreiding over alle rondes",
                None,
            ),
        ],
    );
    let rows = sums
        .iter()
        .enumerate()
        .map(|(i, x)| {
            (
                vec![
                    t((i + 1).to_string(), 13.5, 400.0, k.text),
                    row()
                        .gap(8.0)
                        .center_y()
                        .child(el().size(9.0, 9.0).radius(2.0).fill(team_color(k, x.id, i)))
                        .child(t(x.name.clone(), 13.5, 600.0, k.text)),
                    t(x.laps.to_string(), 13.5, 700.0, k.text),
                    t(pace(Some(x.med)), 13.5, 400.0, k.text),
                    t(
                        format!("{} tot {}", pace(Some(x.p10)), pace(Some(x.p90))),
                        13.5,
                        400.0,
                        k.text,
                    ),
                    t(format!("{:.1}s", x.sd), 13.5, 400.0, k.text),
                ],
                x.id == first.id || x.id == second.id,
            )
        })
        .collect();
    let ranking = panel(k)
        .child(section_header(
            k,
            "Alle teams naast elkaar",
            "Rangschikking op aantal rondes, met de mediaan, P10-P90-band en standaardafwijking van de rondetijden.",
        ))
        .child(table(k, &["#", "Team", "Rondes", "Mediaan", "P10-P90", "Spreiding"], &[0.4, 2.0, 0.8, 1.0, 1.8, 0.9], rows, k.brand_wash));
    let detail_id = s.tactics.detail.unwrap_or(first.id);
    let detail = race.team(detail_id).unwrap_or(first);
    let raw: Vec<(f64, f64)> = detail
        .dur
        .iter()
        .enumerate()
        .map(|(i, d)| (detail.cum[i] / 3_600_000.0, d / 1000.0))
        .collect();
    let rolling: Vec<(f64, Option<f64>)> = raw
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let w: Vec<f64> = raw[i.saturating_sub(19)..=i].iter().map(|x| x.1).collect();
            (p.0, median(&w))
        })
        .collect();
    let ids: Rc<Vec<i64>> = Rc::new(race.teams.iter().map(|t| t.id).collect());
    let detail_pos = race
        .teams
        .iter()
        .position(|t| t.id == detail.id)
        .unwrap_or(0);
    let names = race.teams.iter().map(|t| (t.name.clone(), true)).collect();
    let timeline = panel(k)
        .child(
            row()
                .gap(12.0)
                .items_start()
                .child(
                    section_header(
                        k,
                        &format!("Alle passages van {}", detail.name),
                        "Elke stip is een geregistreerde ronde. De donkere lijn is de lopende mediaan over twintig rondes, zoals in de oorspronkelijke tactische analyse.",
                    )
                    .grow(1.0)
                    .w(0.0),
                )
                .child(
                    field(
                        k,
                        "Team in detail",
                        select(s, k, "tac-detail", "Team in detail", names, detail_pos, 34.0, 13.5,
                            Rc::new(move |s: &mut State, i| s.tactics.detail = Some(ids[i]))),
                    )
                    .w(200.0),
                ),
        )
        .child(chart(
            s,
            k,
            ChartSpec {
                key: "passages",
                height: 420.0,
                x_min: 0.0,
                x_max: 24.0,
                x_ticks: plain_hour_ticks(),
                x_title: Some("Uren sinds de start".into()),
                y_title: "Rondetijd".into(),
                y_fmt: Box::new(|v| pace(Some(v))),
                grace: 0.0,
                begin_at_zero: false,
                zero_line: false,
                legend: true,
                series: vec![Series {
                    label: "Lopende mediaan (20)".into(),
                    color: k.strong,
                    width: 2.0,
                    dash: None,
                    points: rolling,
                    dots: 0.0,
                    hidden: false,
                }],
                bands: Vec::new(),
                now: None,
                scatter: Some((raw, team_color(k, detail.id, 0).alpha(0.35))),
            },
        ));
    // Duration distribution, 2 s bins.
    let fs: Vec<f64> = first.dur.iter().map(|d| d / 1000.0).collect();
    let ss: Vec<f64> = second.dur.iter().map(|d| d / 1000.0).collect();
    let lo_all = fs.iter().chain(&ss).copied().fold(f64::INFINITY, f64::min);
    let hi_all = fs
        .iter()
        .chain(&ss)
        .copied()
        .fold(f64::NEG_INFINITY, f64::max);
    let lo = (lo_all / 2.0).floor() * 2.0;
    let hi = (hi_all.min(180.0) / 2.0).ceil() * 2.0;
    let bins: Vec<f64> = (0..=(((hi - lo) / 2.0).max(0.0) as usize))
        .map(|i| lo + i as f64 * 2.0)
        .collect();
    let freq = |d: &[f64]| -> Vec<(f64, Option<f64>)> {
        bins.iter()
            .map(|b| {
                (
                    *b,
                    Some(d.iter().filter(|x| **x >= *b && **x < b + 2.0).count() as f64),
                )
            })
            .collect()
    };
    let step = ((bins.len() as f64) / 17.0).ceil().max(1.0) as usize;
    let dist = panel(k)
        .child(section_header(
            k,
            &format!("Rondetijdfrequentie van {} en {}", first.name, second.name),
            "Aantal rondes per interval van twee seconden. Zo ziet ge niet alleen het gemiddelde, maar ook de volledige vorm en uitschieters.",
        ))
        .child(chart(
            s,
            k,
            ChartSpec {
                key: "distribution",
                height: 420.0,
                x_min: lo - 1.0,
                x_max: hi + 1.0,
                x_ticks: bins.iter().step_by(step).map(|b| (*b, vec![format!("{}", *b as i64)])).collect(),
                x_title: Some("Rondetijd (s)".into()),
                y_title: "Aantal rondes".into(),
                y_fmt: Box::new(|v| nl(v, 0, false)),
                grace: 0.0,
                begin_at_zero: true,
                zero_line: false,
                legend: true,
                series: vec![
                    Series { label: first.name.clone(), color: team_color(k, first.id, 0), width: 3.0, dash: None, points: freq(&fs), dots: 2.0, hidden: false },
                    Series { label: second.name.clone(), color: team_color(k, second.id, 1), width: 3.0, dash: None, points: freq(&ss), dots: 2.0, hidden: false },
                ],
                bands: Vec::new(),
                now: None,
                scatter: None,
            },
        ));
    col()
        .gap(16.0)
        .child(stats)
        .child(ranking)
        .child(timeline)
        .child(dist)
}

fn tempo_section(s: &State, k: &Ink, first: &Team, second: &Team) -> El {
    let p = &s.tactics;
    let (from, to) = (p.vals[T_FROM], p.vals[T_TO]);
    let control = |id: usize, label: &str| {
        field(
            k,
            label,
            num_input(s, k, id, label, font(13.5, 400.0), 34.0),
        )
        .grow(1.0)
        .w(0.0)
    };
    let quarter = |team: &Team| -> Vec<(f64, Option<f64>)> {
        let mut v = Vec::new();
        let mut h = from;
        while h < to - 1e-9 {
            v.push((h + 0.125, median(&durations_in_window(team, h, h + 0.25))));
            h += 0.25;
        }
        v
    };
    col()
        .gap(16.0)
        .child(
            panel(k)
                .child(section_header(
                    k,
                    "Tempo in detail",
                    "Beperk de kwartieranalyse of pas het nachtvenster aan. De consistentie blijft steeds over de volledige race berekend.",
                ))
                .child(
                    row()
                        .gap(12.0)
                        .child(control(T_FROM, "Van race-uur"))
                        .child(control(T_TO, "Tot race-uur"))
                        .child(control(N_FROM, "Nacht vanaf"))
                        .child(control(N_TO, "Nacht tot")),
                ),
        )
        .child(
            panel(k)
                .child(section_header(
                    k,
                    "Mediaan rondetijd per kwartier",
                    "Meer detail dan de uurblokken: korte versnellingen, terugval en kantelpunten worden afzonderlijk zichtbaar.",
                ))
                .child(chart(
                    s,
                    k,
                    ChartSpec {
                        key: "quarter",
                        height: 420.0,
                        x_min: from,
                        x_max: to,
                        x_ticks: hour_ticks(2.0, from, to, |x| vec![format!("{}u", x as i64)]),
                        x_title: Some("Uren sinds de start".into()),
                        y_title: "Mediaan rondetijd".into(),
                        y_fmt: Box::new(|v| pace(Some(v))),
                        grace: 0.0,
                        begin_at_zero: false,
                        zero_line: false,
                        legend: true,
                        series: vec![
                            Series { label: first.name.clone(), color: team_color(k, first.id, 0), width: 2.0, dash: None, points: quarter(first), dots: 0.0, hidden: false },
                            Series { label: second.name.clone(), color: team_color(k, second.id, 1), width: 2.0, dash: None, points: quarter(second), dots: 0.0, hidden: false },
                        ],
                        bands: Vec::new(),
                        now: None,
                        scatter: None,
                    },
                )),
        )
}

fn race_section(s: &State, k: &Ink, first: &Team, second: &Team) -> El {
    let p = &s.tactics;
    let lap_len = p.vals[LAP_LEN];
    let final_laps = second.cum.len() as f64 - first.cum.len() as f64;
    let cum_series = |team: &Team, i: usize| Series {
        label: team.name.clone(),
        color: team_color(k, team.id, i),
        width: 2.0,
        dash: None,
        points: std::iter::once((0.0, Some(0.0)))
            .chain(
                team.cum
                    .iter()
                    .enumerate()
                    .map(|(n, t)| (t / 3_600_000.0, Some(n as f64 + 1.0))),
            )
            .collect(),
        dots: 0.0,
        hidden: false,
    };
    let lead: Vec<(f64, Option<f64>)> = (0..=24 * 12)
        .map(|m| {
            let ms = m as f64 * 300_000.0;
            (
                m as f64 / 12.0,
                Some(upper_bound(&first.cum, ms) as f64 - upper_bound(&second.cum, ms) as f64),
            )
        })
        .collect();
    let lap_control = col()
        .grow(1.0)
        .w(0.0)
        .min_w(0.0)
        .gap(2.0)
        .px(16.0)
        .py(12.0)
        .child(t("Rondelengte", 12.5, 400.0, k.ink3))
        .child(
            col()
                .child(
                    text_input(&p.edits[LAP_LEN], font(24.0, 600.0))
                        .key(format!("tac-num-{LAP_LEN}"))
                        .label("Rondelengte")
                        .h(34.0)
                        .color(k.text)
                        .on_edit(|s: &mut State| &mut s.tactics.edits[LAP_LEN])
                        .on_input_change(|s: &mut State, _| typed(&mut s.tactics, LAP_LEN))
                        .on_submit(|s: &mut State, _| commit(&mut s.tactics, LAP_LEN)),
                )
                .child(el().h(1.0).w_full().fill(k.line2)),
        )
        .child(t("meter", 12.5, 400.0, k.ink3));
    let gap_final = {
        let ms = 24.0 * 3_600_000.0;
        let _ = ms;
        // Time gap at the end: time A needed to reach B's final progress.
        let target = second.cum.len();
        if target == 0 {
            0.0
        } else if first.cum.len() >= target {
            (first.cum[target - 1] - second.cum[target - 1]) / 1000.0
        } else {
            let tail = &first.dur[first.dur.len().saturating_sub(20)..];
            let pace_ms = median(tail).unwrap_or(1.0);
            (first.cum.last().copied().unwrap_or(0.0) + (target - first.cum.len()) as f64 * pace_ms
                - second.cum[target - 1])
                / 1000.0
        }
    };
    col()
        .gap(16.0)
        .child(stats_grid(
            k,
            "Raceverloop kerncijfers",
            vec![
                stat(k, &format!("Tijdskloof {}", first.name), &format!("{}s", signed_number(gap_final)), None, &format!("Positief betekent achter op {}", second.name), None),
                stat(k, "Rondeverschil", &signed_number(-final_laps), None, &format!("{} tegenover {}", first.name, second.name), None),
                stat(k, "Afstandsverschil", &format!("{} m", signed_number(-final_laps * lap_len)), None, &format!("{} meter per ronde", nl(lap_len, 3, false)), None),
                lap_control,
            ],
        ))
        .child(
            panel(k)
                .child(section_header(
                    k,
                    "Ronden over de volledige race",
                    "De staplijnen tonen elk geregistreerd passeermoment, zodat leiderswissels tot op rondeniveau zichtbaar blijven.",
                ))
                .child(chart(
                    s,
                    k,
                    ChartSpec {
                        key: "cumulative",
                        height: 420.0,
                        x_min: 0.0,
                        x_max: 24.0,
                        x_ticks: plain_hour_ticks(),
                        x_title: Some("Uren sinds de start".into()),
                        y_title: "Rondes".into(),
                        y_fmt: Box::new(|v| nl(v, 0, false)),
                        grace: 0.0,
                        begin_at_zero: true,
                        zero_line: false,
                        legend: true,
                        series: vec![cum_series(first, 0), cum_series(second, 1)],
                        bands: Vec::new(),
                        now: None,
                        scatter: None,
                    },
                )),
        )
        .child(
            panel(k)
                .child(section_header(
                    k,
                    "Wie lag wanneer voor?",
                    &format!(
                        "Boven nul lag {} voor, onder nul {}. De tweede as rekent hetzelfde verschil om met {} meter per ronde.",
                        first.name,
                        second.name,
                        nl(lap_len, 3, false)
                    ),
                ))
                .child(chart(
                    s,
                    k,
                    ChartSpec {
                        key: "lead",
                        height: 420.0,
                        x_min: 0.0,
                        x_max: 24.0,
                        x_ticks: plain_hour_ticks(),
                        x_title: Some("Uren sinds de start".into()),
                        y_title: "Rondeverschil".into(),
                        y_fmt: Box::new(|v| nl(v, 1, false)),
                        grace: 0.0,
                        begin_at_zero: false,
                        zero_line: true,
                        legend: true,
                        series: vec![Series { label: format!("Voorsprong {}", first.name), color: team_color(k, first.id, 0), width: 2.0, dash: None, points: lead, dots: 0.0, hidden: false }],
                        bands: Vec::new(),
                        now: None,
                        scatter: None,
                    },
                )),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_reference_parses_and_targets_last_year() {
        let race = bundled().as_ref().expect("bundled reference");
        assert_eq!(race.teams.len(), 21);
        let own = race.team(APOLLOON).unwrap();
        assert_eq!(own.cum.len(), 1095);
        let paces = build_target_paces(1095.0, Some(own));
        assert!((target_laps_at(&paces, 24.0) - 1095.0).abs() < 1e-6);
        assert_eq!(nl(1089.0, 0, false), "1.089");
        assert_eq!(nl(41.0, 1, true), "41,0");
        assert_eq!(signed_laps(Some(-6.0)), "-6");
        assert_eq!(pace(Some(83.25)), "1:23.250");
        assert_eq!(pace(Some(86_400.0 / 1095.0)), "1:18.904");
        assert_eq!(race_hour(0.85), "0u51");
    }

    #[test]
    fn historical_diagnostics_and_drafting_use_the_selected_reference() {
        let mut s = super::super::init_with_url("http://127.0.0.1:1".into());
        s.fixture = true;
        s.page = 4;
        s.tactics.section = 1;
        s.tactics.deep = 3;
        reset_diagnostics(&mut s.tactics);
        let mut rt = rune::Runtime::new(
            s,
            super::super::view,
            (1366.0, 1080.0),
            rune::Env {
                system_dark: false,
                scale: 1.0,
            },
        );
        rt.frame(0.0);
        assert!(rt.find("tac-chart-historical-diagnostics").is_some());
        assert!(rt.find("tac-chart-historical-break-even").is_some());
        let (x, y) = rt.find("tac-deep-4").expect("Volgeffect tab");
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.2);
        assert!(rt.find("tac-chart-historical-drafting-scatter").is_some());
        assert!(rt.find("tac-chart-historical-drafting-proximity").is_some());

        let fixture = Team {
            id: 42,
            name: "Test".into(),
            cum: vec![
                60_000.0, 120_000.0, 180_000.0, 240_000.0, 300_000.0, 385_000.0,
            ],
            dur: vec![60_000.0, 60_000.0, 60_000.0, 60_000.0, 60_000.0, 85_000.0],
        };
        let (slow, jumps) = diagnostic_laps(&fixture, 80.0, 8.0);
        assert_eq!(slow.iter().map(|lap| lap.number).collect::<Vec<_>>(), [6]);
        assert_eq!(jumps[0].change, Some(25.0));
        assert_eq!(
            nearest_passages(&[(10.0, 60.0)], &[(6.0, 61.0), (14.0, 62.0)]),
            [(4.0, 60.0)]
        );
        assert_eq!(rank_probability(&[60.0, 60.0], &[60.0, 60.0]), Some(1.0));
        assert!(rank_probability(&[60.0; 10], &[70.0; 10]).unwrap() < 0.05);
    }

    #[test]
    fn parse_errors_are_dutch() {
        assert_eq!(
            parse_race("nope").unwrap_err(),
            "Het bestand bevat geen geldige JSON."
        );
        assert_eq!(
            parse_race("[]").unwrap_err(),
            "Het bestand bevat geen teams."
        );
        assert_eq!(
            parse_race(r#"[{"teamId":1,"lapTimes":[1]},{"teamId":1,"lapTimes":[2]}]"#).unwrap_err(),
            "Team 1 staat meer dan één keer in het bestand."
        );
    }

    #[test]
    fn number_fields_clamp_on_commit_and_regenerate_paces() {
        let mut p = Page::default();
        p.edits[RECENT].replace_text("500");
        typed(&mut p, RECENT);
        assert_eq!(p.vals[RECENT], 20.0, "out of range waits for commit");
        commit(&mut p, RECENT);
        assert_eq!(p.vals[RECENT], 100.0);
        assert_eq!(p.edits[RECENT].text, "100");
        p.edits[HOUR + 3].replace_text("90");
        typed(&mut p, HOUR + 3);
        assert!(p.paces_edited);
        assert_eq!(target_paces(&p)[3], 90.0);
        p.edits[TARGET].replace_text("1200");
        typed(&mut p, TARGET);
        assert!(!p.paces_edited);
        assert!((target_laps_at(&target_paces(&p), 24.0) - 1200.0).abs() < 1e-6);
    }
}
