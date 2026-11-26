//! Wachtrij: who is on the track and next, the two lanes (Opwarming, Klaar om te lopen) with drag
//! and drop, Heeft gelopen, and the header's Filter bord, Nieuwe loper and Loper zoeken. Port of
//! src/components/QueuePage.tsx, KanbanBoard.tsx, QueueActions.tsx, RunnerEntryModals.tsx and
//! src/styles/queue.css; sizes are the reference's at 1366×768.
use super::*;
use std::cell::RefCell;
use std::collections::HashMap;
mod tick_cache;
#[cfg(test)]
mod tick_cache_tests;

/// Warming up this long is worth a glance; it never blocks anything.
const LONG_WARM_UP_MS: i64 = 10 * 60_000;
const SEARCH_PAGE: usize = 40;
const TOAST_MS: i64 = 4_000;

pub(super) fn clocks(s: &State, clock: &mut clock::Sample) {
    clock.value(brussels_moment(s.clock));
    let board = board_data(s);
    for r in board.waiting.iter().chain(&board.warming) {
        if tick_cache::clock_visible(s, r) {
            if let Some(at) = r["statusSince"].as_i64() { clock.bucket(at, 1000); }
        }
    }
    if let Some((_, at)) = &s.queue_page.toast { clock.until(*at + TOAST_MS); }
}
const DRAG_START: f32 = 6.0;

#[derive(Default)]
pub(super) struct Search {
    query: TextEdit,
    keep_open: bool,
    show_all: bool,
}
#[derive(Default)]
pub(super) struct Add {
    number: TextEdit,
    name: TextEdit,
    phone: TextEdit,
    email: TextEdit,
    hours: Vec<String>,
    avg_min: TextEdit,
    avg_sec: TextEdit,
    best_min: TextEdit,
    best_sec: TextEdit,
    notes: TextEdit,
    labels: Vec<String>,
    contact_open: bool,
    extra_open: bool,
    error: String,
    confirm_close: bool,
    /// Opened from Beheer › Lopers: the runner is only registered, not sent to warm up.
    registered: bool,
    /// What a drag over the hour grid paints (the opposite of the slot it started on).
    paint: Option<bool>,
    /// The pointer already toggled the slot on Down, so its press must not toggle it back.
    painted: bool,
}
pub(super) enum Dialog {
    Search(Search),
    Add(Box<Add>),
    /// Bellen: a QR code with the `tel:` link (CallQrDialog.tsx); name and phone as shown.
    Call(String, String),
}
/// What a sent action does once the server took it.
enum Pending {
    CheckIn {
        id: String,
        name: String,
        keep_open: bool,
    },
    Added {
        name: String,
    },
    Board,
}
#[derive(Clone, PartialEq, Debug)]
enum Drop {
    Lane(&'static str),
    Before(String),
    After(String),
}
struct DragState {
    id: String,
    active: bool,
    at: [f32; 2],
    grab: [f32; 2],
    over: Option<Drop>,
}
pub(super) struct Page {
    pub(super) filter: TextEdit,
    pub(super) dialog: Option<Dialog>,
    ran_open: bool,
    show_hidden: bool,
    pending: Option<Pending>,
    toast: Option<(String, i64)>,
    error: String,
    drag: Option<DragState>,
    rects: HashMap<String, [f32; 4]>,
    window_h: f32,
    registrations: Value,
    regs_revision: Option<i64>,
    regs_pending: bool,
    available_open: bool,
    available_search: TextEdit,
    /// Clicks made while an earlier one is on its way go out in click order, so the board never locks.
    queued: std::collections::VecDeque<(String, Value, Pending)>,
    board_cache: RefCell<tick_cache::BoardCache>,
}
impl Default for Page {
    fn default() -> Self {
        Self {
            filter: TextEdit::new(""),
            dialog: None,
            ran_open: false,
            show_hidden: false,
            pending: None,
            toast: None,
            error: String::new(),
            drag: None,
            rects: HashMap::new(),
            window_h: 768.0,
            registrations: Value::Null,
            regs_revision: None,
            regs_pending: false,
            available_open: true,
            available_search: TextEdit::new(""),
            queued: Default::default(),
            board_cache: RefCell::default(),
        }
    }
}

struct Pal {
    brand: rune::Color,
    brand_hover: rune::Color,
    brand_ink: rune::Color,
    brand_wash: rune::Color,
    on_brand: rune::Color,
    surface: rune::Color,
    line: rune::Color,
    ink: rune::Color,
    t: tok::Tones,
}
fn pal(dark: bool) -> Pal {
    use rune::oklch;
    let th = tok::theme(dark);
    Pal {
        brand: oklch(0.57, 0.2, 264.0),
        brand_hover: if dark {
            oklch(0.61, 0.2, 264.0)
        } else {
            oklch(0.52, 0.2, 264.0)
        },
        brand_ink: if dark {
            oklch(0.72, 0.14, 262.0)
        } else {
            oklch(0.5, 0.19, 264.0)
        },
        brand_wash: if dark {
            oklch(0.263, 0.036, 250.9)
        } else {
            oklch(0.963, 0.015, 248.0)
        },
        on_brand: oklch(1.0, 0.0, 0.0),
        surface: th.card,
        line: th.card_border,
        ink: th.text,
        t: tok::tones(dark),
    }
}

fn st<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn fold(text: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    text.nfd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .collect::<String>()
        .to_lowercase()
}
fn label_names(r: &Value) -> String {
    r["labels"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|l| st(l, "name"))
        .collect::<Vec<_>>()
        .join(" ")
}
/// Number, name and labels together, so "149 bram" finds Bram with 149.
fn matches(r: &Value, query: &str) -> bool {
    let q = fold(query.trim());
    q.is_empty()
        || fold(&format!(
            "{} {} {}",
            st(r, "runnerNumber"),
            st(r, "name"),
            label_names(r)
        ))
        .contains(&q)
}
fn number_value(r: &Value) -> i64 {
    st(r, "runnerNumber")
        .trim()
        .parse::<i64>()
        .unwrap_or(i64::MAX)
}
fn since(r: &Value) -> i64 {
    r["statusSince"].as_i64().unwrap_or(i64::MAX)
}
fn waiting_order(a: &Value, b: &Value) -> std::cmp::Ordering {
    a["queueIndex"]
        .as_i64()
        .unwrap_or(i64::MAX)
        .cmp(&b["queueIndex"].as_i64().unwrap_or(i64::MAX))
        .then(since(a).cmp(&since(b)))
        .then(number_value(a).cmp(&number_value(b)))
}
/// The whole queue in its server order, whatever the filter shows.
fn waiting(s: &State) -> Vec<&Value> {
    let mut list: Vec<&Value> = runners(s)
        .into_iter()
        .filter(|r| r["status"] == "waiting")
        .collect();
    list.sort_by(|a, b| waiting_order(a, b));
    list
}
fn status_label(r: &Value) -> &'static str {
    if r["hiddenFromQueue"] == true {
        return "Verborgen";
    }
    match st(r, "status") {
        "registered" => "Ingeschreven",
        "warming_up" => "Aan het opwarmen",
        "waiting" => "In de wachtrij",
        "running" => "Op de piste",
        "ran" => "Heeft gelopen",
        _ => "",
    }
}
fn can_move(from: &str, to: &str) -> bool {
    matches!(
        (from, to),
        ("registered", "warming_up" | "waiting")
            | ("warming_up", "registered" | "waiting")
            | ("waiting", "registered" | "warming_up")
            | ("ran", "warming_up" | "waiting")
    )
}
fn next_lane(status: &str) -> Option<&'static str> {
    let to = if status == "warming_up" {
        "waiting"
    } else {
        "warming_up"
    };
    can_move(status, to).then_some(to)
}
fn can_check_in(status: &str) -> bool {
    status == "registered" || status == "ran"
}
fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

// ---------- Icons (src/components/Icon.tsx), in any colour ----------

thread_local! {
    static ICONS: RefCell<HashMap<(&'static str, String, u32), rune::Image>> = RefCell::new(HashMap::new());
}
fn icon(s: &State, name: &'static str, color: rune::Color, size: f32, stroke: f32) -> El {
    let el = rune::el().size(size, size);
    let Some(cache) = &s.image_cache else {
        return el;
    };
    let body = match name {
        "search" => r#"<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>"#,
        "timing" => r#"<path d="M10 2h4M12 14l3-3"/><circle cx="12" cy="14" r="8"/>"#,
        "close" => r#"<path d="M18 6 6 18M6 6l12 12"/>"#,
        "check" => r#"<path d="M20 6 9 17l-5-5"/>"#,
        "chevronRight" => r#"<path d="M9 5.5l6.5 6.5-6.5 6.5"/>"#,
        "chevronDown" => r#"<path d="M5.5 9l6.5 6.5 6.5-6.5"/>"#,
        _ => "",
    };
    let hex = color.hex();
    let key = (name, hex.clone(), (stroke * 100.0) as u32);
    let image = ICONS.with(|icons| {
        icons
            .borrow_mut()
            .entry(key)
            .or_insert_with(|| {
                let svg = format!(
                    r#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="{hex}" stroke-width="{stroke}" stroke-linecap="round" stroke-linejoin="round">{body}</svg>"#
                );
                cache.svg(svg.into_bytes(), size, 2.0)
            })
            .clone()
    });
    el.pixels(image.pixels())
}

// ---------- Primitives (src/styles/primitives.css) ----------

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Plain,
    Primary,
    Ghost,
    Quiet,
}
/// `.btn`: 34 high (28 for `.btn--sm`), 13.5px medium label (13px small).
fn btn(s: &State, key: impl Into<String>, label: &str, kind: Kind, sm: bool) -> El {
    let p = pal(s.dark);
    let (fill, line, ink, hover) = match kind {
        Kind::Plain => (p.surface, p.t.line2, p.ink, p.t.surface2),
        Kind::Primary => (p.brand, p.brand, p.on_brand, p.brand_hover),
        Kind::Ghost => (rune::Color::TRANSPARENT, p.t.line2, p.ink, p.t.surface2),
        Kind::Quiet => (
            rune::Color::TRANSPARENT,
            rune::Color::TRANSPARENT,
            p.t.ink2,
            p.t.surface3,
        ),
    };
    let mut b = row()
        .key(key.into())
        .role("button")
        .label(label.to_string())
        .focusable(true)
        .press_on_return()
        .h(if sm { 28.0 } else { 34.0 })
        .px(if sm { 10.0 } else { 12.0 })
        .center()
        .radius(6.0)
        .fill(fill)
        .border(1.0, line)
        .hover(hover)
        .child(
            text(label.to_string())
                .font(rune::TextStyle::new(if sm { 13.0 } else { 13.5 }, 500.0))
                .color(ink),
        );
    if kind == Kind::Plain && !s.dark {
        b = b.shadow(1.0, 2.0, rune::oklcha(0.21, 0.006, 285.9, 0.05));
    }
    b
}
/// `.btn:disabled`.
fn btn_off(s: &State, key: impl Into<String>, label: &str) -> El {
    let p = pal(s.dark);
    row()
        .key(key.into())
        .role("button")
        .label(label.to_string())
        .disabled(true)
        .h(34.0)
        .px(12.0)
        .center()
        .radius(6.0)
        .fill(p.t.surface2)
        .border(1.0, p.line)
        .child(
            text(label.to_string())
                .font(rune::TextStyle::new(13.5, 500.0))
                .color(p.t.ink3),
        )
}
/// A 16px checkbox in the brand colour, as `accent-color` draws one.
fn checkbox(s: &State, on: bool) -> El {
    let p = pal(s.dark);
    let b = rune::el().size(16.0, 16.0).radius(3.0).center();
    if on {
        b.fill(p.brand)
            .child(icon(s, "check", p.on_brand, 12.0, 3.0))
    } else {
        b.fill(p.surface).border(
            1.0,
            if s.dark {
                p.t.ink3
            } else {
                rune::color::hex("#767676").unwrap()
            },
        )
    }
}
/// `.toggle-row`: a checkbox and its label, 30 high.
fn toggle_row(s: &State, key: &str, title: &str, on: bool, f: impl Fn(&mut State) + 'static) -> El {
    row()
        .key(key.to_string())
        .role("checkbox")
        .label(title.to_string())
        .checked(on)
        .focusable(true)
        .press_on_return()
        .min_h(30.0)
        .gap(11.0)
        .pl(4.0)
        .center_y()
        .on_press(f)
        .child(checkbox(s, on))
        .child(
            text(title.to_string())
                .font(rune::TextStyle::new(13.5, 400.0).lh(20.0))
                .color(pal(s.dark).ink),
        )
}
/// `.input`: 34 high, 1px line-2 border, brand ring while focused.
fn field(s: &State, edit: &TextEdit, key: &str, title: &str, placeholder: &str) -> El {
    let p = pal(s.dark);
    text_input(edit, rune::TextStyle::new(13.5, 400.0).lh(18.0))
        .single_line()
        .key(key.to_string())
        .label(title.to_string())
        .placeholder(placeholder.to_string(), p.t.ink3)
        .h(34.0)
        .py(8.0)
        .px(10.0)
        .w_full()
        .min_w(0.0)
        .radius(6.0)
        .fill(p.surface)
        .color(p.ink)
        .border(1.0, p.t.line2)
        .focus_within_ring(3.0, 0.0, p.brand.alpha(0.22))
}
/// `.label-pill.label-pill--compact`: 18 high, logo or dot, 11.5px name.
fn pill(s: &State, l: &Value) -> El {
    let p = pal(s.dark);
    let mut b = row()
        .h(18.0)
        .gap(5.0)
        .pl(5.0)
        .pr(6.0)
        .center_y()
        .radius(4.0)
        .fill(p.surface)
        .border(1.0, p.line);
    if let Some(image) = l["imageUrl"].as_str().and_then(|url| s.logos.get(url)) {
        b = b.child(
            rune::el()
                .size(14.0, 14.0)
                .pixels_fit(image.pixels(), rune::SurfaceFit::Fit),
        );
    } else {
        let color = rune::color::hex(st(l, "color")).unwrap_or(p.t.ink3);
        b = b.child(rune::el().size(7.0, 7.0).radius(3.5).fill(color));
    }
    b.child(
        text(st(l, "name").to_string())
            .font(rune::TextStyle::new(11.5, 500.0))
            .color(p.t.ink2),
    )
}
const BIB_WIDTH_EM: f32 = 2.6;
const BIB_NAME_GAP: f32 = 8.0;

