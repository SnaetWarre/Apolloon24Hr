//! Beheer › Systeem & herstel: linked laptops, the fixed network address, recovery backups,
//! restoring one, clearing the race after a test run, the database counts and this installation.
//! Port of src/components/admin/{SystemSection,RestorePanel,ClearRacePanel,AboutPanel}.tsx and
//! src/components/NetworkSetupPanel.tsx.
//!
//! Linking laptops (`cluster.*`) runs on the Rust server when `CLUSTER_ENABLED=true` (src/cluster).
//! Static address changes and installation controls use the desktop integrations. Those controls
//! require a request from the same laptop.
use super::admin_kit::{self as kit, Kind, Tone};
use super::*;
use rune::{Span, text::Link};

const SHOWN_AT_FIRST: usize = 8;
const UNDO_PHRASE: &str = "VOORBIJ";
const SCRIPTS: [(&str, &str); 5] = [
    (
        "Windows vastzetten-script",
        "/event-network/Set-ApolloonStaticIp.ps1",
    ),
    (
        "Linux/macOS vastzetten-script",
        "/event-network/set-apolloon-static-ip.sh",
    ),
    (
        "controle-script (Windows)",
        "/event-network/Test-ApolloonNetwork.ps1",
    ),
    (
        "terugzetten-script (Linux/macOS)",
        "/event-network/revert-apolloon-dhcp.sh",
    ),
    (
        "terugzetten-script (Windows)",
        "/event-network/Revert-ApolloonDhcp.ps1",
    ),
];

#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub(super) enum NetPhase {
    #[default]
    Idle,
    ConfirmMake,
    WaitingMake,
    ConfirmRevert,
    WaitingRevert,
}

pub(super) struct Panel {
    ip: TextEdit,
    gateway: TextEdit,
    undo: TextEdit,
    event_over: bool,
    pub(super) phase: NetPhase,
    revert_open: bool,
    manual_open: bool,
    other_url: TextEdit,
    show_all: bool,
    copied_at: Option<i64>,
    folder_error: Option<String>,
    /// The waiting line under the network buttons.
    message: Option<String>,
    /// The last clear also removed the runners (`Alles wissen`).
    clearing_all: bool,
    /// `/api/net/profile` of this laptop; null until read, `"error"` when reading failed.
    net_profile: Value,
    /// Following a started network change until the address changed (`pollUntil`).
    net_wait: Option<NetWait>,
    /// When the profile, the update status and the diagnostics were last asked for.
    profile_asked: Option<i64>,
    update_asked: Option<i64>,
    /// `{status, lastInstall}` of the desktop app's update flow.
    update: Value,
    update_problem: Option<String>,
    desktop_diagnostics: Value,
}
pub(super) struct NetWait {
    elevation: Value,
    /// The address being pinned; None while reverting to automatic.
    wanted: Option<String>,
    ticks: u32,
    answers: u32,
}
const SAME_VERSION: &str = "Installeer dezelfde versie op alle laptops, en nooit tijdens de race: laptops met een andere versie koppelen niet met elkaar.";
impl Default for Panel {
    fn default() -> Self {
        Self {
            ip: TextEdit::new(""),
            gateway: TextEdit::new(""),
            undo: TextEdit::new(""),
            event_over: false,
            phase: NetPhase::Idle,
            revert_open: false,
            manual_open: false,
            other_url: TextEdit::new(""),
            show_all: false,
            copied_at: None,
            folder_error: None,
            message: None,
            clearing_all: false,
            net_profile: Value::Null,
            net_wait: None,
            profile_asked: None,
            update_asked: None,
            update: Value::Null,
            update_problem: None,
            desktop_diagnostics: Value::Null,
        }
    }
}

fn st<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn short_url(url: &str) -> &str {
    url.trim_start_matches("http://")
        .trim_start_matches("https://")
}
fn laptop_label(l: &Value) -> String {
    l["name"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| short_url(st(l, "url")).into())
}
fn laptop_with_address(name: &Value, url: &Value) -> String {
    let url = short_url(url.as_str().unwrap_or(""));
    match name.as_str() {
        Some(name) => format!("{name} ({url})"),
        None => url.into(),
    }
}
fn race_open(race: &Value) -> bool {
    !race["raceStartedAt"].is_null() && race["raceFinishedAt"].is_null()
}
fn backup_kind(record: &Value) -> &'static str {
    let name = st(record, "fileName");
    if record["scheduled"] == true {
        "Automatisch"
    } else if name.contains("-pre-restore-") {
        "Vóór terugzetten"
    } else if name.contains("-pre-clear-") {
        "Vóór race wissen"
    } else if name.contains("-pre-join-") {
        "Vóór koppelen"
    } else if name.contains("-pre-resync-") {
        "Vóór bijwerken"
    } else {
        "Handmatig"
    }
}
fn cluster(s: &State) -> &Value {
    &s.snapshot["cluster"]
}

// ---------- Loading and results ----------

/// The methods whose outcome this section words.
pub(super) fn owns(s: &State, method: &str) -> bool {
    matches!(
        method,
        "backups.create"
            | "backups.preview"
            | "backups.restore"
            | "race.clear"
            | "settings.updatePublicRecordMode"
            | "net.makeStatic"
            | "net.revertDhcp"
            | "net.profile"
            | "update.status"
            | "update.check"
            | "update.install"
            | "desktop.diagnostics"
            | "desktop.openUrl"
            | "cluster.joinGroup"
    ) || (s.page == 8 && (method == "events.burgieGepakt" || method.starts_with("cluster.")))
}

pub(super) fn succeeded(s: &mut State, method: &str, result: &Value) {
    match method {
        "backups.preview" => {
            s.preview = result.clone();
            s.confirm = Some(Command {
                screen: String::new(),
                method: "backups.restore".into(),
                input: json!({"fileName":result["fileName"]}),
            });
        }
        "backups.create" => {
            s.notice = format!(
                "Backup gecontroleerd en opgeslagen om {}.",
                kit::clock(result["createdAt"].as_i64().unwrap_or(s.clock))
            )
        }
        "backups.restore" => {
            s.notice = format!(
                "Teruggezet naar {}: {} lopers, {} rondes. Ongedaan maken kan met de backup \"Vóór terugzetten\" op {}.",
                kit::weekday_time(s.preview["createdAt"].as_i64().unwrap_or(0), false),
                result["runners"],
                result["laps"],
                laptop_with_address(&result["safetyHostName"], &result["safetyHostUrl"])
            );
            s.last_press = None;
        }
        "race.clear" => {
            let undo = format!(
                "Ongedaan maken kan met de backup \"Vóór race wissen\" op {}.",
                laptop_with_address(&result["safetyHostName"], &result["safetyHostUrl"])
            );
            s.notice = if result["runners"].as_i64().unwrap_or(0) > 0 {
                format!(
                    "Alles gewist: {} lopers en {} rondes weg. {undo}",
                    result["runners"], result["laps"]
                )
            } else {
                format!("Race gewist: {} rondes weg. {undo}", result["laps"])
            };
            s.last_press = None;
        }
        "settings.updatePublicRecordMode" => {
            s.notice = format!(
                "Recordflits staat op {}.",
                public_settings::record_mode_label(st(result, "publicRecordMode"))
            );
        }
        "events.burgieGepakt" => {
            let runner = match (result["runnerName"].as_str(), st(result, "runnerNumber")) {
                (Some(name), "") => format!(" voor {name}"),
                (Some(name), n) => format!(" voor {n} {name}"),
                _ => String::new(),
            };
            s.notice = format!(
                "Burgie gepakt opgeslagen om {}{runner}.",
                kit::clock(result["occurredAt"].as_i64().unwrap_or(s.clock))
            );
        }
        "cluster.continueAlone" => {
            s.notice = "Deze laptop werkt alleen verder. De andere laptops sluiten vanzelf weer aan zodra het netwerk terug is.".into()
        }
        "cluster.removeLaptop" => {
            s.notice = "De laptop is uit de groep gehaald. Koppel een reservelaptop om weer een laptop te mogen verliezen.".into()
        }
        "cluster.joinGroup" => {
            s.system.other_url = TextEdit::new("");
            s.notice = match result["backupFile"].as_str() {
                Some(file) => format!("Opnieuw gekoppeld. De vorige gegevens staan in de backup {file}."),
                None => "Gekoppeld.".into(),
            };
        }
        "net.makeStatic" | "net.revertDhcp" => {
            s.system.phase = if method == "net.makeStatic" {
                NetPhase::WaitingMake
            } else {
                NetPhase::WaitingRevert
            };
            let hint = net_profile(s)["elevateHint"]
                .as_str()
                .unwrap_or("Het systeem vraagt nu om toestemming");
            s.system.message = Some(format!("{hint} — bevestig op deze laptop en wacht op de melding “Gelukt!”…"));
            let wanted = (method == "net.makeStatic").then(|| s.system.ip.text.trim().to_string());
            s.system.net_wait = Some(NetWait { elevation: result["elevationId"].clone(), wanted, ticks: 0, answers: 0 });
            s.system.profile_asked = Some(s.server_now());
        }
        "net.profile" => {
            s.system.net_profile = result.clone();
            if let Some(suggestion) = result["suggestion"].as_object() {
                if s.system.ip.text.is_empty() {
                    s.system.ip = TextEdit::new(suggestion["ip"].as_str().unwrap_or(""));
                }
                if s.system.gateway.text.is_empty() {
                    s.system.gateway = TextEdit::new(suggestion["gateway"].as_str().unwrap_or(""));
                }
            }
            follow_net_change(s);
        }
        "update.status" => s.system.update = result.clone(),
        "update.check" => s.system.update_asked = None,
        "update.install" => {
            s.system.update_problem = result["problem"].as_str().map(str::to_owned);
            s.system.update_asked = None;
        }
        "desktop.diagnostics" => s.system.desktop_diagnostics = result.clone(),
        "desktop.openUrl" => {}
        _ => s.notice = "Opgeslagen.".into(),
    }
}

