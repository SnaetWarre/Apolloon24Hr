//! Beheer › Labels: a new label (name, colour, kind, logo), the labels by kind with their member
//! count, logo and Verwijder, and per label who is in it. Port of
//! src/components/admin/LabelsSection.tsx, LabelAdminRow.tsx, LabelImagePicker.tsx,
//! LabelMembers.tsx and src/lib/labels.ts.
use super::admin_base::{
    Choose, Confirm, ConfirmAction, Kind, Pending, btn, field, fold, h2, h3, icon, numeric_cmp,
    pal, panel, pill, plural, runner_label, send, st, ts,
};
use super::*;
use std::collections::{HashMap, HashSet};

const KIND_SELECT: &str = "label-kind";
const COLOR_SELECT: &str = "label-color";
const KINDS: [(&str, &str); 4] = [
    ("speedteam", "Speedteam"),
    ("zustervereniging", "Zustervereniging"),
    ("andere", "Andere"),
    ("custom", "Custom"),
];
const SWATCHES: [&str; 12] = [
    "#3b82f6", "#2563eb", "#0ea5e9", "#14b8a6", "#16a34a", "#84cc16", "#eab308", "#f97316",
    "#dc2626", "#db2777", "#9333ea", "#64748b",
];

/// Where a picked logo goes: the new label, or an existing one.
#[derive(Clone, PartialEq, Debug)]
pub(super) enum LogoTarget {
    New,
    Label(String),
}
pub(super) struct Form {
    name: TextEdit,
    color: String,
    color_edit: TextEdit,
    kind: String,
    image: Option<String>,
    /// Labels whose members are open.
    open: HashSet<String>,
    queries: HashMap<String, TextEdit>,
    suggestions: HashSet<String>,
    /// The logo picker that asked for a file, and the one whose upload is on its way.
    picking: Option<LogoTarget>,
    pub(super) busy: Option<LogoTarget>,
    /// The label whose member box gets the focus back after an add.
    refocus: Option<String>,
}
impl Default for Form {
    fn default() -> Self {
        Self {
            name: TextEdit::new(""),
            color: "#3b82f6".into(),
            color_edit: TextEdit::new("#3b82f6"),
            kind: "andere".into(),
            image: None,
            open: HashSet::new(),
            queries: HashMap::new(),
            suggestions: HashSet::new(),
            picking: None,
            busy: None,
            refocus: None,
        }
    }
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
/// Labels by kind, speedteams first, then by name.
fn grouped(s: &State) -> Vec<(String, Vec<&Value>)> {
    let mut labels: Vec<&Value> = s.snapshot["labels"]
        .as_array()
        .into_iter()
        .flatten()
        .collect();
    labels.sort_by(|a, b| {
        kind_order(st(a, "kind"))
            .cmp(&kind_order(st(b, "kind")))
            .then(fold(st(a, "name")).cmp(&fold(st(b, "name"))))
    });
    let mut groups: Vec<(String, Vec<&Value>)> = Vec::new();
    for l in labels {
        match groups.iter_mut().find(|(k, _)| k == st(l, "kind")) {
            Some((_, list)) => list.push(l),
            None => groups.push((st(l, "kind").to_string(), vec![l])),
        }
    }
    groups
}
fn in_label(r: &Value, id: &str) -> bool {
    r["labels"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|l| st(l, "id") == id)
}
fn compare_runners(a: &Value, b: &Value) -> std::cmp::Ordering {
    numeric_cmp(st(a, "runnerNumber"), st(b, "runnerNumber"))
        .then(fold(st(a, "name")).cmp(&fold(st(b, "name"))))
}
fn members<'a>(s: &'a State, id: &str) -> Vec<&'a Value> {
    let mut list: Vec<&Value> = runners(s).into_iter().filter(|r| in_label(r, id)).collect();
    list.sort_by(|a, b| compare_runners(a, b));
    list
}
/// Runners outside the label who match the add box: exact number, then a word start, then any match.
fn to_add<'a>(s: &'a State, id: &str, query: &str) -> Vec<&'a Value> {
    let q = fold(query.trim());
    if q.is_empty() {
        return Vec::new();
    }
    let mut scored: Vec<(u8, &Value)> = runners(s)
        .into_iter()
        .filter(|r| !in_label(r, id))
        .filter_map(|r| {
            let number = st(r, "runnerNumber");
            if !number.is_empty() && fold(number) == q {
                return Some((0, r));
            }
            let name = fold(st(r, "name"));
            if name.split_whitespace().any(|w| w.starts_with(&q)) || name.starts_with(&q) {
                return Some((1, r));
            }
            fold(&format!("{number} {}", st(r, "name")))
                .contains(&q)
                .then_some((2, r))
        })
        .collect();
    scored.sort_by(|a, b| a.0.cmp(&b.0).then(compare_runners(a.1, b.1)));
    scored.into_iter().take(6).map(|(_, r)| r).collect()
}
/// What someone typed as study phase when they forgot to tick the matching box.
fn phase_hint(label: &str, phase: &str) -> bool {
    let p = phase.trim().to_lowercase();
    match label.trim().to_lowercase().as_str() {
        "1ste jaar" => {
            let rest = if let Some(r) = p.strip_prefix("eerste") {
                r
            } else if let Some(r) = p.strip_prefix('1') {
                let r = r.trim_start();
                r.strip_prefix("ste")
                    .or_else(|| r.strip_prefix('e'))
                    .unwrap_or(r)
            } else {
                return false;
            };
            let rest = rest.trim_start();
            rest.starts_with("bach") || rest.starts_with("jaar")
        }
        "anciens" => [
            "afgestudeerd",
            "alumn",
            "oudstudent",
            "oud-student",
            "exstudent",
            "ex-student",
        ]
        .iter()
        .any(|w| p.contains(w)),
        _ => false,
    }
}
fn suggested<'a>(s: &'a State, l: &Value) -> Vec<&'a Value> {
    let id = st(l, "id");
    let mut list: Vec<&Value> = runners(s)
        .into_iter()
        .filter(|r| {
            !in_label(r, id)
                && phase_hint(
                    st(l, "name"),
                    st(&s.admin.registrations[st(r, "id")], "studyPhase"),
                )
        })
        .collect();
    list.sort_by(|a, b| compare_runners(a, b));
    list
}

