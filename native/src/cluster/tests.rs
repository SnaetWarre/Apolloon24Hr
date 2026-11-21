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
    linked_three_with(dir, |_| {})
}

fn linked_three_with(
    dir: &Dir,
    tune: impl Fn(&mut Config) + Copy,
) -> (TestServer, TestServer, TestServer) {
    let a = TestServer::start_with(&dir.db("a"), free_port(), "Laptop A", tune);
    let b = TestServer::start_with(&dir.db("b"), free_port(), "Laptop B", tune);
    let c = TestServer::start_with(&dir.db("c"), free_port(), "Laptop C", tune);
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
fn frozen_leader_does_not_hold_up_an_election_or_a_timing_press() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three_with(&dir, |cfg| {
        cfg.election_timeout = Duration::from_secs(1);
    });
    b.act("runners.create", json!({"name":"Wout","status":"waiting"}))
        .unwrap();
    press(&b, "race.handoff").unwrap();
    press(&b, "race.handoff").unwrap();
    let laps = |s: &TestServer| s.db.lock().unwrap().history().unwrap()["laps"].clone();
    let before = laps(&b);
    let term = a.node.term();
    assert_eq!(before.as_array().unwrap().len(), 1);
    wait_until("the first lap on all laptops", Duration::from_secs(2), || {
        [&a, &c].iter().all(|s| laps(s) == before)
    });

    // The server keeps accepting TCP connections, but cannot answer votes or writes.
    {
        let _frozen = a.node.raft.lock().unwrap();
        std::thread::sleep(a.node.cfg.heartbeat * 3);
        for follower in [&b, &c] {
            assert_eq!(follower.node.term(), term);
            assert_eq!(follower.status()["leader"]["hostId"], a.node.host_id);
        }
    }
    wait_until("three healthy laptops", Duration::from_secs(2), || {
        all_healthy(&[&a, &b, &c])
    });

    std::thread::scope(|scope| {
        let _frozen = a.node.raft.lock().unwrap();
        let deadline = Instant::now() + Duration::from_millis(2_800);
        let (send, saved) = std::sync::mpsc::channel();
        let follower = &b;
        scope.spawn(move || {
            let _ = send.send(press(follower, "race.handoff"));
        });
        while leader_index(&[&b, &c]).is_none() {
            assert!(Instant::now() < deadline, "the frozen peer delayed the election");
            std::thread::sleep(Duration::from_millis(25));
        }
        saved
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("the press waited for the frozen leader's HTTP response")
            .unwrap();
    });

    let after = laps(&b);
    let after = after.as_array().unwrap();
    assert_eq!(after.len(), 2);
    assert!(after.contains(&before[0]));
    wait_until("the same two laps on all laptops", Duration::from_secs(5), || {
        [&a, &c].iter().all(|s| laps(s).as_array() == Some(after))
    });
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
fn a_write_the_majority_never_confirmed_is_not_kept_on_the_leader() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    assert!(a.node.is_leader());
    let off = |s: &TestServer, v: bool| {
        s.node
            .isolated
            .store(v, std::sync::atomic::Ordering::Relaxed)
    };
    let named = |s: &TestServer, name: &str| {
        s.count(&format!(
            "SELECT COUNT(*) AS n FROM runners WHERE name='{name}'"
        ))
    };
    let head = a.head();
    off(&b, true);
    off(&c, true);
    let refused = a.act("runners.create", json!({"name":"Onbevestigd"}));
    let answer = refused.unwrap_err();
    assert!(
        [super::NOT_CONFIRMED_MESSAGE, super::NO_LEADER_MESSAGE].contains(&answer.as_str()),
        "{answer}"
    );
    // The leader's own data, which its screens read, never held the write.
    assert_eq!(named(&a, "Onbevestigd"), 0);
    assert_eq!(a.head(), head);
    let state: Value = reqwest::blocking::get(format!("{}/api/state", a.url))
        .unwrap()
        .json()
        .unwrap();
    assert!(!state.to_string().contains("Onbevestigd"));

    // A press on the Timing laptop is the exception: the lap stays, also without the others.
    a.act("runners.create", json!({"name":"Te laat"})).unwrap_err();
    off(&b, false);
    off(&c, false);
    wait_until("the group works again", Duration::from_secs(15), || {
        all_healthy(&[&a, &b, &c]) && same_heads(&[&a, &b, &c])
    });
    let timing = [&a, &b, &c][leader_index(&[&a, &b, &c]).unwrap()];
    let others: Vec<&TestServer> = [&a, &b, &c]
        .into_iter()
        .filter(|s| s.port != timing.port)
        .collect();
    for name in ["Zoë", "Wout"] {
        timing
            .act("runners.create", json!({"name":name,"status":"waiting"}))
            .unwrap();
    }
    timing
        .act("cluster.openTiming", json!({"takeOver": false}))
        .unwrap();
    press(timing, "race.handoff").unwrap();
    off(others[0], true);
    off(others[1], true);
    let _ = press(timing, "race.handoff");
    assert_eq!(timing.count("SELECT COUNT(*) AS n FROM laps"), 1);
    assert_eq!(named(timing, "Te laat"), 0);

    // The others return: the write that was answered as not saved appears nowhere.
    off(others[0], false);
    off(others[1], false);
    wait_until("the group works again", Duration::from_secs(20), || {
        all_healthy(&[&a, &b, &c]) && same_heads(&[&a, &b, &c])
    });
    let leader = [&a, &b, &c][leader_index(&[&a, &b, &c]).unwrap()];
    leader
        .act("runners.create", json!({"name":"Bevestigd"}))
        .unwrap();
    wait_until("every laptop holds the next write", Duration::from_secs(5), || {
        same_heads(&[&a, &b, &c]) && [&a, &b, &c].iter().all(|s| named(s, "Bevestigd") == 1)
    });
    for server in [&a, &b, &c] {
        assert_eq!(named(server, "Onbevestigd"), 0);
        assert_eq!(named(server, "Te laat"), 0);
    }
}

