//! Analyse: label scope on the left, figures, charts and tables on the right. Port of
//! src/components/AnalysisView.tsx, src/components/analysis/* and src/lib/analysis.ts; sizes are
//! the reference's at 1366×768 (src/styles/analysis.css). Charts are drawn with Rune shapes the
//! way Chart.js lays them out (same nice ticks, legend, axis titles).
use super::chart_axis::{LabelSlot, visible_labels};
use super::*;
use rune::{Align, Color, Path, Shape, canvas, color::hex, el, oklch};
use std::collections::{HashMap, HashSet};

const MIN_LAP_MS: i64 = 20_000;
const MAX_PLAUSIBLE_LAP_MS: i64 = 600_000;
const HOUR: i64 = 3_600_000;

pub(super) struct Page {
    /// 0 Wedstrijd, 1 Lopers, 2 Ploegen.
    pub(super) section: u8,
    /// None: every label on (unlabeled laps too).
    pub(super) enabled: Option<Vec<String>>,
    pub(super) search: TextEdit,
    /// 0 laps, 1 average, 2 best, 3 consistency.
    pub(super) sort: u8,
    /// 0 day, 1 two hours, 2 hour.
    pub(super) window: u8,
    pub(super) export_open: bool,
}
impl Default for Page {
    fn default() -> Self {
        Page {
            section: 0,
            enabled: None,
            search: TextEdit::new(""),
            sort: 0,
            window: 0,
            export_open: false,
        }
    }
}

// ---------- Palette ----------

struct Pal {
    ink: Color,
    ink2: Color,
    ink3: Color,
    line: Color,
    line2: Color,
    surface: Color,
    surface2: Color,
    surface3: Color,
    brand: Color,
    chart_text: Color,
    chart_muted: Color,
    chart_grid: Color,
    live: Color,
    live_fill: Color,
    strong: Color,
}
fn pal(dark: bool) -> Pal {
    let t = tok::theme(dark);
    let c = tok::tones(dark);
    let h = |v: &str| hex(v).unwrap();
    Pal {
        ink: t.text,
        ink2: c.ink2,
        ink3: c.ink3,
        line: t.card_border,
        line2: c.line2,
        surface: t.card,
        surface2: c.surface2,
        surface3: c.surface3,
        brand: oklch(0.57, 0.2, 264.0),
        chart_text: h(if dark { "#BDBDBD" } else { "#52525B" }),
        chart_muted: h(if dark { "#8C8C8C" } else { "#71717A" }),
        chart_grid: h(if dark { "#2A2A2A" } else { "#EDEDEF" }),
        live: h(if dark { "#3D9BF0" } else { "#0D78D3" }),
        live_fill: if dark {
            hex("#3D9BF0").unwrap().alpha(0.2)
        } else {
            hex("#0D78D3").unwrap().alpha(0.16)
        },
        strong: h(if dark { "#ECECEC" } else { "#18181B" }),
    }
}

// ---------- Data (src/lib/analysis.ts) ----------

fn st<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn n(v: &Value, key: &str) -> i64 {
    v[key].as_i64().unwrap_or(0)
}
fn plausible(lap: &Value) -> bool {
    let d = n(lap, "durationMs");
    lap["durationMs"].is_number() && (MIN_LAP_MS..=MAX_PLAUSIBLE_LAP_MS).contains(&d)
}
fn kind_order(kind: &str) -> u8 {
    match kind {
        "speedteam" => 0,
        "zustervereniging" | "association" => 1,
        "andere" | "group" => 2,
        _ => 3,
    }
}
fn kind_title(kind: &str) -> &'static str {
    match kind_order(kind) {
        0 => "Speedteams",
        1 => "Zusterverenigingen",
        2 => "Andere",
        _ => "Custom",
    }
}
fn compare_labels(a: &Value, b: &Value) -> std::cmp::Ordering {
    kind_order(st(a, "kind"))
        .cmp(&kind_order(st(b, "kind")))
        .then_with(|| {
            st(a, "name")
                .to_lowercase()
                .cmp(&st(b, "name").to_lowercase())
        })
}
/// collectRankingLabels: labels on laps, overridden by the current ones, in label order.
fn analysis_labels(s: &State) -> Vec<Value> {
    let mut by_id: Vec<(String, Value)> = Vec::new();
    let mut put = |label: &Value| {
        let id = st(label, "id").to_string();
        match by_id.iter_mut().find(|(k, _)| *k == id) {
            Some(slot) => slot.1 = label.clone(),
            None => by_id.push((id, label.clone())),
        }
    };
    for lap in laps(s) {
        for label in lap["labels"].as_array().into_iter().flatten() {
            put(label);
        }
    }
    for label in s.snapshot["labels"].as_array().into_iter().flatten() {
        put(label);
    }
    let mut labels: Vec<Value> = by_id.into_iter().map(|(_, v)| v).collect();
    labels.sort_by(compare_labels);
    labels
}
fn filter_laps<'a>(all: &[&'a Value], enabled: &Option<Vec<String>>) -> Vec<&'a Value> {
    let Some(ids) = enabled else {
        return all.to_vec();
    };
    if ids.is_empty() {
        return Vec::new();
    }
    let ids: HashSet<&str> = ids.iter().map(String::as_str).collect();
    all.iter()
        .copied()
        .filter(|lap| {
            lap["labels"]
                .as_array()
                .is_some_and(|l| l.iter().any(|x| ids.contains(st(x, "id"))))
        })
        .collect()
}
/// toggleLabelFilter: turning every label back on means "all laps" again.
pub(super) fn toggle(
    current: &Option<Vec<String>>,
    id: &str,
    all: &[String],
) -> Option<Vec<String>> {
    let mut ids = current.clone().unwrap_or_else(|| all.to_vec());
    if let Some(i) = ids.iter().position(|x| x == id) {
        ids.remove(i);
    } else {
        ids.push(id.to_string());
    }
    if all.iter().all(|a| ids.contains(a)) {
        None
    } else {
        Some(ids)
    }
}

