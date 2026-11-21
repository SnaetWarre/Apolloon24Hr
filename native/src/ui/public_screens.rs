//! The three public tv screens: Binnenscherm (/display/inside), Competitiescherm
//! (/display/competitions) and Buitenscherm (/display/outside). Full screen, without the operator
//! sidebar and header, in their own palette (src/styles/displays.css), independent of the
//! operator theme. Ports src/components/display/*.tsx, the ranking and lap summaries of
//! src/lib/ranking.ts and the points of shared/points.ts.
//!
//! Sizes are the CSS clamp() values of displays.css resolved for a 1366×768 screen.
use super::*;
use rune::{Align, Color, TextStyle, oklch, oklcha};
use std::collections::{HashMap, HashSet};

pub(super) mod settings;

/// The rows of both lists on the Binnenscherm.
const INSIDE_LIST_LENGTH: usize = 25;
/// The runners on the Competities screen.
const COMPETITION_RANKING_LENGTH: usize = 20;
const MAX_COMPETITIONS: usize = 6;
const MIN_LAP_MS: i64 = 20_000;
const MAX_PLAUSIBLE_LAP_MS: i64 = 10 * 60_000;

thread_local! {
    /// The window this frame lays out in (the CSS viewport the vw/vh units resolve against).
    static VIEWPORT: std::cell::Cell<(f32, f32)> = const { std::cell::Cell::new((1366.0, 768.0)) };
    /// `--display-zoom`: the display lays out in a box this much smaller and draws it larger.
    static ZOOM: std::cell::Cell<f32> = const { std::cell::Cell::new(1.0) };
}
/// The width the display lays out in, after its zoom (vw and vh stay the window's).
fn box_w() -> f32 {
    win_w() / ZOOM.with(|z| z.get())
}
fn win_w() -> f32 {
    VIEWPORT.with(|v| v.get().0)
}
fn vw_unit() -> f32 {
    win_w() / 100.0
}
fn vh_unit() -> f32 {
    VIEWPORT.with(|v| v.get().1) / 100.0
}
fn clamp(min: f32, pref: f32, max: f32) -> f32 {
    pref.max(min).min(max)
}

/// What the Competitiescherm's picker has ticked; `None` while it is closed.
#[derive(Default)]
pub(super) struct Screen {
    last_page: Option<usize>,
    picking: Option<Vec<String>>,
    /// The window size the last frame laid out in, for the vw/vh sizes.
    size: Option<(f32, f32)>,
    /// Licht/Donker and zoom per display (`?thema=`, `?zoom=`), remembered across page loads.
    pub(super) settings: settings::Settings,
    /// useArrivals: what each slot (active, next) showed, and whether it changed after opening.
    arrivals: HashMap<&'static str, (String, bool)>,
    /// Binnenscherm: laps seen since it opened, and the ones that arrived after (`is-new`).
    seen_laps: Option<HashSet<String>>,
    new_laps: HashSet<String>,
    /// The lap count when the screen opened: a later count ticks in (`value-tick`).
    laps_at_open: Option<usize>,
    /// Ranking voor: the label the points ranking is limited to.
    ranking_label: Option<String>,
    ranking_menu: bool,
    /// Another ranking was chosen after opening: the table rises in again.
    ranking_changed: bool,
    /// The pointer is over the screen: the display controls show (hover-capable screens).
    hovered: bool,
    /// Buitenscherm: lap and event ids seen since it opened (observeDisplayHistory).
    known_laps: Option<HashSet<String>>,
    known_events: Option<HashSet<String>>,
    /// The flash on screen and when it started (OUTSIDE_ALERT_VISIBLE_MS).
    flash: Option<(Flash, i64)>,
}

// ---------------------------------------------------------------- logic

const OUTSIDE_ALERT_VISIBLE_MS: i64 = 8_000;
/// What the Buitenscherm flashes: a record lap (title, time, runner) or Burgie gepakt.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Flash {
    title: String,
    big: String,
    who: String,
    lap_id: Option<String>,
}
fn record_title(mode: &str) -> &'static str {
    match mode {
        "hour" => "Snelste ronde van dit uur",
        "two_hour" => "Snelste ronde van deze 2 uur",
        _ => "Nieuw dagrecord",
    }
}
fn measured(lap: &Value) -> bool {
    is_measured_lap(
        lap["durationMs"].as_i64().unwrap_or(0),
        lap["source"].as_str().unwrap_or(""),
    )
}
/// isFastestLapForRecordMode.
pub(super) fn is_record(
    latest: &Value,
    previous: &[&Value],
    started: Option<i64>,
    mode: &str,
) -> bool {
    let at = |l: &Value| l["finishedAt"].as_i64().unwrap_or(0);
    let first = previous.iter().map(|l| at(l)).chain([at(latest)]).min();
    if mode == "off" || !measured(latest) || Some(at(latest)) == first {
        return false;
    }
    let ms = |l: &Value| l["durationMs"].as_i64().unwrap_or(0);
    let real = previous
        .iter()
        .filter(|l| measured(l) && Some(at(l)) != first);
    if mode == "day" || mode.is_empty() {
        return real.into_iter().all(|l| ms(latest) < ms(l));
    }
    let Some(start) = started.or(first) else {
        return false;
    };
    let window = if mode == "hour" { 3_600_000 } else { 7_200_000 };
    let index = |t: i64| ((t - start) / window).max(0);
    real.into_iter()
        .filter(|l| index(at(l)) == index(at(latest)))
        .all(|l| ms(latest) < ms(l))
}
/// Ctrl +, Ctrl −, Ctrl 0 and F11 on a public screen.
pub(super) fn key(s: &mut State, event: &rune::KeyEvent) -> bool {
    settings::key(&mut s.public_screens.settings, s.page, event)
}
pub(super) fn poll(s: &mut State, changed: bool, now: i64) -> bool {
    let screen = &mut s.public_screens;
    let on_display = (5..=7).contains(&s.page);
    let refresh_display = screen.last_page != Some(s.page)
        || (on_display && changed)
        || screen.flash.as_ref().is_some_and(|(_, at)| now - at >= OUTSIDE_ALERT_VISIBLE_MS);
    screen.last_page = Some(s.page);
    if refresh_display {
        refresh(s, now);
    }
    let race = &s.snapshot["race"];
    let clock_ticked = s.page == 5
        && race["raceFinishedAt"].is_null()
        && race["raceStartedAt"].as_i64().is_some_and(|start| {
            (now - start).max(0) / 1000 != (s.clock - start).max(0) / 1000
        });
    s.clock = now;
    !on_display || refresh_display || clock_ticked
}