/// How far the name sits right of the bib, so a line under it starts under the name.
fn name_indent(r: &Value, size: f32) -> f32 {
    if st(r, "runnerNumber").is_empty() {
        0.0
    } else {
        size * BIB_WIDTH_EM + BIB_NAME_GAP
    }
}
/// `RunnerName`: the muted bib and the name.
fn runner_name(s: &State, r: &Value, size: f32, weight: f32) -> El {
    let p = pal(s.dark);
    let mut line = row().gap(BIB_NAME_GAP).min_w(0.0).center_y();
    let number = st(r, "runnerNumber");
    if !number.is_empty() {
        line = line.child(
            text(number.to_string())
                .font(rune::TextStyle::new(size, 500.0).features("'tnum' 1"))
                .color(p.t.ink3)
                .min_w(size * BIB_WIDTH_EM),
        );
    }
    line.child(
        text(st(r, "name").to_string())
            .font(rune::TextStyle::new(size, weight))
            .color(p.ink)
            .min_w(0.0)
            .truncate(),
    )
}
/// `.disclosure`: the chevron that turns when the section opens.
fn chevron(s: &State, open: bool) -> El {
    let p = pal(s.dark);
    rune::el().w(12.0).center().child(icon(
        s,
        if open { "chevronDown" } else { "chevronRight" },
        p.t.ink3,
        16.0,
        2.25,
    ))
}

// ---------- Header actions (QueueActions.tsx) ----------

pub(super) fn header_actions(s: &State) -> Vec<El> {
    let p = pal(s.dark);
    let filtering = !s.queue_page.filter.text.is_empty();
    let mut search = row()
        .key("board-search")
        .w(220.0)
        .h(34.0)
        .pl(10.0)
        .pr(4.0)
        .gap(6.0)
        .center_y()
        .radius(6.0)
        .fill(if filtering { p.brand_wash } else { p.surface })
        .border(1.0, if filtering { p.brand } else { p.t.line2 })
        .focus_within_ring(3.0, 0.0, p.brand.alpha(0.22))
        .child(icon(s, "search", p.t.ink3, 15.0, 1.75))
        .child(
            text_input(
                &s.queue_page.filter,
                rune::TextStyle::new(13.5, 400.0).lh(18.0),
            )
            .single_line()
            .key("board-filter")
            .label("Filter dit bord")
            .role("searchbox")
            .placeholder("Filter bord", p.t.ink3)
            .grow(1.0)
            .min_w(0.0)
            .py(8.0)
            .color(p.ink)
            .no_focus_ring()
            .on_edit(|s: &mut State| &mut s.queue_page.filter),
        );
    if filtering {
        search = search.child(
            row()
                .key("board-filter-clear")
                .role("button")
                .label("Filter wissen")
                .focusable(true)
                .press_on_return()
                .size(24.0, 24.0)
                .center()
                .radius(4.0)
                .hover(p.t.surface3)
                .on_press_tx(|s: &mut State, tx: &mut Tx| {
                    s.queue_page.filter = TextEdit::new("");
                    tx.focus_when_shown("board-filter", false);
                })
                .child(icon(s, "close", p.t.ink2, 14.0, 1.75)),
        );
    }
    vec![
        search,
        btn(s, "queue-add", "Nieuwe loper", Kind::Plain, false)
            .min_w(110.0)
            .on_press_tx(|s: &mut State, tx: &mut Tx| {
                s.queue_page.dialog = Some(Dialog::Add(Box::default()));
                tx.focus_when_shown("add-number", false);
            }),
        btn(s, "queue-search", "Loper zoeken", Kind::Primary, false)
            .min_w(112.0)
            .on_press_tx(|s: &mut State, tx: &mut Tx| {
                s.queue_page.dialog = Some(Dialog::Search(Search::default()));
                tx.focus_when_shown("search-query", false);
            }),
    ]
}

// ---------- The page ----------

pub(super) fn page(s: &State) -> El {
    col()
        .key("queue-page")
        .pb(24.0)
        .child(board(s))
        .child(rune::memo("available-now", tick_cache::available_version(s), || available_now(s)).mt(12.0))
}

// ---------- Nu beschikbaar, nog niet opgeroepen (AvailableNowPanel.tsx, lib/availability.ts) ----------

const WEEKDAYS: [&str; 7] = [
    "maandag",
    "dinsdag",
    "woensdag",
    "donderdag",
    "vrijdag",
    "zaterdag",
    "zondag",
];

/// The hour and Dutch weekday on the Brussels wall clock.
fn brussels_moment(ms: i64) -> (u32, &'static str) {
    use chrono::{Datelike, Timelike};
    let d = chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .with_timezone(&chrono_tz::Europe::Brussels);
    (
        d.hour(),
        WEEKDAYS[d.weekday().num_days_from_monday() as usize],
    )
}
/// `20-21u (dinsdag)`, `23-00u`: start, end and weekday of a registration hour block.
fn parse_block(text: &str) -> Option<(u32, u32, Option<String>)> {
    let t = text.trim();
    let (hours, day) = match t.find('(') {
        Some(i) => {
            let rest = t[i + 1..].trim();
            let day = rest.strip_suffix(')')?.trim().to_lowercase();
            (t[..i].trim(), (!day.is_empty()).then_some(day))
        }
        None => (t, None),
    };
    let hours = hours.trim_end_matches(['u', 'U']).trim();
    let (a, b) = hours.split_once(['-', '–'])?;
    let start: u32 = a.trim().trim_end_matches(['u', 'U']).trim().parse().ok()?;
    let end: u32 = b.trim().trim_end_matches(['u', 'U']).trim().parse().ok()?;
    if start > 23 || end > 24 || start == end || a.trim().len() > 3 || b.trim().len() > 3 {
        return None;
    }
    Some((start, if end == 24 { 0 } else { end }, day))
}
fn covers(text: &str, hour: u32, weekday: &str) -> bool {
    let Some((start, end, day)) = parse_block(text) else {
        return false;
    };
    if day.is_some_and(|d| d != weekday) {
        return false;
    }
    if end <= start {
        hour >= start || hour < end
    } else {
        hour >= start && hour < end
    }
}
fn available_runners<'a>(
    s: &'a State,
    hour: u32,
    weekday: &str,
) -> Vec<(&'a Value, String, String)> {
    let regs = &s.queue_page.registrations;
    let mut list: Vec<(&Value, String, String)> = runners(s)
        .into_iter()
        .filter(|r| {
            r["hiddenFromQueue"] != true && (r["status"] == "registered" || r["status"] == "ran")
        })
        .filter_map(|r| {
            let reg = &regs[st(r, "id")];
            let hours = reg["availableHours"].as_array()?;
            hours
                .iter()
                .any(|h| covers(h.as_str().unwrap_or(""), hour, weekday))
                .then(|| {
                    (
                        r,
                        st(reg, "phone").trim().to_string(),
                        st(reg, "flexibility").trim().to_string(),
                    )
                })
        })
        .collect();
    list.sort_by(|(a, _, _), (b, _, _)| {
        (a["status"] == "ran")
            .cmp(&(b["status"] == "ran"))
            .then_with(|| match (st(a, "runnerNumber"), st(b, "runnerNumber")) {
                ("", "") => std::cmp::Ordering::Equal,
                ("", _) => std::cmp::Ordering::Greater,
                (_, "") => std::cmp::Ordering::Less,
                (x, y) => match (x.parse::<i64>(), y.parse::<i64>()) {
                    (Ok(m), Ok(n)) => m.cmp(&n),
                    _ => x.cmp(y),
                },
            })
            .then_with(|| st(a, "name").cmp(st(b, "name")))
    });
    list
}
fn phone_link(phone: &str) -> bool {
    let t = phone.trim();
    !t.is_empty()
        && t.chars()
            .enumerate()
            .all(|(i, c)| c.is_ascii_digit() || " ().-/".contains(c) || (c == '+' && i == 0))
        && t.chars().filter(char::is_ascii_digit).count() >= 6
}
fn available_now(s: &State) -> El {
    let p = pal(s.dark);
    let (hour, weekday) = brussels_moment(s.clock);
    let available = available_runners(s, hour, weekday);
    let q = fold(s.queue_page.available_search.text.trim());
    let compact = |v: &str| v.chars().filter(|c| !c.is_whitespace()).collect::<String>();
    let shown: Vec<&(&Value, String, String)> = available
        .iter()
        .filter(|(r, phone, _)| {
            q.is_empty()
                || fold(st(r, "name")).contains(&q)
                || fold(st(r, "runnerNumber")).contains(&q)
                || compact(phone).contains(&compact(&q))
        })
        .collect();
    let moment = format!("{:02}-{:02}u ({weekday})", hour, (hour + 1) % 24);
    let open = s.queue_page.available_open;
    let mut panel = col()
        .key("available-now")
        .role("group")
        .radius(8.0)
        .fill(p.surface)
        .border(1.0, p.line)
        .padding(1.0)
        .child(
            row()
                .key("available-now-toggle")
                .role("button")
                .label(format!(
                    "Nu beschikbaar, nog niet opgeroepen {} {moment}",
                    available.len()
                ))
                .checked(open)
                .focusable(true)
                .press_on_return()
                .min_h(40.0)
                .px(16.0)
                .gap(8.0)
                .center_y()
                .on_press(|s: &mut State| {
                    s.queue_page.available_open = !s.queue_page.available_open
                })
                .child(chevron(s, open))
                .child(
                    text("Nu beschikbaar, nog niet opgeroepen")
                        .font(rune::TextStyle::new(13.5, 550.0))
                        .color(p.ink),
                )
                .child(
                    text(available.len().to_string())
                        .font(rune::TextStyle::new(13.5, 400.0))
                        .color(p.t.ink3),
                )
                .child(col().grow(1.0))
                .child(
                    text(moment)
                        .font(rune::TextStyle::new(12.5, 400.0).features("'tnum' 1"))
                        .color(p.t.ink3),
                ),
        );
    if !open {
        return panel;
    }
    let search = row()
        .w(220.0)
        .h(34.0)
        .pl(10.0)
        .pr(4.0)
        .gap(6.0)
        .center_y()
        .radius(6.0)
        .fill(p.surface)
        .border(1.0, p.t.line2)
        .focus_within_ring(3.0, 0.0, p.brand.alpha(0.22))
        .child(icon(s, "search", p.t.ink3, 14.0, 1.75))
        .child(
            text_input(
                &s.queue_page.available_search,
                rune::TextStyle::new(13.5, 400.0).lh(18.0),
            )
            .single_line()
            .key("available-search")
            .label("Beschikbare lopers filteren")
            .role("searchbox")
            .placeholder("Naam, nummer of telefoon", p.t.ink3)
            .grow(1.0)
            .min_w(0.0)
            .py(8.0)
            .color(p.ink)
            .no_focus_ring()
            .on_edit(|s: &mut State| &mut s.queue_page.available_search),
        );
    panel = panel.child(
        row()
            .px(16.0)
            .pb(12.0)
            .gap(16.0)
            .center_y()
            .child(
                text("Volgens hun inschrijving kunnen deze lopers dit uur lopen, maar ze staan niet aan het opwarmen of in de wachtrij. Klik op een naam voor het profiel.")
                    .font(rune::TextStyle::new(12.5, 400.0).lh(18.75))
                    .color(p.t.ink3)
                    .wrap()
                    .grow(1.0)
                    .min_w(0.0),
            )
            .child(search),
    );
    let mut rows = col();
    let count = shown.len();
    for (i, (r, phone, flexibility)) in shown.into_iter().enumerate() {
        let id = st(r, "id").to_string();
        let mut details = row()
            .gap(8.0)
            .center_y()
            .min_h(18.0)
            .pl(name_indent(r, 14.0))
            .flex_wrap();
        for l in r["labels"].as_array().into_iter().flatten() {
            details = details.child(pill(s, l));
        }
        let small = rune::TextStyle::new(12.0, 400.0).lh(18.0);
        let laps = r["lapCount"].as_i64().unwrap_or(0);
        details = details.child(
            text(if r["status"] == "ran" {
                format!("{laps} gelopen")
            } else {
                "nog niet gelopen".into()
            })
            .font(small)
            .color(p.t.ink3),
        );
        if !flexibility.is_empty() {
            details = details.child(text(flexibility.clone()).font(small).color(p.t.ink3));
        }
        let profile_id = id.clone();
        let phone_el = if phone_link(phone) {
            {
                let label = runner_label(r);
                let number = phone.clone();
                btn(s, format!("available-phone-{id}"), phone, Kind::Plain, true).on_press(
                    move |s: &mut State| {
                        s.queue_page.dialog = Some(Dialog::Call(label.clone(), number.clone()))
                    },
                )
            }
        } else {
            text(if phone.is_empty() {
                "Geen nummer".to_string()
            } else {
                phone.clone()
            })
            .font(rune::TextStyle::new(12.5, 400.0))
            .color(p.t.ink3)
        };
        let mut line = row()
            .key(format!("available-row-{id}"))
            .min_h(53.0)
            .pt(6.0)
            .pb(7.0)
            .pl(12.0)
            .pr(16.0)
            .gap(10.0)
            .center_y()
            .hover(p.t.surface2)
            .child(
                col()
                    .key(format!("available-identity-{id}"))
                    .role("button")
                    .label(format!("{}: profiel openen", st(r, "name")))
                    .focusable(true)
                    .press_on_return()
                    .grow(1.0)
                    .min_w(0.0)
                    .py(2.0)
                    .gap(3.0)
                    .on_press(move |s: &mut State| {
                        s.send("runners.profile", json!({"id":profile_id}))
                    })
                    .child(
                        row()
                            .h(21.0)
                            .center_y()
                            .child(runner_name(s, r, 14.0, 550.0)),
                    )
                    .child(details),
            )
            .child(phone_el);
        if i + 1 < count {
            line = line.border_sides([0.0, 0.0, 1.0, 0.0], p.line);
        }
        rows = rows.child(line);
    }
    if count == 0 {
        rows = rows.child(empty(
            s,
            if s.queue_page
                .registrations
                .as_object()
                .is_none_or(|m| m.is_empty())
            {
                "Geen inschrijvingsuren bekend. Importeer de inschrijvingen in Beheer."
            } else if !q.is_empty() {
                "Geen beschikbare lopers voor dit filter."
            } else {
                "Iedereen die dit uur beschikbaar is, staat al klaar of heeft al gelopen."
            },
        ));
    }
    panel.child(
        col()
            .key("available-rows")
            .max_h(320.0)
            .scroll(ScrollSpec {
                stick_bottom: false,
            })
            .border_sides([1.0, 0.0, 0.0, 0.0], p.line)
            .child(rows),
    )
}