#[derive(Default, Clone, Copy)]
struct Stats {
    average: Option<i64>,
    median: Option<i64>,
    best: Option<i64>,
    slowest: Option<i64>,
    deviation: Option<i64>,
    total: i64,
}
fn stats(laps: &[&Value]) -> Stats {
    let mut d: Vec<i64> = laps
        .iter()
        .filter(|l| plausible(l))
        .map(|l| n(l, "durationMs"))
        .collect();
    d.sort_unstable();
    let count = d.len();
    let total: i64 = d.iter().sum();
    if count == 0 {
        return Stats {
            total,
            ..Default::default()
        };
    }
    let average = (total as f64 / count as f64).round() as i64;
    let mid = count / 2;
    let median = if count % 2 == 1 {
        d[mid]
    } else {
        ((d[mid - 1] + d[mid]) as f64 / 2.0).round() as i64
    };
    let deviation = (count > 1).then(|| {
        let var = d
            .iter()
            .map(|x| ((x - average) as f64).powi(2))
            .sum::<f64>()
            / count as f64;
        var.sqrt().round() as i64
    });
    Stats {
        average: Some(average),
        median: Some(median),
        best: Some(d[0]),
        slowest: Some(d[count - 1]),
        deviation,
        total,
    }
}
fn start_of(s: &State, laps: &[&Value]) -> Option<i64> {
    s.snapshot["race"]["raceStartedAt"]
        .as_i64()
        .or_else(|| laps.iter().map(|l| n(l, "finishedAt")).min())
}
struct Kpis {
    stats: Stats,
    count: usize,
    per_hour: Option<f64>,
    projected: Option<i64>,
    under_minute: usize,
    over_limit: usize,
}
fn kpis(s: &State, laps: &[&Value]) -> Kpis {
    let start = start_of(s, laps);
    let end = s.snapshot["race"]["raceFinishedAt"]
        .as_i64()
        .or_else(|| laps.iter().map(|l| n(l, "finishedAt")).max());
    let elapsed = match (start, end) {
        (Some(a), Some(b)) => (b - a).max(0),
        _ => 0,
    };
    let per_hour = (elapsed > 0).then(|| laps.len() as f64 / (elapsed as f64 / HOUR as f64));
    Kpis {
        stats: stats(laps),
        count: laps.len(),
        per_hour,
        projected: per_hour.map(|p| (p * 24.0).round() as i64),
        under_minute: laps.iter().filter(|l| n(l, "durationMs") < 60_000).count(),
        over_limit: laps
            .iter()
            .filter(|l| n(l, "durationMs") > MAX_PLAUSIBLE_LAP_MS)
            .count(),
    }
}
fn brussels_hour(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| {
            d.with_timezone(&chrono_tz::Europe::Brussels)
                .format("%H")
                .to_string()
        })
        .unwrap_or_default()
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
struct Bucket {
    label: String,
    count: usize,
    average: Option<i64>,
}
fn time_buckets(s: &State, laps: &[&Value]) -> Vec<Bucket> {
    let Some(start) = start_of(s, laps) else {
        return Vec::new();
    };
    let mut map: std::collections::BTreeMap<i64, (usize, usize, i64)> = Default::default();
    for lap in laps {
        let hour = ((n(lap, "finishedAt") - start) as f64 / HOUR as f64)
            .floor()
            .max(0.0) as i64;
        let b = map.entry(hour).or_default();
        b.0 += 1;
        if plausible(lap) {
            b.1 += 1;
            b.2 += n(lap, "durationMs");
        }
    }
    map.into_iter()
        .map(|(hour, (count, timed, total))| {
            let at = start + hour * HOUR;
            Bucket {
                label: format!("{}u-{}u", brussels_hour(at), brussels_hour(at + HOUR)),
                count,
                average: (timed > 0).then(|| (total as f64 / timed as f64).round() as i64),
            }
        })
        .collect()
}
/// buildRollingLapTrend: (race hour, rolling one-hour average).
fn rolling_trend(s: &State, laps: &[&Value]) -> Vec<(f64, i64)> {
    let Some(start) = start_of(s, laps) else {
        return Vec::new();
    };
    let mut sorted: Vec<&Value> = laps.iter().copied().filter(|l| plausible(l)).collect();
    sorted.sort_by_key(|l| n(l, "finishedAt"));
    let window = 60 * 60_000;
    let mut points = Vec::new();
    let (mut first, mut total, mut g) = (0usize, 0i64, 0usize);
    while g < sorted.len() {
        let at = n(sorted[g], "finishedAt");
        let mut end = g;
        while end < sorted.len() && n(sorted[end], "finishedAt") == at {
            total += n(sorted[end], "durationMs");
            end += 1;
        }
        while first < end && n(sorted[first], "finishedAt") < at - window {
            total -= n(sorted[first], "durationMs");
            first += 1;
        }
        let count = end - first;
        let avg = (total as f64 / count.max(1) as f64).round() as i64;
        for lap in &sorted[g..end] {
            let hour = ((n(lap, "finishedAt") - start) as f64 / HOUR as f64).max(0.0);
            points.push((hour, if count > 0 { avg } else { n(lap, "durationMs") }));
        }
        g = end;
    }
    points
}
fn distribution(laps: &[&Value]) -> Vec<(String, usize)> {
    let mmss = |ms: i64| format!("{}:{:02}", ms / 60_000, ms / 1000 % 60);
    let mut bins: Vec<(String, usize)> = (0..6)
        .map(|i| {
            let min = 60_000 + i * 5_000;
            (format!("{}-{}", mmss(min), mmss(min + 5_000)), 0)
        })
        .collect();
    bins.push(("1:30+".into(), 0));
    for lap in laps {
        let d = n(lap, "durationMs");
        if d < 60_000 || !plausible(lap) {
            continue;
        }
        let i = (((d - 60_000) / 5_000) as usize).min(bins.len() - 1);
        bins[i].1 += 1;
    }
    bins
}
fn fastest_windows<'a>(s: &State, laps: &[&'a Value], mode: u8) -> Vec<(String, &'a Value)> {
    let timed: Vec<&Value> = laps.iter().copied().filter(|l| plausible(l)).collect();
    let faster = |a: &Value, b: &Value| {
        (n(a, "durationMs"), n(a, "finishedAt")) < (n(b, "durationMs"), n(b, "finishedAt"))
    };
    if timed.is_empty() {
        return Vec::new();
    }
    if mode == 0 {
        let mut best = timed[0];
        for lap in &timed {
            if faster(lap, best) {
                best = lap;
            }
        }
        return vec![("Dagrecord".into(), best)];
    }
    let Some(start) = start_of(s, laps) else {
        return Vec::new();
    };
    let hours = if mode == 2 { 1 } else { 2 };
    let mut map: std::collections::BTreeMap<i64, &Value> = Default::default();
    for lap in timed {
        let i = ((n(lap, "finishedAt") - start) as f64 / (hours * HOUR) as f64)
            .floor()
            .max(0.0) as i64;
        match map.get(&i) {
            Some(cur) if !faster(lap, cur) => {}
            _ => {
                map.insert(i, lap);
            }
        }
    }
    map.into_iter()
        .map(|(i, lap)| (format!("{}u-{}u", i * hours, i * hours + hours), lap))
        .collect()
}
struct Insight {
    id: String,
    number: String,
    name: String,
    stats: Stats,
    count: usize,
}
fn runner_insights(s: &State, laps: &[&Value]) -> Vec<Insight> {
    let mut by_runner: Vec<(String, Vec<&Value>)> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for lap in laps {
        let id = st(lap, "runnerId").to_string();
        let i = *index.entry(id.clone()).or_insert_with(|| {
            by_runner.push((id, Vec::new()));
            by_runner.len() - 1
        });
        by_runner[i].1.push(lap);
    }
    let mut out: Vec<Insight> = by_runner
        .into_iter()
        .map(|(id, list)| {
            let runner = runners(s).into_iter().find(|r| st(r, "id") == id);
            let first = list.iter().min_by_key(|l| n(l, "finishedAt")).copied();
            let number = runner
                .and_then(|r| r["runnerNumber"].as_str())
                .or_else(|| first.and_then(|l| l["runnerNumber"].as_str()))
                .unwrap_or("")
                .to_string();
            let name = runner
                .and_then(|r| r["name"].as_str())
                .or_else(|| first.and_then(|l| l["runnerName"].as_str()))
                .unwrap_or("Onbekende loper")
                .to_string();
            Insight {
                id,
                number,
                name,
                stats: stats(&list),
                count: list.len(),
            }
        })
        .collect();
    out.sort_by(|a, b| sort_key(a, b, 0));
    out
}
fn sort_key(a: &Insight, b: &Insight, mode: u8) -> std::cmp::Ordering {
    let asc = |x: Option<i64>, y: Option<i64>| x.unwrap_or(i64::MAX).cmp(&y.unwrap_or(i64::MAX));
    let more = b.count.cmp(&a.count);
    match mode {
        1 => asc(a.stats.average, b.stats.average).then(more),
        2 => asc(a.stats.best, b.stats.best).then(more),
        3 => asc(a.stats.deviation, b.stats.deviation).then(more),
        _ => more.then(asc(a.stats.average, b.stats.average)),
    }
}
fn fold(text: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    text.nfd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .collect::<String>()
        .to_lowercase()
}

fn dur(ms: Option<i64>) -> String {
    public_screens::format_duration(ms)
}
fn number_nl(v: Option<f64>, digits: usize) -> String {
    match v {
        None => "-".into(),
        Some(v) if v.is_nan() => "-".into(),
        Some(v) if digits == 0 => public_screens::format_int(v.round() as i64),
        Some(v) => public_screens::format_points(v),
    }
}

// ---------- Header ----------

pub(super) fn header_meta(s: &State) -> El {
    let all = laps(s);
    let labels = analysis_labels(s);
    let filtered = filter_laps(&all, &s.analysis_page.enabled);
    let on = enabled_count(s, &labels);
    shell::header_tag(
        &format!(
            "{} van {} rondes, {} van {} labels",
            filtered.len(),
            all.len(),
            on,
            labels.len()
        ),
        filtered.len() < all.len(),
        false,
        s.dark,
    )
}
fn enabled_count(s: &State, labels: &[Value]) -> usize {
    match &s.analysis_page.enabled {
        None => labels.len(),
        Some(ids) => labels
            .iter()
            .filter(|l| ids.iter().any(|i| i == st(l, "id")))
            .count(),
    }
}
pub(super) fn header_actions(s: &State) -> Vec<El> {
    let c = tok::tones(s.dark);
    let mut b = shell::header_button("analysis-export", "Exporteren", Some("download"), s.dark)
        .on_press(|s: &mut State| s.analysis_page.export_open = !s.analysis_page.export_open);
    if s.analysis_page.export_open {
        b = b.fill(c.surface3);
    }
    vec![b]
}