// ---------- Actions ----------

fn add_label(s: &mut State) {
    let name = s.label_form.name.text.trim().to_string();
    if name.is_empty() {
        return;
    }
    let f = &s.label_form;
    let input = json!({
        "name": name,
        "color": f.color,
        "icon": name.chars().take(2).collect::<String>().to_uppercase(),
        "kind": f.kind,
        "imageUrl": f.image,
    });
    send(s, "labels.create", input, Pending::LabelCreated(name));
}
pub(super) fn created(s: &mut State) {
    s.label_form.name = TextEdit::new("");
    s.label_form.image = None;
}
fn choose(s: &mut State, tx: &mut Tx, target: LogoTarget) {
    if s.busy {
        return;
    }
    s.label_form.picking = Some(target);
    choose_logo(s, tx);
}
/// The picked file goes up; [`uploaded`] puts its address where it was asked for.
pub(super) fn upload(s: &mut State, bytes: Vec<u8>) {
    let target = s.label_form.picking.take().unwrap_or(LogoTarget::New);
    s.label_form.busy = Some(target.clone());
    send(
        s,
        "labels.uploadFile",
        json!({"dataBase64":base64::engine::general_purpose::STANDARD.encode(bytes)}),
        Pending::Upload(target),
    );
    if !s.busy {
        s.label_form.busy = None;
    }
}
pub(super) fn uploaded(s: &mut State, target: LogoTarget, url: &str) {
    s.label_form.busy = None;
    match target {
        LogoTarget::New => s.label_form.image = Some(url.to_string()),
        LogoTarget::Label(id) => save_image(s, &id, Some(url.to_string())),
    }
}
fn save_image(s: &mut State, id: &str, image: Option<String>) {
    send(
        s,
        "labels.update",
        json!({"id":id,"fields":{"imageUrl":image}}),
        Pending::LabelLogo,
    );
}
fn remove_label(s: &mut State, id: &str, name: &str) {
    s.admin.confirm = Some(Confirm {
        title: format!("Label {name} verwijderen?"),
        message: "Dit verwijdert het label ook van lopers.".into(),
        confirm_label: "Label verwijderen".into(),
        danger: true,
        action: ConfirmAction::DeleteLabel {
            id: id.to_string(),
            name: name.to_string(),
        },
    });
}
fn add_member(s: &mut State, label_id: &str, runner_id: &str) {
    let label = s.snapshot["labels"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|l| st(l, "id") == label_id)
        .map(|l| st(l, "name").to_string());
    let runner = runners(s)
        .into_iter()
        .find(|r| st(r, "id") == runner_id)
        .map(|r| st(r, "name").to_string());
    let (Some(label), Some(runner)) = (label, runner) else {
        return;
    };
    s.label_form.refocus = Some(label_id.to_string());
    send(
        s,
        "labels.addRunner",
        json!({"labelId":label_id,"runnerId":runner_id}),
        Pending::MemberAdded { runner, label },
    );
}
pub(super) fn member_added(s: &mut State) {
    if let Some(id) = s.label_form.refocus.take() {
        s.label_form.queries.insert(id, TextEdit::new(""));
    }
}
fn remove_member(s: &mut State, label_id: &str, label: &str, runner_id: &str, runner: &str) {
    send(
        s,
        "labels.removeRunner",
        json!({"labelId":label_id,"runnerId":runner_id}),
        Pending::MemberRemoved {
            runner: runner.to_string(),
            label: label.to_string(),
        },
    );
}

