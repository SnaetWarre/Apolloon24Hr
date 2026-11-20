//! Building blocks the Beheer sections share, from src/styles/primitives.css and admin.css:
//! `.panel`, `h2`/`h3`, `.panel-copy`, `.btn` and its kinds, `.segmented-control`, `.toggle-row`,
//! `.input`, `.host-hint`, `.warning-banner`, `.backup-metrics` and table cells.
use super::*;
use rune::{Color, Span, TextStyle, oklch};
use std::{cell::RefCell, collections::HashMap};

pub(super) struct Pal {
    pub brand: Color,
    pub brand_hover: Color,
    pub brand_ink: Color,
    pub on_brand: Color,
    pub stop_ink: Color,
    pub surface: Color,
    pub line: Color,
    pub ink: Color,
    pub overlay: Color,
    pub t: tok::Tones,
}
pub(super) fn pal(dark: bool) -> Pal {
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
        on_brand: oklch(1.0, 0.0, 0.0),
        stop_ink: if dark {
            oklch(0.734, 0.163, 25.8)
        } else {
            oklch(0.505, 0.19, 27.5)
        },
        surface: th.card,
        line: th.card_border,
        ink: th.text,
        overlay: rune::oklcha(0.21, 0.006, 285.9, 0.4),
        t: tok::tones(dark),
    }
}

/// The body sets tabular numbers everywhere.
pub(super) fn ts(size: f32, weight: f32) -> TextStyle {
    TextStyle::new(size, weight).features("tnum")
}
// `max-width: 76ch` of Geist 13.5px.
pub(super) const COPY_MAX: f32 = 684.0;

/// A Beheer section: open on the page; `admin_base::stack` splits sections with a line.
pub(super) fn panel() -> El {
    col().w_full().min_w(0.0)
}
pub(super) fn h2(title: &str, dark: bool) -> El {
    text(title.to_string())
        .font(ts(15.5, 600.0).lh(20.0).tracking(-0.2))
        .color(pal(dark).ink)
        .role("heading")
}
pub(super) fn h3(title: &str, dark: bool) -> El {
    text(title.to_string())
        .font(ts(13.0, 600.0).lh(16.25).tracking(-0.13))
        .color(pal(dark).ink)
        .role("heading")
}
/// `.panel-copy`: 13.5px ink-2, at most 76ch wide.
pub(super) fn copy(value: impl Into<String>, dark: bool) -> El {
    text(value.into())
        .font(ts(13.5, 400.0).lh(20.25))
        .color(pal(dark).t.ink2)
        .wrap()
        .min_w(0.0)
        .max_w(COPY_MAX)
}
/// Text with `**bold**` parts in ink, the rest in `color`.
pub(super) fn strong_text(source: &str, color: Color, dark: bool) -> El {
    let mut plain = String::new();
    let mut spans = Vec::new();
    for (i, part) in source.split("**").enumerate() {
        let start = plain.len();
        plain.push_str(part);
        if i % 2 == 1 {
            spans.push(
                Span::new(start, plain.len())
                    .weight(600.0)
                    .color(pal(dark).ink),
            );
        }
    }
    rune::rich(plain, spans)
        .font(ts(13.5, 400.0).lh(20.25))
        .color(color)
        .min_w(0.0)
}

