//! Beheer › Systeem & herstel › Groep maken: one guided screen to link the laptops, give each one
//! a role and test the group. Every laptop is a card with its live state (gevonden, gekoppeld,
//! bijgewerkt), one button links all found laptops, and the role (Timing, Wachtrij, Opwarming or
//! a name of your own) replicates to the group and shows in the sidebar of that laptop.
use super::admin_kit::{self as kit, Kind, Tone};
use super::admin_system::{
    busy_state, cluster, confirm_cluster, describe_group, disclosure, laptop_label,
    manual_join_form, section, short_url, spaced,
};
use super::*;
use super::admin_base::st;
use std::collections::HashMap;

/// The roles the cards offer with one click.
pub(super) const ROLES: [&str; 3] = ["Timing", "Wachtrij", "Opwarming"];
/// The cards a full group shows; empty places invite the next laptop.
const CARDS: usize = 3;
const CARD_W: f32 = 268.0;

#[derive(Default)]
pub(super) struct Setup {
    /// A role being typed, by host id; dropped once saved so the card shows the group's role.
    roles: HashMap<String, TextEdit>,
    /// Linking every found laptop, one after the other.
    linking_all: bool,
    /// Addresses tried in this round of linking, so a failure moves on to the next laptop.
    tried: Vec<String>,
    linked: usize,
    missed: Vec<String>,
}

/// The role of a laptop in the group, if it has one.
pub(super) fn role(m: &Value) -> Option<&str> {
    m["role"].as_str().filter(|r| !r.is_empty())
}
/// The role of this laptop, for the sidebar.
pub(super) fn own_role(s: &State) -> Option<String> {
    let c = &s.snapshot["cluster"];
    if c["enabled"] != true {
        return None;
    }
    c["members"]
        .as_array()?
        .iter()
        .find(|m| m["self"] == true)
        .and_then(role)
        .map(str::to_owned)
}

/// Found laptops this laptop can link with from here.
fn linkable(c: &Value) -> Vec<Value> {
    c["nearby"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|f| f["compatible"] != false && st(f, "link") != "there")
        .cloned()
        .collect()
}

pub(super) fn start_link_all(s: &mut State) {
    let setup = &mut s.system.setup;
    setup.linking_all = true;
    setup.tried.clear();
    setup.missed.clear();
    setup.linked = 0;
    link_next(s);
}
fn link_next(s: &mut State) {
    let next = linkable(cluster(s))
        .into_iter()
        .find(|f| !s.system.setup.tried.iter().any(|u| u == st(f, "url")));
    match next {
        Some(found) => {
            let url = st(&found, "url").to_string();
            s.system.setup.tried.push(url.clone());
            s.send("cluster.joinGroup", json!({"url": url, "name": found["name"]}));
            if !s.busy {
                s.system.setup.linking_all = false;
            }
        }
        None => {
            let setup = &mut s.system.setup;
            setup.linking_all = false;
            s.notice = match (setup.linked, setup.missed.as_slice()) {
                (0, _) => String::new(),
                (n, []) => format!(
                    "{} gekoppeld. Geef elke laptop nu een rol en test de groep.",
                    kit::count_label(n as i64, "laptop", "laptops")
                ),
                (n, missed) => format!(
                    "{} gekoppeld. Nog niet gelukt: {}. Probeer die opnieuw met Koppelen op de kaart.",
                    kit::count_label(n as i64, "laptop", "laptops"),
                    missed.join(", ")
                ),
            };
        }
    }
}
/// A `cluster.joinGroup` answered. True when linking all goes on with the next laptop.
pub(super) fn joined(s: &mut State, ok: bool) -> bool {
    if !s.system.setup.linking_all {
        return false;
    }
    if ok {
        s.system.setup.linked += 1;
    } else if let Some(url) = s.system.setup.tried.last().cloned() {
        s.system.setup.missed.push(short_url(&url).to_string());
        s.error.clear();
    }
    link_next(s);
    true
}
pub(super) fn role_saved(s: &mut State, result: &Value) {
    if let Some(host) = result["hostId"].as_str() {
        s.system.setup.roles.remove(host);
    }
    let name = st(result, "name");
    s.notice = match result["role"].as_str() {
        Some(role) => format!("{name} is nu {role}."),
        None => format!("Rol van {name} gewist."),
    };
}

