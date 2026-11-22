use crate::db::now;
use crate::theme as tok;
use crate::theme as type_;
use base64::Engine;
use rune::{AppSpec, Cx, El, Key, KeyEvent, ScrollSpec, TextEdit, Tx, col, row, text, text_input};
use serde_json::{Value, json};
use std::{
    sync::mpsc::{self, Receiver, Sender},
    time::Duration,
};

#[cfg(not(target_arch = "wasm32"))]
use std::time::Instant;
#[cfg(target_arch = "wasm32")]
use web_time::Instant;

mod activity_panel;
mod admin_base;
mod admin_preparation;
mod admin_runners;
mod admin_kit;
mod analysis_page;
mod admin_system;
mod chart_axis;
mod clock;
mod cluster_setup;
mod group_view;
mod hex;
mod history_delivery;
mod label_editor;
mod laps_panel;
mod profile;
mod public_settings;
mod queue_page;
mod public_screens;
mod readiness;
mod overview;
use overview::overview;
mod shell;
mod tactics_page;
mod timing_page;
mod timing_text;
mod history_sync;
#[cfg(test)]
mod cluster_ui_test;
#[cfg(test)]
mod motion_gate_test;
#[derive(Clone, Copy)]
enum FilePurpose {
    Import,
    Logo,
    Reference,
}
type PickedFile = (FilePurpose, String, Vec<u8>);

const PAGES: [&str; 9] = [
    "Overzicht",
    "Wachtrij",
    "Timing",
    "Analyse",
    "Tactiek",
    "Binnenscherm",
    "Competitiescherm",
    "Buitenscherm",
    "Beheer",
];
struct Command {
    screen: String,
    method: String,
    input: Value,
}
#[derive(Default)]
struct Update {
    partial: bool,
    snapshot: Value,
    history: history_delivery::Delivery,
    history_changes: Option<std::sync::Arc<std::sync::Mutex<history_sync::Pending>>>,
    outcome: Option<(String, Result<Value, String>)>,
    recovery: Value,
    images: Vec<(String, Vec<u8>)>,
    clock_offset: Option<i64>,
}
type WakeSlot = std::sync::Arc<std::sync::Mutex<Option<rune::Waker>>>;
type CommandWake = std::sync::Arc<std::sync::Mutex<Option<std::task::Waker>>>;
#[derive(Clone)]
struct Updates {
    sender: Sender<Update>,
    wake: WakeSlot,
}
impl Updates {
    fn send(&self, update: Update) -> Result<(), mpsc::SendError<Update>> {
        crate::latency::snapshot("update_ready", &update.snapshot);
        self.sender.send(update)?;
        if let Some(wake) = self.wake.lock().unwrap().clone() { wake(); }
        Ok(())
    }
}
pub struct State {
    page: usize,
    page_seen: usize,
    profile: Option<profile::Form>,
    activity: Vec<Value>,
    activity_search: TextEdit,
    activity_queue: bool,
    activity_revision: i64,
    activity_filter: String,
    activity_more: bool,
    label_form: label_editor::Form,
    admin: admin_base::Admin,
    laps: laps_panel::Panel,
    system: admin_system::Panel,
    group: group_view::Watch,
    timing_page: timing_page::Page,
    analysis_page: analysis_page::Page,
    queue_page: queue_page::Page,
    tactics: tactics_page::Page,
    admin_section: usize,
    recovery: Value,
    preview: Value,
    notice: String,
    import_file: Option<(String, Vec<u8>)>,
    import_preview: Option<Result<Value, String>>,
    import_problems: Vec<String>,
    file_tx: Sender<Result<PickedFile, String>>,
    file_rx: Receiver<Result<PickedFile, String>>,
    collapsed: bool,
    welcome_skipped: bool,
    icons: Vec<rune::Image>,
    image_cache: Option<rune::ImageCache>,
    logos: std::collections::HashMap<String, rune::Image>,
    dark: bool,
    snapshot: Value,
    history: Value,
    history_version: u64,
    history_index: history_sync::Index,
    history_sequence: u64,
    history_pending: Vec<history_delivery::Delivery>,
    error: String,
    busy: bool,
    connected: bool,
    search: TextEdit,

    tx: Sender<Command>,
    transport_wake: WakeSlot,
    command_wake: CommandWake,
    rx: Receiver<Update>,
    confirm: Option<Command>,
    last_press: Option<(Instant, i64)>,
    clock: i64,
    clock_offset: i64,
    public_screens: public_screens::Screen,
    fixture: bool,
    route_seen: String,
}
const ROUTES: [&str; 9] = [
    "/",
    "/queue",
    "/timing",
    "/analysis",
    "/tactics",
    "/display/inside",
    "/display/competitions",
    "/display/outside",
    "/admin",
];
const SECTIONS: [&str; 7] = [
    "preparation",
    "runners",
    "laps",
    "labels",
    "public",
    "activity",
    "system",
];
fn apply_route(state: &mut State, route: &str) {
    let (path, query) = route.split_once('?').unwrap_or((route, ""));
    state.page = ROUTES.iter().position(|r| *r == path).unwrap_or(0);
    if state.page == 8 {
        state.admin_section = query
            .split('&')
            .find_map(|part| part.strip_prefix("section="))
            .and_then(|section| SECTIONS.iter().position(|s| *s == section))
            .unwrap_or(0);
    }
    state.public_screens.settings.apply_query(state.page, query);
    state.confirm = None;
}
#[cfg(target_arch = "wasm32")]
fn browser_route() -> String {
    let location = web_sys::window().unwrap().location();
    format!(
        "{}{}",
        location.pathname().unwrap_or_else(|_| "/".into()),
        location.search().unwrap_or_default()
    )
}
#[cfg(target_arch = "wasm32")]
fn sync_route(state: &mut State) -> bool {
    let actual = browser_route();
    if actual != state.route_seen {
        apply_route(state, &actual);
        state.route_seen = actual;
        return true;
    }
    let wanted = if state.page == 8 {
        format!("/admin?section={}", SECTIONS[state.admin_section])
    } else {
        format!("{}{}", ROUTES[state.page], state.public_screens.settings.query(state.page))
    };
    if wanted != actual {
        if web_sys::window()
            .unwrap()
            .history()
            .and_then(|h| h.push_state_with_url(&wasm_bindgen::JsValue::NULL, "", Some(&wanted)))
            .is_ok()
        {
            state.route_seen = wanted;
        }
    }
    false
}
fn init() -> State {
    #[cfg(not(target_arch = "wasm32"))]
    let url = std::env::var("APOLLOON_NATIVE_URL")
        .unwrap_or_else(|_| format!("http://127.0.0.1:{}", crate::port().unwrap_or(5174)));
    #[cfg(target_arch = "wasm32")]
    let url = web_sys::window()
        .expect("browser window")
        .location()
        .origin()
        .expect("page origin");
    #[allow(unused_mut)]
    let mut state = init_with_url(url);
    #[cfg(not(target_arch = "wasm32"))]
    if !state.fixture {
        state.public_screens.settings.ensure_loaded();
        if let Some(route) = crate::desktop::recovered_route() {
            apply_route(&mut state, &route);
        }
    }
    if !state.fixture {
        tactics_page::restore_reference(&mut state.tactics);
        state.welcome_skipped = overview::welcome_skipped();
    }
    #[cfg(target_arch = "wasm32")]
    {
        let route = browser_route();
        apply_route(&mut state, &route);
        state.route_seen = route;
    }
    state
}
fn init_with_url(url: String) -> State {
    let (tx, commands) = mpsc::channel::<Command>();
    let (updates, rx) = mpsc::channel();
    let transport_wake = WakeSlot::default();
    let command_wake = CommandWake::default();
    start_transport(url, commands, Updates { sender: updates, wake: transport_wake.clone() }, command_wake.clone());
    let (file_tx, file_rx) = mpsc::channel();
    #[allow(unused_mut)]
    let mut state = State {
        page: 0,
        page_seen: 0,
        profile: None,
        activity: Vec::new(),
        activity_search: TextEdit::new(""),
        activity_queue: false,
        activity_revision: -1,
        activity_filter: String::new(),
        activity_more: false,
        label_form: label_editor::Form::default(),
        admin: admin_base::Admin::default(),
        laps: laps_panel::Panel::default(),
        system: admin_system::Panel::default(),
        timing_page: timing_page::Page::default(),
        analysis_page: analysis_page::Page::default(),
        queue_page: queue_page::Page::default(),
        tactics: tactics_page::Page::default(),
        admin_section: 1,
        recovery: Value::Null,
        preview: Value::Null,
        notice: String::new(),
        import_file: None,
        import_preview: None,
        import_problems: Vec::new(),
        file_tx,
        file_rx,
        collapsed: false,
        welcome_skipped: false,
        icons: Vec::new(),
        image_cache: None,
        logos: std::collections::HashMap::new(),
        dark: shell::initial_dark(),
        snapshot: Value::Null,
        history: json!({"laps":[]}),
        history_version: 0,
        history_index: Default::default(),
        history_sequence: 0,
        history_pending: Vec::new(),
        error: String::new(),
        busy: false,
        connected: false,
        search: TextEdit::new(""),

        tx,
        transport_wake,
        command_wake,
        rx,
        confirm: None,
        last_press: None,
        clock: now(),
        clock_offset: 0,
        public_screens: Default::default(),
        fixture: false,
        route_seen: String::new(),
        group: Default::default(),
    };
    #[cfg(not(target_arch = "wasm32"))]
    if let Ok(path) = std::env::var("APOLLOON_NATIVE_FIXTURE") {
        let data: Value =
            serde_json::from_slice(&std::fs::read(path).expect("read renderer fixture"))
                .expect("valid renderer fixture");
        state.snapshot = data["snapshot"].clone();
        state.history = data["history"].clone();
        state.clock = data["clock"].as_i64().unwrap_or_else(now);
        state.fixture = true;
        state.dark = std::env::var("APOLLOON_NATIVE_THEME").as_deref() != Ok("light");
        state.page = std::env::var("APOLLOON_NATIVE_PAGE")
            .ok()
            .and_then(|v| v.parse().ok())
            .filter(|i: &usize| *i < PAGES.len())
            .unwrap_or(0);
    }
    state.page_seen = state.page;
    state
}
impl State {
    fn server_now(&self) -> i64 {
        now().saturating_add(self.clock_offset)
    }

