//! Three (or more) real Rust servers in this process, each on a free port with its own SQLite
//! file, linked over HTTP: link, replicated writes, killing the leader, failover, restart and
//! catch-up, a partition and its reconciliation, going on alone and replacing a lost laptop.
use super::{Config, Node};
use crate::db::Db;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

pub(crate) struct TestServer {
    pub node: Arc<Node>,
    pub db: Arc<Mutex<Db>>,
    pub url: String,
    pub port: u16,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl TestServer {
    pub fn start(path: &Path, port: u16, name: &str) -> Self {
        Self::start_with(path, port, name, |_| {})
    }
    pub fn start_with(path: &Path, port: u16, name: &str, tune: impl FnOnce(&mut Config)) -> Self {
        let db = Arc::new(Mutex::new(if path.as_os_str() == ":memory:" {
            Db::open(Path::new(":memory:")).unwrap()
        } else {
            Db::open(path).unwrap()
        }));
        let url = format!("http://127.0.0.1:{port}");
        let mut config = Config::test(url.clone(), name);
        tune(&mut config);
        let host = crate::server::Host::with_cluster(db.clone(), port, Some(config));
        let node = host.cluster.clone().unwrap();
        let socket =
            socket2::Socket::new(socket2::Domain::IPV4, socket2::Type::STREAM, None).unwrap();
        socket.set_reuse_address(true).unwrap();
        socket
            .bind(&std::net::SocketAddr::from(([127, 0, 0, 1], port)).into())
            .unwrap();
        socket.listen(128).unwrap();
        socket.set_nonblocking(true).unwrap();
        let listener: std::net::TcpListener = socket.into();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let thread = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async move {
                let listener = tokio::net::TcpListener::from_std(listener).unwrap();
                let serve = axum::serve(
                    listener,
                    crate::server::router(host)
                        .into_make_service_with_connect_info::<std::net::SocketAddr>(),
                );
                tokio::select! {
                    _ = serve => {}
                    _ = stopped => {}
                }
            });
            // A switched-off laptop: nothing it was doing finishes.
            runtime.shutdown_background();
        });
        Self {
            node,
            db,
            url,
            port,
            stop: Some(stop),
            thread: Some(thread),
        }
    }
    /// Power off: the server, its votes and its replication stop at once.
    pub fn kill(mut self) {
        self.node.stop();
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
    pub fn status(&self) -> Value {
        self.node.status()
    }
    pub fn count(&self, sql: &str) -> i64 {
        self.db.lock().unwrap().one(sql, &[]).unwrap()["n"]
            .as_i64()
            .unwrap()
    }
    pub fn head(&self) -> i64 {
        super::log::head(&self.db.lock().unwrap()).seq
    }
    pub fn act(&self, method: &str, input: Value) -> crate::db::Result<Value> {
        self.node.action(method, &input, "test")
    }
}
impl Drop for TestServer {
    fn drop(&mut self) {
        self.node.stop();
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

pub(crate) fn free_port() -> u16 {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}
/// Linked-server tests run one at a time: each starts several servers with heartbeat and
/// election timers, and running them beside each other under a loaded test suite starves those timers.
pub(crate) fn serial() -> std::sync::MutexGuard<'static, ()> {
    static SERIAL: Mutex<()> = Mutex::new(());
    SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Waits for a condition; deadlines are three times what an idle machine needs, for a loaded one.
pub(crate) fn wait_until(what: &str, timeout: Duration, mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + timeout * 3;
    while !check() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(25));
    }
}

