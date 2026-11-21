//! Timing: the one screen that clocks laps. A station with the running lap and the big handoff
//! key, beside the next runners and the last ten laps. Port of src/components/TimingView.tsx and
//! src/styles/timing.css; sizes are the reference's at 1366×768.
use super::*;

pub(super) fn clocks(s: &State, clock: &mut clock::Sample) {
    let total: i64 = runners(s).iter().filter_map(|r| r["lapCount"].as_i64()).sum();
    if total > 0 && total % 100 == 0 {
        if let Some(at) = s.history["laps"][0]["finishedAt"].as_i64() {
            clock.until(at + 120_000);
        }
    }
    let page = &s.timing_page;
    let race = &s.snapshot["race"];
    if page.finish_stop.as_ref().is_some_and(|(_, started)| started == &race["activeStartedAt"]) { return; }
    let pending = page.pending.as_ref();
    let start = match pending {
        Some((_, id, at)) => id.as_ref().filter(|id| runners(s).iter().any(|r| st(r, "id") == id.as_str())).map(|_| *at),
        None if runners(s).iter().any(|r| !race["activeRunnerId"].is_null() && r["id"] == race["activeRunnerId"]) => race["activeStartedAt"].as_i64(),
        None => None,
    };
    if let Some(start) = start { clock.bucket(start, 100); }
}

const MIN_LAP_MS: i64 = 20_000;
const TOUCH_TARGET: f32 = 44.0;

mod handoff_sound;

#[derive(Clone, PartialEq, Debug)]
pub(super) enum Dialog {
    Resume,
    ShortLap(String),
    Undo { reopen: bool },
    Finish(u8),
    TakeOver,
}
#[derive(Default)]
pub(super) struct Page {
    pub(super) dialog: Option<Dialog>,
    /// The press a question holds: its input, so the lap still ends at the press.
    held: Option<Value>,
    /// "Race beëindigen" stops the clock: the press and the lap it belongs to.
    finish_stop: Option<(i64, Value)>,
    finish_step_at: Option<Instant>,
    /// A handoff on its way: the lap it ends, the runner it starts and when.
    pending: Option<(Value, Option<String>, i64)>,
    reopen: bool,
    sound: handoff_sound::Click,
    pub(super) last_action: String,
    pub(super) error: String,
}

struct Pal {
    brand: rune::Color,
    brand_ink: rune::Color,
    on_brand: rune::Color,
    go: rune::Color,
    stop: rune::Color,
    stop_ink: rune::Color,
    stop_wash: rune::Color,
    stop_line: rune::Color,
    warn_ink: rune::Color,
    line2: rune::Color,
    surface2: rune::Color,
    surface3: rune::Color,
    ink2: rune::Color,
    ink3: rune::Color,
    overlay: rune::Color,
}
fn pal(dark: bool) -> Pal {
    use rune::{color::hex, oklch, oklcha};
    let t = tok::theme(dark);
    let brand = oklch(0.57, 0.2, 264.0);
    if dark {
        Pal {
            brand,
            brand_ink: oklch(0.72, 0.14, 262.0),
            on_brand: oklch(1.0, 0.0, 0.0),
            go: oklch(0.74, 0.19, 145.0),
            stop: oklch(0.665, 0.205, 27.0),
            stop_ink: oklch(0.734, 0.163, 25.8),
            stop_wash: oklch(0.247, 0.03, 19.5),
            stop_line: oklch(0.356, 0.077, 23.9),
            warn_ink: oklch(0.79, 0.12, 58.0),
            line2: hex("#34343A").unwrap(),
            surface2: hex("#26262A").unwrap(),
            surface3: rune::color::hex("#2B2B2F").unwrap(),
            ink2: t.text_secondary,
            ink3: tok::muted(true),
            overlay: oklcha(0.0, 0.0, 0.0, 0.55),
        }
    } else {
        Pal {
            brand,
            brand_ink: oklch(0.5, 0.19, 264.0),
            on_brand: oklch(1.0, 0.0, 0.0),
            go: oklch(0.527, 0.137, 150.1),
            stop: oklch(0.577, 0.215, 27.3),
            stop_ink: oklch(0.505, 0.19, 27.5),
            stop_wash: oklch(0.965, 0.014, 17.4),
            stop_line: oklch(0.862, 0.055, 18.3),
            warn_ink: oklch(0.4732, 0.1247, 46.2),
            line2: hex("#D9D9DE").unwrap(),
            surface2: hex("#F1F1F3").unwrap(),
            surface3: rune::color::hex("#E9E9EC").unwrap(),
            ink2: t.text_secondary,
            ink3: tok::muted(false),
            overlay: oklcha(0.21, 0.006, 285.9, 0.4),
        }
    }
}

fn st<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
/// "113 Fien": the number and the first name, as the button and the dialogs say it.
fn short_name(r: &Value) -> String {
    let name = st(r, "name").trim();
    let first = name.split_whitespace().next().unwrap_or(name);
    match st(r, "runnerNumber") {
        "" => first.to_string(),
        n => format!("{n} {first}"),
    }
}
fn clock_time(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| {
            d.with_timezone(&chrono_tz::Europe::Brussels)
                .format("%H:%M:%S%.3f")
                .to_string()
        })
        .unwrap_or_else(|| "—".into())
}
fn seconds_nl(ms: i64) -> String {
    let tenths = (ms.max(0) + 50) / 100;
    if tenths % 10 == 0 {
        format!("{}", tenths / 10)
    } else {
        format!("{},{}", tenths / 10, tenths % 10)
    }
}

