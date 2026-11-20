//! Beheer › Rondes: every lap, newest first, with the fixes a race needs. A press that came too
//! late or too early is nudged with buttons; a lap on the wrong runner is moved; a missed press is
//! split; a press too many is deleted. Port of src/components/admin/LapsSection.tsx and
//! src/lib/lapReview.ts.
use super::*;
use std::collections::HashMap;

const PAGE_SIZE: usize = 100;
const PICKER_SIZE: usize = 8;
const MIN_LAP_MS: i64 = 20_000;
const MAX_HANDOFF_SHIFT_MS: i64 = 15_000;
const NUDGES_MS: [i64; 4] = [-1_000, -100, 100, 1_000];

#[derive(Clone, Copy, PartialEq, Debug)]
pub(super) enum FixKind {
    Move,
    Split,
}
pub(super) struct Fix {
    kind: FixKind,
    lap_id: String,
    query: TextEdit,
    selected: Option<String>,
}
pub(super) struct Panel {
    search: TextEdit,
    flagged_only: bool,
    shown: usize,
    /// The lap clicked, and the lap that ends at the press the panel moves.
    selected: Option<(String, Option<String>)>,
    shift_ms: i64,
    /// What the runner on the track ran so far when the press was opened: it stands in for their lap.
    running_ms: Option<i64>,
    pointer: bool,
    /// While held, laps that finish after this moment wait, so no row moves under the mouse.
    hold_since: Option<i64>,
    pub(super) fix: Option<Fix>,
    pub(super) success: String,
}
impl Default for Panel {
    fn default() -> Self {
        Self {
            search: TextEdit::new(""),
            flagged_only: false,
            shown: PAGE_SIZE,
            selected: None,
            shift_ms: 0,
            running_ms: None,
            pointer: false,
            hold_since: None,
            fix: None,
            success: String::new(),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub(super) enum Flag {
    Short,
    Long,
}
#[derive(Clone, Copy, PartialEq, Debug)]
pub(super) struct Hint {
    /// Below zero the press came too late, above zero too early.
    pub shift_ms: i64,
    pub usual_before_ms: i64,
    pub usual_after_ms: i64,
}

fn n(v: &Value, key: &str) -> i64 {
    v[key].as_i64().unwrap_or(0)
}
fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn median(values: &mut [i64]) -> i64 {
    values.sort_unstable();
    let m = values.len() / 2;
    if values.len() % 2 == 1 {
        values[m]
    } else {
        // Math.round of a .5 rounds up, also for the integer sums here.
        ((values[m - 1] + values[m]) as f64 / 2.0).round() as i64
    }
}

/// Laps far from the race's median lap: a short one is most often a press too many, a long one a missed handoff.
pub(super) fn review_laps(laps: &[&Value]) -> (Option<i64>, HashMap<String, Flag>) {
    let mut flags = HashMap::new();
    if laps.len() < 5 {
        return (None, flags);
    }
    let med = median(&mut laps.iter().map(|l| n(l, "durationMs")).collect::<Vec<_>>());
    for lap in laps {
        let d = n(lap, "durationMs") as f64;
        if d < med as f64 * 0.5 {
            flags.insert(s(lap, "id").into(), Flag::Short);
        } else if d > med as f64 * 1.75 {
            flags.insert(s(lap, "id").into(), Flag::Long);
        }
    }
    (Some(med), flags)
}

/// Presses that most likely came too late or too early, keyed by the lap that ended there. A late
/// press makes one runner about as much slower than usual as the next runner faster; each runner is
/// held to their own other laps. Each lap explains one press only, the earliest.
pub(super) fn review_handoffs(laps: &[&Value]) -> HashMap<String, Hint> {
    let mut hints = HashMap::new();
    let mut measured: Vec<&Value> = laps
        .iter()
        .copied()
        .filter(|l| n(l, "durationMs") >= MIN_LAP_MS && s(l, "source") != "split")
        .collect();
    measured.sort_by_key(|l| n(l, "startedAt"));
    let mut by_runner: HashMap<&str, Vec<&Value>> = HashMap::new();
    let mut by_start: HashMap<i64, &Value> = HashMap::new();
    for lap in &measured {
        by_runner.entry(s(lap, "runnerId")).or_default().push(lap);
        by_start.insert(n(lap, "startedAt"), lap);
    }
    let usual = |runner: &str, skip: [&Value; 2]| -> Option<i64> {
        let mut others: Vec<i64> = by_runner
            .get(runner)?
            .iter()
            .filter(|l| !skip.iter().any(|k| std::ptr::eq(*k, **l)))
            .map(|l| n(l, "durationMs"))
            .collect();
        (others.len() >= 2).then(|| median(&mut others))
    };
    let mut explained: Option<&Value> = None;
    for before in &measured {
        let Some(after) = by_start.get(&n(before, "finishedAt")).copied() else {
            continue;
        };
        if explained.is_some_and(|e| std::ptr::eq(e, *before)) {
            continue;
        }
        let (Some(ub), Some(ua)) = (
            usual(s(before, "runnerId"), [before, after]),
            usual(s(after, "runnerId"), [before, after]),
        ) else {
            continue;
        };
        let off_before = n(before, "durationMs") - ub;
        let off_after = n(after, "durationMs") - ua;
        if off_before.abs() < 3_000 || off_after.abs() < 3_000 {
            continue;
        }
        if off_before.signum() == off_after.signum() || (off_before + off_after).abs() > 1_000 {
            continue;
        }
        let shift_ms = ((off_after - off_before) as f64 / 200.0).round() as i64 * 100;
        if shift_ms.abs() > MAX_HANDOFF_SHIFT_MS {
            continue;
        }
        hints.insert(
            s(before, "id").into(),
            Hint {
                shift_ms,
                usual_before_ms: ub,
                usual_after_ms: ua,
            },
        );
        explained = Some(after);
    }
    hints
}

fn fold(text: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    text.nfd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .collect::<String>()
        .to_lowercase()
}
fn matches_search(number: &str, name: &str, labels: &str, query: &str) -> bool {
    let q = fold(query.trim());
    q.is_empty() || fold(&format!("{number} {name} {labels}")).contains(&q)
}
fn runner_text(number: &str, name: &str) -> String {
    if number.is_empty() {
        name.into()
    } else {
        format!("#{number} {name}")
    }
}
fn lap_runner_text(lap: &Value) -> String {
    runner_text(s(lap, "runnerNumber"), s(lap, "runnerName"))
}
fn lap_text(lap: &Value) -> String {
    format!(
        "Ronde {} van {} ({}, {})",
        n(lap, "lapNumber"),
        lap_runner_text(lap),
        lap_duration(n(lap, "durationMs")),
        moment(n(lap, "finishedAt"))
    )
}
fn brussels(ms: i64) -> Option<chrono::DateTime<chrono_tz::Tz>> {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.with_timezone(&chrono_tz::Europe::Brussels))
}
/// "ma 17:45:16", as the reference table shows the moment a lap ended.
fn moment(ms: i64) -> String {
    use chrono::Datelike;
    brussels(ms)
        .map(|d| {
            let day = ["ma", "di", "wo", "do", "vr", "za", "zo"]
                [d.weekday().num_days_from_monday() as usize];
            format!("{day} {}", d.format("%H:%M:%S"))
        })
        .unwrap_or_else(|| "—".into())
}
/// "17:45:16.250", a press to the millisecond.
fn clock_ms(ms: i64) -> String {
    brussels(ms)
        .map(|d| format!("{}.{:03}", d.format("%H:%M:%S"), ms.rem_euclid(1000)))
        .unwrap_or_else(|| "—".into())
}
/// "4 s", "0,1 s", "1,25 s": nl-BE seconds with at most `digits` decimals.
fn seconds(ms: i64, digits: usize) -> String {
    let text = format!("{:.*}", digits, ms.abs() as f64 / 1000.0);
    let text = if text.contains('.') {
        text.trim_end_matches('0').trim_end_matches('.')
    } else {
        &text
    };
    format!("{} s", text.replace('.', ","))
}
fn signed(ms: i64) -> String {
    format!("{}{}", if ms < 0 { "−" } else { "+" }, seconds(ms, 3))
}
fn shift_text(ms: i64, as_mistake: bool) -> String {
    let sec = seconds(ms, 3);
    match (as_mistake, ms < 0) {
        (true, true) => format!("{sec} te laat"),
        (true, false) => format!("{sec} te vroeg"),
        (false, true) => format!("{sec} vroeger"),
        (false, false) => format!("{sec} later"),
    }
}
/// A usual lap time to the tenth: "1:19.4".
fn tenths(ms: i64) -> String {
    let rounded = ((ms as f64 / 100.0).round() as i64) * 100;
    let full = lap_duration(rounded);
    full[..full.len() - 2].into()
}
fn off_usual_text(off: i64) -> String {
    format!(
        "{} {} dan gewoonlijk",
        seconds(off, 1),
        if off > 0 { "trager" } else { "sneller" }
    )
}
fn flag_text(flag: Option<Flag>, median: Option<i64>) -> String {
    match (flag, median) {
        (Some(Flag::Short), Some(m)) => format!(
            "Veel korter dan gewoonlijk ({}). Eén keer te veel gedrukt?",
            lap_duration(m)
        ),
        (Some(Flag::Long), Some(m)) => {
            format!(
                "Veel langer dan gewoonlijk ({}). Wissel gemist?",
                lap_duration(m)
            )
        }
        _ => String::new(),
    }
}
fn warn(dark: bool) -> rune::Color {
    if dark {
        rune::oklch(0.79, 0.12, 58.0)
    } else {
        rune::oklch(0.55, 0.15, 50.0)
    }
}

/// Everything the table and the fix panel derive from the lap history.
struct Review<'a> {
    all: Vec<&'a Value>,
    median: Option<i64>,
    flags: HashMap<String, Flag>,
    hints: HashMap<String, Hint>,
    off_usual: HashMap<String, i64>,
    after: HashMap<i64, &'a Value>,
    before: HashMap<i64, &'a Value>,
}
impl<'a> Review<'a> {
    fn new(st: &'a State) -> Self {
        let all = laps(st);
        let (median, flags) = review_laps(&all);
        let hints = review_handoffs(&all);
        let after: HashMap<i64, &Value> = all.iter().map(|l| (n(l, "startedAt"), *l)).collect();
        let before: HashMap<i64, &Value> = all.iter().map(|l| (n(l, "finishedAt"), *l)).collect();
        let mut off_usual = HashMap::new();
        for (id, hint) in &hints {
            let Some(b) = all.iter().find(|l| s(l, "id") == id) else {
                continue;
            };
            let Some(a) = after.get(&n(b, "finishedAt")) else {
                continue;
            };
            off_usual.insert(id.clone(), n(b, "durationMs") - hint.usual_before_ms);
            off_usual.insert(s(a, "id").into(), n(a, "durationMs") - hint.usual_after_ms);
        }
        Self {
            all,
            median,
            flags,
            hints,
            off_usual,
            after,
            before,
        }
    }
    fn lap(&self, id: &str) -> Option<&'a Value> {
        self.all.iter().find(|l| s(l, "id") == id).copied()
    }
    fn marked(&self, lap: &Value) -> bool {
        let id = s(lap, "id");
        self.flags.contains_key(id) || self.off_usual.contains_key(id)
    }
    fn lap_after(&self, lap: &Value) -> Option<&'a Value> {
        self.after.get(&n(lap, "finishedAt")).copied()
    }
}
fn running_runner<'a>(st: &'a State) -> Option<&'a Value> {
    let race = &st.snapshot["race"];
    if race["activeRunnerId"].is_null() {
        return None;
    }
    runners(st)
        .into_iter()
        .find(|r| r["id"] == race["activeRunnerId"])
}
fn press_after(st: &State, r: &Review, lap: &Value) -> bool {
    let race = &st.snapshot["race"];
    r.lap_after(lap).is_some()
        || (!race["activeRunnerId"].is_null()
            && race["activeStartedAt"].as_i64() == Some(n(lap, "finishedAt")))
}
/// The lap ending at the press the panel opens on: a press that looks off next to the lap, else the one after it.
fn press_lap_for(st: &State, r: &Review, lap: &Value) -> Option<String> {
    let before = r.before.get(&n(lap, "startedAt")).copied();
    if r.hints.contains_key(s(lap, "id")) {
        return Some(s(lap, "id").into());
    }
    if let Some(b) = before
        && r.hints.contains_key(s(b, "id"))
    {
        return Some(s(b, "id").into());
    }
    if press_after(st, r, lap) {
        Some(s(lap, "id").into())
    } else {
        before.map(|b| s(b, "id").into())
    }
}
fn choose_press(st: &mut State, lap_id: String, press: Option<String>) {
    st.laps.shift_ms = 0;
    let race = &st.snapshot["race"];
    st.laps.running_ms = race["activeStartedAt"]
        .as_i64()
        .or_else(|| {
            press
                .as_deref()
                .and_then(|p| laps(st).into_iter().find(|l| s(l, "id") == p))
                .map(|l| n(l, "finishedAt"))
        })
        .map(|since| (st.clock - since).max(0));
    st.laps.selected = Some((lap_id, press));
}