/// The confirmation before linking every found laptop.
pub(super) fn link_all_dialog(s: &State) -> (String, Vec<String>, &'static str) {
    let found = linkable(cluster(s));
    let names: Vec<String> = found.iter().map(laptop_label).collect();
    (
        if found.len() == 1 { "Deze laptop koppelen?" } else { "Alle gevonden laptops koppelen?" }.into(),
        vec![
            format!("Apolloon koppelt na elkaar: **{}**.", names.join(", ")),
            "Is de race nog nergens gestart, dan komen de lopers en labels van alle laptops samen. Anders houdt de laptop waar de race loopt zijn gegevens. Een laptop die gegevens overneemt, bewaart wat er stond eerst als backup.".into(),
        ],
        "Alles koppelen",
    )
}

fn step(s: &State, n: usize, title: &str, done: bool, current: bool) -> El {
    let p = kit::pal(s.dark);
    let (fill, ink) = if done {
        (p.t.go, p.surface)
    } else if current {
        (p.ink, p.surface)
    } else {
        (p.t.surface3, p.t.ink3)
    };
    row()
        .key(format!("setup-step-{n}"))
        .label(format!("Stap {n}: {title}{}", if done { ", klaar" } else { "" }))
        .checked(done)
        .gap(8.0)
        .center_y()
        .child(
            rune::el()
                .size(22.0, 22.0)
                .radius(11.0)
                .center()
                .fill(fill)
                .motion(rune::tok::motion::SNAPPY)
                .child(
                    text(if done { "✓".to_string() } else { n.to_string() })
                        .font(kit::ts(12.0, 600.0))
                        .color(ink),
                ),
        )
        .child(
            text(title.to_string())
                .font(kit::ts(13.5, if current { 600.0 } else { 500.0 }))
                .color(if done || current { p.ink } else { p.t.ink3 }),
        )
}

/// A coloured dot and a short state word on a card.
fn chip(s: &State, value: &str, color: rune::Color) -> El {
    let p = kit::pal(s.dark);
    row()
        .gap(6.0)
        .center_y()
        .child(
            rune::el()
                .size(7.0, 7.0)
                .radius(3.5)
                .fill(color)
                .motion(rune::tok::motion::SNAPPY),
        )
        .child(text(value.to_string()).font(kit::ts(12.5, 500.0)).color(p.t.ink2))
}

fn card(s: &State, key: String) -> El {
    let p = kit::pal(s.dark);
    col()
        .key(key)
        .w(CARD_W)
        .min_h(150.0)
        .gap(8.0)
        .padding(14.0)
        .radius(8.0)
        .fill(p.surface)
        .border(1.0, p.line)
}
fn card_title(s: &State, name: &str, tag: Option<&str>) -> El {
    let p = kit::pal(s.dark);
    let mut r = row().w_full().gap(8.0).center_y().child(
        text(name.to_string())
            .font(kit::ts(14.5, 600.0))
            .color(p.ink)
            .truncate()
            .min_w(0.0),
    );
    if let Some(tag) = tag {
        r = r.child(text(tag.to_string()).font(kit::ts(12.0, 400.0)).color(p.t.ink3));
    }
    r
}

fn member_state(s: &State, c: &Value, m: &Value) -> (&'static str, rune::Color) {
    let p = kit::pal(s.dark);
    if m["reachable"] != true {
        ("Gekoppeld · niet bereikbaar", p.t.stop)
    } else if m["self"] == true && c["writable"] != true {
        ("Gekoppeld · wacht op de groep", p.t.warn)
    } else if m["caughtUp"] == true || m["leader"] == true {
        ("Gekoppeld · bijgewerkt", p.t.go)
    } else {
        ("Gekoppeld · werkt bij", p.t.warn)
    }
}