fn phase(race: &Value) -> &'static str {
    if race["raceStartedAt"].is_null() {
        "not_started"
    } else if !race["raceFinishedAt"].is_null() {
        "finished"
    } else if race["activeRunnerId"].is_null() {
        "idle"
    } else {
        "running"
    }
}
fn active_runner(s: &State) -> Option<&Value> {
    let id = &s.snapshot["race"]["activeRunnerId"];
    if id.is_null() {
        return None;
    }
    s.snapshot["runners"].as_array()?.iter().find(|r| &r["id"] == id)
}

fn handoff_check_due(race: &Value, runner: &Value, clock: i64) -> bool {
    if phase(race) != "running" {
        return false;
    }
    let typical = ["averageLapMs", "historicalAvgMs"].into_iter().find_map(|key| {
        runner[key]
            .as_f64()
            .filter(|ms| (MIN_LAP_MS as f64..=600_000.0).contains(ms))
    });
    race["activeStartedAt"]
        .as_i64()
        .zip(typical)
        .is_some_and(|(start, typical)| clock.saturating_sub(start) as f64 >= 2.0 * typical)
}

pub(super) fn waiting(s: &State) -> Vec<&Value> {
    let mut list: Vec<&Value> = runners(s)
        .into_iter()
        .filter(|r| r["status"] == "waiting")
        .collect();
    list.sort_by_key(|r| {
        (
            r["queueIndex"].as_i64().unwrap_or(i64::MAX),
            r["statusSince"].as_i64().unwrap_or(i64::MAX),
        )
    });
    list
}
struct Cluster {
    blocked: bool,
    removed: bool,
    elsewhere: Option<(String, bool)>,
    no_majority: bool,
    self_timing: bool,
}
fn cluster(s: &State) -> Cluster {
    let c = &s.snapshot["cluster"];
    let removed = !c["removedFrom"].is_null() && c["removedFrom"] != false;
    let elsewhere = (c["timing"].is_object() && c["timing"]["self"] != true).then(|| {
        (
            c["timing"]["name"].as_str().unwrap_or("een andere laptop").to_string(),
            c["timing"]["reachable"] == true,
        )
    });
    let no_majority = c["state"] == "no-majority";
    Cluster {
        blocked: no_majority || removed || elsewhere.is_some(),
        removed,
        elsewhere,
        no_majority,
        self_timing: c["timing"]["self"] == true,
    }
}

fn base_input(s: &State, pressed: i64) -> Value {
    let race = &s.snapshot["race"];
    let mut input = json!({"activeRunnerId":race["activeRunnerId"],"activeStartedAt":race["activeStartedAt"],"pressedAt":pressed});
    if let Some((instant, started)) = s.last_press
        && race["activeStartedAt"].as_i64() == Some(started)
    {
        let measured = instant.elapsed().as_millis() as i64 - (s.server_now() - pressed).max(0);
        input["measuredDurationMs"] = json!(measured.max(0));
    }
    input
}
fn send_handoff(s: &mut State, input: Value) {
    let next = waiting(s).first().map(|r| st(r, "id").to_string());
    let pressed = input["pressedAt"].as_i64().unwrap_or_else(now);
    s.timing_page.pending = Some((s.snapshot["race"]["activeStartedAt"].clone(), next, pressed));
    s.last_press = Some((Instant::now(), pressed));
    s.send("race.handoff", input);
    if !s.busy {
        s.timing_page.pending = None;
    }
}
fn unreachable(s: &mut State) -> bool {
    if !s.connected {
        s.timing_page.last_action.clear();
        s.timing_page.error = "Niet opgeslagen: geen verbinding met de laptop. Druk opnieuw.".into();
        return true;
    }
    false
}