struct Board<'a> {
    filtered: Vec<&'a Value>,
    warming: Vec<&'a Value>,
    waiting: Vec<&'a Value>,
    ran: Vec<&'a Value>,
    positions: std::rc::Rc<HashMap<String, usize>>,
}
fn board_data(s: &State) -> Board<'_> {
    s.queue_page.board_cache.borrow_mut().get(s)
}
fn board_data_uncached(s: &State) -> Board<'_> {
    let q = s.queue_page.filter.text.trim().to_string();
    let filtered: Vec<&Value> = runners(s)
        .into_iter()
        .filter(|r| {
            let status = st(r, "status");
            if status == "registered" || status == "running" {
                return false;
            }
            if r["hiddenFromQueue"] == true && !(s.queue_page.show_hidden && status == "ran") {
                return false;
            }
            matches(r, &q)
        })
        .collect();
    let mut warming: Vec<&Value> = filtered
        .iter()
        .copied()
        .filter(|r| r["status"] == "warming_up")
        .collect();
    warming.sort_by(|a, b| {
        since(a)
            .cmp(&since(b))
            .then(number_value(a).cmp(&number_value(b)))
    });
    let all_waiting = waiting(s);
    let positions: HashMap<String, usize> = all_waiting
        .iter()
        .enumerate()
        .map(|(i, r)| (st(r, "id").to_string(), i))
        .collect();
    let waiting_rows = all_waiting
        .into_iter()
        .filter(|r| filtered.iter().any(|f| f["id"] == r["id"]))
        .collect();
    let mut ran: Vec<&Value> = filtered
        .iter()
        .copied()
        .filter(|r| r["status"] == "ran")
        .collect();
    ran.sort_by(|a, b| {
        b["statusSince"]
            .as_i64()
            .unwrap_or(0)
            .cmp(&a["statusSince"].as_i64().unwrap_or(0))
            .then(
                b["createdAt"]
                    .as_i64()
                    .unwrap_or(0)
                    .cmp(&a["createdAt"].as_i64().unwrap_or(0)),
            )
            .then(number_value(b).cmp(&number_value(a)))
    });
    Board {
        filtered,
        warming,
        waiting: waiting_rows,
        ran,
        positions: positions.into(),
    }
}

