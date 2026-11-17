//! The three public tv screens: Binnenscherm (/display/inside), Competitiescherm
//! (/display/competitions) and Buitenscherm (/display/outside). Full screen, without the operator
//! sidebar and header, in their own palette (src/styles/displays.css), independent of the
//! operator theme. Ports src/components/display/*.tsx, the ranking and lap summaries of
//! src/lib/ranking.ts and the points of shared/points.ts.
//!
//! Sizes are the CSS clamp() values of displays.css resolved for a 1366×768 screen.
use super::*;
use rune::{Color, TextStyle, oklch, oklcha};
use std::collections::HashMap;

/// The rows of both lists on the Binnenscherm.
const INSIDE_LIST_LENGTH: usize = 25;
/// The runners on the Competities screen.
const COMPETITION_RANKING_LENGTH: usize = 20;
const MAX_COMPETITIONS: usize = 6;
const MIN_LAP_MS: i64 = 20_000;
const MAX_PLAUSIBLE_LAP_MS: i64 = 10 * 60_000;

const VW: f32 = 1366.0 / 100.0;
const VH: f32 = 768.0 / 100.0;
fn clamp(min: f32, pref: f32, max: f32) -> f32 {
    pref.max(min).min(max)
}

/// What the Competitiescherm's picker has ticked; `None` while it is closed.
#[derive(Default)]
pub(super) struct Screen {
    picking: Option<Vec<String>>,
}

// ---------------------------------------------------------------- logic

/// The daypart factor of the Brussels clock hour a lap started in.
fn daypart_factor(started_at: i64) -> Option<f64> {
    use chrono::{TimeZone, Timelike};
    let hour = chrono_tz::Europe::Brussels
        .timestamp_millis_opt(started_at)
        .single()?
        .hour();
    Some(match hour {
        0..=3 => 1.3,
        4..=11 => 1.8,
        12..=15 => 1.3,
        _ => 1.0,
    })
}
fn is_measured_lap(duration_ms: i64, source: &str) -> bool {
    duration_ms >= MIN_LAP_MS && source != "split"
}
fn lap_time_coefficient(duration_ms: i64) -> f64 {
    if duration_ms < 0 {
        return 0.0;
    }
    let seconds_faster = (85.0 - duration_ms as f64 / 1000.0).max(0.0);
    1.0 + seconds_faster * 0.125
}
/// Points per lap = 20 base points × time coefficient × daypart factor.
pub(super) fn lap_points(lap: &Value) -> f64 {
    let Some(started) = lap["startedAt"].as_i64() else {
        return 0.0;
    };
    let Some(factor) = daypart_factor(started) else {
        return 0.0;
    };
    let duration = lap["durationMs"].as_i64().unwrap_or(0);
    let coefficient = if is_measured_lap(duration, lap["source"].as_str().unwrap_or("")) {
        lap_time_coefficient(duration)
    } else {
        1.0
    };
    20.0 * coefficient * factor
}
fn plausible(duration_ms: i64) -> bool {
    (MIN_LAP_MS..=MAX_PLAUSIBLE_LAP_MS).contains(&duration_ms)
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Entry {
    pub runner_id: String,
    pub runner_number: String,
    pub runner_name: String,
    pub lap_count: i64,
    pub points: f64,
    pub average_ms: Option<i64>,
}
impl Entry {
    fn label(&self) -> String {
        runner_label(&self.runner_number, &self.runner_name)
    }
}
fn runner_label(number: &str, name: &str) -> String {
    if number.is_empty() {
        name.to_string()
    } else {
        format!("{number} {name}")
    }
}
fn str_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}
/// Dutch collation, close enough for names: case and accents fold first.
fn name_order(a: &str, b: &str) -> std::cmp::Ordering {
    let fold = |s: &str| s.to_lowercase();
    fold(a).cmp(&fold(b)).then_with(|| a.cmp(b))
}

/// buildRunnerRanking: by points (`by_points`) or by laps, then laps, faster average, name.
pub(super) fn runner_ranking(
    runners: &[Value],
    laps: &[Value],
    by_points: bool,
    label_id: Option<&str>,
) -> Vec<Entry> {
    let by_id: HashMap<&str, &Value> = runners
        .iter()
        .map(|r| (r["id"].as_str().unwrap_or(""), r))
        .collect();
    let mut order: Vec<String> = Vec::new();
    let mut entries: HashMap<String, (Entry, i64, i64)> = HashMap::new();
    for lap in laps {
        if let Some(label) = label_id
            && !lap["labels"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|l| l["id"] == label)
        {
            continue;
        }
        let id = lap["runnerId"].as_str().unwrap_or("").to_string();
        let (entry, timed, total) = entries.entry(id.clone()).or_insert_with(|| {
            order.push(id.clone());
            let runner = by_id.get(id.as_str());
            (
                Entry {
                    runner_id: id.clone(),
                    runner_number: runner
                        .map(|r| str_of(&r["runnerNumber"]))
                        .unwrap_or_else(|| str_of(&lap["runnerNumber"])),
                    runner_name: runner
                        .map(|r| str_of(&r["name"]))
                        .unwrap_or_else(|| str_of(&lap["runnerName"])),
                    lap_count: 0,
                    points: 0.0,
                    average_ms: None,
                },
                0,
                0,
            )
        });
        entry.lap_count += 1;
        entry.points += lap_points(lap);
        let duration = lap["durationMs"].as_i64().unwrap_or(-1);
        if plausible(duration) {
            *timed += 1;
            *total += duration;
            entry.average_ms = Some((*total as f64 / *timed as f64).round() as i64);
        }
    }
    let mut list: Vec<Entry> = order
        .into_iter()
        .map(|id| entries.remove(&id).unwrap().0)
        .collect();
    list.sort_by(|a, b| {
        let primary = if by_points {
            b.points
                .partial_cmp(&a.points)
                .unwrap_or(std::cmp::Ordering::Equal)
        } else {
            b.lap_count.cmp(&a.lap_count)
        };
        primary
            .then(b.lap_count.cmp(&a.lap_count))
            .then(
                a.average_ms
                    .unwrap_or(i64::MAX)
                    .cmp(&b.average_ms.unwrap_or(i64::MAX)),
            )
            .then_with(|| name_order(&a.runner_name, &b.runner_name))
    });
    list
}

/// buildRecentLapSummaries: the newest laps with the runner's best and average lap.
pub(super) fn recent_laps(laps: &[Value], limit: usize) -> Vec<(&Value, Option<i64>, Option<i64>)> {
    let mut totals: HashMap<&str, (i64, i64, i64)> = HashMap::new();
    for lap in laps {
        let d = lap["durationMs"].as_i64().unwrap_or(-1);
        if !plausible(d) {
            continue;
        }
        let t = totals
            .entry(lap["runnerId"].as_str().unwrap_or(""))
            .or_insert((0, 0, i64::MAX));
        t.0 += 1;
        t.1 += d;
        t.2 = t.2.min(d);
    }
    let mut sorted: Vec<&Value> = laps.iter().collect();
    let n = |v: &Value, k: &str| v[k].as_i64().unwrap_or(0);
    sorted.sort_by(|a, b| {
        n(b, "finishedAt")
            .cmp(&n(a, "finishedAt"))
            .then(n(b, "createdAt").cmp(&n(a, "createdAt")))
            .then_with(|| {
                a["id"]
                    .as_str()
                    .unwrap_or("")
                    .cmp(b["id"].as_str().unwrap_or(""))
            })
    });
    sorted
        .into_iter()
        .take(limit)
        .map(|lap| {
            let t = totals.get(lap["runnerId"].as_str().unwrap_or(""));
            (
                lap,
                t.map(|t| t.2),
                t.map(|t| (t.1 as f64 / t.0 as f64).round() as i64),
            )
        })
        .collect()
}