/// Keeps the table still while the pointer is on it, a fix dialog is open or a delete is being confirmed.
pub(super) fn sync_hold(st: &mut State) {
    let confirming = st
        .confirm
        .as_ref()
        .is_some_and(|c| c.method == "laps.delete");
    let held = st.page == 8
        && st.admin_section == 2
        && (st.laps.pointer || st.laps.fix.is_some() || confirming);
    if !held {
        st.laps.hold_since = None;
    } else if st.laps.hold_since.is_none() {
        st.laps.hold_since = Some(
            laps(st)
                .iter()
                .map(|l| n(l, "finishedAt"))
                .max()
                .unwrap_or(0),
        );
    }
}
/// What a lap fix reports once the server accepted it.
pub(super) fn succeeded(st: &mut State, method: &str) {
    st.notice = std::mem::take(&mut st.laps.success);
    if method == "laps.moveHandoff" {
        st.laps.shift_ms = 0;
    }
    if method == "laps.delete" {
        st.laps.selected = None;
    }
}
/// A refused lap fix, worded as the reference's toast.
pub(super) fn failed(st: &mut State, method: &str) {
    let what = match method {
        "laps.delete" => "Verwijderen mislukt.",
        "laps.moveHandoff" => "Verschuiven mislukt.",
        "laps.move" => "Verplaatsen mislukt.",
        "laps.split" => "Splitsen mislukt.",
        _ => return,
    };
    st.error = format!("{what} {}", st.error);
}
pub(super) fn delete_detail(st: &State, lap_id: &Value) -> String {
    laps(st)
        .into_iter()
        .find(|l| l["id"] == *lap_id)
        .map(|l| {
            format!(
                "{} telt dan niet meer mee. Terugkrijgen kan alleen met een backup.",
                lap_text(l)
            )
        })
        .unwrap_or_default()
}