/// While the Buitenscherm is open, a new record lap or Burgie event flashes.
fn refresh(s: &mut State, now: i64) {
    track_arrivals(s);
    let screen = &mut s.public_screens;
    if let Some((_, at)) = &screen.flash
        && now - at >= OUTSIDE_ALERT_VISIBLE_MS
    {
        screen.flash = None;
    }
    if s.page != 7 || s.history["laps"].as_array().is_none() {
        screen.known_laps = None;
        screen.known_events = None;
        screen.flash = None;
        return;
    }
    let laps: Vec<&Value> = s.history["laps"].as_array().into_iter().flatten().collect();
    let events: Vec<&Value> = s.history["events"]
        .as_array()
        .into_iter()
        .flatten()
        .collect();
    let id = |v: &Value| str_of(&v["id"]);
    let mut by_new = laps.clone();
    by_new.sort_by_key(|l| std::cmp::Reverse(l["finishedAt"].as_i64().unwrap_or(0)));
    let burgie = events
        .iter()
        .filter(|e| e["type"] == "burgie_gepakt")
        .max_by_key(|e| {
            e["occurredAt"]
                .as_i64()
                .or(e["createdAt"].as_i64())
                .unwrap_or(0)
        });
    let new_burgie = burgie.filter(|e| {
        screen
            .known_events
            .as_ref()
            .is_some_and(|k| !k.contains(&id(e)))
    });
    screen.known_events = Some(events.iter().map(|e| id(e)).collect());
    if let Some(e) = new_burgie {
        let name = str_of(&e["runnerName"]);
        screen.flash = Some((
            Flash {
                title: "Burgie gepakt".into(),
                big: "ZINGEN".into(),
                who: if name.is_empty() {
                    "Publiek moment".into()
                } else {
                    runner_label(&str_of(&e["runnerNumber"]), &name)
                },
                lap_id: None,
            },
            now,
        ));
    }
    let mode = s.snapshot["settings"]["publicRecordMode"]
        .as_str()
        .unwrap_or("day")
        .to_string();
    if mode == "off"
        && screen
            .flash
            .as_ref()
            .is_some_and(|(f, _)| f.lap_id.is_some())
    {
        screen.flash = None;
    }
    let latest = by_new.first().copied();
    let new_lap = latest.filter(|l| {
        screen
            .known_laps
            .as_ref()
            .is_some_and(|k| !k.contains(&id(l)))
    });
    screen.known_laps = Some(laps.iter().map(|l| id(l)).collect());
    let burgie_showing = screen
        .flash
        .as_ref()
        .is_some_and(|(f, _)| f.lap_id.is_none());
    if let Some(lap) = new_lap
        && !burgie_showing
        && is_record(
            lap,
            &by_new[1..],
            s.snapshot["race"]["raceStartedAt"].as_i64(),
            &mode,
        )
    {
        screen.flash = Some((
            Flash {
                title: record_title(&mode).into(),
                big: format_duration(lap["durationMs"].as_i64()),
                who: runner_label(&str_of(&lap["runnerNumber"]), &str_of(&lap["runnerName"])),
                lap_id: Some(id(lap)),
            },
            now,
        ));
    }
    // A record lap that was corrected away stops flashing.
    if let Some((
        Flash {
            lap_id: Some(lap), ..
        },
        _,
    )) = &screen.flash
        && !laps.iter().any(|l| id(l) == *lap)
    {
        screen.flash = None;
    }
}
/// useArrivals and the new-lap rows: what changed after a display opened rises in; what was
/// there on opening is simply there.
fn track_arrivals(s: &mut State) {
    if !(5..=7).contains(&s.page) {
        let screen = &mut s.public_screens;
        screen.arrivals.clear();
        screen.seen_laps = None;
        screen.new_laps.clear();
        screen.laps_at_open = None;
        return;
    }
    s.public_screens.settings.ensure_loaded();
    let key = |r: Option<&Value>| r.map_or("none".to_string(), |r| str_of(&r["id"]));
    let slots = [("active", key(active_runner(s))), ("next", key(next_runner(s)))];
    let laps: Option<Vec<String>> = s.history["laps"]
        .as_array()
        .map(|l| l.iter().map(|l| str_of(&l["id"])).collect());
    let screen = &mut s.public_screens;
    for (slot, id) in slots {
        match screen.arrivals.get(slot) {
            Some((seen, _)) if *seen == id => {}
            Some(_) => {
                screen.arrivals.insert(slot, (id, true));
            }
            None => {
                screen.arrivals.insert(slot, (id, false));
            }
        }
    }
    if let Some(laps) = laps {
        screen.laps_at_open.get_or_insert(laps.len());
        match &mut screen.seen_laps {
            None => screen.seen_laps = Some(laps.into_iter().collect()),
            Some(seen) => {
                for id in laps {
                    if seen.insert(id.clone()) {
                        screen.new_laps.insert(id);
                    }
                }
            }
        }
    }
}
/// Whether `slot` now shows something that arrived after the display opened.
fn arrived(s: &State, slot: &str) -> bool {
    s.public_screens
        .arrivals
        .get(slot)
        .is_some_and(|(_, changed)| *changed)
}