/// A leader that inherits an unconfirmed change from an earlier term may not call it saved
/// before a change of its own term is on a majority: until then a laptop that led in between
/// can still win and replace it.
#[test]
fn a_change_answered_as_saved_survives_three_leader_losses_in_a_row() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    assert!(a.node.is_leader());
    let off = |s: &TestServer, v: bool| {
        s.node
            .isolated
            .store(v, std::sync::atomic::Ordering::Relaxed)
    };
    // A change a leader stored in its own data and could not send on, like a Timing press.
    let store_unsent = |s: &TestServer, key: &str| {
        super::log::record(&mut s.db.lock().unwrap(), "test.unsent", None, |db| {
            super::log::set_replicated(db, key, &json!(true)).map(|_| Value::Null)
        })
        .unwrap();
    };
    let holds = |s: &TestServer, key: &str| {
        super::log::setting(&s.db.lock().unwrap(), key).is_some()
    };
    let first_term = a.node.term();
    let place = a.head() + 1;

    // 1. Leader A stores a change and fails before another laptop has it.
    off(&a, true);
    off(&b, true);
    store_unsent(&a, "from-a");
    assert_eq!(a.head(), place);

    // 2. B wins the next term with C's vote, stores a change at the same place and fails before
    //    sending anything. Written as what that election and write leave on disk, so that B
    //    fails at exactly that moment.
    for server in [&b, &c] {
        let db = server.db.lock().unwrap();
        super::log::set_local(&db, "cluster_epoch", &(first_term + 1).to_string()).unwrap();
        super::log::set_local(
            &db,
            "cluster_voted_for",
            &format!("{}:{}", first_term + 1, b.node.host_id),
        )
        .unwrap();
    }
    store_unsent(&b, "from-b");
    assert_eq!(b.head(), place);

    // 3. A returns, wins with C's vote, copies its old change to C and reports the group settled.
    off(&a, false);
    wait_until("A leads again and its log is on a majority", Duration::from_secs(15), || {
        a.node.is_leader() && a.node.term() > first_term + 1 && a.node.log_settled()
    });
    assert!(holds(&c, "from-a"));

    // 4. A fails again and B returns.
    off(&a, true);
    off(&b, false);
    wait_until("B and C work together", Duration::from_secs(20), || {
        leader_index(&[&b, &c]).is_some() && same_heads(&[&b, &c])
    });

    // 5. Whichever of the two leads, the change that was reported as saved is still there.
    for server in [&b, &c] {
        assert!(holds(server, "from-a"), "the saved change is gone");
        assert!(!holds(server, "from-b"));
    }
    off(&a, false);
    wait_until("three healthy laptops", Duration::from_secs(20), || {
        all_healthy(&[&a, &b, &c]) && same_heads(&[&a, &b, &c])
    });
    for server in [&a, &b, &c] {
        assert!(holds(server, "from-a"));
        assert!(!holds(server, "from-b"));
    }
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
    b.act(
        "runners.create",
        json!({"name":"Alleen bij A en B", "runnerNumber":"88"}),
    )
    .unwrap();
    // C hands out the same number meanwhile, to someone else.
    c.act(
        "runners.create",
        json!({"name":"Alleen bij C", "runnerNumber":"88"}),
    )
    .unwrap();

    // B also sends Wout back to the registrations, not knowing C just put Wout on the track.
    let wout = b.db.lock().unwrap().rows("SELECT id FROM runners WHERE name='Wout'", &[]).unwrap()
        [0]["id"]
        .clone();
    b.act("runners.setStatus", json!({"id": wout, "status": "registered"}))
        .unwrap();

    // The network returns: C's split holds the Timing laptop, so A and B follow it, and C
    // first takes what A and B saved meanwhile.
    c.node
        .isolated
        .store(false, std::sync::atomic::Ordering::Relaxed);
    wait_until("one group again", Duration::from_secs(20), || {
        let split = c.status()["split"]["id"].clone();
        [&a, &b].iter().all(|s| s.status()["split"]["id"] == split) && all_healthy(&[&a, &b, &c])
    });
    for server in [&a, &b, &c] {
        // The lap the Timing laptop clocked alone stays, and so does the runner it put on the track.
        assert_eq!(server.count("SELECT COUNT(*) AS n FROM laps"), 1);
        assert_eq!(
            server
                .count("SELECT COUNT(*) AS n FROM runners WHERE name='Wout' AND status='running'"),
            1
        );
        // What the majority confirmed while C was away is kept, once: also the runner whose
        // number C gave to someone else meanwhile, who comes in without that number.
        assert_eq!(
            server.count(
                "SELECT COUNT(*) AS n FROM runners WHERE name='Alleen bij A en B' AND runner_number IS NULL"
            ),
            1
        );
        assert_eq!(
            server.count(
                "SELECT COUNT(*) AS n FROM runners WHERE name='Alleen bij C' AND runner_number='88'"
            ),
            1
        );
    }
    // The laptops that followed say they worked apart, and where their own copy went.
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