fn cell_font() -> rune::TextStyle {
    admin_kit::ts(13.0, 400.0).lh(19.5)
}
/// The time cell is the row's button, drawn as plain text.
fn open_button(key: String, title: String, dark: bool, f: impl Fn(&mut State) + 'static) -> El {
    row()
        .key(key)
        .role("button")
        .label(title.clone())
        .focusable(true)
        .center_y()
        .on_press(f)
        .child(text(title).font(cell_font()).color(tok::theme(dark).text))
}
fn small_button(
    key: String,
    title: impl Into<String>,
    dark: bool,
    f: impl Fn(&mut State) + 'static,
) -> El {
    button(key, title, dark, f).px(10.0).py(6.0)
}

pub(super) fn panel(st: &State) -> El {
    let t = tok::theme(st.dark);
    let r = Review::new(st);
    let p = &st.laps;
    let shown_laps: Vec<&Value> = match p.hold_since {
        Some(since) => r
            .all
            .iter()
            .copied()
            .filter(|l| n(l, "finishedAt") <= since)
            .collect(),
        None => r.all.clone(),
    };
    let held = r.all.len() - shown_laps.len();
    let matching: Vec<&Value> = shown_laps
        .iter()
        .copied()
        .filter(|l| {
            (!p.flagged_only || r.marked(l))
                && matches_search(s(l, "runnerNumber"), s(l, "runnerName"), "", &p.search.text)
        })
        .collect();
    let visible = &matching[..matching.len().min(p.shown)];
    let selected = p.selected.as_ref().and_then(|(id, _)| r.lap(id));
    let flagged_count = r.all.iter().filter(|l| r.marked(l)).count();

    // Cells as the reference table lays them out: 10px padding on each side, no gap.
    let head = |title: &str, w: Option<f32>| {
        let l = text(title.to_string())
            .font(admin_kit::ts(12.5, 500.0))
            .color(tok::tones(st.dark).ink3)
            .px(10.0);
        match w {
            Some(w) => l.w(w),
            None => l.grow(1.0).min_w(0.0),
        }
    };
    let mut table = col().w_full().gap(0.0).child(
        row()
            .w_full()
            .gap(0.0)
            .py(7.0)
            .border_sides([0.0, 0.0, 1.0, 0.0], t.card_border)
            .child(head("Tijd", Some(131.0)))
            .child(head("Loper", Some(248.0)))
            .child(head("Ronde", Some(76.0)))
            .child(head("Rondetijd", Some(101.0)))
            .child(head("Opvallend", None)),
    );
    for (i, lap) in visible.iter().enumerate() {
        let id = s(lap, "id").to_string();
        let is_selected = selected.is_some_and(|sel| s(sel, "id") == id);
        let flag = match r.off_usual.get(&id) {
            Some(off) => off_usual_text(*off),
            None => flag_text(r.flags.get(&id).copied(), r.median),
        };
        let open_id = id.clone();
        let cell = |el: El, w: f32| el.px(10.0).w(w).min_w(0.0);
        let mut line = row()
            .key(format!("lap-row-{id}"))
            .w_full()
            .gap(0.0)
            .py(7.0)
            .center_y()
            .border_sides([0.0, 0.0, 1.0, 0.0], t.card_border)
            .child(
                open_button(
                    format!("lap-open-{id}"),
                    moment(n(lap, "finishedAt")),
                    st.dark,
                    move |st| {
                        let r = Review::new(st);
                        let press = r.lap(&open_id).and_then(|l| press_lap_for(st, &r, l));
                        drop(r);
                        choose_press(st, open_id.clone(), press);
                    },
                )
                .checked(is_selected)
                .w(131.0)
                .px(10.0)
                .py(0.0)
                .h(19.5)
                .radius(0.0)
                .border(0.0, t.card)
                .fill(rune::Color::TRANSPARENT),
            )
            .child(cell(
                row()
                    .gap(8.0)
                    .clip_rounded(0.0)
                    // `.bib`: min-width 2.6em, weight 500, then the `.runner-name` gap.
                    .child(
                        row().w(33.8).child(
                            text(s(lap, "runnerNumber").to_string())
                                .font(admin_kit::ts(13.0, 500.0).lh(19.5))
                                .color(tok::muted(st.dark)),
                        ),
                    )
                    .child(
                        text(s(lap, "runnerName").to_string())
                            .font(cell_font())
                            .color(t.text)
                            .grow(1.0)
                            .min_w(0.0),
                    ),
                248.0,
            ))
            .child(cell(
                text(n(lap, "lapNumber").to_string())
                    .font(cell_font())
                    .color(t.text),
                76.0,
            ))
            .child(cell(
                text(lap_duration(n(lap, "durationMs")))
                    .font(cell_font())
                    .color(t.text),
                101.0,
            ))
            .child(
                text(flag)
                    .font(cell_font())
                    .color(warn(st.dark))
                    .px(10.0)
                    .grow(1.0)
                    .min_w(0.0)
                    .wrap(),
            );
        if is_selected {
            line = line.fill(t.hover);
        }
        table = table.child(line);
        // A press that looks off sits between the two laps it joins: the older lap is the next row.
        if let Some(older) = visible.get(i + 1)
            && r.lap_after(older).is_some_and(|a| s(a, "id") == id)
            && let Some(hint) = r.hints.get(s(older, "id"))
        {
            let older_id = s(older, "id").to_string();
            table = table.child(
                row()
                    .w_full()
                    .gap(12.0)
                    .px(10.0)
                    .py(6.0)
                    .center_y()
                    .border_sides([0.0, 0.0, 1.0, 0.0], t.card_border)
                    .child(
                        text(format!(
                            "Wissel {} gedrukt?",
                            shift_text(hint.shift_ms, true)
                        ))
                        .font(type_::BODY)
                        .color(warn(st.dark)),
                    )
                    .child(small_button(
                        format!("lap-seam-{older_id}"),
                        "Bekijken",
                        st.dark,
                        move |st| choose_press(st, older_id.clone(), Some(older_id.clone())),
                    )),
            );
        }
    }
    if visible.is_empty() {
        table = table.child(
            label(
                if !r.all.is_empty() {
                    "Geen rondes die passen."
                } else {
                    "Nog geen rondes gelopen."
                },
                st.dark,
            )
            .py(12.0)
            .px(10.0),
        );
    }
    let mut list = col()
        .gap(0.0)
        .grow(1.0)
        .min_w(0.0)
        .child(admin_kit::h2("Rondes", st.dark).mb(8.0))
        .child(admin_kit::copy("Elke gelopen ronde, de nieuwste bovenaan. Klik op een ronde om ze te verbeteren: een wissel te laat of te vroeg gedrukt, de verkeerde loper, een gemiste wissel of één keer te veel gedrukt. Elke verbetering staat ook in Activiteit.", st.dark).mb(12.0))
        .child(
            row()
                .w_full()
                .gap(8.0)
                .center_y()
                .mb(12.0)
                .child(
                    admin_kit::input(st, &p.search, "laps-search", "Rondes doorzoeken", "Zoek op nummer of naam")
                        .grow(1.0)
                        .on_edit(|st: &mut State| {
                            st.laps.shown = PAGE_SIZE;
                            &mut st.laps.search
                        }),
                )
                .child(admin_kit::toggle_row(
                    st,
                    "laps-flagged",
                    &format!("Alleen opvallende rondes ({flagged_count})"),
                    p.flagged_only,
                    false,
                    |st| {
                        st.laps.flagged_only = !st.laps.flagged_only;
                        st.laps.shown = PAGE_SIZE;
                    },
                ))
                .child(
                    text(match held {
                        0 => String::new(),
                        1 => "1 nieuwe ronde".into(),
                        n => format!("{n} nieuwe rondes"),
                    })
                    .font(admin_kit::ts(13.0, 400.0))
                    .color(tok::tones(st.dark).ink3)
                    .role("status"),
                ),
        )
        .child(
            table
                .key("laps-table")
                .on_hover_change(|st: &mut State, hovered, _| {
                    st.laps.pointer = hovered;
                    sync_hold(st);
                }),
        );
    if matching.len() > p.shown {
        list = list.child(
            button(
                "laps-more",
                format!(
                    "Toon {} oudere rondes",
                    PAGE_SIZE.min(matching.len() - p.shown)
                ),
                st.dark,
                |st| st.laps.shown += PAGE_SIZE,
            )
            .self_start()
            .mt(12.0),
        );
    }
    row()
        .gap(16.0)
        .min_w(0.0)
        .items_start()
        .child(list)
        .child(fix_panel(st, &r, selected))
}