struct Dir(PathBuf);
impl Dir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("apolloon-cluster-test-{}", crate::db::id()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
    fn db(&self, name: &str) -> PathBuf {
        self.0.join(name).join("app.db")
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn press(server: &TestServer, method: &str) -> crate::db::Result<Value> {
    let race = server.db.lock().unwrap().race().unwrap();
    server.act(
        method,
        json!({"activeRunnerId":race["activeRunnerId"],"activeStartedAt":race["activeStartedAt"]}),
    )
}
fn leader_index(servers: &[&TestServer]) -> Option<usize> {
    servers
        .iter()
        .position(|s| s.node.is_leader() && s.status()["writable"] == true)
}
fn all_healthy(servers: &[&TestServer]) -> bool {
    servers.iter().all(|s| {
        let status = s.status();
        status["members"].as_array().map_or(0, Vec::len) == servers.len()
            && status["state"] == "healthy"
    })
}
fn same_heads(servers: &[&TestServer]) -> bool {
    let head = servers[0].head();
    servers.iter().all(|s| s.head() == head)
}
/// Three laptops linked from the follower side: B and C each press Koppelen next to A.
fn linked_three(dir: &Dir) -> (TestServer, TestServer, TestServer) {
    let a = TestServer::start(&dir.db("a"), free_port(), "Laptop A");
    let b = TestServer::start(&dir.db("b"), free_port(), "Laptop B");
    let c = TestServer::start(&dir.db("c"), free_port(), "Laptop C");
    a.act("runners.create", json!({"name":"Zoë","status":"waiting"}))
        .unwrap();
    // A holds a runner, so B and C (untouched) take A's data whichever laptop the press is on.
    b.act("cluster.joinGroup", json!({"url": a.url})).unwrap();
    // C presses next to B, a follower: the join goes to the leader.
    c.act("cluster.joinGroup", json!({"url": b.url})).unwrap();
    wait_until("three healthy laptops", Duration::from_secs(10), || {
        all_healthy(&[&a, &b, &c])
    });
    (a, b, c)
}

#[test]
fn three_laptops_link_replicate_fail_over_restart_and_catch_up() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    let cluster_id = a.status()["clusterId"].clone();
    for server in [&a, &b, &c] {
        assert_eq!(server.status()["clusterId"], cluster_id);
        assert_eq!(
            server.count("SELECT COUNT(*) AS n FROM runners"),
            1,
            "the group's data was copied"
        );
        assert_eq!(server.count("SELECT COUNT(*) AS n FROM cluster_members"), 3);
    }
    assert!(a.node.is_leader());

    // Writes on a follower go to the leader and are on a majority before the press answers.
    c.act("runners.create", json!({"name":"Wout","status":"waiting"}))
        .unwrap();
    press(&c, "race.handoff").unwrap();
    press(&b, "race.handoff").unwrap();
    // Through the real HTTP route the screens use.
    let created: Value = reqwest::blocking::Client::new()
        .post(format!("{}/api/action/runners.create", b.url))
        .json(&json!({"name":"Mitras"}))
        .send()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(created["name"], "Mitras");
    let laps = |s: &TestServer| s.count("SELECT COUNT(*) AS n FROM laps");
    assert_eq!(laps(&b), 1, "the follower shows its own press at once");
    wait_until("every laptop holds the lap", Duration::from_secs(5), || {
        same_heads(&[&a, &b, &c]) && [&a, &b, &c].iter().all(|s| laps(s) == 1)
    });
    let state = |s: &TestServer| s.db.lock().unwrap().snapshot(0).unwrap()["race"].clone();
    assert_eq!(state(&a), state(&c));
    // A follower's /api/state carries the group status the screens show.
    let state_of_c = || -> Value {
        reqwest::blocking::get(format!("{}/api/state", c.url))
            .unwrap()
            .json()
            .unwrap()
    };
    wait_until(
        "C's screen shows a healthy group",
        Duration::from_secs(5),
        || state_of_c()["cluster"]["state"] == "healthy",
    );
    let snapshot = state_of_c();
    assert_eq!(
        snapshot["cluster"]["leader"]["hostId"],
        a.status()["hostId"]
    );

    // The leader dies: B and C elect a new one and keep saving.
    let a_path = dir.db("a");
    let a_port = a.port;
    a.kill();
    wait_until("a new leader", Duration::from_secs(10), || {
        leader_index(&[&b, &c]).is_some()
    });
    press(&c, "race.handoff").unwrap();
    assert_eq!(laps(&c), 2);
    wait_until(
        "B holds the lap clocked after the failover",
        Duration::from_secs(5),
        || laps(&b) == 2,
    );
    let degraded = b.status();
    assert_eq!(degraded["state"], "degraded");
    assert_eq!(
        degraded["members"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["reachable"] != true)
            .count(),
        1
    );

    // A restarts from its own file and catches up through the log.
    let a = TestServer::start(&a_path, a_port, "Laptop A");
    assert!(!a.node.is_leader(), "a restarted laptop follows");
    wait_until("A catches up", Duration::from_secs(10), || {
        same_heads(&[&a, &b, &c]) && laps(&a) == 2
    });
    wait_until("the group is whole again", Duration::from_secs(10), || {
        all_healthy(&[&a, &b, &c])
    });
    assert_eq!(state(&a), state(&b));
    // Writes made on the restarted laptop work again.
    a.act("runners.create", json!({"name":"Lien"})).unwrap();
    wait_until("Lien everywhere", Duration::from_secs(5), || {
        [&a, &b, &c]
            .iter()
            .all(|s| s.count("SELECT COUNT(*) AS n FROM runners WHERE name='Lien'") == 1)
    });
    // The group clock: followers measured the leader, offsets on one machine stay near zero.
    assert!(super::clock::offset().abs() < 50);
}

#[test]
fn a_cut_off_leader_saves_nothing_and_takes_the_majority_data_when_it_returns() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    assert!(a.node.is_leader());
    a.node
        .isolated
        .store(true, std::sync::atomic::Ordering::Relaxed);
    // The cut-off leader cannot reach a second laptop: the press is refused, never silently kept.
    let refused = a.act("runners.create", json!({"name":"Alleen op A"}));
    assert!(refused.is_err(), "{refused:?}");
    wait_until("B and C elect a leader", Duration::from_secs(10), || {
        leader_index(&[&b, &c]).is_some()
    });
    b.act("runners.create", json!({"name":"Op de meerderheid"}))
        .unwrap();
    assert_eq!(a.status()["writable"], false);
    // The cable is back: A follows the new leader, its unconfirmed write is gone and it has the majority's data.
    a.node
        .isolated
        .store(false, std::sync::atomic::Ordering::Relaxed);
    wait_until("A reconciles", Duration::from_secs(15), || {
        same_heads(&[&a, &b, &c])
            && a.count("SELECT COUNT(*) AS n FROM runners WHERE name='Op de meerderheid'") == 1
            && a.count("SELECT COUNT(*) AS n FROM runners WHERE name='Alleen op A'") == 0
    });
    wait_until("healthy again", Duration::from_secs(10), || {
        all_healthy(&[&a, &b, &c])
    });
    assert!(!a.node.is_leader());
}