/// A failed action of this section; the reason itself is in `s.error`.
pub(super) fn failed(s: &mut State, method: &str) {
    match method {
        "net.makeStatic" | "net.revertDhcp" => {
            s.system.phase = NetPhase::Idle;
            s.system.message = None;
            let reason = std::mem::take(&mut s.error);
            let text = if method == "net.makeStatic" {
                "Vastzetten mislukt"
            } else {
                "Terugzetten mislukt"
            };
            net_failed(s, text, reason);
        }
        "net.profile" => {
            s.error.clear();
            s.system.net_profile = json!("error");
        }
        "update.status" | "update.check" | "desktop.diagnostics" => s.error.clear(),
        "update.install" => s.system.update_problem = Some(std::mem::take(&mut s.error)),
        "desktop.openUrl" => {}
        "backups.preview" => s.error = format!("De backup kon niet gelezen worden: {}", s.error),
        "backups.create" => s.error = format!("Backup maken mislukt: {}", s.error),
        "backups.restore" => s.error = format!("Terugzetten mislukt: {}", s.error),
        "race.clear" if s.system.clearing_all => {
            s.error = format!("Alles wissen mislukt: {}", s.error)
        }
        "race.clear" => s.error = format!("Race wissen mislukt: {}", s.error),
        "settings.updatePublicRecordMode" => {
            s.error = format!("Recordflits aanpassen mislukt: {}", s.error)
        }
        "events.burgieGepakt" => s.error = format!("Burgie gepakt opslaan mislukt: {}", s.error),
        _ => {}
    }
}

// ---------- Laptop tools: network profile, updates, diagnostics ----------

fn net_profile(s: &State) -> &Value {
    if s.system.net_profile.is_object() {
        &s.system.net_profile
    } else {
        &s.recovery["system"]["profile"]
    }
}
fn net_failed(s: &mut State, text: &str, reason: String) {
    let detail = if reason.contains("alleen op de laptop zelf") {
        format!(
            "{reason} Open Beheer op die laptop zelf (dus niet via het netwerk) en probeer het daar."
        )
    } else {
        reason
    };
    s.admin.toast = Some(admin_base::Toast {
        text: text.into(),
        detail,
        error: true,
        at: s.server_now(),
    });
}
/// `pollUntil`: every profile read while a change runs decides whether it worked, failed or timed out.
fn follow_net_change(s: &mut State) {
    let Some(mut wait) = s.system.net_wait.take() else {
        return;
    };
    let next = s.system.net_profile.clone();
    let primary = &next["primary"];
    wait.ticks += 1;
    if primary.is_object() && !primary["dhcp"].is_null() {
        wait.answers += 1;
    }
    let make = wait.wanted.is_some();
    let text = if make {
        "Vastzetten mislukt"
    } else {
        "Terugzetten mislukt"
    };
    let done = match &wait.wanted {
        Some(ip) => primary["address"].as_str() == Some(ip.as_str()) && primary["dhcp"] == false,
        None => primary["dhcp"] == true,
    };
    let elevation = &next["lastElevation"];
    if done {
        s.system.phase = NetPhase::Idle;
        s.system.message = None;
        let (text, detail) = match &wait.wanted {
            Some(ip) => (
                format!("Dit adres is nu vast: {ip}."),
                format!("Andere apparaten blijven bereikbaar op http://{ip}:5173."),
            ),
            None => {
                s.system.event_over = false;
                s.system.undo = TextEdit::new("");
                (
                    "Dit toestel haalt zijn adres weer automatisch op.".into(),
                    "Vergeet niet ook de kabel eruit te halen als je naar school-wifi gaat.".into(),
                )
            }
        };
        s.admin.toast = Some(admin_base::Toast {
            text,
            detail,
            error: false,
            at: s.server_now(),
        });
        return;
    }
    let reason = if !wait.elevation.is_null()
        && elevation["id"] == wait.elevation
        && elevation["state"] == "failed"
    {
        Some(
            elevation["message"]
                .as_str()
                .unwrap_or("De netwerkwijziging is mislukt. Er is niets veranderd.")
                .to_string(),
        )
    } else if wait.answers >= 45 {
        Some(if make {
            "Er is niets veranderd. Waarschijnlijk is de toestemming geweigerd of weggeklikt. Probeer het opnieuw."
        } else {
            "Er is niets veranderd. Waarschijnlijk is de toestemming geweigerd of weggeklikt."
        }.to_string())
    } else if wait.ticks >= 90 {
        Some("Dit toestel liet niet zien of het adres vast of automatisch is, dus het is niet zeker of het gelukt is. Herlaad deze pagina over een minuut om het na te kijken.".to_string())
    } else {
        None
    };
    match reason {
        Some(reason) => {
            s.system.phase = NetPhase::Idle;
            s.system.message = None;
            net_failed(s, text, reason);
        }
        None => s.system.net_wait = Some(wait),
    }
}
/// While Systeem & herstel is open: read the network profile (every 2 s during a change), and on
/// the desktop app the update status (every second while it changes) and the diagnostics once.
pub(super) fn refresh(s: &mut State) {
    // The UI tests drive this section without these background reads holding the one request slot.
    if cfg!(test) || s.busy || !s.connected || s.page != 8 || s.admin_section != 6 {
        return;
    }
    let now = s.server_now();
    let due = |asked: Option<i64>, every: i64| asked.is_none_or(|at| now - at >= every);
    if s.system.net_profile.is_null() && s.system.profile_asked.is_none()
        || s.system.net_wait.is_some() && due(s.system.profile_asked, 2000)
    {
        s.system.profile_asked = Some(now);
        s.send("net.profile", json!({}));
        return;
    }
    if cfg!(target_arch = "wasm32") {
        return;
    }
    if s.system.desktop_diagnostics.is_null() {
        s.system.desktop_diagnostics = json!({});
        s.send("desktop.diagnostics", json!({}));
        return;
    }
    let moving = matches!(
        st(&s.system.update["status"], "state"),
        "checking" | "downloading" | "installing"
    );
    if s.system.update.is_null() && s.system.update_asked.is_none()
        || moving && due(s.system.update_asked, 1000)
    {
        s.system.update_asked = Some(now);
        s.send("update.status", json!({}));
    }
}

// ---------- The section ----------

pub(super) fn panel(s: &State) -> El {
    let card = |el: El| kit::panel_paint(el, s.dark);
    let mut page = col().w_full().min_w(0.0).gap(16.0);
    if cluster(s)["enabled"] == true {
        page = page.child(card(cluster_panel(s)));
    }
    if let Some(nearby) = s.recovery["system"]["nearbyLaptops"]
        .as_array()
        .filter(|laptops| !laptops.is_empty())
    {
        let mut detected = section("Gevonden laptops", s.dark);
        for laptop in nearby {
            let name = laptop["name"]
                .as_str()
                .filter(|name| !name.is_empty())
                .unwrap_or("Laptop");
            let state = if laptop["raceRunning"] == true {
                "Race loopt"
            } else if laptop["raceStarted"] == true {
                "Race gestart"
            } else {
                "Race nog niet gestart"
            };
            detected = detected.child(kit::copy(
                format!("{name} · {} · {state}", st(laptop, "url")),
                s.dark,
            ));
        }
        page = page.child(card(detected));
    }
    page.child(card(network_panel(s)))
        .child(card(backup_panel(s)))
        .child(card(restore_panel(s)))
        .child(card(clear_panel(s)))
        .child(card(database_panel(s)))
        .child(card(about_panel(s)))
}

fn section(title: &str, dark: bool) -> El {
    kit::panel().child(kit::h2(title, dark).mb(8.0))
}
/// `.management-content .panel > .host-hint`: 8 above and below, merged with the copy's 12.
/// `margin-block: 8px`, collapsing with the 12px under a `.panel-copy` above it.
fn spaced(el: El) -> El {
    el.mb(8.0)
}

// ---------- Laptops koppelen ----------