    fn send(&mut self, method: &str, input: Value) {
        if self.busy || !self.connected {
            return;
        }
        self.error.clear();
        self.notice.clear();
        self.busy = true;
        if self
            .tx
            .send(Command {
                screen: ROUTES[self.page].into(),
                method: method.into(),
                input,
            })
            .is_err()
        {
            self.error = "Verbinding verbroken".into();
            self.busy = false;
        }
        if let Some(wake) = self.command_wake.lock().unwrap().take() { wake.wake(); }
    }
    fn timing(&mut self, method: &str, confirmed: bool) {
        if self.busy || !self.connected || self.confirm.is_some() {
            return;
        }
        let race = &self.snapshot["race"];
        let pressed = self.server_now();
        let mut input = json!({"activeRunnerId":race["activeRunnerId"],"activeStartedAt":race["activeStartedAt"],"pressedAt":pressed});
        if method == "race.handoff" && !race["raceFinishedAt"].is_null() {
            input["resume"] = json!(true);
        }
        if let Some((instant, started)) = self.last_press
            && race["activeStartedAt"].as_i64() == Some(started)
        {
            input["measuredDurationMs"] = json!(instant.elapsed().as_millis() as u64);
        }
        let short = race["activeStartedAt"]
            .as_i64()
            .is_some_and(|start| pressed - start < 20000);
        if !confirmed
            && (method == "race.finish"
                || method == "race.undoLastHandoff"
                || (method == "race.handoff" && (short || !race["raceFinishedAt"].is_null())))
        {
            self.confirm = Some(Command {
                screen: String::new(),
                method: method.into(),
                input,
            });
            return;
        }
        self.last_press = Some((Instant::now(), pressed));
        self.send(method, input);
    }
}
fn poll(s: &mut State, _: f64, tx: &mut Tx) -> bool {
    let mut changed = false;
    #[cfg(target_arch = "wasm32")]
    if !s.fixture && sync_route(s) {
        changed = true;
    }
    if s.page != s.page_seen {
        s.page_seen = s.page;
        s.error.clear();
        changed = true;
    }
    #[cfg(not(target_arch = "wasm32"))]
    if !s.fixture {
        crate::desktop::pulse_window();
        let route = if s.page == 8 {
            format!("/admin?section={}", SECTIONS[s.admin_section])
        } else {
            ROUTES[s.page].into()
        };
        crate::desktop::remember_route(route, &mut s.route_seen);
    }
    if s.fixture {
        return changed;
    }
    let public = (5..=7).contains(&s.page);
    while let Ok(file) = s.file_rx.try_recv() {
        changed = true;
        match file {
            Ok((FilePurpose::Import, name, bytes)) => {
                s.import_file = Some((name, bytes));
                s.import_preview = admin_preparation::analysis(s);
                s.import_problems.clear();
            }
            Ok((FilePurpose::Reference, name, bytes)) => tactics_page::load_file(s, name, bytes),
            Ok((FilePurpose::Logo, _, bytes)) => label_editor::upload(s, bytes),
            Err(e) => s.error = e,
        }
    }
    while let Ok(update) = s.rx.try_recv() {
        let traced = crate::latency::enabled() && !update.snapshot.is_null();
        if traced { crate::latency::snapshot("apply_begin", &update.snapshot); }
        if let Some(offset) = update.clock_offset
            && s.clock_offset.abs_diff(offset) >= 16
        {
            s.clock_offset = offset;
        }
        if !update.partial {
            let connected = !update.snapshot.is_null();
            changed |= s.connected != connected;
            s.connected = connected;
        }
        // Polls and actions fetch side by side: never let an older answer replace a newer one.
        let older = |new: &Value, old: &Value| {
            new["revision"].as_i64() < old["revision"].as_i64()
                && same_run(&new["changeToken"], &old["changeToken"])
        };
        if update.snapshot["unchanged"] == true {
            for key in ["host", "cluster", "screens"] {
                if let Some(value) = update.snapshot.get(key)
                    && s.snapshot[key] != *value
                {
                    s.snapshot[key] = value.clone();
                    changed = true;
                }
            }
        }
        if s.connected
            && !update.snapshot.is_null()
            && update.snapshot["unchanged"] != true
            && !older(&update.snapshot, &s.snapshot)
            && s.snapshot != update.snapshot
        {
            s.snapshot = update.snapshot;
            changed = true;
        }
        let full_history = !update.history.body.is_null() && update.history.body["delta"] != true
            && update.history.sequence > s.history_sequence;
        match history_delivery::apply(&mut s.history, &mut s.history_sequence, &mut s.history_pending,
            &mut s.history_index, &mut s.history_version, update.history) {
            Some(applied) => {
                changed |= applied;
                if full_history && let Some(pending) = update.history_changes { pending.lock().unwrap().reset = false; }
            }
            None => {
                if let Some(pending) = update.history_changes { pending.lock().unwrap().reset = true; }
                changed = true;
            }
        }
        if !update.recovery.is_null() && s.recovery != update.recovery {
            s.recovery = update.recovery;
            changed |= !public;
        }
        if let Some(cache) = &s.image_cache {
            for (url, bytes) in update.images {
                s.logos.insert(url, cache.load(bytes));
                changed = true;
            }
        }
        if let Some((method, outcome)) = update.outcome {
            changed = true;
            if method == "cluster.testGroup" {
                s.group.testing = false;
                tx.animated();
            }
            s.busy = false;
            match outcome {
                Err(error) => {
                    s.error = error;
                    if admin_system::owns(s, &method) {
                        admin_system::failed(s, &method);
                    } else {
                        timing_page::failed(s, &method);
                    }
                    queue_page::failed(s, &method);
                    laps_panel::failed(s, &method);
                    admin_base::failed(s);
                    s.last_press = None;
                    s.laps.success.clear();
                }
                Ok(result) => match method.as_str() {
                    m if queue_page::owns(s, m) => queue_page::succeeded(s, m, &result),
                    m if admin_system::owns(s, m) => admin_system::succeeded(s, m, &result),
                    _ if admin_base::owns(s) => admin_base::succeeded(s, &result),
                    "activity.list" | "activity.older" => {
                        let entries = result["entries"].as_array().cloned().unwrap_or_default();
                        s.activity_more = entries.len() == 200;
                        if method == "activity.list" {
                            s.activity = entries;
                            s.activity_revision = result["revision"].as_i64().unwrap_or(-1);
                        } else {
                            s.activity.extend(entries);
                        }
                    }
                    "labels.uploadFile" | "labels.uploadImage" => {
                        s.label_form
                            .set_image(result["imageUrl"].as_str().unwrap_or(""));
                    }
                    "labels.create" | "labels.update" => {
                        s.label_form = label_editor::Form::default();
                        s.notice = "Label opgeslagen.".into();
                    }
                    "runners.profile" => {
                        s.admin.registrations[admin_base::st(&result["runner"], "id")] = result["registration"].clone();
                        s.profile = Some(profile::Form::new(
                            &result["runner"],
                            &result["registration"],
                        ));
                        tx.focus_when_shown("profile-number", false);
                    }
                    "runners.create" | "runners.update" => {
                        s.profile = None;
                        s.notice = "Loper opgeslagen.".into();
                    }
                    "runners.importCsv" | "runners.importXlsx" => {
                        s.notice = format!(
                            "{} aangemaakt, {} bijgewerkt, {} overgeslagen",
                            result["created"], result["updated"], result["skipped"]
                        );
                        s.import_problems = result["errors"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|v| v.as_str().map(str::to_owned))
                            .collect();
                    }
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
                            clock_text(result["createdAt"].as_i64().unwrap_or(s.clock))
                        )
                    }
                    "backups.restore" => {
                        s.notice = format!(
                            "Teruggezet: {} lopers, {} rondes. De toestand van daarvoor staat in backup {}.",
                            result["runners"],
                            result["laps"],
                            result["safetyBackup"].as_str().unwrap_or("")
                        );
                        s.last_press = None;
                    }
                    "race.clear" => {
                        s.notice = format!(
                            "Race gewist: {} rondes weg. {} lopers verwijderd. Ongedaan maken kan met backup {}.",
                            result["laps"],
                            result["runners"],
                            result["safetyBackup"].as_str().unwrap_or("")
                        );
                        s.last_press = None;
                    }
                    "race.handoff" | "race.startNext" | "race.finish" | "race.undoLastHandoff" | "events.burgieGepakt" | "cluster.openTiming" | "cluster.continueAlone" => timing_page::succeeded(s, &method, &result),
                    "laps.move" | "laps.split" | "laps.delete" | "laps.moveHandoff" => {
                        laps_panel::succeeded(s, &method)
                    }
                    _ => s.notice = "Opgeslagen.".into(),
                },
            }
        }
        if traced { crate::latency::snapshot("applied", &s.snapshot); }
    }
    let clock_changed = clock::advance(s, tx);
    if group_view::observe(s) {
        tx.animated();
        changed = true;
    }
    timing_page::send_waiting_press(s);
    let was_busy = s.busy;
    activity_panel::refresh(s);
    queue_page::refresh(s);
    changed |= admin_base::refresh(s, tx);
    laps_panel::sync_hold(s);
    changed |= tactics_page::refresh(s);
    changed |= was_busy != s.busy;
    public_screens::poll(s, changed, s.clock) || clock_changed
}
fn button(
    key: impl Into<String>,
    label: impl Into<String>,
    dark: bool,
    f: impl Fn(&mut State) + 'static,
) -> El {
    let label = label.into();
    let t = tok::theme(dark);
    row()
        .key(key.into())
        .role("button")
        .label(label.clone())
        .focusable(true)
        .px(14.0)
        .py(10.0)
        .radius(7.0)
        .fill(t.card)
        .border(1.0, t.card_border)
        .hover(t.hover)
        .on_press(f)
        .child(text(label).font(type_::BODY).color(t.text))
}
fn label(value: impl Into<String>, dark: bool) -> El {
    text(value.into())
        .font(type_::BODY)
        .color(tok::theme(dark).text)
}
fn heading(value: impl Into<String>, dark: bool) -> El {
    text(value.into())
        .font(type_::TITLE)
        .color(tok::theme(dark).text)
}
fn card(title: &str, value: impl Into<String>, dark: bool) -> El {
    let t = tok::theme(dark);
    col()
        .grow(1.0)
        .gap(12.0)
        .px(22.0)
        .py(22.0)
        .radius(10.0)
        .fill(t.card)
        .border(1.0, t.card_border)
        .child(text(title).font(type_::LABEL).color(t.text_secondary))
        .child(heading(value, dark))
}
fn duration(ms: i64) -> String {
    let sec = ms.max(0) / 1000;
    if sec >= 3600 {
        format!("{}:{:02}:{:02}", sec / 3600, (sec / 60) % 60, sec % 60)
    } else {
        format!("{}:{:02}", sec / 60, sec % 60)
    }
}
fn runners(s: &State) -> Vec<&Value> {
    s.snapshot["runners"]
        .as_array()
        .map(|a| a.iter().collect())
        .unwrap_or_default()
}
fn active(s: &State) -> String {
    runners(s)
        .iter()
        .find(|r| r["id"] == s.snapshot["race"]["activeRunnerId"])
        .and_then(|r| r["name"].as_str())
        .unwrap_or("Niemand op de piste")
        .into()
}
fn laps(s: &State) -> Vec<&Value> {
    s.history["laps"]
        .as_array()
        .map(|a| a.iter().collect())
        .unwrap_or_default()
}
fn race_time(s: &State) -> String {
    s.snapshot["race"]["raceStartedAt"]
        .as_i64()
        .map(|start| {
            duration(
                s.snapshot["race"]["raceFinishedAt"]
                    .as_i64()
                    .unwrap_or(s.clock)
                    - start,
            )
        })
        .unwrap_or_else(|| "0:00".into())
}
fn lap_list(s: &State) -> El {
    let mut list = col().gap(8.0).child(heading("Laatste rondes", s.dark));
    for lap in laps(s).into_iter().take(30) {
        list = list.child(
            row()
                .gap(20.0)
                .py(9.0)
                .child(label(format!("#{}", lap["lapNumber"]), s.dark))
                .child(label(lap["runnerName"].as_str().unwrap_or(""), s.dark).grow(1.0))
                .child(label(
                    duration(lap["durationMs"].as_i64().unwrap_or(0)),
                    s.dark,
                )),
        );
    }
    list
}
fn lap_duration(ms: i64) -> String {
    format!("{}.{:03}", duration(ms), ms.max(0) % 1000)
}
fn timing(s: &State) -> El {
    let current = s.snapshot["race"]["activeStartedAt"]
        .as_i64()
        .map(|start| duration(s.clock - start))
        .unwrap_or_else(|| "00:00:00".into());
    col()
        .gap(24.0)
        .child(
            row()
                .gap(16.0)
                .child(card("Nu op de piste", active(s), s.dark))
                .child(card("Lopende ronde", current, s.dark)),
        )
        .child(
            button(
                "handoff",
                if s.busy {
                    "Bezig met opslaan…"
                } else {
                    "Wissel registreren  ·  Spatie / Enter"
                },
                s.dark,
                |s| s.timing("race.handoff", false),
            )
            .h(85.0)
            .center(),
        )
        .child(
            row()
                .gap(12.0)
                .child(button(
                    "undo",
                    "Laatste wissel ongedaan maken",
                    s.dark,
                    |s| s.timing("race.undoLastHandoff", false),
                ))
                .child(button("finish", "Race beëindigen", s.dark, |s| {
                    s.timing("race.finish", false)
                })),
        )
        .child(lap_list(s))
}
fn queue(s: &State) -> El {
    let mut board = row().gap(14.0);
    let search = s.search.text.to_lowercase();
    for (status, title) in [
        ("registered", "Ingeschreven"),
        ("warming_up", "Opwarming"),
        ("waiting", "Klaar"),
        ("ran", "Gelopen"),
    ] {
        let mut lane = col().grow(1.0).gap(10.0).child(heading(title, s.dark));
        for runner in runners(s).into_iter().filter(|r| {
            r["status"] == status
                && r["hiddenFromQueue"] != true
                && format!("{} {}", r["name"], r["runnerNumber"])
                    .to_lowercase()
                    .contains(&search)
        }) {
            let id = runner["id"].as_str().unwrap_or("").to_owned();
            let destination = if status == "warming_up" {
                "waiting"
            } else {
                "warming_up"
            };
            let action = if destination == "waiting" {
                "Klaarzetten"
            } else {
                "Naar opwarming"
            };
            let mut item = col()
                .gap(8.0)
                .px(12.0)
                .py(12.0)
                .radius(8.0)
                .fill(tok::theme(s.dark).card)
                .child(button(
                    format!("profile-{id}"),
                    runner["name"].as_str().unwrap_or(""),
                    s.dark,
                    {
                        let id = id.clone();
                        move |s| s.send("runners.profile", json!({"id":id}))
                    },
                ))
                .child(label(format!("{} rondes", runner["lapCount"]), s.dark))
                .child(button(format!("move-{id}"), action, s.dark, move |s| {
                    s.send("runners.setStatus", json!({"id":id,"status":destination}))
                }));
            if status == "waiting" {
                let id = runner["id"].as_str().unwrap_or("").to_owned();
                item = item.child(button(format!("up-{id}"), "Naar voren", s.dark, move |s| {
                    let mut ids: Vec<Value> = runners(s)
                        .into_iter()
                        .filter(|r| r["status"] == "waiting")
                        .map(|r| r["id"].clone())
                        .collect();
                    if let Some(i) = ids.iter().position(|v| v == &id)
                        && i > 0
                    {
                        ids.swap(i, i - 1);
                        s.send("runners.reorder", json!({"ids":ids}));
                    }
                }));
            }
            lane = lane.child(item);
        }
        board = board.child(lane);
    }
    col()
        .gap(20.0)
        .child(
            text_input(&s.search, type_::BODY)
                .key("search")
                .label("Loper zoeken")
                .h(38.0)
                .px(12.0)
                .fill(tok::theme(s.dark).card)
                .color(tok::theme(s.dark).text)
                .on_edit(|s: &mut State| &mut s.search),
        )
        .child(board)
}
#[cfg(not(target_arch = "wasm32"))]
fn choose_file(s: &mut State, tx: &mut Tx, purpose: FilePurpose) {
    if s.busy {
        return;
    }
    tx.open_file(
        rune::FileDialogOptions {
            title: match purpose {
                FilePurpose::Import => "Inschrijvingen importeren",
                FilePurpose::Logo => "Logo kiezen",
                FilePurpose::Reference => "Resultaten vorig jaar kiezen",
            }
            .into(),
            ..Default::default()
        }
        .filter(
            "Bestanden",
            match purpose {
                FilePurpose::Import => &["csv", "tsv", "txt", "xlsx"][..],
                FilePurpose::Reference => &["json", "txt"][..],
                FilePurpose::Logo => {
                    &["png", "jpg", "jpeg", "webp", "gif", "bmp", "ico", "svg"][..]
                }
            },
        ),
        move |s: &mut State, result, _| match result {
            Ok(Some(path)) => {
                let sender = s.file_tx.clone();
                std::thread::spawn(move || {
                    let result = (|| {
                        if std::fs::metadata(&path).map_err(|e| e.to_string())?.len()
                            > 25 * 1024 * 1024
                        {
                            return Err("Het bestand is te groot (maximaal 25 MB).".into());
                        }
                        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
                        Ok((
                            purpose,
                            path.file_name()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .to_string(),
                            bytes,
                        ))
                    })();
                    let _ = sender.send(result);
                });
            }
            Ok(None) => {}
            Err(e) => s.error = e.to_string(),
        },
    );
}
#[cfg(target_arch = "wasm32")]
fn choose_file(s: &mut State, _: &mut Tx, purpose: FilePurpose) {
    use wasm_bindgen::{JsCast, closure::Closure};
    if s.busy {
        return;
    }
    let result = (|| -> Result<(), wasm_bindgen::JsValue> {
        let document = web_sys::window().unwrap().document().unwrap();
        let input = document
            .create_element("input")?
            .dyn_into::<web_sys::HtmlInputElement>()?;
        input.set_type("file");
        input.set_accept(match purpose {
            FilePurpose::Import => ".csv,.tsv,.txt,.xlsx",
            FilePurpose::Logo => "image/*,.svg,.png,.jpg,.jpeg,.webp,.gif,.bmp,.ico",
            FilePurpose::Reference => ".json,.txt,application/json,text/plain",
        });
        let sender = s.file_tx.clone();
        let source = input.clone();
        let change = Closure::once_into_js(move |_: web_sys::Event| {
            let file = source.files().and_then(|f| f.get(0));
            source.set_onchange(None);
            source.set_oncancel(None);
            source.remove();
            let Some(file) = file else {
                return;
            };
            wasm_bindgen_futures::spawn_local(async move {
                let result = if file.size() > 25.0 * 1024.0 * 1024.0 {
                    Err("Het bestand is te groot (maximaal 25 MB).".into())
                } else {
                    wasm_bindgen_futures::JsFuture::from(file.array_buffer())
                        .await
                        .map(|b| (purpose, file.name(), js_sys::Uint8Array::new(&b).to_vec()))
                        .map_err(|_| "Het bestand kon niet gelezen worden.".to_string())
                };
                let _ = sender.send(result);
            });
        });
        input.set_hidden(true);
        input.set_onchange(Some(change.unchecked_ref()));
        input.set_oncancel(Some(change.unchecked_ref()));
        document
            .body()
            .ok_or(wasm_bindgen::JsValue::NULL)?
            .append_child(&input)?;
        input.click();
        Ok(())
    })();
    if result.is_err() {
        s.error = "De bestandskiezer kon niet geopend worden.".into();
    }
}
fn choose_import(s: &mut State, tx: &mut Tx) {
    choose_file(s, tx, FilePurpose::Import);
}
fn choose_reference(s: &mut State, tx: &mut Tx) {
    choose_file(s, tx, FilePurpose::Reference);
}
fn choose_logo(s: &mut State, tx: &mut Tx) {
    choose_file(s, tx, FilePurpose::Logo);
}
fn decode_csv(bytes: &[u8]) -> String {
    std::str::from_utf8(bytes)
        .map(str::to_owned)
        .unwrap_or_else(|_| encoding_rs::WINDOWS_1252.decode(bytes).0.into_owned())
}
fn clock_text(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| {
            d.with_timezone(&chrono_tz::Europe::Brussels)
                .format("%d/%m/%Y %H:%M:%S")
                .to_string()
        })
        .unwrap_or_else(|| "—".into())
}