#[test]
fn the_timing_laptop_goes_on_alone_by_itself_and_the_splits_join_again() {
    let _serial = serial();
    let dir = Dir::new();
    let tune = |c: &mut Config| c.auto_alone_after = Duration::from_millis(1_500);
    let a = TestServer::start_with(&dir.db("a"), free_port(), "Laptop A", tune);
    let b = TestServer::start_with(&dir.db("b"), free_port(), "Laptop B", tune);
    let c = TestServer::start_with(&dir.db("c"), free_port(), "Laptop C", tune);
    a.act("runners.create", json!({"name":"Zoë","status":"waiting"}))
        .unwrap();
    a.act("runners.create", json!({"name":"Wout","status":"waiting"}))
        .unwrap();
    b.act("cluster.joinGroup", json!({"url": a.url})).unwrap();
    c.act("cluster.joinGroup", json!({"url": a.url})).unwrap();
    wait_until("three healthy laptops", Duration::from_secs(10), || {
        all_healthy(&[&a, &b, &c])
    });
    // Timing opens on C: C clocks; a press on B is refused.
    c.act("cluster.openTiming", json!({"takeOver": false}))
        .unwrap();
    wait_until("B knows C times", Duration::from_secs(5), || {
        b.status()["timing"]["self"] == false
    });
    assert!(
        press(&b, "race.handoff")
            .unwrap_err()
            .contains("Timing staat open op Laptop C")
    );
    press(&c, "race.handoff").unwrap();

    // The router dies for C: after a while C goes on alone and keeps clocking.
    c.node
        .isolated
        .store(true, std::sync::atomic::Ordering::Relaxed);
    wait_until("C goes on alone", Duration::from_secs(15), || {
        c.status()["state"] == "solo"
    });
    assert_eq!(c.status()["split"]["rank"], 1);
    press(&c, "race.handoff").unwrap();
    // A and B keep a majority and save what is no lap (Timing is on C).
    wait_until("A and B elect", Duration::from_secs(10), || {
        leader_index(&[&a, &b]).is_some()
    });
    b.act("runners.create", json!({"name":"Alleen bij A en B"}))
        .unwrap();

    // The network returns: C's split holds the Timing laptop, so A and B follow it.
    c.node
        .isolated
        .store(false, std::sync::atomic::Ordering::Relaxed);
    wait_until("one group again", Duration::from_secs(20), || {
        let split = c.status()["split"]["id"].clone();
        [&a, &b].iter().all(|s| s.status()["split"]["id"] == split) && all_healthy(&[&a, &b, &c])
    });
    for server in [&a, &b] {
        assert_eq!(server.count("SELECT COUNT(*) AS n FROM laps"), 1);
        assert_eq!(
            server.count("SELECT COUNT(*) AS n FROM runners WHERE name='Alleen bij A en B'"),
            0
        );
    }
    // The laptop that led the other split says what it gave up, and where it went.
    let notices: Vec<Value> = [&a, &b]
        .iter()
        .map(|s| s.status()["notice"].clone())
        .collect();
    assert!(
        notices.iter().any(|n| n
            .as_str()
            .is_some_and(|n| n.contains("werkte even apart") && n.contains("backup"))),
        "{notices:?}"
    );
    assert!(c.node.is_leader());
}