/// The Timing laptop loses the other two and the handoff is pressed in the same moment.
fn press_right_after_the_timing_laptop_is_cut_off(timing_leads: bool) {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    a.act("runners.create", json!({"name":"Wout","status":"waiting"}))
        .unwrap();
    let (timing, others) = if timing_leads { (&a, [&b, &c]) } else { (&c, [&a, &b]) };
    assert_eq!(timing.node.is_leader(), timing_leads);
    timing
        .act("cluster.openTiming", json!({"takeOver": false}))
        .unwrap();
    press(timing, "race.handoff").unwrap();
    wait_until("the start on every laptop", Duration::from_secs(5), || {
        same_heads(&[&a, &b, &c])
    });

    timing
        .node
        .isolated
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let race = timing.db.lock().unwrap().race().unwrap();
    let pressed_at = crate::db::now();
    let pressed = Instant::now();
    timing
        .act(
            "race.handoff",
            json!({"activeRunnerId":race["activeRunnerId"],"activeStartedAt":race["activeStartedAt"],"pressedAt":pressed_at}),
        )
        .expect("a press right after the outage began was refused");
    // Well inside the time a write may wait, and long before the laptop goes on alone unasked.
    assert!(
        pressed.elapsed() < timing.node.cfg.write_deadline / 2,
        "the press took {:?}",
        pressed.elapsed()
    );
    assert_eq!(timing.count("SELECT COUNT(*) AS n FROM laps"), 1);
    assert_eq!(
        timing.count("SELECT finished_at AS n FROM laps"),
        pressed_at,
        "the lap ends when the key was pressed"
    );
    assert_eq!(timing.status()["state"], "solo");
    // It keeps clocking, and the others take its laps when the network is back.
    press(timing, "race.handoff").unwrap();
    timing
        .node
        .isolated
        .store(false, std::sync::atomic::Ordering::Relaxed);
    wait_until("one group again", Duration::from_secs(20), || {
        let split = timing.status()["split"]["id"].clone();
        others.iter().all(|s| s.status()["split"]["id"] == split) && all_healthy(&[&a, &b, &c])
    });
    for server in others {
        assert_eq!(server.count("SELECT COUNT(*) AS n FROM laps"), 2);
    }
}

