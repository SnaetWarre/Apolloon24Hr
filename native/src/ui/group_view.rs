//! The linked laptops at a glance: a short message on every operator screen when a laptop joins
//! the group, drops out or comes back, the laptops side by side in Beheer › Systeem & herstel,
//! and the group test that proves a change reaches each of them.
use super::admin_kit::{self as kit, Kind, Tone};
use super::*;
use rune::Transition;

/// How long a group message stays up.
const SHOWN_MS: i64 = 6_000;
/// A laptop silent this long gets a message, so a short hiccup stays quiet.
const LOST_AFTER_MS: i64 = 4_000;

#[derive(Clone)]
pub(super) struct Toast {
    pub title: String,
    pub detail: String,
    pub tone: Tone,
    pub at: i64,
}

#[derive(Default)]
pub(super) struct Watch {
    /// Host ids of the group at the last look; None before the first one.
    members: Option<Vec<String>>,
    /// Since when each laptop is unreachable, and whether that was announced.
    lost: std::collections::HashMap<String, (i64, bool)>,
    pub toast: Option<Toast>,
    /// The group test is running.
    pub testing: bool,
    /// The last group test's answer.
    pub test: Value,
}

fn name_of(m: &Value) -> String {
    super::admin_system::laptop_label(m)
}
fn names(list: &[String]) -> String {
    match list {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} en {last}", rest.join(", ")),
    }
}