#[test]
fn a_lost_laptop_is_taken_out_and_a_spare_takes_its_place() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    let c_id = c.status()["hostId"].as_str().unwrap().to_owned();
    let (c_path, c_port) = (dir.db("c"), c.port);
    c.kill();
    // Refused while it was only briefly away.
    assert!(
        a.act("cluster.removeLaptop", json!({"hostId": c_id}))
            .is_err()
    );
    wait_until("C is removable", Duration::from_secs(10), || {
        a.status()["members"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["hostId"] == c_id.as_str() && m["removable"] == true)
    });
    // Pressed on the follower B: forwarded to the leader.
    assert!(
        b.act("cluster.removeLaptop", json!({"hostId": c_id}))
            .unwrap()["name"]
            == "Laptop C"
    );
    wait_until("two laptops", Duration::from_secs(5), || {
        b.count("SELECT COUNT(*) AS n FROM cluster_members") == 2
    });
    let d = TestServer::start(&dir.db("d"), free_port(), "Laptop D");
    d.act("cluster.joinGroup", json!({"url": b.url})).unwrap();
    wait_until("the spare is in", Duration::from_secs(10), || {
        all_healthy(&[&a, &b, &d])
    });
    // The removed laptop comes back on: it is not taken back by itself and says so.
    let c = TestServer::start(&c_path, c_port, "Laptop C");
    wait_until("C hears it was removed", Duration::from_secs(10), || {
        !c.status()["removedFrom"].is_null()
    });
    assert_eq!(
        c.act("runners.create", json!({"name":"X"})).unwrap_err(),
        super::REMOVED_MESSAGE
    );
    assert_eq!(a.status()["members"].as_array().unwrap().len(), 3);
    // Opnieuw koppelen takes it back in with the group's data.
    c.act("cluster.joinGroup", json!({"url": a.url, "rejoin": true}))
        .unwrap();
    wait_until("four laptops", Duration::from_secs(10), || {
        all_healthy(&[&a, &b, &c, &d])
    });
}

#[test]
fn simultaneous_presses_on_both_laptops_link_once_and_merge_the_registrations() {
    let _serial = serial();
    let dir = Dir::new();
    let a = TestServer::start(&dir.db("a"), free_port(), "Laptop A");
    let b = TestServer::start(&dir.db("b"), free_port(), "Laptop B");
    a.act("runners.create", json!({"name":"Zoë","runnerNumber":"7"}))
        .unwrap();
    b.act("runners.create", json!({"name":"Jan","runnerNumber":"7"}))
        .unwrap();
    b.act("runners.create", json!({"name":" zoë "})).unwrap();
    let (a_url, b_url) = (a.url.clone(), b.url.clone());
    std::thread::scope(|scope| {
        let pressed_a = scope.spawn(|| a.act("cluster.joinGroup", json!({"url": b_url})));
        let pressed_b = scope.spawn(|| b.act("cluster.joinGroup", json!({"url": a_url})));
        pressed_a.join().unwrap().unwrap();
        pressed_b.join().unwrap().unwrap();
    });
    wait_until("one group of two", Duration::from_secs(10), || {
        all_healthy(&[&a, &b])
    });
    assert_eq!(a.status()["clusterId"], b.status()["clusterId"]);
    for server in [&a, &b] {
        // Zoë once, Jan kept although his number was taken.
        assert_eq!(server.count("SELECT COUNT(*) AS n FROM runners"), 2);
        assert_eq!(
            server.count("SELECT COUNT(*) AS n FROM runners WHERE runner_number='7'"),
            1
        );
    }
}