#[test]
fn a_press_right_after_the_timing_laptop_is_cut_off_is_kept() {
    press_right_after_the_timing_laptop_is_cut_off(false);
}

#[test]
fn a_press_right_after_the_leading_timing_laptop_is_cut_off_is_kept() {
    press_right_after_the_timing_laptop_is_cut_off(true);
}

/// The leader fails while the Timing laptop still reaches a second laptop: the press waits for
/// the takeover and the group stays whole.
#[test]
fn a_press_during_a_takeover_does_not_split_the_group() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    a.act("runners.create", json!({"name":"Wout","status":"waiting"}))
        .unwrap();
    c.act("cluster.openTiming", json!({"takeOver": false}))
        .unwrap();
    press(&c, "race.handoff").unwrap();
    wait_until("the start on every laptop", Duration::from_secs(5), || {
        same_heads(&[&a, &b, &c])
    });
    a.kill();
    press(&c, "race.handoff").unwrap();
    assert_eq!(c.status()["split"]["rank"], 0);
    assert_eq!(c.status()["members"].as_array().unwrap().len(), 3);
    wait_until("the lap on B", Duration::from_secs(5), || {
        b.count("SELECT COUNT(*) AS n FROM laps") == 1
    });
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
fn a_spare_that_links_replaces_a_dead_laptop_and_the_group_survives_one_more_loss() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    let c_id = c.status()["hostId"].as_str().unwrap().to_owned();
    let (c_path, c_port) = (dir.db("c"), c.port);
    c.kill();
    wait_until("C is removable", Duration::from_secs(10), || {
        [&a, &b].iter().any(|s| {
            s.status()["members"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["hostId"] == c_id.as_str() && m["removable"] == true)
        })
    });
    // Nobody clicks "Uit de groep halen": the spare links and takes the dead laptop's place.
    let d = TestServer::start(&dir.db("d"), free_port(), "Laptop D");
    d.act("cluster.joinGroup", json!({"url": b.url})).unwrap();
    wait_until("three laptops again", Duration::from_secs(10), || {
        all_healthy(&[&a, &b, &d])
    });
    for server in [&a, &b, &d] {
        assert_eq!(
            server.count("SELECT COUNT(*) AS n FROM cluster_members"),
            3
        );
    }
    assert!(
        activity_summaries(&a)
            .iter()
            .any(|s| s == "Laptop C uit de groep gehaald")
    );
    // One more laptop drops out: the two that are left are a majority of three and save.
    let (gone, left) = if a.node.is_leader() {
        (&a, [&b, &d])
    } else {
        (&b, [&a, &d])
    };
    gone.node
        .isolated
        .store(true, std::sync::atomic::Ordering::Relaxed);
    wait_until(
        "a leader among the two left",
        Duration::from_secs(10),
        || leader_index(&left).is_some(),
    );
    left[0].act("runners.create", json!({"name":"Na"})).unwrap();
    wait_until("the write is on both", Duration::from_secs(5), || {
        left.iter()
            .all(|s| s.count("SELECT COUNT(*) AS n FROM runners WHERE name='Na'") == 1)
    });
    // The replaced laptop comes back on: it is told it was taken out, as after the button.
    let c = TestServer::start(&c_path, c_port, "Laptop C");
    wait_until("C hears it was removed", Duration::from_secs(10), || {
        !c.status()["removedFrom"].is_null()
    });
}