// ---------- Selects ----------

pub(super) fn select_menu(s: &State, key: &str) -> Option<El> {
    match key {
        KIND_SELECT => {
            let options: Vec<(String, bool, Choose)> = KINDS
                .iter()
                .map(|(value, title)| {
                    let v = value.to_string();
                    let chosen: Choose =
                        Box::new(move |s: &mut State| s.label_form.kind = v.clone());
                    (title.to_string(), s.label_form.kind == *value, chosen)
                })
                .collect();
            Some(admin_base::select_menu(s, KIND_SELECT, options))
        }
        COLOR_SELECT => Some(color_menu(s)),
        _ => None,
    }
}
fn set_color(s: &mut State, color: &str) {
    s.label_form.color = color.to_lowercase();
    s.label_form.color_edit = TextEdit::new(color.to_lowercase());
}
/// What the browser's colour picker offers: a few swatches and the hex code.
fn color_menu(s: &State) -> El {
    let p = pal(s.dark);
    let mut swatches = row().gap(6.0).flex_wrap().w(196.0);
    for hex in SWATCHES {
        let chosen = s.label_form.color.eq_ignore_ascii_case(hex);
        swatches = swatches.child(
            rune::el()
                .key(format!("label-color-{hex}"))
                .role("button")
                .label(hex)
                .focusable(true)
                .size(28.0, 28.0)
                .radius(6.0)
                .fill(rune::color::hex(hex).unwrap())
                .border(
                    if chosen { 2.0 } else { 1.0 },
                    if chosen { p.ink } else { p.line },
                )
                .on_press(move |s: &mut State| {
                    set_color(s, hex);
                    s.admin.select = None;
                }),
        );
    }
    let card = col()
        .key("label-color-menu")
        .anchored_fit(COLOR_SELECT, rune::Side::Bottom, rune::Align::Start, 4.0)
        .gap(10.0)
        .padding(12.0)
        .radius(8.0)
        .fill(p.surface)
        .border(1.0, p.t.line2)
        .shadow(8.0, 24.0, admin_base::overlay_shadow(s))
        .child(swatches)
        .child(
            field(
                s,
                &s.label_form.color_edit,
                "label-color-hex",
                "Kleur in hex",
                "#3b82f6",
            )
            .w(196.0)
            .on_edit(|s: &mut State| &mut s.label_form.color_edit)
            .on_submit(|s: &mut State, _tx: &mut Tx| {
                let v = s.label_form.color_edit.text.trim().to_string();
                if v.len() == 7 && rune::color::hex(&v).is_some() {
                    set_color(s, &v);
                    s.admin.select = None;
                }
            }),
        );
    rune::el()
        .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
        .modal(true, |s: &mut State| {
            let v = s.label_form.color_edit.text.trim().to_string();
            if v.len() == 7 && rune::color::hex(&v).is_some() {
                set_color(s, &v);
            }
            s.admin.select = None;
        })
        .child(card)
}

// ---------- The section ----------