#[test]
fn a_linked_database_without_the_runtime_still_refuses_writes() {
    let _serial = serial();
    let dir = Dir::new();
    let path = dir.db("a");
    {
        let a = TestServer::start(&path, free_port(), "Laptop A");
        let b = TestServer::start(&dir.db("b"), free_port(), "Laptop B");
        b.act("cluster.joinGroup", json!({"url": a.url})).unwrap();
        wait_until("linked", Duration::from_secs(10), || all_healthy(&[&a, &b]));
        a.kill();
        b.kill();
    }
    let mut db = Db::open(&path).unwrap();
    assert!(
        db.mutation("runners.create", &json!({"name":"Solo"}))
            .is_err()
    );
}

#[test]
fn snapshot_install_keeps_this_laptops_identity() {
    let source = Db::open(Path::new(":memory:")).unwrap();
    super::log::set_local(&source, "replication_cluster_id", "group").unwrap();
    super::log::set_local(&source, "host_id", "leader").unwrap();
    source.exec("INSERT INTO runners(id,name,status,registration_source,created_at,updated_at) VALUES('r','Zoë','registered','manual',1,1)", &[]).unwrap();
    let image = super::log::serialize(&source).unwrap();
    let mut target = Db::open(Path::new(":memory:")).unwrap();
    super::log::set_local(&target, "host_id", "me").unwrap();
    assert_eq!(super::log::install(&mut target, &image).unwrap(), "group");
    assert_eq!(
        super::log::setting(&target, "host_id").as_deref(),
        Some("me")
    );
    assert_eq!(target.runners().unwrap().len(), 1);
}

fn activity_summaries(server: &TestServer) -> Vec<String> {
    server
        .db
        .lock()
        .unwrap()
        .rows("SELECT summary FROM activity_log ORDER BY occurred_at", &[])
        .unwrap()
        .into_iter()
        .filter_map(|r| r["summary"].as_str().map(str::to_owned))
        .collect()
}

#[test]
fn restore_and_clear_replace_the_data_on_every_linked_laptop_after_a_safety_copy_on_the_leader() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    // A backup on follower B holds one runner.
    let backup = crate::backups::create_reason(&dir.db("b"), "manual").unwrap();
    for name in ["Wout", "Mitras"] {
        c.act("runners.create", json!({"name": name})).unwrap();
    }
    wait_until("three runners everywhere", Duration::from_secs(5), || {
        [&a, &b, &c]
            .iter()
            .all(|s| s.count("SELECT COUNT(*) AS n FROM runners") == 3)
    });
    // Restore pressed on B: B reads its backup, the leader keeps a safety copy and replaces the data everywhere.
    let restored = b
        .act("backups.restore", json!({"fileName": backup["fileName"]}))
        .unwrap();
    assert_eq!(restored["runners"], 1);
    let safety = restored["safetyBackup"].as_str().unwrap().to_owned();
    assert!(safety.contains("-pre-restore-"));
    // The safety copy is on the laptop that led the write, whichever that was.
    let keeper = [("a", &a), ("b", &b), ("c", &c)]
        .into_iter()
        .find(|(_, s)| restored["safetyHostUrl"] == json!(s.url))
        .expect("the safety copy names a laptop of the group");
    assert!(
        crate::backups::file(&dir.db(keeper.0), &safety).is_ok(),
        "the safety copy is on the leader"
    );
    wait_until("the restore is everywhere", Duration::from_secs(5), || {
        same_heads(&[&a, &b, &c])
            && [&a, &b, &c]
                .iter()
                .all(|s| s.count("SELECT COUNT(*) AS n FROM runners") == 1)
    });
    // The group itself survives a restore.
    wait_until("healthy after the restore", Duration::from_secs(5), || {
        all_healthy(&[&a, &b, &c])
    });
    // Clearing everything, pressed on C.
    let cleared = c.act("race.clear", json!({"runners": true})).unwrap();
    assert!(
        cleared["safetyBackup"]
            .as_str()
            .unwrap()
            .contains("-pre-clear-")
    );
    wait_until("cleared everywhere", Duration::from_secs(5), || {
        [&a, &b, &c]
            .iter()
            .all(|s| s.count("SELECT COUNT(*) AS n FROM runners") == 0)
    });
}

