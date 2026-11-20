//! Motion gate: the real view, recorded frame by frame on the virtual clock, for the moves an
//! operator makes all race long (pages, Beheer tabs, theme, sidebar) and for a lap arriving.
//! `rune::motion_gate` lists what a person would see go wrong: pops, jumps, flickers, overshoot.
use super::*;
use rune::motion_gate::{self, AllowRow, Job, Recording, Run};
use rune::{Env, Runtime};
use std::sync::{Arc, Mutex, OnceLock};

/// Findings that are the design, each with its reason.
const ALLOW: &[AllowRow] = &[
    AllowRow::new(
        "pop-in",
        "",
        "nav/|admin-tab/",
        "a page or Beheer tab swaps at once, as fast as a press",
    )
    .max(38),
    AllowRow::new(
        "pop-out",
        "",
        "nav/|admin-tab/",
        "a page or Beheer tab swaps at once, as fast as a press",
    )
    .max(30),
    AllowRow::new(
        "jump",
        "",
        "nav/|admin-tab/",
        "the new page's header and panel land at their size at once",
    )
    .max(26),
    AllowRow::new(
        "text-swap",
        "page-header",
        "nav/",
        "the page title changes with the page",
    )
    .max(12),
    AllowRow::new(
        "appear-then-jump",
        "tac-chart-",
        "nav/0-4",
        "a chart learns its width on the first frame it shows and redraws to it on the next",
    )
    .max(4),
    AllowRow::new(
        "text-swap",
        "",
        "lap/",
        "the laptops show a new lap, and the praise it moves, the moment it is saved, without a roll",
    )
    .max(16),
    AllowRow::new(
        "snap",
        "timing-",
        "lap/timing",
        "the next runner's row becomes the running one at once",
    )
    .max(3),
    AllowRow::new(
        "snap",
        "points-all/",
        "lap/inside",
        "the NET BINNEN tag moves to the new lap, which rises in",
    )
    .max(1),
];

/// A race in progress, as the server reports it, before and after one more lap.
struct Race {
    before: (Value, Value),
    after: (Value, Value),
    clock: i64,
}

fn race() -> &'static Race {
    static RACE: OnceLock<Race> = OnceLock::new();
    RACE.get_or_init(|| {
        let mut db = crate::db::Db::open(std::path::Path::new(":memory:")).unwrap();
        let mut ids = Vec::new();
        for (number, name) in [("1", "Mitras"), ("2", "Wout"), ("3", "Zoë"), ("4", "Fien"), ("5", "Arno")] {
            let runner = db
                .mutation("runners.create", &json!({"runnerNumber":number,"name":name,"status":"waiting"}))
                .unwrap();
            ids.push(runner["id"].clone());
        }
        let handoff = |db: &mut crate::db::Db| {
            let row = db.rows("SELECT active_runner_id AS r, active_started_at AS a FROM race_state WHERE id=1", &[]).unwrap();
            db.mutation(
                "race.handoff",
                &json!({"activeRunnerId":row[0]["r"],"activeStartedAt":row[0]["a"],"pressedAt":now()}),
            )
            .unwrap();
        };
        handoff(&mut db);
        // Six laps of 80 s before this one, by the runners after Mitras in turn.
        let start = now() - 6 * 80_000 - 75_000;
        for i in 0..6 {
            let at = start + i * 80_000;
            db.exec(
                "INSERT INTO laps(id,runner_id,lap_number,started_at,finished_at,duration_ms,source,created_at,labels_json) VALUES(?,?,?,?,?,80000,'spacebar',?,'[]')",
                &[json!(format!("lap-{i}")), ids[1 + i as usize % 4].clone(), json!(1 + i / 4), json!(at), json!(at + 80_000), json!(at + 80_000)],
            )
            .unwrap();
        }
        db.exec(
            "UPDATE race_state SET active_started_at=?,race_started_at=? WHERE id=1",
            &[json!(now() - 75_000), json!(start)],
        )
        .unwrap();
        let db = Arc::new(Mutex::new(db));
        let socket = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = socket.local_addr().unwrap().port();
        drop(socket);
        let _host = crate::server::start(db.clone(), port).unwrap();
        let state = init_with_url(format!("http://127.0.0.1:{port}"));
        let mut rt = Runtime::new(state, view, (1366.0, 768.0), env());
        let laps = |n: usize| move |s: &State| s.connected && s.history["laps"].as_array().is_some_and(|l| l.len() == n);
        settle(&mut rt, laps(6));
        let before = (rt.state.snapshot.clone(), rt.state.history.clone());
        handoff(&mut db.lock().unwrap());
        settle(&mut rt, laps(7));
        let after = (rt.state.snapshot.clone(), rt.state.history.clone());
        Race { before, after, clock: now() }
    })
}