/// Spatie or Enter on this screen: the same press as the button, but never after the finish.
pub(super) fn key_press(s: &mut State) {
    if phase(&s.snapshot["race"]) == "finished" || s.timing_page.dialog.is_some() {
        return;
    }
    press(s);
}
/// The big button: clock the runner off and start the next, start the first, or resume.
pub(super) fn press(s: &mut State) {
    let race = s.snapshot["race"].clone();
    if s.busy
        || s.timing_page.dialog.is_some()
        || cluster(s).blocked
        || (active_runner(s).is_none() && waiting(s).is_empty())
    {
        return;
    }
    if unreachable(s) {
        return;
    }
    if phase(&race) == "finished" {
        s.timing_page.dialog = Some(Dialog::Resume);
        return;
    }
    let input = base_input(s, s.server_now());
    let lap_ms = input["measuredDurationMs"].as_i64().or_else(|| {
        race["activeStartedAt"]
            .as_i64()
            .map(|start| input["pressedAt"].as_i64().unwrap_or(0) - start)
    });
    if let Some(runner) = active_runner(s)
        && let Some(ms) = lap_ms.filter(|ms| *ms < MIN_LAP_MS)
    {
        let text = format!(
            "{} is pas {} s onderweg. Dubbel gedrukt? Kies Annuleer.",
            short_name(runner),
            seconds_nl(ms)
        );
        s.timing_page.held = Some(input);
        s.timing_page.dialog = Some(Dialog::ShortLap(text));
        return;
    }
    send_handoff(s, input);
}
fn undo(s: &mut State) {
    if s.busy {
        return;
    }
    let race = &s.snapshot["race"];
    let next = &s.snapshot["nextUndo"];
    if next.is_null() || (phase(race) == "finished" && next != "finish") {
        s.timing_page.error = if phase(race) == "finished" {
            "De race is afgesloten. Hervat de race eerst om een wissel ongedaan te maken."
        } else {
            "Er is geen wissel om ongedaan te maken"
        }
        .into();
        return;
    }
    s.timing_page.dialog = Some(Dialog::Undo { reopen: next == "finish" });
}
/// Burgie gepakt and undo sit in the page header, as Hex puts a page's actions top right.
pub(super) fn header_actions(s: &State) -> Vec<El> {
    let c = cluster(s);
    vec![
        off(btn("burgie", "Burgie gepakt", s.dark, burgie), c.blocked, s.dark),
        off(btn("undo", "Laatste wissel ongedaan maken", s.dark, undo), c.blocked, s.dark),
    ]
}
fn burgie(s: &mut State) {
    if !unreachable(s) {
        s.send("events.burgieGepakt", json!({}));
    }
}
fn start_finish(s: &mut State) {
    if s.busy {
        return;
    }
    s.timing_page.finish_stop = Some((s.server_now(), s.snapshot["race"]["activeStartedAt"].clone()));
    s.timing_page.dialog = Some(Dialog::Finish(1));
}
fn close(s: &mut State) {
    if matches!(s.timing_page.dialog, Some(Dialog::Finish(_))) && s.busy {
        return;
    }
    s.timing_page.dialog = None;
    s.timing_page.held = None;
    s.timing_page.finish_stop = None;
}
fn confirm(s: &mut State) {
    let Some(dialog) = s.timing_page.dialog.clone() else { return };
    if s.busy {
        return;
    }
    match dialog {
        Dialog::Resume => {
            s.timing_page.dialog = None;
            if unreachable(s) {
                return;
            }
            // The lap starts at the confirmation, not at the press that opened it.
            let mut input = base_input(s, s.server_now());
            input["resume"] = json!(true);
            send_handoff(s, input);
        }
        Dialog::ShortLap(_) => {
            s.timing_page.dialog = None;
            let Some(input) = s.timing_page.held.take() else { return };
            if input["activeStartedAt"] != s.snapshot["race"]["activeStartedAt"] {
                s.timing_page.error = "De loper is intussen gewisseld. Druk opnieuw.".into();
                return;
            }
            send_handoff(s, input);
        }
        Dialog::Undo { reopen } => {
            s.timing_page.dialog = None;
            s.timing_page.reopen = reopen;
            let input = base_input(s, s.server_now());
            s.send("race.undoLastHandoff", input);
        }
        Dialog::Finish(1) => {
            s.timing_page.finish_step_at = Some(Instant::now());
            s.timing_page.dialog = Some(Dialog::Finish(2));
        }
        Dialog::Finish(_) => {
            // The second click of a double click on "Verder" lands here; it does not count.
            if s
                .timing_page
                .finish_step_at
                .is_some_and(|at| at.elapsed() < Duration::from_millis(500))
            {
                return;
            }
            let Some((pressed, started)) = s.timing_page.finish_stop.clone() else { return };
            if started != s.snapshot["race"]["activeStartedAt"] {
                s.timing_page.dialog = None;
                s.timing_page.finish_stop = None;
                s.timing_page.error = "De loper is intussen gewisseld. Beëindig de race opnieuw.".into();
                return;
            }
            let mut input = base_input(s, pressed);
            input.as_object_mut().unwrap().remove("measuredDurationMs");
            s.send("race.finish", input);
        }
        Dialog::TakeOver => {
            s.timing_page.dialog = None;
            if cluster(s).no_majority {
                s.send("cluster.continueAlone", json!({"takeOverTiming":true}));
            } else {
                s.send("cluster.openTiming", json!({"takeOver":true}));
            }
        }
    }
}

/// An answer from the server to a Timing action.
pub(super) fn succeeded(s: &mut State, method: &str, result: &Value) {
    let page = &mut s.timing_page;
    if s.page == 2 && page.pending.is_some() && method == "race.handoff" && is_runner_handoff(result) {
        page.sound.play();
    }
    page.pending = None;
    page.error.clear();
    page.last_action = match method {
        "race.handoff" | "race.startNext" => {
            if result["startedRunnerId"].is_null() {
                s.last_press = None;
            }
            if result["lapId"].is_null() {
                "Loper gestart."
            } else if result["startedRunnerId"].is_null() {
                "Ronde opgeslagen. Niemand actief; de wachtrij is leeg."
            } else {
                "Ronde opgeslagen. Volgende loper gestart."
            }
            .into()
        }
        "race.undoLastHandoff" if page.reopen => "Race heropend. Beëindigen ongedaan gemaakt.".into(),
        "race.undoLastHandoff" => "Laatste wissel ongedaan gemaakt.".into(),
        "race.finish" => {
            page.dialog = None;
            page.finish_stop = None;
            s.last_press = None;
            "Race beëindigd.".into()
        }
        "events.burgieGepakt" => {
            let runner = match (result["runnerName"].as_str(), st(result, "runnerNumber")) {
                (Some(name), "") => format!(" voor {name}"),
                (Some(name), n) => format!(" voor {n} {name}"),
                _ => String::new(),
            };
            format!(
                "Burgie gepakt opgeslagen om {}{runner}.",
                clock_time(result["occurredAt"].as_i64().unwrap_or_else(now))
            )
        }
        _ => "Timing overgenomen. Je klokt nu op deze laptop.".into(),
    };
}