fn member_state(c: &Value, m: &Value) -> &'static str {
    if m["reachable"] != true {
        "niet bereikbaar"
    } else if m["self"] == true && c["writable"] != true {
        "wacht op de andere laptops"
    } else if m["leader"] == true {
        "ordent de wijzigingen"
    } else if m["caughtUp"] == true {
        "heeft alles"
    } else {
        "haalt wijzigingen op"
    }
}
fn describe_group(c: &Value) -> (Tone, String, String) {
    let members = c["members"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let total = members.len();
    let unreachable = members.iter().filter(|m| m["reachable"] != true).count();
    if !c["removedFrom"].is_null() {
        return (
            Tone::Alert,
            "Uit de groep gehaald".into(),
            "Niets wordt bewaard; koppel opnieuw in Beheer".into(),
        );
    }
    match st(c, "state") {
        "solo" => (
            Tone::Warn,
            "Alleen deze laptop".into(),
            if c["split"]["rank"].as_i64().unwrap_or(0) > 0 {
                "De andere laptops sluiten vanzelf weer aan".into()
            } else {
                "Koppel de andere laptops in Beheer".into()
            },
        ),
        "electing" => (
            Tone::Warn,
            "Laptops nemen over".into(),
            "Even geduld, dit duurt enkele seconden".into(),
        ),
        "no-majority" => (
            Tone::Alert,
            "Te weinig laptops bereikbaar".into(),
            "Niets wordt bewaard; zet de andere laptops aan".into(),
        ),
        "degraded" if unreachable > 0 => (
            Tone::Warn,
            if unreachable == 1 {
                "Eén laptop onbereikbaar".into()
            } else {
                format!("{unreachable} laptops onbereikbaar")
            },
            format!(
                "Alles werkt nog; bewaard op {} laptops",
                total - unreachable
            ),
        ),
        "degraded" => (
            Tone::Warn,
            "Laptop werkt bij".into(),
            "De laatste wijzigingen worden gekopieerd".into(),
        ),
        _ if total == 2 => (
            Tone::Warn,
            "Twee laptops".into(),
            "Koppel een derde, zodat er één mag uitvallen".into(),
        ),
        _ => (
            Tone::Hint,
            "Alles veilig".into(),
            format!("Gegevens op {total} laptops"),
        ),
    }
}
/// The server says `"joining"` or `"resyncing"` while this laptop changes its own data (TS `Boolean(cluster.busy)`).
pub(super) fn busy_state(c: &Value) -> bool {
    c["busy"].as_str().is_some_and(|b| !b.is_empty()) || c["busy"] == true
}
fn confirm_cluster(s: &mut State, method: &str, input: Value) {
    if !s.busy {
        s.confirm = Some(Command {
            screen: String::new(),
            method: method.into(),
            input,
        });
    }
}

pub(super) fn nearby_row(s: &State, found: &Value, busy: bool) -> El {
    let mut line = format!(
        "**{}**  {} · {}",
        laptop_label(found),
        kit::count_label(found["laptops"].as_i64().unwrap_or(1), "laptop", "laptops"),
        kit::count_label(found["runners"].as_i64().unwrap_or(0), "loper", "lopers")
    );
    if found["name"].is_string() {
        line.push_str(&format!(" · {}", short_url(st(found, "url"))));
    }
    let url = found["url"].clone();
    let action = if found["compatible"] == false {
        kit::value_text(
            format!(
                "andere versie ({}): installeer overal dezelfde versie",
                st(found, "appVersion")
            ),
            s.dark,
        )
    } else if st(found, "link") != "there" {
        kit::btn(
            s,
            format!("cluster-join-{}", st(found, "url")),
            if busy { "Bezig..." } else { "Koppelen" },
            Kind::Primary,
            false,
            None,
            busy,
            move |s| confirm_cluster(s, "cluster.joinGroup", json!({"url":url})),
        )
    } else {
        kit::value_text("Druk op Koppelen op die laptop.", s.dark)
    };
    spaced(kit::notice(
        s,
        Tone::Hint,
        row()
            .w_full()
            .justify_between()
            .center_y()
            .child(kit::strong_text(&line, kit::pal(s.dark).t.ink2, s.dark))
            .child(action),
    ))
}

fn cluster_panel(s: &State) -> El {
    let c = cluster(s);
    let members = c["members"].as_array().cloned().unwrap_or_default();
    let nearby = c["nearby"].as_array().cloned().unwrap_or_default();
    let busy = s.busy || busy_state(c);
    let host_url = st(&s.snapshot["host"], "url").to_string();
    let runner_count = runners(s).len();
    let mut copy_text = if members.len() == 1 {
        "Koppel deze laptop met de andere: dan heeft elke laptop alle gegevens, kan je op elke laptop werken, en werken de andere vanzelf verder als er één uitvalt.".to_string()
    } else {
        format!(
            "Gekoppelde laptops hebben elk alle gegevens, en op elke laptop kan je werken. Een wijziging is pas bewaard als minstens {} laptops ze hebben. Valt een laptop uit, dan werken de andere vanzelf verder.",
            c["majority"]
        )
    };
    if c["autoLink"]["enabled"] == true && runner_count == 0 {
        copy_text.push_str(" Zolang hier geen lopers staan, koppelt deze laptop vanzelf met de laptops die ze op het netwerk vindt.");
    }
    let (tone, title, detail) = describe_group(c);
    let mut p = section("Laptops koppelen", s.dark)
        .child(kit::copy(copy_text, s.dark).mb(12.0))
        .child(spaced(
            kit::notice_text(s, tone, &format!("**{title}** · {detail}")).role("status"),
        ));
    if let Some(waiting) = c["autoLink"]["waiting"].as_str() {
        p = p.child(spaced(kit::notice_text(s, Tone::Hint, waiting)));
    }
    let timing_elsewhere = (c["timing"].is_object() && c["timing"]["self"] != true).then(|| {
        c["timing"]["name"]
            .as_str()
            .unwrap_or("een andere laptop")
            .to_string()
    });
    if members.len() > 1 {
        for m in &members {
            let name = laptop_label(m);
            let mut line = format!(
                "**{name}{}**",
                if m["self"] == true {
                    " (deze laptop)"
                } else {
                    ""
                }
            );
            if m["name"].is_string() {
                line.push_str(&format!("  {}", short_url(st(m, "url"))));
            }
            line.push_str(&format!("  {}", member_state(c, m)));
            let mut r = row()
                .w_full()
                .justify_between()
                .center_y()
                .child(kit::strong_text(&line, kit::pal(s.dark).t.ink2, s.dark));
            if m["removable"] == true {
                let host_id = m["hostId"].clone();
                let name = name.clone();
                r = r.child(kit::btn(
                    s,
                    format!("cluster-remove-{}", st(m, "hostId")),
                    "Uit de groep halen",
                    Kind::Ghost,
                    false,
                    None,
                    busy,
                    move |s| {
                        confirm_cluster(
                            s,
                            "cluster.removeLaptop",
                            json!({"hostId":host_id,"name":name}),
                        )
                    },
                ));
            }
            p = p.child(spaced(kit::notice(s, Tone::Hint, r)));
        }
    }
    if let Some(from) = c["removedFrom"].as_object() {
        let from = Value::Object(from.clone());
        p = p.child(spaced(kit::notice(
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
        p = p.child(spaced(kit::notice(
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
                    move |s| {
                        confirm_cluster(
                            s,
                            "cluster.continueAlone",
                            json!({"takeOverTiming":take_over}),
                        )
                    },
                )),
        )));
    }
    if let Some(error) = c["lastError"].as_str() {
        p = p.child(spaced(kit::notice_text(s, Tone::Alert, error)));
    }
    if let Some(notice) = c["notice"].as_str() {
        p = p.child(spaced(
            kit::notice_text(s, Tone::Hint, notice).role("status"),
        ));
    }
    if members.len() == 1 {
        p = p.child(
            kit::copy(
                "Laptops op dit netwerk waarmee deze laptop kan samenwerken:",
                s.dark,
            )
            .mb(12.0),
        );
        if nearby.is_empty() {
            p = p.child(spaced(kit::notice_text(
                s,
                Tone::Hint,
                "Nog geen andere laptops gevonden. Staat Apolloon aan op de andere laptops, en hangen ze aan hetzelfde netwerk?",
            )));
        }
        for found in &nearby {
            p = p.child(nearby_row(s, found, busy));
        }
        let mut details = col().w_full().gap(8.0).child(disclosure(
            s,
            "cluster-manual",
            "Laptop niet in de lijst? Vul het adres in",
            s.system.manual_open,
            |s| s.system.manual_open = !s.system.manual_open,
        ));
        if s.system.manual_open {
            let name = c["hostName"]
                .as_str()
                .map(|n| format!(" heet **{n}** en"))
                .unwrap_or_default();
            let ready = !s.system.other_url.text.trim().is_empty() && !busy;
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
                .child(
                    row()
                        .w_full()
                        .gap(8.0)
                        .center_y()
                        .child(
                            kit::input(
                                s,
                                &s.system.other_url,
                                "cluster-url",
                                "Adres van een andere laptop",
                                "http://192.168.1.20:5173",
                            )
                            .grow(1.0)
                            .on_edit(|s: &mut State| &mut s.system.other_url),
                        )
                        .child(kit::btn(
                            s,
                            "cluster-manual-join",
                            if busy { "Bezig..." } else { "Koppelen" },
                            Kind::Primary,
                            false,
                            None,
                            !ready,
                            |s| {
                                let url = s.system.other_url.text.trim().to_string();
                                confirm_cluster(s, "cluster.joinGroup", json!({"url":url}))
                            },
                        )),
                );
        }
        p = p.child(spaced(kit::notice(s, Tone::Hint, details)));
    } else {
        if !nearby.is_empty() {
            p = p.child(kit::copy("Andere laptops op dit netwerk:", s.dark).mb(12.0));
        }
        for found in &nearby {
            p = p.child(nearby_row(s, found, busy));
        }
        if c["removedFrom"].is_null() {
            p = p.child(kit::strong_text(
                &if c["autoLink"]["enabled"] == true {
                    format!("Nog een laptop toevoegen? Start Apolloon op die laptop aan hetzelfde netwerk: een lege laptop koppelt vanzelf, en zolang de race nog niet gestart is ook een laptop met lopers; zijn lopers komen erbij. Lukt dat niet, open dan op die laptop Beheer › Systeem & herstel en klik op Koppelen naast deze groep (adres **{host_url}**).")
                } else {
                    format!("Nog een laptop toevoegen? Open op die laptop Beheer › Systeem & herstel en klik op Koppelen naast deze groep (adres **{host_url}**).")
                },
                kit::pal(s.dark).t.ink2,
                s.dark,
            ).wrap().max_w(kit::COPY_MAX).mb(12.0));
        }
    }
    p
}

/// `details > summary.disclosure`: a chevron that turns when open.
fn disclosure(
    s: &State,
    key: &str,
    title: &str,
    open: bool,
    f: impl Fn(&mut State) + 'static,
) -> El {
    let p = kit::pal(s.dark);
    row()
        .key(key.to_string())
        .role("button")
        .label(title.to_string())
        .checked(open)
        .focusable(true)
        .gap(8.0)
        .center_y()
        .on_press(f)
        .child(kit::icon(
            s,
            if open { "chevronDown" } else { "chevron" },
            p.t.ink3,
            12.0,
        ))
        .child(kit::strong_text(title, p.t.ink2, s.dark))
}

// ---------- Vast netwerkadres ----------

fn network_panel(s: &State) -> El {
    let p = kit::pal(s.dark);
    let sys = &s.system;
    let mut out = section("Vast netwerkadres", s.dark);
    if sys.net_profile.is_null() && s.recovery["system"].is_null() {
        return out.child(kit::copy("Bezig met opzoeken…", s.dark).mb(12.0));
    }
    if sys.net_profile == "error" {
        out = out.child(spaced(kit::notice_text(
            s,
            Tone::Alert,
            "Netwerkprofiel mislukt.",
        )));
    }
    let profile = net_profile(s);
    let primary = &profile["primary"];
    let is_static = primary.is_object() && primary["dhcp"] == false;
    let busy = matches!(sys.phase, NetPhase::WaitingMake | NetPhase::WaitingRevert);
    out = out.child(
        kit::strong_text(
            "Deze stap doe je **één keer per laptop, op die laptop zelf**, met de netwerkkabel erin. Daarna verandert het adres nooit meer en blijven alle schermen werken.",
            p.t.ink2,
            s.dark,
        )
        .wrap()
        .max_w(kit::COPY_MAX)
        .mb(12.0),
    );
    if profile["apipa"] == true {
        out = out.child(spaced(kit::notice_text(
            s,
            Tone::Alert,
            "Deze laptop heeft nu een noodadres (169.254.x.x): er is geen netwerk gevonden. Controleer dat de kabel in de switch zit en dat de switch aan staat.",
        )));
    }
    if primary.is_object() && profile["apipa"] != true {
        let source = match primary["dhcp"].as_bool() {
            None => "adresbron onbekend",
            Some(true) => "automatisch adres (kan veranderen!)",
            Some(false) => "vast adres (blijft staan!)",
        };
        let mut line = format!(
            "**Nu:** {} (adapter: {}) · {source}",
            st(primary, "address"),
            st(primary, "name")
        );
        if let Some(url) = profile["eventUrl"].as_str() {
            line.push_str(&format!(" · Schermen verbinden met **{url}**"));
        }
        out = out.child(spaced(kit::notice_text(s, Tone::Hint, &line)));
    }
    if let Some(manager) = profile["manager"].as_str() {
        out = out.child(spaced(kit::notice_text(
            s,
            Tone::Hint,
            &format!("Beheerd door **{manager}**."),
        )));
    }
    let elevate = profile["elevateMethod"].is_string();
    if !elevate {
        out = out.child(spaced(kit::notice_text(
            s,
            Tone::Hint,
            &format!(
                "Automatisch vastzetten kan op dit toestel ({}) niet vanuit de app. Doe het handmatig, of download hieronder het script voor de Windows- en Linux-laptops.",
                st(profile, "platform")
            ),
        )));
    }
    let prefix = profile["suggestion"]["prefixLength"]
        .as_i64()
        .or(primary["prefixLength"].as_i64())
        .unwrap_or(24);
    if elevate && !is_static {
        let confirm_hint = match profile["elevateHint"].as_str() {
            Some(hint) => format!(", bevestig ({})", hint.to_lowercase()),
            None => ", bevestig de toestemmingsvraag".into(),
        };
        out = out.child(
            kit::strong_text(
                &format!("**Stap 1:** controleer het adres hieronder (meestal klopt wat er al staat). **Stap 2:** klik op de knop{confirm_hint} en wacht op de melding **“Gelukt!”**. Herhaal dit op elke laptop met een ander adres."),
                p.t.ink2,
                s.dark,
            )
            .wrap()
            .max_w(kit::COPY_MAX)
            .mb(12.0),
        );
        if profile["primaryWired"] == false {
            out = out.child(spaced(kit::notice_text(
                s,
                Tone::Warn,
                "**Deze laptop is via wifi verbonden.** Steek de netwerkkabel in: alleen een bedrade verbinding wordt vastgezet, zodat je wifi thuis of op school nooit verandert.",
            )));
        }
        let field = |title: &str,
                     edit: &TextEdit,
                     key: &str,
                     placeholder: &str,
                     f: fn(&mut State) -> &mut TextEdit| {
            col()
                .grow(1.0)
                .min_w(180.0)
                .gap(4.0)
                .child(
                    text(title.to_string())
                        .font(kit::ts(13.5, 400.0))
                        .color(p.ink),
                )
                .child(
                    kit::input(s, edit, key, title, placeholder)
                        .disabled(busy)
                        .on_edit(f),
                )
        };
        out = out.child(
            row()
                .w_full()
                .gap(8.0)
                .my(12.0)
                .child(field(
                    "Vast adres voor deze laptop",
                    &sys.ip,
                    "net-ip",
                    "192.168.1.211",
                    |s| &mut s.system.ip,
                ))
                .child(field(
                    "Gateway (alleen als er een router is, anders leeg laten)",
                    &sys.gateway,
                    "net-gateway",
                    "192.168.1.1 of leeg",
                    |s| &mut s.system.gateway,
                )),
        );
        let ip = sys.ip.text.trim().to_string();
        if sys.phase == NetPhase::ConfirmMake {
            let label = format!(
                "Ja, maak {} nu vast",
                if ip.is_empty() {
                    "dit adres".to_string()
                } else {
                    format!("{ip}/{prefix}")
                }
            );
            out = out.child(
                row()
                    .gap(8.0)
                    .mt(12.0)
                    .child(kit::btn(s, "net-make-yes", &label, Kind::Primary, false, None, busy || ip.is_empty(), move |s| {
                        let gateway = s.system.gateway.text.trim().to_string();
                        s.send(
                            "net.makeStatic",
                            json!({"ip":s.system.ip.text.trim(),"prefixLength":prefix,"gateway":if gateway.is_empty(){Value::Null}else{json!(gateway)}}),
                        );
                    }))
                    .child(kit::btn(s, "net-make-no", "Toch niet", Kind::Ghost, false, None, busy, |s| s.system.phase = NetPhase::Idle)),
            );
        } else {
            out = out.child(
                kit::btn(
                    s,
                    "net-make",
                    if busy {
                        "Bezig met controleren…"
                    } else {
                        "Maak dit adres vast"
                    },
                    Kind::Primary,
                    false,
                    None,
                    busy || ip.is_empty() || profile["primaryWired"] == false,
                    |s| {
                        s.system.message = None;
                        s.system.phase = NetPhase::ConfirmMake;
                    },
                )
                .self_start(),
            );
        }
    }
    if is_static {
        out = out.child(spaced(kit::notice_text(
            s,
            Tone::Hint,
            &format!(
                "**Dit adres staat vast:** {}. Goed zo — hier hoef je niets meer te doen tot het evenement voorbij is.",
                st(primary, "address")
            ),
        )));
    }
    if elevate {
        let ready = sys.event_over && sys.undo.text.trim().to_uppercase() == UNDO_PHRASE;
        let mut details = col().w_full().gap(8.0).child(disclosure(
            s,
            "net-revert-open",
            "**Na het evenement: adres weer automatisch maken** (hiervoor moet je twee keer bevestigen)",
            sys.revert_open,
            |s| s.system.revert_open = !s.system.revert_open,
        ));
        if sys.revert_open {
            details = details
                .child(kit::copy(
                    "Zolang het adres vast staat, werkt school-wifi vaak niet. Zet het daarom na het evenement terug. Dit kan pas als je hieronder bevestigt dat het evenement echt voorbij is.",
                    s.dark,
                ))
                .child(kit::notice(
                    s,
                    Tone::Hint,
                    kit::toggle_row(s, "net-event-over", "Het evenement is helemaal voorbij (echt waar).", sys.event_over, busy, |s| {
                        s.system.event_over = !s.system.event_over
                    }),
                ))
                .child(
                    col()
                        .gap(4.0)
                        .child(text(format!("Typ {UNDO_PHRASE} om te bewijzen dat je het meent")).font(kit::ts(13.5, 400.0)).color(p.ink))
                        .child(kit::input(s, &sys.undo, "net-undo", "Bevestigingswoord", UNDO_PHRASE).disabled(busy).on_edit(|s: &mut State| &mut s.system.undo)),
                );
            details = details.child(if sys.phase == NetPhase::ConfirmRevert {
                row()
                    .gap(8.0)
                    .child(kit::btn(
                        s,
                        "net-revert-yes",
                        "Ja, zet terug op automatisch",
                        Kind::Primary,
                        false,
                        None,
                        busy || !ready,
                        |s| {
                            let text = s.system.undo.text.trim().to_uppercase();
                            s.send(
                                "net.revertDhcp",
                                json!({"eventOver":true,"confirmText":text}),
                            );
                        },
                    ))
                    .child(kit::btn(
                        s,
                        "net-revert-no",
                        "Toch niet",
                        Kind::Ghost,
                        false,
                        None,
                        busy,
                        |s| s.system.phase = NetPhase::Idle,
                    ))
            } else {
                kit::btn(
                    s,
                    "net-revert",
                    "Zet terug op automatisch",
                    Kind::Ghost,
                    false,
                    None,
                    busy || !ready,
                    |s| {
                        s.system.message = None;
                        s.system.phase = NetPhase::ConfirmRevert;
                    },
                )
                .help(if !sys.event_over {
                    "Vink eerst aan dat het evenement voorbij is".to_string()
                } else if !ready {
                    format!("Typ eerst {UNDO_PHRASE}")
                } else {
                    "Zet het adres terug op automatisch (DHCP)".to_string()
                })
                .self_start()
            });
        }
        out = out.child(spaced(kit::notice(s, Tone::Hint, details)));
    }
    // The download links, as one paragraph with underlined links in brand ink.
    let mut plain = String::from("Liever met de hand of op een andere laptop? Download: ");
    let mut spans = Vec::new();
    let mut links = Vec::new();
    for (i, (title, path)) in SCRIPTS.iter().enumerate() {
        if i > 0 {
            plain.push_str(" · ");
        }
        let start = plain.len();
        plain.push_str(&title.replace('-', "-\u{200b}"));
        spans.push(
            Span::new(start, plain.len())
                .color(p.brand_ink)
                .underline(p.brand_ink),
        );
        links.push(Link::new(start..plain.len(), *path).label(*title));
    }
    let mut paragraph = rune::rich(plain, spans)
        .key("net-scripts")
        .font(kit::ts(13.5, 400.0).lh(20.25))
        .color(p.t.ink2)
        .min_w(0.0)
        .max_w(kit::COPY_MAX)
        .mt(4.0)
        .mb(12.0)
        .on_link(|s: &mut State, path: &str, tx: &mut Tx| open_server_file(s, path, tx));
    for link in links {
        paragraph = paragraph.link(link);
    }
    out = out.child(paragraph);
    if let Some(message) = &sys.message {
        out = out.child(spaced(
            kit::notice_text(s, Tone::Hint, message).role("status"),
        ));
    }
    out
}

/// Opens a file the server hands out (a script, a backup) for download.
fn open_server_file(s: &mut State, path: &str, tx: &mut Tx) {
    #[cfg(target_arch = "wasm32")]
    let _ = s;
    #[cfg(target_arch = "wasm32")]
    let url = path.to_string();
    #[cfg(not(target_arch = "wasm32"))]
    let url = format!(
        "http://127.0.0.1:{}{path}",
        s.snapshot["host"]["port"].as_u64().unwrap_or(5173)
    );
    let _ = tx.open_url(&url);
}

// ---------- Herstelbackups ----------

fn backup_panel(s: &State) -> El {
    let b = &s.recovery["status"];
    let p = kit::pal(s.dark);
    let enabled = b["enabled"] == true;
    let busy = s.busy || b["inProgress"] == true;
    let mut out = section("Herstelbackups", s.dark).child(
        kit::copy(
            if enabled {
                "Apolloon maakt tijdens gebruik automatisch gecontroleerde kopieën van de database en bewaart de recentste."
            } else {
                "Automatische backups zijn op deze installatie uitgeschakeld. Handmatige backups blijven beschikbaar."
            },
            s.dark,
        )
        .mb(12.0),
    );
    if b.is_null() {
        return out;
    }
    if !enabled {
        out = out.child(spaced(kit::notice_text(
            s,
            Tone::Alert,
            "Automatische backups zijn uitgeschakeld.",
        )));
    }
    if let Some(created) = b["latest"]["createdAt"].as_i64() {
        out = out.child(
            kit::strong_text(
                &format!(
                    "**Laatste backup:** {} · {} · {} · gecontroleerd · {} bewaard",
                    kit::date_time(created),
                    kit::relative_age(created, s.clock),
                    kit::file_size(b["latest"]["sizeBytes"].as_i64().unwrap_or(0)),
                    b["retainedCount"]
                ),
                p.ink,
                s.dark,
            )
            .wrap()
            .w_full()
            .py(12.0)
            .border_sides([1.0, 0.0, 1.0, 0.0], p.line),
        );
    } else {
        out = out.child(spaced(kit::notice_text(
            s,
            Tone::Alert,
            "Er is op deze laptop nog geen herstelbackup.",
        )));
    }
    if let Some(name) = b["damagedDatabase"]["fileName"].as_str() {
        out = out.child(spaced(kit::notice_text(
            s,
            Tone::Hint,
            &format!(
                "Bij het opstarten om {} was de databank beschadigd. Ze staat opzij als {name} in de map data; deze laptop startte leeg.",
                kit::date_time(b["damagedDatabase"]["putAsideAt"].as_i64().unwrap_or(0))
            ),
        )));
    }
    if let Some(error) = b["lastError"].as_str() {
        out = out.child(spaced(kit::notice_text(
            s,
            Tone::Alert,
            &format!("Laatste backup mislukt: {error}"),
        )));
    }
    let free = b["diskFreeBytes"]
        .as_i64()
        .map(kit::file_size)
        .unwrap_or_else(|| "onbekend".into());
    if b["diskLow"] == true {
        out = out.child(spaced(kit::notice_text(
            s,
            Tone::Alert,
            &format!(
                "Weinig opslagruimte: nog {free} vrij; de veiligheidsgrens is {}.",
                kit::file_size(b["minimumFreeBytes"].as_i64().unwrap_or(0))
            ),
        )));
    }
    let next = match b["nextScheduledAt"].as_i64() {
        Some(at) if enabled => kit::clock(at),
        _ => "niet gepland".into(),
    };
    out = out.child(
        kit::metrics(
            s,
            vec![
                (
                    "Volgende automatische backup".into(),
                    kit::value_text(next, s.dark),
                ),
                ("Vrije opslag".into(), kit::value_text(free, s.dark)),
                (
                    "Database".into(),
                    kit::value_text(
                        kit::file_size(b["databaseBytes"].as_i64().unwrap_or(0)),
                        s.dark,
                    ),
                ),
            ],
            &[],
        )
        .mt(4.0),
    );
    let mut actions = row().gap(8.0).mt(12.0).child(kit::btn(
        s,
        "backup-create",
        if busy {
            "Backup bezig..."
        } else {
            "Nu backup maken"
        },
        Kind::Primary,
        false,
        None,
        busy,
        |s| s.send("backups.create", json!({})),
    ));
    if let Some(name) = b["latest"]["fileName"].as_str() {
        let path = format!("/api/backups/{name}");
        actions = actions.child(
            kit::btn_el(
                s,
                "backup-download",
                "Laatste backup downloaden",
                Kind::Ghost,
                false,
                None,
                false,
            )
            .role("link")
            .on_press_tx(move |s: &mut State, tx: &mut Tx| open_server_file(s, &path, tx)),
        );
    }
    out.child(actions).child(
        kit::copy(
            "Download regelmatig een kopie naar een USB-stick. De gekoppelde laptops beschermen tegen een defect toestel; deze versies beschermen ook tegen een fout die naar alle laptops gekopieerd is.",
            s.dark,
        )
        .mt(12.0),
    )
}

// ---------- Backup terugzetten ----------

fn restore_panel(s: &State) -> El {
    let p = kit::pal(s.dark);
    let mut out = section("Backup terugzetten", s.dark).child(
        kit::copy(
            "Voor een fout die al op alle laptops staat, zoals een verwijderde loper of een verkeerde import. Alle gekoppelde laptops gaan samen terug; niemand hoeft iets af te sluiten.",
            s.dark,
        )
        .mb(12.0),
    );
    let records = s.recovery["backups"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if records.is_empty() {
        return out.child(spaced(kit::notice_text(
            s,
            Tone::Hint,
            if s.recovery.is_null() {
                "Backups laden…"
            } else {
                "Er is op deze laptop nog geen backup."
            },
        )));
    }
    let line = || {
        row()
            .w_full()
            .gap(20.0)
            .px(10.0)
            .py(7.0)
            .center_y()
            .border_sides([0.0, 0.0, 1.0, 0.0], p.line)
    };
    let mut table = col().w_full().min_w(0.0).child(
        line()
            .child(kit::th("Tijdstip", s.dark).w(260.0))
            .child(kit::th("Soort", s.dark).w(160.0))
            .child(kit::th("Grootte", s.dark).w(100.0))
            .child(rune::el().grow(1.0).label("Actie")),
    );
    let shown = if s.system.show_all {
        records.len()
    } else {
        records.len().min(SHOWN_AT_FIRST)
    };
    for record in &records[..shown] {
        let name = st(record, "fileName").to_string();
        let created = record["createdAt"].as_i64().unwrap_or(0);
        let when = format!("{} ", kit::weekday_time(created, false));
        let age = kit::relative_age(created, s.clock);
        let mut cell = when.clone();
        cell.push_str(&age);
        let span = Span::new(when.len(), cell.len()).color(p.t.ink3).size(12.5);
        let file = name.clone();
        table = table.child(
            line()
                .child(
                    rune::rich(cell, vec![span])
                        .font(kit::ts(13.0, 400.0).lh(19.5))
                        .color(p.ink)
                        .w(260.0),
                )
                .child(
                    text(backup_kind(record))
                        .font(kit::ts(13.0, 400.0))
                        .color(p.ink)
                        .w(160.0),
                )
                .child(
                    text(kit::file_size(record["sizeBytes"].as_i64().unwrap_or(0)))
                        .font(kit::ts(13.0, 400.0))
                        .color(p.ink)
                        .w(100.0),
                )
                .child(row().grow(1.0).justify_end().child(kit::btn(
                    s,
                    format!("restore-{name}"),
                    "Terugzetten",
                    Kind::Ghost,
                    false,
                    None,
                    s.busy,
                    move |s| s.send("backups.preview", json!({"fileName":file})),
                ))),
        );
    }
    out = out.child(table);
    if records.len() > SHOWN_AT_FIRST {
        out = out.child(
            kit::btn(
                s,
                "restore-all",
                &if s.system.show_all {
                    "Minder tonen".to_string()
                } else {
                    format!("Alle {} backups tonen", records.len())
                },
                Kind::Ghost,
                false,
                None,
                false,
                |s| s.system.show_all = !s.system.show_all,
            )
            .self_start()
            .mt(12.0),
        );
    }
    out
}

// ---------- Race wissen ----------

fn clear_panel(s: &State) -> El {
    let race = &s.snapshot["race"];
    let state = match race["raceStartedAt"].as_i64() {
        None => "De race is nog niet gestart.".to_string(),
        Some(start) => format!(
            "De race is {} gestart{}.",
            kit::relative_age(start, s.clock),
            if race["raceFinishedAt"].is_null() {
                " en loopt nog"
            } else {
                " en is afgesloten"
            }
        ),
    };
    let ask = |runners: bool| {
        move |s: &mut State| {
            if !s.busy {
                s.system.clearing_all = runners;
                s.confirm = Some(Command {
                    screen: String::new(),
                    method: "race.clear".into(),
                    input: if runners {
                        json!({"runners":true})
                    } else {
                        json!({})
                    },
                })
            }
        }
    };
    section("Race wissen na een testrun", s.dark)
        .child(kit::copy(
            format!("Haalt alle rondes en de wachtrij weg op alle gekoppelde laptops, zodat de echte race bij nul begint. Lopers en labels blijven staan. Alles wissen haalt ook alle lopers weg, voor een laptop die opnieuw begint. {state}"),
            s.dark,
        ).mb(12.0))
        .child(
            row()
                .gap(8.0)
                .flex_wrap()
                .child(kit::btn(s, "clear-race", if s.busy { "Wissen..." } else { "Race wissen" }, Kind::Danger, false, None, s.busy, ask(false)))
                .child(kit::btn(s, "clear-everything", "Alles wissen", Kind::DangerOutline, false, None, s.busy, ask(true))),
        )
}

// ---------- Database status ----------

fn database_panel(s: &State) -> El {
    let p = kit::pal(s.dark);
    let all = runners(s);
    let waiting = all.iter().filter(|r| r["status"] == "waiting").count();
    let labels = s.snapshot["labels"].as_array().map_or(0, Vec::len);
    let stat = |name: &str, value: usize| {
        col()
            .grow(1.0)
            .min_w(160.0)
            .child(
                text(name.to_string())
                    .font(kit::ts(12.5, 400.0).lh(18.75))
                    .color(p.t.ink3),
            )
            .child(
                text(value.to_string())
                    .font(kit::ts(20.0, 550.0).lh(24.0).tracking(-0.4))
                    .color(p.ink)
                    .mt(2.0),
            )
    };
    section("Database status", s.dark).child(
        row()
            .w_full()
            .gap(12.0)
            .child(stat("Lopers", all.len()))
            .child(stat("Labels", labels))
            .child(stat("In wachtrij", waiting)),
    )
}

// ---------- Over deze installatie ----------

impl State {
    pub(super) fn system_update_problem_clear(&mut self) {
        self.system.update_problem = None;
    }
}
fn ask_install(s: &mut State, version: &str) {
    let others = cluster(s)["members"]
        .as_array()
        .map_or(0, |m| m.len().saturating_sub(1));
    let mut message = "Apolloon maakt eerst een backup, sluit, installeert de nieuwe versie en start daarna vanzelf opnieuw. Dat duurt ongeveer een minuut.".to_string();
    if others > 0 {
        message += &format!(
            " Deze laptop werkt daarna pas weer samen met de {} als die ook bijgewerkt {}: werk ze meteen na elkaar bij.",
            if others == 1 {
                "andere laptop".to_string()
            } else {
                format!("{others} andere laptops")
            },
            if others == 1 { "is" } else { "zijn" }
        );
    }
    s.admin.confirm = Some(admin_base::Confirm {
        title: format!("Bijwerken naar {version}?"),
        message,
        confirm_label: "Installeren en herstarten".into(),
        danger: false,
        action: admin_base::ConfirmAction::InstallUpdate,
    });
}
fn open_url(s: &mut State, url: &str) {
    s.send("desktop.openUrl", json!({"url":url}));
}
/// `UpdateStatusRow`: the last install's outcome, then the update's state with its buttons.
fn update_row(s: &State) -> El {
    let p = kit::pal(s.dark);
    let mut out = col().w_full().gap(8.0);
    let last = &s.system.update["lastInstall"];
    if let Some(version) = last["version"].as_str() {
        out = out.child(if last["ok"] == true {
            row()
                .gap(6.0)
                .center_y()
                .role("status")
                .child(kit::icon(s, "check", p.t.go, 14.0))
                .child(kit::value_text(format!("Apolloon is bijgewerkt naar {version}."), s.dark))
        } else {
            kit::notice_text(
                s,
                Tone::Warn,
                &format!("De installatie van versie {version} is niet gelukt. Probeer opnieuw, of download het installatiebestand zelf."),
            )
            .role("status")
        });
    }
    let status = &s.system.update["status"];
    let state = status["state"].as_str().unwrap_or("idle");
    let version = st(&status["update"], "version").to_string();
    let race = &s.snapshot["race"];
    let race_running = !race["raceStartedAt"].is_null() && race["raceFinishedAt"].is_null();
    if matches!(state, "available" | "downloading" | "ready" | "installing") {
        let percent = status["percent"].as_f64().unwrap_or(0.0);
        let title = match state {
            "downloading" => format!("Versie {version} wordt gedownload… {percent}%"),
            "ready" => format!("Versie {version} is klaar om te installeren."),
            "installing" => format!("Backup maken en versie {version} installeren…"),
            _ => format!("Versie {version} is beschikbaar."),
        };
        let mut body = col().gap(4.0).grow(1.0).min_w(0.0).child(
            text(title)
                .font(kit::ts(13.5, 600.0).lh(20.25))
                .color(p.ink)
                .wrap(),
        );
        if state == "downloading" {
            body = body.child(
                row()
                    .role("progressbar")
                    .label("Download")
                    .a11y_value(format!("{percent}"))
                    .w_full()
                    .h(4.0)
                    .radius(2.0)
                    .fill(p.t.surface3)
                    .child(
                        rune::el()
                            .w((percent as f32 / 100.0).clamp(0.0, 1.0) * 300.0)
                            .max_w(300.0)
                            .h_full()
                            .radius(2.0)
                            .fill(p.brand),
                    )
                    .max_w(300.0),
            );
        }
        let line = match state {
            "installing" => "Apolloon sluit zo en start vanzelf opnieuw met de nieuwe versie.",
            "ready" if race_running => "De wedstrijd loopt: installeer pas na de wedstrijd.",
            _ => SAME_VERSION,
        };
        body = body.child(kit::copy(line, s.dark));
        if matches!(state, "available" | "ready")
            && let Some(problem) = status["problem"].as_str()
        {
            body = body.child(kit::copy(problem.to_string(), s.dark));
        }
        let page_url = st(&status["update"], "pageUrl").to_string();
        let download = status["update"]["downloadUrl"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| page_url.clone());
        let mut actions = row().gap(8.0).center_y();
        if matches!(state, "ready" | "installing") {
            let v = version.clone();
            actions = actions.child(kit::btn(
                s,
                "update-install",
                if state == "installing" {
                    "Bezig…"
                } else {
                    "Nu installeren en herstarten"
                },
                Kind::Primary,
                false,
                Some("download"),
                race_running || state == "installing" || s.busy,
                move |s| ask_install(s, &v),
            ));
        } else if state == "available" {
            actions = actions.child(kit::btn(
                s,
                "update-download",
                "Installatiebestand downloaden",
                Kind::Primary,
                false,
                Some("download"),
                s.busy,
                move |s| open_url(s, &download),
            ));
        }
        actions = actions.child(kit::btn(
            s,
            "update-news",
            "Wat is er nieuw?",
            Kind::Ghost,
            false,
            None,
            s.busy,
            move |s| open_url(s, &page_url),
        ));
        out = out.child(
            kit::notice(
                s,
                Tone::Hint,
                row()
                    .w_full()
                    .gap(12.0)
                    .center_y()
                    .child(body)
                    .child(actions),
            )
            .role("status"),
        );
        if let Some(problem) = &s.system.update_problem {
            out = out.child(kit::notice_text(s, Tone::Alert, problem));
        }
        return out;
    }
    let checked = status["checkedAt"].as_i64().unwrap_or(0);
    let line = match state {
        "checking" => "Controleren op een nieuwere versie…".to_string(),
        "current" => format!("Dit is de nieuwste versie. Gecontroleerd om {}.", &kit::clock(checked)[..5]),
        "unreachable" => "Kon niet controleren op een nieuwere versie (geen internet). Op het evenement is dat normaal.".to_string(),
        _ => "Nog niet gecontroleerd op een nieuwere versie.".to_string(),
    };
    let checking = state == "checking";
    out.child(
        kit::notice(
            s,
            Tone::Hint,
            row()
                .w_full()
                .justify_between()
                .center_y()
                .child(kit::value_text(line, s.dark).color(p.t.ink2))
                .child(kit::btn(
                    s,
                    "update-check",
                    if checking {
                        "Bezig…"
                    } else {
                        "Nu controleren"
                    },
                    Kind::Ghost,
                    true,
                    None,
                    checking || s.busy,
                    |s| {
                        s.send("update.check", json!({}));
                        s.system.update["status"] = json!({"state":"checking","checkedAt":null});
                        s.system.update_asked = Some(s.server_now());
                    },
                )),
        )
        .role("status"),
    )
}

fn diagnostics(s: &State) -> String {
    let info = &s.recovery["system"];
    let mut lines = vec![
        format!(
            "Apolloon Telsysteem — diagnose van {}",
            kit::date_time(s.clock)
        ),
        String::new(),
    ];
    lines.push(format!(
        "Versie: {} · schema {}",
        info["appVersion"].as_str().unwrap_or("onbekend"),
        info["schemaVersion"].as_i64().unwrap_or(17)
    ));
    if cfg!(target_arch = "wasm32") {
        lines.push("Scherm: browser (Rune WebAssembly)".into());
    } else {
        lines.push(format!(
            "Scherm: desktop-app (Rune, {})",
            std::env::consts::OS
        ));
        if let Some(os) = s.system.desktop_diagnostics["os"].as_str() {
            lines.push(format!("Besturingssysteem: {os}"));
        }
        if let Some(path) = s.system.desktop_diagnostics["dataPath"]
            .as_str()
            .or(info["dataPath"].as_str())
        {
            lines.push(format!("Gegevensmap: {path}"));
        }
    }
    if let Some(url) = s.snapshot["host"]["url"].as_str() {
        lines.push(format!("Adres: {url}"));
    }
    lines.push(String::new());
    let c = cluster(s);
    if c["enabled"] == true {
        let (_, title, detail) = describe_group(c);
        lines.push(format!("Groep: {title} — {detail}"));
    } else {
        lines.push("Groep: koppelen staat uit op deze installatie".into());
    }
    let b = &s.recovery["status"];
    lines.push(format!(
        "Backup: {}{} · vrij {}",
        b["latest"]["createdAt"]
            .as_i64()
            .map(|at| format!("laatste {}", kit::date_time(at)))
            .unwrap_or_else(|| "nog geen".into()),
        b["lastError"]
            .as_str()
            .map(|e| format!(" · mislukt: {e}"))
            .unwrap_or_default(),
        b["diskFreeBytes"]
            .as_i64()
            .map(|bytes| format!("{} MB", (bytes as f64 / 1024.0 / 1024.0).round()))
            .unwrap_or_else(|| "onbekend".into())
    ));
    if let Some(tail) = s.system.desktop_diagnostics["logTail"]
        .as_str()
        .filter(|t| !t.is_empty())
    {
        lines.extend([
            String::new(),
            "--- laatste regels van server.log ---".into(),
            tail.to_string(),
        ]);
    }
    lines.join("\n")
}

fn about_panel(s: &State) -> El {
    let p = kit::pal(s.dark);
    let info = &s.recovery["system"];
    let desktop = cfg!(not(target_arch = "wasm32"));
    let mut facts = vec![
        (
            "Versie".to_string(),
            kit::value_text(
                format!("Apolloon {}", info["appVersion"].as_str().unwrap_or("…")),
                s.dark,
            ),
        ),
        (
            "Databankschema".to_string(),
            kit::value_text(
                info["schemaVersion"]
                    .as_i64()
                    .map_or("…".into(), |v| v.to_string()),
                s.dark,
            ),
        ),
    ];
    let mut widths = vec![Some(140.0), Some(140.0)];
    if desktop && let Some(path) = info["dataPath"].as_str() {
        facts.push((
            "Gegevensmap (databank, backups en server.log)".into(),
            text(path.to_string())
                .font(kit::ts(12.5, 400.0).mono())
                .color(p.ink)
                .wrap()
                .min_w(0.0),
        ));
        widths.push(None);
    } else {
        // The empty third column of the grid.
        facts.push((String::new(), rune::el()));
        widths.push(None);
    }
    let mut out =
        section("Over deze installatie", s.dark).child(kit::metrics(s, facts, &widths).gap(20.0));
    if desktop {
        out = out.child(update_row(s).mt(12.0));
    } else {
        out = out.child(
            kit::copy(
                "Dit scherm is een browser. Installeren, updaten en de logbestanden openen gebeurt op de laptop zelf, in de Apolloon-app.",
                s.dark,
            )
            .mt(12.0)
            .mb(12.0),
        );
    }
    let copied = s.system.copied_at.is_some_and(|at| s.clock - at < 2000);
    let mut actions = row().gap(8.0).mt(if desktop { 12.0 } else { 0.0 });
    if desktop {
        actions = actions.child(
            kit::btn_el(
                s,
                "about-folder",
                "Logmap openen",
                Kind::Ghost,
                false,
                Some("folder"),
                false,
            )
            .on_press(|s: &mut State| {
                s.system.folder_error =
                    open_folder(s.recovery["system"]["dataPath"].as_str().unwrap_or(""));
            }),
        );
    }
    actions = actions.child(
        kit::btn_el(
            s,
            "about-diagnostics",
            if copied {
                "Gekopieerd"
            } else {
                "Diagnose kopiëren"
            },
            Kind::Ghost,
            false,
            Some(if copied { "check" } else { "copy" }),
            false,
        )
        .on_press_tx(|s: &mut State, tx: &mut Tx| {
            tx.copy(&diagnostics(s));
            s.system.copied_at = Some(s.server_now());
        }),
    );
    out = out.child(actions);
    if let Some(error) = &s.system.folder_error {
        out = out.child(spaced(kit::notice_text(
            s,
            Tone::Alert,
            &format!("De map kon niet worden geopend: {error}"),
        )));
    }
    out.child(
        kit::copy(
            format!(
                "Vraag je hulp op afstand? Plak de diagnose in je bericht: ze bevat de versie, de status van de laptops en de backups{}.",
                if desktop { ", en de laatste regels van het logbestand" } else { "" }
            ),
            s.dark,
        )
        .mt(12.0),
    )
}

#[cfg(not(target_arch = "wasm32"))]
fn open_folder(path: &str) -> Option<String> {
    if path.is_empty() {
        return Some("De gegevensmap is niet bekend.".into());
    }
    let program = if cfg!(target_os = "windows") {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program)
        .arg(path)
        .spawn()
        .err()
        .map(|e| e.to_string())
}
#[cfg(target_arch = "wasm32")]
fn open_folder(_: &str) -> Option<String> {
    Some("Dit kan alleen in de Apolloon-app.".into())
}

// ---------- Confirmations (src/components/ConfirmDialog.tsx) ----------

/// The dialog for a confirmation this section asked for, worded as the reference does.
pub(super) fn modal(s: &State) -> Option<El> {
    let command = s.confirm.as_ref()?;
    let input = &command.input;
    let (title, paragraphs, confirm_label): (String, Vec<String>, &str) = match command.method.as_str() {
        "backups.restore" => {
            let pv = &s.preview;
            let when = kit::weekday_time(pv["createdAt"].as_i64().unwrap_or(0), false);
            let mut body = vec![
                format!(
                    "Alle gekoppelde laptops gaan terug naar deze backup: {} lopers en {} rondes{}. Nu zijn er {} lopers.",
                    pv["runners"],
                    pv["laps"],
                    pv["lastLapAt"].as_i64().map(|at| format!(", laatste ronde om {}", kit::weekday_time(at, false))).unwrap_or_default(),
                    runners(s).len()
                ),
                format!("Alles wat na {when} gebeurde, verdwijnt. De huidige toestand wordt eerst als backup bewaard, dus ook dit terugzetten kan je nog ongedaan maken."),
            ];
            if race_open(pv) {
                body.push("**De wedstrijd liep toen.** De loper die toen op de piste stond, staat er weer, met de starttijd van toen. Controleer de timing meteen na het terugzetten.".into());
            }
            (format!("Terug naar {when}?"), body, "Terugzetten")
        }
        "race.clear" => {
            let all = input["runners"] == true;
            let mut body = if all {
                vec![
                    "Op alle gekoppelde laptops verdwijnen alle lopers met hun inschrijvingen, en alle rondes, wissels, Burgie-meldingen en de wachtrij. De race staat weer op niet gestart.".to_string(),
                    "Labels, logo's en instellingen blijven staan.".into(),
                ]
            } else {
                vec![
                    "Op alle gekoppelde laptops verdwijnen alle rondes, wissels, Burgie-meldingen en de wachtrij. De race staat weer op niet gestart en elke loper staat terug op ingeschreven.".to_string(),
                    "Lopers, labels, logo's en instellingen blijven staan.".into(),
                ]
            };
            if race_open(&s.snapshot["race"]) {
                body.push("**De race loopt nu.** Wis alleen na de testrun, nooit tijdens de echte race.".into());
            }
            body.push("De huidige toestand wordt eerst als backup bewaard, dus je kan dit nog ongedaan maken.".into());
            (if all { "Alles wissen?" } else { "Race wissen?" }.into(), body, if all { "Alles wissen" } else { "Race wissen" })
        }
        "cluster.continueAlone" if input["takeOverTiming"] == true => {
            let name = cluster(s)["timing"]["name"].as_str().unwrap_or("een andere laptop");
            (
                "Timing overnemen en alleen verder werken?".into(),
                vec![format!("Doe dit alleen als {name} echt kapot is. Deze laptop werkt dan alleen verder en klokt de rondes. Komen de andere laptops terug, dan nemen ze de gegevens van deze laptop over en bewaren ze hun eigen gegevens in een backup.")],
                "Overnemen en alleen verder werken",
            )
        }
        "cluster.continueAlone" => (
            "Alleen verder werken?".into(),
            vec!["Doe dit alleen als de andere laptops echt kapot of weg zijn. Staan ze nog aan, controleer dan de netwerkkabel: dan werkt alles vanzelf weer. Wijzigingen van de laatste seconden op de andere laptops kunnen ontbreken. Komen ze later terug, dan nemen ze de gegevens van deze laptop over en bewaren ze hun eigen gegevens in een backup.".into()],
            "Alleen verder werken",
        ),
        "cluster.removeLaptop" => {
            let name = st(input, "name");
            let left = cluster(s)["members"].as_array().map_or(1, Vec::len) as i64 - 1;
            (
                format!("{name} uit de groep halen?"),
                vec![format!(
                    "Doe dit alleen als deze laptop kapot of weg is. Staat hij nog aan, controleer dan de netwerkkabel: dan werkt hij vanzelf weer mee. Daarna bestaat de groep uit {}, en is een wijziging bewaard zodra {} laptops ze hebben. Koppel daarna een reservelaptop, zodat er weer één mag uitvallen. Komt {name} later toch terug, dan werkt hij pas weer mee als je daar op Opnieuw koppelen drukt.",
                    kit::count_label(left, "laptop", "laptops"),
                    left / 2 + 1
                )],
                "Uit de groep halen",
            )
        }
        "cluster.joinGroup" if input["rejoin"] == true => (
            "Opnieuw koppelen?".into(),
            vec![format!(
                "Deze laptop neemt alle gegevens van {} over en werkt daarna weer mee. Wat nu op deze laptop staat, wordt eerst als backup bewaard.",
                laptop_label(input)
            )],
            "Opnieuw koppelen",
        ),
        "cluster.joinGroup" => {
            let others = cluster(s)["members"].as_array().map_or(1, Vec::len) - 1;
            (
                if others > 0 { "Deze laptops koppelen?" } else { "Deze laptop koppelen?" }.into(),
                vec!["Is de race nog nergens gestart, dan komen de lopers en labels van beide laptops samen. Anders houdt de laptop waar de race loopt zijn gegevens, dan die waar de race al gestart is, en daarna die met de meeste lopers. De andere laptop neemt alle gegevens over en werkt daarna mee. Wat daar stond, wordt eerst als backup bewaard.".into()],
                "Koppelen",
            )
        }
        _ => return None,
    };
    let p = kit::pal(s.dark);
    let t = tok::theme(s.dark);
    let close = |s: &mut State| s.confirm = None;
    let cancel = kit::btn(
        s,
        "cancel",
        "Annuleer",
        Kind::Plain,
        false,
        None,
        false,
        close,
    )
    .autofocus();
    let ok = kit::btn(
        s,
        "confirm",
        confirm_label,
        Kind::Danger,
        false,
        None,
        s.busy,
        |s| {
            if let Some(c) = s.confirm.take() {
                s.send(&c.method, c.input);
            }
        },
    );
    let mut body = col().gap(8.0);
    for paragraph in paragraphs {
        body = body.child(
            kit::strong_text(&paragraph, p.t.ink2, s.dark)
                .wrap()
                .w_full(),
        );
    }
    Some(
        rune::el()
            .key("dialog-overlay")
            .absolute(0.0, 0.0)
            .w_full()
            .h_full()
            .padding(16.0)
            .center()
            .fill(p.overlay)
            .modal(false, close)
            .child(
                col()
                    .key("confirmation")
                    .role("dialog")
                    .label(title.clone())
                    .w(420.0)
                    .max_w(420.0)
                    .padding(20.0)
                    .radius(10.0)
                    .fill(t.card)
                    .border(1.0, t.card_border)
                    .child(
                        text(title)
                            .font(kit::ts(16.0, 600.0).lh(20.0))
                            .color(t.text)
                            .mb(6.0)
                            .wrap()
                            .w_full(),
                    )
                    .child(body)
                    .child(
                        row()
                            .mt(20.0)
                            .gap(8.0)
                            .justify_end()
                            .child(cancel)
                            .child(ok),
                    ),
            ),
    )
}

#[cfg(test)]
mod tests {
    use super::super::*;
    use super::{backup_kind, diagnostics, kit, laptop_with_address};
    use rune::{Env, Runtime};
    use std::sync::{Arc, Mutex};

    fn settle(rt: &mut Runtime<State>, predicate: impl Fn(&State) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(8);
        while !predicate(&rt.state) {
            assert!(
                Instant::now() < deadline,
                "UI did not settle: {}",
                rt.state.error
            );
            rt.update_if(|state, tx| poll(state, 0.0, tx));
            rt.frame(1.0 / 60.0);
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn press(rt: &mut Runtime<State>, key: &str) {
        rt.frame(1.0 / 60.0);
        let (x, y) = rt
            .find(key)
            .unwrap_or_else(|| panic!("Missing UI control {key}"));
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(1.0 / 60.0);
    }
    fn reveal(rt: &mut Runtime<State>, key: &str) {
        for _ in 0..30 {
            rt.frame(0.2);
            if rt.find(key).is_some_and(|(_, y)| y > 60.0 && y < 720.0) {
                return;
            }
            rt.wheel(1100.0, 650.0, -160.0);
        }
        panic!("Could not scroll to {key}");
    }
    /// A server on a fresh on-disk database (backups need a file), and the UI on a Beheer section.
    fn start(
        section: usize,
        seed: impl FnOnce(&mut crate::db::Db),
    ) -> (
        Runtime<State>,
        Arc<Mutex<crate::db::Db>>,
        impl Drop,
        std::path::PathBuf,
    ) {
        let root = std::env::temp_dir().join(format!("apolloon-native-system-{}", crate::db::id()));
        let mut database = crate::db::Db::open(&root.join("data/app.db")).unwrap();
        seed(&mut database);
        let db = Arc::new(Mutex::new(database));
        let socket = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = socket.local_addr().unwrap().port();
        drop(socket);
        let host = crate::server::start(db.clone(), port).unwrap();
        let mut state = init_with_url(format!("http://127.0.0.1:{port}"));
        state.page = 8;
        state.admin_section = section;
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
        settle(&mut rt, |s| s.connected && s.recovery["system"].is_object());
        (rt, db, host, root)
    }
    #[test]
    fn update_row_reads_the_status_over_http_and_asks_before_installing() {
        let (mut rt, _db, _host, _root) = start(6, |_| {});
        // The desktop's update status comes from the server.
        rt.state.send("update.status", json!({}));
        settle(&mut rt, |s| {
            !s.busy && s.system.update["status"]["state"].is_string()
        });
        assert!(rt.state.error.is_empty(), "{}", rt.state.error);
        // A downloaded update offers install, which asks first with the reference wording.
        rt.update_if(|s, _| {
            s.system.update = json!({"status":{"state":"ready","checkedAt":1,"update":{"version":"9.9.9","pageUrl":"https://example.invalid"}}});
            true
        });
        reveal(&mut rt, "update-install");
        press(&mut rt, "update-install");
        let confirm = rt.state.admin.confirm.as_ref().expect("install asks first");
        assert_eq!(confirm.title, "Bijwerken naar 9.9.9?");
        assert_eq!(confirm.confirm_label, "Installeren en herstarten");
        // During the race the install button stays off.
        rt.update_if(|s, _| {
            s.admin.confirm = None;
            s.snapshot["race"]["raceStartedAt"] = json!(1);
            s.snapshot["race"]["raceFinishedAt"] = Value::Null;
            true
        });
        reveal(&mut rt, "update-install");
        press(&mut rt, "update-install");
        assert!(rt.state.admin.confirm.is_none());
    }
    #[test]
    fn a_pinned_address_is_followed_until_the_profile_shows_it() {
        let (mut rt, _db, _host, _root) = start(6, |_| {});
        let s = &mut rt.state;
        s.system.phase = super::NetPhase::WaitingMake;
        s.system.net_wait = Some(super::NetWait {
            elevation: json!("e1"),
            wanted: Some("192.168.1.211".into()),
            ticks: 0,
            answers: 0,
        });
        s.system.net_profile = json!({"primary":{"address":"192.168.1.20","dhcp":true},"lastElevation":{"id":"e1","state":"waiting"}});
        super::follow_net_change(s);
        assert!(s.system.net_wait.is_some(), "still waiting");
        s.system.net_profile = json!({"primary":{"address":"192.168.1.211","dhcp":false}});
        super::follow_net_change(s);
        assert!(s.system.net_wait.is_none() && s.system.phase == super::NetPhase::Idle);
        assert_eq!(
            s.admin.toast.as_ref().unwrap().text,
            "Dit adres is nu vast: 192.168.1.211."
        );
        // A refused password prompt stops the wait at once.
        s.system.net_wait = Some(super::NetWait {
            elevation: json!("e2"),
            wanted: None,
            ticks: 0,
            answers: 0,
        });
        s.system.net_profile = json!({"primary":{"address":"192.168.1.211","dhcp":false},"lastElevation":{"id":"e2","state":"failed","message":"Geweigerd."}});
        super::follow_net_change(s);
        let toast = s.admin.toast.as_ref().unwrap();
        assert_eq!(
            (toast.text.as_str(), toast.detail.as_str(), toast.error),
            ("Terugzetten mislukt", "Geweigerd.", true)
        );
    }
    fn setting(db: &Arc<Mutex<crate::db::Db>>) -> Value {
        db.lock()
            .unwrap()
            .rows(
                "SELECT value FROM settings WHERE key='public_record_mode'",
                &[],
            )
            .unwrap()[0]["value"]
            .clone()
    }

    #[test]
    fn public_section_sets_the_record_flash_and_saves_burgie_gepakt() {
        let (mut rt, db, host, root) = start(4, |db| {
            db.mutation(
                "runners.create",
                &json!({"runnerNumber":"7","name":"Mitras","status":"waiting"}),
            )
            .unwrap();
        });
        press(&mut rt, "record-hour");
        settle(&mut rt, |s| {
            !s.busy && s.snapshot["settings"]["publicRecordMode"] == "hour"
        });
        assert_eq!(setting(&db), "hour");
        assert_eq!(rt.state.notice, "Recordflits staat op per uur.");
        // The chosen mode does not send again.
        press(&mut rt, "record-hour");
        assert!(!rt.state.busy);
        press(&mut rt, "burgie");
        settle(&mut rt, |s| !s.busy);
        assert!(
            rt.state.notice.starts_with("Burgie gepakt opgeslagen om "),
            "{}",
            rt.state.notice
        );
        let saved = db
            .lock()
            .unwrap()
            .rows(
                "SELECT COUNT(*) AS n FROM race_events WHERE type='burgie_gepakt'",
                &[],
            )
            .unwrap();
        assert_eq!(saved[0]["n"], 1);
        press(&mut rt, "open-outside");
        assert_eq!(rt.state.page, 7);
        drop(rt);
        drop(host);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn activity_section_lists_changes_and_filters_queue_moves_and_search() {
        let (mut rt, db, host, root) = start(5, |db| {
            let id = db
                .mutation(
                    "runners.create",
                    &json!({"runnerNumber":"7","name":"Mitras"}),
                )
                .unwrap()["id"]
                .clone();
            db.mutation("runners.create", &json!({"runnerNumber":"8","name":"Wout"}))
                .unwrap();
            db.mutation("runners.setStatus", &json!({"id":id,"status":"waiting"}))
                .unwrap();
        });
        settle(&mut rt, |s| !s.busy && !s.activity.is_empty());
        let all = rt.state.activity.len();
        assert!(rt.find("activity-queue").is_some());
        press(&mut rt, "activity-queue");
        assert!(rt.state.activity_queue);
        settle(&mut rt, |s| {
            !s.busy && s.activity_filter.starts_with("true|")
        });
        assert!(rt.state.activity.len() >= all);
        rt.state.activity_search = TextEdit::new("Wout");
        settle(&mut rt, |s| !s.busy && s.activity_filter.ends_with("|Wout"));
        assert!(!rt.state.activity.is_empty());
        assert!(
            rt.state
                .activity
                .iter()
                .all(|e| e.to_string().contains("Wout"))
        );
        rt.state.activity_search = TextEdit::new("niemand-zo");
        settle(&mut rt, |s| {
            !s.busy && s.activity_filter.ends_with("|niemand-zo")
        });
        assert!(rt.state.activity.is_empty());
        drop(db);
        drop(rt);
        drop(host);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn system_section_shows_the_address_clears_the_race_after_its_dialog_and_copies_the_diagnosis()
    {
        let (mut rt, db, host, root) = start(6, |db| {
            db.mutation(
                "runners.create",
                &json!({"runnerNumber":"7","name":"Mitras","status":"waiting"}),
            )
            .unwrap();
        });
        let profile = &rt.state.recovery["system"]["profile"];
        assert_eq!(profile["elevateMethod"], Value::Null);
        assert_eq!(rt.state.recovery["system"]["schemaVersion"], 17);
        // Race wissen asks first, in the reference's words; Annuleer keeps everything.
        reveal(&mut rt, "clear-race");
        press(&mut rt, "clear-race");
        assert_eq!(
            rt.state.confirm.as_ref().map(|c| c.method.as_str()),
            Some("race.clear"),
            "clear button at {:?}, busy={}",
            rt.find("clear-race"),
            rt.state.busy
        );
        assert!(rt.find("confirmation").is_some());
        press(&mut rt, "cancel");
        assert!(rt.state.confirm.is_none());
        reveal(&mut rt, "clear-everything");
        press(&mut rt, "clear-everything");
        press(&mut rt, "confirm");
        settle(&mut rt, |s| {
            !s.busy
                && s.snapshot["runners"]
                    .as_array()
                    .is_some_and(|r| r.is_empty())
        });
        assert!(db.lock().unwrap().runners().unwrap().is_empty());
        assert!(
            rt.state
                .notice
                .starts_with("Alles gewist: 1 lopers en 0 rondes weg."),
            "{}",
            rt.state.notice
        );
        settle(&mut rt, |s| {
            s.recovery["backups"]
                .as_array()
                .is_some_and(|b| !b.is_empty())
        });
        assert!(
            rt.state.recovery["backups"][0]["fileName"]
                .as_str()
                .unwrap()
                .contains("-pre-clear-")
        );
        reveal(&mut rt, "about-diagnostics");
        press(&mut rt, "about-diagnostics");
        assert!(rt.state.system.copied_at.is_some());
        let text = diagnostics(&rt.state);
        assert!(
            text.contains("· schema 17") && text.contains("Groep: koppelen staat uit"),
            "{text}"
        );
        drop(rt);
        drop(host);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn backup_names_and_sizes_read_as_in_the_reference() {
        assert_eq!(
            backup_kind(&json!({"fileName":"app-pre-clear-1.db","scheduled":false})),
            "Vóór race wissen"
        );
        assert_eq!(
            backup_kind(&json!({"fileName":"app-scheduled-1.db","scheduled":true})),
            "Automatisch"
        );
        assert_eq!(kit::file_size(282_829), "276.2 KiB");
        assert_eq!(kit::file_size(21_367_276_339), "19.9 GiB");
        assert_eq!(kit::relative_age(0, 51 * 60_000), "51 minuten geleden");
        assert_eq!(
            laptop_with_address(&json!("kassa"), &json!("http://10.0.0.2:5173")),
            "kassa (10.0.0.2:5173)"
        );
    }
}
