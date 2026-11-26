//! Three (or more) real Rust servers in this process, each on a free port with its own SQLite
//! file, linked over HTTP: link, replicated writes, killing the leader, failover, restart and
//! catch-up, a partition and its reconciliation, going on alone and replacing a lost laptop.
use super::{Config, Node};
use crate::db::Db;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
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


mod addresses;
mod discovery;
mod failover;
mod maintenance;
mod membership;
mod replication;
mod safety;
mod security;
mod timing;
