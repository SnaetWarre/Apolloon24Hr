//! Operator shell from src/components/Sidebar.tsx, PageHeader.tsx and ThemeSwitch.tsx
//! (styles: src/styles/shell.css), plus the operator theme choice (src/app/theme.ts).
use super::*;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;

/// localStorage key and values shared with the React renderer.
pub(super) const THEME_KEY: &str = "apolloon.theme";

// ---------- Theme persistence ----------

/// The stored choice, else the system preference (browser) or dark (desktop default).
pub(super) fn initial_dark() -> bool {
    if cfg!(test) {
        return true;
    }
    #[cfg(target_arch = "wasm32")]
    {
        let window = web_sys::window();
        let stored = window
            .as_ref()
            .and_then(|w| w.local_storage().ok().flatten())
            .and_then(|s| s.get_item(THEME_KEY).ok().flatten());
        match stored.as_deref() {
            Some("light") => return false,
            Some("dark") => return true,
            _ => {}
        }
        return window
            .and_then(|w| w.match_media("(prefers-color-scheme: dark)").ok().flatten())
            .is_some_and(|m| m.matches());
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        match std::env::var("APOLLOON_NATIVE_THEME")
            .ok()
            .or_else(|| theme_file().and_then(|p| std::fs::read_to_string(p).ok()))
        {
            Some(v) if v.trim() == "light" => false,
            _ => true,
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn theme_file() -> Option<std::path::PathBuf> {
    if let Some(p) = std::env::var_os("APOLLOON_NATIVE_THEME_FILE") {
        return Some(p.into());
    }
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("APPDATA").map(std::path::PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::Path::new(&h).join(".config")))?;
    Some(base.join("apolloon").join(THEME_KEY))
}

pub(super) fn set_dark(s: &mut State, dark: bool) {
    s.dark = dark;
    if cfg!(test) || s.fixture {
        return;
    }
    let value = if dark { "dark" } else { "light" };
    #[cfg(target_arch = "wasm32")]
    if let Some(storage) = web_sys::window().and_then(|w| w.local_storage().ok().flatten()) {
        let _ = storage.set_item(THEME_KEY, value);
    }
    #[cfg(not(target_arch = "wasm32"))]
    if let Some(path) = theme_file() {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, value);
    }
}

// ---------- Icons (geometry from src/components/Icon.tsx and ThemeSwitch.tsx) ----------

const ICONS: [(&str, &str); 9] = [
    (
        "panelLeft",
        r#"<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>"#,
    ),
    (
        "copy",
        r#"<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>"#,
    ),
    ("upload", r#"<path d="M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4"/>"#),
    ("link", r#"<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7L12 5m2 6a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7L12 19"/>"#),
    ("check", r#"<path d="M20 6 9 17l-5-5"/>"#),
    ("arrowRight", r#"<path d="M5 12h14m-6-6 6 6-6 6"/>"#),
    (
        "sun",
        r#"<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>"#,
    ),
    (
        "moon",
        r#"<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>"#,
    ),
    (
        "download",
        r#"<path d="M12 3v12m0 0-4-4m4 4 4-4M4 21h16"/>"#,
    ),
];
/// Ink tones an icon is drawn in: 0 ink, 1 ink-2, 2 ink-3.
const INKS: [[&str; 3]; 2] = [
    ["#18181B", "#52525B", "#71717A"],
    ["#ECECEC", "#A3A3A3", "#8B8B8B"],
];

thread_local! {
    static ICON_CACHE: RefCell<HashMap<(&'static str, bool, usize), rune::Image>> = RefCell::new(HashMap::new());
    static COPIED: Cell<(u8, i64)> = const { Cell::new((0, i64::MIN / 2)) };
}

pub(super) fn load_icons(cache: &rune::ImageCache) {
    ICON_CACHE.with(|icons| {
        let mut icons = icons.borrow_mut();
        for (name, body) in ICONS {
            for dark in [false, true] {
                for (tone, color) in INKS[usize::from(dark)].iter().enumerate() {
                    let svg = format!(
                        r#"<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="{color}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">{body}</svg>"#
                    );
                    icons.insert((name, dark, tone), cache.svg(svg.into_bytes(), 18.0, 2.0));
                }
            }
        }
    });
}

pub(super) fn icon(name: &'static str, dark: bool, tone: usize, size: f32) -> El {
    let el = rune::el().size(size, size);
    match ICON_CACHE.with(|i| i.borrow().get(&(name, dark, tone)).cloned()) {
        Some(image) => el.pixels(image.pixels()),
        None => el,
    }
}

fn copied(which: u8, s: &State) -> bool {
    let (w, at) = COPIED.with(Cell::get);
    w == which && s.clock - at < 1600
}
fn copy_host(which: u8) -> impl Fn(&mut State, &mut Tx) {
    move |s: &mut State, tx: &mut Tx| {
        if let Some(url) = s.snapshot["host"]["url"].as_str() {
            tx.copy(url);
            COPIED.with(|c| c.set((which, s.clock)));
        }
    }
}

// ---------- System status (src/lib/systemStatus.ts) ----------

#[derive(Clone, Copy, PartialEq, Debug)]
pub(super) enum Tone {
    Healthy,
    Warning,
    Error,
}
pub(super) struct SystemStatus {
    pub tone: Tone,
    pub title: &'static str,
    pub detail: String,
}

fn format_age(created: i64, now: i64) -> String {
    let minutes = ((now - created) / 60_000).max(0);
    match minutes {
        0 => "minder dan een minuut geleden".into(),
        1 => "1 minuut geleden".into(),
        2..=59 => format!("{minutes} minuten geleden"),
        _ if minutes / 60 == 1 => "1 uur geleden".into(),
        _ => format!("{} uur geleden", minutes / 60),
    }
}

/// None while the first status has not arrived (the row keeps its place).
pub(super) fn system_status(s: &State) -> Option<SystemStatus> {
    let b = &s.recovery["status"];
    if b.is_null() {
        if !s.connected && s.recovery.is_null() && s.snapshot.is_null() {
            return None;
        }
        if !s.connected {
            return Some(SystemStatus {
                tone: Tone::Error,
                title: "Serververbinding controleren",
                detail: "De systeemstatus kon niet worden vernieuwd".into(),
            });
        }
        return None;
    }
    let enabled = b["enabled"] == true;
    let interval = b["intervalMs"].as_i64().unwrap_or(300_000);
    let latest = b["latest"]["createdAt"].as_i64();
    let overdue = enabled && latest.is_none_or(|t| s.clock - t > interval * 3);
    let error = !b["lastError"].is_null() && b["lastError"] != false;
    let disk_low = b["diskLow"] == true;
    if !enabled || error || disk_low || overdue {
        return Some(SystemStatus {
            tone: if disk_low || error {
                Tone::Error
            } else {
                Tone::Warning
            },
            title: "Backup controleren",
            detail: if error {
                "Laatste backup is mislukt"
            } else if disk_low {
                "Vrije opslag zit onder de veiligheidsgrens"
            } else if !enabled {
                "Automatische backups zijn uitgeschakeld"
            } else {
                "Geen recente herstelbackup"
            }
            .into(),
        });
    }
    Some(SystemStatus {
        tone: Tone::Healthy,
        title: "Lokale opslag gezond",
        detail: latest
            .map(|t| format!("Backup {}", format_age(t, s.clock)))
            .unwrap_or_else(|| "Backupservice is actief".into()),
    })
}

pub(super) fn tone_colors(tone: Tone, dark: bool) -> (rune::Color, rune::Color, rune::Color) {
    let c = tok::tones(dark);
    match tone {
        Tone::Healthy => (c.go, c.go_wash, c.go_line),
        Tone::Warning => (c.warn, c.warn_wash, c.warn_line),
        Tone::Error => (c.stop, c.stop_wash, c.stop_line),
    }
}

/// The 7px status dot.
pub(super) fn dot(color: rune::Color) -> El {
    rune::el().size(7.0, 7.0).radius(3.5).fill(color)
}

// ---------- Sidebar ----------

const GROUPS: [(Option<&str>, &[usize]); 5] = [
    (None, &[0]),
    (Some("Wedstrijd"), &[1, 2]),
    (Some("Opvolgen"), &[3, 4]),
    (Some("Publieksschermen"), &[5, 6, 7]),
    (Some("Systeem"), &[8]),
];

pub(super) fn sidebar(s: &State) -> El {
    let t = tok::theme(s.dark);
    let c = tok::tones(s.dark);
    let collapsed = s.collapsed;
    let toggle_label = if collapsed {
        "Zijbalk uitklappen"
    } else {
        "Zijbalk inklappen"
    };
    let toggle = row()
        .key("collapse")
        .role("button")
        .label(toggle_label)
        .expanded(!collapsed)
        .focusable(true)
        .size(28.0, 28.0)
        .center()
        .radius(6.0)
        .hover(c.surface3)
        .on_press(|s: &mut State| s.collapsed = !s.collapsed)
        .child(icon("panelLeft", s.dark, 2, 18.0));
    let top = if collapsed {
        col().items_center().child(toggle)
    } else {
        row()
            .h(32.0)
            .center_y()
            .justify_between()
            .child(
                row()
                    .key("brand")
                    .role("link")
                    .label("Apolloon, naar het overzicht")
                    .focusable(true)
                    .h(32.0)
                    .px(8.0)
                    .center_y()
                    .radius(6.0)
                    .on_press(|s: &mut State| {
                        s.page = 0;
                        s.confirm = None;
                    })
                    .child(match s.icons.get(27 + usize::from(s.dark)) {
                        Some(image) => rune::el()
                            .size(92.0, 28.0)
                            .pixels_fit(image.pixels(), rune::SurfaceFit::Fit),
                        None => label("Apolloon", s.dark),
                    }),
            )
            .child(toggle)
    };
    let mut nav = col().gap(16.0).label("Hoofdnavigatie").role("navigation");
    if collapsed {
        nav = nav.items_center();
    }
    for (title, pages) in GROUPS {
        let mut group = col().gap(1.0);
        if let Some(title) = title
            && !collapsed
        {
            group = group.child(
                row().h(22.0).px(8.0).pb(4.0).center_y().child(
                    text(title)
                        .font(rune::TextStyle::new(12.0, 500.0))
                        .color(c.ink3),
                ),
            );
        }
        for &i in pages {
            group = group.child(nav_link(s, i));
        }
        nav = nav.child(group);
    }
    let mut side = col()
        .w(if collapsed { 60.0 } else { 208.0 })
        .h_full()
        .pt(16.0)
        .pb(12.0)
        .px(if collapsed { 8.0 } else { 12.0 })
        .gap(16.0)
        .fill(tok::sidebar(s.dark))
        .border_sides([0.0, 1.0, 0.0, 0.0], t.card_border)
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .child(top)
        .child(nav)
        .child(col().grow(1.0).gap(0.0));
    if collapsed {
        side = side.items_center();
    }
    side.child(footer(s))
}

fn nav_link(s: &State, i: usize) -> El {
    let t = tok::theme(s.dark);
    let c = tok::tones(s.dark);
    let current = s.page == i;
    let mut link = row()
        .key(format!("nav-{i}"))
        .role("link")
        .label(PAGES[i])
        .focusable(true)
        .h(32.0)
        .px(if s.collapsed { 0.0 } else { 8.0 })
        .gap(10.0)
        .center_y()
        .radius(6.0)
        .hover(c.surface3)
        .on_press(move |s: &mut State| {
            s.page = i;
            s.confirm = None;
        });
    if s.collapsed {
        link = link.w(40.0).center();
    }
    if current {
        link = link.fill(t.card).border(1.0, t.card_border).hover(t.card);
        if !s.dark {
            link = link.shadow(1.0, 2.0, rune::oklcha(0.21, 0.006, 285.9, 0.05));
        }
    }
    let image = i * 3 + if current { 2 } else { usize::from(s.dark) };
    if let Some(img) = s.icons.get(image) {
        link = link.child(rune::el().size(18.0, 18.0).pixels(img.pixels()));
    }
    if !s.collapsed {
        link =
            link.child(
                text(PAGES[i])
                    .font(tok::NAV)
                    .color(if current { t.text } else { c.ink2 }),
            );
    }
    link
}

fn sidebar_row(key: &str) -> El {
    row()
        .key(key.to_string())
        .min_w(0.0)
        .h(28.0)
        .px(8.0)
        .gap(8.0)
        .center_y()
        .radius(6.0)
}

fn footer(s: &State) -> El {
    let t = tok::theme(s.dark);
    let c = tok::tones(s.dark);
    let mut footer = col()
        .gap(2.0)
        .pt(12.0)
        .border_sides([1.0, 0.0, 0.0, 0.0], t.card_border);
    if s.collapsed {
        footer = footer.w_full().items_center();
    } else {
        footer = footer.w_full();
    }
    // System status: quiet when healthy, a coloured card with the reason otherwise.
    let status = system_status(s);
    let (title, detail, tone) = match &status {
        Some(st) => (
            if st.tone == Tone::Healthy {
                "Systeem in orde"
            } else {
                st.title
            },
            st.detail.clone(),
            Some(st.tone),
        ),
        None => ("Status laden…", String::new(), None),
    };
    let (dot_color, wash, line) = match tone {
        Some(tone) => tone_colors(tone, s.dark),
        None => (c.ink3, t.bg, t.bg),
    };
    let mut card = row()
        .key("system-status")
        .role(if tone == Some(Tone::Error) {
            "alert"
        } else {
            "link"
        })
        .label(if let Some(st) = &status {
            format!("{}: {}. Open Beheer voor details.", title, st.detail)
        } else {
            title.to_string()
        })
        .focusable(status.is_some())
        .items_start()
        .gap(8.0)
        .py(6.0)
        .radius(6.0)
        .border(1.0, rune::Color::TRANSPARENT)
        .child(dot(dot_color).mt(if s.collapsed { 0.0 } else { 6.0 }));
    if s.collapsed {
        card = card.w(40.0).py(8.0).center();
    } else {
        card = card.px(8.0).w_full();
    }
    if status.is_some() {
        card = card.on_press(|s: &mut State| {
            s.page = 8;
            s.confirm = None;
        });
    }
    let alarming = matches!(tone, Some(Tone::Warning | Tone::Error));
    if alarming {
        card = card.fill(wash).border(1.0, line).mb(4.0).pb(8.0);
    } else if status.is_some() {
        card = card.hover(c.surface3);
    }
    if !s.collapsed {
        let mut words = col().min_w(0.0).grow(1.0).child(
            text(title)
                .font(
                    rune::TextStyle::new(12.5, if status.is_some() { 500.0 } else { 400.0 })
                        .lh(18.75),
                )
                .color(if status.is_some() { t.text } else { c.ink3 }),
        );
        if alarming {
            words = words.child(
                text(detail)
                    .font(rune::TextStyle::new(12.5, 400.0).lh(18.75))
                    .color(c.ink2)
                    .wrap()
                    .min_w(0.0),
            );
        }
        card = card.child(words);
    }
    footer = footer.child(card);
    if !s.collapsed {
        let race = &s.snapshot["race"];
        let value = if race["raceStartedAt"].is_null() {
            "Niet gestart".to_string()
        } else if !race["raceFinishedAt"].is_null() {
            "Afgesloten".to_string()
        } else {
            race_time(s)
        };
        footer = footer.child(
            sidebar_row("race-clock")
                .label(format!("Race {value}"))
                .child(
                    text("Race")
                        .font(type_::LABEL_REGULAR)
                        .color(c.ink3)
                        .grow(1.0),
                )
                .child(text(value).font(type_::LABEL_REGULAR).color(c.ink2)),
        );
        if let Some(url) = s.snapshot["host"]["url"].as_str() {
            let shown = url
                .trim_start_matches("http://")
                .trim_start_matches("https://")
                .to_string();
            let done = copied(1, s);
            footer = footer.child(
                sidebar_row("host-address")
                    .role("button")
                    .label(format!("Adres voor andere laptops kopiëren: {shown}"))
                    .focusable(true)
                    .hover(c.surface3)
                    .on_press_tx(copy_host(1))
                    .child(
                        text(if done {
                            "Gekopieerd".to_string()
                        } else {
                            shown
                        })
                        .font(type_::LABEL_REGULAR)
                        .color(c.ink2)
                        .truncate()
                        .min_w(0.0)
                        .grow(1.0),
                    )
                    .child(icon(if done { "check" } else { "copy" }, s.dark, 2, 14.0)),
            );
        }
    }
    footer.child(theme_switch(s))
}

fn theme_switch(s: &State) -> El {
    let t = tok::theme(s.dark);
    let c = tok::tones(s.dark);
    let mut group = if s.collapsed {
        col().w(36.0)
    } else {
        row().w_full()
    }
    .key("theme")
    .role("radiogroup")
    .label("Thema")
    .mt(8.0)
    .gap(if s.collapsed { 2.0 } else { 0.0 })
    .padding(2.0)
    .radius(6.0)
    .border(1.0, t.card_border)
    .fill(c.surface2);
    for (dark, name, glyph) in [(false, "Licht", "sun"), (true, "Donker", "moon")] {
        let checked = s.dark == dark;
        let mut option = row()
            .key(format!("theme-{}", if dark { "dark" } else { "light" }))
            .role("radio")
            .label(name)
            .checked(checked)
            .focusable(checked)
            .grow(1.0)
            .h(26.0)
            .center()
            .radius(5.0)
            .on_press(move |s: &mut State| set_dark(s, dark))
            .child(icon(glyph, s.dark, if checked { 0 } else { 2 }, 14.0));
        if checked {
            option = option.fill(t.card).border(1.0, c.line2);
        }
        group = group.child(option);
    }
    group
}

// ---------- Page header ----------

/// Context next to the title (`PageHeader` meta). Pages without one return None.
pub(super) fn header_meta(s: &State) -> Option<El> {
    let c = tok::tones(s.dark);
    let meta = |v: &str| Some(text(v.to_string()).font(type_::BODY).color(c.ink3));
    match s.page {
        0 if super::overview::show_welcome(s) => meta("Nog niet ingesteld"),
        3 => Some(super::analysis_page::header_meta(s)),
        2 => meta("Spatie of Enter klokt de huidige loper af en start de volgende."),
        4 => Some(header_tag(
            &if s.history["laps"].is_null() {
                "Live data laden".to_string()
            } else {
                format!("{} rondes live gekoppeld", laps(s).len())
            },
            false,
            true,
            s.dark,
        )),
        _ => None,
    }
}

/// `.header-tag`: a 22px pill (12px medium); `partial` is the amber variant, `live` adds the go dot.
pub(super) fn header_tag(value: &str, partial: bool, live: bool, dark: bool) -> El {
    let t = tok::theme(dark);
    let c = tok::tones(dark);
    let (fill, line, ink) = if partial {
        (c.warn_wash, c.warn_line, c.warn_ink)
    } else {
        (t.card, t.card_border, c.ink2)
    };
    let mut tag = row()
        .role("status")
        .h(22.0)
        .px(8.0)
        .gap(6.0)
        .center_y()
        .radius(11.0)
        .fill(fill)
        .border(1.0, line);
    if live {
        tag = tag.child(dot(c.go));
    }
    tag.child(
        text(value.to_string())
            .font(rune::TextStyle::new(12.0, 500.0))
            .color(ink),
    )
}

/// Buttons on the right of the header (`PageHeader` actions). Page modules add theirs here.
pub(super) fn header_actions(s: &State) -> Vec<El> {
    match s.page {
        0 if !super::overview::show_welcome(s) && !s.snapshot["host"]["url"].is_null() => {
            let done = copied(2, s);
            vec![
                header_button(
                    "copy-address",
                    if done {
                        "Gekopieerd"
                    } else {
                        "Adres voor andere laptop kopiëren"
                    },
                    Some(if done { "check" } else { "copy" }),
                    s.dark,
                )
                .label("Adres voor andere laptop kopiëren")
                .on_press_tx(copy_host(2)),
            ]
        }
        1 => super::queue_page::header_actions(s),
        3 => super::analysis_page::header_actions(s),
        _ => Vec::new(),
    }
}

/// `.btn.btn--sm`: 28 high, 13px medium label, optional 15px leading icon.
pub(super) fn header_button(key: &str, label: &str, glyph: Option<&'static str>, dark: bool) -> El {
    let t = tok::theme(dark);
    let c = tok::tones(dark);
    let mut b = row()
        .key(key.to_string())
        .role("button")
        .label(label.to_string())
        .focusable(true)
        .h(28.0)
        .px(10.0)
        .gap(8.0)
        .center_y()
        .radius(6.0)
        .fill(t.card)
        .border(1.0, c.line2)
        .hover(c.surface3);
    if !dark {
        b = b.shadow(1.0, 2.0, rune::oklcha(0.21, 0.006, 285.9, 0.05));
    }
    if let Some(g) = glyph {
        b = b.child(icon(g, dark, 0, 15.0));
    }
    b.child(
        text(label.to_string())
            .font(rune::TextStyle::new(13.0, 500.0))
            .color(t.text),
    )
}

/// The thin page bar: title, meta and actions; 52 high with a bottom rule.
pub(super) fn header(s: &State) -> El {
    let t = tok::theme(s.dark);
    let mut bar = row()
        .key("page-header")
        .min_h(52.0)
        .px(24.0)
        .py(8.0)
        .gap(12.0)
        .center_y()
        .fill(t.bg)
        .border_sides([0.0, 0.0, 1.0, 0.0], t.card_border)
        .child(
            text(PAGES[s.page])
                .font(type_::TITLE)
                .color(t.text)
                .role("heading")
                .level(1),
        );
    if let Some(meta) = header_meta(s) {
        bar = bar.child(meta.min_w(0.0).truncate());
    }
    let actions = header_actions(s);
    bar = bar.child(col().grow(1.0));
    if !actions.is_empty() {
        let mut group = row().gap(8.0).center_y();
        for a in actions {
            group = group.child(a);
        }
        bar = bar.child(group);
    }
    bar
}

// ---------- Overview helpers ----------

/// `.btn--sm.btn--quiet` with a trailing arrow: "Naar Timing →".
pub(super) fn quiet_link(key: String, label: &str, page: usize, dark: bool) -> El {
    let c = tok::tones(dark);
    row()
        .key(key)
        .role("link")
        .label(label.to_string())
        .focusable(true)
        .h(28.0)
        .px(10.0)
        .gap(8.0)
        .center_y()
        .radius(6.0)
        .hover(c.surface3)
        .on_press(move |s: &mut State| {
            s.page = page;
            s.confirm = None;
        })
        .child(
            text(label.to_string())
                .font(rune::TextStyle::new(13.0, 500.0))
                .color(c.ink3),
        )
        .child(icon("arrowRight", dark, 2, 14.0))
}

/// Overview › Systeem: the status card (`.overview-status`).
pub(super) fn overview_status(s: &State) -> Option<El> {
    let st = system_status(s)?;
    let t = tok::theme(s.dark);
    let c = tok::tones(s.dark);
    let (dot_color, wash, line) = tone_colors(st.tone, s.dark);
    Some(
        row()
            .key("overview-status")
            .role(if st.tone == Tone::Error {
                "alert"
            } else {
                "status"
            })
            .items_start()
            .gap(8.0)
            .px(12.0)
            .pt(10.0)
            .pb(11.0)
            .mt(1.0)
            .radius(6.0)
            .fill(wash)
            .border(1.0, line)
            .child(dot(dot_color).mt(6.0))
            .child(
                col()
                    .min_w(0.0)
                    .grow(1.0)
                    .child(
                        text(if st.tone == Tone::Healthy {
                            "Alles in orde"
                        } else {
                            st.title
                        })
                        .font(rune::TextStyle::new(13.0, 550.0).lh(19.5))
                        .color(t.text),
                    )
                    .child(
                        text(st.detail)
                            .font(type_::BODY.lh(19.5))
                            .color(c.ink2)
                            .wrap()
                            .min_w(0.0),
                    ),
            ),
    )
}

/// LiveDuration format="seconds": m:ss, or h:mm:ss past an hour.
pub(super) fn elapsed_seconds(ms: i64) -> String {
    duration(ms)
}