fn fix_panel(st: &State, r: &Review, selected: Option<&Value>) -> El {
    let t = tok::theme(st.dark);
    let aside = col()
        .key("lap-fix")
        .label("Ronde verbeteren")
        .w(400.0)
        .gap(12.0)
        .padding(18.0)
        .radius(12.0)
        .fill(t.card)
        .border(1.0, t.card_border);
    let Some(lap) = selected else {
        return aside.child(
            text("Klik op een ronde om ze te verbeteren. Een wissel die te laat of te vroeg gedrukt werd, schuif je hier met knoppen van een seconde.")
                .font(admin_kit::ts(14.0, 400.0).lh(21.0))
                .color(tok::tones(st.dark).ink3)
                .wrap()
                .min_w(0.0),
        );
    };
    let lap_id = s(lap, "id").to_string();
    let after = r.lap_after(lap);
    let has_press_after = press_after(st, r, lap);
    let running = if has_press_after && after.is_none() {
        running_runner(st)
    } else {
        None
    };
    let mut aside = aside.child(
        row()
            .gap(10.0)
            .child(
                col()
                    .gap(6.0)
                    .grow(1.0)
                    .min_w(0.0)
                    .child(
                        heading(
                            format!("Ronde {} van {}", n(lap, "lapNumber"), lap_runner_text(lap)),
                            st.dark,
                        )
                        .wrap(),
                    )
                    .child(
                        text(format!(
                            "{}, gelopen van {} tot {}",
                            lap_duration(n(lap, "durationMs")),
                            clock_ms(n(lap, "startedAt")),
                            clock_ms(n(lap, "finishedAt"))
                        ))
                        .font(type_::BODY)
                        .color(t.text_secondary)
                        .wrap()
                        .min_w(0.0),
                    ),
            )
            .child(
                button("laps-close", "✕", st.dark, |st| st.laps.selected = None)
                    .label("Sluiten")
                    .size(30.0, 30.0)
                    .px(0.0)
                    .py(0.0)
                    .center(),
            ),
    );
    // Which press the panel moves, when the lap has one on both ends.
    let before = r.before.get(&n(lap, "startedAt")).copied();
    let next_name = after
        .map(|a| s(a, "runnerName").to_string())
        .or_else(|| running.map(|r| s(r, "name").to_string()));
    let press_id = st.laps.selected.as_ref().and_then(|(_, p)| p.clone());
    if let (Some(b), Some(next)) = (before, &next_name) {
        let mut choice = row()
            .gap(6.0)
            .flex_wrap()
            .role("group")
            .label("Welke wissel");
        for (id, title) in [
            (
                s(b, "id").to_string(),
                format!("Van {} naar {}", s(b, "runnerName"), s(lap, "runnerName")),
            ),
            (
                lap_id.clone(),
                format!("Van {} naar {next}", s(lap, "runnerName")),
            ),
        ] {
            let on = press_id.as_deref() == Some(id.as_str());
            let (lap_id, chosen) = (lap_id.clone(), id.clone());
            choice = choice.child(
                small_button(format!("press-choice-{id}"), title, st.dark, move |st| {
                    choose_press(st, lap_id.clone(), Some(chosen.clone()))
                })
                .checked(on)
                .fill(if on { t.hover } else { t.card }),
            );
        }
        aside = aside.child(choice);
    }
    if let Some(press) = press_id.as_deref().and_then(|id| r.lap(id)) {
        let press_after = r.lap_after(press);
        let press_running = if press_after.is_none() {
            running_runner(st)
        } else {
            None
        };
        if let Some(editor) = press_editor(
            st,
            press,
            press_after,
            press_running,
            r.hints.get(s(press, "id")).copied(),
        ) {
            aside = aside.child(editor);
        }
    }
    let busy = st.busy;
    let (move_id, split_id, delete_id) = (lap_id.clone(), lap_id.clone(), lap_id.clone());
    aside.child(
        col()
            .gap(10.0)
            .pt(6.0)
            .border_sides([1.0, 0.0, 0.0, 0.0], t.card_border)
            .child(
                text("Iets anders mis met deze ronde?")
                    .font(rune::TextStyle::new(14.0, 600.0))
                    .color(t.text)
                    .pt(10.0),
            )
            .child(
                row()
                    .gap(8.0)
                    .flex_wrap()
                    .child(
                        button("lap-fix-move", "Andere loper", st.dark, |_| {})
                            .on_press_tx(move |st: &mut State, tx| {
                                open_fix(st, FixKind::Move, &move_id);
                                tx.focus_when_shown("lap-picker-search", false);
                            })
                            .disabled(busy),
                    )
                    .child(
                        button("lap-fix-split", "Splitsen", st.dark, |_| {})
                            .on_press_tx(move |st: &mut State, tx| {
                                open_fix(st, FixKind::Split, &split_id);
                                tx.focus_when_shown("lap-picker-search", false);
                            })
                            .disabled(busy),
                    )
                    .child(
                        button("lap-fix-delete", "Verwijderen", st.dark, move |st| {
                            if st.busy {
                                return;
                            }
                            st.confirm = Some(Command {
                                screen: String::new(),
                                method: "laps.delete".into(),
                                input: json!({"lapId":delete_id}),
                            });
                            if let Some(lap) =
                                laps(st).into_iter().find(|l| s(l, "id") == delete_id)
                            {
                                st.laps.success = format!("{} is verwijderd.", lap_text(lap));
                            }
                            sync_hold(st);
                        })
                        .disabled(busy),
                    ),
            ),
    )
}

