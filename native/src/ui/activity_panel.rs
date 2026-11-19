//! Beheer › Activiteit: every change, newest first, with the screen and address it came from.
//! Port of src/components/admin/ActivitySection.tsx.
use super::admin_kit as kit;
use super::*;

const PAGE_SIZE: usize = 200;

pub(super) fn refresh(s: &mut State) {
    if s.page != 8 || s.admin_section != 5 || s.busy || !s.connected {
        return;
    }
    let filter = format!("{}|{}", s.activity_queue, s.activity_search.text.trim());
    if filter != s.activity_filter || s.activity_revision != s.snapshot["revision"].as_i64().unwrap_or(0) {
        s.activity_filter = filter;
        s.send(
            "activity.list",
            json!({"limit":PAGE_SIZE,"search":s.activity_search.text.trim(),"queueMoves":s.activity_queue}),
        );
    }
}

pub(super) fn panel(s: &State) -> El {
    let p = kit::pal(s.dark);
    let empty = s.activity.is_empty();
    // An empty table shares its width out as the browser's auto layout does; a full one keeps
    // the time and origin on one line and lets the summary wrap.
    let cell = |el: El, col: usize| -> El {
        let el = el.min_w(0.0);
        match (empty, col) {
            (true, 0) => el.grow(326.0),
            (true, 1) => el.grow(342.0),
            (true, _) => el.grow(408.0),
            (false, 0) => el.w(140.0),
            (false, 1) => el.grow(1.0),
            (false, _) => el.w(300.0),
        }
    };
    let line = || {
        row()
            .w_full()
            .gap(20.0)
            .px(10.0)
            .py(7.0)
            .items_start()
            .border_sides([0.0, 0.0, 1.0, 0.0], p.line)
    };
    let mut table = col().w_full().min_w(0.0).child(
        line()
            .child(cell(kit::th("Tijd", s.dark), 0))
            .child(cell(kit::th("Wat", s.dark), 1))
            .child(cell(kit::th("Waar", s.dark), 2)),
    );
    for entry in &s.activity {
        table = table.child(
            line()
                .child(cell(
                    text(kit::weekday_time(entry["occurredAt"].as_i64().unwrap_or(0), true))
                        .font(kit::ts(13.0, 400.0).lh(19.5))
                        .color(p.ink),
                    0,
                ))
                .child(cell(
                    text(entry["summary"].as_str().unwrap_or("").to_string())
                        .font(kit::ts(13.0, 400.0).lh(19.5))
                        .color(p.ink)
                        .wrap(),
                    1,
                ))
                .child(cell(
                    text(entry["origin"].as_str().unwrap_or("").to_string())
                        .font(kit::ts(13.0, 400.0).lh(19.5))
                        .color(p.t.ink3),
                    2,
                )),
        );
    }
    if empty {
        let loading = s.activity_revision == 0 && s.busy;
        table = table.child(
            line().border_sides([0.0, 0.0, 0.0, 0.0], p.line).child(
                text(if loading {
                    "Activiteit laden…"
                } else if s.activity_search.text.trim().is_empty() {
                    "Nog geen activiteit."
                } else {
                    "Geen activiteit gevonden."
                })
                .font(kit::ts(13.0, 400.0).lh(19.5))
                .color(p.ink),
            ),
        );
    }
    let mut panel = col()
        .w_full()
        .min_w(0.0)
        .child(kit::h2("Activiteit", s.dark).mb(8.0))
        .child(
            kit::copy(
                "Wie wat veranderde, van welk scherm en welk adres. Elke laptop toont dezelfde lijst. Gelopen rondes staan niet hier maar bij Analyse.",
                s.dark,
            )
            .mb(12.0),
        )
        .child(
            row()
                .w_full()
                .gap(8.0)
                .center_y()
                .mb(12.0)
                .child(
                    kit::input(s, &s.activity_search, "activity-search", "Activiteit doorzoeken", "Zoek op loper, label of adres")
                        .grow(1.0)
                        .on_edit(|s: &mut State| &mut s.activity_search),
                )
                .child(kit::toggle_row(s, "activity-queue", "Wachtrij-bewegingen tonen", s.activity_queue, false, |s| {
                    s.activity_queue = !s.activity_queue
                })),
        )
        .child(table);
    if s.activity_more {
        panel = panel.child(
            kit::btn(
                s,
                "activity-older",
                if s.busy { "Laden…" } else { "Oudere activiteit laden" },
                kit::Kind::Ghost,
                false,
                None,
                s.busy,
                |s| {
                    if let Some(last) = s.activity.last() {
                        s.send(
                            "activity.older",
                            json!({"limit":PAGE_SIZE,"before":{"occurredAt":last["occurredAt"],"id":last["id"]},"search":s.activity_search.text.trim(),"queueMoves":s.activity_queue}),
                        );
                    }
                },
            )
            .self_start()
            .mt(12.0),
        );
    }
    panel
}