fn admin(s: &State) -> El {
    // SectionNavigation: 38 high tabs, 20 apart, ink-3 until chosen, a 2px ink rail on the divider.
    let tabs = [
        "Voorbereiding",
        "Lopers",
        "Rondes",
        "Labels",
        "Publiek",
        "Activiteit",
        "Systeem & herstel",
    ];
    let p = admin_base::pal(s.dark);
    let attention = readiness::needs_attention(s);
    let mut bar = row()
        .key("admin-tabs")
        .role("navigation")
        .label("Beheeronderdelen")
        .gap(20.0)
        .mb(16.0)
        .flex_wrap()
        .border_sides([0.0, 0.0, 1.0, 0.0], p.line);
    for (i, title) in tabs.iter().enumerate() {
        let on = s.admin_section == i;
        let mut tab = row()
            .key(format!("admin-tab-{i}"))
            .role("button")
            .label(if i == 6 && attention { format!("{title} Vraagt aandacht") } else { title.to_string() })
            .checked(on)
            .focusable(true)
            .h(38.0)
            .mb(-1.0)
            .center_y()
            .border_sides([0.0, 0.0, if on { 2.0 } else { 0.0 }, 0.0], p.ink)
            .on_press_tx(move |s: &mut State, tx: &mut Tx| {
                tx.instant();
                s.admin_section = i;
                s.admin.select = None;
            })
            .child(text(title.to_string()).font(admin_base::ts(13.5, 500.0)).color(if on { p.ink } else { p.t.ink3 }));
        if i == 6 && attention {
            tab = tab.child(rune::el().size(6.0, 6.0).radius(3.0).ml(6.0).mt(9.0).fill(p.t.warn));
        }
        bar = bar.child(tab);
    }
    let content = match s.admin_section {
        0 => admin_preparation::section(s),
        1 => admin_runners::section(s),
        2 => laps_panel::panel(s),
        3 => label_editor::panel_view(s),
        4 => public_settings::panel(s),
        5 => activity_panel::panel(s),
        6 => admin_system::panel(s),
        _ => col().child(label("Deze sectie wordt nog gemigreerd.", s.dark)),
    };
    let content = content.pt(8.0);
    let content = match s.admin_section {
        1 => content,
        2 => content.max_w(1720.0),
        _ => content.max_w(1120.0),
    };
    col().child(bar).child(content)
}
fn view(s: &State, _cx: &mut Cx<State>) -> El {
    if (5..=7).contains(&s.page) {
        return public_screens::view(s);
    }
    #[cfg(not(target_arch = "wasm32"))]
    _cx.zoom(s.public_screens.settings.operator_zoom());
    let t = tok::theme(s.dark);
    let nav = shell::sidebar(s);
    let body = match s.page {
        0 => overview(s),
        1 => queue_page::page(s),
        2 => timing_page::page(s),
        3 => analysis_page::page(s),
        4 => tactics_page::page(s),
        5..=7 => col()
            .gap(30.0)
            .child(heading("APOLLOON 24 URENLOOP", s.dark))
            .child(overview(s)),
        _ => admin(s),
    };
    let mut content = col()
        .grow(1.0)
        .min_h(0.0)
        .min_w(0.0)
        .gap(20.0)
        .child(shell::header(s));
    if !s.notice.is_empty() {
        content = content.child(label(&s.notice, s.dark).role("status").wrap().min_w(0.0));
    }
    if !s.error.is_empty() {
        content = content.child(
            row().gap(12.0).center_y()
                .child(label(&s.error, s.dark).role("alert").wrap().min_w(0.0).grow(1.0))
                .child(button("error-dismiss", "Sluiten", s.dark, |s| s.error.clear())),
        );
    }
    let modal = if let Some(modal) = admin_system::modal(s) {
        Some(modal)
    } else if let Some(command) = &s.confirm {
        let title = match command.method.as_str() {
            "backups.restore" => "Backup terugzetten?",
            "race.clear" if command.input["runners"] == true => "Alles wissen?",
            "race.clear" => "Race wissen?",
            "labels.delete" => "Label verwijderen?",
            "laps.delete" => "Ronde verwijderen?",
            "runners.delete" => "Loper definitief verwijderen?",
            "race.finish" => "De race beëindigen?",
            "race.undoLastHandoff" => "De laatste actie ongedaan maken?",
            _ => "Korte ronde of hervatting: deze wissel bevestigen?",
        };
        let detail = if command.method == "backups.restore" {
            format!(
                "{} — {} lopers, {} rondes. De huidige toestand wordt eerst als gecontroleerde backup bewaard.",
                clock_text(s.preview["createdAt"].as_i64().unwrap_or(0)),
                s.preview["runners"],
                s.preview["laps"]
            )
        } else if command.method == "laps.delete" {
            laps_panel::delete_detail(s, &command.input["lapId"])
        } else if command.method == "labels.delete" {
            "Dit verwijdert het label ook van lopers. Labels op gelopen rondes blijven bewaard."
                .into()
        } else if command.method == "runners.delete" {
            "Deze loper wordt definitief verwijderd. Gelopen rondes worden niet verwijderd.".into()
        } else if command.method == "race.clear" {
            "Lopers en racegegevens worden volgens je keuze gewist. Een backup bewaart de toestand van daarvoor.".into()
        } else {
            String::new()
        };
        Some(
            rune::el()
                .key("dialog-overlay")
                .absolute(0.0, 0.0)
                .w_full()
                .h_full()
                .padding(24.0)
                .center()
                .fill(rune::oklcha(0.21, 0.006, 285.9, 0.4))
                .modal(false, |s: &mut State| s.confirm = None)
                .child(
                    col()
                        .key("confirmation")
                        .role("dialog")
                        .label(title)
                        .w_full()
                        .max_w(520.0)
                        .min_w(0.0)
                        .radius(10.0)
                        .gap(12.0)
                        .padding(20.0)
                        .fill(t.card)
                        .child(heading(title, s.dark))
                        .child(label(detail, s.dark).wrap().min_w(0.0))
                        .child(
                            row()
                                .gap(10.0)
                                .child(button("confirm", "Bevestigen", s.dark, |s| {
                                    if let Some(c) = s.confirm.take() {
                                        s.send(&c.method, c.input);
                                    }
                                }))
                                .child(button("cancel", "Annuleren", s.dark, |s| s.confirm = None)),
                        ),
                ),
        )
    } else {
        admin_base::modal(s)
            .or_else(|| laps_panel::modal(s))
            .or_else(|| timing_page::modal(s))
            .or_else(|| queue_page::modal(s))
            .or_else(|| analysis_page::modal(s))
    };
    content = content.child(
        col()
            .grow(1.0)
            .min_h(0.0)
            .scroll(ScrollSpec {
                stick_bottom: false,
            })
            .px(30.0)
            .pb(24.0)
            .child(if s.confirm.is_some() || s.profile.is_some() || s.laps.fix.is_some() {
                body.inert()
            } else {
                body
            }),
    );
    // Hex-style window: the sidebar sits on the window colour, the page in one rounded panel.
    let panel = col()
        .grow(1.0)
        .h_full()
        .min_w(0.0)
        .py(8.0)
        .pr(8.0)
        .child(
            content
                .w_full()
                .fill(t.bg)
                .radius(12.0)
                .border(1.0, t.card_border)
                .clip_rounded(12.0),
        );
    // Laptop screens answer quickly: every change on them that animates (a press, a new lap)
    // springs on `SNAP` (0.25 s), not Rune's 0.5 s fallback. The tv screens keep their slower motion.
    let mut root = row()
        .w_full()
        .h_full()
        .token_motion(rune::tok::motion::SNAP)
        .fill(tok::sidebar(s.dark))
        .child(nav)
        .child(panel);
    if let Some(toast) = group_view::toast(s) {
        root = root.child(toast);
    }
    match modal {
        Some(modal) => root.child(modal),
        None => root,
    }
}
fn on_key(s: &mut State, event: &KeyEvent, tx: &mut Tx) -> bool {
    if crate::latency::enabled() && s.page == 2 && (matches!(&event.key, Key::Enter) || matches!(&event.key, Key::Text(v) if v == " ")) {
        crate::latency::handoff("key", &s.snapshot["race"], None);
    }
    if s.confirm.is_some() && matches!(event.key, Key::Escape) {
        s.confirm = None;
        return true;
    }
    if event.is_command('b') {
        s.collapsed = !s.collapsed;
        return true;
    }
    if public_screens::key(s, event) {
        return true;
    }
    if s.page != 2
        || s.confirm.is_some()
        || s.profile.is_some()
        || tx.focused().is_some()
        || tx.key_repeat()
        || event.mods.ctrl
        || event.mods.alt
        || event.mods.logo
    {
        return false;
    }
    if matches!(&event.key, Key::Enter) || matches!(&event.key,Key::Text(v) if v==" ") {
        timing_page::key_press(s);
        return true;
    }
    false
}
pub fn run() {
    crate::latency::init();
    let spec = AppSpec {
        fonts: &[
            include_bytes!("../assets/geist-latin-wght-normal.ttf"),
            include_bytes!("../assets/geist-latin-ext-wght-normal.ttf"),
        ],
        families: ("Geist", "Geist"),
        setup: Some(setup),
        poll: Some(poll),
        on_key: Some(desktop_key),
        ..AppSpec::new("Apolloon Telsysteem", (1366.0, 768.0), init, desktop_view)
    };
    #[cfg(not(target_arch = "wasm32"))]
    crate::desktop::chrome::run(spec, |app| if crate::latency::enabled() {
        app.on_frame_drawn(|rt| crate::latency::snapshot("frame", &rt.state.snapshot))
            .on_frame_stage(crate::latency::frame_stage)
            .on_frame_encoded(|frame| {
                if frame.outcome() == rune::FrameOutcome::Drawn { crate::latency::emit("cadence", "native", None); }
            })
    } else { app });
    #[cfg(target_arch = "wasm32")]
    rune::run(spec);
}
/// The desktop window's title bar, start screen and close question around the view.
fn desktop_view(s: &State, cx: &mut Cx<State>) -> El {
    let content = view(s, cx);
    #[cfg(not(target_arch = "wasm32"))]
    return crate::desktop::chrome::frame(cx, s.dark, (5..=7).contains(&s.page), content, |s: &mut State| s.page = 0);
    #[cfg(target_arch = "wasm32")]
    content
}
fn desktop_key(s: &mut State, event: &KeyEvent, tx: &mut Tx) -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    if crate::desktop::chrome::key(event, tx) {
        return true;
    }
    on_key(s, event, tx)
}