#[test]
fn a_spare_that_links_while_every_laptop_answers_makes_the_group_one_larger() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    let d = TestServer::start(&dir.db("d"), free_port(), "Laptop D");
    d.act("cluster.joinGroup", json!({"url": a.url})).unwrap();
    wait_until("four laptops", Duration::from_secs(10), || {
        all_healthy(&[&a, &b, &c, &d])
    });
}

#[test]
fn the_retaining_laptop_reports_the_registration_merge() {
    let _serial = serial();
    let dir = Dir::new();
    let a = TestServer::start(&dir.db("a"), free_port(), "Laptop A");
    let b = TestServer::start(&dir.db("b"), free_port(), "Laptop B");
    for name in ["Zoë", "Jan"] {
        a.act("runners.create", json!({"name":name})).unwrap();
    }
    b.act("runners.create", json!({"name":"Fien"})).unwrap();
    let answer = a.act("cluster.joinGroup", json!({"url":b.url})).unwrap();
    assert_eq!(answer["merged"], true);
    assert!(answer["backupFile"].is_null());
    wait_until("merged registrations", Duration::from_secs(10), || {
        [&a, &b].iter().all(|s| s.count("SELECT COUNT(*) AS n FROM runners") == 3)
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

pub(crate) fn beacon(server: &TestServer, url: &str, name: &str) -> Value {
    let status = server.status();
    let proof = super::beacon_proof(
        &server.node.group_keys()[0],
        status["hostId"].as_str().unwrap(),
        url,
    );
    json!({
        "app": "apolloon", "hostId": status["hostId"], "name": name, "clusterId": status["clusterId"],
        "url": url, "proof": proof, "appVersion": super::APP_VERSION, "schemaVersion": 17, "leader": server.node.is_leader(),
        "groupSize": status["members"].as_array().unwrap().len(), "runners": status["runners"],
        "changed": status["changed"], "raceStarted": status["raceStarted"], "raceRunning": status["raceRunning"],
    })
}
pub(crate) fn hear(listener: &TestServer, beacon: &Value) {
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

#[test]
fn the_group_test_sees_a_mark_arrive_and_leave_on_every_laptop() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    let runners = |s: &TestServer| s.count("SELECT COUNT(*) AS n FROM runners");
    let before = [runners(&a), runners(&b), runners(&c)];

    // Started on a follower: the mark goes through the leader and every laptop reports it.
    let result = c.act("cluster.testGroup", json!({})).unwrap();
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!((result["reached"].as_i64(), result["total"].as_i64()), (Some(3), Some(3)));
    assert_eq!(result["inStep"], true);
    for laptop in result["laptops"].as_array().unwrap() {
        assert!(laptop["addedMs"].as_u64().is_some() && laptop["removedMs"].as_u64().is_some());
    }
    // Nothing is left behind, and no race data changed.
    wait_until("the mark is gone everywhere", Duration::from_secs(5), || {
        [&a, &b, &c].iter().all(|s| {
            s.count("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'cluster_probe:%'") == 0
        })
    });
    assert_eq!([runners(&a), runners(&b), runners(&c)], before);

    // A laptop that is off is reported as not reached; the others still pass.
    c.kill();
    let result = a.act("cluster.testGroup", json!({})).unwrap();
    assert_eq!(result["ok"], false);
    assert_eq!(result["reached"], 2);
    let missing: Vec<_> = result["laptops"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|l| l["ok"] != true)
        .map(|l| l["name"].clone())
        .collect();
    assert_eq!(missing, vec![json!("Laptop C")]);
}

/// Three linked laptops where A leads and gives `stale` as its own address.
fn linked_three_led_by_a_stale_address(
    dir: &Dir,
    stale: impl Fn(u16) -> String,
) -> (TestServer, TestServer, TestServer) {
    let port = free_port();
    let stale = stale(port);
    let a = TestServer::start_with(&dir.db("a"), port, "Laptop A", |c| c.self_url = stale);
    let b = TestServer::start(&dir.db("b"), free_port(), "Laptop B");
    let c = TestServer::start(&dir.db("c"), free_port(), "Laptop C");
    a.act("runners.create", json!({"name":"Zoë","status":"waiting"}))
        .unwrap();
    b.act("cluster.joinGroup", json!({"url": a.url})).unwrap();
    c.act("cluster.joinGroup", json!({"url": a.url})).unwrap();
    (a, b, c)
}
fn followers_save(a: &TestServer, b: &TestServer, c: &TestServer) {
    wait_until("three healthy laptops", Duration::from_secs(10), || {
        all_healthy(&[a, b, c])
    });
    assert!(a.node.is_leader());
    for (follower, name) in [(b, "Op B"), (c, "Op C")] {
        follower
            .act("runners.create", json!({"name": name}))
            .unwrap();
    }
    wait_until(
        "every laptop has both runners",
        Duration::from_secs(5),
        || {
            same_heads(&[a, b, c])
                && [a, b, c].iter().all(|s| {
                    s.count("SELECT COUNT(*) AS n FROM runners WHERE name IN ('Op B','Op C')") == 2
                })
        },
    );
}

#[test]
fn followers_save_through_a_leader_that_started_before_its_network_was_up() {
    let _serial = serial();
    let dir = Dir::new();
    // A started without a network and still gives the address it had then.
    let (a, b, c) = linked_three_led_by_a_stale_address(&dir, |_| "http://localhost:1".into());
    for s in [&b, &c] {
        hear(s, &beacon(&a, &a.url, "Laptop A"));
    }
    followers_save(&a, &b, &c);
}

#[test]
fn followers_save_through_a_leader_whose_announcements_do_not_arrive() {
    let _serial = serial();
    let dir = Dir::new();
    // A gives the address it had on another network; nobody hears it announce the new one.
    let (a, b, c) =
        linked_three_led_by_a_stale_address(&dir, |port| format!("http://192.0.2.1:{port}"));
    followers_save(&a, &b, &c);
}

#[test]
fn followers_keep_saving_after_the_leader_gets_another_address() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    let (a, b, c) = match leader_index(&[&a, &b, &c]).unwrap() {
        0 => (a, b, c),
        1 => (b, a, c),
        _ => (c, a, b),
    };
    b.act("runners.create", json!({"name":"Voor"})).unwrap();
    // The leader moves to another network while the app keeps running.
    let moved = format!("http://localhost:{}", a.port);
    a.node.set_self_url(&moved);
    let a_id = a.status()["hostId"].as_str().unwrap().to_owned();
    wait_until(
        "every laptop stores the leader's new address",
        Duration::from_secs(10),
        || {
            [&a, &b, &c].iter().all(|s| {
                s.db.lock()
                    .unwrap()
                    .one(
                        "SELECT url FROM cluster_members WHERE host_id=?",
                        &[json!(a_id)],
                    )
                    .is_ok_and(|row| row["url"] == json!(moved))
            })
        },
    );
    assert!(a.node.is_leader());
    assert_eq!(a.status()["leader"]["url"], json!(moved));
    followers_save(&a, &b, &c);
}

#[test]
fn an_announcement_from_elsewhere_does_not_replace_the_address_the_leader_connects_from() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, _c) = linked_three(&dir);
    let a_id = a.status()["hostId"].as_str().unwrap().to_owned();
    hear(&b, &beacon(&a, "http://192.0.2.9:5173", "Laptop A"));
    let from = Some(std::net::IpAddr::from(std::net::Ipv4Addr::LOCALHOST));
    assert_eq!(b.node.leader_address(&a_id, &a.url, from), a.url);
    assert_eq!(b.node.leader_address(&a_id, &a.url, None), a.url);
}