/// What a drop does, as src/lib/kanban.ts resolves it.
enum Action {
    Status(String, &'static str),
    Move(String, String),
}
fn resolve(s: &State, id: &str, over: &Drop) -> Option<Action> {
    let all = runners(s);
    let me = all.iter().find(|r| st(r, "id") == id)?;
    let from = st(me, "status");
    match over {
        Drop::Lane(lane) => can_move(from, lane).then(|| Action::Status(id.into(), lane)),
        Drop::Before(target) | Drop::After(target) => {
            let other = all.iter().find(|r| st(r, "id") == target)?;
            let to = st(other, "status");
            if from == "waiting" && to == "waiting" {
                (id != target).then(|| Action::Move(id.into(), target.clone()))
            } else if can_move(from, to) {
                Some(Action::Status(
                    id.into(),
                    if to == "waiting" {
                        "waiting"
                    } else {
                        "warming_up"
                    },
                ))
            } else {
                None
            }
        }
    }
}
fn run(s: &mut State, action: Action) {
    match action {
        Action::Status(id, to) => set_status(s, &id, to, Pending::Board),
        Action::Move(id, target) => {
            let mut order: Vec<String> =
                waiting(s).iter().map(|r| st(r, "id").to_string()).collect();
            let (Some(old), Some(at)) = (
                order.iter().position(|i| *i == id),
                order.iter().position(|i| *i == target),
            ) else {
                return;
            };
            if old == at {
                return;
            }
            let moved = order.remove(old);
            order.insert(at, moved);
            send(s, "runners.reorder", json!({"ids":order}), Pending::Board);
        }
    }
}
fn send(s: &mut State, method: &str, input: Value, pending: Pending) {
    if !s.connected {
        return;
    }
    if s.busy || s.queue_page.pending.is_some() || s.queue_page.regs_pending {
        s.queue_page
            .queued
            .push_back((method.into(), input, pending));
        return;
    }
    s.queue_page.error.clear();
    s.queue_page.pending = Some(pending);
    s.send(method, input);
    if !s.busy {
        s.queue_page.pending = None;
    }
}
fn set_status(s: &mut State, id: &str, to: &str, pending: Pending) {
    send(
        s,
        "runners.setStatus",
        json!({"id":id,"status":to,"statusSince":s.server_now()}),
        pending,
    );
}

/// Whether this page sent the action that just came back.
pub(super) fn owns(s: &State, method: &str) -> bool {
    if method == "runners.registrations" {
        return s.queue_page.regs_pending;
    }
    s.queue_page.pending.is_some()
}
/// Registrations say who could run this hour; fetched again whenever the data changed.
pub(super) fn refresh(s: &mut State) {
    if s.busy || !s.connected {
        return;
    }
    if let Some((method, input, pending)) = s.queue_page.queued.pop_front() {
        send(s, &method, input, pending);
        return;
    }
    if s.page != 1 {
        return;
    }
    let revision = s.snapshot["revision"].as_i64().unwrap_or(0);
    if s.queue_page.regs_revision != Some(revision) {
        s.queue_page.regs_revision = Some(revision);
        s.queue_page.regs_pending = true;
        s.send("runners.registrations", json!({}));
        if !s.busy {
            s.queue_page.regs_pending = false;
        }
    }
}
pub(super) fn succeeded(s: &mut State, method: &str, result: &Value) {
    if method == "runners.registrations" {
        s.queue_page.regs_pending = false;
        s.queue_page.registrations = result.clone();
        if s.profile.is_some() {
            s.admin.registrations = result.clone();
        }
        return;
    }
    match s.queue_page.pending.take() {
        Some(Pending::CheckIn {
            id: _,
            name,
            keep_open,
        }) => {
            s.queue_page.filter = TextEdit::new("");
            if keep_open {
                if let Some(Dialog::Search(search)) = &mut s.queue_page.dialog {
                    search.query = TextEdit::new("");
                    search.show_all = false;
                }
            } else {
                s.queue_page.dialog = None;
            }
            s.queue_page.toast = Some((format!("{name} staat bij opwarming."), s.server_now()));
        }
        Some(Pending::Added { name }) => {
            if matches!(&s.queue_page.dialog, Some(Dialog::Add(a)) if a.registered) {
                s.queue_page.dialog = None;
                admin_base::toast(s, format!("{name} toegevoegd."));
                return;
            }
            s.queue_page.filter = TextEdit::new("");
            s.queue_page.dialog = None;
            s.queue_page.toast = Some((format!("{name} staat bij opwarming."), s.server_now()));
        }
        Some(Pending::Board) | None => {}
    }
}
pub(super) fn failed(s: &mut State, method: &str) {
    if method == "runners.registrations" {
        s.queue_page.regs_pending = false;
        s.error.clear();
        return;
    }
    match s.queue_page.pending.take() {
        Some(Pending::Added { .. }) => {
            if let Some(Dialog::Add(add)) = &mut s.queue_page.dialog {
                add.error = std::mem::take(&mut s.error);
            }
        }
        Some(Pending::CheckIn { .. }) => {
            s.queue_page.toast = Some((
                format!("Loper activeren mislukt: {}", std::mem::take(&mut s.error)),
                s.server_now(),
            ));
        }
        Some(Pending::Board) => s.queue_page.error = std::mem::take(&mut s.error),
        None => {}
    }
}

fn rows_height(s: &State) -> f32 {
    (s.queue_page.window_h - 205.0).max(280.0)
}

fn board(s: &State) -> El {
    let p = pal(s.dark);
    let b = board_data(s);
    let q = s.queue_page.filter.text.trim().to_string();
    let drag = s.queue_page.drag.as_ref().filter(|d| d.active);
    let drop_action = drag.and_then(|d| d.over.as_ref().map(|o| (d.id.clone(), o.clone())));
    let mut lanes = row().gap(16.0);
    for (key, title, list, grow) in [
        ("warming_up", "Opwarming", &b.warming, 1.0),
        ("waiting", "Klaar om te lopen", &b.waiting, 1.08),
    ] {
        let hint = drop_action
            .as_ref()
            .and_then(|(id, over)| match resolve(s, id, over) {
                Some(Action::Status(_, to)) if to == key => Some(if key == "waiting" {
                    "Loslaten: achteraan in de wachtrij"
                } else {
                    "Loslaten: naar opwarming"
                }),
                _ => None,
            });
        let total = runners(s)
            .iter()
            .filter(|r| r["status"] == key && r["hiddenFromQueue"] != true)
            .count();
        let count = if q.is_empty() {
            plural(list.len(), "loper", "lopers")
        } else {
            format!("{} van {total} lopers", list.len())
        };
        let mut rows = col().pr(15.0);
        for r in list.iter() {
            rows = rows.child(runner_row(s, r, &b, drop_action.as_ref()));
        }
        if list.is_empty() {
            rows = rows.child(empty(
                s,
                if !q.is_empty() {
                    "Geen lopers voor dit filter. Wis het filter om iedereen te zien."
                } else if key == "warming_up" {
                    "Nog niemand aan het opwarmen. Zoek een loper op nummer of naam, of voeg een nieuwe loper toe."
                } else {
                    "De wachtrij is leeg. Sleep een opgewarmde loper hierheen of kies “Naar wachtrij”."
                },
            ));
        }
        let header_right = match hint {
            Some(h) => text(h)
                .font(rune::TextStyle::new(12.5, 500.0))
                .color(p.brand_ink)
                .role("status"),
            None => text(count)
                .font(rune::TextStyle::new(12.5, 400.0))
                .color(p.t.ink3),
        };
        let lane_key = format!("lane-{key}");
        let mut lane = col()
            .key(lane_key.clone())
            .role("region")
            .label(title)
            .grow(grow)
            .min_w(0.0)
            .radius(8.0)
            .fill(p.surface)
            .border(1.0, if hint.is_some() { p.brand } else { p.line })
            .padding(1.0)
            .clip_rounded(8.0)
            .on_layout_tx(move |s: &mut State, rect, tx: &mut Tx| {
                s.queue_page.rects.insert(lane_key.clone(), rect);
                tx.live_only();
            })
            .child(
                row()
                    .h(42.0)
                    .px(16.0)
                    .gap(12.0)
                    .center_y()
                    .justify_between()
                    .border_sides([0.0, 0.0, 1.0, 0.0], p.line)
                    .child(
                        text(title)
                            .font(rune::TextStyle::new(13.5, 600.0))
                            .color(p.ink)
                            .role("heading")
                            .level(2),
                    )
                    .child(header_right),
            )
            .child(
                col()
                    .key(format!("lane-rows-{key}"))
                    .h(rows_height(s))
                    .scroll(ScrollSpec {
                        stick_bottom: false,
                    })
                    .child(rows),
            );
        if hint.is_some() {
            lane = lane.shadow(0.0, 0.0, p.brand);
        }
        lanes = lanes.child(lane);
    }
    let mut ran_rows = col();
    let mut completed = col()
        .key("queue-completed")
        .role("group")
        .radius(8.0)
        .fill(p.surface)
        .border(1.0, p.line)
        .padding(1.0)
        .child(
            row()
                .key("queue-completed-toggle")
                .role("button")
                .label(format!(
                    "Heeft gelopen {} Terug laten opwarmen of verbergen",
                    b.ran.len()
                ))
                .checked(s.queue_page.ran_open)
                .focusable(true)
                .press_on_return()
                .min_h(40.0)
                .px(16.0)
                .gap(8.0)
                .center_y()
                .on_press(|s: &mut State| s.queue_page.ran_open = !s.queue_page.ran_open)
                .child(chevron(s, s.queue_page.ran_open))
                .child(
                    text("Heeft gelopen")
                        .font(rune::TextStyle::new(13.5, 550.0))
                        .color(p.ink),
                )
                .child(
                    text(b.ran.len().to_string())
                        .font(rune::TextStyle::new(13.5, 400.0))
                        .color(p.t.ink3),
                )
                .child(col().grow(1.0))
                .child(
                    text("Terug laten opwarmen of verbergen")
                        .font(rune::TextStyle::new(12.5, 400.0))
                        .color(p.t.ink3),
                ),
        );
    if s.queue_page.ran_open {
        for r in &b.ran {
            ran_rows = ran_rows.child(runner_row(s, r, &b, drop_action.as_ref()));
        }
        if b.ran.is_empty() {
            ran_rows = ran_rows.child(empty(s, "Geen gelopen lopers voor deze selectie."));
        }
        completed = completed
            .child(row().px(16.0).pb(8.0).child(toggle_row(
                s,
                "queue-show-hidden",
                "Verborgen gelopen tonen",
                s.queue_page.show_hidden,
                |s| s.queue_page.show_hidden = !s.queue_page.show_hidden,
            )))
            .child(
                col()
                    .key("queue-completed-rows")
                    .max_h(240.0)
                    .scroll(ScrollSpec {
                        stick_bottom: false,
                    })
                    .border_sides([1.0, 0.0, 0.0, 0.0], p.line)
                    .child(ran_rows),
            );
    }
    let mut workspace = col().gap(12.0);
    if !s.queue_page.error.is_empty() {
        workspace = workspace.child(
            text(s.queue_page.error.clone())
                .font(rune::TextStyle::new(13.0, 500.0))
                .color(p.t.warn_ink)
                .role("alert")
                .wrap()
                .min_w(0.0),
        );
    }
    let _ = &b.filtered;
    workspace.child(lanes).child(completed)
}

fn empty(s: &State, message: &str) -> El {
    text(message.to_string())
        .font(rune::TextStyle::new(13.5, 400.0).lh(20.0))
        .color(pal(s.dark).t.ink3)
        .wrap()
        .min_w(0.0)
        .padding(16.0)
}

/// `.queue-runner`: handle, place in line, identity, time in this lane and the row's buttons.
fn runner_row(s: &State, r: &Value, b: &Board, drop: Option<&(String, Drop)>) -> El {
    let id = st(r, "id");
    let key = format!("queue-card-{id}");
    let build = || runner_row_uncached(s, r, b, drop);
    if drop.is_some() || s.queue_page.drag.as_ref().is_some_and(|d| d.active) {
        return build().key(key);
    }
    let seconds = if st(r, "status") == "ran" {
        0
    } else {
        r["statusSince"].as_i64().map_or(0, |at| (s.clock - at).max(0) / 1000)
    };
    rune::memo(key, (r, b.positions.get(id), seconds, s.dark, s.connected, s.busy, s.logos.len()), build)
}
fn runner_row_uncached(s: &State, r: &Value, b: &Board, drop: Option<&(String, Drop)>) -> El {
    let p = pal(s.dark);
    let id = st(r, "id").to_string();
    let status = st(r, "status");
    let position = b.positions.get(&id).copied();
    let next = position == Some(0);
    let dragging = s
        .queue_page
        .drag
        .as_ref()
        .is_some_and(|d| d.active && d.id == id);
    let edge = drop.and_then(|(from, over)| match (over, resolve(s, from, over)) {
        (Drop::Before(t) | Drop::After(t), Some(Action::Move(..))) if *t == id => {
            let before = b.positions.get(from).copied().unwrap_or(0) > position.unwrap_or(0);
            Some(before)
        }
        _ => None,
    });

    let mut line = row()
        .key(format!("queue-row-{id}"))
        .role("button")
        .label(format!("Verplaats {}", st(r, "name")))
        .min_h(53.0)
        .pt(6.0)
        .pb(7.0)
        .pl(8.0)
        .pr(10.0)
        .gap(10.0)
        .center_y()
        .fill(if next { p.brand_wash } else { p.surface })
        .border_sides([0.0, 0.0, 1.0, 0.0], p.line)
        .opacity(if dragging { 0.3 } else { 1.0 })
        .child(
            rune::el()
                .key(format!("queue-handle-{id}"))
                .w(16.0)
                .h(36.0)
                .center()
                .opacity(0.6)
                .child(
                    text("⠿")
                        .font(rune::TextStyle::new(13.0, 400.0))
                        .color(p.t.ink3),
                ),
        );
    if !next {
        line = line.hover(p.t.surface2);
    }
    if let Some(pos) = position {
        line = line.child(
            rune::el().w(22.0).center().child(
                text((pos + 1).to_string())
                    .font(rune::TextStyle::new(13.0, if next { 600.0 } else { 500.0 }))
                    .color(if next { p.brand_ink } else { p.t.ink3 }),
            ),
        );
    }
    // Identity: name (with the Volgende tag) over the labels, laps and pace.
    let identity = rune::memo(format!("queue-identity-{id}"), (r, position, s.dark, s.logos.len()), || {
        let mut title = row()
            .gap(8.0)
            .center_y()
            .min_w(0.0)
            .min_h(21.0)
            .flex_wrap()
            .child(runner_name(s, r, 14.0, 550.0));
        if next {
            title = title.child(
                row()
                    .h(18.0)
                    .px(6.0)
                    .radius(4.0)
                    .fill(p.brand)
                    .center()
                    .child(
                        text("Volgende")
                            .font(rune::TextStyle::new(11.0, 550.0))
                            .color(p.on_brand),
                    ),
            );
        }
        if position == Some(1) {
            title = title.child(
                row()
                    .key(format!("queue-then-{id}"))
                    .h(18.0)
                    .px(6.0)
                    .radius(4.0)
                    .fill(p.brand_wash)
                    .border(1.0, p.brand.alpha(0.35))
                    .center()
                    .child(
                        text("Daarna")
                            .font(rune::TextStyle::new(11.0, 550.0))
                            .color(p.brand_ink),
                    ),
            );
        }
        let mut details: Vec<El> = r["labels"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|l| pill(s, l))
            .collect();
        let laps = r["lapCount"].as_i64().unwrap_or(0);
        let small = rune::TextStyle::new(12.0, 400.0).lh(18.0);
        if laps > 0 {
            details.push(
                text(plural(laps as usize, "ronde", "rondes"))
                    .font(small)
                    .color(p.t.ink3),
            );
        }
        if let Some(pace) = r["estimatedPace"].as_str().filter(|v| !v.is_empty()) {
            details.push(text(format!("~{pace}")).font(small).color(p.t.ink3));
        }
        let profile_id = id.clone();
        let mut identity = col()
            .key(format!("queue-identity-{id}"))
            .role("button")
            .label(format!("{}: profiel openen", st(r, "name")))
            .focusable(true)
            .press_on_return()
            .grow(1.0)
            .min_w(0.0)
            .py(2.0)
            .gap(3.0)
            .on_press(move |s: &mut State| s.send("runners.profile", json!({"id":profile_id})))
            .child(title);
        // No empty second line without labels, laps or pace, so the name lines up with the place in
        // line and the timer.
        if !details.is_empty() {
            identity = identity.child(
                row()
                    .gap(8.0)
                    .center_y()
                    .min_h(18.0)
                    .pl(name_indent(r, 14.0))
                    .flex_wrap()
                    .children(details),
            );
        }
        identity
    });
    line = line.child(identity);
    // TimerBadge: time in this lane, amber after ten minutes of warming up.
    let elapsed = (s.clock - r["statusSince"].as_i64().unwrap_or(s.clock)).max(0);
    let seconds = if status == "ran" { 0 } else { elapsed / 1000 };
    let timer = rune::memo(format!("queue-timer-{id}"), (&r["statusSince"], status, seconds, s.dark), || {
        let mut timer = row().w(70.0).gap(4.0).center_y().justify_end();
        if let Some(at) = r["statusSince"].as_i64().filter(|_| status != "ran") {
            let elapsed = (s.clock - at).max(0);
            let long = status == "warming_up" && elapsed >= LONG_WARM_UP_MS;
            let ink = if long { p.t.warn_ink } else { p.t.ink2 };
            timer = timer
                .child(icon(
                    s,
                    "timing",
                    if long { p.t.warn_ink } else { p.t.ink3 },
                    12.0,
                    1.75,
                ))
                .child(
                    text(duration(elapsed))
                        .font(rune::TextStyle::new(13.0, 500.0).features("'tnum' 1"))
                        .color(ink),
                );
        }
        timer
    });
    line = line.child(timer);
    let actions = rune::memo(format!("queue-actions-{id}"), (status, &r["hiddenFromQueue"], s.dark, s.connected, s.busy), || {
        let mut actions = row().gap(4.0);
        if let Some(to) = next_lane(status) {
            let move_id = id.clone();
            actions = actions.child(
                btn(
                    s,
                    format!("queue-advance-{id}"),
                    if to == "waiting" {
                        "Naar wachtrij"
                    } else {
                        "Opwarmen"
                    },
                    Kind::Plain,
                    true,
                )
                .on_press(move |s: &mut State| set_status(s, &move_id, to, Pending::Board)),
            );
        }
        if status == "ran" {
            let hidden = r["hiddenFromQueue"] == true;
            let hide_id = id.clone();
            actions = actions.child(
                btn(
                    s,
                    format!("queue-hide-{id}"),
                    if hidden { "Terug tonen" } else { "Verberg" },
                    Kind::Quiet,
                    true,
                )
                .on_press(move |s: &mut State| {
                    let method = if hidden {
                        "runners.unhide"
                    } else {
                        "runners.hide"
                    };
                    send(s, method, json!({"id":hide_id}), Pending::Board)
                }),
            );
        }
        actions
    });
    line = line.child(actions);

    let drag_id = id.clone();
    let rect_key = format!("row-{id}");
    let mut wrap = col()
        .on_layout_tx(move |s: &mut State, rect, tx: &mut Tx| {
            s.queue_page.rects.insert(rect_key.clone(), rect);
            tx.live_only();
        })
        .child(
            line.on_drag(move |s: &mut State, d: &mut rune::Drag, tx: &mut Tx| {
                drag(s, &drag_id, d, tx)
            }),
        );
    if let Some(before) = edge {
        let bar = rune::el().h(2.0).w_full().fill(p.brand);
        let tag = row().px(6.0).radius(4.0).fill(p.brand).child(
            text("Hier invoegen")
                .font(rune::TextStyle::new(11.5, 500.0))
                .color(p.on_brand),
        );
        wrap = wrap.child(if before {
            bar.absolute(0.0, 0.0)
        } else {
            bar.pin(Some(0.0), None, Some(0.0), Some(0.0))
        });
        wrap = wrap.child(if before {
            tag.pin(None, Some(-8.0), Some(10.0), None)
        } else {
            tag.pin(None, None, Some(10.0), Some(-8.0))
        });
    }
    wrap
}

fn hit(rect: &[f32; 4], at: [f32; 2]) -> bool {
    at[0] >= rect[0] && at[0] < rect[0] + rect[2] && at[1] >= rect[1] && at[1] < rect[1] + rect[3]
}
fn target(s: &State, id: &str, at: [f32; 2]) -> Option<Drop> {
    let rects = &s.queue_page.rects;
    let lane = ["warming_up", "waiting"]
        .into_iter()
        .find(|k| rects.get(&format!("lane-{k}")).is_some_and(|r| hit(r, at)))?;
    // A row of that lane under the pointer, else the lane itself.
    for r in runners(s) {
        let rid = st(r, "id");
        if rid == id || st(r, "status") != lane {
            continue;
        }
        if let Some(rect) = rects.get(&format!("row-{rid}"))
            && hit(rect, at)
        {
            let me = runners(s).into_iter().find(|x| st(x, "id") == id);
            let mine = me.and_then(|m| waiting(s).iter().position(|w| w["id"] == m["id"]));
            let theirs = waiting(s).iter().position(|w| st(w, "id") == rid);
            return Some(match (mine, theirs) {
                (Some(a), Some(b)) if a < b => Drop::After(rid.into()),
                _ => Drop::Before(rid.into()),
            });
        }
    }
    Some(Drop::Lane(if lane == "waiting" {
        "waiting"
    } else {
        "warming_up"
    }))
}
fn drag(s: &mut State, id: &str, d: &mut rune::Drag, _tx: &mut Tx) {
    let at = d.window_point();
    match d.phase {
        rune::Phase::Down => {
            s.queue_page.drag = Some(DragState {
                id: id.into(),
                active: false,
                at,
                grab: [d.start_x, d.start_y],
                over: None,
            });
        }
        rune::Phase::Move => {
            let over = target(s, id, at);
            if let Some(g) = &mut s.queue_page.drag {
                g.at = at;
                if !g.active && (d.dx * d.dx + d.dy * d.dy).sqrt() >= DRAG_START {
                    g.active = true;
                }
                g.over = over;
            }
        }
        rune::Phase::Up => {
            let Some(g) = s.queue_page.drag.take() else {
                return;
            };
            if d.cancelled() || !g.active {
                return;
            }
            if let Some(over) = target(s, id, at)
                && let Some(action) = resolve(s, id, &over)
            {
                run(s, action);
            }
        }
    }
}

// ---------- Overlays: dialogs, the card in hand and the toast ----------

/// Nieuwe loper from Beheer › Lopers (`RunnerAddModal destination="registered"`).
pub(super) fn open_add(s: &mut State, registered: bool) {
    s.queue_page.dialog = Some(Dialog::Add(Box::new(Add {
        registered,
        ..Default::default()
    })));
}
pub(super) fn modal(s: &State) -> Option<El> {
    let adding_elsewhere = s.page == 8 && matches!(s.queue_page.dialog, Some(Dialog::Add(_)));
    if s.page != 1 && !adding_elsewhere {
        return None;
    }
    if let Some(dialog) = &s.queue_page.dialog {
        return Some(match dialog {
            Dialog::Search(search) => search_dialog(s, search),
            Dialog::Add(add) if add.confirm_close => rune::el()
                .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                .child(add_dialog(s, add).inert())
                .child(close_question(s)),
            Dialog::Add(add) => add_dialog(s, add),
            Dialog::Call(name, phone) => call_dialog(s, name, phone),
        });
    }
    let p = pal(s.dark);
    // A window-wide layer with nothing to press: it tells the lanes how tall the window is, and
    // holds the card in hand and the toast.
    let mut layer = rune::el()
        .key("queue-layer")
        .absolute(0.0, 0.0)
        .w_full()
        .h_full()
        .on_layout(|s: &mut State, rect| {
            if (s.queue_page.window_h - rect[3]).abs() > 0.5 {
                s.queue_page.window_h = rect[3];
            }
        });
    let mut extra = Vec::new();
    if let Some(g) = s.queue_page.drag.as_ref().filter(|g| g.active)
        && let Some(r) = runners(s).into_iter().find(|r| st(r, "id") == g.id)
    {
        let _ = g.grab;
        extra.push(
            row()
                .key("queue-drag-card")
                .absolute(g.at[0] - 24.0, g.at[1] - 26.0)
                .w(420.0)
                .min_h(52.0)
                .py(6.0)
                .pl(8.0)
                .pr(10.0)
                .gap(10.0)
                .center_y()
                .radius(6.0)
                .fill(p.surface)
                .border(1.0, p.t.line2)
                .shadow(
                    8.0,
                    24.0,
                    if s.dark {
                        rune::oklcha(0.0, 0.0, 0.0, 0.5)
                    } else {
                        rune::oklcha(0.21, 0.006, 285.9, 0.14)
                    },
                )
                .child(
                    text("⠿")
                        .font(rune::TextStyle::new(13.0, 400.0))
                        .color(p.t.ink3)
                        .w(16.0),
                )
                .child(
                    col()
                        .gap(3.0)
                        .min_w(0.0)
                        .child(runner_name(s, r, 14.0, 550.0))
                        .child(
                            text("Loslaten om te verplaatsen")
                                .font(rune::TextStyle::new(12.0, 400.0))
                                .color(p.t.ink3)
                                .pl(name_indent(r, 14.0)),
                        ),
                ),
        );
    }
    if let Some((message, at)) = &s.queue_page.toast
        && s.clock - at < TOAST_MS
    {
        extra.push(
            row()
                .key("queue-toast")
                .role("status")
                .pin(None, None, Some(20.0), Some(20.0))
                .w(400.0)
                .gap(12.0)
                .pt(12.0)
                .pb(12.0)
                .pl(12.0)
                .pr(10.0)
                .items_start()
                .radius(10.0)
                .fill(p.surface)
                .border(1.0, p.line)
                .shadow(
                    16.0,
                    48.0,
                    if s.dark {
                        rune::oklcha(0.0, 0.0, 0.0, 0.5)
                    } else {
                        rune::oklcha(0.21, 0.006, 285.9, 0.16)
                    },
                )
                .child(
                    rune::el()
                        .size(24.0, 24.0)
                        .radius(12.0)
                        .center()
                        .fill(p.t.go)
                        .child(icon(s, "check", p.on_brand, 14.0, 2.75)),
                )
                .child(
                    text(message.clone())
                        .font(rune::TextStyle::new(13.5, 400.0).lh(19.6))
                        .color(p.ink)
                        .wrap()
                        .grow(1.0)
                        .min_w(0.0)
                        .pt(2.0),
                ),
        );
    }
    for e in extra {
        layer = layer.child(e);
    }
    Some(layer)
}

fn overlay(s: &State, key: &str, dismiss: impl Fn(&mut State) + 'static) -> El {
    rune::el()
        .key(key.to_string())
        .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
        .padding(16.0)
        .center()
        .fill(if s.dark {
            rune::oklcha(0.0, 0.0, 0.0, 0.55)
        } else {
            rune::oklcha(0.21, 0.006, 285.9, 0.4)
        })
        .modal(false, dismiss)
}
fn sheet(s: &State, key: &str, title: &str, max_h: f32) -> El {
    let p = pal(s.dark);
    col()
        .key(key.to_string())
        .role("dialog")
        .label(title.to_string())
        .w(760.0)
        .max_w(760.0)
        .min_w(0.0)
        .max_h(max_h)
        .padding(20.0)
        .radius(10.0)
        .fill(p.surface)
        .border(1.0, p.line)
        .shadow(
            16.0,
            48.0,
            if s.dark {
                rune::oklcha(0.0, 0.0, 0.0, 0.5)
            } else {
                rune::oklcha(0.21, 0.006, 285.9, 0.16)
            },
        )
}
fn modal_header(s: &State, key: &str, title: &str, close: impl Fn(&mut State) + 'static) -> El {
    let p = pal(s.dark);
    row()
        .mb(16.0)
        .gap(12.0)
        .items_start()
        .justify_between()
        .child(
            text(title.to_string())
                .font(rune::TextStyle::new(16.0, 600.0).lh(20.0))
                .color(p.ink)
                .role("heading")
                .level(2),
        )
        .child(
            row()
                .key(key.to_string())
                .role("button")
                .label("Sluiten")
                .focusable(true)
                .press_on_return()
                .size(28.0, 28.0)
                .center()
                .radius(6.0)
                .hover(p.t.surface3)
                .on_press(close)
                .child(
                    text("✕")
                        .font(rune::TextStyle::new(14.0, 500.0))
                        .color(p.t.ink2),
                ),
        )
}
fn dialog_max_h(s: &State) -> f32 {
    (s.queue_page.window_h * 0.9).min(860.0) - 0.0
}

// ---------- Bellen (CallQrDialog.tsx) ----------

fn runner_label(r: &Value) -> String {
    let number = st(r, "runnerNumber");
    if number.is_empty() {
        st(r, "name").to_string()
    } else {
        format!("{number} {}", st(r, "name"))
    }
}
/// `phoneHref`: tel: plus the digits and a leading +.
pub(super) fn phone_href(phone: &str) -> String {
    format!(
        "tel:{}",
        phone
            .trim()
            .chars()
            .filter(|c| c.is_ascii_digit() || *c == '+')
            .collect::<String>()
    )
}
/// The QR modules with a four-module quiet zone (uqr's `border: 4`), as one filled path.
fn qr_shape(href: &str, dark: bool) -> Option<rune::Shape> {
    let qr = qrcodegen::QrCode::encode_text(href, qrcodegen::QrCodeEcc::Medium).ok()?;
    let size = qr.size() as f32 + 8.0;
    let mut path = rune::Path::new();
    for y in 0..qr.size() {
        for x in 0..qr.size() {
            if qr.get_module(x, y) {
                let (x, y) = (x as f32 + 4.0, y as f32 + 4.0);
                path = path
                    .move_to([x, y])
                    .line_to([x + 1.0, y])
                    .line_to([x + 1.0, y + 1.0])
                    .line_to([x, y + 1.0])
                    .close();
            }
        }
    }
    let _ = dark;
    Some(
        rune::Shape::new()
            .view_box(size, size)
            .fill(
                vec![[0.0, 0.0], [size, 0.0], [size, size], [0.0, size]],
                rune::oklch(1.0, 0.0, 0.0),
            )
            .fill_path(&path, rune::oklch(0.0, 0.0, 0.0)),
    )
}
fn call_dialog(s: &State, name: &str, phone: &str) -> El {
    let p = pal(s.dark);
    let close = |s: &mut State| s.queue_page.dialog = None;
    let header = row()
        .w_full()
        .mb(16.0)
        .gap(12.0)
        .items_start()
        .justify_between()
        .child(
            col()
                .gap(2.0)
                .child(
                    text("Bellen")
                        .font(rune::TextStyle::new(12.0, 500.0))
                        .color(p.t.ink3),
                )
                .child(
                    text(name.to_string())
                        .font(rune::TextStyle::new(22.0, 600.0).lh(26.0).tracking(-0.44))
                        .color(p.ink)
                        .role("heading")
                        .level(2),
                ),
        )
        .child(
            row()
                .key("call-close")
                .role("button")
                .label("Sluiten")
                .focusable(true)
                .press_on_return()
                .size(28.0, 28.0)
                .center()
                .radius(6.0)
                .hover(p.t.surface3)
                .on_press(close)
                .child(
                    text("✕")
                        .font(rune::TextStyle::new(14.0, 500.0))
                        .color(p.t.ink2),
                ),
        );
    let mut body = col().w_full().items_center().child(header);
    if let Some(shape) = qr_shape(&phone_href(phone), s.dark) {
        body = body.child(
            rune::canvas(shape)
                .key("call-qr")
                .label(format!("QR-code om {phone} te bellen"))
                .size(340.0, 340.0)
                .radius(6.0)
                .clip_rounded(6.0),
        );
    }
    body = body
        .child(
            text(phone.to_string())
                .font(
                    rune::TextStyle::new(32.0, 700.0)
                        .features("'tnum' 1")
                        .tracking(0.32),
                )
                .color(p.ink)
                .mt(16.0),
        )
        .child(
            text("Scan met de camera van je telefoon en tik op Bellen.")
                .font(rune::TextStyle::new(13.5, 400.0))
                .color(p.t.ink2)
                .mt(8.0),
        );
    overlay(s, "call-overlay", close).child(
        col()
            .key("call-dialog")
            .role("dialog")
            .label(format!("{name} bellen"))
            .w(460.0)
            .max_w(460.0)
            .padding(20.0)
            .radius(10.0)
            .fill(p.surface)
            .border(1.0, p.line)
            .shadow(
                16.0,
                48.0,
                if s.dark {
                    rune::oklcha(0.0, 0.0, 0.0, 0.5)
                } else {
                    rune::oklcha(0.21, 0.006, 285.9, 0.16)
                },
            )
            .child(body),
    )
}

// ---------- Loper zoeken (RunnerActivationModal) ----------

fn search_matches<'a>(s: &'a State, query: &str) -> Vec<&'a Value> {
    let mut all = runners(s);
    all.sort_by(|a, b| {
        let (x, y) = (st(a, "runnerNumber"), st(b, "runnerNumber"));
        match (x.parse::<i64>(), y.parse::<i64>()) {
            (Ok(m), Ok(n)) => m.cmp(&n),
            _ => x.cmp(y),
        }
        .then(st(a, "name").cmp(st(b, "name")))
    });
    let q = fold(query.trim());
    if q.is_empty() {
        return all;
    }
    let exact: Vec<&Value> = all
        .iter()
        .copied()
        .filter(|r| fold(st(r, "runnerNumber").trim()) == q)
        .collect();
    if !exact.is_empty() {
        return exact;
    }
    all.into_iter().filter(|r| matches(r, &q)).collect()
}
fn check_in(s: &mut State, id: &str) {
    let keep_open = matches!(&s.queue_page.dialog, Some(Dialog::Search(x)) if x.keep_open);
    let name = runners(s)
        .into_iter()
        .find(|r| st(r, "id") == id)
        .map(|r| st(r, "name").to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Loper".into());
    set_status(
        s,
        id,
        "warming_up",
        Pending::CheckIn {
            id: id.into(),
            name,
            keep_open,
        },
    );
}
fn close_search(s: &mut State) {
    if !matches!(s.queue_page.pending, Some(Pending::CheckIn { .. })) {
        s.queue_page.dialog = None;
    }
}

fn search_dialog(s: &State, search: &Search) -> El {
    let p = pal(s.dark);
    let found = search_matches(s, &search.query.text);
    let has_query = !search.query.text.trim().is_empty();
    let shown = if search.show_all {
        found.len()
    } else {
        found.len().min(SEARCH_PAGE)
    };
    let busy_id = match &s.queue_page.pending {
        Some(Pending::CheckIn { id, .. }) => Some(id.clone()),
        _ => None,
    };
    let help = rune::TextStyle::new(12.5, 400.0).lh(18.75);
    let mut body = col()
        .min_w(0.0)
        .child(modal_header(
            s,
            "search-close",
            "Loper zoeken",
            close_search,
        ))
        .child(
            field(
                s,
                &search.query,
                "search-query",
                "Zoek op nummer, naam of label",
                "Zoek op nummer, naam of label...",
            )
            .on_edit(|s: &mut State| match &mut s.queue_page.dialog {
                Some(Dialog::Search(x)) => {
                    x.show_all = false;
                    &mut x.query
                }
                _ => unreachable!("search field without its dialog"),
            })
            .on_submit(|s: &mut State, _tx: &mut Tx| {
                let Some(Dialog::Search(x)) = &s.queue_page.dialog else {
                    return;
                };
                let q = x.query.text.clone();
                if q.trim().is_empty() || s.queue_page.pending.is_some() {
                    return;
                }
                let found = search_matches(s, &q);
                if found.len() == 1 && can_check_in(st(found[0], "status")) {
                    let id = st(found[0], "id").to_string();
                    check_in(s, &id);
                }
            }),
        )
        .child(row().child(toggle_row(
            s,
            "search-keep-open",
            "Meerdere lopers aanmelden",
            search.keep_open,
            |s| {
                if let Some(Dialog::Search(x)) = &mut s.queue_page.dialog {
                    x.keep_open = !x.keep_open;
                }
            },
        )))
        .child(
            text("Aan: dit venster blijft open na elke aanmelding.")
                .font(help)
                .color(p.t.ink3)
                .mb(8.0),
        );
    if has_query && found.len() == 1 && can_check_in(st(found[0], "status")) {
        body = body.child(
            text("Enter: deze loper naar opwarming.")
                .font(help)
                .color(p.t.ink3)
                .mb(8.0),
        );
    }
    let mut list = col()
        .key("search-results")
        .mt(4.0)
        .border_sides([1.0, 0.0, 0.0, 0.0], p.line)
        .child(
            text(format!(
                "{}{}",
                if has_query {
                    format!(
                        "{} {}",
                        found.len(),
                        if found.len() == 1 {
                            "resultaat"
                        } else {
                            "resultaten"
                        }
                    )
                } else {
                    format!("{} lopers in de databank", found.len())
                },
                if found.len() > shown {
                    format!(" · eerste {shown} getoond")
                } else {
                    String::new()
                }
            ))
            .font(rune::TextStyle::new(13.5, 400.0).lh(20.0))
            .color(p.t.ink3)
            .py(8.0),
        );
    if found.is_empty() {
        list = list.child(empty(
            s,
            if has_query {
                "Geen loper gevonden."
            } else {
                "Geen beschikbare lopers in de databank."
            },
        ));
    }
    for r in &found[..shown] {
        let id = st(r, "id").to_string();
        let mut meta = row().gap(5.0).mt(4.0).center_y().flex_wrap().child(
            row()
                .h(20.0)
                .px(6.0)
                .radius(4.0)
                .center_y()
                .fill(p.t.surface2)
                .child(
                    text(status_label(r))
                        .font(rune::TextStyle::new(12.0, 500.0))
                        .color(p.t.ink2),
                ),
        );
        let labels: Vec<&Value> = r["labels"].as_array().into_iter().flatten().collect();
        if !labels.is_empty() {
            let mut pills = row().gap(4.0).center_y();
            for l in labels.iter().take(2) {
                pills = pills.child(pill(s, l));
            }
            if labels.len() > 2 {
                pills = pills.child(
                    row()
                        .h(18.0)
                        .px(6.0)
                        .radius(4.0)
                        .center_y()
                        .border(1.0, p.line)
                        .child(
                            text(format!("+{}", labels.len() - 2))
                                .font(rune::TextStyle::new(11.5, 500.0))
                                .color(p.t.ink2),
                        ),
                );
            }
            meta = meta.child(pills);
        }
        let profile_id = id.clone();
        let mut profile = btn(
            s,
            format!("search-profile-{id}"),
            "Profiel",
            Kind::Ghost,
            false,
        )
        .min_w(104.0);
        if busy_id.is_none() {
            profile = profile.on_press(move |s: &mut State| {
                s.queue_page.dialog = None;
                s.send("runners.profile", json!({"id":profile_id}));
            });
        } else {
            profile = profile.disabled(true).opacity(0.6);
        }
        let action = if can_check_in(st(r, "status")) {
            let go_id = id.clone();
            let busy = busy_id.as_deref() == Some(id.as_str());
            let b = btn(
                s,
                format!("search-activate-{id}"),
                if busy { "Bezig..." } else { "Opwarmen" },
                Kind::Primary,
                false,
            )
            .min_w(170.0);
            if busy_id.is_some() {
                b.disabled(true).opacity(0.6)
            } else {
                b.on_press(move |s: &mut State| check_in(s, &go_id))
            }
        } else {
            btn_off(s, format!("search-status-{id}"), status_label(r))
                .min_w(170.0)
                .help("Deze loper staat al in het traject en kan niet opnieuw worden aangemeld.")
        };
        let mut title = row().gap(8.0).center_y();
        let number = st(r, "runnerNumber");
        if !number.is_empty() {
            title = title.child(
                text(number.to_string())
                    .font(rune::TextStyle::new(14.0, 500.0))
                    .color(p.t.ink3)
                    .min_w(36.4),
            );
        }
        title = title.child(
            text(st(r, "name").to_string())
                .font(rune::TextStyle::new(14.0, 550.0))
                .color(p.ink),
        );
        list = list.child(
            row()
                .key(format!("search-row-{id}"))
                .min_h(58.0)
                .py(8.0)
                .px(2.0)
                .gap(12.0)
                .center_y()
                .justify_between()
                .border_sides([0.0, 0.0, 1.0, 0.0], p.line)
                .child(col().min_w(0.0).child(title).child(meta))
                .child(row().gap(8.0).child(profile).child(action)),
        );
    }
    if found.len() > shown {
        let n = found.len();
        list = list.child(
            btn(
                s,
                "search-show-all",
                &format!("Toon alle {n} lopers"),
                Kind::Ghost,
                false,
            )
            .mt(8.0)
            .on_press(|s: &mut State| {
                if let Some(Dialog::Search(x)) = &mut s.queue_page.dialog {
                    x.show_all = true;
                }
            }),
        );
    }
    body = body.child(list);
    overlay(s, "search-overlay", close_search).child(
        sheet(s, "search-dialog", "Loper zoeken", dialog_max_h(s))
            .scroll(ScrollSpec {
                stick_bottom: false,
            })
            .child(body),
    )
}

// ---------- Beschikbare uren (AvailableHoursPicker.tsx, lib/availability.ts setHourBlock) ----------

fn hour_block(text: &str) -> Option<(u32, u32, Option<String>)> {
    let t = text.trim();
    let (hours, weekday) = match t.find('(') {
        Some(i) => {
            let day = t[i + 1..].trim().strip_suffix(')')?.trim().to_lowercase();
            (t[..i].trim(), (!day.is_empty()).then_some(day))
        }
        None => (t, None),
    };
    let (a, b) = hours.split_once(['-', '–'])?;
    let num = |v: &str| -> Option<u32> {
        let v = v.trim().trim_end_matches(['u', 'U']).trim();
        (!v.is_empty() && v.len() <= 2 && v.chars().all(|c| c.is_ascii_digit()))
            .then(|| v.parse().ok())
            .flatten()
    };
    let (start, end) = (num(a)?, num(b)?);
    if start > 23 || end > 24 || start == end {
        return None;
    }
    Some((start, end % 24, weekday))
}
fn block_covers(b: &(u32, u32, Option<String>), weekday: &str, hour: u32) -> bool {
    if b.2.as_deref().is_some_and(|d| d != weekday) {
        return false;
    }
    if b.1 <= b.0 {
        hour >= b.0 || hour < b.1
    } else {
        hour >= b.0 && hour < b.1
    }
}
fn has_hour(texts: &[String], weekday: &str, hour: u32) -> bool {
    texts
        .iter()
        .any(|t| hour_block(t).is_some_and(|b| block_covers(&b, weekday, hour)))
}
fn block_text(hour: u32, weekday: Option<&str>) -> String {
    match weekday {
        Some(d) => format!("{hour:02}-{:02}u ({d})", (hour + 1) % 24),
        None => format!("{hour:02}-{:02}u", (hour + 1) % 24),
    }
}
fn block_position(text: &str) -> usize {
    match hour_block(text) {
        Some((start, _, Some(day))) => {
            WEEKDAYS.iter().position(|d| *d == day).unwrap_or(7) * 24 + start as usize
        }
        _ => usize::MAX,
    }
}
pub(super) fn set_hour(texts: &[String], weekday: &str, hour: u32, on: bool) -> Vec<String> {
    if on {
        if has_hour(texts, weekday, hour) {
            return texts.to_vec();
        }
        let mut list = texts.to_vec();
        list.push(block_text(hour, Some(weekday)));
        list.sort_by(|a, b| {
            block_position(a)
                .cmp(&block_position(b))
                .then(fold(a).cmp(&fold(b)))
        });
        return list;
    }
    texts
        .iter()
        .flat_map(|t| match hour_block(t) {
            Some(b) if block_covers(&b, weekday, hour) => {
                let mut out = Vec::new();
                let mut h = b.0;
                while h != b.1 {
                    if h != hour {
                        out.push(block_text(h, b.2.as_deref()));
                    }
                    h = (h + 1) % 24;
                }
                out
            }
            _ => vec![t.clone()],
        })
        .collect()
}
/// The event's 24 one-hour slots (eventHourGrid: Tuesday 20u to Wednesday 20u).
fn event_hour_grid() -> Vec<(&'static str, Vec<u32>)> {
    let mut days: Vec<(&'static str, Vec<u32>)> = Vec::new();
    let (mut day, mut hour) = (1usize, 20u32);
    for _ in 0..24 {
        match days.last_mut() {
            Some((d, hs)) if *d == WEEKDAYS[day] => hs.push(hour),
            _ => days.push((WEEKDAYS[day], vec![hour])),
        }
        hour = (hour + 1) % 24;
        if hour == 0 {
            day = (day + 1) % 7;
        }
    }
    days
}
fn toggle_hour(s: &mut State, weekday: &'static str, hour: u32) {
    let a = add_mut(s);
    if std::mem::take(&mut a.painted) {
        return;
    }
    let on = !has_hour(&a.hours, weekday, hour);
    a.hours = set_hour(&a.hours, weekday, hour, on);
}
/// Press and drag across slots to set them all (AvailableHoursPicker startPaint/continuePaint).
fn paint_hours(s: &mut State, weekday: &'static str, hour: u32, d: &rune::Drag) {
    // Layout space of the slot rects: this slot's own origin plus the pointer within it.
    let own = s.queue_page.rects.get(&format!("hour-{weekday}-{hour}"));
    let at = own.map_or([f32::NAN; 2], |r| [r[0] + d.x, r[1] + d.y]);
    let under = event_hour_grid().into_iter().find_map(|(wd, hs)| {
        hs.into_iter()
            .find(|h| {
                s.queue_page
                    .rects
                    .get(&format!("hour-{wd}-{h}"))
                    .is_some_and(|r| hit(r, at))
            })
            .map(|h| (wd, h))
    });
    let a = add_mut(s);
    match d.phase {
        rune::Phase::Down => {
            let on = !has_hour(&a.hours, weekday, hour);
            a.paint = Some(on);
            a.painted = true;
            a.hours = set_hour(&a.hours, weekday, hour, on);
        }
        rune::Phase::Move => {
            if let (Some(on), Some((wd, h))) = (a.paint, under)
                && has_hour(&a.hours, wd, h) != on
            {
                a.hours = set_hour(&a.hours, wd, h, on);
            }
        }
        rune::Phase::Up => a.paint = None,
    }
}
fn hours_picker(s: &State, hours: &[String]) -> El {
    let p = pal(s.dark);
    let mut picker = col()
        .key("add-hours")
        .role("group")
        .label("Beschikbare uren")
        .gap(8.0)
        .mt(16.0)
        .child(
            text("Beschikbare uren")
                .font(rune::TextStyle::new(13.5, 500.0))
                .color(p.t.ink2)
                .mb(8.0),
        );
    for (weekday, slots_of_day) in event_hour_grid() {
        let mut slots = row().gap(4.0).flex_wrap().grow(1.0).min_w(0.0);
        for h in slots_of_day {
            let on = has_hour(hours, weekday, h);
            slots = slots.child(
                row()
                    .key(format!("add-hour-{weekday}-{h}"))
                    .role("button")
                    .label(block_text(h, Some(weekday)))
                    .checked(on)
                    .focusable(true)
                    .press_on_return()
                    .min_w(58.0)
                    .h(28.0)
                    .px(6.0)
                    .center()
                    .radius(6.0)
                    .fill(if on { p.brand_wash } else { p.surface })
                    .border(
                        if on { 2.0 } else { 1.0 },
                        if on { p.brand } else { p.t.line2 },
                    )
                    .hover(if on { p.brand_wash } else { p.t.surface2 })
                    .on_press(move |s: &mut State| toggle_hour(s, weekday, h))
                    .on_drag(move |s: &mut State, d: &mut rune::Drag, _: &mut Tx| {
                        paint_hours(s, weekday, h, d)
                    })
                    .on_layout_tx({
                        let k = format!("hour-{weekday}-{h}");
                        move |s: &mut State, rect, tx: &mut Tx| {
                            s.queue_page.rects.insert(k.clone(), rect);
                            tx.live_only();
                        }
                    })
                    .child(
                        text(format!("{h:02}–{:02}", (h + 1) % 24))
                            .font(rune::TextStyle::new(13.0, 500.0))
                            .color(if on { p.brand_ink } else { p.ink }),
                    ),
            );
        }
        let mut name = weekday.to_string();
        name[..1].make_ascii_uppercase();
        picker = picker.child(
            row()
                .gap(12.0)
                .items_start()
                .child(
                    text(name)
                        .font(rune::TextStyle::new(13.0, 400.0))
                        .color(p.t.ink2)
                        .w(88.0)
                        .pt(5.0),
                )
                .child(slots),
        );
    }
    picker.child(
        text("Sleep over meerdere uren om ze in één keer aan of uit te zetten.")
            .font(rune::TextStyle::new(12.5, 400.0))
            .color(p.t.ink3)
            .mt(4.0),
    )
}

// ---------- Nieuwe loper (RunnerAddModal) ----------

fn add_mut(s: &mut State) -> &mut Add {
    match &mut s.queue_page.dialog {
        Some(Dialog::Add(a)) => a,
        _ => unreachable!("add field without its dialog"),
    }
}
fn has_draft(a: &Add) -> bool {
    !a.labels.is_empty()
        || !a.hours.is_empty()
        || [
            &a.number,
            &a.name,
            &a.notes,
            &a.phone,
            &a.email,
            &a.avg_min,
            &a.avg_sec,
            &a.best_min,
            &a.best_sec,
        ]
        .iter()
        .any(|e| !e.text.trim().is_empty())
}
fn request_close(s: &mut State) {
    if matches!(s.queue_page.pending, Some(Pending::Added { .. })) {
        return;
    }
    if let Some(Dialog::Add(a)) = &mut s.queue_page.dialog {
        if has_draft(a) {
            a.confirm_close = true;
            return;
        }
    }
    s.queue_page.dialog = None;
}
fn seconds_input(v: &str) -> Option<i64> {
    let n: f64 = if v.trim().is_empty() {
        0.0
    } else {
        v.trim().parse().ok()?
    };
    Some(n.round().clamp(0.0, 59.0) as i64)
}
fn minute_second_ms(min: &str, sec: &str) -> Value {
    if min.trim().is_empty() && sec.trim().is_empty() {
        return Value::Null;
    }
    let m: f64 = if min.trim().is_empty() {
        0.0
    } else {
        match min.trim().parse() {
            Ok(v) => v,
            Err(_) => return Value::Null,
        }
    };
    match seconds_input(sec) {
        Some(sec) => json!(((m.round().max(0.0) as i64) * 60 + sec) * 1000),
        None => Value::Null,
    }
}
fn save(s: &mut State) {
    if s.queue_page.pending.is_some() {
        return;
    }
    let Some(Dialog::Add(a)) = &mut s.queue_page.dialog else {
        return;
    };
    let name = a.name.text.trim().to_string();
    if name.is_empty() {
        a.error = "Naam is verplicht.".into();
        return;
    }
    a.error.clear();
    let hours = a.hours.clone();
    let number = a.number.text.trim().to_string();
    let input = json!({
        "runnerNumber": if number.is_empty() { Value::Null } else { json!(number) },
        "name": name,
        "historicalAvgMs": minute_second_ms(&a.avg_min.text, &a.avg_sec.text),
        "historicalBestMs": minute_second_ms(&a.best_min.text, &a.best_sec.text),
        "registrationSource": "manual",
        "notes": a.notes.text,
        "registrationDetails": {"phone": a.phone.text, "email": a.email.text, "availableHours": hours},
        "labels": a.labels,
        "status": if a.registered { "registered" } else { "warming_up" },
    });
    send(s, "runners.create", input, Pending::Added { name });
}

fn labelled(s: &State, title: &str, input: El) -> El {
    col()
        .gap(6.0)
        .grow(1.0)
        .min_w(0.0)
        .child(
            text(title.to_string())
                .font(rune::TextStyle::new(13.0, 500.0))
                .color(pal(s.dark).t.ink2),
        )
        .child(input)
}
macro_rules! add_field {
    ($s:expr, $a:expr, $f:ident, $key:expr, $title:expr, $ph:expr) => {
        field($s, &$a.$f, $key, $title, $ph)
            .on_edit(|s: &mut State| &mut add_mut(s).$f)
            .on_submit(|s: &mut State, _tx: &mut Tx| save(s))
    };
}
fn disclosure(
    s: &State,
    key: &str,
    title: &str,
    hint: &str,
    open: bool,
    f: impl Fn(&mut State) + 'static,
) -> El {
    let p = pal(s.dark);
    row()
        .key(key.to_string())
        .role("button")
        .label(format!("{title} {hint}"))
        .checked(open)
        .focusable(true)
        .press_on_return()
        .gap(8.0)
        .min_h(22.0)
        .center_y()
        .on_press(f)
        .child(chevron(s, open))
        .child(
            text(title.to_string())
                .font(rune::TextStyle::new(14.0, 600.0))
                .color(p.ink),
        )
        .child(
            text(hint.to_string())
                .font(rune::TextStyle::new(13.0, 400.0))
                .color(p.t.ink3)
                .ml(8.0),
        )
}
fn add_dialog(s: &State, a: &Add) -> El {
    let p = pal(s.dark);
    let saving = matches!(s.queue_page.pending, Some(Pending::Added { .. }));
    let mut body = col()
        .min_w(0.0)
        .child(modal_header(s, "add-close", "Nieuwe loper", request_close))
        .child(
            row()
                .gap(12.0)
                .mb(16.0)
                .child(labelled(
                    s,
                    "Lopersnummer",
                    add_field!(s, a, number, "add-number", "Lopersnummer", ""),
                ))
                .child(labelled(
                    s,
                    "Naam",
                    add_field!(s, a, name, "add-name", "Naam", ""),
                )),
        );
    // Labels by kind, speedteams first; a runner runs for one speedteam.
    let mut labels: Vec<&Value> = s.snapshot["labels"]
        .as_array()
        .into_iter()
        .flatten()
        .collect();
    let order = |k: &str| match k {
        "speedteam" => 0,
        "zustervereniging" | "association" => 1,
        "andere" | "group" => 2,
        _ => 3,
    };
    labels.sort_by(|x, y| {
        order(st(x, "kind")).cmp(&order(st(y, "kind"))).then(
            st(x, "name")
                .to_lowercase()
                .cmp(&st(y, "name").to_lowercase()),
        )
    });
    let mut groups = col().gap(16.0).mb(16.0);
    let mut i = 0;
    while i < labels.len() {
        let kind = st(labels[i], "kind").to_string();
        let title = match kind.as_str() {
            "speedteam" => "Speedteams",
            "zustervereniging" | "association" => "Zusterverenigingen",
            "andere" | "group" => "Andere",
            _ => "Custom",
        };
        let mut group = col().child(
            text(title)
                .font(rune::TextStyle::new(14.0, 500.0).lh(17.5))
                .color(p.t.ink2)
                .mb(2.0),
        );
        if kind == "speedteam" {
            group = group.child(
                text("Kies maximaal 1 optie.")
                    .font(rune::TextStyle::new(12.5, 400.0).lh(18.75))
                    .color(p.t.ink3)
                    .mb(8.0),
            );
        }
        let mut picker = row().gap(6.0).flex_wrap();
        while i < labels.len() && st(labels[i], "kind") == kind {
            let l = labels[i];
            let id = st(l, "id").to_string();
            let on = a.labels.contains(&id);
            let mut chip = row()
                .key(format!("add-label-{id}"))
                .role("checkbox")
                .label(st(l, "name").to_string())
                .checked(on)
                .focusable(true)
                .press_on_return()
                .h(30.0)
                .pl(8.0)
                .pr(10.0)
                .gap(6.0)
                .center_y()
                .radius(6.0)
                .fill(if on { p.brand_wash } else { p.surface })
                .border(
                    if on { 2.0 } else { 1.0 },
                    if on { p.brand } else { p.t.line2 },
                )
                .hover(if on { p.brand_wash } else { p.t.surface2 });
            if let Some(image) = l["imageUrl"].as_str().and_then(|url| s.logos.get(url)) {
                chip = chip.child(
                    rune::el()
                        .size(14.0, 14.0)
                        .pixels_fit(image.pixels(), rune::SurfaceFit::Fit),
                );
            } else {
                chip = chip.child(
                    rune::el()
                        .size(7.0, 7.0)
                        .radius(3.5)
                        .fill(rune::color::hex(st(l, "color")).unwrap_or(p.t.ink3)),
                );
            }
            chip = chip.child(
                text(st(l, "name").to_string())
                    .font(rune::TextStyle::new(13.0, 500.0))
                    .color(if on { p.brand_ink } else { p.ink }),
            );
            let speed = kind == "speedteam";
            let all_speed: Vec<String> = labels
                .iter()
                .filter(|x| st(x, "kind") == "speedteam")
                .map(|x| st(x, "id").to_string())
                .collect();
            picker = picker.child(chip.on_press(move |s: &mut State| {
                let a = add_mut(s);
                if a.labels.contains(&id) {
                    a.labels.retain(|x| *x != id);
                } else {
                    if speed {
                        a.labels.retain(|x| !all_speed.contains(x));
                    }
                    a.labels.push(id.clone());
                }
            }));
            i += 1;
        }
        groups = groups.child(group.child(picker));
    }
    body = body.child(groups);
    let section = || col().pt(12.0).border_sides([1.0, 0.0, 0.0, 0.0], p.line);
    let mut contact = section().child(disclosure(
        s,
        "add-contact",
        "Contact en beschikbaarheid",
        "Telefoon, e-mail en beschikbare uren",
        a.contact_open,
        |s| {
            let a = add_mut(s);
            a.contact_open = !a.contact_open;
        },
    ));
    if a.contact_open {
        contact = contact
            .child(
                row()
                    .gap(12.0)
                    .my(16.0)
                    .child(
                        labelled(
                            s,
                            "Telefoon",
                            add_field!(s, a, phone, "add-phone", "Telefoon", ""),
                        )
                        .w(0.0),
                    )
                    .child(
                        labelled(
                            s,
                            "E-mail",
                            add_field!(s, a, email, "add-email", "E-mail", ""),
                        )
                        .w(0.0),
                    ),
            )
            .child(hours_picker(s, &a.hours));
    }
    let mut extra = section().mt(16.0).child(disclosure(
        s,
        "add-extra",
        "Extra gegevens",
        "Historische tijden en notities",
        a.extra_open,
        |s| {
            let a = add_mut(s);
            a.extra_open = !a.extra_open;
        },
    ));
    if a.extra_open {
        let pair = |m: El, sec: El| {
            row()
                .gap(8.0)
                .child(m.w(0.0).grow(1.0))
                .child(sec.w(0.0).grow(1.0))
        };
        extra = extra
            .child(
                row()
                    .gap(12.0)
                    .my(16.0)
                    .child(labelled(
                        s,
                        "Historisch gemiddelde",
                        pair(
                            add_field!(
                                s,
                                a,
                                avg_min,
                                "add-avg-min",
                                "Historisch gemiddelde minuten",
                                "min"
                            ),
                            add_field!(
                                s,
                                a,
                                avg_sec,
                                "add-avg-sec",
                                "Historisch gemiddelde seconden",
                                "sec"
                            ),
                        ),
                    ))
                    .child(labelled(
                        s,
                        "Historisch snelste",
                        pair(
                            add_field!(
                                s,
                                a,
                                best_min,
                                "add-best-min",
                                "Historisch snelste minuten",
                                "min"
                            ),
                            add_field!(
                                s,
                                a,
                                best_sec,
                                "add-best-sec",
                                "Historisch snelste seconden",
                                "sec"
                            ),
                        ),
                    )),
            )
            .child(labelled(
                s,
                "Notities",
                text_input(&a.notes, rune::TextStyle::new(13.5, 400.0).lh(20.25))
                    .key("add-notes")
                    .label("Notities")
                    .min_h(88.0)
                    .px(10.0)
                    .py(8.0)
                    .w_full()
                    .radius(6.0)
                    .fill(p.surface)
                    .color(p.ink)
                    .border(1.0, p.t.line2)
                    .on_edit(|s: &mut State| &mut add_mut(s).notes),
            ));
    }
    body = body.child(contact).child(extra);
    if !a.error.is_empty() {
        body = body.child(
            text(a.error.clone())
                .font(rune::TextStyle::new(13.0, 500.0))
                .color(p.t.warn_ink)
                .role("alert")
                .mt(12.0),
        );
    }
    let mut cancel = btn(s, "add-cancel", "Annuleer", Kind::Ghost, false);
    let mut ok = btn(
        s,
        "add-save",
        if saving {
            "Opslaan..."
        } else if a.registered {
            "Loper toevoegen"
        } else {
            "Toevoegen aan opwarmen"
        },
        Kind::Primary,
        false,
    );
    if saving {
        cancel = cancel.disabled(true).opacity(0.6);
        ok = ok.disabled(true).opacity(0.6);
    } else {
        cancel = cancel.on_press(request_close);
        ok = ok.on_press(save);
    }
    body = body.child(
        row()
            .mt(20.0)
            .pt(16.0)
            .gap(8.0)
            .justify_end()
            .border_sides([1.0, 0.0, 0.0, 0.0], p.line)
            .child(cancel)
            .child(ok),
    );
    overlay(s, "add-overlay", request_close).child(
        sheet(s, "add-dialog", "Nieuwe loper", dialog_max_h(s))
            .scroll(ScrollSpec {
                stick_bottom: false,
            })
            .child(body),
    )
}
/// "Nieuwe loper sluiten?": a draft is lost on close, so ask first; Verder invullen is the safe default.
fn close_question(s: &State) -> El {
    let p = pal(s.dark);
    let back = |s: &mut State| add_mut(s).confirm_close = false;
    overlay(s, "add-close-overlay", back).child(
        col()
            .key("add-close-dialog")
            .role("dialog")
            .label("Nieuwe loper sluiten?")
            .w(420.0)
            .max_w(420.0)
            .padding(20.0)
            .radius(10.0)
            .fill(p.surface)
            .border(1.0, p.line)
            .child(
                text("Nieuwe loper sluiten?")
                    .font(rune::TextStyle::new(16.0, 600.0).lh(20.0))
                    .color(p.ink)
                    .mb(6.0),
            )
            .child(
                text("Je invoer is nog niet opgeslagen en gaat verloren.")
                    .font(rune::TextStyle::new(13.5, 400.0).lh(20.0))
                    .color(p.t.ink2)
                    .wrap(),
            )
            .child(
                row()
                    .mt(20.0)
                    .gap(8.0)
                    .justify_end()
                    .child(
                        btn(s, "add-close-cancel", "Verder invullen", Kind::Plain, false)
                            .autofocus()
                            .on_press(back),
                    )
                    .child(
                        row()
                            .key("add-close-confirm")
                            .role("button")
                            .label("Sluiten zonder opslaan")
                            .focusable(true)
                            .press_on_return()
                            .h(34.0)
                            .px(12.0)
                            .center()
                            .radius(6.0)
                            .fill(p.t.stop)
                            .border(1.0, p.t.stop)
                            .on_press(|s: &mut State| s.queue_page.dialog = None)
                            .child(
                                text("Sluiten zonder opslaan")
                                    .font(rune::TextStyle::new(13.5, 500.0))
                                    .color(p.on_brand),
                            ),
                    ),
            ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune::{Env, Runtime};
    use std::sync::{Arc, Mutex};

    fn update(rt: &mut Runtime<State>, predicate: impl Fn(&State) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !predicate(&rt.state) {
            assert!(
                Instant::now() < deadline,
                "UI did not settle: {}",
                rt.state.error
            );
            rt.update_if(|state, tx| super::super::poll(state, 0.0, tx));
            rt.frame(1.0 / 60.0);
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn click(rt: &mut Runtime<State>, key: &str) {
        rt.frame(1.0 / 60.0);
        let (x, y) = rt
            .find(key)
            .unwrap_or_else(|| panic!("Missing UI control {key}"));
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(1.0 / 60.0);
    }
    fn start() -> (Runtime<State>, Arc<Mutex<crate::db::Db>>) {
        let db = Arc::new(Mutex::new(
            crate::db::Db::open(std::path::Path::new(":memory:")).unwrap(),
        ));
        let socket = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = socket.local_addr().unwrap().port();
        drop(socket);
        std::mem::forget(crate::server::start(db.clone(), port).unwrap());
        let mut state = init_with_url(format!("http://127.0.0.1:{port}"));
        state.page = 1;
        let mut rt = Runtime::new(
            state,
            view,
            (1366.0, 768.0),
            Env {
                system_dark: false,
                scale: 1.0,
            },
        );
        rt.frame(0.0);
        update(&mut rt, |s| s.connected);
        (rt, db)
    }

    #[test]
    fn hour_blocks_split_and_merge_like_set_hour_block() {
        let on = set_hour(&[], "dinsdag", 21, true);
        assert_eq!(on, vec!["21-22u (dinsdag)"]);
        let two = set_hour(&on, "dinsdag", 20, true);
        assert_eq!(two, vec!["20-21u (dinsdag)", "21-22u (dinsdag)"]);
        // Clearing one hour out of a stretch keeps the rest of it.
        assert_eq!(
            set_hour(&["20-23u".into()], "dinsdag", 21, false),
            vec!["20-21u", "22-23u"]
        );
    }

    #[test]
    fn new_runner_hour_grid_saves_the_pressed_hours() {
        let (mut rt, db) = start();
        click(&mut rt, "queue-add");
        add_mut(&mut rt.state).name = TextEdit::new("Uurtje Test");
        click(&mut rt, "add-contact");
        click(&mut rt, "add-hour-dinsdag-21");
        click(&mut rt, "add-hour-woensdag-3");
        assert_eq!(
            add_mut(&mut rt.state).hours,
            vec!["21-22u (dinsdag)", "03-04u (woensdag)"]
        );
        click(&mut rt, "add-hour-woensdag-3");
        assert_eq!(add_mut(&mut rt.state).hours, vec!["21-22u (dinsdag)"]);
        // Toevoegen sits below the fold of the taller dialog; press it the way its button does.
        rt.update_if(|s, _| {
            save(s);
            true
        });
        update(&mut rt, |s| s.queue_page.dialog.is_none() && !s.busy);
        let row = db
            .lock()
            .unwrap()
            .one(
                "SELECT registration_json AS r FROM runners WHERE name='Uurtje Test'",
                &[],
            )
            .unwrap();
        let reg: Value = serde_json::from_str(row["r"].as_str().unwrap()).unwrap();
        assert_eq!(reg["availableHours"], json!(["21-22u (dinsdag)"]));
    }

    #[test]
    fn dragging_across_hour_slots_sets_them_all() {
        let (mut rt, _db) = start();
        click(&mut rt, "queue-add");
        click(&mut rt, "add-contact");
        rt.frame(1.0 / 60.0);
        let (x0, y0) = rt.find("add-hour-dinsdag-21").unwrap();
        let (x1, y1) = rt.find("add-hour-dinsdag-22").unwrap();
        let (x2, y2) = rt.find("add-hour-dinsdag-23").unwrap();
        rt.pointer_down(x0, y0);
        rt.pointer_move(x1, y1);
        rt.pointer_move(x2, y2);
        rt.pointer_up(x2, y2);
        rt.frame(1.0 / 60.0);
        let hours = add_mut(&mut rt.state).hours.clone();
        assert_eq!(
            hours,
            vec!["21-22u (dinsdag)", "22-23u (dinsdag)", "23-00u (dinsdag)"]
        );
        // Starting on a set slot clears instead, and the release doesn't toggle it back.
        rt.pointer_down(x1, y1);
        rt.pointer_move(x2, y2);
        rt.pointer_up(x2, y2);
        rt.frame(1.0 / 60.0);
        assert_eq!(add_mut(&mut rt.state).hours, vec!["21-22u (dinsdag)"]);
        click(&mut rt, "add-hour-dinsdag-21");

        assert!(add_mut(&mut rt.state).hours.is_empty());
    }

    #[test]
    fn the_runner_after_volgende_is_tagged_without_turn_times() {
        let (mut rt, db) = start();
        {
            let mut db = db.lock().unwrap();
            for name in ["Anna", "Bram", "Cas", "Dirk"] {
                db.mutation("runners.create", &json!({"name":name,"status":"waiting"}))
                    .unwrap();
            }
            let race = db.race().unwrap();
            db.mutation("race.handoff", &json!({"activeRunnerId":race["activeRunnerId"],"activeStartedAt":race["activeStartedAt"],"pressedAt":crate::db::now()})).unwrap();
            db.exec("UPDATE runners SET historical_avg_ms=90000", &[])
                .unwrap();
        }
        update(&mut rt, |s| waiting(s).len() == 3);
        let ids: Vec<String> = waiting(&rt.state)
            .iter()
            .map(|r| st(r, "id").to_string())
            .collect();
        rt.frame(1.0 / 60.0);
        assert!(rt.find(&format!("queue-then-{}", ids[1])).is_some());
        assert!(rt.find(&format!("queue-then-{}", ids[0])).is_none());
        assert!(rt.find(&format!("queue-then-{}", ids[2])).is_none());
        // Apolloon plans turns on paper: no turn times or warm-up prompts here.
        for id in &ids {
            assert!(rt.find(&format!("queue-eta-{id}")).is_none());
        }
        assert!(rt.find("queue-warm-up-nudge").is_none());
    }

    #[test]
    fn call_dialog_shows_a_qr_with_the_tel_link() {
        assert_eq!(phone_href(" +32 470 12 34 56 "), "tel:+32470123456");
        let (mut rt, _db) = start();
        rt.update_if(|s, _| {
            s.queue_page.dialog = Some(Dialog::Call("12 Fien".into(), "0470 12 34 56".into()));
            true
        });
        rt.frame(1.0 / 60.0);
        assert!(rt.find("call-qr").is_some());
        click(&mut rt, "call-close");
        assert!(rt.state.queue_page.dialog.is_none());
    }
}