/// Moves one press with buttons of a second and a tenth: "Mitras −4, Wout +4". The buttons change
/// the lap before the press; the lap after it changes the other way.
fn press_editor(
    st: &State,
    before: &Value,
    after: Option<&Value>,
    running: Option<&Value>,
    hint: Option<Hint>,
) -> Option<El> {
    let t = tok::theme(st.dark);
    let next_name = after
        .map(|a| s(a, "runnerName").to_string())
        .or_else(|| running.map(|r| s(r, "name").to_string()))?;
    let next_text = after
        .map(lap_runner_text)
        .or_else(|| running.map(|r| runner_text(s(r, "runnerNumber"), s(r, "name"))))?;
    let shift = st.laps.shift_ms;
    let before_ms = n(before, "durationMs");
    let after_ms = after
        .map(|a| n(a, "durationMs"))
        .unwrap_or_else(|| st.laps.running_ms.unwrap_or(0));
    let allowed = |shift: i64| {
        shift.abs() <= MAX_HANDOFF_SHIFT_MS
            && before_ms + shift >= MIN_LAP_MS.min(before_ms)
            && after_ms - shift >= MIN_LAP_MS.min(after_ms)
    };
    let before_name = s(before, "runnerName").to_string();
    let finished = n(before, "finishedAt");
    let mut editor = col().gap(12.0).key("press-editor");
    editor = editor.child(label(
        if shift == 0 {
            format!("Wissel gedrukt om {}", clock_ms(finished))
        } else {
            format!(
                "Wissel gedrukt om {} → {}",
                clock_ms(finished),
                clock_ms(finished + shift)
            )
        },
        st.dark,
    ));
    let bar = |name: &str, detail: String, grow: i64, fill: rune::Color| {
        col()
            .gap(2.0)
            .grow(grow.max(1) as f32)
            .min_w(96.0)
            .px(8.0)
            .py(6.0)
            .radius(6.0)
            .fill(fill)
            .child(label(name, st.dark).min_w(0.0))
            .child(text(detail).font(type_::LABEL).color(t.text_secondary))
    };
    editor = editor.child(
        row()
            .gap(4.0)
            .min_w(0.0)
            .child(bar(
                &before_name,
                lap_duration(before_ms + shift),
                before_ms + shift,
                t.hover,
            ))
            .child(bar(
                &next_name,
                if after.is_some() {
                    lap_duration(after_ms - shift)
                } else {
                    "loopt nu".into()
                },
                (after_ms - shift).max(0),
                t.control_off,
            )),
    );
    if let Some(h) = hint
        && h.shift_ms != shift
    {
        editor = editor.child(
            col()
                .gap(8.0)
                .padding(10.0)
                .radius(6.0)
                .border(1.0, warn(st.dark))
                .child(
                    label(
                        format!(
                            "{before_name} loopt meestal {}, {next_name} meestal {}. Waarschijnlijk werd de spatie {} ingedrukt.",
                            tenths(h.usual_before_ms),
                            tenths(h.usual_after_ms),
                            shift_text(h.shift_ms, true)
                        ),
                        st.dark,
                    )
                    .wrap()
                    .min_w(0.0),
                )
                .child(small_button("press-hint".into(), format!("Wissel {}", shift_text(h.shift_ms, false)), st.dark, move |st| {
                    st.laps.shift_ms = h.shift_ms
                })),
        );
    }
    let mut nudges = row()
        .gap(6.0)
        .center_y()
        .role("group")
        .label(format!("Ronde van {before_name}"))
        .child(
            label(format!("Ronde van {before_name}"), st.dark)
                .grow(1.0)
                .min_w(0.0),
        );
    for step in NUDGES_MS {
        nudges = nudges.child(
            small_button(format!("nudge-{step}"), signed(step), st.dark, move |st| {
                st.laps.shift_ms += step
            })
            .disabled(!allowed(shift + step)),
        );
    }
    editor = editor.child(nudges);
    let result = |who: String, was: i64, now_ms: Option<i64>, delta: i64| {
        let mut line = row()
            .gap(10.0)
            .center_y()
            .child(label(who, st.dark).grow(1.0).min_w(0.0));
        match now_ms {
            Some(now_ms) => {
                if delta != 0 {
                    line = line.child(
                        text(lap_duration(was))
                            .font(type_::BODY)
                            .color(tok::muted(st.dark)),
                    );
                }
                line = line.child(
                    text(lap_duration(now_ms))
                        .font(rune::TextStyle::new(13.0, 600.0))
                        .color(t.text),
                );
            }
            None => {
                line = line.child(
                    text("loopt nu")
                        .font(rune::TextStyle::new(13.0, 600.0))
                        .color(t.text),
                )
            }
        }
        if delta != 0 {
            line = line.child(text(signed(delta)).font(type_::BODY).color(warn(st.dark)));
        }
        line
    };
    editor = editor
        .child(result(
            lap_runner_text(before),
            before_ms,
            Some(before_ms + shift),
            shift,
        ))
        .child(result(
            next_text.clone(),
            after_ms,
            after.map(|_| after_ms - shift),
            -shift,
        ));
    let lap_id = s(before, "id").to_string();
    let message = format!(
        "Wissel van {} naar {next_text} {} gezet.",
        lap_runner_text(before),
        shift_text(shift, false)
    );
    let busy = st.busy;
    editor = editor.child(
        row()
            .gap(8.0)
            .child(
                button("press-reset", "Terugzetten", st.dark, |st| {
                    st.laps.shift_ms = 0
                })
                .disabled(shift == 0),
            )
            .child(
                button("press-move", "Wissel verschuiven", st.dark, move |st| {
                    let shift = st.laps.shift_ms;
                    if shift == 0 || st.busy {
                        return;
                    }
                    st.laps.success = message.clone();
                    st.send(
                        "laps.moveHandoff",
                        json!({"lapId":lap_id,"from":finished,"to":finished+shift}),
                    );
                })
                .disabled(busy || shift == 0),
            ),
    );
    Some(editor)
}