fn role_editor(s: &State, m: &Value, busy: bool) -> El {
    let p = kit::pal(s.dark);
    let host = st(m, "hostId").to_string();
    let current = role(m).unwrap_or("").to_string();
    let typed = s.system.setup.roles.get(&host);
    let shown = typed.cloned().unwrap_or_else(|| TextEdit::new(current.as_str()));
    let mut presets = row().gap(6.0).flex_wrap();
    for preset in ROLES {
        let on = current == preset;
        let id = host.clone();
        presets = presets.child(
            kit::btn(
                s,
                format!("setup-role-{host}-{}", preset.to_lowercase()),
                preset,
                if on { Kind::Primary } else { Kind::Plain },
                true,
                None,
                busy,
                move |s| {
                    if !on {
                        s.send("cluster.setRole", json!({"hostId": id, "role": preset}))
                    }
                },
            )
            .checked(on),
        );
    }
    let edit_id = host.clone();
    let start = current.clone();
    let save_id = host.clone();
    let submit_id = host.clone();
    let changed = typed.is_some_and(|t| t.text.trim() != current);
    let save = move |s: &mut State, id: &str| {
        let Some(edit) = s.system.setup.roles.get(id) else { return };
        let role = edit.text.trim().to_string();
        s.send("cluster.setRole", json!({"hostId": id, "role": role}));
    };
    let save_btn = save.clone();
    col()
        .w_full()
        .gap(6.0)
        .child(text("Rol").font(kit::ts(12.0, 500.0)).color(p.t.ink3))
        .child(presets)
        .child(
            row()
                .w_full()
                .gap(6.0)
                .center_y()
                .child(
                    kit::input(s, &shown, &format!("setup-role-{host}"), "Rol van deze laptop", "Eigen naam, bv. Reserve")
                        .grow(1.0)
                        .disabled(busy)
                        .on_edit(move |s: &mut State| {
                            s.system
                                .setup
                                .roles
                                .entry(edit_id.clone())
                                .or_insert_with(|| TextEdit::new(start.as_str()))
                        })
                        .on_submit(move |s: &mut State, _tx: &mut Tx| save(s, &submit_id)),
                )
                .child(kit::btn(
                    s,
                    format!("setup-role-save-{host}"),
                    "Opslaan",
                    Kind::Plain,
                    true,
                    None,
                    busy || !changed,
                    move |s| save_btn(s, &save_id),
                )),
        )
}

fn member_card(s: &State, c: &Value, m: &Value, busy: bool) -> El {
    let p = kit::pal(s.dark);
    let (state, color) = member_state(s, c, m);
    let mut title = card_title(s, &laptop_label(m), (m["self"] == true).then_some("deze laptop"));
    if let Some(r) = role(m) {
        title = title.child(rune::el().grow(1.0)).child(
            text(r.to_string())
                .key(format!("setup-role-tag-{}", st(m, "hostId")))
                .font(kit::ts(12.0, 600.0))
                .color(p.brand)
                .truncate()
                .min_w(0.0),
        );
    }
    let mut el = card(s, format!("setup-laptop-{}", st(m, "hostId")))
        .label(format!("{} {state}", laptop_label(m)))
        .child(title)
        .child(text(short_url(st(m, "url")).to_string()).font(kit::ts(12.5, 400.0)).color(p.t.ink3))
        .child(chip(s, state, color))
        .child(role_editor(s, m, busy));
    if m["removable"] == true {
        let host_id = m["hostId"].clone();
        let name = laptop_label(m);
        el = el.child(kit::btn(
            s,
            format!("cluster-remove-{}", st(m, "hostId")),
            "Uit de groep halen",
            Kind::Ghost,
            true,
            None,
            busy,
            move |s| confirm_cluster(s, "cluster.removeLaptop", json!({"hostId":host_id,"name":name})),
        ));
    }
    el
}

fn found_card(s: &State, found: &Value, busy: bool) -> El {
    let p = kit::pal(s.dark);
    let url = found["url"].clone();
    let (state, color, action) = if found["compatible"] == false {
        (
            "Gevonden · andere versie",
            p.t.warn,
            kit::value_text(format!("Installeer overal dezelfde versie ({}).", st(found, "appVersion")), s.dark),
        )
    } else if st(found, "link") == "there" {
        ("Gevonden", p.t.ink3, kit::value_text("Druk op Koppelen op die laptop.", s.dark))
    } else {
        (
            "Gevonden",
            p.t.ink3,
            kit::btn(
                s,
                format!("cluster-join-{}", st(found, "url")),
                if busy { "Bezig..." } else { "Koppelen" },
                Kind::Plain,
                true,
                None,
                busy,
                move |s| confirm_cluster(s, "cluster.joinGroup", json!({"url":url})),
            ),
        )
    };
    let laptops = found["laptops"].as_i64().unwrap_or(1);
    card(s, format!("setup-found-{}", st(found, "url")))
        .label(format!("{} {state}", laptop_label(found)))
        .child(card_title(s, &laptop_label(found), (laptops > 1).then_some("groep")))
        .child(text(short_url(st(found, "url")).to_string()).font(kit::ts(12.5, 400.0)).color(p.t.ink3))
        .child(chip(s, state, color))
        .child(kit::value_text(
            format!(
                "{} · {}",
                kit::count_label(laptops, "laptop", "laptops"),
                kit::count_label(found["runners"].as_i64().unwrap_or(0), "loper", "lopers")
            ),
            s.dark,
        ))
        .child(row().child(action))
}