const EXPORTS: [(&str, &str); 6] = [
    ("Excel: lopers, punten en rondes", "race.xlsx"),
    ("Rondes (CSV)", "laps.csv"),
    ("Rondes (JSON)", "laps.json"),
    ("Volledige toestand (JSON)", "current-state.json"),
    ("Gebeurtenissen (CSV)", "events.csv"),
    ("Gebeurtenissen (JSON)", "events.json"),
];
fn base_url() -> String {
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::env::var("APOLLOON_NATIVE_URL")
            .unwrap_or_else(|_| format!("http://127.0.0.1:{}", crate::port().unwrap_or(5174)))
    }
    #[cfg(target_arch = "wasm32")]
    {
        String::new()
    }
}
fn download(s: &mut State, tx: &mut Tx, file: &str) {
    s.analysis_page.export_open = false;
    let url = format!("{}/api/export/{file}", base_url());
    #[cfg(target_arch = "wasm32")]
    let result = tx.open_url_same_tab(&url);
    #[cfg(not(target_arch = "wasm32"))]
    let result = tx.open_url(&url);
    if result.is_err() {
        s.error = "De export kon niet geopend worden.".into();
    }
}

/// `.analysis-export__menu`: 300 wide under the header button.
pub(super) fn modal(s: &State) -> Option<El> {
    if s.page != 3 || !s.analysis_page.export_open {
        return None;
    }
    let p = pal(s.dark);
    let item = |i: usize, quiet: bool| {
        let (label, file) = EXPORTS[i];
        let mut b = row()
            .key(format!("export-{file}"))
            .role("link")
            .label(label)
            .focusable(true)
            .h(28.0)
            .px(10.0)
            .center_y()
            .radius(6.0)
            .border(1.0, if quiet { Color::TRANSPARENT } else { p.line2 })
            .fill(if quiet { Color::TRANSPARENT } else { p.surface })
            .hover(if quiet { p.surface3 } else { p.surface2 })
            .on_press_tx(move |s: &mut State, tx: &mut Tx| download(s, tx, file))
            .child(
                text(label)
                    .font(rune::TextStyle::new(13.0, 500.0))
                    .color(if quiet { p.ink2 } else { p.ink }),
            );
        if !quiet && !s.dark {
            b = b.shadow(1.0, 2.0, rune::oklcha(0.21, 0.006, 285.9, 0.05));
        }
        b
    };
    let mut menu = col()
        .key("analysis-export-menu")
        .role("menu")
        .label("Exporteren")
        .pin(None, Some(46.0), Some(24.0), None)
        .w(300.0)
        .padding(12.0)
        .gap(4.0)
        .radius(8.0)
        .fill(p.surface)
        .border(1.0, p.line)
        .shadow(8.0, 24.0, rune::oklcha(0.0, 0.0, 0.0, if s.dark { 0.5 } else { 0.12 }))
        .modal(true, |s: &mut State| s.analysis_page.export_open = false)
        .child(
            text("Exports bevatten altijd de volledige wedstrijd. De labelfilters op dit scherm tellen niet mee.")
                .font(rune::TextStyle::new(13.5, 400.0).lh(19.0))
                .color(p.ink2)
                .wrap()
                .min_w(0.0)
                .pb(8.0),
        )
        .child(item(0, false))
        .child(
            text("Voor MATLAB, R of andere scripts")
                .font(rune::TextStyle::new(12.5, 400.0))
                .color(p.ink3)
                .pt(8.0)
                .pb(8.0),
        );
    for i in 1..EXPORTS.len() {
        menu = menu.child(item(i, true));
    }
    Some(menu)
}

// ---------- Page ----------

fn section_header(title: &str, body: &str, p: &Pal, small: bool) -> El {
    col()
        .gap(4.0)
        .pb(12.0)
        .min_w(0.0)
        .child(
            text(title.to_string())
                .font(rune::TextStyle::new(14.0, 600.0).tracking(-0.14))
                .color(p.ink)
                .role("heading")
                .level(2),
        )
        .child(
            text(body.to_string())
                .font(
                    rune::TextStyle::new(if small { 12.5 } else { 14.0 }, 400.0).lh(if small {
                        19.0
                    } else {
                        21.0
                    }),
                )
                .color(p.ink3)
                .wrap()
                .min_w(0.0),
        )
}
fn panel(p: &Pal) -> El {
    col()
        .min_w(0.0)
        .padding(16.0)
        .radius(8.0)
        .fill(p.surface)
        .border(1.0, p.line)
}
fn empty_state(message: &str, p: &Pal) -> El {
    el().w_full()
        .min_h(160.0)
        .padding(20.0)
        .center()
        .radius(8.0)
        .border(1.5, p.line2)
        .child(
            text(message.to_string())
                .font(type_::BODY.lh(19.0))
                .color(p.ink2)
                .wrap()
                .align(Align::Center),
        )
}
fn segmented(s: &State, key: &str, options: &[&str], active: u8, set: fn(&mut State, u8)) -> El {
    let p = pal(s.dark);
    let mut bar = row()
        .key(key.to_string())
        .gap(2.0)
        .padding(2.0)
        .radius(6.0)
        .fill(p.surface2)
        .border(1.0, p.line)
        .self_start();
    for (i, label) in options.iter().enumerate() {
        let on = i as u8 == active;
        let mut b = row()
            .key(format!("{key}-{i}"))
            .role("button")
            .label(label.to_string())
            .focusable(true)
            .checked(on)
            .h(26.0)
            .px(10.0)
            .center()
            .radius(4.0)
            .hover(if on { p.surface } else { p.surface3 })
            .on_press(move |s: &mut State| set(s, i as u8))
            .child(
                text(label.to_string())
                    .font(rune::TextStyle::new(13.0, 500.0))
                    .color(if on { p.ink } else { p.ink2 }),
            );
        if on {
            b = b.fill(p.surface).border(1.0, p.line2);
        }
        bar = bar.child(b);
    }
    bar
}

fn label_mark(s: &State, label: &Value, on: bool) -> El {
    let alpha = if on { 1.0 } else { 0.45 };
    if let Some(image) = label["imageUrl"].as_str().and_then(|u| s.logos.get(u)) {
        el().size(16.0, 16.0)
            .opacity(alpha)
            .pixels_fit(image.pixels(), rune::SurfaceFit::Fit)
    } else {
        let color = hex(st(label, "color")).unwrap_or(tok::theme(s.dark).text);
        el().size(7.0, 7.0).radius(3.5).fill(color).opacity(alpha)
    }
}

fn scope(s: &State, labels: &[Value]) -> El {
    let p = pal(s.dark);
    let ghost = |key: &str, label: &str, f: fn(&mut State)| {
        row()
            .key(key.to_string())
            .role("button")
            .label(label.to_string())
            .focusable(true)
            .h(30.0)
            .px(10.0)
            .center()
            .radius(6.0)
            .border(1.0, p.line2)
            .hover(p.surface2)
            .on_press(f)
            .child(
                text(label.to_string())
                    .font(rune::TextStyle::new(13.5, 500.0))
                    .color(p.ink),
            )
    };
    let mut groups = col().gap(12.0);
    let enabled: Vec<String> = match &s.analysis_page.enabled {
        None => labels.iter().map(|l| st(l, "id").to_string()).collect(),
        Some(ids) => ids.clone(),
    };
    let mut i = 0;
    while i < labels.len() {
        let kind = kind_order(st(&labels[i], "kind"));
        let mut list = col();
        let title = kind_title(st(&labels[i], "kind"));
        while i < labels.len() && kind_order(st(&labels[i], "kind")) == kind {
            let label = &labels[i];
            let id = st(label, "id").to_string();
            let on = enabled.contains(&id);
            let name = st(label, "name").to_string();
            list = list.child(
                row()
                    .key(format!("analysis-label-{id}"))
                    .role("button")
                    .label(name.clone())
                    .checked(on)
                    .focusable(true)
                    .min_h(36.0)
                    .px(4.0)
                    .py(2.0)
                    .gap(12.0)
                    .center_y()
                    .radius(6.0)
                    .hover(p.surface2)
                    .on_press(move |s: &mut State| {
                        let all: Vec<String> = analysis_labels(s)
                            .iter()
                            .map(|l| st(l, "id").to_string())
                            .collect();
                        s.analysis_page.enabled = toggle(&s.analysis_page.enabled, &id, &all);
                    })
                    .child(
                        row()
                            .grow(1.0)
                            .min_w(0.0)
                            .gap(8.0)
                            .center_y()
                            .child(label_mark(s, label, on))
                            .child(
                                text(name)
                                    .font(rune::TextStyle::new(14.5, 500.0))
                                    .color(if on { p.ink } else { p.ink3 })
                                    .wrap()
                                    .min_w(0.0),
                            ),
                    )
                    .child(
                        row()
                            .size(34.0, 20.0)
                            .padding(3.0)
                            .radius(10.0)
                            .fill(if on { p.brand } else { p.line2 })
                            .child(el().w(if on { 14.0 } else { 0.0 }))
                            .child(el().size(14.0, 14.0).radius(7.0).fill(if on {
                                Color::WHITE
                            } else {
                                p.surface
                            })),
                    ),
            );
            i += 1;
        }
        groups = groups.child(
            col()
                .child(
                    text(title)
                        .font(rune::TextStyle::new(13.0, 600.0))
                        .color(p.ink3)
                        .pt(8.0)
                        .pb(4.0),
                )
                .child(list),
        );
    }
    panel(&p)
        .key("analysis-scope")
        .w(260.0)
        .child(
            section_header(
                "Labels",
                "Een ronde telt mee zodra één van haar labels aan staat.",
                &p,
                true,
            )
            .pb(0.0),
        )
        .child(
            row()
                .gap(6.0)
                .pt(12.0)
                .pb(8.0)
                .child(ghost("analysis-all-on", "Alles aan", |s| {
                    s.analysis_page.enabled = None
                }))
                .child(ghost("analysis-all-off", "Alles uit", |s| {
                    s.analysis_page.enabled = Some(Vec::new())
                })),
        )
        .child(groups)
}