/// `LabelImagePicker`: the logo, Logo kiezen or Ander logo, and Weg.
fn image_picker(
    s: &State,
    key: &str,
    image: Option<&str>,
    target: LogoTarget,
    compact: bool,
) -> El {
    let loading = s.label_form.busy.as_ref() == Some(&target);
    let mut picker = row().gap(8.0).center_y().min_w(0.0);
    if let Some(url) = image {
        let preview = rune::el().size(28.0, 28.0);
        picker = picker.child(match s.logos.get(url) {
            Some(img) => preview.pixels_fit(img.pixels(), rune::SurfaceFit::Fit),
            None => preview,
        });
    }
    let title = if loading {
        "Logo laden..."
    } else if image.is_some() {
        "Ander logo"
    } else {
        "Logo kiezen"
    };
    let mut choose_btn = btn(
        s,
        format!("{key}-logo"),
        title,
        Kind::Plain,
        compact,
        loading,
    );
    if !loading {
        let t = target.clone();
        choose_btn =
            choose_btn.on_press_tx(move |s: &mut State, tx: &mut Tx| choose(s, tx, t.clone()));
    }
    picker = picker.child(choose_btn);
    if image.is_some() {
        let mut clear = btn(
            s,
            format!("{key}-logo-clear"),
            "Weg",
            Kind::Quiet,
            compact,
            loading,
        )
        .label("Logo weghalen");
        if !loading {
            clear = clear.on_press(move |s: &mut State| match &target {
                LogoTarget::New => s.label_form.image = None,
                LogoTarget::Label(id) => save_image(s, id, None),
            });
        }
        picker = picker.child(clear);
    }
    picker
}

fn members_panel(s: &State, l: &Value) -> El {
    let p = pal(s.dark);
    let id = st(l, "id").to_string();
    let name = st(l, "name").to_string();
    let pending = s.busy;
    let empty = TextEdit::new("");
    let query = s.label_form.queries.get(&id).unwrap_or(&empty);
    let matches = to_add(s, &id, &query.text);
    let speed = st(l, "kind") == "speedteam";
    let first = matches.first().map(|r| st(r, "id").to_string());
    let (qid, sid, eid) = (id.clone(), id.clone(), id.clone());
    let mut add = col().gap(4.0).max_w(420.0).w_full().child(
        field(
            s,
            query,
            &format!("label-members-search-{id}"),
            &format!("Loper toevoegen aan {name}"),
            "Naam of nummer, Enter om toe te voegen",
        )
        .role("searchbox")
        .on_edit(move |s: &mut State| {
            s.label_form
                .queries
                .entry(qid.clone())
                .or_insert_with(|| TextEdit::new(""))
        })
        .on_submit(move |s: &mut State, _tx: &mut Tx| {
            if let Some(r) = &first
                && !s.busy
            {
                add_member(s, &sid, r);
            }
        }),
    );
    if !query.text.trim().is_empty() {
        let mut list = col()
            .key(format!("label-matches-{id}"))
            .role("list")
            .label("Gevonden lopers")
            .items_start();
        for r in &matches {
            let rid = st(r, "id").to_string();
            let other = if speed {
                r["labels"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|o| st(o, "kind") == "speedteam" && st(o, "id") != id)
            } else {
                None
            };
            let lid = id.clone();
            let mut b = btn(
                s,
                format!("label-member-{rid}"),
                &format!("+ {}", runner_label(r)),
                Kind::Quiet,
                true,
                pending,
            );
            if let Some(o) = other {
                b = b.child(
                    text(format!("nu in {}", st(o, "name")))
                        .font(ts(12.5, 400.0))
                        .color(p.t.ink3),
                );
            }
            if !pending {
                b = b.on_press(move |s: &mut State| add_member(s, &lid, &rid));
            }
            list = list.child(b);
        }
        if matches.is_empty() {
            list = list.child(
                text(format!("Geen loper gevonden buiten {name}"))
                    .font(ts(12.5, 400.0))
                    .color(p.t.ink3)
                    .ml(8.0),
            );
        }
        add = add.child(list);
    }
    let mut body = col()
        .key(format!("label-members-{id}"))
        .gap(12.0)
        .padding(12.0)
        .radius(8.0)
        .fill(p.t.surface2)
        .child(add);
    let current = members(s, &id);
    if current.is_empty() {
        body = body.child(
            text(format!("Nog niemand in {name}."))
                .font(ts(12.5, 400.0))
                .color(p.t.ink3),
        );
    } else {
        let mut chips = row()
            .role("list")
            .label(format!("Lopers in {name}"))
            .gap(6.0)
            .flex_wrap();
        for r in current {
            let (rid, rname, lid, lname) = (
                st(r, "id").to_string(),
                st(r, "name").to_string(),
                id.clone(),
                name.clone(),
            );
            let mut x = row()
                .key(format!("label-member-remove-{rid}"))
                .role("button")
                .label(format!("{rname} uit {name} halen"))
                .focusable(!pending)
                .disabled(pending)
                .size(26.0, 26.0)
                .center()
                .radius(13.0)
                .hover(p.t.surface3)
                .child(text("×").font(ts(16.0, 400.0)).color(p.t.ink3));
            if !pending {
                x = x.on_press(move |s: &mut State| remove_member(s, &lid, &lname, &rid, &rname));
            }
            chips = chips.child(
                row()
                    .role("listitem")
                    .gap(2.0)
                    .pl(10.0)
                    .center_y()
                    .min_w(0.0)
                    .radius(13.0)
                    .fill(p.surface)
                    .border(1.0, p.t.line2)
                    .child(
                        text(runner_label(r))
                            .font(ts(13.0, 400.0))
                            .color(p.ink)
                            .truncate()
                            .min_w(0.0),
                    )
                    .child(x),
            );
        }
        body = body.child(chips);
    }
    let suggestions = suggested(s, l);
    if !suggestions.is_empty() {
        let open = s.label_form.suggestions.contains(&id);
        let mut details = col().child(
            row()
                .key(format!("label-suggestions-{id}"))
                .role("button")
                .label(format!(
                    "Misschien ook: {}",
                    plural(suggestions.len(), "loper", "lopers")
                ))
                .expanded(open)
                .focusable(true)
                .gap(6.0)
                .center_y()
                .on_press(move |s: &mut State| {
                    if !s.label_form.suggestions.remove(&eid) {
                        s.label_form.suggestions.insert(eid.clone());
                    }
                })
                .child(icon(
                    s,
                    if open { "chevronDown" } else { "chevronRight" },
                    p.ink,
                    12.0,
                    2.5,
                ))
                .child(
                    text(format!(
                        "Misschien ook: {}",
                        plural(suggestions.len(), "loper", "lopers")
                    ))
                    .font(ts(13.5, 600.0))
                    .color(p.ink),
                ),
        );
        if open {
            details = details.child(
                text(format!("Hun studiefase past bij {name}, maar ze vinkten het vakje in het formulier niet aan."))
                    .font(ts(12.5, 400.0))
                    .color(p.t.ink3)
                    .wrap()
                    .mt(4.0)
                    .mb(8.0),
            );
            for r in suggestions {
                let (rid, lid) = (st(r, "id").to_string(), id.clone());
                let mut b = btn(
                    s,
                    format!("label-suggest-{rid}"),
                    "Toevoegen",
                    Kind::Plain,
                    true,
                    pending,
                );
                if !pending {
                    b = b.on_press(move |s: &mut State| add_member(s, &lid, &rid));
                }
                details = details.child(
                    row()
                        .gap(8.0)
                        .py(4.0)
                        .center_y()
                        .border_sides([0.0, 0.0, 1.0, 0.0], p.line)
                        .child(
                            text(runner_label(r))
                                .font(ts(13.0, 400.0))
                                .color(p.ink)
                                .w(224.0)
                                .truncate(),
                        )
                        .child(
                            text(format!(
                                "\"{}\"",
                                st(&s.admin.registrations[st(r, "id")], "studyPhase")
                            ))
                            .font(ts(12.5, 400.0))
                            .color(p.t.ink3)
                            .w(256.0)
                            .truncate(),
                        )
                        .child(b),
                );
            }
        }
        body = body.child(details);
    }
    body
}