#[derive(Clone, Copy, PartialEq)]
pub(super) enum Kind {
    Plain,
    Primary,
    /// `.btn--ghost` and `.btn--secondary`: no fill, no shadow.
    Ghost,
    Danger,
    DangerOutline,
}
/// `.btn`: 34 high (28 for `.btn--sm`), 13.5px medium label (13px small), an optional 15px icon.
pub(super) fn btn(
    s: &State,
    key: impl Into<String>,
    label: &str,
    kind: Kind,
    sm: bool,
    glyph: Option<&'static str>,
    disabled: bool,
    f: impl Fn(&mut State) + 'static,
) -> El {
    let b = btn_el(s, key, label, kind, sm, glyph, disabled);
    if disabled { b } else { b.on_press(f) }
}
/// [`btn`] without its press handler, for one that needs the [`Tx`].
pub(super) fn btn_el(
    s: &State,
    key: impl Into<String>,
    label: &str,
    kind: Kind,
    sm: bool,
    glyph: Option<&'static str>,
    disabled: bool,
) -> El {
    let p = pal(s.dark);
    let (fill, line, ink, hover) = match kind {
        Kind::Plain => (p.surface, p.t.line2, p.ink, p.t.surface2),
        Kind::Primary => (p.brand, p.brand, p.on_brand, p.brand_hover),
        Kind::Ghost => (Color::TRANSPARENT, p.t.line2, p.ink, p.t.surface2),
        Kind::Danger => (p.t.stop, p.t.stop, p.on_brand, p.stop_ink),
        Kind::DangerOutline => (Color::TRANSPARENT, p.t.line2, p.stop_ink, p.t.stop_wash),
    };
    let (fill, line, ink) = if disabled {
        (p.t.surface2, p.line, p.t.ink3)
    } else {
        (fill, line, ink)
    };
    let mut b = row()
        .key(key.into())
        .role("button")
        .label(label.to_string())
        .focusable(!disabled)
        .disabled(disabled)
        .h(if sm { 28.0 } else { 34.0 })
        .px(if sm { 10.0 } else { 12.0 })
        .gap(8.0)
        .center()
        .radius(8.0)
        .fill(fill)
        .border(1.0, line);
    if !disabled {
        b = b.hover(hover);
        if kind == Kind::Plain && !s.dark {
            b = b.shadow(1.0, 2.0, rune::oklcha(0.21, 0.006, 285.9, 0.05));
        }
    }
    if let Some(glyph) = glyph {
        b = b.child(icon(s, glyph, ink, 15.0));
    }
    b.child(
        text(label.to_string())
            .font(ts(if sm { 13.0 } else { 13.5 }, 500.0))
            .color(ink),
    )
}

