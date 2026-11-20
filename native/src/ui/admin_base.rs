//! Shared pieces of Beheer › Voorbereiding, Lopers and Labels: the section stack, `.btn`, `.input` and
//! select primitives from src/styles/primitives.css, the confirm dialog (ConfirmDialog.tsx), the
//! toasts (Toaster.tsx) and which sent action belongs to these sections.
use super::*;
use std::cell::RefCell;
use std::collections::HashMap;

const TOAST_MS: i64 = 4_000;

/// What a sent action does once the server answered.
pub(super) enum Pending {
    Import,
    Registrations,
    RunnerDeleted(String),
    Unhidden(String),
    LabelCreated(String),
    LabelDeleted(String),
    LabelLogo,
    Upload(label_editor::LogoTarget),
    MemberAdded { runner: String, label: String },
    MemberRemoved { runner: String, label: String },
    ProfileSaved(String),
    Status { ok: String, failure: &'static str },
}
#[derive(Clone)]
pub(super) enum ConfirmAction {
    DeleteRunner { id: String, name: String },
    DeleteLabel { id: String, name: String },
    LeaveQueue { id: String, name: String },
    LoadLatestProfile,
    InstallUpdate,
}
pub(super) struct Confirm {
    pub title: String,
    pub message: String,
    pub confirm_label: String,
    pub danger: bool,
    pub action: ConfirmAction,
}
pub(super) struct Toast {
    pub text: String,
    pub detail: String,
    pub error: bool,
    pub at: i64,
}
#[derive(Default)]
pub(super) struct Admin {
    pub runners: admin_runners::Page,
    /// The focused control's key, so a row can show its actions while a control in it has focus.
    pub focused: Option<String>,
    pub confirm: Option<Confirm>,
    pub toast: Option<Toast>,
    /// The select whose options are open, by its key, and how wide it is.
    pub select: Option<String>,
    select_w: HashMap<String, f32>,
    pub pending: Option<Pending>,
    pub registrations: Value,
    regs_revision: Option<i64>,
    /// The import file could not be read.
    pub import_failed: Option<String>,
    window_h: f32,
}
impl Admin {
    pub(super) fn window_h(&self) -> f32 {
        if self.window_h > 0.0 {
            self.window_h
        } else {
            768.0
        }
    }
    pub(super) fn select_w(&self, key: &str) -> f32 {
        self.select_w.get(key).copied().unwrap_or(240.0)
    }
}
pub(super) fn track_width(s: &mut State, key: &str, w: f32) {
    if (s.admin.select_w(key) - w).abs() > 0.5 {
        s.admin.select_w.insert(key.to_string(), w);
    }
}

// ---------- Palette (src/styles/tokens.css) ----------

pub(super) struct Pal {
    pub brand: rune::Color,
    pub brand_hover: rune::Color,
    pub brand_ink: rune::Color,
    pub brand_wash: rune::Color,
    pub on_brand: rune::Color,
    pub surface: rune::Color,
    pub line: rune::Color,
    pub ink: rune::Color,
    pub stop_ink: rune::Color,
    pub go_ink: rune::Color,
    pub t: tok::Tones,
}
pub(super) fn pal(dark: bool) -> Pal {
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
        stop_ink: if dark {
            oklch(0.734, 0.163, 25.8)
        } else {
            oklch(0.505, 0.19, 27.5)
        },
        go_ink: if dark {
            oklch(0.772, 0.188, 145.5)
        } else {
            oklch(0.4479, 0.1083, 151.33)
        },
        t: tok::tones(dark),
    }
}
/// The body sets tabular numbers everywhere.
pub(super) fn ts(size: f32, weight: f32) -> rune::TextStyle {
    rune::TextStyle::new(size, weight).features("tnum")
}
pub(super) fn st<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
pub(super) fn fold(text: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    text.nfd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .collect::<String>()
        .to_lowercase()
}
/// `localeCompare(…, { numeric: true })` for runner numbers: digits by value, the rest as text.
pub(super) fn numeric_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    match (a.parse::<u64>(), b.parse::<u64>()) {
        (Ok(x), Ok(y)) => x.cmp(&y),
        (Ok(_), Err(_)) if b.is_empty() => std::cmp::Ordering::Greater,
        (Err(_), Ok(_)) if a.is_empty() => std::cmp::Ordering::Less,
        _ => fold(a).cmp(&fold(b)),
    }
}
/// "149 Bram Lenaerts", or the name alone without a number.
pub(super) fn runner_label(r: &Value) -> String {
    let number = st(r, "runnerNumber");
    if number.is_empty() {
        st(r, "name").to_string()
    } else {
        format!("{number} {}", st(r, "name"))
    }
}
pub(super) fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