/// `LabelAdminRow`: the badge, the member count that opens the members, the logo and Verwijder.
fn label_row(s: &State, l: &Value, first: bool, last: bool) -> El {
    let p = pal(s.dark);
    let id = st(l, "id").to_string();
    let open = s.label_form.open.contains(&id);
    let count = runners(s).into_iter().filter(|r| in_label(r, &id)).count();
    let toggle = id.clone();
    let count_btn = btn(
        s,
        format!("label-count-{id}"),
        &plural(count, "loper", "lopers"),
        Kind::Quiet,
        true,
        false,
    )
    .expanded(open)
    .child(icon(
        s,
        if open { "chevronUp" } else { "chevronDown" },
        p.t.ink2,
        13.0,
        1.75,
    ))
    .on_press(move |s: &mut State| {
        if !s.label_form.open.remove(&toggle) {
            s.label_form.open.insert(toggle.clone());
        }
    });
    let mut logo = col().gap(4.0).w(200.0);
    if first {
        logo = logo.child(text("Logo").font(ts(12.0, 400.0).lh(18.0)).color(p.t.ink3));
    }
    logo = logo.child(image_picker(
        s,
        &format!("label-{id}"),
        l["imageUrl"].as_str(),
        LogoTarget::Label(id.clone()),
        true,
    ));
    let (did, dname) = (id.clone(), st(l, "name").to_string());
    let mut line = row()
        .gap(8.0)
        .items_end()
        .child(
            row()
                .grow(1.0)
                .min_w(160.0)
                .h(28.0)
                .center_y()
                .child(pill(s, l, false)),
        )
        .child(row().h(28.0).center_y().child(count_btn))
        .child(logo)
        .child(
            btn(
                s,
                format!("delete-label-{id}"),
                "Verwijder",
                Kind::QuietDanger,
                true,
                false,
            )
            .on_press(move |s: &mut State| remove_label(s, &did, &dname)),
        );
    if open {
        line = col().gap(8.0).child(line).child(members_panel(s, l));
    }
    // `padding: 8px 0` plus the border under it, which Rune draws inside the box.
    let _ = last;
    col()
        .key(format!("label-row-{id}"))
        .pt(8.0)
        .pb(9.0)
        .child(line)
        .border_sides([0.0, 0.0, 1.0, 0.0], p.line)
}