#[test]
fn a_leader_that_gets_the_stored_address_of_another_laptop_keeps_that_laptop_in_the_group() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    let (a, b, c) = match leader_index(&[&a, &b, &c]).unwrap() {
        0 => (a, b, c),
        1 => (b, a, c),
        _ => (c, a, b),
    };
    let a_id = a.status()["hostId"].as_str().unwrap().to_owned();
    a.node.set_self_url(&b.url);
    wait_until(
        "the leader stores its new address",
        Duration::from_secs(10),
        || {
            a.db.lock()
                .unwrap()
                .one("SELECT url FROM cluster_members WHERE host_id=?", &[json!(a_id)])
                .is_ok_and(|row| row["url"] == json!(b.url))
        },
    );
    assert_eq!(a.count("SELECT COUNT(*) AS n FROM cluster_members"), 3);
    drop(c);
}

#[test]
fn a_leader_at_the_stored_address_of_a_laptop_that_is_off_keeps_leading() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    let (a, b, c) = match leader_index(&[&a, &b, &c]).unwrap() {
        0 => (a, b, c),
        1 => (b, a, c),
        _ => (c, a, b),
    };
    let b_id = b.status()["hostId"].as_str().unwrap().to_owned();
    drop(b);
    let term = a.node.term();
    a.node
        .add_member(
            &super::Member {
                host_id: b_id.clone(),
                url: a.url.clone(),
                name: None,
            },
            None,
        )
        .unwrap();
    std::thread::sleep(Duration::from_secs(2));
    assert!(a.node.is_leader());
    assert_eq!(a.node.term(), term);
    let status = a.status();
    let off = status["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["hostId"] == json!(b_id))
        .unwrap();
    assert_eq!(off["reachable"], json!(false));
    let own = json!({"term": term, "leaderId": a.status()["hostId"], "leaderUrl": a.url});
    assert_eq!(a.node.handle_append(&own, None)["reason"], json!("self"));
    assert!(a.node.is_leader());
    c.act("runners.create", json!({"name":"Op C"})).unwrap();
}