fn env() -> Env {
    Env {
        system_dark: false,
        scale: 1.0,
    }
}

fn settle(rt: &mut Runtime<State>, done: impl Fn(&State) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !done(&rt.state) {
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

/// A runtime on `page` (Beheer section `section`) holding the race before its last lap,
/// detached from any server.
fn start(page: usize, section: usize, dark: bool, size: (f32, f32)) -> Run<State> {
    let r = race();
    let mut s = init_with_url("http://127.0.0.1:1".into());
    s.fixture = true;
    s.connected = true;
    s.dark = dark;
    s.page = page;
    s.admin_section = section;
    (s.snapshot, s.history) = r.before.clone();
    s.clock = r.clock;
    // The screen has been open a while: what it shows now is what it opened with.
    let clock = s.clock;
    public_screens::poll(&mut s, true, clock);
    let mut rt = Runtime::new(s, view, size, env());
    rt.on_key = Some(on_key);
    let mut run = Run::new(rt, 120.0);
    run.idle(1.5);
    run.step();
    run
}

const LAPTOP: (f32, f32) = (1366.0, 768.0);
const TV: (f32, f32) = (1920.0, 1080.0);

fn tap_and_play(page: usize, section: usize, dark: bool, key: String) -> Recording {
    let mut run = start(page, section, dark, LAPTOP);
    run.act(&format!("tap {key}"), |rt| Run::tap(rt, &key));
    run.play(1.2);
    run.rec
}

/// Opens `key`, then closes it with Escape (a dialog or menu) or by tapping it again.
fn open_and_close(page: usize, key: &str, escape: bool) -> Recording {
    let mut run = start(page, 0, false, LAPTOP);
    run.act(&format!("tap {key}"), |rt| Run::tap(rt, key));
    run.play(1.0);
    if escape {
        run.act("escape", |rt| rt.key(rune::Key::Escape.into()));
    } else {
        run.act(&format!("tap {key} again"), |rt| Run::tap(rt, key));
    }
    run.play(1.0);
    run.rec
}

fn lap_arrives(page: usize, size: (f32, f32)) -> Recording {
    let mut run = start(page, 0, false, size);
    // As a poll that brings the lap: the tv screens mark what arrived and may flash.
    run.rt.update(|s, _| {
        (s.snapshot, s.history) = race().after.clone();
        let clock = s.clock;
        public_screens::poll(s, true, clock);
    });
    run.step();
    run.play(2.0);
    run.rec
}

fn cells() -> Vec<(String, Job)> {
    let mut cells: Vec<(String, Job)> = Vec::new();
    for dark in [false, true] {
        let theme = if dark { "dark" } else { "light" };
        for to in [1, 2, 3, 4, 8] {
            cells.push((
                format!("nav/0-{to}/{theme}"),
                Box::new(move || tap_and_play(0, 1, dark, format!("nav-{to}"))),
            ));
        }
        cells.push((
            format!("nav/2-0/{theme}"),
            Box::new(move || tap_and_play(2, 1, dark, "nav-0".into())),
        ));
    }
    for to in 0..SECTIONS.len() {
        if to != 1 {
            cells.push((
                format!("admin-tab/1-{to}"),
                Box::new(move || tap_and_play(8, 1, false, format!("admin-tab-{to}"))),
            ));
        }
    }
    // Dialogs, menus and sections that open and close in place: in, then out again.
    for (name, page, key, escape) in [
        ("timing-finish", 2, "finish", true),
        ("analysis-export", 3, "analysis-export", true),
        ("queue-completed", 1, "queue-completed-toggle", false),
        ("queue-available", 1, "available-now-toggle", false),
        ("tactics-hours", 4, "tac-hour-toggle", false),
        ("tactics-analysis", 4, "tac-analysis-toggle", false),
    ] {
        cells.push((
            format!("open/{name}"),
            Box::new(move || open_and_close(page, key, escape)),
        ));
    }
    cells.push((
        "theme/light-dark".into(),
        Box::new(|| tap_and_play(0, 1, false, "theme-dark".into())),
    ));
    cells.push((
        "sidebar/collapse".into(),
        Box::new(|| tap_and_play(2, 1, false, "collapse".into())),
    ));
    for (name, page, size) in [
        ("overview", 0, LAPTOP),
        ("queue", 1, LAPTOP),
        ("timing", 2, LAPTOP),
        ("inside", 5, TV),
        ("outside", 7, TV),
    ] {
        cells.push((
            format!("lap/{name}"),
            Box::new(move || lap_arrives(page, size)),
        ));
    }
    cells
}

#[test]
fn motion_gate() {
    race();
    motion_gate::gate_rows(cells(), ALLOW);
}
