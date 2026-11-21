//! Beheer › Systeem & herstel › Groep maken: one guided screen to link the laptops and test the
//! group. Every laptop is a card with its live state (gevonden, gekoppeld, bijgewerkt), and one
//! button links all found laptops. Every laptop can do everything; there is nothing to configure.
use super::admin_kit::{self as kit, Kind, Tone};
use super::admin_system::{
    busy_state, cluster, confirm_cluster, describe_group, disclosure, laptop_label,
    manual_join_form, section, short_url, spaced,
};
use super::*;
use super::admin_base::st;

/// The cards a full group shows; empty places invite the next laptop.
const CARDS: usize = 3;
const CARD_W: f32 = 268.0;

#[derive(Default)]
pub(super) struct Setup {
    /// Linking every found laptop, one after the other.
    linking_all: bool,
    /// Addresses tried in this round of linking, so a failure moves on to the next laptop.
    tried: Vec<String>,
    linked: usize,
    missed: Vec<String>,
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
            if setup.linked == 0 && !setup.missed.is_empty() {
                s.error = format!(
                    "Koppelen lukte nog niet met {}. Controleer of Apolloon daar open staat en aan dezelfde switch hangt, en probeer opnieuw.",
                    setup.missed.join(", ")
                );
            }
            s.notice = match (setup.linked, setup.missed.as_slice()) {
                (0, _) => String::new(),
                (n, []) => format!(
                    "{} gekoppeld. Test nu de groep.",
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

fn member_card(s: &State, c: &Value, m: &Value, busy: bool) -> El {
    let p = kit::pal(s.dark);
    let (state, color) = member_state(s, c, m);
    let title = card_title(s, &laptop_label(m), (m["self"] == true).then_some("deze laptop"));
    let mut el = card(s, format!("setup-laptop-{}", st(m, "hostId")))
        .label(format!("{} {state}", laptop_label(m)))
        .child(title)
        .child(text(short_url(st(m, "url")).to_string()).font(kit::ts(12.5, 400.0)).color(p.t.ink3))
        .child(chip(s, state, color));
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
                .child(step(s, 2, "Groep testen", tested, linked && !tested)),
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