/// A request the way another device on the network sends it: no group key.
fn unsigned(method: reqwest::Method, url: &str, body: Option<Value>) -> (u16, Value) {
    let mut request = reqwest::blocking::Client::new()
        .request(method, url)
        .header("x-apolloon-app-version", super::APP_VERSION);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().unwrap();
    (response.status().as_u16(), response.json().unwrap_or(Value::Null))
}

#[test]
fn a_device_outside_the_group_cannot_write_or_read_through_the_laptop_endpoints() {
    let _serial = serial();
    let dir = Dir::new();
    let (a, b, c) = linked_three(&dir);
    assert!(a.node.is_leader());
    // Linking gave all three the leader's key; none of them shows it.
    assert_eq!(a.node.group_keys()[0], b.node.group_keys()[0]);
    assert_eq!(a.node.group_keys()[0], c.node.group_keys()[0]);
    assert!(!a.status().to_string().contains(&a.node.group_keys()[0]));
    // It is in no backup and in no copy of the data either: both are the database, the key is not in it.
    let key = a.node.group_keys()[0].clone();
    let image = super::log::serialize(&a.db.lock().unwrap()).unwrap();
    assert!(!image.windows(key.len()).any(|w| w == key.as_bytes()));
    let status = a.status();
    let head = a.head();
    let runners = a.count("SELECT COUNT(*) AS n FROM runners");
    let append = json!({"type": "append", "body": {
        "clusterId": status["clusterId"], "split": status["split"]["id"], "term": a.node.term() + 5,
        "leaderId": "someone-else", "leaderUrl": "http://127.0.0.1:9",
    }});
    let write = json!({"method": "race.clear", "input": {}, "origin": "phone", "requestId": "r1"});
    for (method, target, path, body) in [
        (reqwest::Method::POST, &a, "/api/cluster/write", Some(write)),
        (reqwest::Method::POST, &b, "/api/cluster/peer", Some(append)),
        (reqwest::Method::GET, &a, "/api/cluster/snapshot", None),
        (reqwest::Method::GET, &a, "/api/cluster/probe?id=x", None),
        (reqwest::Method::POST, &a, "/api/cluster/split/common", Some(json!({"marks": []}))),
        (reqwest::Method::POST, &a, "/api/cluster/split/merge", Some(json!({}))),
    ] {
        let (code, answer) = unsigned(method, &format!("{}{path}", target.url), body);
        assert_eq!((code, &answer["code"]), (401, &json!("not_in_group")), "{path}");
    }
    // A signature made with another key is no better than none.
    let forged = reqwest::blocking::Client::new()
        .get(format!("{}/api/cluster/snapshot", a.url))
        .header(
            super::key::HEADER,
            super::key::sign("not-the-key", &[b"GET", b"/api/cluster/snapshot", b""]),
        )
        .send()
        .unwrap();
    assert_eq!(forged.status().as_u16(), 401);
    // Nobody outside the group tells a laptop to follow another group, or moves it once its
    // race started.
    let follow = json!({"url": "http://127.0.0.1:9", "clusterId": "other", "follow": status["clusterId"]});
    let (code, _) = unsigned(reqwest::Method::POST, &format!("{}/api/cluster/invite", b.url), Some(follow));
    assert_eq!(code, 409);
    press(&a, "race.handoff").unwrap();
    wait_until("the lap is everywhere", Duration::from_secs(5), || same_heads(&[&a, &b, &c]));
    let invite = json!({"url": "http://127.0.0.1:9", "clusterId": "other"});
    let (code, _) = unsigned(reqwest::Method::POST, &format!("{}/api/cluster/invite", c.url), Some(invite));
    assert_eq!(code, 409);
    // Nothing of that reached the group, and the laptops still save through each other.
    assert!(a.node.is_leader());
    assert_eq!(a.head(), head + 1);
    assert_eq!(a.count("SELECT COUNT(*) AS n FROM runners"), runners);
    c.act("runners.create", json!({"name": "Op C"})).unwrap();
    wait_until("healthy", Duration::from_secs(5), || all_healthy(&[&a, &b, &c]));
}