fn stat_grid(cells: &[(&str, String)], p: &Pal) -> El {
    let mut grid = col()
        .min_w(0.0)
        .radius(8.0)
        .fill(p.surface)
        .border(1.0, p.line)
        .clip_rounded(8.0);
    for (r, chunk) in cells.chunks(4).enumerate() {
        let mut line = row().w_full();
        for (c, (label, value)) in chunk.iter().enumerate() {
            let size = if value.chars().count() >= 10 {
                21.0
            } else {
                23.2
            };
            line = line.child(
                col()
                    .w(0.0)
                    .grow(1.0)
                    .min_w(0.0)
                    .px(16.0)
                    .py(14.0)
                    .gap(4.0)
                    .border_sides(
                        [
                            0.0,
                            if c < 3 { 1.0 } else { 0.0 },
                            if r == 0 { 1.0 } else { 0.0 },
                            0.0,
                        ],
                        p.line,
                    )
                    .child(
                        text(label.to_string())
                            .font(type_::LABEL_REGULAR)
                            .color(p.ink3),
                    )
                    .child(
                        text(value.clone())
                            .font(
                                rune::TextStyle::new(size, 550.0)
                                    .lh(size * 1.2)
                                    .tracking(-0.02 * size),
                            )
                            .color(p.ink),
                    ),
            );
        }
        grid = grid.child(line);
    }
    grid
}

fn section_nav(s: &State, p: &Pal) -> El {
    let mut bar = row()
        .key("analysis-sections")
        .role("tablist")
        .label("Analyseonderdelen")
        .gap(20.0)
        .border_sides([0.0, 0.0, 1.0, 0.0], p.line);
    for (i, label) in ["Wedstrijd", "Lopers", "Ploegen"].iter().enumerate() {
        let on = s.analysis_page.section == i as u8;
        bar = bar.child(
            col()
                .key(format!("analysis-section-{i}"))
                .role("button")
                .label(label.to_string())
                .checked(on)
                .focusable(true)
                .h(38.0)
                .justify_center()
                .border_sides([0.0, 0.0, if on { 2.0 } else { 0.0 }, 0.0], p.ink)
                .on_press(move |s: &mut State| s.analysis_page.section = i as u8)
                .child(
                    text(label.to_string())
                        .font(rune::TextStyle::new(13.5, 500.0))
                        .color(if on { p.ink } else { p.ink3 }),
                ),
        );
    }
    bar
}

pub(super) fn page(s: &State) -> El {
    let p = pal(s.dark);
    let all = laps(s);
    let labels = analysis_labels(s);
    let filtered = filter_laps(&all, &s.analysis_page.enabled);
    let k = kpis(s, &filtered);
    let burgie = s.history["events"].as_array().map_or(0, |e| {
        e.iter().filter(|e| e["type"] == "burgie_gepakt").count()
    });
    let cells = [
        ("Rondes", k.count.to_string()),
        ("Gemiddelde ronde", dur(k.stats.average)),
        ("Mediaan", dur(k.stats.median)),
        ("Snelste", dur(k.stats.best)),
        (
            "Lopers met rondes",
            filtered
                .iter()
                .filter_map(|l| l["runnerId"].as_str())
                .collect::<std::collections::HashSet<_>>()
                .len()
                .to_string(),
        ),
        ("Rondes per uur", number_nl(k.per_hour, 1)),
        (
            "Projectie na 24 uur",
            number_nl(k.projected.map(|v| v as f64), 0),
        ),
        ("Burgie gepakt", burgie.to_string()),
    ];
    let enabled_labels: Vec<&Value> = labels
        .iter()
        .filter(|l| match &s.analysis_page.enabled {
            None => true,
            Some(ids) => ids.iter().any(|i| i == st(l, "id")),
        })
        .collect();
    let section = match s.analysis_page.section {
        1 => runners_section(s, &filtered, &p),
        2 => teams_section(s, &enabled_labels, &filtered, &p),
        _ => race_section(
            s,
            &filtered,
            &k,
            !labels.is_empty() && enabled_labels.is_empty(),
            &p,
        ),
    };
    let mut top = col().key("analysis-page").gap(20.0).pb(24.0);
    if s.history["laps"].is_null() {
        top = top.child(
            text("Racegeschiedenis wordt geladen...")
                .font(type_::BODY)
                .color(p.ink3)
                .role("status"),
        );
    }
    top.child(
        row()
            .gap(24.0)
            .items_start()
            .child(scope(s, &labels))
            .child(
                col()
                    .grow(1.0)
                    .min_w(0.0)
                    .gap(20.0)
                    .child(stat_grid(&cells, &p))
                    .child(section_nav(s, &p))
                    .child(section),
            ),
    )
}

fn warning(textv: String, s: &State) -> El {
    let c = tok::tones(s.dark);
    col()
        .w_full()
        .min_w(0.0)
        .padding(12.0)
        .radius(8.0)
        .fill(c.warn_wash)
        .border(1.0, c.warn_line)
        .child(
            text(textv)
                .font(type_::BODY.lh(19.0))
                .color(c.warn_ink)
                .wrap()
                .w_full()
                .min_w(0.0),
        )
}