// Motion for the tv screens (displays.css, motion.css): larger and slower than on the laptops.
// The renderer's one-shot sequences carry opacity and scale; a new element key replays them.
const EASE_OUT: rune::Easing = rune::Easing::cubic(0.2, 0.0, 0.0, 1.0);
/// `display-rise` (--dur-3, 360 ms): fades up into place.
const RISE: &[rune::Beat] = &[
    rune::Beat::new(0.0).opacity(0.0).scale(0.97),
    rune::Beat::new(0.36).easing(EASE_OUT),
];
/// `display-pop` (600 ms on --ease-spring): the big figure lands with a small overshoot.
const POP: &[rune::Beat] = &[
    rune::Beat::new(0.0).opacity(0.0).scale(0.88),
    rune::Beat::new(0.6).easing(rune::Easing::cubic(0.34, 1.3, 0.64, 1.0)),
];
/// `display-flash`: in over the first 4% of the time it stays, out over the last 6%.
const FLASH: &[rune::Beat] = &[
    rune::Beat::new(0.0).opacity(0.0),
    rune::Beat::new(0.32).easing(EASE_OUT),
    rune::Beat::new(7.52).easing(rune::Easing::LINEAR),
    rune::Beat::new(8.0).opacity(0.0).easing(EASE_OUT),
];
/// `value-tick` (--dur-3 on the displays): a changed figure lands from 35% opacity.
const TICK: &[rune::Beat] = &[
    rune::Beat::new(0.0).opacity(0.35),
    rune::Beat::new(0.36).easing(EASE_OUT),
];
fn rise(el: El, delay: f64) -> El {
    el.sequence(rune::Sequence::new(RISE).delay(delay))
}

