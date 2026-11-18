//! LAN presence. Beacons are advisory and never authorize a join or a write.
use crate::db::Db;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    net::{Ipv4Addr, SocketAddr, UdpSocket},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const INTERVAL: Duration = Duration::from_secs(2);
const VERSION: &str = concat!("native-", env!("CARGO_PKG_VERSION"));

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Beacon {
    app: String,
    host_id: String,
    name: Option<String>,
    cluster_id: String,
    url: String,
    app_version: String,
    schema_version: u32,
    leader: bool,
    group_size: u32,
    runners: u32,
    #[serde(default)]
    changed: bool,
    #[serde(default)]
    race_started: bool,
    #[serde(default)]
    race_running: bool,
}

#[derive(Default)]
pub struct Discovery {
    heard: Mutex<BTreeMap<(String, String), (Instant, Beacon)>>,
    /// Set by the linked-laptop runtime while this laptop leads its group.
    pub leader: std::sync::atomic::AtomicBool,
}

impl Discovery {
    pub fn start(db: &Arc<Mutex<Db>>, port: u16) -> Arc<Self> {
        let discovery = Arc::new(Self::default());
        if std::env::var("CLUSTER_ENABLED").as_deref() != Ok("true")
            || std::env::var("CLUSTER_DISCOVERY").as_deref() == Ok("false")
        {
            return discovery;
        }
        let discovery_port = std::env::var("CLUSTER_DISCOVERY_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .filter(|port| *port > 0)
            .unwrap_or(45737);
        let setup = || -> std::io::Result<UdpSocket> {
            let socket = socket2::Socket::new(socket2::Domain::IPV4, socket2::Type::DGRAM, None)?;
            socket.set_reuse_address(true)?;
            socket.set_broadcast(true)?;
            socket.bind(&SocketAddr::from((Ipv4Addr::UNSPECIFIED, discovery_port)).into())?;
            socket.set_read_timeout(Some(Duration::from_millis(250)))?;
            Ok(socket.into())
        };
        let socket = match setup() {
            Ok(socket) => socket,
            Err(error) => {
                eprintln!("Laptopdetectie kon niet starten: {error}");
                return discovery;
            }
        };
        let own_id = {
            let db = db.lock().unwrap();
            db.exec(
                "INSERT OR IGNORE INTO settings(key,value) VALUES('host_id',?)",
                &[json!(crate::db::id())],
            )
            .and_then(|_| db.one("SELECT value FROM settings WHERE key='host_id'", &[]))
            .ok()
            .and_then(|row| row["value"].as_str().map(str::to_owned))
        };
        let Some(own_id) = own_id else {
            return discovery;
        };
        let reference = Arc::downgrade(&discovery);
        let db = Arc::downgrade(db);
        let loopback_target = std::env::var("CLUSTER_DISCOVERY_ADDRESS")
            .ok()
            .and_then(|value| value.trim().parse::<Ipv4Addr>().ok());
        let self_url = std::env::var("CLUSTER_SELF_URL").ok();
        std::thread::spawn(move || {
            let mut packet = [0; 4096];
            let mut next = Instant::now();
            while let Some(discovery) = reference.upgrade() {
                if Instant::now() >= next {
                    next += INTERVAL;
                    if let Some(db) = db.upgrade() {
                        let db = db.lock().unwrap();
                        if let Ok(state) = db.one(
                            "SELECT active_started_at, race_started_at, race_finished_at, (SELECT COUNT(*) FROM runners) AS runners, EXISTS(SELECT 1 FROM laps) AS has_laps, MAX(1,(SELECT COUNT(*) FROM cluster_members)) AS group_size, (SELECT value FROM settings WHERE key='replication_cluster_id') AS cluster_id, EXISTS(SELECT 1 FROM replication_log WHERE type NOT LIKE 'cluster.%') AS logged FROM race_state WHERE id=1", &[],
                        ) {
                            let started = !state["race_started_at"].is_null()
                                || !state["active_started_at"].is_null()
                                || !state["race_finished_at"].is_null()
                                || state["has_laps"] == 1;
                            let info = crate::host::info(port);
                            let advertised_port = info["port"].as_u64().unwrap_or(u64::from(port));
                            let mut beacon = Beacon {
                                app: "apolloon".into(),
                                host_id: own_id.clone(),
                                name: Some(crate::host::name()),
                                cluster_id: state["cluster_id"].as_str().unwrap_or(&own_id).to_owned(),
                                url: String::new(),
                                app_version: VERSION.into(),
                                schema_version: 17,
                                leader: discovery.leader.load(std::sync::atomic::Ordering::Relaxed),
                                group_size: state["group_size"].as_u64().unwrap_or(1) as u32,
                                runners: state["runners"].as_u64().unwrap_or(0) as u32,
                                changed: state["runners"] != 0 || started || state["logged"] == 1,
                                race_started: started,
                                race_running: started && state["race_finished_at"].is_null(),
                            };
                            let targets = if let Some(address) = loopback_target {
                                vec![(address, self_url.clone().unwrap_or_else(|| format!("http://127.0.0.1:{port}")))]
                            } else {
                                crate::host::addresses().into_iter()
                                    .map(|(_, ip, broadcast)| (broadcast, format!("http://{ip}:{advertised_port}")))
                                    .collect()
                            };
                            drop(db);
                            for (address, url) in targets {
                                beacon.url = url;
                                if let Ok(bytes) = serde_json::to_vec(&beacon) {
                                    let _ = socket.send_to(&bytes, (address, discovery_port));
                                }
                            }
                        }
                    }
                }
                if let Ok((len, _)) = socket.recv_from(&mut packet) {
                    discovery.receive(&packet[..len], &own_id);
                }
            }
        });
        discovery
    }

    /// Tests: a beacon as if it arrived over UDP.
    #[cfg(test)]
    pub fn hear(&self, beacon: &Value) {
        self.receive(beacon.to_string().as_bytes(), "");
    }

    fn receive(&self, bytes: &[u8], own_id: &str) {
        let Ok(beacon) = serde_json::from_slice::<Beacon>(bytes) else {
            return;
        };
        if beacon.app != "apolloon"
            || beacon.host_id == own_id
            || beacon.host_id.is_empty()
            || beacon.host_id.len() > 128
            || beacon.url.len() > 2048
            || beacon.name.as_ref().is_some_and(|name| name.len() > 256)
            || beacon.app_version.len() > 64
            || beacon.group_size == 0
        {
            return;
        }
        let Ok(url) = reqwest::Url::parse(&beacon.url) else {
            return;
        };
        if url.scheme() != "http"
            || url.path() != "/"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return;
        }
        let mut heard = self.heard.lock().unwrap();
        heard.retain(|_, (at, _)| at.elapsed() < INTERVAL * 5);
        let key = (beacon.host_id.clone(), url.origin().ascii_serialization());
        if heard.len() < 256 || heard.contains_key(&key) {
            heard.insert(key, (Instant::now(), beacon));
        }
    }

    pub fn nearby(&self) -> Vec<Value> {
        let mut heard = self.heard.lock().unwrap();
        heard.retain(|_, (at, _)| at.elapsed() < INTERVAL * 5);
        heard.values().map(|(_, beacon)| json!(beacon)).collect()
    }
}