fn race_section(s: &State, laps: &[&Value], k: &Kpis, no_labels: bool, p: &Pal) -> El {
    let buckets = time_buckets(s, laps);
    let trend = rolling_trend(s, laps);
    let mut pace = panel(p)
        .key("analysis-pace")
        .w(0.0)
        .grow(1.0)
        .child(section_header(
            "Rondes en tempo per uur",
            "Balken: aantal rondes per uur. Lijn: gemiddelde rondetijd in dat uur.",
            p,
            false,
        ));
    if buckets.is_empty() {
        pace = pace.child(empty_state(
            if no_labels {
                "Zet minstens een ploeg aan om de grafiek te tonen."
            } else {
                "Geen rondes binnen deze selectie."
            },
            p,
        ));
    } else {
        pace = pace.child(pace_chart(&buckets, p));
        if buckets.len() < 2 {
            pace = pace.child(
                text("Nog maar één uur met rondes. De trend wordt zichtbaar naarmate de race vordert.")
                    .font(rune::TextStyle::new(13.5, 400.0).lh(20.0))
                    .color(p.ink3)
                    .wrap()
                    .min_w(0.0)
                    .pt(8.0),
            );
        }
    }
    let mut trend_panel = panel(p)
        .key("analysis-trend")
        .w(0.0)
        .grow(1.0)
        .child(section_header(
            "Rondetijd over de race",
            "Voortschrijdend gemiddelde van de rondetijden.",
            p,
            false,
        ));
    trend_panel = if trend.is_empty() {
        trend_panel.child(empty_state("Geen rondes binnen deze selectie.", p))
    } else {
        trend_panel.child(trend_chart(&trend, p))
    };
    let mut out = col()
        .gap(20.0)
        .min_w(0.0)
        .child(row().gap(16.0).items_start().child(pace).child(trend_panel));
    if k.under_minute > 0 {
        out = out.child(warning(
            format!(
                "{} ronde(s) onder 1:00 gevonden. Die worden niet opgenomen in de verdeling.",
                k.under_minute
            ),
            s,
        ));
    }
    if k.over_limit > 0 {
        out = out.child(warning(format!("{} ronde(s) langer dan 10 minuten gevonden. Waarschijnlijk werd er niet gewisseld; die tijden tellen niet mee in gemiddelden, maximumtijden en grafieken.", k.over_limit), s));
    }
    // Rondeverdeling
    let bins = distribution(laps);
    let max = bins.iter().map(|b| b.1).max().unwrap_or(0).max(1);
    let mut hist = col().gap(8.0);
    for (label, count) in &bins {
        let frac = *count as f32 / max as f32;
        hist = hist.child(
            row()
                .gap(12.0)
                .center_y()
                .child(
                    text(label.clone())
                        .font(rune::TextStyle::new(13.5, 400.0))
                        .color(p.ink2)
                        .w(76.0),
                )
                .child(
                    row()
                        .grow(1.0)
                        .min_w(0.0)
                        .h(22.0)
                        .radius(3.0)
                        .fill(p.surface2)
                        .clip_rounded(3.0)
                        .child(
                            el().h_full()
                                .min_w(3.0)
                                .w(0.0)
                                .grow(frac.max(0.0001))
                                .fill(p.brand),
                        )
                        .child(el().h_full().w(0.0).grow((1.0 - frac).max(0.0001))),
                )
                .child(
                    text(count.to_string())
                        .font(rune::TextStyle::new(13.5, 700.0))
                        .color(p.ink2)
                        .w(40.0)
                        .align(Align::End),
                ),
        );
    }
    let windows = fastest_windows(s, laps, s.analysis_page.window);
    let mut fastest = panel(p)
        .w(0.0)
        .grow(1.0)
        .child(section_header(
            "Snelste rondes",
            "Binnen de huidige selectie.",
            p,
            false,
        ))
        .child(
            segmented(
                s,
                "analysis-window",
                &["Per dag", "Per 2 uur", "Per uur"],
                s.analysis_page.window,
                |s, i| s.analysis_page.window = i,
            )
            .mt(8.0)
            .mb(12.0),
        );
    if windows.is_empty() {
        fastest = fastest.child(empty_state("Geen rondes binnen deze selectie.", p));
    } else {
        let rows = windows
            .iter()
            .map(|(label, lap)| {
                let who = match st(lap, "runnerNumber") {
                    "" => st(lap, "runnerName").to_string(),
                    num => format!("{num} {}", st(lap, "runnerName")),
                };
                vec![
                    (label.clone(), false),
                    (who, false),
                    (n(lap, "lapNumber").to_string(), false),
                    (dur(Some(n(lap, "durationMs"))), true),
                    (clock_time(n(lap, "finishedAt")), false),
                ]
            })
            .collect();
        fastest = fastest.child(table(
            &["Periode", "Loper", "Ronde", "Tijd", "Moment"],
            rows,
            p,
        ));
    }
    out.child(
        row()
            .gap(16.0)
            .items_start()
            .child(
                panel(p)
                    .w(0.0)
                    .grow(1.0)
                    .child(section_header(
                        "Rondeverdeling",
                        "Aantal rondes per zone van 5 seconden.",
                        p,
                        false,
                    ))
                    .child(hist),
            )
            .child(fastest),
    )
}

/// A plain `table`: 12px medium muted heads, 13px cells, 7×10 padding, rules between rows.
fn table(heads: &[&str], rows: Vec<Vec<(String, bool)>>, p: &Pal) -> El {
    table_with(
        heads,
        rows.into_iter()
            .map(|r| r.into_iter().map(|(v, b)| cell_text(v, b, p)).collect())
            .collect(),
        p,
    )
}
fn cell_text(v: String, strong: bool, p: &Pal) -> El {
    text(v)
        .font(rune::TextStyle::new(
            13.0,
            if strong { 700.0 } else { 400.0 },
        ))
        .color(p.ink)
}
fn table_with(heads: &[&str], rows: Vec<Vec<El>>, p: &Pal) -> El {
    let cols = heads.len();
    let mut columns: Vec<El> = heads
        .iter()
        .map(|h| {
            col().min_w(0.0).child(
                row()
                    .h(31.0)
                    .px(10.0)
                    .center_y()
                    .border_sides([0.0, 0.0, 1.0, 0.0], p.line)
                    .child(
                        text(h.to_string())
                            .font(rune::TextStyle::new(12.0, 500.0))
                            .color(p.ink3),
                    ),
            )
        })
        .collect();
    for r in rows {
        for (i, cell) in r.into_iter().enumerate().take(cols) {
            let c = std::mem::replace(&mut columns[i], col());
            columns[i] = c.child(
                row()
                    .h(34.0)
                    .px(10.0)
                    .center_y()
                    .border_sides([0.0, 0.0, 1.0, 0.0], p.line)
                    .child(cell),
            );
        }
    }
    let mut grid = row().w_full().min_w(0.0);
    let last = columns.len().saturating_sub(1);
    for (i, c) in columns.into_iter().enumerate() {
        grid = grid.child(if i == last { c.grow(1.0) } else { c });
    }
    grid
}

fn runners_section(s: &State, laps: &[&Value], p: &Pal) -> El {
    let q = fold(s.analysis_page.search.text.trim());
    let mut insights: Vec<Insight> = runner_insights(s, laps)
        .into_iter()
        .filter(|i| q.is_empty() || fold(&i.name).contains(&q) || fold(&i.number).contains(&q))
        .collect();
    let mode = s.analysis_page.sort;
    insights.sort_by(|a, b| sort_key(a, b, mode));
    let search = text_input(
        &s.analysis_page.search,
        rune::TextStyle::new(13.5, 400.0).lh(18.0),
    )
    .single_line()
    .key("analysis-runner-search")
    .label("Zoek loper...")
    .role("searchbox")
    .placeholder("Zoek loper...", p.ink3)
    .w(300.0)
    .h(34.0)
    .px(10.0)
    .py(8.0)
    .radius(6.0)
    .fill(p.surface)
    .border(1.0, p.line2)
    .color(p.ink)
    .on_edit(|s: &mut State| &mut s.analysis_page.search);
    let body = if insights.is_empty() {
        row()
            .px(10.0)
            .py(7.0)
            .border_sides([0.0, 0.0, 1.0, 0.0], p.line)
            .child(
                text("Geen lopers met rondes binnen deze selectie.")
                    .font(type_::BODY)
                    .color(p.ink),
            )
    } else {
        let rows = insights
            .iter()
            .map(|i| {
                vec![
                    (
                        if i.number.is_empty() {
                            "-".into()
                        } else {
                            i.number.clone()
                        },
                        false,
                    ),
                    (i.name.clone(), false),
                    (i.count.to_string(), false),
                    (dur(Some(i.stats.total)), false),
                    (dur(i.stats.average), false),
                    (dur(i.stats.median), false),
                    (dur(i.stats.best), false),
                    (dur(i.stats.deviation), false),
                ]
            })
            .collect();
        table(
            &[
                "Nr.",
                "Naam",
                "Toeren",
                "Totaal",
                "Gem.",
                "Mediaan",
                "Snelste",
                "Spreiding",
            ],
            rows,
            p,
        )
        .key(format!(
            "runner-insights-{}",
            insights.first().map_or("", |i| i.id.as_str())
        ))
    };
    panel(p)
        .child(
            row()
                .gap(12.0)
                .items_start()
                .child(
                    section_header(
                        "Lopers",
                        "Binnen de huidige selectie. Sorteer op rondes, tempo of regelmaat.",
                        p,
                        false,
                    )
                    .grow(1.0),
                )
                .child(search),
        )
        .child(
            segmented(
                s,
                "analysis-sort",
                &[
                    "Meeste rondes",
                    "Snelste gem.",
                    "Snelste ronde",
                    "Consistent",
                ],
                mode,
                |s, i| s.analysis_page.sort = i,
            )
            .mt(8.0)
            .mb(12.0),
        )
        .child(body)
}

fn teams_section(s: &State, labels: &[&Value], laps: &[&Value], p: &Pal) -> El {
    let mut rows = Vec::new();
    for label in labels {
        let id = st(label, "id");
        let list: Vec<&Value> = laps
            .iter()
            .copied()
            .filter(|l| {
                l["labels"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|x| st(x, "id") == id))
            })
            .collect();
        if list.is_empty() {
            continue;
        }
        let stt = stats(&list);
        rows.push(vec![
            super::label_badge(label, s),
            cell_text(list.len().to_string(), false, p),
            cell_text(dur(stt.average), true, p),
            cell_text(dur(stt.median), false, p),
            cell_text(dur(stt.best), false, p),
            cell_text(dur(stt.slowest), false, p),
        ]);
    }
    let mut out = panel(p).child(section_header(
        "Gemiddelde per label",
        "Een loper kan in meerdere labels zitten, dus labels overlappen.",
        p,
        false,
    ));
    out = if rows.is_empty() {
        out.child(empty_state(
            "Geen labels met rondes binnen deze selectie.",
            p,
        ))
    } else {
        out.child(table_with(
            &[
                "Label",
                "Rondes",
                "Gemiddeld",
                "Mediaan",
                "Snelste",
                "Maximumtijd",
            ],
            rows,
            p,
        ))
    };
    out
}