fn empty_card(s: &State, i: usize) -> El {
    let p = kit::pal(s.dark);
    card(s, format!("setup-empty-{i}"))
        .fill(p.t.surface2)
        .border(1.0, p.t.line2)
        .child(card_title(s, "Nog een laptop", None))
        .child(chip(s, "Zoeken op het netwerk…", p.t.ink3))
        .child(
            kit::copy("Start Apolloon op de volgende laptop, aan dezelfde switch. Ze verschijnt hier vanzelf.", s.dark)
                .wrap(),
        )
}

/// What the last group test means, in one line.
fn test_verdict(s: &State) -> Option<El> {
    let t = &s.group.test;
    if !t.is_object() || s.group.testing {
        return None;
    }
    let (tone, line) = if t["ok"] == true {
        (Tone::Hint, format!("**De groep werkt.** Elke laptop ({}) kreeg de testwijziging en ruimde ze weer op. Lopers en rondes bleven ongewijzigd.", t["total"]))
    } else {
        (Tone::Warn, "**Nog niet elke laptop antwoordde.** Controleer de stroom en de netwerkkabel van de laptop die niet antwoordde, en test opnieuw.".to_string())
    };
    Some(spaced(kit::notice_text(s, tone, &line).key("setup-test-verdict").role("status")))
}

pub(super) fn panel(s: &State) -> El {
    let c = cluster(s);
    let members = c["members"].as_array().cloned().unwrap_or_default();
    let nearby = c["nearby"].as_array().cloned().unwrap_or_default();
    let busy = s.busy || busy_state(c) || s.system.setup.linking_all;
    let host_url = st(&s.snapshot["host"], "url").to_string();
    let linked = members.len() > 1;
    let roles_done = linked && members.iter().all(|m| role(m).is_some());
    let tested = s.group.test["ok"] == true;
    let mut copy_text = if linked {
        format!(
            "Gekoppelde laptops hebben elk alle gegevens, en op elke laptop kan je werken. Een wijziging is pas bewaard als minstens {} laptops ze hebben. Valt een laptop uit, dan werken de andere vanzelf verder.",
            c["majority"]
        )
    } else {
        "Koppel de laptops: dan heeft elke laptop alle gegevens, kan je op elke laptop werken, en werken de andere vanzelf verder als er één uitvalt.".to_string()
    };
    if c["autoLink"]["enabled"] == true && runners(s).is_empty() {
        copy_text.push_str(" Zolang hier geen lopers staan, koppelt deze laptop vanzelf met de laptops die ze op het netwerk vindt.");
    }
    let (tone, title, mut detail) = describe_group(c);
    if detail == "Koppel de andere laptops in Beheer" {
        detail = "Koppel hieronder de andere laptops".into();
    }
    let mut p = section("Groep maken", s.dark)
        .key("group-setup")
        .child(kit::copy(copy_text, s.dark).mb(12.0))
        .child(
            row()
                .key("setup-steps")
                .gaps(8.0, 24.0)
                .flex_wrap()
                .mb(14.0)
                .child(step(s, 1, "Laptops koppelen", linked, !linked))
                .child(step(s, 2, "Rollen geven", roles_done, linked && !roles_done))
                .child(step(s, 3, "Groep testen", tested, roles_done && !tested)),
        )
        .child(spaced(
            kit::notice_text(s, tone, &format!("**{title}** · {detail}")).role("status"),
        ));
    if let Some(waiting) = c["autoLink"]["waiting"].as_str() {
        p = p.child(spaced(kit::notice_text(s, Tone::Hint, waiting)));
    }
    // What needs the operator now comes before the cards.
    p = p.child(alerts(s, c, busy));

    let mut cards = row().key("setup-cards").w_full().gaps(12.0, 12.0).flex_wrap().mb(12.0);
    for m in &members {
        cards = cards.child(member_card(s, c, m, busy));
    }
    for found in &nearby {
        cards = cards.child(found_card(s, found, busy));
    }
    for i in members.len() + nearby.len()..CARDS {
        cards = cards.child(empty_card(s, i));
    }
    p = p.child(cards);

    let ready = linkable(c);
    if !ready.is_empty() || s.system.setup.linking_all {
        let label = if s.system.setup.linking_all {
            "Koppelen...".to_string()
        } else if ready.len() == 1 {
            "Gevonden laptop koppelen".to_string()
        } else {
            format!("Alle {} gevonden laptops koppelen", ready.len())
        };
        p = p.child(
            row().mb(12.0).child(kit::btn(
                s,
                "setup-link-all",
                &label,
                Kind::Primary,
                false,
                None,
                busy,
                |s| confirm_cluster(s, "cluster.linkAll", json!({})),
            )),
        );
    }
    if linked {
        if s.group.testing || s.group.test.is_object() {
            p = p.child(super::group_view::laptops(s, |_, _| None));
        }
        p = p.child(super::group_view::test_section(s, busy));
        if let Some(verdict) = test_verdict(s) {
            p = p.child(verdict);
        }
    }

    let mut details = col().w_full().gap(8.0).child(disclosure(
        s,
        "cluster-manual",
        "Laptop niet gevonden? Vul het adres in",
        s.system.manual_open,
        |s| s.system.manual_open = !s.system.manual_open,
    ));
    if s.system.manual_open {
        let name = c["hostName"]
            .as_str()
            .map(|n| format!(" heet **{n}** en"))
            .unwrap_or_default();
        details = details
            .child(
                kit::strong_text(
                    &format!("Het adres staat onderaan de zijbalk van die laptop. Deze laptop{name} heeft adres **{host_url}**."),
                    kit::pal(s.dark).t.ink2,
                    s.dark,
                )
                .wrap()
                .max_w(kit::COPY_MAX),
            )
            .child(manual_join_form(s, busy));
    }
    p.child(spaced(kit::notice(s, Tone::Hint, details)))
}