pub(super) fn panel_view(s: &State) -> El {
    let p = pal(s.dark);
    let f = &s.label_form;
    let adding = matches!(s.admin.pending, Some(Pending::LabelCreated(_)));
    let kind_name = KINDS
        .iter()
        .find(|(v, _)| *v == f.kind)
        .map(|(_, t)| *t)
        .unwrap_or("Andere");
    let color = rune::color::hex(&f.color).unwrap_or(p.brand);
    let can_add = !f.name.text.trim().is_empty() && !adding;
    let mut add_btn = btn(
        s,
        "label-save",
        if adding {
            "Toevoegen..."
        } else {
            "Label toevoegen"
        },
        Kind::Primary,
        false,
        !can_add,
    );
    if can_add {
        add_btn = add_btn.on_press(add_label);
    }
    let create =
        row()
            .key("label-create-row")
            .my(12.0)
            .gap(8.0)
            .center_y()
            .child(
                row().w(0.0).grow(1.3).min_w(140.0).child(
                    field(
                        s,
                        &f.name,
                        "label-name",
                        "Naam van het nieuwe label",
                        "Nieuw label",
                    )
                    .w_full()
                    .on_edit(|s: &mut State| &mut s.label_form.name)
                    .on_submit(|s: &mut State, _tx: &mut Tx| add_label(s)),
                ),
            )
            .child(
                row()
                    .key(COLOR_SELECT)
                    .role("button")
                    .label("Kleur van het nieuwe label")
                    .a11y_value(f.color.clone())
                    .focusable(true)
                    .size(44.0, 34.0)
                    .padding(4.0)
                    .radius(6.0)
                    .fill(p.surface)
                    .border(1.0, p.t.line2)
                    .on_press(|s: &mut State| {
                        s.label_form.color_edit = TextEdit::new(s.label_form.color.clone());
                        s.admin.select = Some(COLOR_SELECT.into());
                    })
                    .child(rune::el().grow(1.0).h_full().radius(2.0).fill(color)),
            )
            .child(
                row().w(0.0).grow(1.0).min_w(120.0).child(
                    select(s, KIND_SELECT, "Soort van het nieuwe label", kind_name).w_full(),
                ),
            )
            .child(row().w(0.0).grow(1.3).min_w(140.0).child(image_picker(
                s,
                "label",
                f.image.as_deref(),
                LogoTarget::New,
                false,
            )))
            .child(add_btn);
    let mut list = col().key("label-admin-list").gap(8.0);
    for (kind, labels) in grouped(s) {
        let mut group = col().child(h3(s, kind_title(&kind)).color(p.t.ink2).mt(16.0).mb(4.0));
        let n = labels.len();
        for (i, l) in labels.into_iter().enumerate() {
            group = group.child(label_row(s, l, i == 0, i + 1 == n));
        }
        list = list.child(group);
    }
    panel(s)
        .key("labels-panel")
        .child(h2(s, "Labels").mb(8.0))
        .child(create)
        .child(list)
}
fn select(s: &State, key: &str, title: &str, value: &str) -> El {
    admin_base::select(s, key, title, value)
}
impl Form {
    /// A logo uploaded outside these sections lands on the new label.
    pub(super) fn set_image(&mut self, url: &str) {
        self.image = (!url.is_empty()).then(|| url.to_string());
    }
}
impl Form {
    #[cfg(test)]
    pub(super) fn has_new_image(&self) -> bool {
        self.image.is_some()
    }
}
