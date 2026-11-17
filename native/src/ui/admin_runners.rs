//! Beheer › Lopers: every runner with search, an hour filter, the hours strip, labels, source and
//! laps; the name opens the profile, Verwijder asks first. Port of
//! src/components/admin/RunnersSection.tsx, AdminRunnerTable.tsx and the hour helpers in
//! src/lib/availability.ts.
use super::admin_base::{
    Choose, ConfirmAction, Confirm, Kind, Pending, btn, copy, field, fold, h2, numeric_cmp, pal, panel, pill, select,
    send, st, ts,
};
use super::*;

const MAX_VISIBLE_RUNNERS: usize = 150;
const WEEKDAYS: [&str; 7] = ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"];
const HOUR_SELECT: &str = "admin-runner-hours";

pub(super) struct Page {
    pub query: TextEdit,
    pub hour: String,
    shown: usize,
    hovered: Option<String>,
}
impl Default for Page {
    fn default() -> Self {
        Self { query: TextEdit::new(""), hour: String::new(), shown: MAX_VISIBLE_RUNNERS, hovered: None }
    }
}

// ---------- Hours (src/lib/availability.ts) ----------

struct Block {
    start: u32,
    end: u32,
    weekday: Option<String>,
}
/// `20-21u (dinsdag)`, `23-00u`, `12 - 14 u (woensdag)`.
fn parse_block(text: &str) -> Option<Block> {
    let t = text.trim();
    let (hours, weekday) = match t.find('(') {
        Some(i) => {
            let rest = t[i + 1..].trim();
            let day = rest.strip_suffix(')')?.trim().to_lowercase();
            (t[..i].trim(), (!day.is_empty()).then_some(day))
        }
        None => (t, None),
    };
    let (a, b) = hours.split_once(['-', '–'])?;
    let num = |v: &str| -> Option<u32> {
        let v = v.trim().trim_end_matches(['u', 'U']).trim();
        (!v.is_empty() && v.len() <= 2 && v.chars().all(|c| c.is_ascii_digit())).then(|| v.parse().ok()).flatten()
    };
    let (start, end) = (num(a)?, num(b)?);
    if start > 23 || end > 24 || start == end {
        return None;
    }
    Some(Block { start, end: if end == 24 { 0 } else { end }, weekday })
}
fn block_covers(b: &Block, weekday: &str, hour: u32) -> bool {
    if b.weekday.as_deref().is_some_and(|d| d != weekday) {
        return false;
    }
    if b.end <= b.start { hour >= b.start || hour < b.end } else { hour >= b.start && hour < b.end }
}
fn covers(texts: &[String], weekday: &str, hour: u32) -> bool {
    texts.iter().any(|t| parse_block(t).is_some_and(|b| block_covers(&b, weekday, hour)))
}
/// The race's 24 hours from Tuesday 20:00, as (weekday, hour).
fn event_hours() -> Vec<(&'static str, u32)> {
    let mut day = 1;
    let mut hour = 20;
    let mut out = Vec::new();
    for _ in 0..24 {
        out.push((WEEKDAYS[day], hour));
        hour = (hour + 1) % 24;
        if hour == 0 {
            day = (day + 1) % 7;
        }
    }
    out
}
fn slot_label(weekday: &str, hour: u32) -> String {
    format!("{hour:02}-{:02}u ({weekday})", (hour + 1) % 24)
}
pub(super) fn hours_of(s: &State, id: &str) -> Vec<String> {
    s.admin.registrations[id]["availableHours"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect()
}
/// The event's one-hour slots that at least one registration covers, in event order.
fn covered_slots(s: &State) -> Vec<(&'static str, u32, String)> {
    let lists: Vec<Vec<String>> = s
        .admin
        .registrations
        .as_object()
        .into_iter()
        .flatten()
        .map(|(id, _)| hours_of(s, id))
        .collect();
    event_hours()
        .into_iter()
        .filter(|(d, h)| lists.iter().any(|l| covers(l, d, *h)))
        .map(|(d, h)| (d, h, slot_label(d, h)))
        .collect()
}
fn searchable_hours(texts: &[String]) -> Vec<String> {
    let mut out = texts.to_vec();
    out.extend(event_hours().into_iter().filter(|(d, h)| covers(texts, d, *h)).map(|(d, h)| slot_label(d, h)));
    out
}
/// The strip's slots and the hours as stretches: `di 20–22u`, `di 23u – wo 1u`.
fn summarize(texts: &[String]) -> (Vec<(&'static str, bool)>, Vec<String>) {
    let slots: Vec<(&str, u32, bool)> = event_hours().into_iter().map(|(d, h)| (d, h, covers(texts, d, h))).collect();
    let mut ranges = Vec::new();
    if slots.iter().all(|s| s.2) {
        ranges.push("Hele race".to_string());
    } else {
        let mut i = 0;
        while i < slots.len() {
            if !slots[i].2 {
                i += 1;
                continue;
            }
            let mut end = i;
            while end + 1 < slots.len() && slots[end + 1].2 {
                end += 1;
            }
            let (fd, fh, _) = slots[i];
            let (ld, lh, _) = slots[end];
            let day = |d: &str| d[..2].to_string();
            ranges.push(if fd == ld {
                format!("{} {fh}–{}u", day(fd), lh + 1)
            } else {
                format!("{} {fh}u – {} {}u", day(fd), day(ld), lh + 1)
            });
            i = end + 1;
        }
    }
    for t in texts {
        if !slots.iter().any(|(d, h, _)| covers(std::slice::from_ref(t), d, *h)) {
            ranges.push(t.clone());
        }
    }
    (slots.into_iter().map(|(d, _, a)| (d, a)).collect(), ranges)
}

// ---------- Runners ----------

fn status_order(status: &str) -> u8 {
    match status {
        "running" => 0,
        "waiting" => 1,
        "warming_up" => 2,
        "ran" => 3,
        "registered" => 4,
        _ => 5,
    }
}
pub(super) fn status_label(status: &str) -> &str {
    match status {
        "registered" => "Ingeschreven",
        "warming_up" => "Aan het opwarmen",
        "waiting" => "In de wachtrij",
        "running" => "Op de piste",
        "ran" => "Heeft gelopen",
        other => other,
    }
}
fn admin_status(r: &Value) -> String {
    let label = status_label(st(r, "status"));
    if r["hiddenFromQueue"] == true { format!("{label} · verborgen") } else { label.to_string() }
}
fn matching<'a>(s: &'a State) -> Vec<&'a Value> {
    let page = &s.admin.runners;
    let slot = covered_slots(s).into_iter().find(|(_, _, l)| *l == page.hour);
    let q = fold(page.query.text.trim());
    let mut list: Vec<&Value> = runners(s)
        .into_iter()
        .filter(|r| slot.as_ref().is_none_or(|(d, h, _)| covers(&hours_of(s, st(r, "id")), d, *h)))
        .filter(|r| {
            if q.is_empty() {
                return true;
            }
            let mut texts = vec![
                st(r, "name").to_string(),
                st(r, "runnerNumber").to_string(),
                admin_status(r),
                if st(r, "registrationSource") == "import" { "Import".into() } else { "Manueel".into() },
            ];
            texts.extend(r["labels"].as_array().into_iter().flatten().map(|l| st(l, "name").to_string()));
            texts.extend(searchable_hours(&hours_of(s, st(r, "id"))));
            texts.iter().any(|t| fold(t).contains(&q))
        })
        .collect();
    list.sort_by(|a, b| {
        status_order(st(a, "status"))
            .cmp(&status_order(st(b, "status")))
            .then(numeric_cmp(st(a, "runnerNumber"), st(b, "runnerNumber")))
            .then(st(a, "name").cmp(st(b, "name")))
    });
    list
}