/// `.segmented-control`: 2px inset on surface-2; the chosen one lifts onto surface.
pub(super) fn segmented(
    s: &State,
    name: &str,
    options: &[(&'static str, &'static str)],
    chosen: &str,
    key: &str,
    disabled: bool,
    f: impl Fn(&mut State, &'static str) + Clone + 'static,
) -> El {
    let p = pal(s.dark);
    let mut group = row()
        .role("group")
        .label(name.to_string())
        .gap(2.0)
        .padding(2.0)
        .radius(6.0)
        .fill(p.t.surface2)
        .border(1.0, p.line);
    for (value, title) in options.iter().copied() {
        let on = chosen == value;
        let f = f.clone();
        let mut b = row()
            .key(format!("{key}-{value}"))
            .role("button")
            .label(title)
            .checked(on)
            .focusable(true)
            .disabled(disabled)
            .h(26.0)
            .px(10.0)
            .center()
            .radius(4.0)
            .child(
                text(title)
                    .font(ts(13.0, 500.0))
                    .color(if on { p.ink } else { p.t.ink2 }),
            );
        if on {
            b = b.fill(p.surface).border(1.0, p.t.line2);
            if !s.dark {
                b = b.shadow(1.0, 2.0, rune::oklcha(0.21, 0.006, 285.9, 0.05));
            }
        } else if !disabled {
            b = b
                .hover(p.t.surface3)
                .on_press(move |s: &mut State| f(s, value));
        }
        group = group.child(b);
    }
    group
}

/// A 16px checkbox, as `accent-color` draws one.
pub(super) fn checkbox(s: &State, on: bool) -> El {
    let p = pal(s.dark);
    let b = rune::el().size(16.0, 16.0).radius(3.0).center();
    if on {
        b.fill(p.brand).child(icon(s, "check", p.on_brand, 12.0))
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
pub(super) fn toggle_row(
    s: &State,
    key: &str,
    title: &str,
    on: bool,
    disabled: bool,
    f: impl Fn(&mut State) + 'static,
) -> El {
    let mut r = row()
        .key(key.to_string())
        .role("checkbox")
        .label(title.to_string())
        .checked(on)
        .disabled(disabled)
        .focusable(!disabled)
        .min_h(30.0)
        .gap(11.0)
        .pl(4.0)
        .center_y()
        .child(checkbox(s, on))
        .child(
            text(title.to_string())
                .font(ts(13.5, 400.0).lh(20.0))
                .color(pal(s.dark).ink),
        );
    if !disabled {
        r = r.on_press(f);
    }
    r
}
/// `.input`: 34 high, 1px line-2 border, brand ring while focused.
pub(super) fn input(s: &State, edit: &TextEdit, key: &str, title: &str, placeholder: &str) -> El {
    let p = pal(s.dark);
    text_input(edit, ts(13.5, 400.0).lh(18.0))
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

#[derive(Clone, Copy, PartialEq)]
pub(super) enum Tone {
    Hint,
    Warn,
    Alert,
}
/// `.host-hint` (ink-2 on surface), `.warning-banner` (warn wash) and `[role=alert]` (stop wash).
pub(super) fn notice(s: &State, tone: Tone, body: El) -> El {
    let p = pal(s.dark);
    let (fill, line) = match tone {
        Tone::Hint => (p.surface, p.line),
        Tone::Warn => (p.t.warn_wash, p.t.warn_line),
        Tone::Alert => (p.t.stop_wash, p.t.stop_line),
    };
    let el = row()
        .w_full()
        .min_w(0.0)
        .flex_wrap()
        .gaps(8.0, 12.0)
        .center_y()
        // 9px padding plus the 1px border of the border-box reference.
        .py(10.0)
        .px(13.0)
        .radius(6.0)
        .fill(fill)
        .border(1.0, line)
        .child(body.grow(1.0));
    if tone == Tone::Alert {
        el.role("alert")
    } else {
        el
    }
}
/// A notice of plain text, `**bold**` in ink.
pub(super) fn notice_text(s: &State, tone: Tone, value: &str) -> El {
    let p = pal(s.dark);
    notice(
        s,
        tone,
        strong_text(
            value,
            if tone == Tone::Hint { p.t.ink2 } else { p.ink },
            s.dark,
        )
        .wrap(),
    )
}

/// `.backup-metrics`: facts in columns, each under a line, the name small in ink-3.
pub(super) fn metrics(s: &State, facts: Vec<(String, El)>, widths: &[Option<f32>]) -> El {
    let p = pal(s.dark);
    let mut r = row().w_full().gap(20.0).items_start();
    for (i, (name, value)) in facts.into_iter().enumerate() {
        let cell = col()
            .gap(2.0)
            .py(10.0)
            .min_w(0.0)
            .border_sides([1.0, 0.0, 0.0, 0.0], p.line)
            .child(text(name).font(ts(12.5, 400.0).lh(18.75)).color(p.t.ink3))
            .child(value);
        r = r.child(match widths.get(i).copied().flatten() {
            Some(w) => cell.w(w),
            None => cell.grow(1.0),
        });
    }
    r
}
pub(super) fn value_text(value: impl Into<String>, dark: bool) -> El {
    text(value.into())
        .font(ts(13.5, 400.0).lh(20.25))
        .color(pal(dark).ink)
        .wrap()
        .min_w(0.0)
}

/// A table head cell: 13px, ink-3 on surface, 7/10 padding.
pub(super) fn th(title: &str, dark: bool) -> El {
    text(title.to_string())
        .font(ts(12.5, 500.0))
        .color(pal(dark).t.ink3)
}

// ---------- Icons (src/components/Icon.tsx), in any colour ----------

thread_local! {
    static ICONS: RefCell<HashMap<(&'static str, String, u32), rune::Image>> = RefCell::new(HashMap::new());
}
pub(super) fn icon(s: &State, name: &'static str, color: Color, size: f32) -> El {
    let el = rune::el().size(size, size);
    let Some(cache) = &s.image_cache else {
        return el;
    };
    let (body, stroke) = match name {
        "displayInside" => (
            r#"<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>"#,
            1.75,
        ),
        "displayCompetitions" => (
            r#"<path d="M8 21V10h8v11M2 21v-7h6M16 21v-5h6M1 21h22"/>"#,
            1.75,
        ),
        "displayOutside" => (
            r#"<rect x="2" y="7" width="20" height="14" rx="2"/><path d="m17 2-5 5-5-5"/>"#,
            1.75,
        ),
        "copy" => (
            r#"<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>"#,
            1.75,
        ),
        "check" => (
            r#"<path d="M20 6 9 17l-5-5"/>"#,
            if size <= 12.0 { 3.0 } else { 2.5 },
        ),
        "download" => (r#"<path d="M12 3v12m0 0-4-4m4 4 4-4M4 21h16"/>"#, 1.75),
        "folder" => (
            r#"<path d="M3 6a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>"#,
            1.75,
        ),
        "chevron" => (r#"<path d="M9 5.5l6.5 6.5-6.5 6.5"/>"#, 2.0),
        "chevronDown" => (r#"<path d="M5.5 9l6.5 6.5 6.5-6.5"/>"#, 2.0),
        _ => ("", 1.75),
    };
    let hex = color.hex();
    let key = (name, hex.clone(), (size * 10.0) as u32);
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

// ---------- Formatting (src/components/admin/adminFormat.ts) ----------

pub(super) fn file_size(bytes: i64) -> String {
    let b = bytes as f64;
    if bytes < 1_024 {
        format!("{bytes} B")
    } else if b < 1_024f64.powi(2) {
        format!("{:.1} KiB", b / 1_024.0)
    } else if b < 1_024f64.powi(3) {
        format!("{:.1} MiB", b / 1_024f64.powi(2))
    } else {
        format!("{:.1} GiB", b / 1_024f64.powi(3))
    }
}
pub(super) fn relative_age(timestamp: i64, now: i64) -> String {
    let minutes = ((now - timestamp) / 60_000).max(0);
    let hours = minutes / 60;
    match minutes {
        0 => "zonet".into(),
        1 => "1 minuut geleden".into(),
        2..=59 => format!("{minutes} minuten geleden"),
        _ if hours == 1 => "1 uur geleden".into(),
        _ if hours < 48 => format!("{hours} uur geleden"),
        _ if hours / 24 == 1 => "1 dag geleden".into(),
        _ => format!("{} dagen geleden", hours / 24),
    }
}
fn brussels(ms: i64) -> chrono::DateTime<chrono_tz::Tz> {
    use chrono::TimeZone;
    chrono_tz::Europe::Brussels
        .timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(|| chrono_tz::Europe::Brussels.timestamp_millis_opt(0).unwrap())
}
const WEEKDAYS: [&str; 7] = ["ma", "di", "wo", "do", "vr", "za", "zo"];
/// `toLocaleString('nl-BE', {weekday:'short', hour, minute[, second]})`: "ma 17:45[:16]".
pub(super) fn weekday_time(ms: i64, seconds: bool) -> String {
    use chrono::{Datelike, Timelike};
    let t = brussels(ms);
    let day = WEEKDAYS[t.weekday().num_days_from_monday() as usize];
    if seconds {
        format!("{day} {:02}:{:02}:{:02}", t.hour(), t.minute(), t.second())
    } else {
        format!("{day} {:02}:{:02}", t.hour(), t.minute())
    }
}
/// `toLocaleString('nl-BE')`: "17/11/2026 14:05:33".
pub(super) fn date_time(ms: i64) -> String {
    brussels(ms).format("%-d/%m/%Y %H:%M:%S").to_string()
}
/// `toLocaleTimeString('nl-BE')`: "14:05:33".
pub(super) fn clock(ms: i64) -> String {
    brussels(ms).format("%H:%M:%S").to_string()
}
pub(super) fn count_label(n: i64, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}