fn is_runner_handoff(result: &Value) -> bool {
    result["lapId"].is_string() && result["startedRunnerId"].is_string()
}
/// A Timing action that failed: the reason shows under the button, not at the top of the page.
pub(super) fn failed(s: &mut State, method: &str) {
    if !(method.starts_with("race.") && method != "race.clear"
        || method == "events.burgieGepakt"
        || method.starts_with("cluster."))
    {
        return;
    }
    s.timing_page.pending = None;
    s.timing_page.last_action.clear();
    s.timing_page.error = if method == "events.burgieGepakt" {
        format!("Burgie gepakt niet opgeslagen: {}", s.error)
    } else {
        std::mem::take(&mut s.error)
    };
    s.error.clear();
}

fn btn(key: &str, value: &str, dark: bool, f: impl Fn(&mut State) + 'static) -> El {
    let t = tok::theme(dark);
    let p = pal(dark);
    row()
        .key(key.to_string())
        .role("button")
        .label(value.to_string())
        .focusable(true)
        .min_h(TOUCH_TARGET)
        .px(14.0)
        .center()
        .radius(9.0)
        .fill(t.card)
        .border(1.0, p.line2)
        .hover(p.surface2)
        .on_press(f)
        .child(text(value.to_string()).font(ts(13.5, 500.0)).color(t.text))
}
fn off(button: El, disabled: bool, dark: bool) -> El {
    if !disabled {
        return button;
    }
    let p = pal(dark);
    button
        .disabled(true)
        .fill(p.surface2)
        .border(1.0, tok::theme(dark).card_border)
        .opacity(0.75)
}

fn sound_switch(s: &State) -> El {
    let t = tok::theme(s.dark);
    let p = pal(s.dark);
    let enabled = s.timing_page.sound.enabled();
    row()
        .key("timing-sound")
        .role("switch")
        .label("Wisselgeluid")
        .checked(enabled)
        .focusable(true)
        .min_h(TOUCH_TARGET)
        .px(14.0)
        .gap(8.0)
        .center_y()
        .radius(9.0)
        .fill(t.card)
        .border(1.0, p.line2)
        .hover(p.surface2)
        .on_press_tx(|s: &mut State, tx| {
            s.timing_page.sound.toggle();
            if !tx.focus_visible() {
                tx.focus("handoff", false);
            }
        })
        .child(text("Wisselgeluid").font(ts(13.5, 500.0)).color(t.text))
        .child(
            text(if enabled { "Aan" } else { "Uit" })
                .font(ts(12.5, 550.0))
                .color(if enabled { p.brand_ink } else { p.ink3 }),
        )
}
fn pill(label: &Value, s: &State) -> El {
    let t = tok::theme(s.dark);
    let mut badge = row()
        .gap(5.0)
        .center_y()
        .h(20.0)
        .pl(5.0)
        .pr(6.0)
        .radius(4.0)
        .fill(t.card)
        .border(1.0, t.card_border);
    if let Some(image) = label["imageUrl"].as_str().and_then(|url| s.logos.get(url)) {
        badge = badge.child(rune::el().size(14.0, 14.0).radius(2.0).pixels_fit(image.pixels(), rune::SurfaceFit::Fit));
    } else {
        let color = rune::color::hex(label["color"].as_str().unwrap_or("#3b82f6")).unwrap_or(t.text);
        badge = badge.child(rune::el().size(7.0, 7.0).radius(3.5).fill(color));
    }
    badge.child(text(st(label, "name").to_string()).font(ts(12.0, 500.0)).color(pal(s.dark).ink2))
}
fn banner(content: El, dark: bool) -> El {
    let p = pal(dark);
    row()
        .px(12.0)
        .py(9.0)
        .gap(12.0)
        .center_y()
        .radius(6.0)
        .fill(p.stop_wash)
        .border(1.0, p.stop_line)
        .min_w(0.0)
        .child(content)
}
fn body_text(value: impl Into<String>, color: rune::Color) -> El {
    text(value.into())
        .font(ts(13.5, 400.0).lh(20.25))
        .color(color)
        .wrap()
        .min_w(0.0)
}