/// Compares the group with the last look. True when a message appeared or went away, so the
/// caller animates that change.
pub(super) fn observe(s: &mut State) -> bool {
    let now = s.clock;
    let mut changed = false;
    if s.group
        .toast
        .as_ref()
        .is_some_and(|t| now - t.at >= SHOWN_MS)
    {
        s.group.toast = None;
        changed = true;
    }
    let c = &s.snapshot["cluster"];
    if c["enabled"] != true {
        s.group.members = None;
        s.group.lost.clear();
        return changed;
    }
    let list = c["members"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let ids: Vec<String> = list
        .iter()
        .filter_map(|m| m["hostId"].as_str().map(str::to_owned))
        .collect();
    // Nothing joined and nobody is or was missing: the common case on every poll.
    if s.group.members.as_ref() == Some(&ids)
        && s.group.lost.is_empty()
        && list.iter().all(|m| m["reachable"] == true)
    {
        return changed;
    }
    let members = list.to_vec();
    let Some(before) = s.group.members.replace(ids.clone()) else {
        // The first look only sets what later looks compare with.
        return changed;
    };
    let mut toast = None;
    let joined: Vec<String> = members
        .iter()
        .filter(|m| m["self"] != true && !before.iter().any(|id| m["hostId"] == id.as_str()))
        .map(name_of)
        .collect();
    if !joined.is_empty() && ids.len() > 1 {
        let together = ids.len();
        toast = Some(Toast {
            title: if before.len() <= 1 {
                format!("Gekoppeld met {}", names(&joined))
            } else {
                format!("{} doet mee", names(&joined))
            },
            detail: format!("{together} laptops delen nu dezelfde gegevens."),
            tone: Tone::Hint,
            at: now,
        });
    }
    for m in &members {
        let Some(id) = m["hostId"].as_str() else {
            continue;
        };
        if m["reachable"] == true {
            if let Some((_, announced)) = s.group.lost.remove(id)
                && announced
                && toast.is_none()
            {
                toast = Some(Toast {
                    title: format!("{} is terug", name_of(m)),
                    detail: "Gemiste wijzigingen worden vanzelf bijgewerkt.".into(),
                    tone: Tone::Hint,
                    at: now,
                });
            }
        } else {
            let entry = s.group.lost.entry(id.to_owned()).or_insert((now, false));
            if !entry.1 && now - entry.0 >= LOST_AFTER_MS && c["writable"] == true {
                entry.1 = true;
                toast.get_or_insert_with(|| Toast {
                    title: format!("{} is niet bereikbaar", name_of(m)),
                    detail: "De andere laptops werken verder. Controleer stroom en netwerk.".into(),
                    tone: Tone::Warn,
                    at: now,
                });
            }
        }
    }
    s.group.lost.retain(|id, _| ids.contains(id));
    if let Some(toast) = toast {
        s.group.toast = Some(toast);
        changed = true;
    }
    changed
}

/// The message over every operator screen, bottom right.
pub(super) fn toast(s: &State) -> Option<El> {
    let t = s.group.toast.as_ref()?;
    let p = kit::pal(s.dark);
    let dot = match t.tone {
        Tone::Hint => p.t.go,
        _ => p.t.warn,
    };
    // Above the admin message when both show.
    let bottom = match &s.admin.toast {
        Some(t) if s.page == 8 && t.detail.is_empty() => 100.0,
        Some(_) if s.page == 8 => 150.0,
        _ => 20.0,
    };
    Some(
        row()
            .key("group-toast")
            .role("status")
            .label(format!("{} {}", t.title, t.detail))
            .pin(None, None, Some(20.0), Some(bottom))
            .w(360.0)
            .gap(10.0)
            .py(12.0)
            .pl(14.0)
            .pr(10.0)
            .items_start()
            .radius(8.0)
            .fill(p.surface)
            .border(1.0, p.line)
            .shadow(12.0, 32.0, super::admin_base::overlay_shadow(s))
            .transition(Transition::offset(0.0, 8.0).combined(Transition::opacity()))
            .child(rune::el().size(7.0, 7.0).radius(3.5).mt(6.0).fill(dot))
            .child(
                col()
                    .grow(1.0)
                    .min_w(0.0)
                    .gap(1.0)
                    .child(
                        text(t.title.clone())
                            .font(kit::ts(13.5, 600.0))
                            .color(p.ink)
                            .wrap(),
                    )
                    .child(
                        text(t.detail.clone())
                            .font(kit::ts(13.0, 400.0).lh(18.0))
                            .color(p.t.ink3)
                            .wrap(),
                    ),
            )
            .child(
                row()
                    .key("group-toast-close")
                    .role("button")
                    .label("Melding sluiten")
                    .focusable(true)
                    .press_on_return()
                    .size(22.0, 22.0)
                    .center()
                    .radius(5.0)
                    .hover(p.t.surface3)
                    .on_press(|s: &mut State| s.group.toast = None)
                    .child(text("×").font(kit::ts(15.0, 400.0)).color(p.t.ink3)),
            ),
    )
}

// ---------- Beheer › Systeem & herstel ----------

fn state_line(c: &Value, m: &Value) -> (&'static str, bool) {
    if m["reachable"] != true {
        ("Niet bereikbaar", false)
    } else if m["self"] == true && c["writable"] != true {
        ("Wacht op de andere laptops", false)
    } else if m["leader"] == true {
        ("Ordent de wijzigingen", true)
    } else if m["caughtUp"] == true {
        ("Bijgewerkt", true)
    } else {
        ("Haalt wijzigingen op", true)
    }
}

fn ms(v: &Value) -> String {
    match v.as_u64() {
        Some(ms) if ms >= 1000 => format!("{:.1} s", ms as f64 / 1000.0),
        Some(ms) => format!("{ms} ms"),
        None => "—".into(),
    }
}

const COLS: [f32; 3] = [0.0, 170.0, 220.0];
const TEST_COL: f32 = 170.0;

fn cell(value: impl Into<String>, color: rune::Color, weight: f32) -> El {
    text(value.into())
        .font(kit::ts(13.5, weight))
        .color(color)
        .truncate()
        .min_w(0.0)
}

/// The laptops of the group as a table, with what the last group test measured on each.
pub(super) fn laptops(s: &State, remove: impl Fn(&State, &Value) -> Option<El>) -> El {
    let c = &s.snapshot["cluster"];
    let p = kit::pal(s.dark);
    let members = c["members"].as_array().cloned().unwrap_or_default();
    let test = s.group.test["laptops"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let tested = s.group.test.is_object() || s.group.testing;
    let line = |r: El| {
        r.w_full()
            .min_h(40.0)
            .px(12.0)
            .gap(16.0)
            .center_y()
            .border_sides([1.0, 0.0, 0.0, 0.0], p.line)
    };
    let mut head = row()
        .w_full()
        .h(32.0)
        .px(12.0)
        .gap(16.0)
        .center_y()
        .fill(p.t.surface2)
        .child(kit::th("Laptop", s.dark).grow(1.0).min_w(0.0))
        .child(kit::th("Adres", s.dark).w(COLS[1]))
        .child(kit::th("Status", s.dark).w(COLS[2]));
    if tested {
        head = head.child(kit::th("Test: erbij / weg", s.dark).w(TEST_COL));
    }
    let mut table = col()
        .key("cluster-laptops")
        .w_full()
        .mb(12.0)
        .radius(6.0)
        .border(1.0, p.line)
        .clip_rounded(6.0)
        .child(head);
    for m in &members {
        let host = m["hostId"].as_str().unwrap_or("");
        let (state, good) = state_line(c, m);
        let mut name =
            row()
                .grow(1.0)
                .min_w(0.0)
                .gap(8.0)
                .center_y()
                .child(cell(name_of(m), p.ink, 500.0));
        if m["self"] == true {
            name = name.child(
                text("deze laptop")
                    .font(kit::ts(12.5, 400.0))
                    .color(p.t.ink3),
            );
        }
        let status = row()
            .w(COLS[2])
            .gap(8.0)
            .center_y()
            .child(
                rune::el()
                    .size(7.0, 7.0)
                    .radius(3.5)
                    .fill(if good { p.t.go } else { p.t.stop })
                    .motion(rune::tok::motion::SNAPPY),
            )
            .child(cell(state, if good { p.t.ink2 } else { p.stop_ink }, 400.0));
        // The remove button sits with the name, so the other cells stay under their headings.
        if let Some(button) = remove(s, m) {
            name = name.child(button);
        }
        let mut r = line(row().key(format!("cluster-laptop-{host}")))
            .child(name)
            .child(
                cell(
                    super::admin_system::short_url(m["url"].as_str().unwrap_or("")),
                    p.t.ink3,
                    400.0,
                )
                .w(COLS[1]),
            )
            .child(status);
        if tested {
            let seen = test.iter().find(|l| l["hostId"] == host);
            let at = s.group.test["at"].as_i64().unwrap_or(0);
            // A pass from before the laptop dropped out says nothing about it now.
            let stale = seen.is_some_and(|l| (l["ok"] == true) != (m["reachable"] == true));
            let (value, color) = match seen {
                _ if s.group.testing => ("…".to_string(), p.t.ink3),
                Some(l) if !stale && l["addedMs"].is_null() => {
                    ("Niet bereikt".to_string(), p.stop_ink)
                }
                Some(l) if !stale => (
                    format!("{} / {}", ms(&l["addedMs"]), ms(&l["removedMs"])),
                    p.ink,
                ),
                _ => ("—".to_string(), p.t.ink3),
            };
            r = r.child(
                cell(value, color, 400.0)
                    .key(format!("cluster-test-{at}-{host}"))
                    .w(TEST_COL)
                    .transition(Transition::opacity()),
            );
        }
        table = table.child(r);
    }
    table
}

/// The button that starts the group test, and what the last test found.
pub(super) fn test_section(s: &State, busy: bool) -> El {
    let p = kit::pal(s.dark);
    let running = s.group.testing;
    let t = &s.group.test;
    // A test keeps this laptop busy for a moment; on the Timing laptop during the race that
    // would swallow a press of the space bar.
    let race = &s.snapshot["race"];
    let held = race["raceStartedAt"].is_number()
        && race["raceFinishedAt"].is_null()
        && s.snapshot["cluster"]["timing"]["self"] == true;
    let summary = if held && !running {
        Some((
            "Tijdens de race test je vanaf een andere laptop dan de Timing-laptop.".to_string(),
            p.t.ink3,
        ))
    } else if running {
        Some((
            "Wijziging wordt naar alle laptops gestuurd…".to_string(),
            p.t.ink3,
        ))
    } else if t.is_object() {
        let laptops = t["laptops"].as_array().cloned().unwrap_or_default();
        let slowest = |field: &str| {
            laptops
                .iter()
                .filter_map(|l| l[field].as_u64())
                .max()
                .map(|v| ms(&json!(v)))
                .unwrap_or_else(|| "—".into())
        };
        Some(if t["ok"] == true {
            (
                format!(
                    "{} van {} laptops bevestigd · traagste {} erbij, {} weg{}",
                    t["reached"],
                    t["total"],
                    slowest("addedMs"),
                    slowest("removedMs"),
                    if t["inStep"] == true {
                        " · logboek gelijk"
                    } else {
                        ""
                    }
                ),
                p.t.ink2,
            )
        } else {
            let missing: Vec<String> = laptops
                .iter()
                .filter(|l| l["ok"] != true)
                .map(name_of)
                .collect();
            (
                format!(
                    "{} van {} laptops bevestigd · {} antwoordde niet",
                    t["reached"],
                    t["total"],
                    names(&missing)
                ),
                p.stop_ink,
            )
        })
    } else {
        Some(("Stuurt een testwijziging naar alle laptops en verwijdert ze weer. Lopers en rondes blijven ongewijzigd.".to_string(), p.t.ink3))
    };
    let mut r = row().w_full().gap(12.0).center_y().mb(12.0).child(
        kit::btn_el(
            s,
            "cluster-test",
            if running { "Testen..." } else { "Groep testen" },
            Kind::Plain,
            true,
            None,
            busy || running || held,
        )
        .on_press_tx(|s: &mut State, tx: &mut Tx| {
            let race = &s.snapshot["race"];
            let held = race["raceStartedAt"].is_number()
                && race["raceFinishedAt"].is_null()
                && s.snapshot["cluster"]["timing"]["self"] == true;
            if s.busy || s.group.testing || held {
                return;
            }
            tx.animated();
            s.group.testing = true;
            s.send("cluster.testGroup", json!({}));
            // Not sent (disconnected): nothing will answer, so the button must not stay busy.
            s.group.testing = s.busy;
        }),
    );
    if let Some((line, color)) = summary {
        r = r.child(
            text(line)
                .key(format!("cluster-test-result-{}-{running}", t["at"]))
                .role("status")
                .font(kit::ts(13.0, 400.0))
                .color(color)
                .wrap()
                .grow(1.0)
                .min_w(0.0)
                .transition(Transition::opacity()),
        );
    }
    r
}