// ---------- Charts (Chart.js geometry) ----------

/// Chart.js `niceNum` without rounding.
fn nice_num(range: f64) -> f64 {
    if range <= 0.0 {
        return 1.0;
    }
    let rounded = range.round();
    let range = if (range - rounded).abs() <= range / 1000.0 {
        rounded
    } else {
        range
    };
    let exp = 10f64.powf(range.log10().floor());
    let f = range / exp;
    let nf = if f <= 1.0 {
        1.0
    } else if f <= 2.0 {
        2.0
    } else if f <= 5.0 {
        5.0
    } else {
        10.0
    };
    nf * exp
}
/// Linear ticks as Chart.js generates them: (min, max, step).
fn nice_ticks(
    mut min: f64,
    mut max: f64,
    begin_at_zero: bool,
    max_ticks: usize,
    integer: bool,
) -> (f64, f64, f64) {
    if begin_at_zero {
        min = min.min(0.0);
        max = max.max(0.0);
    }
    if min == max {
        let off = if max == 0.0 { 1.0 } else { (max * 0.05).abs() };
        max += off;
        if !begin_at_zero {
            min -= off;
        }
    }
    let spaces = (max_ticks.max(2) - 1) as f64;
    let mut step = nice_num((max - min) / spaces);
    if integer {
        step = step.max(1.0).round();
    }
    let count = (max / step).ceil() - (min / step).floor();
    if count > spaces {
        step = nice_num(count * step / spaces);
        if integer {
            step = step.max(1.0).round();
        }
    }
    (
        (min / step).floor() * step,
        (max / step).ceil() * step,
        step,
    )
}
fn tick_values(min: f64, max: f64, step: f64) -> Vec<f64> {
    let count = ((max - min) / step).round() as usize;
    (0..=count).map(|i| min + i as f64 * step).collect()
}
/// Chart.js `splineCurve` (tension) through points in pixel space.
fn spline(points: &[[f32; 2]], tension: f32) -> Path {
    let mut path = Path::new().move_to(points[0]);
    if points.len() < 2 {
        return path;
    }
    let ctrl = |i: usize| -> ([f32; 2], [f32; 2]) {
        let p1 = points[i];
        let p0 = if i == 0 { p1 } else { points[i - 1] };
        let p2 = if i + 1 == points.len() {
            p1
        } else {
            points[i + 1]
        };
        let d01 = ((p1[0] - p0[0]).powi(2) + (p1[1] - p0[1]).powi(2)).sqrt();
        let d12 = ((p2[0] - p1[0]).powi(2) + (p2[1] - p1[1]).powi(2)).sqrt();
        let sum = d01 + d12;
        let (s01, s12) = if sum > 0.0 {
            (d01 / sum, d12 / sum)
        } else {
            (0.0, 0.0)
        };
        let (fa, fb) = (tension * s01, tension * s12);
        (
            [p1[0] - fa * (p2[0] - p0[0]), p1[1] - fa * (p2[1] - p0[1])],
            [p1[0] + fb * (p2[0] - p0[0]), p1[1] + fb * (p2[1] - p0[1])],
        )
    };
    for i in 1..points.len() {
        let (_, next) = ctrl(i - 1);
        let (prev, _) = ctrl(i);
        path = path.cubic_to(next, prev, points[i]);
    }
    path
}
fn chart_text(v: String, size: f32, weight: f32, color: Color) -> El {
    text(v)
        .font(rune::TextStyle::new(size, weight).lh(14.0))
        .color(color)
}
fn legend(items: &[(&str, Color, Color)], p: &Pal) -> El {
    let mut r = row()
        .w_full()
        .h(19.0)
        .gap(10.0)
        .justify_center()
        .items_start()
        .pt(3.0);
    for (label, fill, line) in items {
        r = r.child(
            row()
                .gap(6.0)
                .center_y()
                .child(el().size(14.0, 14.0).fill(*fill).border(1.0, *line))
                .child(chart_text(label.to_string(), 12.0, 500.0, p.chart_text)),
        );
    }
    r
}
fn axis_title(v: &str, h: f32, p: &Pal, clockwise: bool) -> El {
    let title = row().w(h).h(16.0).center();
    let title = title.rotate(if clockwise {
        std::f32::consts::FRAC_PI_2
    } else {
        -std::f32::consts::FRAC_PI_2
    });
    el().w(16.0).h(h).center().child(title.child(chart_text(
        v.to_string(),
        12.0,
        500.0,
        p.chart_muted,
    )))
}
/// Tick labels on a vertical axis, top to bottom, with an 8px tick mark toward the plot.
fn y_ticks(labels: Vec<String>, h: f32, p: &Pal, right: bool) -> El {
    let mut c = col().h(h + 14.0).justify_between();
    for l in labels {
        let mark = el().size(8.0, 1.0).fill(p.chart_grid);
        let label = chart_text(l, 12.0, 400.0, p.chart_muted);
        c = c.child(if right {
            row().h(14.0).gap(4.0).center_y().child(mark).child(label)
        } else {
            row()
                .h(14.0)
                .gap(4.0)
                .center_y()
                .justify_end()
                .child(label)
                .child(mark)
        });
    }
    c.items_stretch()
}

fn pace_chart(buckets: &[Bucket], p: &Pal) -> El {
    const H: f32 = 240.0;
    const W: f32 = 240.0;
    let max_count = buckets.iter().map(|b| b.count).max().unwrap_or(0) as f64;
    let (lmin, lmax, lstep) = nice_ticks(0.0, max_count, true, 11, true);
    let secs: Vec<f64> = buckets
        .iter()
        .filter_map(|b| b.average)
        .map(|a| a as f64 / 1000.0)
        .collect();
    let (smin, smax) = if secs.is_empty() {
        (0.0, 1.0)
    } else {
        (
            secs.iter().cloned().fold(f64::MAX, f64::min),
            secs.iter().cloned().fold(f64::MIN, f64::max),
        )
    };
    let (smin, smax, sstep) = nice_ticks(smin, smax, false, 11, false);
    let ly = |v: f64| H - ((v - lmin) / (lmax - lmin)) as f32 * H;
    let sy = |v: f64| H - ((v - smin) / (smax - smin)) as f32 * H;
    let cw = W / buckets.len() as f32;
    let mut shape = Shape::new().view_box(W, H);
    for v in tick_values(lmin, lmax, lstep) {
        let y = ly(v);
        shape = shape.stroke(vec![[0.0, y], [W, y]], 1.0, p.chart_grid);
    }
    shape = shape
        .stroke(vec![[0.0, 0.0], [0.0, H]], 1.0, p.chart_grid)
        .stroke(vec![[W, 0.0], [W, H]], 1.0, p.chart_grid);
    for (i, b) in buckets.iter().enumerate() {
        let bw = (cw * 0.54).min(160.0);
        let x0 = cw * (i as f32 + 0.5) - bw / 2.0;
        let top = ly(b.count as f64);
        let rect = vec![[x0, H], [x0, top], [x0 + bw, top], [x0 + bw, H]];
        shape = shape
            .fill(rect.clone(), p.live_fill)
            .stroke(rect, 1.0, p.live);
    }
    let pts: Vec<[f32; 2]> = buckets
        .iter()
        .enumerate()
        .filter_map(|(i, b)| {
            b.average
                .map(|a| [cw * (i as f32 + 0.5), sy(a as f64 / 1000.0)])
        })
        .collect();
    if pts.len() > 1 {
        shape = shape.stroke_path(&spline(&pts, 0.3), 3.0, rune::LineCap::Round, p.strong);
    }
    for pt in &pts {
        shape = shape.line(*pt, *pt, 8.0, rune::LineCap::Round, p.strong);
    }
    let left: Vec<String> = tick_values(lmin, lmax, lstep)
        .iter()
        .rev()
        .map(|v| format!("{}", v.round() as i64))
        .collect();
    let right: Vec<String> = tick_values(smin, smax, sstep)
        .iter()
        .rev()
        .map(|v| dur(Some((v * 1000.0).round() as i64)))
        .collect();
    let width = rune::memo::layout_with("pace-plot", |r| r[2]).unwrap_or_default();
    let mut xlabels = el().w_full().h(24.0).instant_changes();
    if width > 0.0 {
        let font = rune::TextStyle::new(12.0, 500.0).lh(14.0);
        let ticks: Vec<_> = buckets
            .iter()
            .enumerate()
            .map(|(i, b)| {
                LabelSlot::new(
                    width / buckets.len() as f32 * (i as f32 + 0.5),
                    [b.label.as_str()],
                    font,
                )
            })
            .collect();
        for i in visible_labels(&ticks) {
            xlabels = xlabels.child(
                row()
                    .key(format!("pace-tick-{i}"))
                    .w(ticks[i].width)
                    .justify_center()
                    .absolute(ticks[i].x - ticks[i].width / 2.0, 10.0)
                    .child(text(buckets[i].label.clone()).font(font).color(p.chart_muted)),
            );
        }
    }
    col()
        .key("pace-chart")
        .label("Rondes en tempo per uur")
        .w_full()
        .h(300.0)
        .child(legend(
            &[
                ("Rondes per uur", p.live_fill, p.live),
                ("Gemiddelde rondetijd", p.strong, p.strong),
            ],
            p,
        ))
        .child(
            row()
                .w_full()
                .items_start()
                .child(axis_title("Rondes per uur", H + 14.0, p, false).mr(4.0))
                .child(y_ticks(left, H, p, false))
                .child(
                    col()
                        .grow(1.0)
                        .min_w(0.0)
                        .mt(7.0)
                        .child(canvas(shape).key("pace-plot").w_full().h(H))
                        .child(xlabels),
                )
                .child(y_ticks(right, H, p, true))
                .child(axis_title("Gemiddelde rondetijd", H + 14.0, p, true).ml(4.0)),
        )
}