pub(super) fn select_menu(s: &State, key: &str) -> Option<El> {
    if key != HOUR_SELECT {
        return None;
    }
    let current = s.admin.runners.hour.clone();
    let mut options: Vec<(String, bool, Choose)> = vec![(
        "Alle beschikbare uren".into(),
        current.is_empty(),
        Box::new(|s: &mut State| {
            s.admin.runners.hour.clear();
            s.admin.runners.shown = MAX_VISIBLE_RUNNERS;
        }),
    )];
    for (_, _, label) in covered_slots(s) {
        let chosen = label.clone();
        options.push((
            label.clone(),
            current == label,
            Box::new(move |s: &mut State| {
                s.admin.runners.hour = chosen.clone();
                s.admin.runners.shown = MAX_VISIBLE_RUNNERS;
            }),
        ));
    }
    Some(admin_base::select_menu(s, HOUR_SELECT, options))
}

fn remove(s: &mut State, id: &str) {
    let Some(r) = runners(s).into_iter().find(|r| st(r, "id") == id) else { return };
    if r["lapCount"].as_i64().unwrap_or(0) > 0 || r["status"] == "running" {
        return;
    }
    let name = st(r, "name").to_string();
    s.admin.confirm = Some(Confirm {
        title: format!("{name} definitief verwijderen?"),
        message: "Dit kan niet ongedaan gemaakt worden.".into(),
        confirm_label: "Definitief verwijderen".into(),
        danger: true,
        action: ConfirmAction::DeleteRunner { id: id.to_string(), name },
    });
}