// ---------- Icons (src/components/Icon.tsx) ----------

thread_local! {
    static ICONS: RefCell<HashMap<(&'static str, String, u32, u32), rune::Image>> = RefCell::new(HashMap::new());
}
pub(super) fn icon(
    s: &State,
    name: &'static str,
    color: rune::Color,
    size: f32,
    stroke: f32,
) -> El {
    let el = rune::el().size(size, size);
    let Some(cache) = &s.image_cache else {
        return el;
    };
    let body = match name {
        "check" => r#"<path d="M20 6 9 17l-5-5"/>"#,
        "alert" => r#"<path d="M12 8v5M12 16.5v.01"/><circle cx="12" cy="12" r="9"/>"#,
        "close" => r#"<path d="M18 6 6 18M6 6l12 12"/>"#,
        "chevronDown" => r#"<path d="M6 9l6 6 6-6"/>"#,
        "chevronUp" => r#"<path d="M6 15l6-6 6 6"/>"#,
        "chevronRight" => r#"<path d="M9 5.5l6.5 6.5-6.5 6.5"/>"#,
        _ => "",
    };
    let hex = color.hex();
    let key = (
        name,
        hex.clone(),
        (stroke * 100.0) as u32,
        (size * 10.0) as u32,
    );
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

// ---------- Primitives ----------

/// A boxed panel: 16 padding, 1px line, 8 radius, surface. Beheer sections are open instead.
pub(super) fn panel(s: &State) -> El {
    let p = pal(s.dark);
    col()
        .w_full()
        .min_w(0.0)
        .padding(16.0)
        .radius(8.0)
        .fill(p.surface)
        .border(1.0, p.line)
}
/// Beheer sections one under the other, split by a thin line; each section is an
/// [`admin_kit::panel`](super::admin_kit::panel).
pub(super) fn stack(s: &State, sections: Vec<El>) -> El {
    let line = pal(s.dark).line;
    let last = sections.len().saturating_sub(1);
    let mut page = col().w_full().min_w(0.0);
    for (i, mut section) in sections.into_iter().enumerate() {
        if i > 0 {
            section = section.pt(28.0).border_sides([1.0, 0.0, 0.0, 0.0], line);
        }
        page = page.child(if i < last { section.pb(28.0) } else { section });
    }
    page
}
pub(super) fn h2(s: &State, title: &str) -> El {
    super::admin_kit::h2(title, s.dark).level(2)
}
pub(super) fn h3(s: &State, title: &str) -> El {
    text(title.to_string())
        .font(ts(13.0, 600.0).lh(16.25))
        .color(pal(s.dark).ink)
        .role("heading")
        .level(3)
}
/// `.panel-copy`: 13.5px ink-2, at most 76ch wide.
pub(super) fn copy(s: &State, value: impl Into<String>) -> El {
    text(value.into())
        .font(ts(13.5, 400.0).lh(20.25))
        .color(pal(s.dark).t.ink2)
        .wrap()
        .max_w(super::admin_kit::COPY_MAX)
        .min_w(0.0)
}

#[derive(Clone, Copy, PartialEq)]
pub(super) enum Kind {
    Plain,
    Primary,
    Ghost,
    Quiet,
    /// `.btn--quiet.btn--danger-outline`
    QuietDanger,
    Danger,
}
/// `.btn`: 34 high (28 for `.btn--sm`), 13.5px medium label (13px small).
pub(super) fn btn(
    s: &State,
    key: impl Into<String>,
    label: &str,
    kind: Kind,
    sm: bool,
    disabled: bool,
) -> El {
    let p = pal(s.dark);
    let (mut fill, mut line, mut ink, hover) = match kind {
        Kind::Plain => (p.surface, p.t.line2, p.ink, p.t.surface2),
        Kind::Primary => (p.brand, p.brand, p.on_brand, p.brand_hover),
        Kind::Ghost => (rune::Color::TRANSPARENT, p.t.line2, p.ink, p.t.surface2),
        Kind::Quiet => (
            rune::Color::TRANSPARENT,
            rune::Color::TRANSPARENT,
            p.t.ink2,
            p.t.surface3,
        ),
        Kind::QuietDanger => (
            rune::Color::TRANSPARENT,
            rune::Color::TRANSPARENT,
            p.stop_ink,
            p.t.stop_wash,
        ),
        Kind::Danger => (p.t.stop, p.t.stop, p.on_brand, p.stop_ink),
    };
    let quiet = matches!(kind, Kind::Quiet | Kind::QuietDanger);
    if disabled {
        if quiet {
            ink = p.t.ink3;
        } else {
            fill = p.t.surface2;
            line = p.line;
            ink = p.t.ink3;
        }
    }
    let mut b = row()
        .key(key.into())
        .role("button")
        .label(label.to_string())
        .focusable(!disabled)
        .disabled(disabled)
        .h(if sm { 28.0 } else { 34.0 })
        .px(if sm { 10.0 } else { 12.0 })
        .gap(6.0)
        .center()
        .radius(6.0)
        .fill(fill)
        .border(1.0, line)
        .child(
            text(label.to_string())
                .font(ts(if sm { 13.0 } else { 13.5 }, 500.0))
                .color(ink),
        );
    if !disabled {
        b = b.hover(hover);
        if kind == Kind::Plain && !s.dark {
            b = b.shadow(1.0, 2.0, rune::oklcha(0.21, 0.006, 285.9, 0.05));
        }
    }
    b
}
/// `.input`: 34 high, 1px line-2 border, brand ring while focused.
pub(super) fn field(s: &State, edit: &TextEdit, key: &str, title: &str, placeholder: &str) -> El {
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
/// A closed `select.input`: the chosen option and the chevron; pressing it opens [`select_menu`].
pub(super) fn select(s: &State, key: &str, title: &str, value: &str) -> El {
    let p = pal(s.dark);
    let open = s.admin.select.as_deref() == Some(key);
    let owned = key.to_string();
    let measured = key.to_string();
    row()
        .key(key.to_string())
        .role("combobox")
        .label(title.to_string())
        .a11y_value(value.to_string())
        .expanded(open)
        .focusable(true)
        .h(34.0)
        .pl(14.0)
        .pr(8.0)
        .gap(8.0)
        .center_y()
        .min_w(0.0)
        .radius(6.0)
        .fill(p.surface)
        .border(1.0, if open { p.brand } else { p.t.line2 })
        .on_layout(move |s: &mut State, rect| track_width(s, &measured, rect[2]))
        .on_press(move |s: &mut State| {
            s.admin.select = if s.admin.select.as_deref() == Some(owned.as_str()) {
                None
            } else {
                Some(owned.clone())
            };
        })
        .child(
            text(value.to_string())
                .font(ts(13.5, 400.0))
                .color(p.ink)
                .grow(1.0)
                .min_w(0.0)
                .truncate(),
        )
        .child(icon(s, "chevronDown", p.ink, 14.0, 2.5))
}
pub(super) type Choose = Box<dyn Fn(&mut State)>;
/// The open options of a [`select`], under it, as wide as it.
pub(super) fn select_menu(s: &State, key: &str, options: Vec<(String, bool, Choose)>) -> El {
    let p = pal(s.dark);
    let mut items = col().min_h(0.0).shrink().scroll(ScrollSpec {
        stick_bottom: false,
    });
    for (i, (title, selected, choose)) in options.into_iter().enumerate() {
        items = items.child(
            row()
                .key(format!("{key}-option-{i}"))
                .role("option")
                .label(title.clone())
                .checked(selected)
                .focusable(true)
                .h(28.0)
                .px(14.0)
                .center_y()
                .fill(if selected {
                    p.t.surface3
                } else {
                    rune::Color::TRANSPARENT
                })
                .hover(p.t.surface2)
                .on_press(move |s: &mut State| {
                    s.admin.select = None;
                    choose(s);
                })
                .child(text(title).font(ts(13.5, 400.0)).color(p.ink)),
        );
    }
    let list = col()
        .key(format!("{key}-menu"))
        .role("listbox")
        .anchored_fit(key.to_string(), rune::Side::Bottom, rune::Align::Start, 2.0)
        .w(s.admin.select_w(key))
        .min_h(0.0)
        .py(4.0)
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
        .child(items);
    rune::el()
        .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
        .modal(true, |s: &mut State| s.admin.select = None)
        .child(list)
}
/// `.label-pill` (`--compact` in tables): logo or dot, then the name.
pub(super) fn pill(s: &State, l: &Value, compact: bool) -> El {
    let p = pal(s.dark);
    let color = rune::color::hex(st(l, "color")).unwrap_or(p.t.ink3);
    let mut b = row()
        .h(if compact { 18.0 } else { 20.0 })
        .gap(5.0)
        .pl(5.0)
        .pr(6.0)
        .center_y()
        .min_w(0.0)
        .radius(4.0)
        .fill(p.surface)
        .border(1.0, p.line);
    if let Some(image) = l["imageUrl"].as_str().and_then(|url| s.logos.get(url)) {
        b = b.child(
            rune::el()
                .size(14.0, 14.0)
                .radius(2.0)
                .pixels_fit(image.pixels(), rune::SurfaceFit::Fit),
        );
    } else {
        b = b.child(rune::el().size(7.0, 7.0).radius(3.5).fill(color));
    }
    b.child(
        text(st(l, "name").to_string())
            .font(ts(if compact { 11.5 } else { 12.0 }, 500.0))
            .color(p.t.ink2)
            .min_w(0.0)
            .truncate(),
    )
}
/// `.warning-banner` (`[role=alert]` in the stop colours).
pub(super) fn banner(s: &State, alert: bool) -> El {
    let p = pal(s.dark);
    col()
        .w_full()
        .gap(4.0)
        .py(9.0)
        .px(12.0)
        .radius(6.0)
        .fill(if alert { p.t.stop_wash } else { p.t.warn_wash })
        .border(1.0, if alert { p.t.stop_line } else { p.t.warn_line })
}

// ---------- Sending, and what comes back ----------

pub(super) fn send(s: &mut State, method: &str, input: Value, pending: Pending) {
    if s.busy || !s.connected {
        return;
    }
    s.send(method, input);
    if s.busy {
        s.admin.pending = Some(pending);
    }
}
pub(super) fn toast(s: &mut State, text: impl Into<String>) {
    s.admin.toast = Some(Toast {
        text: text.into(),
        detail: String::new(),
        error: false,
        at: s.server_now(),
    });
}
fn toast_error(s: &mut State, text: &str) {
    let detail = std::mem::take(&mut s.error);
    s.admin.toast = Some(Toast {
        text: text.into(),
        detail,
        error: true,
        at: s.server_now(),
    });
}
pub(super) fn owns(s: &State) -> bool {
    s.admin.pending.is_some()
}
/// Registrations say when runners can run; fetched again whenever the data changed.
pub(super) fn refresh(s: &mut State, tx: &Tx) {
    s.admin.focused = tx.focused().map(str::to_owned);
    profile::follow_stored(s);
    admin_system::refresh(s);
    if s.busy || !s.connected || s.page != 8 || !matches!(s.admin_section, 1 | 3) {
        return;
    }
    let revision = s.snapshot["revision"].as_i64().unwrap_or(0);
    if s.admin.regs_revision != Some(revision) {
        s.admin.regs_revision = Some(revision);
        send(
            s,
            "runners.registrations",
            json!({}),
            Pending::Registrations,
        );
    }
}
pub(super) fn succeeded(s: &mut State, result: &Value) {
    match s.admin.pending.take() {
        Some(Pending::Registrations) => s.admin.registrations = result.clone(),
        Some(Pending::Import) => {
            toast(
                s,
                format!(
                    "{} aangemaakt, {} bijgewerkt, {} overgeslagen",
                    result["created"], result["updated"], result["skipped"]
                ),
            );
            s.import_problems = result["errors"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect();
        }
        Some(Pending::RunnerDeleted(name)) => toast(s, format!("{name} is definitief verwijderd.")),
        Some(Pending::Unhidden(name)) => toast(s, format!("{name} is terug zichtbaar.")),
        Some(Pending::LabelCreated(name)) => {
            label_editor::created(s);
            toast(s, format!("{name} is toegevoegd."));
        }
        Some(Pending::LabelDeleted(name)) => toast(s, format!("{name} is verwijderd.")),
        Some(Pending::LabelLogo) => {}
        Some(Pending::Upload(target)) => {
            label_editor::uploaded(s, target, result["imageUrl"].as_str().unwrap_or(""))
        }
        Some(Pending::MemberAdded { runner, label }) => {
            label_editor::member_added(s);
            toast(s, format!("{runner} zit nu in {label}."));
        }
        Some(Pending::MemberRemoved { runner, label }) => {
            toast(s, format!("{runner} is uit {label} gehaald."))
        }
        Some(Pending::ProfileSaved(name)) => {
            s.profile = None;
            toast(s, format!("Profiel van {name} opgeslagen."));
        }
        Some(Pending::Status { ok, .. }) => toast(s, ok),
        None => {}
    }
}
pub(super) fn failed(s: &mut State) {
    match s.admin.pending.take() {
        Some(Pending::Registrations) => s.error.clear(),
        Some(Pending::Import) => toast_error(s, "Import mislukt"),
        Some(Pending::RunnerDeleted(_)) => toast_error(s, "Loper verwijderen mislukt"),
        Some(Pending::Unhidden(_)) => toast_error(s, "Loper terug tonen mislukt"),
        Some(Pending::LabelCreated(_)) => toast_error(s, "Label toevoegen mislukt"),
        Some(Pending::LabelDeleted(_)) => toast_error(s, "Label verwijderen mislukt"),
        Some(Pending::LabelLogo) => toast_error(s, "Logo opslaan mislukt"),
        Some(Pending::Upload(_)) => toast_error(s, "Logo kiezen mislukt"),
        Some(Pending::MemberAdded { .. }) => toast_error(s, "Toevoegen mislukt"),
        Some(Pending::MemberRemoved { .. }) => toast_error(s, "Verwijderen mislukt"),
        Some(Pending::ProfileSaved(_)) => profile::save_failed(s),
        Some(Pending::Status { failure, .. }) => toast_error(s, failure),
        None => {}
    }
}

// ---------- Overlays: selects, the confirm dialog and the toast ----------

pub(super) fn overlay(s: &State, key: &str, dismiss: impl Fn(&mut State) + 'static) -> El {
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
        .on_layout(|s: &mut State, rect| {
            if (s.admin.window_h - rect[3]).abs() > 0.5 {
                s.admin.window_h = rect[3];
            }
        })
        .modal(false, dismiss)
}
pub(super) fn overlay_shadow(s: &State) -> rune::Color {
    if s.dark {
        rune::oklcha(0.0, 0.0, 0.0, 0.5)
    } else {
        rune::oklcha(0.21, 0.006, 285.9, 0.16)
    }
}
fn run_confirm(s: &mut State) {
    let Some(c) = s.admin.confirm.take() else {
        return;
    };
    match c.action {
        ConfirmAction::DeleteRunner { id, name } => send(
            s,
            "runners.delete",
            json!({"id":id}),
            Pending::RunnerDeleted(name),
        ),
        ConfirmAction::DeleteLabel { id, name } => send(
            s,
            "labels.delete",
            json!({"id":id}),
            Pending::LabelDeleted(name),
        ),
        ConfirmAction::LeaveQueue { id, name } => send(
            s,
            "runners.setStatus",
            json!({"id":id,"status":"registered"}),
            Pending::Status {
                ok: format!("{name} staat niet meer in de wachtrij of opwarming."),
                failure: "Loper terugzetten mislukt",
            },
        ),
        ConfirmAction::LoadLatestProfile => profile::load_latest(s),
        ConfirmAction::InstallUpdate => {
            s.system_update_problem_clear();
            s.send("update.install", json!({}));
        }
    }
}
/// `ConfirmModal`: a danger question starts on Annuleer, so Enter never confirms by accident.
pub(super) fn confirm_dialog(s: &State, c: &Confirm) -> El {
    let p = pal(s.dark);
    let mut cancel = btn(
        s,
        "admin-confirm-cancel",
        "Annuleer",
        Kind::Plain,
        false,
        false,
    )
    .on_press(|s: &mut State| s.admin.confirm = None);
    let mut ok = btn(
        s,
        "admin-confirm-ok",
        &c.confirm_label,
        if c.danger {
            Kind::Danger
        } else {
            Kind::Primary
        },
        false,
        false,
    )
    .on_press(run_confirm);
    if c.danger {
        cancel = cancel.autofocus();
    } else {
        ok = ok.autofocus();
    }
    let mut card = col()
        .key("admin-confirm")
        .role("dialog")
        .label(c.title.clone())
        .w(420.0)
        .max_w(420.0)
        .padding(20.0)
        .radius(10.0)
        .fill(p.surface)
        .border(1.0, p.line)
        .shadow(16.0, 48.0, overlay_shadow(s))
        .child(
            text(c.title.clone())
                .font(ts(16.0, 600.0).lh(20.0))
                .color(p.ink)
                .wrap()
                .mb(6.0)
                .role("heading")
                .level(3),
        );
    if !c.message.is_empty() {
        card = card.child(
            text(c.message.clone())
                .font(ts(13.5, 400.0).lh(20.25))
                .color(p.t.ink2)
                .wrap(),
        );
    }
    overlay(s, "admin-confirm-overlay", |s: &mut State| {
        s.admin.confirm = None
    })
    .child(
        card.child(
            row()
                .mt(20.0)
                .gap(8.0)
                .justify_end()
                .child(cancel)
                .child(ok),
        ),
    )
}
fn toast_view(s: &State, t: &Toast) -> El {
    let p = pal(s.dark);
    let mut body = col().gap(2.0).grow(1.0).min_w(0.0).pt(2.0).child(
        text(t.text.clone())
            .font(ts(13.5, 400.0).lh(19.6))
            .color(p.ink)
            .wrap(),
    );
    if !t.detail.is_empty() {
        body = body.child(
            text(t.detail.clone())
                .font(ts(13.5, 400.0).lh(19.6))
                .color(p.t.ink2)
                .wrap(),
        );
    }
    row()
        .key("admin-toast")
        .role(if t.error { "alert" } else { "status" })
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
        .border(1.0, if t.error { p.t.stop_line } else { p.line })
        .shadow(16.0, 48.0, overlay_shadow(s))
        .child(
            rune::el()
                .size(24.0, 24.0)
                .radius(12.0)
                .center()
                .fill(if t.error { p.t.stop } else { p.t.go })
                .child(icon(
                    s,
                    if t.error { "alert" } else { "check" },
                    p.on_brand,
                    14.0,
                    2.75,
                )),
        )
        .child(body)
        .child(
            row()
                .key("admin-toast-close")
                .role("button")
                .label("Melding sluiten")
                .focusable(true)
                .size(24.0, 24.0)
                .center()
                .radius(6.0)
                .hover(p.t.surface3)
                .on_press(|s: &mut State| s.admin.toast = None)
                .child(icon(s, "close", p.t.ink3, 14.0, 2.0)),
        )
}
/// Everything these sections draw over the page; `None` when nothing is open.
pub(super) fn modal(s: &State) -> Option<El> {
    if s.page != 8 {
        return None;
    }
    if let Some(c) = &s.admin.confirm {
        return Some(confirm_dialog(s, c));
    }
    if s.profile.is_some() {
        return Some(profile::modal(s));
    }
    let mut layers: Vec<El> = Vec::new();
    if let Some(key) = &s.admin.select {
        layers.extend(match s.admin_section {
            1 => admin_runners::select_menu(s, key),
            3 => label_editor::select_menu(s, key),
            _ => None,
        });
    }
    if let Some(t) = &s.admin.toast
        && (t.error || s.clock - t.at < TOAST_MS)
    {
        layers.push(toast_view(s, t));
    }
    if layers.is_empty() {
        return None;
    }
    let mut layer = rune::el().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0));
    for l in layers {
        layer = layer.child(l);
    }
    Some(layer)
}