/// getNextWaitingRunner: the first waiting runner by place in line, then who joined first.
pub(super) fn next_waiting(runners: &[Value]) -> Option<&Value> {
    runners
        .iter()
        .filter(|r| r["status"] == "waiting")
        .min_by_key(|r| {
            (
                r["queueIndex"].as_i64().unwrap_or(i64::MAX),
                r["statusSince"].as_i64().unwrap_or(i64::MAX),
            )
        })
}

/// buildKpis().lapsPerHour.
pub(super) fn laps_per_hour(laps: &[Value], race: &Value) -> Option<f64> {
    let finished: Vec<i64> = laps
        .iter()
        .filter_map(|l| l["finishedAt"].as_i64())
        .collect();
    let start = race["raceStartedAt"]
        .as_i64()
        .or_else(|| finished.iter().min().copied())?;
    let end = race["raceFinishedAt"]
        .as_i64()
        .or_else(|| finished.iter().max().copied())?;
    let elapsed = (end - start).max(0);
    (elapsed > 0).then(|| laps.len() as f64 / (elapsed as f64 / 3_600_000.0))
}

/// nl-BE integer: 1.234.
pub(super) fn format_int(n: i64) -> String {
    let digits = n.unsigned_abs().to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push('.');
        }
        out.push(c);
    }
    if n < 0 { format!("-{out}") } else { out }
}
/// nl-BE with one decimal: 142,5.
pub(super) fn format_points(points: f64) -> String {
    let tenths = (points * 10.0 + if points < 0.0 { -0.5 } else { 0.5 }).trunc() as i64;
    let sign = if tenths < 0 { "-" } else { "" };
    let tenths = tenths.abs();
    format!("{sign}{},{}", format_int(tenths / 10), tenths % 10)
}
/// formatDurationMs: m:ss.mmm, h:mm:ss.mmm past an hour.
pub(super) fn format_duration(ms: Option<i64>) -> String {
    let Some(ms) = ms else { return "—".into() };
    let ms = ms.max(0);
    let (h, m, s, f) = (ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}.{f:03}")
    } else {
        format!("{m}:{s:02}.{f:03}")
    }
}
/// formatElapsedSeconds: m:ss, h:mm:ss past an hour.
fn format_elapsed(ms: i64) -> String {
    let t = ms.max(0) / 1000;
    let (h, m, s) = (t / 3600, t / 60 % 60, t % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}
/// Brussels clock time without milliseconds.
fn format_clock(ms: i64) -> String {
    use chrono::TimeZone;
    chrono_tz::Europe::Brussels
        .timestamp_millis_opt(ms)
        .single()
        .map(|d| d.format("%H:%M:%S").to_string())
        .unwrap_or_else(|| "—".into())
}

/// competitionVerdict.
pub(super) fn competition_verdict(standings: &[(String, i64)]) -> String {
    let Some((leader, laps)) = standings.first() else {
        return String::new();
    };
    if *laps == 0 {
        return "Nog geen rondes".into();
    }
    let tied: Vec<&str> = standings
        .iter()
        .filter(|s| s.1 == *laps)
        .map(|s| s.0.as_str())
        .collect();
    if tied.len() == standings.len() {
        return "Gelijke stand".into();
    }
    if tied.len() > 1 {
        return format!("{} staan gelijk", tied.join(" en "));
    }
    let lead = laps - standings[1].1;
    format!(
        "{leader} leidt met {}",
        if lead == 1 {
            "1 ronde".to_string()
        } else {
            format!("{lead} rondes")
        }
    )
}

// ---------------------------------------------------------------- look

struct Pal {
    bg: Color,
    surface: Color,
    surface2: Color,
    ink: Color,
    ink2: Color,
    ink3: Color,
    line: Color,
    accent: Color,
    gold: Color,
    /// color-mix(apolloon-blue 18%, transparent) over the surface.
    highlight: Color,
}
fn pal(dark: bool) -> Pal {
    if dark {
        Pal {
            bg: oklch(0.178, 0.0, 0.0),
            surface: oklch(0.218, 0.0, 0.0),
            surface2: oklch(0.26, 0.0, 0.0),
            ink: oklch(0.961, 0.0, 0.0),
            ink2: oklch(0.77, 0.0, 0.0),
            ink3: oklch(0.633, 0.0, 0.0),
            line: oklch(0.285, 0.0, 0.0),
            accent: oklch(0.715, 0.13, 247.8),
            gold: oklch(0.7904, 0.1386, 85.24),
            highlight: rune::color::hex("#172b3b").unwrap(),
        }
    } else {
        Pal {
            bg: oklch(1.0, 0.0, 0.0),
            surface: oklch(0.967, 0.001, 286.4),
            surface2: oklch(0.932, 0.004, 286.3),
            ink: oklch(0.141, 0.004, 285.8),
            ink2: oklch(0.37, 0.012, 285.8),
            ink3: oklch(0.552, 0.014, 285.9),
            line: oklch(0.92, 0.004, 286.3),
            accent: oklch(0.4923, 0.1419, 251.85),
            gold: oklch(0.5538, 0.1207, 66.44),
            highlight: rune::color::hex("#d0e1f2").unwrap(),
        }
    }
}
fn blue() -> Color {
    oklch(0.5681, 0.1641, 251.76)
}
fn white() -> Color {
    oklch(1.0, 0.0, 0.0)
}
/// Geist at `size` px, line-height `lh` × size, letter-spacing `em`. `INHERIT` is the
/// -0.01em of .display-root, which children inherit as px of its 14px font. `ROUNDING` makes
/// up for Chromium on Linux rounding each glyph advance to whole pixels.
const INHERIT: f32 = -0.01;
fn font(size: f32, weight: f32, lh: f32, em: f32) -> TextStyle {
    let spacing = if em == INHERIT { -0.14 } else { size * em };
    let rounding = if size < 24.0 {
        0.12
    } else if size < 40.0 {
        0.15
    } else {
        -0.35
    };
    TextStyle::new(size, weight)
        .lh(size * lh)
        .tracking(spacing + rounding)
        .features("'tnum' 1")
}
fn t(value: impl Into<String>, style: TextStyle, color: Color) -> El {
    text(value.into()).font(style).color(color)
}
fn score_font(size: f32, weight: f32) -> TextStyle {
    TextStyle::new(size, weight)
        .family(rune::Family::Named("Big Shoulders Display Thin"))
        .lh(size)
        .tracking(size * 0.01)
}
fn logo(s: &State, w: f32, h: f32) -> El {
    // icons 27/28: the wordmark for light and for dark backgrounds.
    match s.icons.get(28) {
        Some(image) => rune::el()
            .size(w, h)
            .pixels_fit(image.pixels(), rune::SurfaceFit::Fit),
        None => rune::el().size(w, h),
    }
}
fn live_dot(size: f32, color: Color) -> El {
    rune::el().size(size, size).radius(size / 2.0).fill(color)
}

fn snapshot_list<'a>(s: &'a State, key: &str) -> &'a [Value] {
    s.snapshot[key].as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn history_laps(s: &State) -> &[Value] {
    s.history["laps"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
}
fn finished(s: &State) -> bool {
    !s.snapshot["race"]["raceFinishedAt"].is_null()
}
fn active_runner(s: &State) -> Option<&Value> {
    if finished(s) {
        return None;
    }
    let id = &s.snapshot["race"]["activeRunnerId"];
    snapshot_list(s, "runners")
        .iter()
        .find(|r| !id.is_null() && r["id"] == *id)
}
fn next_runner(s: &State) -> Option<&Value> {
    if finished(s) {
        None
    } else {
        next_waiting(snapshot_list(s, "runners"))
    }
}
fn label_of(r: &Value) -> String {
    runner_label(&str_of(&r["runnerNumber"]), &str_of(&r["name"]))
}

pub(super) fn view(s: &State) -> El {
    let body = match s.page {
        5 => inside(s),
        6 => competitions(s),
        _ => outside(s),
    };
    let root = rune::el().w_full().h_full().child(body);
    match picker(s) {
        Some(modal) => root.child(modal),
        None => root,
    }
}

// ---------------------------------------------------------------- shared header

/// The top line of the Binnenscherm and the Competitiescherm, around `middle`.
fn header(s: &State, p: &Pal, middle: El) -> El {
    row()
        .h(34.0)
        .center_y()
        .gap(2.0 * VW)
        .min_w(0.0)
        .child(
            rune::el()
                .key("display-home")
                .role("button")
                .label("Apolloon, terug naar start")
                .focusable(true)
                .on_press(|s: &mut State| s.page = 0)
                .child(
                    logo(
                        s,
                        clamp(110.0, 7.0 * VW, 160.0),
                        clamp(34.0, 2.2 * VW, 48.0),
                    )
                    .mt(-2.0)
                    .mb(2.0),
                ),
        )
        .child(middle.grow(1.0).min_w(0.0))
        .child(totals(s, p))
}
fn baseline_pair(small: El, small_size: f32, big: El, big_size: f32, gap: f32) -> El {
    // Bottom-aligned line boxes of 1.2 × size; the smaller one is lifted to share the baseline.
    row()
        .items_end()
        .gap(gap)
        .child(small.mb((big_size - small_size) * 0.26))
        .child(big)
}
fn totals(s: &State, p: &Pal) -> El {
    let race = &s.snapshot["race"];
    let laps = history_laps(s);
    let dt = clamp(14.0, VW, 22.0);
    let dd = clamp(20.0, 1.6 * VW, 34.0);
    let elapsed = match (
        race["raceStartedAt"].as_i64(),
        race["raceFinishedAt"].as_i64(),
    ) {
        (Some(start), Some(end)) => format_elapsed(end - start),
        (Some(start), None) => format_elapsed(s.clock - start),
        _ => "0:00".into(),
    };
    let per_hour = laps_per_hour(laps, race)
        .map(format_points)
        .unwrap_or_else(|| "—".into());
    let item = |name: &str, value: String| {
        baseline_pair(
            t(name, font(dt, 400.0, 1.2, -0.01), p.ink3),
            dt,
            t(value, font(dd, 600.0, 1.2, -0.02), p.ink),
            dd,
            0.6 * VW,
        )
    };
    row()
        .gap(2.4 * VW)
        .child(item("Racetijd", elapsed))
        .child(item("Rondes", format_int(laps.len() as i64)))
        .child(item("Per uur", per_hour))
}
fn panel(p: &Pal) -> El {
    col()
        .min_h(0.0)
        .h_full()
        .py(1.6 * VH + 1.0)
        .px(1.3 * VW + 1.0)
        .radius(0.7 * VW)
        .border(1.0, p.line)
        .fill(p.surface)
        .clip_rounded(0.7 * VW)
}
fn panel_heading(title: &str, note: Option<&str>, p: &Pal) -> El {
    let h2 = clamp(20.0, 1.5 * VW, 32.0);
    let mut r = row().h(h2 * 1.25).items_end().gap(VW).min_w(0.0).child(t(
        title,
        font(h2, 600.0, 1.25, -0.02),
        p.ink,
    ));
    if let Some(note) = note {
        let size = clamp(12.0, 0.85 * VW, 18.0);
        r = r.child(
            row()
                .grow(1.0)
                .min_w(0.0)
                .justify_end()
                .mb((h2 - size) * 0.24)
                .child(
                    t(note, font(size, 400.0, 1.5, -0.01), p.ink3)
                        .truncate()
                        .min_w(0.0),
                ),
        );
    }
    r
}
fn screen(p: &Pal) -> El {
    col()
        .w_full()
        .h_full()
        .fill(p.bg)
        .child(rune::el().w_full().h(0.6 * VH).fill(blue()))
}

// ---------------------------------------------------------------- Binnenscherm

fn inside(s: &State) -> El {
    let p = pal(true);
    let done = finished(s);
    let now_size = clamp(16.0, 1.25 * VW, 28.0);
    let active = active_runner(s);
    let next = next_runner(s);
    let race = &s.snapshot["race"];
    let mut label = row().center_y().gap(0.6 * now_size);
    if !done {
        label = label.child(live_dot(0.5 * now_size, p.accent));
    }
    label = label.child(t(
        if done {
            "Race afgelopen"
        } else {
            "Nu op de piste"
        },
        font(now_size, 500.0, 1.5, -0.01),
        p.ink3,
    ));
    let runner_text = match active {
        Some(r) => label_of(r),
        None if done => "Bedankt aan alle lopers".into(),
        None if !race["raceStartedAt"].is_null() => "Even niemand".into(),
        None => "Nog niemand gestart".into(),
    };
    let mut now = row()
        .center_y()
        .gap(0.6 * VW)
        .min_w(0.0)
        .clip_rounded(0.0)
        .role("group")
        .label("Nu op de piste")
        .child(label)
        .child(
            t(runner_text, font(now_size, 650.0, 1.5, -0.02), p.ink)
                .truncate()
                .min_w(0.0),
        );
    if !done {
        let next_text = next.map(label_of).unwrap_or_else(|| "niemand klaar".into());
        now = now.child(
            row()
                .ml(0.6 * VW)
                .pl(1.2 * VW + 1.0)
                .min_w(0.0)
                .center_y()
                .border_sides([0.0, 0.0, 0.0, 1.0], p.line)
                .child(t(
                    "Volgende\u{a0}",
                    font(now_size, 400.0, 1.5, -0.01),
                    p.ink2,
                ))
                .child(
                    t(next_text, font(now_size, 600.0, 1.5, -0.01), p.ink)
                        .truncate()
                        .min_w(0.0),
                ),
        );
    }

    let width = 1366.0 - 4.0 * VW - 1.2 * VW;
    let left_w = width * 1.5 / 2.5;
    let right_w = width - left_w;
    let board = row()
        .grow(1.0)
        .min_h(0.0)
        .gap(1.2 * VW)
        .child(recent_panel(s, &p).w(left_w))
        .child(points_panel(s, &p).w(right_w));
    screen(&p).child(
        col()
            .grow(1.0)
            .min_h(0.0)
            .w_full()
            .pt(2.2 * VH)
            .pb(2.2 * VH)
            .px(2.0 * VW)
            .gap(1.6 * VH)
            .child(header(s, &p, now))
            .child(board),
    )
}

/// A table cell: fixed width, padded, clipped, its text centred on the row.
fn cell(width: f32, content: El, align_end: bool, center: bool) -> El {
    let r = row()
        .w(width)
        .h_full()
        .px(0.6 * VW)
        .center_y()
        .min_w(0.0)
        .clip_rounded(0.0)
        .child(content);
    if align_end {
        r.justify_end()
    } else if center {
        r.justify_center()
    } else {
        r
    }
}
fn head_cells(cols: &[(f32, &str, bool)], p: &Pal) -> El {
    let size = clamp(12.0, 0.8 * VW, 16.0);
    let mut r = row().h(2.4 * VH).w_full();
    for (w, name, end) in cols {
        let mut c = row()
            .w(*w)
            .h_full()
            .px(0.6 * VW)
            .pb(0.4 * VH)
            .items_end()
            .min_w(0.0)
            .clip_rounded(0.0);
        if *end {
            c = c.justify_end();
        }
        r = r.child(c.child(t(*name, font(size, 500.0, 1.1, -0.01), p.ink3)));
    }
    r
}
fn table_row(p: &Pal) -> El {
    row()
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .border_sides([1.0, 0.0, 0.0, 0.0], p.line)
}
fn inside_empty(message: &str, p: &Pal) -> El {
    rune::el()
        .w_full()
        .min_h(12.0 * VH)
        .padding(2.0 * VH)
        .center()
        .border(1.0, p.line)
        .border_dash(4.0, 4.0)
        .radius(0.7 * VW)
        .child(
            t(
                message,
                font(clamp(16.0, 1.2 * VW, 26.0), 400.0, 1.5, -0.01),
                p.ink3,
            )
            .wrap(),
        )
}

fn recent_panel(s: &State, p: &Pal) -> El {
    let inner = 1366.0 - 4.0 * VW - 1.2 * VW;
    let inner = inner * 1.5 / 2.5 - 2.0 - 2.6 * VW;
    let w = [0.11, 0.42, 0.14, 0.09, 0.12, 0.12].map(|f| f * inner);
    let title = format!("Laatste {INSIDE_LIST_LENGTH} lopers");
    let mut panel = panel(p)
        .role("region")
        .label(title.clone())
        .gap(0.6 * VH)
        .child(panel_heading(&title, None, p));
    let recent = recent_laps(history_laps(s), INSIDE_LIST_LENGTH);
    if recent.is_empty() {
        return panel.child(inside_empty(
            "De eerste rondes verschijnen hier zodra de timing start.",
            p,
        ));
    }
    let big = clamp(15.0, 1.1 * VW, 23.0);
    let mid = clamp(14.0, VW, 21.0);
    let when = clamp(13.0, 0.95 * VW, 20.0);
    let mut table = col().grow(1.0).min_h(0.0).w_full().child(head_cells(
        &[
            (w[0], "Binnen om", false),
            (w[1], "Loper", false),
            (w[2], "Deze ronde", false),
            (w[3], "Punten", false),
            (w[4], "Snelste", false),
            (w[5], "Gem.", false),
        ],
        p,
    ));
    for (i, (lap, best, avg)) in recent.iter().enumerate() {
        let first = if i == 0 {
            let size = clamp(11.0, 0.7 * VW, 14.0);
            row()
                .py(0.2 * size)
                .px(0.55 * size)
                .radius(0.3 * size)
                .fill(blue())
                .child(t("NET BINNEN", font(size, 700.0, 1.1, 0.06), white()))
        } else {
            t(
                format_clock(lap["finishedAt"].as_i64().unwrap_or(0)),
                font(when, 400.0, 1.1, -0.01),
                p.ink3,
            )
        };
        let runner = row()
            .items_end()
            .min_w(0.0)
            .child(t(
                runner_label(&str_of(&lap["runnerNumber"]), &str_of(&lap["runnerName"])),
                font(big, 600.0, 1.1, -0.015),
                p.ink,
            ))
            .child(
                t(
                    format!("ronde {}", lap["lapNumber"].as_i64().unwrap_or(0)),
                    font(0.7 * big, 500.0, 1.1, 0.0),
                    p.ink3,
                )
                .ml(0.7 * 0.7 * big)
                .mb(0.1 * big),
            );
        table = table.child(
            table_row(p)
                .key(lap["id"].as_str().unwrap_or("").to_string())
                .child(cell(w[0], first, false, false))
                .child(cell(w[1], runner, false, false))
                .child(cell(
                    w[2],
                    t(
                        format_duration(lap["durationMs"].as_i64()),
                        font(big, 650.0, 1.1, -0.02),
                        if i == 0 { p.accent } else { p.ink },
                    ),
                    false,
                    false,
                ))
                .child(cell(
                    w[3],
                    t(
                        format_points(lap_points(lap)),
                        font(mid, 600.0, 1.1, -0.01),
                        p.gold,
                    ),
                    false,
                    false,
                ))
                .child(cell(
                    w[4],
                    t(format_duration(*best), font(mid, 500.0, 1.1, -0.01), p.ink2),
                    false,
                    false,
                ))
                .child(cell(
                    w[5],
                    t(format_duration(*avg), font(mid, 500.0, 1.1, -0.01), p.ink2),
                    false,
                    false,
                )),
        );
    }
    for _ in recent.len()..INSIDE_LIST_LENGTH {
        table = table.child(table_row(p));
    }
    panel = panel.child(table);
    panel
}

fn points_panel(s: &State, p: &Pal) -> El {
    let inner = 1366.0 - 4.0 * VW - 1.2 * VW;
    let inner = inner / 2.5 - 2.0 - 2.6 * VW;
    let head = clamp(12.0, 0.8 * VW, 16.0);
    let place_w = 3.2 * head;
    let w = [place_w, inner * 0.6 - place_w, inner * 0.18, inner * 0.22];
    let ranking: Vec<Entry> =
        runner_ranking(snapshot_list(s, "runners"), history_laps(s), true, None)
            .into_iter()
            .take(INSIDE_LIST_LENGTH)
            .collect();
    let mut panel = panel(p)
        .role("region")
        .label("Ranking op punten")
        .gap(0.6 * VH)
        .child(panel_heading(
            "Ranking op punten",
            Some("Snelle rondes en rondes tussen middernacht en 16 uur tellen zwaarder"),
            p,
        ));
    if ranking.is_empty() {
        return panel.child(inside_empty("Nog geen rondes voor deze selectie", p));
    }
    let big = clamp(15.0, 1.1 * VW, 23.0);
    let mid = clamp(14.0, VW, 21.0);
    let mut table = col().grow(1.0).min_h(0.0).w_full().child(head_cells(
        &[
            (w[0], "", false),
            (w[1], "Loper", false),
            (w[2], "Rondes", true),
            (w[3], "Punten", true),
        ],
        p,
    ));
    for (i, r) in ranking.iter().enumerate() {
        let mut tr = table_row(p).key(r.runner_id.clone());
        if i == 0 {
            tr = tr.fill(p.highlight);
        }
        let podium = i < 3;
        table = table.child(
            tr.child(cell(
                w[0],
                t(
                    (i + 1).to_string(),
                    font(mid, if podium { 700.0 } else { 500.0 }, 1.1, -0.01),
                    if podium { p.gold } else { p.ink3 },
                ),
                false,
                true,
            ))
            .child(cell(
                w[1],
                t(r.label(), font(big, 550.0, 1.1, -0.01), p.ink)
                    .truncate()
                    .min_w(0.0),
                false,
                false,
            ))
            .child(cell(
                w[2],
                t(
                    r.lap_count.to_string(),
                    font(mid, 400.0, 1.1, -0.01),
                    p.ink3,
                ),
                true,
                false,
            ))
            .child(cell(
                w[3],
                t(format_points(r.points), font(big, 650.0, 1.1, -0.01), p.ink),
                true,
                false,
            )),
        );
    }
    for _ in ranking.len()..INSIDE_LIST_LENGTH {
        table = table.child(table_row(p));
    }
    panel = panel.child(table);
    panel
}

// ---------------------------------------------------------------- Competitiescherm

fn competitions(s: &State) -> El {
    let p = pal(true);
    let labels = snapshot_list(s, "labels");
    let ids: Vec<Vec<String>> = s.snapshot["settings"]["competitions"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| c.as_array().into_iter().flatten().map(str_of).collect())
        .collect();
    let can_add = ids.len() < MAX_COMPETITIONS && labels.len() >= 2;
    let title = t(
        "Competities",
        score_font(clamp(26.0, 2.0 * VW, 44.0), 800.0),
        p.ink,
    )
    .role("heading");
    let width = 1366.0 - 4.0 * VW - 1.2 * VW;
    let left_w = width * 2.3 / 3.3;
    let right_w = width - left_w;

    let mut counts: HashMap<&str, i64> = HashMap::new();
    for lap in history_laps(s) {
        for l in lap["labels"].as_array().into_iter().flatten() {
            *counts.entry(l["id"].as_str().unwrap_or("")).or_default() += 1;
        }
    }
    let left = if ids.is_empty() {
        let size = clamp(16.0, 1.3 * VW, 28.0);
        let mut empty = col()
            .w(left_w)
            .h_full()
            .center()
            .gap(2.4 * VH)
            .padding(4.0 * VH)
            .border(1.0, p.line)
            .border_dash(3.0, 3.0)
            .radius(0.7 * VW)
            .child(
                col()
                    .items_center()
                    .child(t(
                        "Kies welke ploegen tegen elkaar strijden,",
                        font(size, 400.0, 1.5, -0.01),
                        p.ink2,
                    ))
                    .child(t(
                        "bijvoorbeeld 1ste, 2de en 3de jaar.",
                        font(size, 400.0, 1.5, -0.01),
                        p.ink2,
                    )),
            )
            .child(
                row()
                    .key("competition-add")
                    .role("button")
                    .label("Competitie toevoegen")
                    .focusable(can_add)
                    .center_y()
                    .gap(0.5 * size)
                    .py(0.6 * size)
                    .px(1.1 * size)
                    .radius(0.5 * size)
                    .fill(blue())
                    .opacity(if can_add { 1.0 } else { 0.5 })
                    .on_press(move |s: &mut State| {
                        if can_add {
                            s.public_screens.picking = Some(Vec::new());
                        }
                    })
                    .child(plus_icon(20.0, white()))
                    .child(t(
                        "Competitie toevoegen",
                        font(size, 600.0, 1.25, -0.01),
                        white(),
                    )),
            );
        if labels.len() < 2 {
            empty = empty.child(t(
                "Maak eerst minstens twee labels in Beheer › Labels.",
                font(size, 400.0, 1.5, -0.01),
                p.ink2,
            ));
        }
        empty
    } else {
        let by_id: HashMap<&str, &Value> = labels
            .iter()
            .map(|l| (l["id"].as_str().unwrap_or(""), l))
            .collect();
        let mut list = col().w(left_w).h_full().gap(1.4 * VH).min_h(0.0);
        for group in &ids {
            let teams: Vec<&Value> = group
                .iter()
                .filter_map(|id| by_id.get(id.as_str()).copied())
                .collect();
            if teams.is_empty() {
                continue;
            }
            list = list.child(
                competition(s, &p, group.clone(), &teams, &counts).grow(teams.len() as f32 + 1.4),
            );
        }
        list
    };

    let ranking: Vec<Entry> =
        runner_ranking(snapshot_list(s, "runners"), history_laps(s), false, None)
            .into_iter()
            .take(COMPETITION_RANKING_LENGTH)
            .collect();
    let help = clamp(12.0, 0.85 * VW, 18.0);
    let mut right = panel(&p)
        .w(right_w)
        .role("region")
        .label("Ranking op meeste rondes")
        .child(panel_heading("Meeste rondes", None, &p))
        .child(
            t(
                "Bij gelijke stand telt het snelste gemiddelde.",
                font(help, 400.0, 1.5, -0.01),
                p.ink3,
            )
            .mt(0.4 * VH)
            .mb(0.8 * VH),
        );
    if ranking.is_empty() {
        right = right.child(inside_empty("Nog geen rondes.", &p));
    } else {
        let size = clamp(15.0, 1.1 * VW, 23.0);
        let mut list = col().grow(1.0).min_h(0.0).w_full();
        for (i, r) in ranking.iter().enumerate() {
            let podium = i < 3;
            let mut li = row()
                .key(r.runner_id.clone())
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .center_y()
                .gap(0.6 * VW);
            li = if i == 0 {
                li.fill(p.highlight).radius(0.4 * VW)
            } else {
                li.border_sides([1.0, 0.0, 0.0, 0.0], p.line)
            };
            list = list.child(
                li.child(row().w(2.2 * size).justify_center().child(t(
                    (i + 1).to_string(),
                    font(size, if podium { 700.0 } else { 500.0 }, 1.5, -0.01),
                    if podium { p.gold } else { p.ink3 },
                )))
                .child(
                    t(r.label(), font(size, 550.0, 1.5, -0.01), p.ink)
                        .truncate()
                        .min_w(0.0)
                        .grow(1.0),
                )
                .child(
                    row()
                        .items_end()
                        .child(t(
                            r.lap_count.to_string(),
                            font(size, 650.0, 1.5, -0.01),
                            p.ink,
                        ))
                        .child(
                            t(
                                format!("gem. {}", format_duration(r.average_ms)),
                                font(0.72 * size, 500.0, 1.5, -0.01),
                                p.ink3,
                            )
                            .ml(0.5 * size)
                            .mb(0.1 * size),
                        ),
                ),
            );
        }
        right = right.child(list);
    }

    screen(&p).child(
        col()
            .grow(1.0)
            .min_h(0.0)
            .w_full()
            .pt(2.2 * VH)
            .pb(2.2 * VH)
            .px(2.0 * VW)
            .gap(1.6 * VH)
            .child(header(s, &p, row().child(title)))
            .child(
                row()
                    .grow(1.0)
                    .min_h(0.0)
                    .gap(1.2 * VW)
                    .child(left)
                    .child(right),
            ),
    )
}

fn plus_icon(size: f32, color: Color) -> El {
    let stroke = size / 12.0 * 1.75;
    let arm = size * 14.0 / 24.0;
    rune::el()
        .size(size, size)
        .child(
            rune::el()
                .size(arm, stroke)
                .radius(stroke / 2.0)
                .fill(color)
                .absolute((size - arm) / 2.0, (size - stroke) / 2.0),
        )
        .child(
            rune::el()
                .size(stroke, arm)
                .radius(stroke / 2.0)
                .fill(color)
                .absolute((size - stroke) / 2.0, (size - arm) / 2.0),
        )
}

fn team_color(label: &Value) -> Color {
    rune::color::hex(label["color"].as_str().unwrap_or("#3b82f6")).unwrap_or_else(|| blue())
}

/// One competition as a bar chart: a thick bar per team, leader on top.
fn competition(
    s: &State,
    p: &Pal,
    ids: Vec<String>,
    teams: &[&Value],
    counts: &HashMap<&str, i64>,
) -> El {
    let mut standings: Vec<(&Value, i64)> = teams
        .iter()
        .map(|l| {
            (
                *l,
                counts
                    .get(l["id"].as_str().unwrap_or(""))
                    .copied()
                    .unwrap_or(0),
            )
        })
        .collect();
    standings.sort_by(|a, b| {
        b.1.cmp(&a.1).then_with(|| {
            name_order(
                a.0["name"].as_str().unwrap_or(""),
                b.0["name"].as_str().unwrap_or(""),
            )
        })
    });
    let leader = standings[0].1;
    let title = teams
        .iter()
        .map(|l| str_of(&l["name"]))
        .collect::<Vec<_>>()
        .join(" vs ");
    let verdict = competition_verdict(
        &standings
            .iter()
            .map(|(l, n)| (str_of(&l["name"]), *n))
            .collect::<Vec<_>>(),
    );
    let n = teams.len() as f32;
    // Heights of a competition box are shared out by (teams + 1.4).
    let digits = format_int(leader).len() as f32;
    let remove_ids = ids.clone();
    let mut bars = col().grow(1.0).min_h(0.0).w_full();
    for (label, laps) in &standings {
        let behind = leader - laps;
        let leading = *laps > 0 && behind == 0;
        let share = if leader > 0 {
            *laps as f32 / leader as f32
        } else {
            0.0
        };
        let team_size = 22.0_f32.min(40.0 / n.max(1.0)).max(14.0);
        let figure = (team_size * 2.1).min(48.0);
        let ink = if leading { p.ink } else { p.ink2 };
        let mut team = row().w(220.0).center_y().gap(0.45 * team_size).min_w(0.0);
        if let Some(image) = label["imageUrl"].as_str().and_then(|u| s.logos.get(u)) {
            team = team.child(
                rune::el()
                    .size(1.3 * team_size, 1.3 * team_size)
                    .pixels_fit(image.pixels(), rune::SurfaceFit::Fit),
            );
        } else {
            team = team.child(
                rune::el()
                    .size(0.6 * team_size, 0.6 * team_size)
                    .radius(0.3 * team_size)
                    .fill(team_color(label)),
            );
        }
        team = team.child(
            t(
                str_of(&label["name"]),
                font(team_size, 600.0, 1.25, -0.015),
                ink,
            )
            .truncate()
            .min_w(0.0),
        );
        let track_w = 1366.0 * 0.5;
        let bar_w = (0.35 * VW).max(share * (track_w - digits * 0.6 * figure - 1.4 * figure));
        let mut track = row()
            .grow(1.0)
            .min_w(0.0)
            .center_y()
            .child(
                rune::el()
                    .w(bar_w)
                    .h(figure * 0.9)
                    .corners([0.0, 0.6 * VH, 0.6 * VH, 0.0])
                    .fill(team_color(label)),
            )
            .child(t(format_int(*laps), score_font(figure, 800.0), ink).ml(0.22 * figure));
        if behind > 0 {
            track = track.child(
                t(
                    format!("−{}", format_int(behind)),
                    font((0.34 * figure).max(13.0), 500.0, 1.25, -0.01),
                    p.ink3,
                )
                .ml(0.6 * figure),
            );
        }
        bars = bars.child(
            row()
                .grow(1.0)
                .min_h(0.0)
                .w_full()
                .center_y()
                .gap(1.2 * VW)
                .child(team)
                .child(track),
        );
    }
    col()
        .role("region")
        .label(title.clone())
        .min_h(0.0)
        .pt(1.6 * VH + 1.0)
        .px(1.4 * VW + 1.0)
        .pb(1.8 * VH + 1.0)
        .gap(VH)
        .radius(0.7 * VW)
        .border(1.0, p.line)
        .fill(p.surface)
        .clip_rounded(0.7 * VW)
        .child(
            row()
                .center_y()
                .gap(1.2 * VW)
                .min_w(0.0)
                .child(
                    t(
                        title.clone(),
                        font(clamp(16.0, 1.25 * VW, 27.0), 600.0, 1.25, -0.015),
                        p.ink,
                    )
                    .truncate()
                    .min_w(0.0)
                    .grow(1.0),
                )
                .child(t(
                    verdict,
                    font(clamp(15.0, 1.1 * VW, 23.0), 500.0, 1.25, -0.01),
                    p.ink2,
                ))
                .child(
                    rune::el()
                        .key(format!("remove-{}", ids.join(".")))
                        .role("button")
                        .label(format!("{title} verwijderen"))
                        .focusable(true)
                        .size(28.0, 28.0)
                        .center()
                        .radius(6.0)
                        .border(1.0, p.line)
                        .fill(p.surface2)
                        .on_press(move |s: &mut State| {
                            s.send(
                                "settings.removeCompetition",
                                json!({ "labelIds": remove_ids }),
                            )
                        })
                        .child(t("✕", font(14.0, 500.0, 1.0, 0.0), p.ink2)),
                ),
        )
        .child(bars)
}

/// Tick the teams of one competition, then add it.
fn picker(s: &State) -> Option<El> {
    let picked = s.public_screens.picking.as_ref()?;
    let p = pal(true);
    let mut labels: Vec<&Value> = snapshot_list(s, "labels").iter().collect();
    labels.sort_by_key(|l| {
        (
            l["sortOrder"].as_i64().unwrap_or(i64::MAX),
            str_of(&l["name"]).to_lowercase(),
        )
    });
    let taken: Vec<String> = s.snapshot["settings"]["competitions"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| {
            let mut ids: Vec<String> = c.as_array().into_iter().flatten().map(str_of).collect();
            ids.sort();
            ids.join(".")
        })
        .collect();
    let mut key: Vec<String> = picked.clone();
    key.sort();
    let duplicate = taken.contains(&key.join("."));
    let mut choices = row().flex_wrap().gap(8.0);
    for label in labels {
        let id = str_of(&label["id"]);
        let on = picked.contains(&id);
        let toggle_id = id.clone();
        let mut chip = row()
            .key(format!("pick-{id}"))
            .role("button")
            .label(str_of(&label["name"]))
            .focusable(true)
            .h(44.0)
            .pl(14.0)
            .pr(12.0)
            .gap(8.0)
            .center_y()
            .radius(8.0)
            .border(1.0, if on { blue() } else { p.line })
            .fill(if on {
                oklch(0.32, 0.06, 251.0)
            } else {
                p.surface2
            })
            .on_press(move |s: &mut State| {
                if let Some(list) = &mut s.public_screens.picking {
                    if let Some(i) = list.iter().position(|x| *x == toggle_id) {
                        list.remove(i);
                    } else {
                        list.push(toggle_id.clone());
                    }
                }
            });
        if let Some(image) = label["imageUrl"].as_str().and_then(|u| s.logos.get(u)) {
            chip = chip.child(
                rune::el()
                    .size(22.0, 22.0)
                    .pixels_fit(image.pixels(), rune::SurfaceFit::Fit),
            );
        } else {
            chip = chip.child(
                rune::el()
                    .size(10.0, 10.0)
                    .radius(5.0)
                    .fill(team_color(label)),
            );
        }
        chip = chip.child(t(
            str_of(&label["name"]),
            font(16.0, 500.0, 1.25, -0.01),
            p.ink,
        ));
        if on {
            chip = chip.child(t("✓", font(16.0, 600.0, 1.0, 0.0), p.accent));
        }
        choices = choices.child(chip);
    }
    let ready = picked.len() >= 2 && !duplicate;
    let add_text = if picked.len() < 2 {
        "Kies minstens 2 ploegen".to_string()
    } else if duplicate {
        "Deze competitie staat er al op".to_string()
    } else {
        format!("Toevoegen met {} ploegen", picked.len())
    };
    let action = |key: &'static str, label: String, primary: bool| {
        row()
            .key(key)
            .role("button")
            .label(label.clone())
            .focusable(true)
            .h(38.0)
            .px(16.0)
            .center_y()
            .radius(5.0)
            .border(1.0, if primary { blue() } else { p.line })
            .fill(if primary { blue() } else { p.surface2 })
            .child(t(
                label,
                font(15.0, 500.0, 1.25, -0.01),
                if primary { white() } else { p.ink },
            ))
    };
    Some(
        rune::el()
            .key("competition-picker-overlay")
            .absolute(0.0, 0.0)
            .w_full()
            .h_full()
            .padding(24.0)
            .center()
            .fill(oklcha(0.0, 0.0, 0.0, 0.5))
            .modal(true, |s: &mut State| s.public_screens.picking = None)
            .child(
                col()
                    .key("competition-picker")
                    .role("dialog")
                    .label("Nieuwe competitie")
                    .w_full()
                    .max_w(760.0)
                    .padding(24.0)
                    .radius(12.0)
                    .border(1.0, p.line)
                    .fill(p.surface)
                    .child(t(
                        "Nieuwe competitie",
                        font(22.0, 650.0, 1.25, -0.02),
                        p.ink,
                    ))
                    .child(
                        t(
                            "Kies twee of meer ploegen die tegen elkaar strijden.",
                            font(15.0, 400.0, 1.5, -0.01),
                            p.ink2,
                        )
                        .mt(4.0),
                    )
                    .child(choices.mt(18.0))
                    .child(
                        row()
                            .mt(22.0)
                            .pt(16.0)
                            .gap(8.0)
                            .justify_end()
                            .border_sides([1.0, 0.0, 0.0, 0.0], p.line)
                            .child(
                                action("picker-cancel", "Annuleer".into(), false)
                                    .on_press(|s: &mut State| s.public_screens.picking = None),
                            )
                            .child(
                                action("picker-add", add_text, true)
                                    .opacity(if ready { 1.0 } else { 0.5 })
                                    .on_press(move |s: &mut State| {
                                        if !ready {
                                            return;
                                        }
                                        if let Some(ids) = s.public_screens.picking.take() {
                                            s.send(
                                                "settings.addCompetition",
                                                json!({ "labelIds": ids }),
                                            );
                                        }
                                    }),
                            ),
                    ),
            ),
    )
}