/// The 24 race hours with the available ones filled, then the same hours as stretches.
fn hours_cell(s: &State, texts: &[String]) -> El {
    let p = pal(s.dark);
    if texts.is_empty() {
        return text("Niet opgegeven").font(ts(13.0, 400.0).lh(19.5)).color(p.t.ink3);
    }
    let (slots, ranges) = summarize(texts);
    let mut strip = row().gap(1.0).center_y();
    for (i, (day, available)) in slots.iter().enumerate() {
        let mut slot = rune::el().size(5.0, 14.0).radius(1.5).fill(if *available { p.brand } else { p.t.surface3 });
        if i > 0 && slots[i - 1].0 != *day {
            slot = slot.ml(3.0);
        }
        strip = strip.child(slot);
    }
    row()
        .gap(12.0)
        .center_y()
        .min_w(0.0)
        .child(strip)
        .child(
            text(ranges.join(" · "))
                .font(ts(13.0, 400.0).lh(19.5))
                .color(p.t.ink2)
                .wrap()
                .grow(1.0)
                .min_w(0.0),
        )
}

// Column widths of the reference's auto table layout at 1366 wide.
const W_NUM: f32 = 44.0;
const W_NAME: f32 = 139.0;
const W_STATUS: f32 = 122.0;
const W_LABELS: f32 = 193.0;
const W_SOURCE: f32 = 69.0;
const W_LAPS: f32 = 59.0;
const W_ACTIONS: f32 = 100.0;