pub(super) fn page(s: &State) -> El {
    let t = tok::theme(s.dark);
    let p = pal(s.dark);
    let race = &s.snapshot["race"];
    let page = &s.timing_page;
    let c = cluster(s);
    let active = active_runner(s);
    let queue = waiting(s);
    let total: i64 = runners(s).iter().filter_map(|r| r["lapCount"].as_i64()).sum();
    let pending = page
        .pending
        .as_ref()
        .filter(|(from, _, _)| s.busy && from == &race["activeStartedAt"]);
    let shown: Option<&Value> = match pending {
        Some((_, Some(id), _)) => queue.iter().copied().find(|r| st(r, "id") == id),
        Some((_, None, _)) => None,
        None => active,
    };
    let shown_started = match pending {
        Some((_, id, at)) => id.as_ref().map(|_| *at),
        None => race["activeStartedAt"].as_i64(),
    };
    let shown_queue: Vec<&Value> = match pending {
        Some((_, Some(id), _)) => queue.iter().copied().filter(|r| st(r, "id") != id).collect(),
        _ => queue.clone(),
    };
    let shown_next = shown_queue.first().copied();
    let finished = phase(race) == "finished" && pending.is_none();
    let finish_press = page
        .finish_stop
        .as_ref()
        .filter(|(_, started)| started == &race["activeStartedAt"])
        .map(|(at, _)| *at);
    let handoff_disabled = c.blocked || (active.is_none() && queue.is_empty());

    // Station: label, runner, clock, the key, feedback and the footer.
    let mut status = row().gap(6.0).center_y().h(19.0);
    if shown.is_some() {
        status = status.child(rune::el().size(7.0, 7.0).radius(3.5).fill(p.go));
    }
    status = status.child(
        text(if finished {
            "Race afgesloten"
        } else if shown.is_some() {
            "Nu op de piste"
        } else {
            "Nog niemand op de piste"
        })
        .font(ts(12.5, 400.0))
        .color(p.ink3),
    );
    let now_row = match shown {
        Some(r) => {
            let mut who = row().gap(12.0).center_y();
            if !st(r, "runnerNumber").is_empty() {
                who = who.child(
                    text(st(r, "runnerNumber").to_string())
                        .font(ts(32.0, 500.0).lh(36.8).tracking(-0.64))
                        .color(p.ink3),
                );
            }
            who = who.child(
                text(st(r, "name").to_string())
                    .font(ts(32.0, 600.0).lh(36.8).tracking(-0.64))
                    .color(t.text),
            );
            let mut line = row().key("timing-now").gap(16.0).center_y().min_h(40.0).flex_wrap().child(who);
            if let Some(labels) = r["labels"].as_array().filter(|l| !l.is_empty()) {
                let mut list = row().gap(4.0).center_y().flex_wrap();
                for label in labels {
                    list = list.child(pill(label, s));
                }
                line = line.child(list);
            }
            line
        }
        None => row().min_h(40.0).center_y().child(
            text(if finished {
                "Niemand actief"
            } else if shown_next.is_some() {
                "Klaar om te starten"
            } else {
                "Wacht op de eerste loper"
            })
            .font(ts(28.0, 500.0).tracking(-0.56))
            .color(p.ink3),
        ),
    };
    let (main, fraction, idle) = match (shown, shown_started) {
        (Some(_), Some(start)) => {
            let ms = (finish_press.unwrap_or(s.clock) - start).max(0);
            (duration(ms), format!(".{}", (ms % 1000) / 100), false)
        }
        _ => ("0:00".to_string(), ".0".to_string(), true),
    };
    let clock = row()
        .key("timing-clock")
        .role("timer")
        .label("Lopende rondetijd")
        .items_end()
        .child(
            text(main)
                .font(ts(96.0, 550.0).lh(92.0).tracking(-3.6))
                .color(if idle { p.surface3 } else { t.text }),
        )
        .child(
            text(fraction)
                .font(ts(42.0, 550.0).lh(44.0).tracking(-0.8))
                .color(if idle { p.surface3 } else { p.ink3 })
                .mb(-2.0),
        );
    let previous = shown
        .and_then(|r| r["lastLapMs"].as_i64())
        .filter(|ms| *ms > 0)
        .map(lap_duration)
        .unwrap_or_else(|| "—".into());
    let best = shown
        .and_then(|r| r["bestLapMs"].as_i64())
        .filter(|ms| *ms > 0)
        .map(lap_duration)
        .unwrap_or_else(|| "—".into());
    let clock_row = col().w_full().pb(6.0).child(clock);
    let handoff_label = if let Some((name, _)) = &c.elsewhere {
        format!("Timing staat open op {name}")
    } else if c.blocked {
        "Timing geblokkeerd".into()
    } else if phase(race) == "finished" && pending.is_none() && !queue.is_empty() {
        format!("Race hervatten met {}", short_name(queue[0]))
    } else {
        match (shown, shown_next) {
            (Some(r), Some(n)) => format!("Klok {} af, start {}", short_name(r), short_name(n)),
            (Some(r), None) => format!("Klok {} af", short_name(r)),
            (None, Some(n)) => format!("Start {}", short_name(n)),
            (None, None) => "Geen loper klaar".into(),
        }
    };
    let mut key = row()
        .key("handoff")
        .role("button")
        .label(if !finished && !handoff_disabled {
            format!("{handoff_label} Spatie / Enter")
        } else {
            handoff_label.clone()
        })
        .focusable(true)
        .w_full()
        .min_h(88.0)
        .px(24.0)
        .center_y()
        .justify_between()
        .gap(8.0)
        .radius(12.0)
        .busy(s.busy)
        .child(
            text(handoff_label)
                .font(ts(19.0, 550.0))
                .color(if handoff_disabled { p.ink3 } else { p.on_brand })
                .wrap()
                .min_w(0.0)
                .grow(1.0),
        );
    key = if handoff_disabled {
        key.disabled(true)
            .fill(p.surface2)
            .border(1.0, t.card_border)
            .border_dash(4.0, 3.0)
    } else {
        key.fill(p.brand)
            .border(1.0, p.brand)
            .hover(oklch_hover(s.dark))
            .on_press(press)
            .on_key(|s: &mut State, event, tx| {
                let space = matches!(&event.key, Key::Text(v) if v == " ");
                if !(event.key == Key::Enter || space) || event.mods != rune::Mods::default() {
                    return false;
                }
                if !tx.key_repeat() {
                    key_press(s);
                }
                true
            })
    };
    if !finished && !handoff_disabled {
        key = key.child(
            row()
                .h(26.0)
                .px(10.0)
                .center_y()
                .radius(7.0)
                .fill(rune::oklcha(1.0, 0.0, 0.0, 0.18))
                .child(text("Spatie").font(ts(13.0, 500.0)).color(p.on_brand)),
        );
    }

    let mut feedback = col().gap(8.0).min_h(42.0);
    if c.blocked {
        let message = if c.removed {
            body_text("Deze laptop is uit de groep gehaald. Niets wordt hier bewaard. Klik in Beheer › Systeem & herstel op Opnieuw koppelen.", t.text)
        } else if let Some((name, reachable)) = &c.elsewhere {
            let why = if c.no_majority {
                format!("Er zijn te weinig laptops bereikbaar. Klok verder op {name}, of wacht tot het netwerk terug is.")
            } else if *reachable {
                "Klok daar verder: zo telt geen ronde dubbel.".into()
            } else {
                format!("{name} antwoordt niet.")
            };
            row()
                .gap(12.0)
                .center_y()
                .grow(1.0)
                .min_w(0.0)
                .child(body_text(format!("Timing staat open op {name}. {why} Werkt {name} niet meer?"), t.text).grow(1.0))
                .child(
                    off(
                        btn("timing-takeover", "Overnemen", s.dark, |s| {
                            if !s.busy {
                                s.timing_page.dialog = Some(Dialog::TakeOver)
                            }
                        })
                        .px(10.0),
                        s.busy,
                        s.dark,
                    ),
                )
        } else if c.self_timing {
            body_text("Timing staat even stil. Komt het netwerk niet binnen enkele seconden terug, dan werkt deze laptop vanzelf alleen verder en klok je gewoon door.", t.text)
        } else {
            body_text("Timing staat stil. Klokken lukt weer zodra een tweede laptop terug is. Zijn de andere laptops echt kapot, ga dan alleen verder in Beheer.", t.text)
        };
        feedback = feedback.child(banner(message, s.dark));
    }
    if !page.error.is_empty() {
        feedback = feedback.child(banner(body_text(page.error.clone(), t.text), s.dark).key("timing-error").role("alert"));
    }
    if s.connected
        && !c.blocked
        && !s.busy
        && page.dialog.is_none()
        && active.is_some_and(|runner| handoff_check_due(race, runner, s.clock))
    {
        feedback = feedback.child(
            row()
                .key("timing-handoff-check")
                .role("status")
                .radius(8.0)
                .px(12.0)
                .py(8.0)
                .fill(p.surface2)
                .child(body_text(
                    "Even checken: is er al gewisseld? Zo niet, laat de klok gerust doorlopen.",
                    t.text,
                )),
        );
    }
    if pending.is_some() {
        feedback = feedback.child(body_text("Wissel wordt opgeslagen…", p.ink3).role("status"));
    } else if !page.last_action.is_empty() {
        feedback = feedback.child(
            row()
                .key("timing-done")
                .role("status")
                .gap(8.0)
                .child(text("✓").font(ts(13.5, 700.0).lh(20.25)).color(p.go))
                .child(body_text(page.last_action.clone(), p.ink2)),
        );
    }
    // Every hundredth lap of the race gets a line of its own for two minutes.
    let newest = laps(s).first().and_then(|l| l["finishedAt"].as_i64());
    if total > 0 && total % 100 == 0 && newest.is_some_and(|at| s.clock - at < 120_000) {
        feedback = feedback.child(
            text(format!("Mijlpaal: {total} rondes in de race. Proficiat, iedereen!"))
                .key("timing-milestone")
                .role("status")
                .font(ts(13.5, 600.0).lh(20.25))
                .color(p.go),
        );
    }
    if shown.is_none() && shown_next.is_none() && !finished && !c.blocked {
        feedback = feedback.child(body_text("Zet in Wachtrij een opgewarmde loper klaar om te starten.", p.ink3));
    }
    if shown.is_some() && shown_next.is_none() && !finished && !c.blocked {
        feedback = feedback.child(body_text(
            "Niemand klaar in de wachtrij. Na afklokken loopt er niemand op de piste.",
            p.warn_ink,
        ));
    }
    if finished {
        feedback = feedback.child(body_text(
            "Race afgesloten. Spatie en Enter doen niets meer; hervat alleen bewust met de knop.",
            p.ink3,
        ));
    }
    let now_group = super::hex::group(s)
        .key("timing-now-group")
        .px(26.0)
        .pt(22.0)
        .pb(20.0)
        .gap(8.0)
        .child(status)
        .child(now_row)
        .child(clock_row);
    let station = col()
        .key("timing-station")
        .role("region")
        .label("Timing bedienen")
        .grow(1.15)
        .w(0.0)
        .min_w(0.0)
        .gap(16.0)
        .child(now_group)
        .child(key)
        .child(feedback)
        .child(row().child(sound_switch(s)))
        .child(super::hex::stats(
            s,
            vec![
                ("Eigen vorige ronde", previous),
                ("Eigen snelste ronde", best),
                ("Rondes in de race", total.to_string()),
            ],
        ));

    // Beside it: who is next and the last laps, as grouped rows.
    use super::hex;
    let mut upcoming = hex::group(s).key("timing-upcoming").role("region").label("Komende lopers");
    if shown_queue.is_empty() {
        upcoming = upcoming.child(
            hex::item(s, true).child(body_text("Niemand klaar. Zet lopers klaar via Wachtrij.", p.ink3)),
        );
    }
    for (i, r) in shown_queue.iter().take(3).enumerate() {
        upcoming = upcoming.child(
            hex::item(s, i == 0)
                .key(format!("timing-next-{}", st(r, "id")))
                .child(
                    text(format!("{}", i + 1))
                        .font(ts(14.0, if i == 0 { 600.0 } else { 400.0 }))
                        .color(if i == 0 { p.brand_ink } else { p.ink3 })
                        .w(14.0),
                )
                .child(hex::number(s, st(r, "runnerNumber"), 14.5, 36.0))
                .child(
                    text(st(r, "name").to_string())
                        .font(ts(15.0, 450.0))
                        .color(t.text)
                        .truncate()
                        .min_w(0.0)
                        .grow(1.0),
                )
        );
    }
    let recent: Vec<&Value> = laps(s).into_iter().take(5).collect();
    let mut log = hex::group(s).key("timing-log");
    if recent.is_empty() {
        log = log.child(hex::item(s, true).child(body_text("Nog geen rondes geregistreerd", p.ink3)));
    }
    for (i, lap) in recent.iter().enumerate() {
        log = log.child(
            hex::item(s, i == 0)
                .key(format!("timing-lap-{}", st(lap, "id")))
                .child(hex::number(s, st(lap, "runnerNumber"), 14.5, 36.0))
                .child({
                    // The runner's own lap count, so the table reads like the paper tally.
                    let mut name = row()
                        .grow(1.0)
                        .min_w(0.0)
                        .gap(8.0)
                        .center_y()
                        .child(
                            text(st(lap, "runnerName").to_string())
                                .font(ts(15.0, 450.0))
                                .color(t.text)
                                .truncate()
                                .min_w(0.0),
                        );
                    if let Some(n) = lap["lapNumber"].as_i64() {
                        name = name.child(text(format!("ronde {n}")).font(ts(12.5, 400.0)).color(p.ink3));
                    }
                    if let Some(praise) = hex::lap_praise(s, lap) {
                        name = name.child(praise);
                    }
                    name
                })
                .child(
                    text(
                        clock_time(lap["finishedAt"].as_i64().unwrap_or(0))
                            .split('.')
                            .next()
                            .unwrap_or("")
                            .chars()
                            .take(5)
                            .collect::<String>(),
                    )
                    .font(ts(14.0, 400.0))
                    .color(p.ink3),
                )
                .child(
                    text(lap_duration(lap["durationMs"].as_i64().unwrap_or(0)))
                        .font(ts(15.0, 550.0))
                        .color(t.text)
                        .w(78.0)
                        .align(rune::Align::End),
                ),
        );
    }
    let can_finish = matches!(phase(race), "running" | "idle");
    let finish_button = {
        let b = row()
            .key("finish")
            .role("button")
            .label("Race beëindigen")
            .focusable(true)
            .min_h(TOUCH_TARGET)
            .px(12.0)
            .center()
            .radius(8.0)
            .child(text("Race beëindigen").font(ts(14.0, 450.0)).color(
                if c.blocked || !can_finish { p.ink3 } else { p.stop_ink },
            ));
        if c.blocked || !can_finish {
            b.disabled(true)
        } else {
            b.hover(p.stop_wash).on_press(start_finish)
        }
    };
    let danger = row().justify_end().child(finish_button);
    let aside = col()
        .grow(1.0)
        .w(0.0)
        .min_w(0.0)
        .child(hex::label(s, "Hierna", Some(shown_queue.len())))
        .child(upcoming)
        .child(hex::label(s, "Laatste rondes", None).mt(22.0))
        .child(log)
        .child(danger.mt(14.0));
    let workspace = row().items_start().gap(24.0).pb(24.0).child(station).child(aside);
    if s.timing_page.dialog.is_some() {
        workspace.inert()
    } else {
        workspace
    }
}
fn oklch_hover(dark: bool) -> rune::Color {
    if dark {
        rune::oklch(0.61, 0.2, 264.0)
    } else {
        rune::oklch(0.52, 0.2, 264.0)
    }
}