fn open_fix(st: &mut State, kind: FixKind, lap_id: &str) {
    if st.busy {
        return;
    }
    let runner = laps(st)
        .into_iter()
        .find(|l| s(l, "id") == lap_id)
        .map(|l| s(l, "runnerId").to_string());
    st.laps.fix = Some(Fix {
        kind,
        lap_id: lap_id.into(),
        query: TextEdit::new(""),
        // A split lap is most often one runner who ran twice, so that runner starts selected.
        selected: if kind == FixKind::Split { runner } else { None },
    });
    sync_hold(st);
}
/// The runners of the laps just before and after this one: the usual mix-ups at a handoff.
fn nearby(all: &[&Value], lap_id: &str) -> Vec<String> {
    let Some(i) = all.iter().position(|l| s(l, "id") == lap_id) else {
        return Vec::new();
    };
    all[i.saturating_sub(3)..(i + 4).min(all.len())]
        .iter()
        .map(|l| s(l, "runnerId").to_string())
        .collect()
}
fn rank(suggestions: &[String], id: &str) -> usize {
    match suggestions.iter().position(|s| s == id) {
        Some(i) => i.abs_diff(suggestions.len() / 2),
        None => suggestions.len(),
    }
}
fn numeric_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    match (a.parse::<u64>(), b.parse::<u64>()) {
        (Ok(x), Ok(y)) => x.cmp(&y),
        _ => a.cmp(b),
    }
}
fn label_names(r: &Value) -> String {
    r["labels"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|l| l["name"].as_str())
        .collect::<Vec<_>>()
        .join(" ")
}
/// Runners matching the picker's search, the usual mix-ups first.
fn matches<'a>(st: &'a State, fix: &Fix, lap: &Value) -> Vec<&'a Value> {
    let suggestions = nearby(&laps(st), &fix.lap_id);
    let mut found: Vec<&Value> = runners(st)
        .into_iter()
        .filter(|r| fix.kind == FixKind::Split || r["id"] != lap["runnerId"])
        .filter(|r| {
            matches_search(
                s(r, "runnerNumber"),
                s(r, "name"),
                &label_names(r),
                &fix.query.text,
            )
        })
        .collect();
    found.sort_by(|a, b| {
        rank(&suggestions, s(a, "id"))
            .cmp(&rank(&suggestions, s(b, "id")))
            .then_with(|| numeric_cmp(s(a, "runnerNumber"), s(b, "runnerNumber")))
            .then_with(|| s(a, "name").cmp(s(b, "name")))
    });
    found
}
fn enter_runner<'a>(st: &'a State, fix: &Fix, lap: &Value) -> Option<&'a Value> {
    let found = matches(st, fix, lap);
    if !fix.query.text.trim().is_empty() && found.len() == 1 {
        return found.first().copied();
    }
    let selected = fix.selected.as_deref()?;
    runners(st).into_iter().find(|r| s(r, "id") == selected)
}
fn apply_fix(st: &mut State, runner_id: Option<String>) {
    let Some(fix) = st.laps.fix.take() else {
        return;
    };
    sync_hold(st);
    let Some(runner_id) = runner_id else {
        return;
    };
    let Some(lap) = laps(st)
        .into_iter()
        .find(|l| s(l, "id") == fix.lap_id)
        .cloned()
    else {
        return;
    };
    let name = runners(st)
        .into_iter()
        .find(|r| s(r, "id") == runner_id)
        .map(|r| runner_text(s(r, "runnerNumber"), s(r, "name")))
        .unwrap_or_default();
    let (method, message) = match fix.kind {
        FixKind::Move => (
            "laps.move",
            format!("{} staat nu op {name}.", lap_text(&lap)),
        ),
        FixKind::Split => (
            "laps.split",
            format!(
                "{} is gesplitst in twee rondes van {}.",
                lap_text(&lap),
                lap_duration(n(&lap, "durationMs") / 2)
            ),
        ),
    };
    st.laps.success = message;
    st.send(method, json!({"lapId":fix.lap_id,"runnerId":runner_id}));
}
fn submit_picker(st: &mut State) {
    let Some(fix) = &st.laps.fix else {
        return;
    };
    let Some(lap) = laps(st).into_iter().find(|l| s(l, "id") == fix.lap_id) else {
        return;
    };
    let id = enter_runner(st, fix, lap).map(|r| s(r, "id").to_string());
    if id.is_some() {
        apply_fix(st, id);
    }
}