/// Taken out of the group, too few laptops, and the server's own messages.
fn alerts(s: &State, c: &Value, busy: bool) -> El {
    let mut out = col().w_full();
    let timing_elsewhere = (c["timing"].is_object() && c["timing"]["self"] != true).then(|| {
        c["timing"]["name"]
            .as_str()
            .unwrap_or("een andere laptop")
            .to_string()
    });
    if let Some(from) = c["removedFrom"].as_object() {
        let from = Value::Object(from.clone());
        out = out.child(spaced(kit::notice(
            s,
            Tone::Alert,
            row()
                .flex_wrap()
                .gap(8.0)
                .center_y()
                .child(kit::value_text(
                    "Deze laptop is uit de groep gehaald. Wat je hier doet, wordt niet bewaard. Werkt hij weer?",
                    s.dark,
                ))
                .child(kit::btn(
                    s,
                    "cluster-rejoin",
                    "Opnieuw koppelen",
                    Kind::Ghost,
                    false,
                    None,
                    s.busy,
                    move |s| confirm_cluster(s, "cluster.joinGroup", json!({"url":from["url"],"name":from["name"],"rejoin":true})),
                )),
        )));
    } else if st(c, "state") == "no-majority" {
        let (message, label) = match &timing_elsewhere {
            Some(name) => (
                format!(
                    "Er zijn te weinig laptops bereikbaar om iets te bewaren. Wacht tot het netwerk terug is, of klok verder op {name}: daar staat Timing open, en alleen die laptop kan alleen verder werken. Is {name} echt kapot?"
                ),
                "Timing overnemen en alleen verder werken",
            ),
            None => (
                format!(
                    "Er zijn te weinig laptops bereikbaar om iets te bewaren. Zet de andere laptops aan of controleer de kabel.{} Zijn ze echt kapot?",
                    if c["timing"]["self"] == true {
                        " Timing staat open op deze laptop: komt het netwerk niet snel terug, dan werkt ze vanzelf alleen verder."
                    } else {
                        ""
                    }
                ),
                "Alleen verder werken",
            ),
        };
        let take_over = timing_elsewhere.is_some();
        out = out.child(spaced(kit::notice(
            s,
            Tone::Alert,
            row()
                .flex_wrap()
                .gap(8.0)
                .center_y()
                .child(kit::value_text(message, s.dark))
                .child(kit::btn(
                    s,
                    "cluster-alone",
                    label,
                    Kind::Ghost,
                    false,
                    None,
                    busy,
                    move |s| confirm_cluster(s, "cluster.continueAlone", json!({"takeOverTiming":take_over})),
                )),
        )));
    }
    if let Some(error) = c["lastError"].as_str() {
        out = out.child(spaced(kit::notice_text(s, Tone::Alert, error)));
    }
    if let Some(notice) = c["notice"].as_str() {
        out = out.child(spaced(kit::notice_text(s, Tone::Hint, notice).role("status")));
    }
    out
}