fn setup(s: &mut State, waker: rune::Waker) {
    #[cfg(not(target_arch = "wasm32"))]
    timing_text::prepare();
    *s.transport_wake.lock().unwrap() = Some(waker.clone());
    waker();
    let cache = rune::ImageCache::new(waker);
    s.icons = vec![
        cache.svg(
            &include_bytes!("../assets/icons/overview-light.svg")[..],
            18.0,
            2.0,
        ),
        cache.svg(
            &include_bytes!("../assets/icons/overview-dark.svg")[..],
            18.0,
            2.0,
        ),
        cache.svg(
            &include_bytes!("../assets/icons/overview-active.svg")[..],
            18.0,
            2.0,
        ),
        cache.svg(
            &include_bytes!("../assets/icons/queue-light.svg")[..],
            18.0,
            2.0,
        ),
        cache.svg(
            &include_bytes!("../assets/icons/queue-dark.svg")[..],
            18.0,
            2.0,
        ),
        cache.svg(
            &include_bytes!("../assets/icons/queue-active.svg")[..],
            18.0,
            2.0,
        ),
        cache.svg(
            &include_bytes!("../assets/icons/timing-light.svg")[..],
            18.0,
            2.0,
        ),
        cache.svg(
            &include_bytes!("../assets/icons/timing-dark.svg")[..],
            18.0,
            2.0,
        ),
        cache.svg(
            &include_bytes!("../assets/icons/timing-active.svg")[..],
            18.0,
            2.0,
        ),
        cache.svg(
            &include_bytes!("../assets/icons/analysis-light.svg")[..],
            18.0,
            2.0,
        ),
        cache.svg(
            &include_bytes!("../assets/icons/analysis-dark.svg")[..],
            18.0,
            2.0,
        ),
        cache.svg(
            &include_bytes!("../assets/icons/analysis-active.svg")[..],
            18.0,
            2.0,
        ),
        cache.svg(
            &include_bytes!("../assets/icons/tactics-light.svg")[..],
            18.0,
            2.0,
        ),
        cache.svg(
            &include_bytes!("../assets/icons/tactics-dark.svg")[..],
            18.0,
            2.0,
        ),
        cache.svg(
            &include_bytes!("../assets/icons/tactics-active.svg")[..],
            18.0,
            2.0,
        ),
        cache.svg(
            &include_bytes!("../assets/icons/displayInside-light.svg")[..],
            18.0,
            2.0,
        ),
        cache.svg(
            &include_bytes!("../assets/icons/displayInside-dark.svg")[..],
            18.0,
            2.0,
        ),
        cache.svg(
            &include_bytes!("../assets/icons/displayInside-active.svg")[..],
            18.0,
            2.0,
        ),
        cache.svg(
            &include_bytes!("../assets/icons/displayCompetitions-light.svg")[..],
            18.0,
            2.0,
        ),
        cache.svg(
            &include_bytes!("../assets/icons/displayCompetitions-dark.svg")[..],
            18.0,
            2.0,
        ),
        cache.svg(
            &include_bytes!("../assets/icons/displayCompetitions-active.svg")[..],
            18.0,
            2.0,
        ),
        cache.svg(
            &include_bytes!("../assets/icons/displayOutside-light.svg")[..],
            18.0,
            2.0,
        ),
        cache.svg(
            &include_bytes!("../assets/icons/displayOutside-dark.svg")[..],
            18.0,
            2.0,
        ),
        cache.svg(
            &include_bytes!("../assets/icons/displayOutside-active.svg")[..],
            18.0,
            2.0,
        ),
        cache.svg(
            &include_bytes!("../assets/icons/admin-light.svg")[..],
            18.0,
            2.0,
        ),
        cache.svg(
            &include_bytes!("../assets/icons/admin-dark.svg")[..],
            18.0,
            2.0,
        ),
        cache.svg(
            &include_bytes!("../assets/icons/admin-active.svg")[..],
            18.0,
            2.0,
        ),
    ];
    shell::load_icons(&cache);
    s.icons
        .push(cache.load(&include_bytes!("../assets/logo-light.png")[..]));
    s.icons
        .push(cache.load(&include_bytes!("../assets/logo-dark.png")[..]));
    #[cfg(not(target_arch = "wasm32"))]
    crate::desktop::chrome::set_logos(s.icons[s.icons.len() - 2].clone(), s.icons[s.icons.len() - 1].clone());
    #[cfg(not(target_arch = "wasm32"))]
    for icon in &s.icons {
        icon.wait().expect("bundled icon must decode");
    }
    s.image_cache = Some(cache);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_poll_paths_keep_history_cursor_presence_and_change_token() {
        let synced = Synced { history: json!({"cursor":"epoch.2"}), ..Default::default() };
        assert_eq!(synced.state_path(Some("db.1.2"), Some("inside")), "/api/state?history=1&after=db.1.2&since=epoch.2&screen=inside");
        assert_eq!(Synced::default().state_path(None, None), "/api/state?history=1");
    }

    #[test]
    fn old_servers_errors_and_fast_unchanged_answers_are_paced_without_delaying_changes() {
        let elapsed = Duration::from_millis(10);
        for state in [Value::Null, json!({"revision":1}), json!({"changeToken":"same"}), json!({"unchanged":true,"changeToken":"same"})] {
            assert_eq!(poll_delay(&state, Some("same"), elapsed), Duration::from_millis(190));
            assert_eq!(poll_delay(&state, Some("same"), Duration::from_secs(2)), Duration::ZERO);
        }
        assert_eq!(poll_delay(&json!({"changeToken":"new"}), Some("old"), elapsed), Duration::ZERO);
    }

    #[test]
    fn unchanged_push_keeps_race_and_history_but_refreshes_live_status() {
        let (sender, receiver) = mpsc::channel();
        let mut state = init_with_url("http://127.0.0.1:0".into());
        state.connected = true;
        state.snapshot = json!({"revision":7,"changeToken":"db.7","runners":[{"id":"runner"}],"race":{"activeRunnerId":"runner"},"cluster":{"writable":true}});
        state.history = json!({"laps":[{"id":"lap"}],"cursor":"epoch.2"});
        let before = (state.snapshot.clone(), state.history.clone());
        state.rx = receiver;
        sender.send(Update { snapshot: json!({"unchanged":true,"changeToken":"db.7","cluster":{"writable":false},"screens":[{"kind":"inside"}]}), ..Default::default() }).unwrap();
        poll(&mut state, 0.0, &mut Tx::default());
        assert!(state.connected);
        for key in ["revision", "changeToken", "runners", "race"] {
            assert_eq!(state.snapshot[key], before.0[key]);
        }
        assert_eq!(state.history, before.1);
        assert_eq!(state.snapshot["cluster"]["writable"], false);
        assert_eq!(state.snapshot["screens"], json!([{"kind":"inside"}]));
        assert!(state.snapshot.get("unchanged").is_none());
    }

    #[test]
    fn a_restarted_server_at_a_lower_revision_replaces_what_the_screen_holds() {
        let mut state = init_with_url("http://127.0.0.1:0".into());
        let (sender, receiver) = std::sync::mpsc::channel();
        state.rx = receiver;
        state.connected = true;
        state.snapshot = json!({"revision":9,"changeToken":"first.9.1","runners":[{"id":"old"}]});
        // The same run: an answer that was overtaken is dropped.
        sender.send(Update { snapshot: json!({"revision":8,"changeToken":"first.8.1","runners":[]}), ..Default::default() }).unwrap();
        poll(&mut state, 0.0, &mut Tx::default());
        assert_eq!(state.snapshot["revision"], 9);
        // Restarted with an earlier clock: its revisions start lower, and it is still the truth.
        sender.send(Update { snapshot: json!({"revision":3,"changeToken":"second.3.1","runners":[]}), ..Default::default() }).unwrap();
        poll(&mut state, 0.0, &mut Tx::default());
        assert_eq!(state.snapshot["revision"], 3);

        let mut synced = Synced { history: json!({"cursor":"first.2", "revision":9, "laps":[1]}), ..Default::default() };
        assert_eq!(synced.take_history(json!({"cursor":"first.1","revision":8,"laps":[]})), Some(Default::default()));
        let restarted = json!({"cursor":"second.1","revision":3,"laps":[]});
        let delivery = synced.take_history(restarted.clone()).unwrap();
        assert_eq!(delivery.body, restarted);
        // The screen takes it too, over the history of the earlier run it holds.
        let mut held = json!({"cursor":"first.2","revision":9,"laps":[1]});
        let (mut sequence, mut pending) = (delivery.sequence - 1, Vec::new());
        let mut index = history_sync::Index::new(&held);
        let mut version = 0;
        assert_eq!(history_delivery::apply(&mut held, &mut sequence, &mut pending, &mut index, &mut version, delivery), Some(true));
        assert_eq!(held, restarted);
        assert_eq!(version, 1);
    }

    #[test]
    fn racing_history_deltas_request_a_full_recovery_instead_of_waiting_for_another_change() {
        let mut synced = Synced { history: json!({"cursor":"epoch.2", "revision":2}), ..Default::default() };
        assert_eq!(synced.take_history(json!({"delta":true,"since":"epoch.1","cursor":"epoch.3"})), None);
        assert_eq!(synced.take_history(json!({"delta":true,"since":"epoch.1","cursor":"epoch.2"})), Some(Default::default()));
        assert_eq!(synced.take_history(Value::Null), Some(Default::default()));
    }

    #[test]
    fn transport_updates_wake_immediately_and_partial_updates_keep_connectivity() {
        use std::sync::{Arc, Mutex, atomic::{AtomicUsize, Ordering}};
        let count = Arc::new(AtomicUsize::new(0));
        let called = count.clone();
        let (sender, receiver) = mpsc::channel();
        let updates = Updates { sender, wake: Arc::new(Mutex::new(Some(Arc::new(move || { called.fetch_add(1, Ordering::SeqCst); })))) };
        updates.send(Update { partial: true, recovery: json!({"available":true}), ..Default::default() }).unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 1);
        let mut state = init_with_url("http://127.0.0.1:0".into());
        state.connected = true;
        state.snapshot = json!({"revision":1});
        state.rx = receiver;
        poll(&mut state, 0.0, &mut Tx::default());
        assert!(state.connected);
        assert_eq!(state.snapshot["revision"], 1);
        assert_eq!(state.recovery["available"], true);
    }
    use rune::{Env, Runtime};
    use std::sync::{Arc, Mutex};
    #[test]
    fn native_transport_delivers_the_clock_with_the_first_snapshot() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (sampling, sampled) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let mut first_clock = true;
            for _ in 0..4 {
                let (mut socket, _) = listener.accept().unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut request = [0; 4096];
                let size = socket.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..size]);
                let body = if request.starts_with("GET /api/clock ") {
                    if std::mem::take(&mut first_clock) {
                        sampling.send(()).unwrap();
                        released.recv_timeout(Duration::from_secs(5)).unwrap();
                    }
                    json!({"serverNowMs":now()+60_000})
                } else if request.starts_with("GET /api/state?") {
                    json!({"revision":1,"stateHistory":{"scope":"full","cursor":"clock.1","laps":[],"events":[]}})
                } else { json!({}) }.to_string();
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        let (_commands, commands) = mpsc::channel();
        let (sender, receiver) = mpsc::channel();
        start_transport(url, commands, Updates { sender, wake: Arc::new(Mutex::new(None)) }, Default::default());
        sampled.recv_timeout(Duration::from_secs(5)).unwrap();
        let premature = receiver.try_recv();
        release.send(()).unwrap();
        assert!(matches!(premature, Err(mpsc::TryRecvError::Empty)));
        let update = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(update.snapshot["revision"], 1);
        assert!((59_000..=61_000).contains(&update.clock_offset.unwrap()));
        server.join().unwrap();
    }
    #[test]
    fn native_transport_repolls_unchanged_tokens_without_fetching_history() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut states = 0;
            while states < 3 {
                let (mut socket, _) = listener.accept().unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut request = [0; 4096];
                let size = socket.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..size]);
                let body = if request.starts_with("GET /api/state?") {
                    states += 1;
                    if states == 1 {
                        assert!(!request.contains("after="));
                        json!({"changeToken":"db.1","revision":1,"stateHistory":{"scope":"full","cursor":"history.1","laps":[],"events":[]}})
                    } else {
                        assert!(request.contains("after=db.1"), "{request}");
                        assert!(request.contains("since=history.1"), "{request}");
                        json!({"unchanged":true,"changeToken":"db.1"})
                    }
                } else if request.starts_with("GET /api/clock ") {
                    json!({"serverNowMs":now()})
                } else {
                    assert!(request.starts_with("GET /api/recovery "), "unexpected fetch: {request}");
                    json!({})
                }.to_string();
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        let (_commands, commands) = mpsc::channel();
        let (sender, receiver) = mpsc::channel();
        start_transport(url, commands, Updates { sender, wake: Arc::new(Mutex::new(None)) }, Default::default());
        let mut unchanged = 0;
        while unchanged < 2 {
            let update = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
            if update.snapshot["unchanged"] == true {
                unchanged += 1;
                assert_eq!(update.history, history_delivery::Delivery::default());
                assert!(update.images.is_empty());
            }
        }
        server.join().unwrap();
    }
    fn update(rt: &mut Runtime<State>, predicate: impl Fn(&State) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
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
    fn click(rt: &mut Runtime<State>, key: &str) {
        eprintln!(
            "click {key}, page={} confirm={:?}",
            rt.state.page,
            rt.state.confirm.as_ref().map(|c| &c.method)
        );
        rt.frame(1.0 / 60.0);
        let (x, y) = rt
            .find(key)
            .unwrap_or_else(|| panic!("Missing UI control {key}"));
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(1.0 / 60.0);
    }
    #[test]
    fn laps_panel_moves_a_late_press_and_moves_splits_and_deletes_laps_through_http() {
        let mut initial = crate::db::Db::open(std::path::Path::new(":memory:")).unwrap();
        let mut ids = Vec::new();
        for (number, name) in [("1", "Mitras"), ("2", "Wout"), ("3", "Zoë")] {
            ids.push(
                initial
                    .mutation("runners.create", &json!({"runnerNumber":number,"name":name}))
                    .unwrap()["id"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
            );
        }
        // Mitras runs 80 s, Wout 70 s; the fifth press came 4 s late.
        let start = 1_700_000_000_000_i64;
        let mut t = start;
        let mut lap_ids = Vec::new();
        for (i, (runner, ms)) in [(0, 80_000), (1, 70_000), (0, 80_000), (1, 70_000), (0, 84_000), (1, 66_000), (0, 80_000), (1, 70_000)]
            .into_iter()
            .enumerate()
        {
            let id = format!("lap-{i}");
            initial.exec("INSERT INTO laps(id,runner_id,lap_number,started_at,finished_at,duration_ms,source,created_at,labels_json) VALUES(?,?,0,?,?,?,'spacebar',?,'[]')",&[json!(id),json!(ids[runner]),json!(t),json!(t+ms),json!(ms),json!(t+ms)]).unwrap();
            lap_ids.push(id);
            t += ms;
        }
        initial.exec("UPDATE laps SET lap_number=(SELECT COUNT(*) FROM laps e WHERE e.runner_id=laps.runner_id AND e.started_at<=laps.started_at)", &[]).unwrap();
        let db = Arc::new(Mutex::new(initial));
        let socket = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = socket.local_addr().unwrap().port();
        drop(socket);
        let _host = crate::server::start(db.clone(), port).unwrap();
        let mut state = init_with_url(format!("http://127.0.0.1:{port}"));
        state.page = 8;
        state.admin_section = 2;
        let mut rt = Runtime::new(state, view, (1366.0, 1080.0), Env { system_dark: true, scale: 1.0 });
        rt.frame(0.0);
        update(&mut rt, |s| s.connected && laps(s).len() == 8);
        let duration = |id: &str| {
            db.lock().unwrap().rows("SELECT duration_ms AS d FROM laps WHERE id=?", &[json!(id)]).unwrap()[0]["d"].as_i64().unwrap()
        };
        // The seam row between the two laps of the late press opens the press, and the hint fixes it.
        click(&mut rt, "lap-seam-lap-4");
        assert!(rt.find("press-hint").is_some(), "the late press must offer its fix");
        click(&mut rt, "press-hint");
        assert_eq!(rt.state.laps_shift(), -4_000);
        click(&mut rt, "press-move");
        update(&mut rt, |s| !s.busy && s.notice.starts_with("Wissel van #1 Mitras naar #2 Wout 4 s vroeger"));
        assert_eq!((duration("lap-4"), duration("lap-5")), (80_000, 70_000));
        // Nudging is bounded: the newest lap's press has no lap after it and nobody running, so no press is offered.
        click(&mut rt, "lap-open-lap-7");
        assert!(rt.find("press-move").is_some(), "the press before the newest lap can still move");
        // Move the newest lap to Zoë through the picker, searching without accents.
        click(&mut rt, "lap-fix-move");
        click(&mut rt, "lap-picker-search");
        rt.paste("zoe");
        rt.frame(1.0 / 60.0);
        rt.key(rune::Key::Enter.into());
        update(&mut rt, |s| !s.busy && s.notice.contains("staat nu op #3 Zoë"));
        let owner = |id: &str| db.lock().unwrap().rows("SELECT runner_id AS r FROM laps WHERE id=?", &[json!(id)]).unwrap()[0]["r"].clone();
        assert_eq!(owner("lap-7"), json!(ids[2]));
        // Split the oldest lap: the same runner starts selected.
        click(&mut rt, "lap-open-lap-0");
        click(&mut rt, "lap-fix-split");
        click(&mut rt, "lap-picker-apply");
        update(&mut rt, |s| !s.busy && laps(s).len() == 9);
        assert_eq!(duration("lap-0"), 40_000);
        // Delete asks first; cancelling keeps the lap.
        click(&mut rt, "lap-open-lap-6");
        click(&mut rt, "lap-fix-delete");
        assert_eq!(rt.state.confirm.as_ref().map(|c| c.method.as_str()), Some("laps.delete"));
        click(&mut rt, "cancel");
        click(&mut rt, "lap-fix-delete");
        click(&mut rt, "confirm");
        update(&mut rt, |s| !s.busy && laps(s).len() == 8);
        assert!(db.lock().unwrap().rows("SELECT id FROM laps WHERE id='lap-6'", &[]).unwrap().is_empty());
        let summaries: Vec<String> = db
            .lock()
            .unwrap()
            .rows("SELECT summary FROM activity_log ORDER BY occurred_at", &[])
            .unwrap()
            .into_iter()
            .map(|r| r["summary"].as_str().unwrap().to_owned())
            .collect();
        assert!(summaries.len() >= 4, "{summaries:?}");
    }
    #[test]
    fn public_controls_and_activity_filters_save_and_show_the_correct_origin() {
        let mut initial = crate::db::Db::open(std::path::Path::new(":memory:")).unwrap();
        let rid = initial
            .mutation("runners.create", &json!({"name":"Zoë"}))
            .unwrap()["id"]
            .clone();
        initial
            .mutation("runners.setStatus", &json!({"id":rid,"status":"waiting"}))
            .unwrap();
        let db = Arc::new(Mutex::new(initial));
        let socket = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = socket.local_addr().unwrap().port();
        drop(socket);
        let _host = crate::server::start(db.clone(), port).unwrap();
        let mut state = init_with_url(format!("http://127.0.0.1:{port}"));
        state.page = 8;
        state.admin_section = 4;
        let mut rt = Runtime::new(
            state,
            view,
            (1366.0, 768.0),
            Env {
                system_dark: true,
                scale: 1.0,
            },
        );
        rt.frame(0.0);
        update(&mut rt, |s| s.connected);
        click(&mut rt, "record-hour");
        update(&mut rt, |s| {
            !s.busy && s.snapshot["settings"]["publicRecordMode"] == "hour"
        });
        assert!(
            db.lock()
                .unwrap()
                .activity(&json!({}))
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .any(
                    |a| a["summary"] == "Records op de publieke schermen: per uur"
                        && a["origin"]
                            .as_str()
                            .unwrap()
                            .starts_with("Beheer · laptop ")
                )
        );
        click(&mut rt, "burgie");
        update(&mut rt, |s| {
            !s.busy && s.history["events"].as_array().is_some_and(|a| a.len() == 1)
        });
        click(&mut rt, "burgie");
        update(&mut rt, |s| !s.busy);
        assert_eq!(
            db.lock()
                .unwrap()
                .rows("SELECT id FROM race_events", &[])
                .unwrap()
                .len(),
            1
        );
        click(&mut rt, "admin-tab-5");
        update(&mut rt, |s| {
            !s.busy && s.activity_revision == s.snapshot["revision"].as_i64().unwrap()
        });
        assert!(
            !rt.state
                .activity
                .iter()
                .any(|a| a["action"] == "runners.setStatus")
        );
        click(&mut rt, "activity-queue");
        update(&mut rt, |s| {
            !s.busy
                && s.activity_queue
                && s.activity
                    .iter()
                    .any(|a| a["action"] == "runners.setStatus")
        });
        click(&mut rt, "activity-search");
        rt.paste("Zoe");
        update(&mut rt, |s| !s.busy && s.activity_filter == "true|Zoe");
        assert_eq!(rt.state.activity.len(), 2);
        assert!(
            rt.state
                .activity
                .iter()
                .all(|a| a["summary"].as_str().unwrap().contains("Zoë"))
        );
    }
    #[test]
    fn runners_section_shows_each_runners_available_hours() {
        let mut initial = crate::db::Db::open(std::path::Path::new(":memory:")).unwrap();
        let id = initial.mutation("runners.create", &json!({"runnerNumber":"5","name":"Uren Loper"})).unwrap()["id"].as_str().unwrap().to_owned();
        let mut registration = json!({"availableHours":["20-21u (dinsdag)","21-22u (dinsdag)","00-01u (woensdag)"],"categories":[]});
        for key in ["submittedAt","email","phone","studyPhase","estimatedLaps","estimatedPace","maxLapsPerBlock","reuseConsent","flexibility","remarks"] {
            registration[key] = json!("");
        }
        initial.exec("UPDATE runners SET registration_json=? WHERE id=?", &[json!(registration.to_string()), json!(id)]).unwrap();
        let db = Arc::new(Mutex::new(initial));
        let socket = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = socket.local_addr().unwrap().port();
        drop(socket);
        let _host = crate::server::start(db.clone(), port).unwrap();
        let mut state = init_with_url(format!("http://127.0.0.1:{port}"));
        state.page = 8;
        state.admin_section = 1;
        let mut rt = Runtime::new(state, view, (1366.0, 1080.0), Env { system_dark: false, scale: 1.0 });
        rt.frame(0.0);
        update(&mut rt, |s| s.connected && !s.busy && s.admin.registrations[&id].is_object());
        // Keep polling: later snapshots must not lose the hours again.
        for _ in 0..60 {
            rt.update_if(|state, tx| poll(state, 0.0, tx));
            rt.frame(1.0 / 60.0);
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(rt.find(&format!("runner-hours-{id}")).is_some(), "the hours strip must show");
        assert!(rt.state.admin.registrations[&id].is_object());
    }
    #[test]
    fn empty_laptop_can_link_a_discovered_laptop_from_overview() {
        let mut state = init_with_url("http://127.0.0.1:1".into());
        state.fixture = true;
        let url = "http://192.0.2.2:5173";
        state.snapshot = json!({
            "runners": [],
            "cluster": {
                "enabled": true,
                "members": [{}],
                "nearby": [{"name":"Timing", "url": url, "runners":15, "laptops":1, "compatible":true}]
            }
        });
        let mut rt = Runtime::new(
            state,
            view,
            (1366.0, 768.0),
            Env { system_dark: false, scale: 1.0 },
        );
        click(&mut rt, &format!("cluster-join-{url}"));
        let confirmation = rt.state.confirm.as_ref().unwrap();
        assert_eq!(confirmation.method, "cluster.joinGroup");
        assert_eq!(confirmation.input["url"], url);
        rt.update(|s, _| s.confirm = None);
        click(&mut rt, "welcome-system");
        assert_eq!(rt.state.page, 0);
        rt.paste(url);
        click(&mut rt, "cluster-manual-join");
        let confirmation = rt.state.confirm.as_ref().unwrap();
        assert_eq!(confirmation.method, "cluster.joinGroup");
        assert_eq!(confirmation.input["url"], url);
        rt.update(|s, _| s.confirm = None);
        click(&mut rt, "welcome-import");
        assert_eq!((rt.state.page, rt.state.admin_section), (8, 0));
    }
    #[test]
    fn readiness_counts_registrations_and_local_screens() {
        let mut state = init_with_url("http://127.0.0.1:1".into());
        state.fixture = true;
        state.connected = true;
        state.clock = 1000;
        state.recovery = json!({"status":{"enabled":true,"latest":{"createdAt":1000},"diskFreeBytes":1000000000}});
        state.snapshot = json!({"runners":[],"screens":[],"cluster":{"enabled":true,"state":"healthy","members":[{"reachable":true},{"reachable":true},{"reachable":true}]}});
        let checks = readiness::checks(&state);
        assert_eq!(
            checks
                .iter()
                .find(|c| c.id == "registrations")
                .unwrap()
                .level,
            readiness::Level::Blocked
        );
        assert_eq!(
            checks.iter().find(|c| c.id == "screens").unwrap().level,
            readiness::Level::Info
        );
        state.snapshot["runners"] = json!([{"id":"runner"}]);
        assert!(!readiness::needs_attention(&state));
        let checks = readiness::checks(&state);
        assert_eq!(readiness::summary(&checks), readiness::Level::Ready);
        assert_eq!(readiness::open_count(&checks), 0);
        assert_eq!(checks.last().unwrap().id, "screens");
        assert_eq!(checks.last().unwrap().level, readiness::Level::Info);
        state.snapshot["screens"] =
            json!([{"kind":"outside","address":"192.168.88.20"}]);
        let checks = readiness::checks(&state);
        let screens = checks.iter().find(|c| c.id == "screens").unwrap();
        assert_eq!(screens.level, readiness::Level::Ready);
        assert_eq!(readiness::summary(&checks), readiness::Level::Ready);
        assert_eq!(readiness::open_count(&checks), 0);
        assert!(screens.detail.contains("Buitenscherm (192.168.88.20)"));
        assert_eq!(
            checks
                .iter()
                .find(|c| c.id == "registrations")
                .unwrap()
                .level,
            readiness::Level::Ready
        );
        state.connected = false;
        let offline = readiness::checks(&state);
        assert_eq!(offline.len(), 1);
        assert_eq!(offline[0].id, "server-status");
        assert_eq!(readiness::open_count(&offline), 1);
        assert_eq!(readiness::summary(&offline), readiness::Level::Blocked);
    }
    #[test]
    fn a_press_while_another_action_is_on_its_way_is_kept_with_its_own_time() {
        let mut initial = crate::db::Db::open(std::path::Path::new(":memory:")).unwrap();
        for (number, name) in [("1", "Eerste"), ("2", "Tweede"), ("3", "Derde")] {
            initial.mutation("runners.create", &json!({"runnerNumber":number,"name":name,"status":"waiting"})).unwrap();
        }
        initial
            .mutation("race.handoff", &json!({"activeRunnerId":null,"activeStartedAt":null,"pressedAt":now()}))
            .unwrap();
        let started = now() - 60_000;
        initial.exec("UPDATE race_state SET active_started_at=?,race_started_at=? WHERE id=1", &[json!(started), json!(started)]).unwrap();
        let db = Arc::new(Mutex::new(initial));
        let socket = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = socket.local_addr().unwrap().port();
        drop(socket);
        let _host = crate::server::start(db.clone(), port).unwrap();
        let mut state = init_with_url(format!("http://127.0.0.1:{port}"));
        state.page = 2;
        let mut rt = Runtime::new(state, view, (1366.0, 1080.0), Env { system_dark: false, scale: 1.0 });
        rt.on_key = Some(on_key);
        rt.frame(0.0);
        update(&mut rt, |s| s.connected && !s.snapshot["race"]["activeRunnerId"].is_null());
        rt.update_if(|s, _| {
            s.send("events.burgieGepakt", json!({}));
            true
        });
        assert!(rt.state.busy, "Burgie gepakt is on its way");
        let pressed = rt.state.server_now();
        let shown = timing_page::waiting(&rt.state)[0]["id"].as_str().unwrap().to_string();
        rt.key(rune::Key::Text(" ".into()).into());
        // The queue desk moves the other runner to the front while the press waits.
        let other = timing_page::waiting(&rt.state)[1]["id"].as_str().unwrap().to_string();
        db.lock().unwrap().mutation("runners.reorder", &json!({"ids":[other, shown]})).unwrap();
        rt.frame(1.0 / 60.0);
        std::thread::sleep(Duration::from_millis(300));
        update(&mut rt, |s| !s.busy && s.history["laps"].as_array().is_some_and(|l| l.len() == 1));
        let lap = db.lock().unwrap().rows("SELECT duration_ms FROM laps", &[]).unwrap();
        assert_eq!(lap.len(), 1, "The press is sent once the other action is done");
        let duration = lap[0]["duration_ms"].as_i64().unwrap();
        assert!((duration - (pressed - started)).abs() < 100, "The lap ends at the press, not when it was sent: {duration}");
        assert!(rt.state.timing_page.error.is_empty());
        assert_eq!(db.lock().unwrap().race().unwrap()["activeRunnerId"], shown, "The runner shown at the press starts");
        let (at, _) = rt.state.last_press.unwrap();
        let since_press = rt.state.server_now() - pressed;
        assert!((at.elapsed().as_millis() as i64 - since_press).abs() < 100, "The next lap counts from the press");
    }
    #[test]
    fn space_records_one_lap_and_guards_an_immediate_second_press() {
        let mut initial = crate::db::Db::open(std::path::Path::new(":memory:")).unwrap();
        for (number, name) in [("1", "Eerste"), ("2", "Tweede")] {
            initial.mutation("runners.create", &json!({"runnerNumber":number,"name":name,"status":"waiting"})).unwrap();
        }
        initial
            .mutation("race.handoff", &json!({"activeRunnerId":null,"activeStartedAt":null,"pressedAt":now()}))
            .unwrap();
        // The first runner has been out for a minute: the next press is a real lap.
        let started = now() - 60_000;
        initial.exec("UPDATE race_state SET active_started_at=?,race_started_at=? WHERE id=1", &[json!(started), json!(started)]).unwrap();
        let db = Arc::new(Mutex::new(initial));
        let socket = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = socket.local_addr().unwrap().port();
        drop(socket);
        let _host = crate::server::start(db.clone(), port).unwrap();
        let mut state = init_with_url(format!("http://127.0.0.1:{port}"));
        state.page = 2;
        let mut rt = Runtime::new(state, view, (1366.0, 1080.0), Env { system_dark: false, scale: 1.0 });
        rt.on_key = Some(on_key);
        rt.frame(0.0);
        update(&mut rt, |s| s.connected && !s.snapshot["race"]["activeRunnerId"].is_null());
        let laps = || db.lock().unwrap().rows("SELECT id FROM laps", &[]).unwrap().len();
        assert_eq!(laps(), 0);
        assert_eq!(timing_page::race_lap_total(&rt.state), 0);
        rt.key(rune::Key::Text(" ".into()).into());
        rt.frame(1.0 / 60.0);
        assert!(rt.state.busy, "Space on Timing sends the handoff");
        update(&mut rt, |s| !s.busy && s.history["laps"].as_array().is_some_and(|l| l.len() == 1));
        assert_eq!(laps(), 1, "Space on Timing clocks the runner off");
        assert_eq!(timing_page::race_lap_total(&rt.state), 1);

        rt.key(rune::Key::Text(" ".into()).into());
        rt.frame(1.0 / 60.0);
        assert!(rt.find("timing-dialog-overlay").is_some(), "A second press asks before saving a short lap");
        assert!(!rt.state.busy, "No second handoff is sent");
        click(&mut rt, "timing-cancel");
        assert!(rt.state.timing_page.dialog.is_none());
        assert_eq!(laps(), 1);
        assert_eq!(timing_page::race_lap_total(&rt.state), 1);
    }
    #[test]
    fn errors_can_be_dismissed_and_do_not_follow_navigation() {
        let mut state = init_with_url("http://127.0.0.1:1".into());
        state.fixture = true;
        state.page = 8;
        state.page_seen = state.page;
        state.error = "no XDG desktop portal FileChooser is available".into();
        let mut rt = Runtime::new(state, view, (1366.0, 768.0), Env { system_dark: false, scale: 1.0 });
        rt.frame(0.0);
        click(&mut rt, "error-dismiss");
        assert!(rt.state.error.is_empty());
        assert!(rt.find("error-dismiss").is_none());
        rt.update(|s, _| s.error = "Picker failed".into());
        click(&mut rt, "nav-2");
        rt.update(|s, tx| { poll(s, 0.0, tx); });
        assert!(rt.state.error.is_empty());
        rt.state.error = "Picker failed".into();
        apply_route(&mut rt.state, "/queue");
        rt.update(|s, tx| { poll(s, 0.0, tx); });
        assert!(rt.state.error.is_empty());
        rt.update(|s, tx| {
            s.page = 0;
            s.welcome_skipped = true;
            poll(s, 0.0, tx);
            s.error = "Picker failed".into();
        });
        click(&mut rt, "overview-ready");
        rt.update(|s, tx| { poll(s, 0.0, tx); });
        assert_eq!(rt.state.page, 1);
        assert!(rt.state.error.is_empty());
        rt.update(|s, tx| {
            s.page = 0;
            s.error = "Old error".into();
            s.file_tx.send(Err("New picker error".into())).unwrap();
            s.fixture = false;
            poll(s, 0.0, tx);
            s.fixture = true;
        });
        assert_eq!(rt.state.error, "New picker error");
        rt.update(|s, tx| { poll(s, 0.0, tx); });
        assert_eq!(rt.state.error, "New picker error");
    }
    #[test]
    fn space_presses_a_tab_focused_button_outside_timing() {
        let mut initial = crate::db::Db::open(std::path::Path::new(":memory:")).unwrap();
        let id = initial.mutation("runners.create", &json!({"runnerNumber":"5","name":"Tab Loper"})).unwrap()["id"].as_str().unwrap().to_owned();
        let db = Arc::new(Mutex::new(initial));
        let socket = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = socket.local_addr().unwrap().port();
        drop(socket);
        let _host = crate::server::start(db.clone(), port).unwrap();
        let mut state = init_with_url(format!("http://127.0.0.1:{port}"));
        state.page = 8;
        state.admin_section = 1;
        let mut rt = Runtime::new(state, view, (1366.0, 1080.0), Env { system_dark: false, scale: 1.0 });
        rt.on_key = Some(on_key);
        rt.frame(0.0);
        update(&mut rt, |s| s.connected && !s.busy && s.admin.registrations.is_object());
        let target = format!("delete-{id}");
        for _ in 0..80 {
            if rt.state.admin.focused.as_deref() == Some(target.as_str()) {
                break;
            }
            rt.key(rune::Key::Tab.into());
            rt.frame(1.0 / 60.0);
            rt.update_if(|state, tx| poll(state, 0.0, tx));
            rt.frame(1.0 / 60.0);
        }
        assert_eq!(rt.state.admin.focused.as_deref(), Some(target.as_str()), "Tab reaches Verwijder");
        rt.key(rune::Key::Text(" ".into()).into());
        rt.frame(1.0 / 60.0);
        assert!(rt.state.admin.confirm.is_some(), "Space on the focused Verwijder asks to confirm");
        rt.state.admin.confirm = None;
        rt.frame(1.0 / 60.0);
        rt.update_if(|state, tx| poll(state, 0.0, tx));
        rt.frame(1.0 / 60.0);
        rt.key(rune::Key::Enter.into());
        rt.frame(1.0 / 60.0);
        assert!(rt.state.admin.confirm.is_some(), "Enter on the focused Verwijder asks to confirm");
    }
    #[test]
    fn runners_section_searches_unhides_and_deletes_a_runner_after_confirming() {
        let mut initial = crate::db::Db::open(std::path::Path::new(":memory:")).unwrap();
        let mut make = |number: &str, name: &str| {
            initial.mutation("runners.create", &json!({"runnerNumber":number,"name":name})).unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        let (keep, gone) = (make("7", "Hidden Runner"), make("8", "Removable Runner"));
        initial.exec("UPDATE runners SET hidden_at=1 WHERE id=?", &[json!(keep)]).unwrap();
        let db = Arc::new(Mutex::new(initial));
        let socket = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = socket.local_addr().unwrap().port();
        drop(socket);
        let _host = crate::server::start(db.clone(), port).unwrap();
        let mut state = init_with_url(format!("http://127.0.0.1:{port}"));
        state.page = 8;
        state.admin_section = 1;
        let mut rt = Runtime::new(state, view, (1366.0, 1080.0), Env { system_dark: false, scale: 1.0 });
        rt.frame(0.0);
        update(&mut rt, |s| s.connected && !s.busy);
        // Search narrows the table to one runner, without accents or case.
        click(&mut rt, "admin-runner-search");
        rt.paste("removable");
        rt.frame(1.0 / 60.0);
        assert!(rt.find(&format!("runner-row-{gone}")).is_some());
        assert!(rt.find(&format!("runner-row-{keep}")).is_none());
        // Keyboard: Tab reaches Verwijder in the row and shows while it has focus.
        let target = format!("delete-{gone}");
        for _ in 0..8 {
            if rt.state.admin.focused.as_deref() == Some(target.as_str()) {
                break;
            }
            rt.key(rune::Key::Tab.into());
            rt.update_if(|state, tx| poll(state, 0.0, tx));
            rt.frame(1.0 / 60.0);
        }
        assert_eq!(rt.state.admin.focused.as_deref(), Some(target.as_str()));
        // Unhovered, the button only takes a click once focus has made it visible.
        click(&mut rt, &target);
        assert!(rt.state.admin.confirm.is_some(), "the focused Verwijder shows and asks first");
        click(&mut rt, "admin-confirm-cancel");
        // Verwijder shows on hover and asks first; Annuleer keeps the runner.
        let (x, y) = rt.find(&format!("delete-{gone}")).unwrap();
        rt.pointer_move(x, y);
        rt.frame(1.0 / 60.0);
        click(&mut rt, &format!("delete-{gone}"));
        assert_eq!(rt.state.admin.confirm.as_ref().map(|c| c.title.as_str()), Some("Removable Runner definitief verwijderen?"));
        click(&mut rt, "admin-confirm-cancel");
        assert!(rt.state.admin.confirm.is_none());
        click(&mut rt, &format!("delete-{gone}"));
        click(&mut rt, "admin-confirm-ok");
        update(&mut rt, |s| !s.busy && s.admin.toast.as_ref().is_some_and(|t| t.text == "Removable Runner is definitief verwijderd."));
        assert!(db.lock().unwrap().rows("SELECT id FROM runners WHERE id=?", &[json!(gone)]).unwrap().is_empty());
        // A hidden runner offers Terug tonen, which clears hidden_at.
        click(&mut rt, "admin-runner-search");
        for _ in 0.."removable".len() {
            rt.key(rune::Key::Backspace.into());
        }
        rt.frame(1.0 / 60.0);
        assert_eq!(rt.state.admin.runners.query.text, "");
        click(&mut rt, &format!("unhide-{keep}"));
        update(&mut rt, |s| !s.busy && s.admin.toast.as_ref().is_some_and(|t| t.text == "Hidden Runner is terug zichtbaar."));
        assert!(db.lock().unwrap().rows("SELECT hidden_at AS h FROM runners WHERE id=?", &[json!(keep)]).unwrap()[0]["h"].is_null());
    }
    #[test]
    fn label_controls_upload_a_logo_assign_a_runner_and_confirm_deletion() {
        let mut initial = crate::db::Db::open(std::path::Path::new(":memory:")).unwrap();
        initial.exec("DELETE FROM labels", &[]).unwrap();
        let rid = initial
            .mutation("runners.create", &json!({"name":"Label Runner"}))
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let db = Arc::new(Mutex::new(initial));
        let socket = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = socket.local_addr().unwrap().port();
        drop(socket);
        let _host = crate::server::start(db.clone(), port).unwrap();
        let mut state = init_with_url(format!("http://127.0.0.1:{port}"));
        state.page = 8;
        state.admin_section = 3;
        let mut rt = Runtime::new(
            state,
            view,
            (1366.0, 1080.0),
            Env {
                system_dark: true,
                scale: 1.0,
            },
        );
        rt.frame(0.0);
        update(&mut rt, |s| s.connected && !s.busy);
        click(&mut rt, "label-name");
        rt.paste("Native label");
        // The kind select opens its options; Speedteam is the first.
        click(&mut rt, "label-kind");
        click(&mut rt, "label-kind-option-0");
        assert!(rt.state.admin.select.is_none());
        click(&mut rt, "label-logo");
        rt.resolve_file_dialog(Some(
            std::env::current_dir()
                .unwrap()
                .parent()
                .unwrap()
                .join("public/labels/hilok.png"),
        ))
        .unwrap();
        rt.frame(1.0 / 60.0);
        update(&mut rt, |s| !s.busy && s.label_form.has_new_image());
        click(&mut rt, "label-save");
        update(&mut rt, |s| {
            !s.busy
                && s.snapshot["labels"]
                    .as_array()
                    .is_some_and(|a| a.len() == 1)
        });
        assert_eq!(rt.state.admin.toast.as_ref().unwrap().text, "Native label is toegevoegd.");
        let labels = db.lock().unwrap().labels(None).unwrap();
        assert_eq!(labels[0]["name"], "Native label");
        assert_eq!(labels[0]["kind"], "speedteam");
        assert_eq!(labels[0]["icon"], "NA");
        let id = labels[0]["id"].as_str().unwrap().to_owned();
        let image_url = labels[0]["imageUrl"].as_str().unwrap();
        assert!(image_url.starts_with("/api/label-images/"));
        let response =
            reqwest::blocking::get(format!("http://127.0.0.1:{port}{image_url}")).unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["content-type"], "image/png");
        assert!(!response.bytes().unwrap().is_empty());
        // Weg takes the logo off the label.
        click(&mut rt, &format!("label-{id}-logo-clear"));
        update(&mut rt, |s| !s.busy && s.snapshot["labels"][0]["imageUrl"].is_null());
        // The member count opens who is in the label; typing finds the runner, Enter adds them.
        click(&mut rt, &format!("label-count-{id}"));
        click(&mut rt, &format!("label-members-search-{id}"));
        rt.paste("label run");
        rt.frame(1.0 / 60.0);
        assert!(rt.find(&format!("label-member-{rid}")).is_some(), "the match is offered");
        rt.key(rune::Key::Enter.into());
        update(&mut rt, |s| {
            !s.busy
                && s.snapshot["runners"][0]["labels"]
                    .as_array()
                    .is_some_and(|a| a.len() == 1)
        });
        assert_eq!(
            db.lock().unwrap().runner(&rid).unwrap()["labels"][0]["id"],
            id.as_str()
        );
        assert_eq!(rt.state.admin.toast.as_ref().unwrap().text, "Label Runner zit nu in Native label.");
        // The × takes them out again.
        click(&mut rt, &format!("label-member-remove-{rid}"));
        update(&mut rt, |s| !s.busy && s.snapshot["runners"][0]["labels"].as_array().is_some_and(|a| a.is_empty()));
        click(&mut rt, &format!("label-members-search-{id}"));
        rt.paste("label");
        rt.frame(1.0 / 60.0);
        click(&mut rt, &format!("label-member-{rid}"));
        update(&mut rt, |s| !s.busy && s.snapshot["runners"][0]["labels"].as_array().is_some_and(|a| a.len() == 1));
        click(&mut rt, &format!("delete-label-{id}"));
        assert_eq!(rt.state.admin.confirm.as_ref().unwrap().title, "Label Native label verwijderen?");
        click(&mut rt, "admin-confirm-cancel");
        assert_eq!(db.lock().unwrap().labels(None).unwrap().len(), 1);
        click(&mut rt, &format!("delete-label-{id}"));
        click(&mut rt, "admin-confirm-ok");
        update(&mut rt, |s| {
            !s.busy
                && s.snapshot["labels"]
                    .as_array()
                    .is_some_and(|a| a.is_empty())
        });
        assert!(
            db.lock().unwrap().runner(&rid).unwrap()["labels"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn runner_editor_creates_and_updates_contact_labels_and_historical_times() {
        let db = Arc::new(Mutex::new(
            crate::db::Db::open(std::path::Path::new(":memory:")).unwrap(),
        ));
        let socket = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = socket.local_addr().unwrap().port();
        drop(socket);
        let _host = crate::server::start(db.clone(), port).unwrap();
        let mut state = init_with_url(format!("http://127.0.0.1:{port}"));
        state.page = 8;
        state.admin_section = 1;
        let mut rt = Runtime::new(
            state,
            view,
            (1366.0, 1080.0),
            Env {
                system_dark: true,
                scale: 1.0,
            },
        );
        rt.frame(0.0);
        update(&mut rt, |s| s.connected && !s.busy);
        // Nieuwe loper opens the same dialog as in Wachtrij, but the runner is only registered.
        click(&mut rt, "new-runner");
        rt.paste("18");
        rt.frame(1.0 / 60.0);
        click(&mut rt, "add-name");
        rt.paste("Zoë Native");
        click(&mut rt, "add-contact");
        rt.frame(0.2);
        click(&mut rt, "add-email");
        assert!(rt.elements().iter().any(|el| el.key.as_deref() == Some("add-email") && el.focused));
        rt.paste("zoe@example.be");
        click(&mut rt, "add-phone");
        rt.paste("0471");
        click(&mut rt, "add-hour-dinsdag-20");
        click(&mut rt, "add-hour-dinsdag-22");
        // The hour grid makes the dialog taller: scroll Extra gegevens into view first.
        rt.wheel(700.0, 670.0, -300.0);
        rt.frame(0.2);
        click(&mut rt, "add-extra");
        rt.wheel(700.0, 670.0, -450.0);
        rt.frame(0.2);
        click(&mut rt, "add-avg-min");
        rt.paste("1");
        click(&mut rt, "add-avg-sec");
        rt.paste("20");
        click(&mut rt, "add-notes");
        rt.paste("Operatornote");
        click(&mut rt, "add-save");
        update(&mut rt, |s| !s.busy && s.admin.toast.is_some());
        assert_eq!(rt.state.admin.toast.as_ref().unwrap().text, "Zoë Native toegevoegd.");
        let runners = db.lock().unwrap().runners().unwrap();
        assert_eq!(runners.len(), 1);
        let rid = runners[0]["id"].as_str().unwrap().to_owned();
        assert_eq!(runners[0]["name"], "Zoë Native");
        assert_eq!(runners[0]["runnerNumber"], "18");
        assert_eq!(runners[0]["historicalAvgMs"], 80000);
        assert_eq!(runners[0]["status"], "registered");
        let registrations = db.lock().unwrap().registrations().unwrap();
        assert_eq!(registrations[&rid]["email"], "zoe@example.be");
        // The table shows the hours as a stretch, and the name opens the profile.
        update(&mut rt, |s| s.admin.registrations[&rid].is_object());
        click(&mut rt, &format!("profile-{rid}"));
        assert!(rt.state.profile.is_some());
        // Select the hour near the top, then scroll down to the notes and save button.
        click(&mut rt, "profile-hour-woensdag-0");
        rt.wheel(700.0, 670.0, -550.0);
        rt.frame(0.2);
        click(&mut rt, "profile-notes");
        rt.paste(" updated");
        click(&mut rt, "profile-save");
        update(&mut rt, |s| !s.busy && s.profile.is_none());
        assert!(
            db.lock().unwrap().runner(&rid).unwrap()["notes"]
                .as_str()
                .unwrap()
                .contains("updated")
        );
        let registration = db.lock().unwrap().registrations().unwrap()[&rid].clone();
        assert_eq!(registration["email"], "zoe@example.be");
        assert_eq!(
            registration["availableHours"],
            json!(["20-21u (dinsdag)", "22-23u (dinsdag)", "00-01u (woensdag)"])
        );
        // Closing with unsaved edits asks first; Niet opslaan drops them.
        click(&mut rt, &format!("profile-{rid}"));
        rt.wheel(700.0, 670.0, 900.0);
        rt.frame(0.2);
        click(&mut rt, "profile-name");
        assert!(rt.elements().iter().any(|el| el.key.as_deref() == Some("profile-name") && el.focused),
            "profile-name at {:?}", rt.find("profile-name"));
        rt.paste(" X");
        rt.frame(0.2);
        click(&mut rt, "profile-close");
        assert!(rt.find("profile-discard").is_some(), "unsaved edits ask before closing");
        click(&mut rt, "profile-discard");
        assert!(rt.state.profile.is_none());
        // Opwarmen from the profile, then Uit opwarmen halen after a confirmation.
        click(&mut rt, &format!("profile-{rid}"));
        click(&mut rt, "profile-queue-action");
        update(&mut rt, |s| !s.busy && s.snapshot["runners"][0]["status"] == "warming_up");
        click(&mut rt, "profile-queue-action");
        click(&mut rt, "admin-confirm-ok");
        update(&mut rt, |s| !s.busy && s.snapshot["runners"][0]["status"] == "registered");
        click(&mut rt, "profile-close");
        // Verwijder asks, then deletes the runner without laps.
        click(&mut rt, &format!("delete-{rid}"));
        assert_eq!(rt.state.admin.confirm.as_ref().unwrap().title, "Zoë Native definitief verwijderen?");
        click(&mut rt, "admin-confirm-ok");
        update(&mut rt, |s| !s.busy && super::runners(s).is_empty());
        assert!(db.lock().unwrap().runners().unwrap().is_empty());
    }

    fn queue_contact_profile() -> (Runtime<State>, Arc<Mutex<crate::db::Db>>, String, crate::server::ServerHandle) {
        let mut db = crate::db::Db::open(std::path::Path::new(":memory:")).unwrap();
        let id = db.mutation("runners.create", &json!({"name":"Queue contact","status":"waiting"})).unwrap()["id"].as_str().unwrap().to_owned();
        db.mutation("runners.update", &json!({"id":id,"fields":{"registrationDetails":{"phone":"0471","email":"queue@example.be","availableHours":["20-21u (dinsdag)"]}}})).unwrap();
        let db = Arc::new(Mutex::new(db));
        let socket = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = socket.local_addr().unwrap().port();
        drop(socket);
        let host = crate::server::start(db.clone(), port).unwrap();
        let mut state = init_with_url(format!("http://127.0.0.1:{port}"));
        state.page = 1;
        let mut rt = Runtime::new(state, view, (1366.0, 1080.0), Env { system_dark:false, scale:1.0 });
        rt.frame(0.0);
        update(&mut rt, |s| s.connected && !s.busy);
        assert!(rt.state.admin.registrations.is_null());
        rt.update_if(|s, _| { s.send("runners.profile",json!({"id":id})); true });
        update(&mut rt, |s| !s.busy && s.profile.is_some());
        (rt, db, id, host)
    }

    #[test]
    fn queue_profile_save_preserves_fetched_contact_without_visiting_admin() {
        let (mut rt, db, id, _host) = queue_contact_profile();
        let before = db.lock().unwrap().registrations().unwrap()[&id].clone();
        assert_eq!(rt.state.admin.registrations[&id],before);
        db.lock().unwrap().mutation("runners.update", &json!({"id":id,"fields":{"registrationDetails":{"phone":"0472","email":"updated@example.be","availableHours":["21-22u (dinsdag)"]}}})).unwrap();
        update(&mut rt, |s| !s.busy && s.admin.registrations[&id]["email"] == "updated@example.be");
        let before = db.lock().unwrap().registrations().unwrap()[&id].clone();
        profile::follow_stored(&mut rt.state);
        click(&mut rt,"profile-name");
        rt.paste(" edited");
        rt.frame(0.2);
        rt.wheel(700.0,670.0,-900.0);
        rt.frame(0.2);
        click(&mut rt,"profile-save");
        update(&mut rt, |s| !s.busy && s.profile.is_none());
        assert_eq!(db.lock().unwrap().registrations().unwrap()[&id],before);
        assert_eq!(db.lock().unwrap().runner(&id).unwrap()["name"],"Queue contact edited");
    }
    #[test]
    fn queue_profile_remove_confirmation_cancels_then_removes_through_http() {
        let (mut rt, db, id, _host) = queue_contact_profile();
        click(&mut rt,"profile-queue-action");
        click(&mut rt,"admin-confirm-cancel");
        assert_eq!(db.lock().unwrap().runner(&id).unwrap()["status"],"waiting");
        assert!(rt.state.profile.is_some());
        click(&mut rt,"profile-queue-action");
        click(&mut rt,"admin-confirm-ok");
        update(&mut rt, |s| !s.busy && s.snapshot["runners"][0]["status"] == "registered");
        assert!(rt.state.admin.confirm.is_none());
        assert_eq!(db.lock().unwrap().runner(&id).unwrap()["status"],"registered");
    }

    #[test]
    fn queue_profile_latest_confirmation_cancels_then_loads_remote_contact() {
        let (mut rt, db, id, _host) = queue_contact_profile();
        click(&mut rt,"profile-name");
        rt.paste(" draft");
        rt.frame(0.2);
        db.lock().unwrap().mutation("runners.update", &json!({"id":id,"fields":{"name":"Remote contact","registrationDetails":{"email":"remote@example.be","phone":"0472","availableHours":["21-22u (dinsdag)"]}}})).unwrap();
        update(&mut rt, |s| !s.busy && s.admin.registrations[&id]["email"] == "remote@example.be");
        rt.wheel(700.0,670.0,-1600.0);
        rt.frame(0.2);
        click(&mut rt,"profile-load-latest");
        click(&mut rt,"admin-confirm-cancel");
        assert!(rt.state.profile.is_some());
        click(&mut rt,"profile-load-latest");
        click(&mut rt,"admin-confirm-ok");
        rt.wheel(700.0,670.0,1600.0);
        rt.frame(0.2);
        click(&mut rt,"profile-name");
        rt.paste(" saved");
        rt.frame(0.2);
        rt.wheel(700.0,670.0,-1600.0);
        rt.frame(0.2);
        click(&mut rt,"profile-save");
        update(&mut rt, |s| !s.busy && s.profile.is_none());
        assert_eq!(db.lock().unwrap().runner(&id).unwrap()["name"],"Remote contact saved");
        assert_eq!(db.lock().unwrap().registrations().unwrap()[&id]["email"],"remote@example.be");
    }

    #[test]
    fn file_picker_imports_and_reimports_through_the_real_http_server() {
        let path =
            std::env::temp_dir().join(format!("apolloon-import-{}.csv", uuid::Uuid::new_v4()));
        std::fs::write(
            &path,
            "nummer,naam,labels\n17,Zoë,Dames\n18,Jan,1ste jaar\n19,",
        )
        .unwrap();
        let db = Arc::new(Mutex::new(
            crate::db::Db::open(std::path::Path::new(":memory:")).unwrap(),
        ));
        let socket = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = socket.local_addr().unwrap().port();
        drop(socket);
        let _host = crate::server::start(db.clone(), port).unwrap();
        let mut state = init_with_url(format!("http://127.0.0.1:{port}"));
        state.page = 8;
        state.admin_section = 0;
        let mut rt = Runtime::new(
            state,
            view,
            (1366.0, 768.0),
            Env {
                system_dark: true,
                scale: 1.0,
            },
        );
        rt.frame(0.0);
        update(&mut rt, |s| s.connected);
        click(&mut rt, "choose-import");
        assert_eq!(rt.file_dialog().unwrap().0, rune::FileDialogKind::Open);
        rt.resolve_file_dialog(None).unwrap();
        rt.frame(1.0 / 60.0);
        assert!(rt.state.import_file.is_none());
        click(&mut rt, "choose-import");
        rt.resolve_file_dialog(Some(path.clone())).unwrap();
        rt.frame(1.0 / 60.0);
        update(&mut rt, |s| s.import_file.is_some());
        click(&mut rt, "import-runners");
        update(&mut rt, |s| !s.busy && s.admin.toast.as_ref().is_some_and(|t| t.text.contains("2 aangemaakt")));
        assert_eq!(db.lock().unwrap().runners().unwrap().len(), 2);
        assert_eq!(rt.state.import_problems.len(), 1);
        std::fs::write(&path, "nummer,naam\n17,Zoë Corrected\n18,Jan").unwrap();
        rt.update_if(|s, _| {
            s.import_file = None;
            true
        });
        click(&mut rt, "choose-import");
        rt.resolve_file_dialog(Some(path.clone())).unwrap();
        rt.frame(1.0 / 60.0);
        update(&mut rt, |s| s.import_file.is_some());
        click(&mut rt, "import-runners");
        update(&mut rt, |s| !s.busy && s.admin.toast.as_ref().is_some_and(|t| t.text.contains("2 bijgewerkt")));
        let runners = db.lock().unwrap().runners().unwrap();
        assert_eq!(runners.len(), 2);
        assert!(runners.iter().any(|r| r["name"] == "Zoë Corrected"));
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn native_buttons_record_confirm_and_undo_through_the_real_http_server() {
        let mut db = crate::db::Db::open(std::path::Path::new(":memory:")).unwrap();
        let a = db
            .mutation("runners.create", &json!({"name":"A","status":"waiting"}))
            .unwrap()["id"]
            .clone();
        let b = db
            .mutation("runners.create", &json!({"name":"B","status":"waiting"}))
            .unwrap()["id"]
            .clone();
        let socket = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = socket.local_addr().unwrap().port();
        drop(socket);
        let db = Arc::new(Mutex::new(db));
        let _host = crate::server::start(db.clone(), port).unwrap();
        let state = init_with_url(format!("http://127.0.0.1:{port}"));
        let mut rt = Runtime::new(
            state,
            view,
            (1366.0, 768.0),
            Env {
                system_dark: true,
                scale: 1.0,
            },
        );
        rt.frame(0.0);
        update(&mut rt, |s| s.connected);
        click(&mut rt, "nav-2");
        click(&mut rt, "handoff");
        update(&mut rt, |s| {
            !s.busy && s.snapshot["race"]["activeRunnerId"] == a
        });
        assert_eq!(db.lock().unwrap().race().unwrap()["activeRunnerId"], a);
        click(&mut rt, "handoff");
        assert!(matches!(rt.state.timing_page.dialog, Some(timing_page::Dialog::ShortLap(_))));
        assert!(
            db.lock().unwrap().history().unwrap()["laps"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        click(&mut rt, "timing-confirm");
        update(&mut rt, |s| {
            !s.busy && s.snapshot["race"]["activeRunnerId"] == b
        });
        assert_eq!(
            db.lock().unwrap().history().unwrap()["laps"][0]["runnerId"],
            a
        );
        click(&mut rt, "undo");
        click(&mut rt, "timing-cancel");
        rt.key(rune::Key::Enter.into());
        rt.frame(1.0 / 60.0);
        assert!(matches!(rt.state.timing_page.dialog, Some(timing_page::Dialog::ShortLap(_))));
        click(&mut rt, "timing-cancel");
        click(&mut rt, "undo");
        click(&mut rt, "timing-confirm");
        update(&mut rt, |s| {
            !s.busy && s.snapshot["race"]["activeRunnerId"] == a
        });
        assert!(
            db.lock().unwrap().history().unwrap()["laps"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        rt.key(rune::Key::Text(" ".into()).into());
        rt.frame(1.0 / 60.0);
        assert!(matches!(rt.state.timing_page.dialog, Some(timing_page::Dialog::ShortLap(_))));
    }
    fn scroll_to(rt: &mut Runtime<State>, key: &str) {
        for _ in 0..20 {
            rt.frame(1.0 / 60.0);
            if rt.find(key).is_some_and(|(_, y)| y > 60.0 && y < 720.0) {
                return;
            }
            rt.wheel(1100.0, 650.0, -160.0);
        }
        panic!("Could not scroll to {key}");
    }
    #[test]
    fn recovery_panel_creates_clears_previews_and_restores_through_http() {
        let root = std::env::temp_dir().join(format!("apolloon-native-ui-{}", crate::db::id()));
        let path = root.join("data/app.db");
        let mut database = crate::db::Db::open(&path).unwrap();
        database
            .mutation(
                "runners.create",
                &json!({"name":"Keep me","status":"waiting"}),
            )
            .unwrap();
        let db = Arc::new(Mutex::new(database));
        let socket = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = socket.local_addr().unwrap().port();
        drop(socket);
        let host = crate::server::start(db.clone(), port).unwrap();
        let mut rt = Runtime::new(
            init_with_url(format!("http://127.0.0.1:{port}")),
            view,
            (1366.0, 768.0),
            Env {
                system_dark: true,
                scale: 1.0,
            },
        );
        rt.frame(0.0);
        update(&mut rt, |s| s.connected && s.recovery["backups"].is_array());
        click(&mut rt, "nav-8");
        click(&mut rt, "admin-tab-6");
        scroll_to(&mut rt, "backup-create");
        click(&mut rt, "backup-create");
        update(&mut rt, |s| {
            !s.busy
                && s.recovery["backups"]
                    .as_array()
                    .is_some_and(|a| !a.is_empty())
        });
        let name = rt.state.recovery["backups"][0]["fileName"]
            .as_str()
            .unwrap()
            .to_owned();
        scroll_to(&mut rt, "clear-everything");
        click(&mut rt, "clear-everything");
        assert!(rt.state.confirm.is_some());
        assert_eq!(db.lock().unwrap().runners().unwrap().len(), 1);
        click(&mut rt, "cancel");
        assert_eq!(db.lock().unwrap().runners().unwrap().len(), 1);
        scroll_to(&mut rt, "clear-everything");
        click(&mut rt, "clear-everything");
        click(&mut rt, "confirm");
        update(&mut rt, |s| {
            !s.busy
                && s.snapshot["runners"]
                    .as_array()
                    .is_some_and(|r| r.is_empty())
        });
        assert!(db.lock().unwrap().runners().unwrap().is_empty());
        rt.wheel(1100.0, 650.0, 10000.0);
        rt.frame(1.0 / 60.0);
        let key = format!("restore-{name}");
        scroll_to(&mut rt, &key);
        click(&mut rt, &key);
        update(&mut rt, |s| {
            !s.busy
                && s.confirm
                    .as_ref()
                    .is_some_and(|c| c.method == "backups.restore")
        });
        assert_eq!(rt.state.preview["runners"], 1);
        assert!(db.lock().unwrap().runners().unwrap().is_empty());
        click(&mut rt, "confirm");
        update(&mut rt, |s| {
            !s.busy
                && s.snapshot["runners"]
                    .as_array()
                    .is_some_and(|r| r.len() == 1)
        });
        assert_eq!(db.lock().unwrap().runners().unwrap()[0]["name"], "Keep me");
        assert!(
            crate::backups::list(&path)
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["fileName"].as_str().unwrap().contains("pre-restore"))
        );
        drop(rt);
        drop(host);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn queue_page_checks_in_moves_reorders_hides_and_adds_runners_through_http() {
        let mut initial = crate::db::Db::open(std::path::Path::new(":memory:")).unwrap();
        let mut id = |number: &str, name: &str, status: &str| {
            initial
                .mutation("runners.create", &json!({"runnerNumber":number,"name":name,"status":status}))
                .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        let zoe = id("17", "Zoë Peeters", "registered");
        let warm = id("20", "Warre Opwarmer", "warming_up");
        let first = id("30", "Bram Eerst", "waiting");
        let second = id("31", "Cas Tweede", "waiting");
        let ran = id("40", "Dirk Gelopen", "registered");
        initial.exec("UPDATE runners SET status='ran',status_since=1 WHERE id=?", &[json!(ran)]).unwrap();
        let db = Arc::new(Mutex::new(initial));
        let socket = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = socket.local_addr().unwrap().port();
        drop(socket);
        let _host = crate::server::start(db.clone(), port).unwrap();
        let mut state = init_with_url(format!("http://127.0.0.1:{port}"));
        state.page = 1;
        let mut rt = Runtime::new(state, view, (1366.0, 1080.0), Env { system_dark: false, scale: 1.0 });
        rt.frame(0.0);
        update(&mut rt, |s| s.connected && runners(s).len() == 5 && !s.busy);
        let status = |id: &str| {
            db.lock().unwrap().rows("SELECT status,hidden_at AS h FROM runners WHERE id=?", &[json!(id)]).unwrap()[0].clone()
        };
        // Loper zoeken: the search field has the cursor; one exact number match and Enter checks Zoë in.
        click(&mut rt, "queue-search");
        assert!(rt.find("search-dialog").is_some());
        rt.paste("17");
        rt.frame(1.0 / 60.0);
        rt.key(rune::Key::Enter.into());
        update(&mut rt, |s| !s.busy && runners(s).iter().any(|r| r["id"] == json!(zoe) && r["status"] == "warming_up"));
        assert_eq!(status(&zoe)["status"], "warming_up");
        rt.frame(1.0 / 60.0);
        assert!(rt.find("search-dialog").is_none(), "one check-in closes Loper zoeken");
        assert!(rt.find("queue-toast").is_some(), "the check-in is confirmed");
        // Naar wachtrij: Warre joins the back of the queue.
        update(&mut rt, |s| !s.busy);
        click(&mut rt, &format!("queue-advance-{warm}"));
        update(&mut rt, |s| !s.busy && runners(s).iter().any(|r| r["id"] == json!(warm) && r["status"] == "waiting"));
        assert_eq!(status(&warm)["status"], "waiting");
        // Drag Cas onto Bram: Cas is next in line.
        update(&mut rt, |s| !s.busy);
        rt.frame(1.0 / 60.0);
        let (x0, y0) = rt.find(&format!("queue-handle-{second}")).unwrap();
        let (_, y1) = rt.find(&format!("queue-handle-{first}")).unwrap();
        rt.pointer_down(x0, y0);
        for step in 1..=10 {
            rt.pointer_move(x0, y0 + (y1 - y0) * step as f32 / 10.0);
            rt.frame(1.0 / 60.0);
        }
        assert!(rt.find("queue-drag-card").is_some(), "the card in hand follows the pointer");
        rt.pointer_up(x0, y1);
        update(&mut rt, |s| !s.busy && waiting_ids(s).first() == Some(&second));
        let order: Vec<String> = db
            .lock()
            .unwrap()
            .rows("SELECT id FROM runners WHERE status='waiting' ORDER BY queue_index", &[])
            .unwrap()
            .into_iter()
            .map(|r| r["id"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(order, vec![second.clone(), first.clone(), warm.clone()]);
        // Heeft gelopen: Verberg hides Dirk from the board.
        click(&mut rt, "queue-completed-toggle");
        // The rows open below the lanes: scroll the page down to them.
        let hide = format!("queue-hide-{ran}");
        for _ in 0..20 {
            if rt.find(&hide).is_some_and(|(_, y)| y < 1060.0) {
                break;
            }
            rt.wheel(700.0, 160.0, -200.0);
            rt.frame(1.0 / 60.0);
        }
        // Let the scroll glide land before pressing.
        for _ in 0..40 {
            rt.frame(1.0 / 60.0);
        }
        click(&mut rt, &hide);
        update(&mut rt, |s| !s.busy && runners(s).iter().any(|r| r["id"] == json!(ran) && r["hiddenFromQueue"] == true));
        assert!(!status(&ran)["h"].is_null());
        rt.frame(1.0 / 60.0);
        assert!(rt.find(&format!("queue-hide-{ran}")).is_none(), "a hidden runner leaves Heeft gelopen");
        // Nieuwe loper: number first, then the name; Enter adds the runner to Opwarming.
        update(&mut rt, |s| !s.busy);
        click(&mut rt, "queue-add");
        rt.paste("88");
        click(&mut rt, "add-name");
        rt.paste("Nina Nieuw");
        rt.frame(1.0 / 60.0);
        rt.key(rune::Key::Enter.into());
        update(&mut rt, |s| !s.busy && runners(s).iter().any(|r| r["name"] == "Nina Nieuw"));
        let added = db.lock().unwrap().rows("SELECT runner_number AS n,status FROM runners WHERE name='Nina Nieuw'", &[]).unwrap();
        assert_eq!((added[0]["n"].clone(), added[0]["status"].clone()), (json!("88"), json!("warming_up")));
        rt.frame(1.0 / 60.0);
        assert!(rt.find("add-dialog").is_none());
    }
    fn waiting_ids(s: &State) -> Vec<String> {
        let mut w: Vec<&Value> = runners(s).into_iter().filter(|r| r["status"] == "waiting").collect();
        w.sort_by_key(|r| r["queueIndex"].as_i64().unwrap_or(i64::MAX));
        w.into_iter().map(|r| r["id"].as_str().unwrap().to_owned()).collect()
    }
}

fn image_urls(snapshot: &Value, history: &Value) -> std::collections::HashSet<String> {
    let mut urls = std::collections::HashSet::new();
    let mut collect = |labels: &Value| {
        for label in labels.as_array().into_iter().flatten() {
            if let Some(url) = label["imageUrl"].as_str().filter(|s| !s.is_empty()) {
                urls.insert(url.to_owned());
            }
        }
    };
    collect(&snapshot["labels"]);
    for lap in history["laps"].as_array().into_iter().flatten() {
        collect(&lap["labels"]);
    }
    for pair in history["changes"]["laps"]["changed"].as_array().into_iter().flatten() {
        collect(&pair[1]["labels"]);
    }
    urls
}
fn label_badge(value: &Value, s: &State) -> El {
    let mut badge = row()
        .gap(5.0)
        .center_y()
        .px(5.0)
        .py(2.0)
        .radius(4.0)
        .border(1.0, tok::theme(s.dark).card_border);
    if let Some(image) = value["imageUrl"].as_str().and_then(|url| s.logos.get(url)) {
        badge = badge.child(
            rune::el()
                .size(14.0, 14.0)
                .pixels_fit(image.pixels(), rune::SurfaceFit::Fit),
        );
    } else {
        let color = rune::color::hex(value["color"].as_str().unwrap_or("#3b82f6"))
            .unwrap_or(tok::theme(s.dark).text);
        badge = badge.child(rune::el().size(7.0, 7.0).radius(3.5).fill(color));
    }
    badge.child(
        text(value["name"].as_str().unwrap_or(""))
            .font(type_::LABEL)
            .color(tok::theme(s.dark).text),
    )
}
/// Estimate the server clock at the midpoint of the fastest request.
fn clock_offset(samples: impl IntoIterator<Item = (i64, i64, i64)>) -> Option<i64> {
    samples
        .into_iter()
        .filter(|&(before, after, server)| server > 0 && (0..=1000).contains(&(after - before)))
        .min_by_key(|&(before, after, _)| after - before)
        .map(|(before, after, server)| server - (before + (after - before) / 2))
}

/// What the transport already holds, so a poll only refetches heavy data that changed:
/// history follows the server revision, label images are fetched once, recovery every few seconds.
#[derive(Default)]
struct Synced {
    history_revision: Option<i64>,
    history_sequence: u64,
    /// Identities validate deltas and image paths retain retries; payloads move to the UI.
    history: Value,
    history_index: history_sync::Index,
    history_images: history_delivery::Images,
    pending: std::sync::Arc<std::sync::Mutex<history_sync::Pending>>,
    images: std::collections::HashSet<String>,
}
impl Synced {
    fn state_path(&self, after: Option<&str>, screen: Option<&str>) -> String {
        let mut path = String::from("/api/state?history=1");
        if !self.pending.lock().unwrap().reset {
            if let Some(after) = after { path.push_str(&format!("&after={after}")); }
            if let Some(cursor) = self.history["cursor"].as_str() { path.push_str(&format!("&since={cursor}")); }
        }
        if let Some(screen) = screen { path.push_str(&format!("&screen={screen}")); }
        path
    }
    fn history_path(&self) -> String {
        if self.pending.lock().unwrap().reset { return "/api/history?scope=full".into(); }
        match self.history["cursor"].as_str() {
            Some(cursor) => format!("/api/history?scope=full&since={cursor}"),
            None => "/api/history?scope=full".into(),
        }
    }
    /// Move a validated full or delta reply to the UI; `None` requests full recovery.
    fn take_history(&mut self, reply: Value) -> Option<history_delivery::Delivery> {
        if reply.is_null() {
            return Some(Default::default());
        }
        if reply["delta"] == true {
            if self.pending.lock().unwrap().reset { return None; }
            if reply["cursor"] == self.history["cursor"] {
                return Some(Default::default());
            }
            if reply["since"] != self.history["cursor"] {
                return None;
            }
            if self.history_index.apply(&mut self.history, &history_delivery::delta_index(&reply)).is_none() {
                self.history = Value::Null;
                self.history_index = Default::default();
                self.pending.lock().unwrap().reset = true;
                return None;
            }
        } else if reply["revision"].as_i64() >= self.history["revision"].as_i64()
            || !same_run(&reply["cursor"], &self.history["cursor"])
        {
            self.history = history_delivery::index(&reply);
            self.history_index = history_sync::Index::new(&self.history);
            self.pending.lock().unwrap().reset = false;
        } else {
            return Some(Default::default());
        }
        self.history_revision = self.history["revision"].as_i64();
        self.history_images.accept(&reply, &self.images);
        self.history_sequence += 1;
        Some(history_delivery::Delivery { sequence: self.history_sequence, body: reply })
    }
}
/// Whether two change tokens or history cursors come from one run of one server. Revisions count
/// up within a run only: a restarted server, or another laptop, may be at a lower one.
fn same_run(new: &Value, old: &Value) -> bool {
    let run = |token: &Value| token.as_str().and_then(|t| t.split('.').next().map(str::to_owned));
    match (run(new), run(old)) {
        (Some(new), Some(old)) => new == old,
        _ => true,
    }
}
/// Applies `/api/history?since=` changes to a full history; `false` when they do not line up.
#[cfg(test)]
pub(crate) fn merge_history(held: &mut Value, delta: &Value) -> bool {
    fn merge(held: Value, change: &Value) -> Option<Value> {
        let Value::Array(held) = held else { return None };
        let mut skip: std::collections::HashSet<&str> =
            change["removed"].as_array()?.iter().filter_map(Value::as_str).collect();
        let mut slots = vec![None; usize::try_from(change["count"].as_u64()?).ok()?];
        for pair in change["changed"].as_array()? {
            let slot = slots.get_mut(usize::try_from(pair[0].as_u64()?).ok()?)?;
            skip.insert(pair[1]["id"].as_str()?);
            if slot.replace(pair[1].clone()).is_some() {
                return None;
            }
        }
        let mut kept = held
            .into_iter()
            .filter(|row| row["id"].as_str().is_none_or(|id| !skip.contains(id)));
        let rows = slots
            .into_iter()
            .map(|slot| slot.or_else(|| kept.next()))
            .collect::<Option<Vec<_>>>()?;
        kept.next().is_none().then_some(Value::Array(rows))
    }
    let changes = &delta["changes"];
    let laps = merge(held["laps"].take(), &changes["laps"]);
    let events = merge(held["events"].take(), &changes["events"]);
    let (Some(laps), Some(events)) = (laps, events) else {
        return false;
    };
    held["laps"] = laps;
    held["events"] = events;
    held["revision"] = delta["revision"].clone();
    held["cursor"] = delta["cursor"].clone();
    true
}
const POLL_EVERY: Duration = Duration::from_millis(200);
fn poll_delay(snapshot: &Value, after: Option<&str>, elapsed: Duration) -> Duration {
    let token = snapshot["changeToken"].as_str();
    if snapshot.is_null() || token.is_none() || token == after {
        POLL_EVERY.saturating_sub(elapsed)
    } else { Duration::ZERO }
}
/// Actions that only read: their answer needs no fresh history or recovery behind it.
fn reads_only(method: &str) -> bool {
    matches!(method, "runners.registrations" | "runners.profile" | "activity.list" | "activity.older")
}
const RECOVERY_EVERY: Duration = Duration::from_secs(5);
fn action_error(value: &Value) -> String {
    value["error"]["message"]
        .as_str()
        .unwrap_or("Opslaan mislukt")
        .into()
}
fn absolute(url: &str, path: &str) -> String {
    if path.starts_with("http://") || path.starts_with("https://") {
        path.into()
    } else {
        format!("{url}{path}")
    }
}

/// Actions run on their own thread and never wait behind a long-poll.
#[cfg(not(target_arch = "wasm32"))]
fn start_transport(url: String, commands: Receiver<Command>, updates: Updates, _command_wake: CommandWake) {
    use reqwest::blocking::Client;
    use std::sync::{Arc, Mutex};
    let client = Client::builder()
        .tcp_nodelay(true)
        .timeout(Duration::from_secs(25))
        .build()
        .unwrap();
    let synced = Arc::new(Mutex::new(Synced::default()));
    fn get(client: &Client, url: &str, path: &str) -> Value {
        if crate::latency::enabled() && path.starts_with("/api/state") {
            let read = || -> std::result::Result<Value, reqwest::Error> {
                let response = client.get(format!("{url}{path}")).timeout(Duration::from_secs(5)).send()?.error_for_status()?;
                let headers = crate::latency::realtime_us();
                let request = response.headers().get("x-apolloon-trace-request").and_then(|v| v.to_str().ok()).map(str::to_owned);
                let bytes = response.bytes()?;
                let body = crate::latency::realtime_us();
                let snapshot = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
                let parsed = crate::latency::realtime_us();
                crate::latency::http_stage("http_headers", &snapshot, headers, request.as_deref());
                crate::latency::http_stage("http_body", &snapshot, body, request.as_deref());
                crate::latency::http_stage("json_parsed", &snapshot, parsed, request.as_deref());
                crate::latency::http_size(&snapshot, request.as_deref(), bytes.len());
                crate::latency::http_stage("push_received", &snapshot, crate::latency::realtime_us(), request.as_deref());
                Ok(snapshot)
            };
            return read().unwrap_or(Value::Null);
        }
        client
            .get(format!("{url}{path}"))
            .timeout(Duration::from_secs(5))
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.json::<Value>())
            .unwrap_or(Value::Null)
    }
    /// `full`: an action just ran, so its outcome arrives with the history it changed.
    fn refresh(
        client: &Client,
        url: &str,
        synced: &Mutex<Synced>,
        full: bool,
        extra_image: Option<String>,
        path: &str,
    ) -> Update {
        let mut snapshot = get(client, url, path);
        if snapshot["unchanged"] == true {
            return Update { snapshot, ..Default::default() };
        }
        let bundled = snapshot.as_object_mut().and_then(|s| s.remove("stateHistory"));
        let revision = snapshot["revision"].as_i64();
        let changed = full || (revision.is_some() && synced.lock().unwrap().history_revision != revision);
        let history = if let Some(reply) = bundled {
            let history = synced.lock().unwrap().take_history(reply);
            history.unwrap_or_else(|| {
                let full = get(client, url, "/api/history?scope=full");
                synced.lock().unwrap().take_history(full).unwrap_or_default()
            })
        } else if changed {
            let path = synced.lock().unwrap().history_path();
            let reply = get(client, url, &path);
            let history = synced.lock().unwrap().take_history(reply);
            history.unwrap_or_else(|| {
                let full = get(client, url, "/api/history?scope=full");
                synced.lock().unwrap().take_history(full).unwrap_or_default()
            })
        } else {
            Default::default()
        };
        let recovery = Value::Null;
        crate::latency::snapshot("history_merged", &snapshot);
        let mut paths = image_urls(&snapshot, &Value::Null);
        paths.extend(synced.lock().unwrap().history_images.pending());
        paths.extend(extra_image);
        paths.retain(|path| !synced.lock().unwrap().images.contains(path));
        let images = paths
            .into_iter()
            .filter_map(|path| {
                let bytes = client
                    .get(absolute(url, &path))
                    .timeout(Duration::from_secs(3))
                    .send()
                    .and_then(|r| r.error_for_status())
                    .and_then(|r| r.bytes())
                    .ok()?;
                synced.lock().unwrap().images.insert(path.clone());
                synced.lock().unwrap().history_images.loaded(&path);
                Some((path, bytes.to_vec()))
            })
            .collect();
        Update {
            partial: false,
            snapshot,
            history,
            history_changes: Some(synced.lock().unwrap().pending.clone()),
            recovery,
            images,
            clock_offset: None,
            outcome: None,
        }
    }
    {
        let (client, url, synced, updates) =
            (client.clone(), url.clone(), synced.clone(), updates.clone());
        std::thread::spawn(move || {
            while let Ok(command) = commands.recv() {
                let local = crate::desktop::with(|_| ())
                    .and_then(|_| crate::desktop::control(&command.method, &command.input));
                let result = local.unwrap_or_else(|| {
                    if command.method == "race.handoff" { crate::latency::handoff("post_sent", &command.input, None); }
                    client
                        .post(format!("{url}/api/action/{}", command.method))
                        .header("x-apolloon-screen", &command.screen)
                        .json(&command.input)
                        .send()
                        .map_err(|error| error.to_string())
                        .and_then(|response| {
                            let status = response.status();
                            let value: Value = response.json().map_err(|error| error.to_string())?;
                            if status.is_success() { Ok(value) } else { Err(action_error(&value)) }
                        })
                });
                if command.method == "race.handoff" { crate::latency::handoff("client_response", &command.input, result.as_ref().ok().and_then(|r| r["lapId"].as_str())); }
                let image = result.as_ref().ok().and_then(|r| r["imageUrl"].as_str()).map(str::to_owned);
                let path = synced.lock().unwrap().state_path(None, None);
                let mut update = refresh(&client, &url, &synced, !reads_only(&command.method), image, &path);
                let recovery = !reads_only(&command.method);
                update.outcome = Some((command.method, result));
                if updates.send(update).is_err() {
                    break;
                }
                if recovery && updates.send(Update { partial: true, recovery: get(&client, &url, "/api/recovery"), ..Default::default() }).is_err() { break; }
            }
        });
    }
    std::thread::spawn(move || {
        let mut next_clock_sync = Instant::now();
        let mut next_recovery = Instant::now();
        let mut after: Option<String> = None;
        loop {
            let started = Instant::now();
            let path = synced.lock().unwrap().state_path(after.as_deref(), None);
            let mut update = refresh(&client, &url, &synced, false, None, &path);
            let wait = poll_delay(&update.snapshot, after.as_deref(), started.elapsed());
            after = update.snapshot["changeToken"].as_str().map(str::to_owned);
            let connected = !update.snapshot.is_null();
            if connected && started >= next_clock_sync {
                let mut samples = Vec::new();
                for _ in 0..3 {
                    let before = now();
                    if let Some(server) = get(&client, &url, "/api/clock")["serverNowMs"].as_i64() {
                        samples.push((before, now(), server));
                    }
                }
                update.clock_offset = clock_offset(samples);
                next_clock_sync = Instant::now()
                    + Duration::from_secs(if update.clock_offset.is_some() { 60 } else { 5 });
            }
            if updates.send(update).is_err() { break; }
            let mut extra = Update { partial: true, ..Default::default() };
            if started >= next_recovery {
                extra.recovery = get(&client, &url, "/api/recovery");
                next_recovery = Instant::now() + RECOVERY_EVERY;
            }
            if updates.send(extra).is_err() {
                break;
            }
            std::thread::sleep(wait);
        }
    });
}
#[cfg(target_arch = "wasm32")]
fn start_transport(url: String, commands: Receiver<Command>, updates: Updates, command_wake: CommandWake) {
    use std::{cell::RefCell, rc::Rc};
    async fn get(client: &reqwest::Client, url: &str, path: &str) -> Value {
        if crate::latency::enabled() && path.starts_with("/api/state") {
            if let Ok(response) = client.get(format!("{url}{path}")).timeout(Duration::from_secs(5)).send().await
                && response.status().is_success()
            {
                let headers = crate::latency::realtime_us();
                let request = response.headers().get("x-apolloon-trace-request").and_then(|v| v.to_str().ok()).map(str::to_owned);
                if let Ok(bytes) = response.bytes().await {
                    let body = crate::latency::realtime_us();
                    let snapshot = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
                    let parsed = crate::latency::realtime_us();
                    crate::latency::http_stage("http_headers", &snapshot, headers, request.as_deref());
                    crate::latency::http_stage("http_body", &snapshot, body, request.as_deref());
                    crate::latency::http_stage("json_parsed", &snapshot, parsed, request.as_deref());
                    crate::latency::http_size(&snapshot, request.as_deref(), bytes.len());
                    crate::latency::http_stage("push_received", &snapshot, crate::latency::realtime_us(), request.as_deref());
                    return snapshot;
                }
            }
            return Value::Null;
        }
        match client.get(format!("{url}{path}")).timeout(Duration::from_secs(5)).send().await {
            Ok(r) if r.status().is_success() => r.json::<Value>().await.unwrap_or(Value::Null),
            _ => Value::Null,
        }
    }
    /// `full`: an action just ran, so its outcome arrives with the history it changed.
    async fn refresh(
        client: &reqwest::Client,
        url: &str,
        synced: &RefCell<Synced>,
        full: bool,
        extra_image: Option<String>,
        after: Option<&str>,
    ) -> Update {
        let screen = web_sys::window()
            .and_then(|w| w.location().pathname().ok())
            .and_then(|p| {
                p.strip_prefix("/display/")
                    .map(|kind| kind.trim_end_matches('/').to_owned())
            })
            .filter(|kind| matches!(kind.as_str(), "inside" | "competitions" | "outside"))
            ;
        let path = synced.borrow().state_path(after, screen.as_deref());
        let mut snapshot = get(client, url, &path).await;
        if snapshot["unchanged"] == true {
            return Update { snapshot, ..Default::default() };
        }
        let bundled = snapshot.as_object_mut().and_then(|s| s.remove("stateHistory"));
        let revision = snapshot["revision"].as_i64();
        let changed = full || (revision.is_some() && synced.borrow().history_revision != revision);
        let history = match bundled {
            Some(reply) => reply,
            None if changed => {
                let path = synced.borrow().history_path();
                get(client, url, &path).await
            }
            None => Value::Null,
        };
        let history = synced.borrow_mut().take_history(history);
        let history = match history {
            Some(history) => history,
            None => {
                let full = get(client, url, "/api/history?scope=full").await;
                synced.borrow_mut().take_history(full).unwrap_or_default()
            }
        };
        crate::latency::snapshot("history_merged", &snapshot);
        let mut paths = image_urls(&snapshot, &Value::Null);
        paths.extend(synced.borrow().history_images.pending());
        paths.extend(extra_image);
        paths.retain(|path| !synced.borrow().images.contains(path));
        let mut images = Vec::new();
        for path in paths {
            if let Ok(response) = client.get(absolute(url, &path)).send().await
                && response.status().is_success()
                && let Ok(bytes) = response.bytes().await
            {
                synced.borrow_mut().images.insert(path.clone());
                synced.borrow_mut().history_images.loaded(&path);
                images.push((path, bytes.to_vec()));
            }
        }
        Update {
            partial: false,
            snapshot,
            history,
            history_changes: Some(synced.borrow().pending.clone()),
            recovery: Value::Null,
            images,
            clock_offset: None,
            outcome: None,
        }
    }
    /// Polls both futures until each is done; enough for two fetches without a futures crate.
    async fn futures_join<A: std::future::Future, B: std::future::Future>(
        a: A,
        b: B,
    ) -> (A::Output, B::Output) {
        use std::{pin::pin, task::Poll};
        let (mut a, mut b) = (pin!(a), pin!(b));
        let (mut ra, mut rb) = (None, None);
        std::future::poll_fn(move |cx| {
            if ra.is_none()
                && let Poll::Ready(v) = a.as_mut().poll(cx)
            {
                ra = Some(v);
            }
            if rb.is_none()
                && let Poll::Ready(v) = b.as_mut().poll(cx)
            {
                rb = Some(v);
            }
            if ra.is_some() && rb.is_some() {
                Poll::Ready((ra.take().unwrap(), rb.take().unwrap()))
            } else {
                Poll::Pending
            }
        })
        .await
    }
    async fn sample_clock(client: &reqwest::Client, url: &str) -> Option<i64> {
        let mut samples = Vec::new();
        for _ in 0..3 {
            let before = now();
            if let Some(server) = get(client, url, "/api/clock").await["serverNowMs"].as_i64() {
                samples.push((before, now(), server));
            }
        }
        clock_offset(samples)
    }
    let client = reqwest::Client::new();
    let synced = Rc::new(RefCell::new(Synced::default()));
    {
        let (client, url, synced, updates) =
            (client.clone(), url.clone(), synced.clone(), updates.clone());
        wasm_bindgen_futures::spawn_local(async move {
            loop {
                let command = std::future::poll_fn(|cx| {
                    *command_wake.lock().unwrap() = Some(cx.waker().clone());
                    match commands.try_recv() {
                        Ok(command) => std::task::Poll::Ready(Some(command)),
                        Err(mpsc::TryRecvError::Empty) => std::task::Poll::Pending,
                        Err(mpsc::TryRecvError::Disconnected) => std::task::Poll::Ready(None),
                    }
                }).await;
                let Some(command) = command else { break };
                if command.method == "race.handoff" { crate::latency::handoff("post_sent", &command.input, None); }
                let result = match client
                    .post(format!("{url}/api/action/{}", command.method))
                    .header("x-apolloon-screen", &command.screen)
                    .json(&command.input)
                    .send()
                    .await
                {
                    Ok(response) => {
                        let status = response.status();
                        match response.json::<Value>().await {
                            Ok(v) if status.is_success() => Ok(v),
                            Ok(v) => Err(action_error(&v)),
                            Err(e) => Err(e.to_string()),
                        }
                    }
                    Err(e) => Err(e.to_string()),
                };
                if command.method == "race.handoff" { crate::latency::handoff("client_response", &command.input, result.as_ref().ok().and_then(|r| r["lapId"].as_str())); }
                let image = result.as_ref().ok().and_then(|r| r["imageUrl"].as_str()).map(str::to_owned);
                let mut update = refresh(&client, &url, &synced, !reads_only(&command.method), image, None).await;
                let recovery = !reads_only(&command.method);
                update.outcome = Some((command.method, result));
                if updates.send(update).is_err() {
                    break;
                }
                if recovery {
                    let recovery = get(&client, &url, "/api/recovery").await;
                    if updates.send(Update { partial: true, recovery, ..Default::default() }).is_err() { break; }
                }
            }
        });
    }
    wasm_bindgen_futures::spawn_local(async move {
        let mut next_clock_sync = Instant::now();
        let mut next_recovery = Instant::now();
        let mut after: Option<String> = None;
        loop {
            let started = Instant::now();
            let load = refresh(&client, &url, &synced, false, None, after.as_deref());
            let sync_clock = started >= next_clock_sync;
            let (mut update, offset) = if sync_clock {
                futures_join(load, sample_clock(&client, &url)).await
            } else {
                (load.await, None)
            };
            let wait = poll_delay(&update.snapshot, after.as_deref(), started.elapsed());
            after = update.snapshot["changeToken"].as_str().map(str::to_owned);
            update.clock_offset = offset;
            if sync_clock {
                next_clock_sync = Instant::now()
                    + Duration::from_millis(if offset.is_some() { 60_000 } else { 500 });
            }
            if updates.send(update).is_err() { break; }
            let mut extra = Update { partial: true, ..Default::default() };
            if started >= next_recovery {
                extra.recovery = get(&client, &url, "/api/recovery").await;
                next_recovery = Instant::now() + RECOVERY_EVERY;
            }
            if updates.send(extra).is_err() {
                break;
            }
            if !wait.is_zero() { gloo_timers::future::TimeoutFuture::new(wait.as_millis() as u32).await; }
        }
    });
}