/// Picks the runner a lap goes to, or who ran the second half of a split lap.
pub(super) fn modal(st: &State) -> Option<El> {
    let fix = st.laps.fix.as_ref()?;
    let lap = laps(st).into_iter().find(|l| s(l, "id") == fix.lap_id)?;
    let t = tok::theme(st.dark);
    let title = match fix.kind {
        FixKind::Move => "Ronde naar andere loper",
        FixKind::Split => "Ronde splitsen",
    };
    let explanation = match fix.kind {
        FixKind::Move => format!("{}. Wie liep deze ronde echt?", lap_text(lap)),
        FixKind::Split => format!(
            "{}. Er werd een wissel gemist: de ronde wordt twee rondes van {}. De eerste blijft bij {}. Wie liep de tweede?",
            lap_text(lap),
            lap_duration(n(lap, "durationMs") / 2),
            lap_runner_text(lap)
        ),
    };
    let mut dialog = col()
        .key("lap-picker")
        .role("dialog")
        .label(title)
        .w_full()
        .max_w(560.0)
        .min_w(0.0)
        .radius(10.0)
        .gap(12.0)
        .padding(20.0)
        .fill(t.card)
        .child(
            row()
                .center_y()
                .child(heading(title, st.dark).grow(1.0))
                .child(
                    button("lap-picker-close", "✕", st.dark, |st| apply_fix(st, None))
                        .label("Sluiten")
                        .size(30.0, 30.0)
                        .px(0.0)
                        .py(0.0)
                        .center(),
                ),
        )
        .child(label(explanation, st.dark).wrap().min_w(0.0))
        .child(
            text_input(&fix.query, type_::BODY)
                .key("lap-picker-search")
                .label("Loper zoeken")
                .placeholder("Zoek op nummer of naam", tok::muted(st.dark))
                .h(36.0)
                .px(12.0)
                .fill(t.card)
                .color(t.text)
                .border(1.0, t.card_border)
                .radius(6.0)
                .on_edit(|st: &mut State| &mut st.laps.fix.as_mut().expect("open lap picker").query)
                .on_submit(|st: &mut State, _| submit_picker(st)),
        );
    if let Some(r) = enter_runner(st, fix, lap) {
        let who = runner_text(s(r, "runnerNumber"), s(r, "name"));
        dialog = dialog.child(
            text(match fix.kind {
                FixKind::Move => format!("Enter: ronde naar {who}."),
                FixKind::Split => format!("Enter: tweede helft naar {who}."),
            })
            .font(type_::LABEL)
            .color(t.text_secondary),
        );
    }
    let mut options = col().gap(4.0).role("radiogroup").label("Loper");
    let found = matches(st, fix, lap);
    for r in found.iter().take(PICKER_SIZE) {
        let id = s(r, "id").to_string();
        let on = fix.selected.as_deref() == Some(id.as_str());
        let chosen = id.clone();
        let mut option = row()
            .key(format!("lap-pick-{id}"))
            .role("radio")
            .label(runner_text(s(r, "runnerNumber"), s(r, "name")))
            .checked(on)
            .focusable(true)
            .gap(10.0)
            .px(10.0)
            .py(8.0)
            .radius(6.0)
            .center_y()
            .fill(if on { t.hover } else { t.card })
            .hover(t.hover)
            .on_press(move |st: &mut State| {
                if let Some(fix) = st.laps.fix.as_mut() {
                    fix.selected = Some(chosen.clone());
                }
            })
            .child(label(if on { "●" } else { "○" }, st.dark))
            .child(
                text(s(r, "runnerNumber").to_string())
                    .font(type_::BODY)
                    .color(tok::muted(st.dark))
                    .w(36.0),
            )
            .child(label(s(r, "name"), st.dark).grow(1.0).min_w(0.0));
        if r["id"] == lap["runnerId"] {
            option = option.child(
                text("dezelfde loper, twee keer")
                    .font(type_::LABEL)
                    .color(t.text_secondary),
            );
        }
        options = options.child(option);
    }
    if found.is_empty() {
        options = options.child(label("Geen loper gevonden.", st.dark));
    }
    let can_apply = fix.selected.is_some() && !st.busy;
    dialog = dialog.child(options).child(
        row()
            .gap(10.0)
            .child(button("lap-picker-cancel", "Annuleer", st.dark, |st| {
                apply_fix(st, None)
            }))
            .child(
                button(
                    "lap-picker-apply",
                    match fix.kind {
                        FixKind::Move => "Verplaatsen",
                        FixKind::Split => "Splitsen",
                    },
                    st.dark,
                    |st| {
                        let id = st.laps.fix.as_ref().and_then(|f| f.selected.clone());
                        if id.is_some() {
                            apply_fix(st, id);
                        }
                    },
                )
                .disabled(!can_apply),
            ),
    );
    Some(
        rune::el()
            .key("lap-picker-overlay")
            .absolute(0.0, 0.0)
            .w_full()
            .h_full()
            .padding(24.0)
            .center()
            .fill(rune::oklcha(0.21, 0.006, 285.9, 0.4))
            .modal(false, |st: &mut State| apply_fix(st, None))
            .child(dialog),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn lap(id: &str, runner: &str, start: i64, ms: i64) -> Value {
        json!({"id":id,"runnerId":runner,"startedAt":start,"finishedAt":start+ms,"durationMs":ms,"source":"spacebar"})
    }
    #[test]
    fn a_late_press_is_found_by_both_runners_usual_laps_and_short_laps_are_flagged() {
        // A runs 80 s and B 70 s; the third press came 4 s late: A 84 s, B 66 s.
        let mut all = Vec::new();
        let mut t = 0;
        for (i, (runner, ms)) in [
            ("a", 80_000),
            ("b", 70_000),
            ("a", 80_000),
            ("b", 70_000),
            ("a", 84_000),
            ("b", 66_000),
            ("a", 80_000),
            ("b", 70_000),
        ]
        .into_iter()
        .enumerate()
        {
            all.push(lap(&format!("l{i}"), runner, t, ms));
            t += ms;
        }
        all.push(lap("tiny", "a", t, 5_000));
        let refs: Vec<&Value> = all.iter().collect();
        let hints = review_handoffs(&refs);
        assert_eq!(hints.len(), 1, "{hints:?}");
        assert_eq!(
            hints["l4"],
            Hint {
                shift_ms: -4_000,
                usual_before_ms: 80_000,
                usual_after_ms: 70_000
            }
        );
        let (median, flags) = review_laps(&refs);
        assert_eq!(median, Some(70_000));
        assert_eq!(flags.get("tiny"), Some(&Flag::Short));
        assert_eq!(flags.len(), 1);
    }
    #[test]
    fn dutch_seconds_and_shift_wording_match_the_reference() {
        assert_eq!(seconds(4_000, 3), "4 s");
        assert_eq!(seconds(-100, 3), "0,1 s");
        assert_eq!(seconds(1_250, 3), "1,25 s");
        assert_eq!(seconds(3_460, 1), "3,5 s");
        assert_eq!(signed(-1_000), "−1 s");
        assert_eq!(shift_text(-4_000, true), "4 s te laat");
        assert_eq!(shift_text(4_000, false), "4 s later");
        assert_eq!(tenths(79_440), "1:19.4");
        assert!(matches_search("12", "Zoë Peeters", "", "zoe"));
    }
}
#[cfg(test)]
impl State {
    pub(super) fn laps_shift(&self) -> i64 {
        self.laps.shift_ms
    }
}