#[test]
fn an_unreachable_laptop_and_its_return_are_listed_in_activity_on_every_laptop() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    let (c_path, c_port) = (dir.db("c"), c.port);
    c.kill();
    wait_until("listed as unreachable", Duration::from_secs(10), || {
        activity_summaries(&b)
            .iter()
            .any(|s| s == "Laptop C is niet bereikbaar")
    });
    let c = TestServer::start(&c_path, c_port, "Laptop C");
    wait_until("listed as back", Duration::from_secs(10), || {
        [&a, &b, &c].iter().all(|s| {
            activity_summaries(s)
                .iter()
                .any(|s| s == "Laptop C is weer bereikbaar")
        })
    });
    assert_eq!(
        activity_summaries(&a)
            .iter()
            .filter(|s| s.as_str() == "Laptop C is niet bereikbaar")
            .count(),
        1
    );
}

fn beacon(server: &TestServer, url: &str, name: &str) -> Value {
    let status = server.status();
    json!({
        "app": "apolloon", "hostId": status["hostId"], "name": name, "clusterId": status["clusterId"],
        "url": url, "appVersion": super::APP_VERSION, "schemaVersion": 17, "leader": server.node.is_leader(),
        "groupSize": status["members"].as_array().unwrap().len(), "runners": status["runners"],
        "changed": status["changed"], "raceStarted": status["raceStarted"], "raceRunning": status["raceRunning"],
    })
}
fn hear(listener: &TestServer, beacon: &Value) {
    listener
        .node
        .discovery
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .hear(beacon);
}

#[test]
fn the_leader_stores_the_address_and_name_a_laptop_announces() {
    let _serial = serial();
    let dir = Dir::new();
    let a = TestServer::start(&dir.db("a"), free_port(), "Laptop A");
    let b = TestServer::start(&dir.db("b"), free_port(), "Laptop B");
    b.act("cluster.joinGroup", json!({"url": a.url})).unwrap();
    wait_until("linked", Duration::from_secs(10), || all_healthy(&[&a, &b]));
    // Whichever laptop ended up leading stores what the other one announces.
    let (a, b) = if a.node.is_leader() { (a, b) } else { (b, a) };
    let b_id = b.status()["hostId"].as_str().unwrap().to_owned();
    // B is now announced under another address (a new lease) and a new computer name.
    let moved = format!("http://localhost:{}", b.port);
    hear(&a, &beacon(&b, &moved, "Nieuwe naam"));
    let stored = |s: &TestServer| {
        s.db.lock().unwrap().one("SELECT m.url, n.name FROM cluster_members m LEFT JOIN cluster_member_names n USING(host_id) WHERE host_id=?", &[json!(b_id)]).unwrap()
    };
    wait_until(
        "the new address is stored on both laptops",
        Duration::from_secs(10),
        || {
            [&a, &b]
                .iter()
                .all(|s| stored(s)["url"] == json!(moved) && stored(s)["name"] == "Nieuwe naam")
        },
    );
    assert!(
        activity_summaries(&a)
            .iter()
            .any(|s| s == &format!("Nieuwe naam heeft een nieuw adres: localhost:{}", b.port))
    );
    // Replication keeps working at the new address.
    a.act("runners.create", json!({"name":"Zoë"})).unwrap();
    wait_until("healthy", Duration::from_secs(5), || all_healthy(&[&a, &b]));
}

#[test]
fn a_fresh_laptop_links_by_itself_and_the_group_says_so() {
    let _serial = serial();
    let dir = Dir::new();
    let a = TestServer::start(&dir.db("a"), free_port(), "Laptop A");
    let b = TestServer::start_with(&dir.db("b"), free_port(), "Laptop B", |c| {
        c.auto_link = true
    });
    a.act("runners.create", json!({"name":"Zoë"})).unwrap();
    hear(&b, &beacon(&a, &a.url, "Laptop A"));
    assert_eq!(b.status()["nearby"][0]["link"], "join");
    wait_until("B linked by itself", Duration::from_secs(10), || {
        all_healthy(&[&a, &b])
    });
    for server in [&a, &b] {
        let linked = server.status()["autoLink"]["linked"].clone();
        assert_eq!(linked[0]["name"], "Laptop B", "{linked}");
        assert_eq!(linked[0]["with"], "Laptop A");
    }
    assert!(
        activity_summaries(&a)
            .iter()
            .any(|s| s == "Laptop B vanzelf gekoppeld met Laptop A")
    );
    assert_eq!(b.count("SELECT COUNT(*) AS n FROM runners"), 1);
}