/// `.outside-record-flash`: the whole screen blue, a ring, title, the time in a white block and the runner.
fn flash_layer(f: &Flash, ink: Color) -> El {
    let (vw, vh) = (vw_unit(), vh_unit());
    let long = f.title.chars().count() > 18;
    let title = if long {
        clamp(
            44.0,
            (7.5 * vw).min(11.0 * vh),
            150.0f32.max((7.8125 * vw).min(13.8889 * vh)),
        )
    } else {
        clamp(
            56.0,
            (12.0 * vw).min(17.0 * vh),
            238.0f32.max((12.3958 * vw).min(22.037 * vh)),
        )
    };
    let big = clamp(
        72.0,
        (14.0 * vw).min(24.0 * vh),
        282.0f32.max((14.6875 * vw).min(26.1111 * vh)),
    );
    let who = clamp(
        30.0,
        (5.8 * vw).min(9.0 * vh),
        112.0f32.max((5.8333 * vw).min(10.3704 * vh)),
    );
    let inset = clamp(16.0, 2.4 * vw, 46.0f32.max((2.3958 * vw).min(4.2593 * vh)));
    let ring = clamp(4.0, 0.45 * vw, 9.0f32.max((0.4688 * vw).min(0.8333 * vh)));
    rune::el()
        .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
        .center()
        .padding(clamp(
            26.0,
            5.0 * vw,
            90.0f32.max((4.6875 * vw).min(8.3333 * vh)),
        ))
        .child(
            rune::el()
                .pin(Some(inset), Some(inset), Some(inset), Some(inset))
                .radius(12.0)
                .border(ring, ink.alpha(0.72)),
        )
        .child(
            col()
                .items_center()
                .max_w(1640.0f32.max((85.4167 * vw).min(151.852 * vh)))
                .child(rise(
                    text(f.title.to_uppercase())
                        .font(
                            TextStyle::new(title, 900.0)
                                .lh(title * 0.84)
                                .tracking(-0.01 * title),
                        )
                        .color(ink)
                        .wrap()
                        .align(Align::Center),
                    0.12,
                ))
                .child(
                    rune::el()
                        .mt(clamp(
                            16.0,
                            (2.3 * vw).min(3.4 * vh),
                            42.0f32.max((2.1875 * vw).min(3.8889 * vh)),
                        ))
                        .py(clamp(8.0, vw, 20.0f32.max((1.0417 * vw).min(1.8519 * vh))))
                        .px(clamp(
                            22.0,
                            2.2 * vw,
                            52.0f32.max((2.7083 * vw).min(4.8148 * vh)),
                        ))
                        .fill(white())
                        .sequence(rune::Sequence::new(POP))
                        .child(
                            text(f.big.clone())
                                .font(
                                    TextStyle::new(big, 900.0)
                                        .lh(big * 0.92)
                                        .tracking(-0.03 * big)
                                        .features("'tnum' 1"),
                                )
                                .color(blue()),
                        ),
                )
                .child(rise(
                    text(f.who.clone())
                        .font(TextStyle::new(who, 900.0).lh(who).tracking(-0.02 * who))
                        .color(ink)
                        .wrap()
                        .align(Align::Center)
                        .mt(clamp(
                            18.0,
                            (2.6 * vw).min(3.8 * vh),
                            48.0f32.max((2.5 * vw).min(4.4444 * vh)),
                        )),
                    0.2,
                )),
        )
}
/// `.outside-record-flash`: the whole screen blue, a ring, title, the time in a white block and the runner.
/// It fades in, holds and fades out (`display-flash`), and pulses between Apolloon blue with
/// white and night blue with light blue every 2.4 s (`record-flash-pulse`): the night layer and the
/// light blue copy of the lines fade in and out together over the blue and white ones.
fn flash_view(f: &Flash, at: i64) -> El {
    let pulse = rune::LoopSpec::opacity(2.4, 0.0, 0.0, 1.0);
    rune::el()
        .key(format!("outside-flash-{at}"))
        .role("status")
        .label(format!("{} {} {}", f.title, f.big, f.who))
        .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
        .fill(blue())
        .clip_rounded(0.0)
        .sequence(rune::Sequence::new(FLASH))
        .child(
            rune::el()
                .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                .fill(oklch(0.297, 0.096, 261.4))
                .looping(pulse),
        )
        .child(flash_layer(f, white()))
        .child(flash_layer(f, oklch(0.86, 0.08, 240.0)).looping(pulse))
}

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
    /// Points and the top three places: a lighter Apolloon blue, never yellow beside the blue.
    podium: Color,
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
            podium: oklch(0.82, 0.09, 240.0),
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
            podium: oklch(0.4923, 0.1419, 251.85),
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
/// The Competities title and lap counts: Geist with tabular digits, like the other screens.
fn score_font(size: f32, weight: f32) -> TextStyle {
    TextStyle::new(size, weight.min(700.0))
        .lh(size)
        .tracking(size * -0.02)
        .features("'tnum' 1")
}
fn logo(s: &State, w: f32, h: f32) -> El {
    logo_on(s, w, h, true)
}
fn logo_on(s: &State, w: f32, h: f32, dark_bg: bool) -> El {
    // icons 27/28: the wordmark for light and for dark backgrounds.
    match s.icons.get(if dark_bg { 28 } else { 27 }) {
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
    let (w, h) = s.public_screens.size.unwrap_or((1366.0, 768.0));
    VIEWPORT.with(|v| v.set((w, h)));
    let zoom = s.public_screens.settings.zoom(s.page);
    ZOOM.with(|z| z.set(zoom));
    let body = match s.page {
        5 => inside(s),
        6 => competitions(s),
        _ => outside(s),
    };
    // Ctrl + / Ctrl −: the page stays the size of the screen (displays.css --display-zoom).
    let body = if zoom == 1.0 {
        body
    } else {
        rune::el()
            .key(format!("display-zoom-{}", (zoom * 100.0).round()))
            .size(w / zoom, h / zoom)
            .origin(0.0, 0.0)
            .scale(zoom)
            .child(body)
    };
    let mut root = rune::el().w_full().h_full().child(body);
    if let Some(flash) = outside_flash(s) {
        root = root.child(flash);
    }
    if s.page == 5 || s.page == 6 {
        root = root.on_hover_change(|s: &mut State, on, _| {
            s.public_screens.hovered = on;
            if !on {
                s.public_screens.ranking_menu = false;
            }
        });
        if s.public_screens.hovered || s.public_screens.ranking_menu {
            root = root.child(display_controls(s));
        }
    }
    let root = root.on_layout(|s: &mut State, r| {
        let size = Some((r[2].max(1.0), r[3].max(1.0)));
        if s.public_screens.size != size {
            s.public_screens.size = size;
        }
    });
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
        .gap(2.0 * vw_unit())
        .min_w(0.0)
        .child(
            rune::el()
                .key("display-home")
                .role("button")
                .label("Apolloon, terug naar start")
                .focusable(true)
                .on_press_tx(|s: &mut State, tx: &mut Tx| {
                    tx.instant();
                    s.page = 0;
                })
                .child(
                    logo_on(
                        s,
                        clamp(110.0, 7.0 * vw_unit(), 160.0),
                        clamp(34.0, 2.2 * vw_unit(), 48.0),
                        p.bg == pal(true).bg,
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
    let dt = clamp(14.0, vw_unit(), 22.0);
    let dd = clamp(20.0, 1.6 * vw_unit(), 34.0);
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
            0.6 * vw_unit(),
        )
    };
    row()
        .gap(2.4 * vw_unit())
        .child(item("Racetijd", elapsed))
        .child({
            // `value-tick`: a count that changed after opening lands again, keyed by its value.
            let mut value = t(format_int(laps.len() as i64), font(dd, 600.0, 1.2, -0.02), p.ink)
                .key(format!("laps-{}", laps.len()));
            if s.public_screens.laps_at_open.is_some_and(|n| n != laps.len()) {
                value = value.sequence(rune::Sequence::new(TICK));
            }
            baseline_pair(
                t("Rondes", font(dt, 400.0, 1.2, -0.01), p.ink3),
                dt,
                value,
                dd,
                0.6 * vw_unit(),
            )
        })
        .child(item("Per uur", per_hour))
}
fn panel(p: &Pal) -> El {
    col()
        .min_h(0.0)
        .h_full()
        .py(1.6 * vh_unit() + 1.0)
        .px(1.3 * vw_unit() + 1.0)
        .radius(0.7 * vw_unit())
        .border(1.0, p.line)
        .fill(p.surface)
        .clip_rounded(0.7 * vw_unit())
}
fn panel_heading(title: &str, note: Option<&str>, p: &Pal) -> El {
    let h2 = clamp(20.0, 1.5 * vw_unit(), 32.0);
    let mut r = row()
        .h(h2 * 1.25)
        .items_end()
        .gap(vw_unit())
        .min_w(0.0)
        .child(t(title, font(h2, 600.0, 1.25, -0.02), p.ink));
    if let Some(note) = note {
        let size = clamp(12.0, 0.85 * vw_unit(), 18.0);
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
        .child(rune::el().w_full().h(0.6 * vh_unit()).fill(blue()))
}

// ---------------------------------------------------------------- display controls

/// collectRankingLabels: the labels on laps and the current ones, in label order.
fn ranking_labels(s: &State) -> Vec<Value> {
    let mut by_id: Vec<Value> = Vec::new();
    let laps = history_laps(s)
        .iter()
        .flat_map(|l| l["labels"].as_array().cloned().unwrap_or_default());
    for l in laps.chain(snapshot_list(s, "labels").iter().cloned()) {
        match by_id.iter_mut().find(|x| x["id"] == l["id"]) {
            Some(x) => *x = l,
            None => by_id.push(l),
        }
    }
    let kind = |l: &Value| match l["kind"].as_str().unwrap_or("") {
        "speedteam" => 0,
        "zustervereniging" | "association" => 1,
        _ => 2,
    };
    by_id.sort_by(|a, b| {
        kind(a)
            .cmp(&kind(b))
            .then_with(|| name_order(&str_of(&a["name"]), &str_of(&b["name"])))
    });
    by_id
}
fn control_button(key: String, label: &str, on: bool, p: &Pal) -> El {
    row()
        .key(key)
        .role("button")
        .label(label.to_string())
        .checked(on)
        .focusable(true)
        .h(28.0)
        .px(8.0)
        .center()
        .radius(5.0)
        .fill(p.surface2)
        .border(1.0, if on { p.accent } else { p.line })
        .child(t(
            label,
            TextStyle::new(13.0, 500.0),
            if on { p.accent } else { p.ink },
        ))
}
/// `.display-controls`: Ranking voor (Binnenscherm) and Licht/Donker, bottom right, on hover.
fn display_controls(s: &State) -> El {
    let inside = s.page == 5;
    let light = s.public_screens.settings.light(s.page, false);
    let p = pal(!light);
    let mut bar = row()
        .key("display-controls")
        .pin(None, None, Some(1.2 * vw_unit()), Some(1.2 * vh_unit()))
        .gap(12.0)
        .py(8.0)
        .px(10.0)
        .center_y()
        .radius(8.0)
        .fill(p.surface)
        .border(1.0, p.line)
        .shadow(8.0, 24.0, oklcha(0.0, 0.0, 0.0, 0.3));
    if inside {
        let labels = ranking_labels(s);
        let current = labels
            .iter()
            .find(|l| Some(str_of(&l["id"])) == s.public_screens.ranking_label)
            .map_or("Alle lopers".to_string(), |l| str_of(&l["name"]));
        let mut select = col().child(
            control_button("display-ranking".into(), &format!("{current} ▾"), false, &p)
                .label(format!("Ranking voor {current}"))
                .on_press(|s: &mut State| {
                    s.public_screens.ranking_menu = !s.public_screens.ranking_menu
                }),
        );
        if s.public_screens.ranking_menu {
            let mut menu = col()
                .key("display-ranking-menu")
                .role("listbox")
                .absolute(0.0, -8.0)
                .min_w(180.0)
                .padding(4.0)
                .radius(6.0)
                .fill(p.surface)
                .border(1.0, p.line)
                .shadow(8.0, 24.0, oklcha(0.0, 0.0, 0.0, 0.3));
            let mut options = vec![(None, "Alle lopers".to_string())];
            options.extend(
                labels
                    .iter()
                    .map(|l| (Some(str_of(&l["id"])), str_of(&l["name"]))),
            );
            let count = options.len() as f32;
            menu = menu.absolute(0.0, -(count * 28.0 + 16.0));
            for (id, name) in options {
                let on = id == s.public_screens.ranking_label;
                menu = menu.child(
                    row()
                        .key(format!(
                            "display-ranking-{}",
                            id.as_deref().unwrap_or("all")
                        ))
                        .role("option")
                        .label(name.clone())
                        .checked(on)
                        .focusable(true)
                        .h(28.0)
                        .px(8.0)
                        .center_y()
                        .radius(4.0)
                        .hover(p.surface2)
                        .on_press(move |s: &mut State| {
                            if s.public_screens.ranking_label != id {
                                s.public_screens.ranking_changed = true;
                            }
                            s.public_screens.ranking_label = id.clone();
                            s.public_screens.ranking_menu = false;
                        })
                        .child(t(
                            name,
                            TextStyle::new(13.0, if on { 600.0 } else { 500.0 }),
                            p.ink,
                        )),
                );
            }
            select = select.child(menu);
        }
        bar = bar.child(
            row()
                .gap(8.0)
                .center_y()
                .child(t("Ranking voor", TextStyle::new(13.0, 400.0), p.ink3))
                .child(select),
        );
    }
    let set = |s: &mut State, light: bool| s.public_screens.settings.choose_light(s.page, light);
    bar.child(
        row()
            .role("group")
            .label("Weergave van dit scherm")
            .gap(6.0)
            .child(
                control_button("display-light".into(), "Licht", light, &p)
                    .on_press(move |s: &mut State| set(s, true)),
            )
            .child(
                control_button("display-dark".into(), "Donker", !light, &p)
                    .on_press(move |s: &mut State| set(s, false)),
            ),
    )
}

// ---------------------------------------------------------------- Binnenscherm

fn inside(s: &State) -> El {
    let p = pal(!s.public_screens.settings.light(5, false));
    let done = finished(s);
    let now_size = clamp(16.0, 1.25 * vw_unit(), 28.0);
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
        .gap(0.6 * vw_unit())
        .min_w(0.0)
        .clip_rounded(0.0)
        .role("group")
        .label("Nu op de piste")
        .child(label)
        .child({
            let el = t(runner_text, font(now_size, 650.0, 1.5, -0.02), p.ink)
                .truncate()
                .min_w(0.0)
                .key(format!("now-{}", active.map_or("none".into(), |r| str_of(&r["id"]))));
            if arrived(s, "active") { rise(el, 0.0) } else { el }
        });
    if !done {
        let next_text = next.map(label_of).unwrap_or_else(|| "niemand klaar".into());
        now = now.child(
            row()
                .ml(0.6 * vw_unit())
                .pl(1.2 * vw_unit() + 1.0)
                .min_w(0.0)
                .center_y()
                .border_sides([0.0, 0.0, 0.0, 1.0], p.line)
                .child(t(
                    "Volgende\u{a0}",
                    font(now_size, 400.0, 1.5, -0.01),
                    p.ink2,
                ))
                .child({
                    let el = t(next_text, font(now_size, 600.0, 1.5, -0.01), p.ink)
                        .truncate()
                        .min_w(0.0)
                        .key(format!("next-{}", next.map_or("none".into(), |r| str_of(&r["id"]))));
                    if arrived(s, "next") { rise(el, 0.0) } else { el }
                }),
        );
    }

    let width = box_w() - 4.0 * vw_unit() - 1.2 * vw_unit();
    let left_w = width * 1.5 / 2.5;
    let right_w = width - left_w;
    let board = row()
        .grow(1.0)
        .min_h(0.0)
        .gap(1.2 * vw_unit())
        .child(recent_panel(s, &p).w(left_w))
        .child(points_panel(s, &p).w(right_w));
    screen(&p).child(
        col()
            .grow(1.0)
            .min_h(0.0)
            .w_full()
            .pt(2.2 * vh_unit())
            .pb(2.2 * vh_unit())
            .px(2.0 * vw_unit())
            .gap(1.6 * vh_unit())
            .child(header(s, &p, now))
            .child(board),
    )
}

/// A table cell: fixed width, padded, clipped, its text centred on the row.
fn cell(width: f32, content: El, align_end: bool, center: bool) -> El {
    let r = row()
        .w(width)
        .h_full()
        .px(0.6 * vw_unit())
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
    let size = clamp(12.0, 0.8 * vw_unit(), 16.0);
    let mut r = row().h(2.4 * vh_unit()).w_full();
    for (w, name, end) in cols {
        let mut c = row()
            .w(*w)
            .h_full()
            .px(0.6 * vw_unit())
            .pb(0.4 * vh_unit())
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
        .min_h(12.0 * vh_unit())
        .padding(2.0 * vh_unit())
        .center()
        .border(1.0, p.line)
        .border_dash(4.0, 4.0)
        .radius(0.7 * vw_unit())
        .child(
            t(
                message,
                font(clamp(16.0, 1.2 * vw_unit(), 26.0), 400.0, 1.5, -0.01),
                p.ink3,
            )
            .wrap(),
        )
}

fn recent_panel(s: &State, p: &Pal) -> El {
    let inner = box_w() - 4.0 * vw_unit() - 1.2 * vw_unit();
    let inner = inner * 1.5 / 2.5 - 2.0 - 2.6 * vw_unit();
    let w = [0.11, 0.42, 0.14, 0.09, 0.12, 0.12].map(|f| f * inner);
    let title = format!("Laatste {INSIDE_LIST_LENGTH} lopers");
    let mut panel = panel(p)
        .role("region")
        .label(title.clone())
        .gap(0.6 * vh_unit())
        .child(panel_heading(&title, None, p));
    let recent = recent_laps(history_laps(s), INSIDE_LIST_LENGTH);
    if recent.is_empty() {
        return panel.child(inside_empty(
            "De eerste rondes verschijnen hier zodra de timing start.",
            p,
        ));
    }
    let big = clamp(15.0, 1.1 * vw_unit(), 23.0);
    let mid = clamp(14.0, vw_unit(), 21.0);
    let when = clamp(13.0, 0.95 * vw_unit(), 20.0);
    // A new ranking (another label) rises in under the same heading.
    let ranking_key = format!(
        "points-{}",
        s.public_screens.ranking_label.as_deref().unwrap_or("all")
    );
    let mut table = col().key(ranking_key.clone()).grow(1.0).min_h(0.0).w_full();
    if s.public_screens.ranking_changed {
        table = rise(table, 0.0);
    }
    let mut table = table.child(head_cells(
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
            let size = clamp(11.0, 0.7 * vw_unit(), 14.0);
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
        let lap_id = str_of(&lap["id"]);
        let mut tr = table_row(p);
        // `.recent-lap-row.is-new`: a lap that landed after the screen opened comes in.
        if s.public_screens.new_laps.contains(&lap_id) {
            tr = rise(tr, 0.0);
        }
        table = table.child(
            tr.key(lap_id)
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
                        p.podium,
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
    let inner = box_w() - 4.0 * vw_unit() - 1.2 * vw_unit();
    let inner = inner / 2.5 - 2.0 - 2.6 * vw_unit();
    let head = clamp(12.0, 0.8 * vw_unit(), 16.0);
    let place_w = 3.2 * head;
    let w = [place_w, inner * 0.6 - place_w, inner * 0.18, inner * 0.22];
    let ranking: Vec<Entry> = runner_ranking(
        snapshot_list(s, "runners"),
        history_laps(s),
        true,
        s.public_screens.ranking_label.as_deref(),
    )
    .into_iter()
    .take(INSIDE_LIST_LENGTH)
    .collect();
    let only = ranking_labels(s)
        .into_iter()
        .find(|l| Some(str_of(&l["id"])) == s.public_screens.ranking_label)
        .map(|l| format!("Alleen {}", str_of(&l["name"])));
    let mut panel =
        panel(p)
            .role("region")
            .label("Ranking op punten")
            .gap(0.6 * vh_unit())
            .child(panel_heading(
                "Ranking op punten",
                Some(only.as_deref().unwrap_or(
                    "Snelle rondes en rondes van 0 tot 16 u tellen zwaarder",
                )),
                p,
            ));
    if ranking.is_empty() {
        return panel.child(inside_empty("Nog geen rondes voor deze selectie", p));
    }
    let big = clamp(15.0, 1.1 * vw_unit(), 23.0);
    let mid = clamp(14.0, vw_unit(), 21.0);
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
                    if podium { p.podium } else { p.ink3 },
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
    let p = pal(!s.public_screens.settings.light(6, false));
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
        score_font(clamp(26.0, 2.0 * vw_unit(), 44.0), 800.0),
        p.ink,
    )
    .role("heading");
    let width = box_w() - 4.0 * vw_unit() - 1.2 * vw_unit();
    let left_w = width * 2.3 / 3.3;
    let right_w = width - left_w;

    let mut counts: HashMap<&str, i64> = HashMap::new();
    for lap in history_laps(s) {
        for l in lap["labels"].as_array().into_iter().flatten() {
            *counts.entry(l["id"].as_str().unwrap_or("")).or_default() += 1;
        }
    }
    let left = if ids.is_empty() {
        let size = clamp(16.0, 1.3 * vw_unit(), 28.0);
        let mut empty = col()
            .w(left_w)
            .h_full()
            .center()
            .gap(2.4 * vh_unit())
            .padding(4.0 * vh_unit())
            .border(1.0, p.line)
            .border_dash(3.0, 3.0)
            .radius(0.7 * vw_unit())
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
        let mut list = col().w(left_w).h_full().gap(1.4 * vh_unit()).min_h(0.0);
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
    let help = clamp(12.0, 0.85 * vw_unit(), 18.0);
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
            .mt(0.4 * vh_unit())
            .mb(0.8 * vh_unit()),
        );
    if ranking.is_empty() {
        right = right.child(inside_empty("Nog geen rondes.", &p));
    } else {
        let size = clamp(15.0, 1.1 * vw_unit(), 23.0);
        let mut list = col().grow(1.0).min_h(0.0).w_full();
        for (i, r) in ranking.iter().enumerate() {
            let podium = i < 3;
            let mut li = row()
                .key(r.runner_id.clone())
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .center_y()
                .gap(0.6 * vw_unit());
            li = if i == 0 {
                li.fill(p.highlight).radius(0.4 * vw_unit())
            } else {
                li.border_sides([1.0, 0.0, 0.0, 0.0], p.line)
            };
            list = list.child(
                li.child(row().w(2.2 * size).justify_center().child(t(
                    (i + 1).to_string(),
                    font(size, if podium { 700.0 } else { 500.0 }, 1.5, -0.01),
                    if podium { p.podium } else { p.ink3 },
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
            .pt(2.2 * vh_unit())
            .pb(2.2 * vh_unit())
            .px(2.0 * vw_unit())
            .gap(1.6 * vh_unit())
            .child(header(s, &p, row().child(title)))
            .child(
                row()
                    .grow(1.0)
                    .min_h(0.0)
                    .gap(1.2 * vw_unit())
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
        let track_w = box_w() * 0.5;
        let bar_w =
            (0.35 * vw_unit()).max(share * (track_w - digits * 0.6 * figure - 1.4 * figure));
        let mut track = row()
            .grow(1.0)
            .min_w(0.0)
            .center_y()
            .child(
                rune::el()
                    .w(bar_w)
                    .h(figure * 0.9)
                    .corners([0.0, 0.6 * vh_unit(), 0.6 * vh_unit(), 0.0])
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
                .gap(1.2 * vw_unit())
                .child(team)
                .child(track),
        );
    }
    col()
        .role("region")
        .label(title.clone())
        .min_h(0.0)
        .pt(1.6 * vh_unit() + 1.0)
        .px(1.4 * vw_unit() + 1.0)
        .pb(1.8 * vh_unit() + 1.0)
        .gap(vh_unit())
        .radius(0.7 * vw_unit())
        .border(1.0, p.line)
        .fill(p.surface)
        .clip_rounded(0.7 * vw_unit())
        .child(
            row()
                .center_y()
                .gap(1.2 * vw_unit())
                .min_w(0.0)
                .child(
                    t(
                        title.clone(),
                        font(clamp(16.0, 1.25 * vw_unit(), 27.0), 600.0, 1.25, -0.015),
                        p.ink,
                    )
                    .truncate()
                    .min_w(0.0)
                    .grow(1.0),
                )
                .child(t(
                    verdict,
                    font(clamp(15.0, 1.1 * vw_unit(), 23.0), 500.0, 1.25, -0.01),
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
    let p = pal(!s.public_screens.settings.light(6, false));
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
    let p = pal(!s.public_screens.settings.light(7, true));
    let done = finished(s);
    let race = &s.snapshot["race"];
    let kicker = clamp(22.0, 2.0 * vw_unit(), 44.0);
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
    // `.outside-runner--in`: a runner who takes over after the screen opened rises in.
    let in_key = |slot: &str, r: Option<&Value>| {
        format!("{slot}-{}", r.map_or("none".into(), |r| str_of(&r["id"])))
    };
    let current_in = arrived(s, "active");
    let next_in = arrived(s, "next");
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
    }
    .key(in_key("active", active_runner(s)))
    .sequence_if(current_in));
    let mut next = band()
        .pt(3.0 * vh_unit() + 1.0)
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
    )
    .key(in_key("next", next_runner(s)))
    .sequence_if(next_in));
    let logo_w = clamp(200.0, 17.0 * vw_unit(), 30.0 * vh_unit());
    let screen = col()
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
                .on_press_tx(|s: &mut State, tx: &mut Tx| {
                    tx.instant();
                    s.page = 0;
                })
                .pin(None, Some(4.0 * vh_unit()), Some(4.0 * vw_unit()), None)
                .child(logo(s, logo_w, logo_w * 169.0 / 560.0)),
        );
    screen
}
/// The flash on the Buitenscherm; it stays the size of the screen at any zoom.
fn outside_flash(s: &State) -> Option<El> {
    (s.page == 7)
        .then_some(s.public_screens.flash.as_ref())
        .flatten()
        .map(|(f, at)| flash_view(f, *at))
}
trait RiseIf {
    fn sequence_if(self, on: bool) -> Self;
}
impl RiseIf for El {
    fn sequence_if(self, on: bool) -> El {
        if on { rise(self, 0.0) } else { self }
    }
}
fn band() -> El {
    col()
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .min_w(0.0)
        .justify_center()
        .gap(2.2 * vh_unit())
        .py(3.0 * vh_unit())
        .px(5.0 * vw_unit())
        .clip_rounded(0.0)
}
fn runner_size() -> f32 {
    clamp(46.0, 6.04 * vw_unit(), 128.0)
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
    let width = box_w() - 10.0 * vw_unit();
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
    let mut out = col().gap(2.2 * vh_unit()).min_w(0.0).child(name_row);
    if !shown.is_empty() {
        let fs = clamp(20.0, 1.6 * vw_unit(), 34.0);
        let mut labels = row().gap(0.4 * fs).flex_wrap();
        for l in shown {
            let mut pill = row()
                .h(1.8 * fs)
                .pl(0.45 * fs + 1.0)
                .pr(0.55 * fs + 1.0)
                .gap(0.4 * fs)
                .center_y()
                .radius(0.3 * fs)
                .border(1.0, line);
            if let Some(image) = l["imageUrl"].as_str().and_then(|u| s.logos.get(u)) {
                pill = pill.child(
                    rune::el()
                        .size(1.4 * fs, 1.4 * fs)
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
        let runners = [json!({"id":"noor", "runnerNumber":"101", "name":"Noor Janssens"})];
        assert_eq!(
            runner_ranking(&runners, &laps, true, None)[0].label(),
            "101 Noor Janssens"
        );
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

    fn timed(id: &str, finished: i64, ms: i64) -> Value {
        json!({"id": id, "runnerNumber": "7", "runnerName": "Fien", "finishedAt": finished, "durationMs": ms, "source": "spacebar"})
    }

    #[test]
    fn idle_display_redraws_on_data_clock_or_route_changes() {
        let mut s = init_with_url("http://127.0.0.1:9".into());
        s.page = 5;
        s.snapshot = json!({"race": {"raceStartedAt": 1000}});
        assert!(poll(&mut s, false, 1000));
        assert!(!poll(&mut s, false, 1900));
        assert!(poll(&mut s, false, 2000));
        s.snapshot["race"]["raceFinishedAt"] = json!(2050);
        assert!(poll(&mut s, true, 2100));
        assert!(!poll(&mut s, false, 3000));
        s.page = 7;
        assert!(poll(&mut s, false, 3100));
        assert!(!poll(&mut s, false, 3200));
    }

    #[test]
    fn outside_flashes_a_new_day_record_and_then_burgie() {
        let mut s = init_with_url("http://127.0.0.1:9".into());
        s.page = 7;
        s.snapshot = json!({"race": {"raceStartedAt": 0}, "settings": {"publicRecordMode": "day"}});
        s.history = json!({"laps": [timed("a", 100_000, 100_000), timed("b", 170_000, 70_000)], "events": []});
        poll(&mut s, true, now());
        assert!(
            s.public_screens.flash.is_none(),
            "laps there on opening don't flash"
        );
        let mut laps = s.history["laps"].as_array().cloned().unwrap();
        laps.push(timed("c", 250_000, 80_000));
        s.history["laps"] = json!(laps);
        poll(&mut s, true, now());
        assert!(s.public_screens.flash.is_none(), "slower than the record");
        laps.push(timed("d", 310_000, 60_000));
        s.history["laps"] = json!(laps);
        poll(&mut s, true, now());
        let (f, _) = s.public_screens.flash.clone().expect("record flash");
        assert_eq!(
            (f.title.as_str(), f.big.as_str(), f.who.as_str()),
            ("Nieuw dagrecord", "1:00.000", "7 Fien")
        );
        s.history["events"] = json!([{"id": "e1", "type": "burgie_gepakt", "runnerNumber": "8", "runnerName": "Tuur", "createdAt": 1}]);
        poll(&mut s, true, now());
        let (f, shown_at) = s.public_screens.flash.clone().expect("burgie flash");
        assert_eq!(
            (f.title.as_str(), f.big.as_str(), f.who.as_str()),
            ("Burgie gepakt", "ZINGEN", "8 Tuur")
        );
        assert!(!poll(&mut s, false, shown_at + OUTSIDE_ALERT_VISIBLE_MS - 1));
        assert!(poll(&mut s, false, shown_at + OUTSIDE_ALERT_VISIBLE_MS));
        assert!(s.public_screens.flash.is_none());
        s.page = 5;
        poll(&mut s, true, now());
        assert!(s.public_screens.flash.is_none());
    }

    #[test]
    fn display_controls_switch_presentation_and_ranking_label() {
        use rune::{Env, Runtime};
        let mut s = init_with_url("http://127.0.0.1:9".into());
        s.page = 5;
        s.snapshot = json!({"race": {}, "settings": {}, "runners": [], "labels": [{"id": "l1", "name": "Dames", "kind": "andere"}]});
        s.history = json!({"laps": [], "events": []});
        s.public_screens.hovered = true;
        let mut rt = Runtime::new(
            s,
            super::super::view,
            (1366.0, 768.0),
            Env {
                system_dark: true,
                scale: 1.0,
            },
        );
        rt.frame(0.0);
        let press = |rt: &mut Runtime<State>, key: &str| {
            rt.frame(1.0 / 60.0);
            let (x, y) = rt.find(key).unwrap_or_else(|| panic!("Missing {key}"));
            rt.pointer_move(x, y);
            rt.pointer_down(x, y);
            rt.pointer_up(x, y);
            rt.frame(1.0 / 60.0);
        };
        press(&mut rt, "display-light");
        assert!(rt.state.public_screens.settings.light(5, false));
        assert_eq!(rt.state.public_screens.settings.query(5), "?thema=licht");
        press(&mut rt, "display-ranking");
        press(&mut rt, "display-ranking-l1");
        assert_eq!(rt.state.public_screens.ranking_label.as_deref(), Some("l1"));
        assert!(rt.state.public_screens.ranking_changed, "the new ranking rises in");
    }

    #[test]
    fn runners_and_laps_that_arrive_after_opening_rise_in() {
        let mut s = init_with_url("http://127.0.0.1:9".into());
        s.page = 5;
        s.snapshot = json!({"race": {"raceStartedAt": 0}, "settings": {}, "runners": []});
        s.history = json!({"laps": [timed("a", 100_000, 100_000)], "events": []});
        poll(&mut s, true, now());
        assert!(!arrived(&s, "active") && !arrived(&s, "next"), "the first ones are simply there");
        assert!(s.public_screens.new_laps.is_empty());
        assert_eq!(s.public_screens.laps_at_open, Some(1));
        s.history["laps"] = json!([timed("a", 100_000, 100_000), timed("b", 170_000, 70_000)]);
        poll(&mut s, true, now());
        assert!(s.public_screens.new_laps.contains("b"));
        assert!(!s.public_screens.new_laps.contains("a"));
        s.page = 0;
        poll(&mut s, true, now());
        assert!(s.public_screens.seen_laps.is_none(), "reopening starts over");
    }

    #[test]
    fn ctrl_plus_zooms_the_display_and_ctrl_zero_resets_it() {
        use rune::{Env, Key, KeyEvent, Mods, Runtime};
        let mut s = init_with_url("http://127.0.0.1:9".into());
        s.page = 7;
        s.snapshot = json!({"race": {}, "settings": {}, "runners": []});
        s.history = json!({"laps": [], "events": []});
        let mut rt = Runtime::new(
            s,
            super::super::view,
            (1366.0, 768.0),
            Env {
                system_dark: true,
                scale: 1.0,
            },
        );
        rt.frame(0.0);
        let ctrl = |c: char| KeyEvent {
            key: Key::Command(c),
            mods: Mods {
                ctrl: true,
                cmd: true,
                ..Default::default()
            },
        };
        rt.update_if(|s, _| key(s, &ctrl('+')));
        rt.frame(1.0 / 60.0);
        assert_eq!(rt.state.public_screens.settings.zoom(7), 1.1);
        assert!(rt.find("display-zoom-110").is_some(), "the page draws zoomed");
        rt.update_if(|s, _| key(s, &ctrl('0')));
        rt.frame(1.0 / 60.0);
        assert_eq!(rt.state.public_screens.settings.zoom(7), 1.0);
        assert!(rt.find("display-zoom-110").is_none());
    }
}