pub(super) fn section(s: &State) -> El {
    let p = pal(s.dark);
    let page = &s.admin.runners;
    let all = matching(s);
    let shown = &all[..all.len().min(page.shown)];
    let slots = covered_slots(s);
    let slot = slots.iter().find(|(_, _, l)| *l == page.hour);

    let mut counts: Vec<(u8, &str, usize)> = Vec::new();
    for r in &all {
        let status = st(r, "status");
        match counts.iter_mut().find(|c| c.1 == status) {
            Some(c) => c.2 += 1,
            None => counts.push((status_order(status), status, 1)),
        }
    }
    counts.sort_by_key(|c| c.0);
    let mut found = format!("{} {} gevonden", all.len(), if all.len() == 1 { "loper" } else { "lopers" });
    if let Some((_, _, label)) = slot {
        found += &format!(" voor {label}");
    }
    if all.len() > page.shown {
        found += &format!(" · eerste {} getoond", page.shown);
    }
    if !counts.is_empty() {
        found += " · ";
        found += &counts.iter().map(|(_, st, n)| format!("{}: {n}", status_label(st))).collect::<Vec<_>>().join(" · ");
    }

    let head = |title: &str, w: Option<f32>, num: bool| {
        let t = text(title.to_string()).font(ts(12.0, 500.0).lh(18.0)).color(p.t.ink3).role("columnheader");
        let cell = row().px(10.0).py(7.0);
        let cell = match w {
            Some(w) => cell.w(w),
            None => cell.grow(1.0).min_w(0.0),
        };
        if num { cell.justify_end().child(t) } else { cell.child(t) }
    };
    let mut table = col().key("runner-admin-table").role("table").w_full().min_w(0.0).child(
        row()
            .role("row")
            .w_full()
            .border_sides([0.0, 0.0, 1.0, 0.0], p.line)
            .child(head("Nr.", Some(W_NUM), true))
            .child(head("Naam", Some(W_NAME), false))
            .child(head("Status", Some(W_STATUS), false))
            .child(head("Beschikbaar", None, false))
            .child(head("Labels", Some(W_LABELS), false))
            .child(head("Bron", Some(W_SOURCE), false))
            .child(head("Toeren", Some(W_LAPS), true))
            .child(row().w(W_ACTIONS).child(text("Acties").font(ts(12.0, 500.0)).color(rune::Color::TRANSPARENT).role("columnheader"))),
    );
    let count = shown.len();
    for (i, r) in shown.iter().enumerate() {
        let id = st(r, "id").to_string();
        let hovered = page.hovered.as_deref() == Some(id.as_str());
        let cell = |w: Option<f32>| {
            let c = row().px(10.0).py(10.0).center_y().min_w(0.0);
            match w {
                Some(w) => c.w(w),
                None => c.grow(1.0),
            }
        };
        let mut labels = row().gap(4.0).flex_wrap().min_w(0.0);
        for l in r["labels"].as_array().into_iter().flatten() {
            labels = labels.child(pill(s, l, true));
        }
        let mut actions = row().gap(4.0).justify_end().w_full();
        if r["hiddenFromQueue"] == true {
            let (rid, name) = (id.clone(), st(r, "name").to_string());
            actions = actions.child(btn(s, format!("unhide-{id}"), "Terug tonen", Kind::Plain, true, false).on_press(
                move |s: &mut State| {
                    send(s, "runners.unhide", json!({"id":rid}), Pending::Unhidden(name.clone()))
                },
            ));
        }
        let removable = r["lapCount"].as_i64().unwrap_or(0) == 0 && r["status"] != "running";
        let mut delete = btn(s, format!("delete-{id}"), "Verwijder", Kind::QuietDanger, true, !removable)
            .opacity(if hovered { 1.0 } else { 0.0 });
        if removable {
            let rid = id.clone();
            delete = delete.on_press(move |s: &mut State| remove(s, &rid));
        }
        actions = actions.child(delete);
        let open_id = id.clone();
        let hover_id = id.clone();
        let mut line = row()
            .key(format!("runner-row-{id}"))
            .role("row")
            .w_full()
            .min_w(0.0)
            .fill(if hovered { p.t.surface2 } else { p.surface })
            .on_hover_change(move |s: &mut State, on, _| {
                if on {
                    s.admin.runners.hovered = Some(hover_id.clone());
                } else if s.admin.runners.hovered.as_deref() == Some(hover_id.as_str()) {
                    s.admin.runners.hovered = None;
                }
            })
            .on_press(move |s: &mut State| profile::open(s, &open_id))
            .child(
                cell(Some(W_NUM)).justify_end().child(
                    text(match st(r, "runnerNumber") {
                        "" => "-".to_string(),
                        n => n.to_string(),
                    })
                    .font(ts(13.0, 400.0).lh(19.5))
                    .color(p.t.ink3),
                ),
            )
            .child(
                cell(Some(W_NAME)).child({
                    let pid = id.clone();
                    text(st(r, "name").to_string())
                        .key(format!("profile-{id}"))
                        .role("button")
                        .label(st(r, "name").to_string())
                        .focusable(true)
                        .font(ts(13.0, 500.0).lh(19.5))
                        .color(p.ink)
                        .wrap()
                        .min_w(0.0)
                        .on_press(move |s: &mut State| profile::open(s, &pid))
                }),
            )
            .child(cell(Some(W_STATUS)).child(text(admin_status(r)).font(ts(13.0, 400.0).lh(19.5)).color(p.t.ink3).wrap().min_w(0.0)))
            .child(cell(None).child(hours_cell(s, &hours_of(s, &id))))
            .child(cell(Some(W_LABELS)).child(labels))
            .child(
                cell(Some(W_SOURCE)).child(
                    text(if st(r, "registrationSource") == "import" { "Import" } else { "Manueel" })
                        .font(ts(12.0, 500.0).lh(20.0))
                        .color(p.t.ink2)
                        .px(6.0)
                        .radius(4.0)
                        .fill(p.t.surface2),
                ),
            )
            .child(
                cell(Some(W_LAPS))
                    .justify_end()
                    .child(text(r["lapCount"].as_i64().unwrap_or(0).to_string()).font(ts(13.0, 400.0).lh(19.5)).color(p.ink)),
            )
            .child(cell(Some(W_ACTIONS)).child(actions));
        if i + 1 < count {
            line = line.border_sides([0.0, 0.0, 1.0, 0.0], p.line);
        }
        table = table.child(line);
    }
    if shown.is_empty() {
        table = table.child(
            row().px(10.0).py(7.0).child(text("Geen lopers gevonden.").font(ts(13.0, 400.0).lh(19.5)).color(p.ink)),
        );
    }

    let hour_value = if page.hour.is_empty() { "Alle beschikbare uren".to_string() } else { page.hour.clone() };
    let mut card = panel(s)
        .key("runners-panel")
        .child(
            row()
                .gap(12.0)
                .items_start()
                .justify_between()
                .child(
                    col()
                        .min_w(0.0)
                        .shrink()
                        .child(h2(s, "Lopers beheren"))
                        .child(copy(s, "Definitief verwijderen kan alleen voor lopers zonder rondes. Gelopen data blijft bewaard voor analyse.")),
                )
                .child(btn(s, "new-runner", "Nieuwe loper", Kind::Primary, false, false).on_press_tx(
                    |s: &mut State, tx: &mut Tx| {
                        queue_page::open_add(s, true);
                        tx.focus_when_shown("add-number", false);
                    },
                )),
        )
        .child(
            row()
                .mt(12.0)
                .gap(8.0)
                .center_y()
                .child(
                    field(s, &page.query, "admin-runner-search", "Lopers zoeken", "Zoek op nummer, naam, label, status, bron of uur...")
                        .grow(1.0)
                        .w(0.0)
                        .on_edit(|s: &mut State| {
                            s.admin.runners.shown = MAX_VISIBLE_RUNNERS;
                            &mut s.admin.runners.query
                        }),
                )
                .child(
                    select(s, HOUR_SELECT, "Beschikbaar tijdens", &hour_value).grow(1.0).w(0.0),
                ),
        )
        .child(copy(s, found).mt(12.0).role("status"));
    if slot.is_some() {
        card = card.child(copy(
            s,
            "Beschikbaarheid komt uit de inschrijving. De status toont de huidige stap in de app, niet de fysieke locatie.",
        ));
    }
    card = card.child(table.mt(12.0));
    if all.len() > page.shown {
        let next = MAX_VISIBLE_RUNNERS.min(all.len() - page.shown);
        card = card.child(
            row().child(
                btn(s, "runners-more", &format!("Toon de volgende {next} lopers"), Kind::Ghost, false, false)
                    .on_press(|s: &mut State| s.admin.runners.shown += MAX_VISIBLE_RUNNERS),
            ),
        );
    }
    card
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hours_join_into_stretches_like_the_reference() {
        let texts: Vec<String> = ["20-21u (dinsdag)", "21-22u (dinsdag)", "00-01u (woensdag)"].map(String::from).to_vec();
        assert_eq!(summarize(&texts).1, vec!["di 20–22u", "wo 0–1u"]);
        let night: Vec<String> = ["23-00u (dinsdag)", "00-01u (woensdag)", "03-04u (woensdag)"].map(String::from).to_vec();
        assert_eq!(summarize(&night).1, vec!["di 23u – wo 1u", "wo 3–4u"]);
        assert!(covers(&["12-14u (woensdag)".into()], "woensdag", 13));
        assert_eq!(slot_label("dinsdag", 23), "23-00u (dinsdag)");
    }
}