/// The questions Timing asks, in the reference's words; danger ones start on Annuleer.
pub(super) fn modal(s: &State) -> Option<El> {
    if s.page != 2 {
        return None;
    }
    let dialog = s.timing_page.dialog.as_ref()?;
    let t = tok::theme(s.dark);
    let p = pal(s.dark);
    let race = &s.snapshot["race"];
    let (title, message, confirm_label, danger): (&str, String, &str, bool) = match dialog {
        Dialog::Resume => (
            "Race hervatten?",
            "De race is afgesloten. Hervatten start de volgende loper.".into(),
            "Race hervatten",
            true,
        ),
        Dialog::ShortLap(text) => ("Toch afklokken?", text.clone(), "Toch afklokken", true),
        Dialog::Undo { reopen: true } => (
            "Race beëindigen ongedaan maken?",
            "De race gaat weer open. De loper die op de piste was, loopt verder met dezelfde starttijd. Alle rondes blijven staan.".into(),
            "Race heropenen",
            true,
        ),
        Dialog::Undo { reopen: false } => (
            "Laatste wissel ongedaan maken?",
            "Wachtrij, actieve loper en eventuele ronde gaan terug naar de toestand van vóór de laatste wissel.".into(),
            "Ongedaan maken",
            true,
        ),
        Dialog::Finish(1) => {
            let stopped = match (active_runner(s), race["activeStartedAt"].as_i64(), &s.timing_page.finish_stop) {
                (Some(r), Some(start), Some((at, from))) if from == &race["activeStartedAt"] => format!(
                    "De klok van {} staat stil op {}. ",
                    short_name(r),
                    lap_duration((at - start).max(0))
                ),
                _ => String::new(),
            };
            (
                "Race beëindigen?",
                format!("{stopped}De actieve loper stopt zonder extra ronde. Bij annuleren loopt de klok gewoon verder. Daarna vraagt de app nog één keer om bevestiging."),
                "Verder",
                false,
            )
        }
        Dialog::Finish(_) => (
            "Definitief afsluiten",
            "Bevestig alleen als de race echt afgerond is. Spatie en Enter doen daarna niets meer op dit scherm.".into(),
            "Race definitief beëindigen",
            true,
        ),
        Dialog::TakeOver => {
            let name = cluster(s).elsewhere.map(|(n, _)| n).unwrap_or_else(|| "een andere laptop".into());
            if cluster(s).no_majority {
                ("Timing overnemen en alleen verder werken?", format!("Doe dit alleen als {name} echt kapot is. Er zijn te weinig laptops bereikbaar, dus deze laptop werkt dan alleen verder en klokt de rondes. Komen de andere laptops terug, dan nemen ze de gegevens van deze laptop over en bewaren ze hun eigen gegevens in een backup."), "Overnemen en alleen verder werken", true)
            } else {
                ("Timing overnemen?", format!("Doe dit alleen als Timing op {name} niet meer werkt. Daarna klok je op deze laptop, en kan {name} niet meer klokken."), "Timing overnemen", true)
            }
        }
    };
    let finishing = matches!(dialog, Dialog::Finish(_));
    let mut cancel = off(btn("timing-cancel", "Annuleer", s.dark, close), finishing && s.busy, s.dark);
    let fill = if danger { p.stop } else { p.brand };
    let mut ok = row()
        .key("timing-confirm")
        .role("button")
        .label(confirm_label)
        .focusable(true)
        .min_h(TOUCH_TARGET)
        .px(12.0)
        .center()
        .radius(6.0)
        .fill(fill)
        .border(1.0, fill)
        .hover(if danger { p.stop_ink } else { oklch_hover(s.dark) })
        .on_press(confirm)
        .child(text(confirm_label).font(ts(13.5, 500.0)).color(p.on_brand));
    if s.busy && matches!(dialog, Dialog::Finish(2)) {
        ok = ok.disabled(true).opacity(0.6);
    }
    if danger {
        cancel = cancel.autofocus();
    } else {
        ok = ok.autofocus();
    }
    Some(
        rune::el()
            .key("timing-dialog-overlay")
            .focus_return("handoff")
            .absolute(0.0, 0.0)
            .w_full()
            .h_full()
            .padding(16.0)
            .center()
            .fill(p.overlay)
            .modal(false, close)
            .child(
                col()
                    .key("timing-dialog")
                    .role("dialog")
                    .label(if finishing { "Race afsluiten" } else { title })
                    .w(420.0)
                    .max_w(420.0)
                    .padding(20.0)
                    .radius(10.0)
                    .fill(t.card)
                    .border(1.0, t.card_border)
                    .child(text(title).font(ts(16.0, 600.0).lh(20.0)).color(t.text).mb(6.0))
                    .child(body_text(message, p.ink2))
                    .child(row().mt(20.0).gap(8.0).justify_end().child(cancel).child(ok)),
            ),
    )
}