fn trend_chart(points: &[(f64, i64)], p: &Pal) -> El {
    const H: f32 = 215.0;
    const W: f32 = 270.0;
    let xs: Vec<f64> = points.iter().map(|p| p.0).collect();
    let ys: Vec<f64> = points.iter().map(|p| p.1 as f64 / 1000.0).collect();
    let fold = |v: &[f64], f: fn(f64, f64) -> f64, init: f64| v.iter().cloned().fold(init, f);
    let (xmin, xmax, xstep) = nice_ticks(
        fold(&xs, f64::min, f64::MAX),
        fold(&xs, f64::max, f64::MIN),
        false,
        7,
        false,
    );
    let (ymin, ymax, ystep) = nice_ticks(
        fold(&ys, f64::min, f64::MAX),
        fold(&ys, f64::max, f64::MIN),
        false,
        11,
        false,
    );
    let px = |v: f64| ((v - xmin) / (xmax - xmin)) as f32 * W;
    let py = |v: f64| H - ((v - ymin) / (ymax - ymin)) as f32 * H;
    let mut shape = Shape::new().view_box(W, H);
    for v in tick_values(ymin, ymax, ystep) {
        shape = shape.stroke(vec![[0.0, py(v)], [W, py(v)]], 1.0, p.chart_grid);
    }
    let x_ticks = tick_values(xmin, xmax, xstep);
    for &v in &x_ticks {
        shape = shape.stroke(vec![[px(v), 0.0], [px(v), H]], 1.0, p.chart_grid);
    }
    let pts: Vec<[f32; 2]> = xs.iter().zip(&ys).map(|(x, y)| [px(*x), py(*y)]).collect();
    shape = if pts.len() > 1 {
        shape.stroke_path(&spline(&pts, 0.32), 3.0, rune::LineCap::Round, p.live)
    } else {
        shape.line(pts[0], pts[0], 3.0, rune::LineCap::Round, p.live)
    };
    let left: Vec<String> = tick_values(ymin, ymax, ystep)
        .iter()
        .rev()
        .map(|v| dur(Some((v * 1000.0).round() as i64)))
        .collect();
    let width = rune::memo::layout_with("trend-plot", |r| r[2]).unwrap_or_default();
    let mut xlabels = el()
        .pin(Some(0.0), Some(H), Some(0.0), None)
        .h(26.0)
        .instant_changes();
    if width > 0.0 {
        let font = rune::TextStyle::new(12.0, 400.0).lh(14.0);
        let labels: Vec<_> = x_ticks
            .iter()
            .map(|v| {
                let minutes = (v * 60.0).round() as i64;
                format!("{}:{:02}", minutes / 60, minutes % 60)
            })
            .collect();
        let ticks: Vec<_> = x_ticks
            .iter()
            .zip(&labels)
            .map(|(&v, label)| LabelSlot::new(px(v) / W * width, [label.as_str()], font))
            .collect();
        for tick in &ticks {
            xlabels = xlabels.child(
                el().size(1.0, 8.0)
                    .fill(p.chart_grid)
                    .absolute(tick.x - 0.5, 0.0),
            );
        }
        for i in visible_labels(&ticks) {
            xlabels = xlabels.child(
                row()
                    .key(format!("trend-tick-{i}"))
                    .w(ticks[i].width)
                    .justify_center()
                    .absolute(ticks[i].x - ticks[i].width / 2.0, 12.0)
                    .child(text(labels[i].clone()).font(font).color(p.chart_muted)),
            );
        }
    }
    col()
        .key("trend-chart")
        .label("Rondetijd over de race")
        .w_full()
        .h(300.0)
        .child(legend(&[("Lopend gemiddelde", p.live, p.live)], p))
        .child(
            row()
                .w_full()
                .items_start()
                .child(axis_title("Gemiddelde rondetijd", H + 14.0, p, false).mr(4.0))
                .child(y_ticks(left, H, p, false))
                .child(
                    col()
                        .grow(1.0)
                        .min_w(0.0)
                        .mt(7.0)
                        .mr(16.0)
                        .h(H + 52.0)
                        .child(canvas(shape).key("trend-plot").w_full().h(H))
                        .child(xlabels)
                        .child(
                            row()
                                .pin(Some(0.0), Some(H + 34.0), Some(0.0), None)
                                .justify_center()
                                .child(chart_text(
                                    "Tijd sinds start (u:mm)".into(),
                                    12.0,
                                    500.0,
                                    p.chart_muted,
                                )),
                        ),
                ),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticks_match_chart_js() {
        assert_eq!(nice_ticks(0.0, 35.0, true, 11, true), (0.0, 35.0, 5.0));
        let (a, b, s) = nice_ticks(85.3, 85.3, false, 11, false);
        assert_eq!((a, b, s), (81.0, 90.0, 1.0));
        let (a, b, s) = nice_ticks(0.004, 0.83, false, 7, false);
        assert!(
            (a, b) == (0.0, 1.0) && (s - 0.2).abs() < 1e-9,
            "{a} {b} {s}"
        );
    }

    use rune::{Env, Runtime};
    use std::sync::{Arc, Mutex};

    #[test]
    fn chart_labels_follow_the_plot_when_the_window_resizes() {
        fn charts(_: &(), _: &mut rune::Cx<()>) -> El {
            let p = pal(false);
            let buckets: Vec<_> = (0..24)
                .map(|hour| Bucket {
                    label: format!("{hour}u-{}u", (hour + 1) % 24),
                    count: 42,
                    average: Some(82_000),
                })
                .collect();
            col().child(pace_chart(&buckets, &p)).child(trend_chart(
                &[(0.0, 81_000), (24.0, 83_000)],
                &p,
            ))
        }
        let mut rt = Runtime::new(
            (),
            charts,
            (1800.0, 768.0),
            Env {
                system_dark: false,
                scale: 1.0,
            },
        );
        for width in [1800.0, 220.0, 1800.0] {
            rt.set_viewport((width, 768.0), 1.0);
            for _ in 0..4 {
                rt.frame(1.0 / 60.0);
            }
            let elements = rt.elements();
            let rect = |key: &str| {
                elements
                    .iter()
                    .find(|el| !el.exiting && el.key.as_deref() == Some(key))
                    .map(|el| el.target)
            };
            for (axis, count) in [("pace", 24), ("trend", 6)] {
                let plot = rect(&format!("{axis}-plot")).unwrap();
                let ticks: Vec<_> = (0..count)
                    .filter_map(|i| rect(&format!("{axis}-tick-{i}")).map(|r| (i, r)))
                    .collect();
                if width == 1800.0 {
                    assert_eq!(ticks.len(), count, "{axis}");
                } else {
                    assert!((2..count).contains(&ticks.len()), "{axis}: {} labels", ticks.len());
                }
                for &(i, r) in &ticks {
                    let fraction = if axis == "pace" {
                        (i as f32 + 0.5) / count as f32
                    } else {
                        i as f32 / (count - 1) as f32
                    };
                    assert!((r[0] + r[2] / 2.0 - plot[0] - fraction * plot[2]).abs() < 1.1);
                }
                assert!(ticks.windows(2).all(|pair| {
                    let [(.., left), (.., right)] = pair else { unreachable!() };
                    left[0] + left[2] + 7.0 <= right[0]
                }));
            }
        }
    }

    #[test]
    fn race_warning_wraps_inside_the_panel() {
        const WARNING: &str = "1 ronde(s) langer dan 10 minuten gevonden. Die tijden tellen niet mee in de cijfers en in de grafieken van deze wedstrijd.";
        let state = init_with_url("http://127.0.0.1:1".into());
        let mut rt = Runtime::new(
            state,
            |s, _| col().child(warning(WARNING.into(), s).key("race-warning")),
            (480.0, 768.0),
            Env {
                system_dark: false,
                scale: 1.0,
            },
        );
        rt.frame(0.0);
        let elements = rt.elements();
        let panel = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("race-warning"))
            .unwrap()
            .target;
        let text = elements
            .iter()
            .find(|el| el.text.as_deref() == Some(WARNING))
            .unwrap()
            .target;
        assert!(text[3] >= 38.0, "warning did not wrap: {text:?}");
        assert!(text[0] + text[2] <= panel[0] + panel[2] - 12.0);
        assert!(text[1] + text[3] <= panel[1] + panel[3] - 12.0);
    }

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
    fn shown(s: &State) -> usize {
        filter_laps(&laps(s), &s.analysis_page.enabled).len()
    }

    #[test]
    fn analysis_filters_labels_switches_sections_and_exports_from_the_real_server() {
        let mut db = crate::db::Db::open(std::path::Path::new(":memory:")).unwrap();
        let mut ids = Vec::new();
        for (number, name) in [("1", "Mitras"), ("2", "Wout")] {
            ids.push(
                db.mutation(
                    "runners.create",
                    &json!({"runnerNumber":number,"name":name}),
                )
                .unwrap()["id"]
                    .clone(),
            );
        }
        db.exec("DELETE FROM labels", &[]).unwrap();
        let blue = r##"[{"id":"blue","icon":"SB","name":"Speedteam Blue","kind":"speedteam","color":"#2563eb"}]"##;
        let first = r##"[{"id":"first","icon":"1J","name":"1ste jaar","kind":"andere","color":"#16a34a"}]"##;
        let start = 1_700_000_000_000_i64;
        let mut t = start;
        for (i, (runner, ms, labels)) in [(0, 80_000, blue), (1, 70_000, first), (0, 90_000, blue)]
            .into_iter()
            .enumerate()
        {
            db.exec(
                "INSERT INTO laps(id,runner_id,lap_number,started_at,finished_at,duration_ms,source,created_at,labels_json) VALUES(?,?,?,?,?,?,'spacebar',?,?)",
                &[json!(format!("lap-{i}")), ids[runner].clone(), json!(i + 1), json!(t), json!(t + ms), json!(ms), json!(t + ms), json!(labels)],
            )
            .unwrap();
            t += ms;
        }
        let db = Arc::new(Mutex::new(db));
        let socket = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = socket.local_addr().unwrap().port();
        drop(socket);
        let _host = crate::server::start(db.clone(), port).unwrap();
        let mut state = super::super::init_with_url(format!("http://127.0.0.1:{port}"));
        state.page = 3;
        let mut rt = Runtime::new(
            state,
            super::super::view,
            (1366.0, 1080.0),
            Env {
                system_dark: false,
                scale: 1.0,
            },
        );
        rt.frame(0.0);
        update(&mut rt, |s| s.connected && laps(s).len() == 3);
        assert!(rt.find("pace-chart").is_some() && rt.find("trend-chart").is_some());

        // A label switch drops its laps; switching it back on means every lap again.
        click(&mut rt, "analysis-label-blue");
        assert_eq!(
            rt.state.analysis_page.enabled,
            Some(vec!["first".to_string()])
        );
        assert_eq!(shown(&rt.state), 1);
        click(&mut rt, "analysis-label-blue");
        assert_eq!(rt.state.analysis_page.enabled, None);
        click(&mut rt, "analysis-all-off");
        assert_eq!(shown(&rt.state), 0);
        rt.frame(1.0 / 60.0);
        assert!(
            rt.find("pace-chart").is_none(),
            "no labels on: the chart gives way to the empty state"
        );
        click(&mut rt, "analysis-all-on");
        assert_eq!(shown(&rt.state), 3);

        // Snelste rondes per window, then the runner table sorted by best lap.
        click(&mut rt, "analysis-window-2");
        assert_eq!(rt.state.analysis_page.window, 2);
        click(&mut rt, "analysis-section-1");
        assert!(rt.find("runner-insights-").is_none());
        assert!(
            rt.find(&format!("runner-insights-{}", ids[0].as_str().unwrap()))
                .is_some(),
            "Mitras has the most laps"
        );
        click(&mut rt, "analysis-sort-2");
        rt.frame(1.0 / 60.0);
        assert!(
            rt.find(&format!("runner-insights-{}", ids[1].as_str().unwrap()))
                .is_some(),
            "Wout has the fastest lap"
        );
        click(&mut rt, "analysis-section-2");
        assert_eq!(rt.state.analysis_page.section, 2);

        // The export menu opens under its button and a choice downloads from the server.
        click(&mut rt, "analysis-export");
        assert!(rt.state.analysis_page.export_open);
        click(&mut rt, "export-laps.csv");
        assert!(!rt.state.analysis_page.export_open);
        let urls = rt.take_url_requests();
        assert!(
            urls.len() == 1 && urls[0].ends_with("/api/export/laps.csv"),
            "{urls:?}"
        );
        let csv = reqwest::blocking::get(format!("http://127.0.0.1:{port}/api/export/laps.csv"))
            .unwrap()
            .text()
            .unwrap();
        assert!(csv.contains("Mitras") && csv.contains("Wout"), "{csv}");
    }

    #[test]
    fn toggling_every_label_back_on_means_all_laps() {
        let all = vec!["a".to_string(), "b".to_string()];
        let off = toggle(&None, "a", &all);
        assert_eq!(off, Some(vec!["b".to_string()]));
        assert_eq!(toggle(&off, "a", &all), None);
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;
    use rune::{Env, Runtime};
    use std::sync::{Arc, Mutex};

    #[test]
    fn analysis_opened_directly_shows_live_laps() {
        let mut db = crate::db::Db::open(std::path::Path::new(":memory:")).unwrap();
        let runner = db
            .mutation("runners.create", &json!({"name": "Analyse Loper", "runnerNumber": "113"}))
            .unwrap();
        db.exec(
            "INSERT INTO laps (id, runner_id, lap_number, started_at, finished_at, duration_ms, source, created_at)
             VALUES ('first-lap', ?, 1, 0, 75000, 75000, 'spacebar', 75000)",
            &[runner["id"].clone()],
        )
        .unwrap();
        let db = Arc::new(Mutex::new(db));
        let socket = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = socket.local_addr().unwrap().port();
        drop(socket);
        let _host = crate::server::start(db, port).unwrap();
        let mut state = init_with_url(format!("http://127.0.0.1:{port}"));
        state.page = 3;
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
        let deadline = Instant::now() + Duration::from_secs(8);
        while !rt.state.connected || rt.state.history.is_null() {
            assert!(Instant::now() < deadline, "no data");
            rt.update_if(|state, tx| poll(state, 0.0, tx));
            rt.frame(1.0 / 60.0);
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(rt.state.history["laps"][0]["id"], "first-lap");
        // Exporteren opens the six export routes; each one downloads from the Rust server.
        rt.frame(1.0 / 60.0);
        let (x, y) = rt.find("analysis-export").expect("Exporteren");
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(1.0 / 60.0);
        rt.frame(1.0 / 60.0);
        for (_, file) in EXPORTS {
            assert!(
                rt.find(&format!("export-{file}")).is_some(),
                "menu item {file}"
            );
            let response =
                reqwest::blocking::get(format!("http://127.0.0.1:{port}/api/export/{file}"))
                    .unwrap();
            assert!(response.status().is_success(), "{file}");
            assert!(!response.bytes().unwrap().is_empty(), "{file}");
        }
    }
}