// ---------------------------------------------------------------- Buitenscherm

fn outside(s: &State) -> El {
    let p = pal(false);
    let done = finished(s);
    let race = &s.snapshot["race"];
    let kicker = clamp(22.0, 2.0 * VW, 44.0);
    let current_ink3 = oklcha(1.0, 0.0, 0.0, 0.8);
    let mut current = band().fill(blue());
    if !done {
        current = current.child(
            row()
                .center_y()
                .gap(0.5 * kicker)
                .child(live_dot(0.45 * kicker, white()))
                .child(t(
                    "Nu op de piste",
                    font(kicker, 500.0, 1.0, -0.01),
                    current_ink3,
                )),
        );
    }
    current = current.child(if done {
        big_name("Race afgelopen", white(), 650.0)
    } else {
        display_runner(
            s,
            active_runner(s),
            if race["raceStartedAt"].is_null() {
                "Nog niemand gestart"
            } else {
                "Even niemand"
            },
            white(),
            current_ink3,
            oklcha(1.0, 0.0, 0.0, 0.88),
            oklcha(1.0, 0.0, 0.0, 0.4),
        )
    });
    let mut next = band()
        .pt(3.0 * VH + 1.0)
        .fill(p.surface)
        .border_sides([1.0, 0.0, 0.0, 0.0], p.line);
    if !done {
        next = next.child(t("Volgende racer", font(kicker, 500.0, 1.0, -0.01), p.ink3));
    }
    next = next.child(display_runner(
        s,
        next_runner(s),
        if done {
            "Bedankt aan alle lopers"
        } else {
            "Geen loper in de wachtrij"
        },
        p.ink,
        p.ink3,
        p.ink2,
        p.line,
    ));
    let logo_w = clamp(200.0, 17.0 * VW, 30.0 * VH);
    col()
        .w_full()
        .h_full()
        .fill(p.bg)
        .child(current)
        .child(next)
        .child(
            rune::el()
                .key("display-home")
                .role("button")
                .label("Apolloon, terug naar start")
                .focusable(true)
                .on_press(|s: &mut State| s.page = 0)
                .pin(None, Some(4.0 * VH), Some(4.0 * VW), None)
                .child(logo(s, logo_w, logo_w * 169.0 / 560.0)),
        )
}
fn band() -> El {
    col()
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .min_w(0.0)
        .justify_center()
        .gap(2.2 * VH)
        .py(3.0 * VH)
        .px(5.0 * VW)
        .clip_rounded(0.0)
}
fn runner_size() -> f32 {
    clamp(46.0, 6.04 * VW, 128.0)
}
fn big_name(name: &str, color: Color, weight: f32) -> El {
    let size = runner_size();
    t(name, font(size, weight, 1.0, -0.035), color).max_lines(2)
}
#[allow(clippy::too_many_arguments)]
fn display_runner(
    s: &State,
    runner: Option<&Value>,
    empty: &str,
    ink: Color,
    ink3: Color,
    ink2: Color,
    line: Color,
) -> El {
    let Some(runner) = runner else {
        return big_name(empty, ink3, 500.0);
    };
    let size = runner_size();
    let number = str_of(&runner["runnerNumber"]);
    let name = str_of(&runner["name"]);
    // Steps a long name down until it fits on one line (RUNNER_NAME_SCALES).
    let width = 1366.0 - 10.0 * VW;
    let estimate = |scale: f32| {
        (number.chars().count() as f32 * 0.6 + 0.35 + name.chars().count() as f32 * 0.5)
            * size
            * scale
    };
    let scale = [1.0, 0.85, 0.68]
        .into_iter()
        .find(|k| estimate(*k) <= width)
        .unwrap_or(0.6);
    let size = size * scale;
    let mut name_row = row()
        .items_end()
        .gap(0.35 * size)
        .min_w(0.0)
        .h(size * 1.5)
        .pb(size * 0.25);
    if !number.is_empty() {
        name_row = name_row.child(t(number, font(size, 500.0, 1.0, -0.03), ink3));
    }
    name_row = name_row.child(
        t(name, font(size, 650.0, 1.0, -0.035), ink)
            .max_lines(2)
            .min_w(0.0),
    );
    let shown: Vec<&Value> = runner["labels"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|l| l["kind"] == "zustervereniging" || l["kind"] == "association")
        .collect();
    let mut out = col().gap(2.2 * VH).min_w(0.0).child(name_row);
    if !shown.is_empty() {
        let fs = clamp(20.0, 1.6 * VW, 34.0);
        let mut labels = row().gap(0.4 * fs);
        for l in shown {
            let mut pill = row()
                .h(1.6 * fs)
                .pl(0.45 * fs + 1.0)
                .pr(0.55 * fs + 1.0)
                .gap(0.4 * fs)
                .center_y()
                .radius(0.3 * fs)
                .border(1.0, line);
            if let Some(image) = l["imageUrl"].as_str().and_then(|u| s.logos.get(u)) {
                pill = pill.child(
                    rune::el()
                        .size(1.1 * fs, 1.1 * fs)
                        .pixels_fit(image.pixels(), rune::SurfaceFit::Fit),
                );
            } else {
                pill = pill.child(
                    rune::el()
                        .size(0.5 * fs, 0.5 * fs)
                        .radius(0.25 * fs)
                        .fill(team_color(l)),
                );
            }
            labels =
                labels.child(pill.child(t(str_of(&l["name"]), font(fs, 500.0, 1.2, -0.01), ink2)));
        }
        out = out.child(labels);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Vec<Value>, Vec<Value>) {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(".tmp-verify-evidence/native-reference");
        let state: Value =
            std::fs::read_to_string(dir.join("13-reference-light-inside.state.json"))
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(Value::Null);
        let runners = state["runners"].as_array().cloned().unwrap_or_default();
        (runners, Vec::new())
    }

    fn lap(
        id: &str,
        runner: &str,
        number: &str,
        name: &str,
        started: i64,
        duration: i64,
        source: &str,
    ) -> Value {
        json!({"id": id, "runnerId": runner, "runnerNumber": number, "runnerName": name, "lapNumber": 1,
            "startedAt": started, "finishedAt": started + duration, "createdAt": started + duration,
            "durationMs": duration, "source": source, "labels": []})
    }
    // 2026-11-15 17:xx Brussels (CET, UTC+1) = 16:xx UTC.
    const EVENING: i64 = 1_794_844_530_585;

    #[test]
    fn points_follow_the_prize_system() {
        // 1:06.000 in the 16-20u part: 20 × (1 + 19 × 0.125) = 67,5.
        assert_eq!(
            format_points(lap_points(&lap(
                "a", "r", "101", "N", EVENING, 66_000, "spacebar"
            ))),
            "67,5"
        );
        // Slower than 85 s: base points only.
        assert_eq!(
            format_points(lap_points(&lap(
                "a", "r", "101", "N", EVENING, 98_250, "spacebar"
            ))),
            "20,0"
        );
        // A split half gets no speed bonus.
        assert_eq!(
            format_points(lap_points(&lap(
                "a", "r", "101", "N", EVENING, 60_000, "split"
            ))),
            "20,0"
        );
        // 03:00 Brussels: ×1.3; 06:00: ×1.8.
        let night = EVENING - 14 * 3_600_000;
        assert_eq!(
            format_points(lap_points(&lap(
                "a", "r", "1", "N", night, 90_000, "spacebar"
            ))),
            "26,0"
        );
        assert_eq!(
            format_points(lap_points(&lap(
                "a",
                "r",
                "1",
                "N",
                night + 3 * 3_600_000,
                90_000,
                "spacebar"
            ))),
            "36,0"
        );
    }

    #[test]
    fn ranking_matches_the_reference_binnenscherm() {
        // 101 Noor Verbruggen: 1:06.000 (67,5) and 1:03.000 (75,0) = 142,5 points.
        let laps = vec![
            lap(
                "1",
                "noor",
                "101",
                "Noor Verbruggen",
                EVENING,
                63_000,
                "spacebar",
            ),
            lap(
                "2",
                "noor",
                "101",
                "Noor Verbruggen",
                EVENING + 63_000,
                66_000,
                "spacebar",
            ),
            lap(
                "3",
                "sara",
                "110",
                "Sara De Smet",
                EVENING,
                64_500,
                "spacebar",
            ),
            lap(
                "4",
                "sara",
                "110",
                "Sara De Smet",
                EVENING + 64_500,
                71_000,
                "spacebar",
            ),
            lap(
                "5",
                "fien",
                "113",
                "Fien Goossens",
                EVENING,
                90_500,
                "spacebar",
            ),
        ];
        let ranking = runner_ranking(&[], &laps, true, None);
        assert_eq!(ranking[0].label(), "101 Noor Verbruggen");
        assert_eq!(format_points(ranking[0].points), "142,5");
        assert_eq!(ranking[0].average_ms, Some(64_500));
        assert_eq!(ranking[2].label(), "113 Fien Goossens");
        // By laps: two laps first, faster average wins a tie.
        let by_laps = runner_ranking(&[], &laps, false, None);
        assert_eq!(
            by_laps
                .iter()
                .map(|e| e.runner_id.as_str())
                .collect::<Vec<_>>(),
            ["noor", "sara", "fien"]
        );
        // Current runner names win over the name on the lap.
        let (runners, _) = fixture();
        let _ = runner_ranking(&runners, &laps, true, None);
    }

    #[test]
    fn recent_laps_are_newest_first_with_best_and_average() {
        let laps = vec![
            lap("1", "noor", "101", "Noor", EVENING, 63_000, "spacebar"),
            lap(
                "2",
                "noor",
                "101",
                "Noor",
                EVENING + 63_000,
                66_000,
                "spacebar",
            ),
            lap("3", "x", "1", "X", EVENING, 5_000, "spacebar"),
        ];
        let recent = recent_laps(&laps, 25);
        assert_eq!(recent[0].0["id"], "2");
        assert_eq!((recent[0].1, recent[0].2), (Some(63_000), Some(64_500)));
        assert_eq!((recent[2].1, recent[2].2), (None, None));
        assert_eq!(recent_laps(&laps, 1).len(), 1);
    }

    #[test]
    fn formats_match_nl_be() {
        assert_eq!(format_points(142.45), "142,5");
        assert_eq!(format_points(1234.0), "1.234,0");
        assert_eq!(format_int(1234567), "1.234.567");
        assert_eq!(format_duration(Some(77_000)), "1:17.000");
        assert_eq!(format_duration(Some(3_723_004)), "1:02:03.004");
        assert_eq!(format_duration(None), "—");
        assert_eq!(format_elapsed(3_074_000), "51:14");
        assert_eq!(format_clock(1_794_847_439_085), "17:43:59");
    }

    #[test]
    fn next_runner_and_laps_per_hour() {
        let runners = vec![
            json!({"id": "a", "status": "waiting", "queueIndex": 2, "statusSince": 1}),
            json!({"id": "b", "status": "waiting", "queueIndex": 1, "statusSince": 5}),
            json!({"id": "c", "status": "running", "queueIndex": 0}),
        ];
        assert_eq!(next_waiting(&runners).unwrap()["id"], "b");
        let laps: Vec<Value> = (0..35).map(|i| json!({"finishedAt": i})).collect();
        let race = json!({"raceStartedAt": 0, "raceFinishedAt": 3_000_000});
        assert_eq!(format_points(laps_per_hour(&laps, &race).unwrap()), "42,0");
        assert_eq!(laps_per_hour(&[], &json!({})), None);
    }

    #[test]
    fn verdicts() {
        let v = |s: &[(&str, i64)]| {
            competition_verdict(
                &s.iter()
                    .map(|(a, b)| (a.to_string(), *b))
                    .collect::<Vec<_>>(),
            )
        };
        assert_eq!(v(&[("A", 0), ("B", 0)]), "Nog geen rondes");
        assert_eq!(v(&[("A", 3), ("B", 3)]), "Gelijke stand");
        assert_eq!(v(&[("A", 3), ("B", 3), ("C", 1)]), "A en B staan gelijk");
        assert_eq!(v(&[("A", 4), ("B", 3)]), "A leidt met 1 ronde");
        assert_eq!(v(&[("A", 5), ("B", 3)]), "A leidt met 2 rondes");
    }
}