#[test]
fn an_announcement_without_the_group_key_does_not_move_a_laptop() {
    let _serial = serial();
    let dir = Dir::new();
    let a = TestServer::start(&dir.db("a"), free_port(), "Laptop A");
    let b = TestServer::start(&dir.db("b"), free_port(), "Laptop B");
    b.act("cluster.joinGroup", json!({"url": a.url})).unwrap();
    wait_until("linked", Duration::from_secs(10), || all_healthy(&[&a, &b]));
    let (a, b) = if a.node.is_leader() { (a, b) } else { (b, a) };
    let b_id = b.status()["hostId"].as_str().unwrap().to_owned();
    // Another device announces itself under B's id, at its own address.
    let elsewhere = format!("http://127.0.0.1:{}", free_port());
    let mut spoofed = beacon(&b, &elsewhere, "Laptop B");
    for proof in [Value::Null, json!(super::beacon_proof("not-the-key", &b_id, &elsewhere))] {
        spoofed["proof"] = proof;
        hear(&a, &spoofed);
        a.node.maintain();
        let address = |s: &TestServer| {
            s.node.members().into_iter().find(|m| m.host_id == b_id).unwrap().url
        };
        assert_eq!(address(&a), b.url);
        assert_eq!(
            a.node.leader_address(&b_id, &b.url, Some("127.0.0.1".parse().unwrap())),
            b.url
        );
    }
    a.act("runners.create", json!({"name":"Zoë"})).unwrap();
    wait_until("healthy", Duration::from_secs(5), || all_healthy(&[&a, &b]));
    assert_eq!(b.count("SELECT COUNT(*) AS n FROM runners"), 1);
}