/// The reference sets tabular numbers on the whole body.
fn ts(size: f32, weight: f32) -> rune::TextStyle {
    rune::TextStyle::new(size, weight).features("tnum")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reminder_waits_for_twice_the_current_average_when_available() {
        let race = json!({"raceStartedAt":1, "activeRunnerId":"a", "activeStartedAt":1_000});
        let runner = json!({"averageLapMs":65_000.0, "historicalAvgMs":80_000});
        assert!(!handoff_check_due(&race, &runner, 130_999));
        assert!(handoff_check_due(&race, &runner, 131_000));
    }

    #[test]
    fn reminder_can_use_a_historical_average_but_not_a_missing_or_invalid_one() {
        let race = json!({"raceStartedAt":1, "activeRunnerId":"a", "activeStartedAt":1_000});
        let runner = json!({"averageLapMs":null, "historicalAvgMs":75_000});
        assert!(handoff_check_due(&race, &runner, 151_000));
        assert!(!handoff_check_due(&race, &json!({"historicalAvgMs":15_000}), 500_000));
        assert!(!handoff_check_due(&race, &json!({}), 500_000));
        for race in [
            json!({"activeRunnerId":"a", "activeStartedAt":1_000}),
            json!({"raceStartedAt":1, "activeStartedAt":1_000}),
            json!({"raceStartedAt":1, "activeRunnerId":"a"}),
            json!({"raceStartedAt":1, "activeRunnerId":"a", "activeStartedAt":1_000, "raceFinishedAt":160_000}),
        ] {
            assert!(!handoff_check_due(&race, &runner, 500_000));
        }
    }

    #[test]
    fn sound_requires_both_a_saved_lap_and_a_new_runner() {
        assert!(is_runner_handoff(&json!({"lapId":"lap", "startedRunnerId":"b"})));
        assert!(!is_runner_handoff(&json!({"startedRunnerId":"a"})));
        assert!(!is_runner_handoff(&json!({"lapId":"lap"})));
    }
}
