use crate::db::{Db, Result, now};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
    serve::ListenerExt,
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
mod history;
use history::HistoryLog;

type ReadVersion = (i64, u64, u64, i64, i64);

/// Database version a cached read was built at. Replication and snapshot installation advance
/// the revision; total_changes also covers local settings writes that keep the same revision.
fn read_version(db: &Db) -> Result<ReadVersion> {
    Ok((
        db.revision,
        db.conn.total_changes(),
        db.history_generation(),
        db.data_version()?,
        db.schema_version()?,
    ))
}

/// Serialized `/api/state` body without the per-request `host` and `cluster` fields.
#[derive(Default)]
struct ReadCache {
    version: Option<ReadVersion>,
    snapshot: Option<Bytes>,
}

#[derive(Default)]
struct Screens(std::collections::BTreeMap<(String, std::net::IpAddr), std::time::Instant>);

impl Screens {
    fn seen(&mut self, kind: &str, address: std::net::IpAddr) {
        if matches!(kind, "inside" | "competitions" | "outside") {
            self.0
                .insert((kind.into(), address), std::time::Instant::now());
        }
    }

    fn active(&mut self) -> Value {
        self.0
            .retain(|_, seen| seen.elapsed() < std::time::Duration::from_secs(15));
        json!(
            self.0
                .iter()
                .map(|((kind, address), _)| {
                    json!({"kind":kind,"address":address.to_string()})
                })
                .collect::<Vec<_>>()
        )
    }
}

#[derive(Clone)]
pub struct Host {
    pub db: Arc<Mutex<Db>>,
    pub port: u16,
    discovery: Arc<crate::discovery::Discovery>,
    pub backups: Arc<crate::backup_service::Service>,
    /// Linked-laptop runtime (`CLUSTER_ENABLED=true`); writes then replicate to a majority.
    pub cluster: Option<Arc<crate::cluster::Node>>,
    reads: Arc<Mutex<ReadCache>>,
    history: Arc<Mutex<HistoryLog>>,
    screens: Arc<Mutex<Screens>>,
}
impl Host {
    fn new(db: Arc<Mutex<Db>>, port: u16) -> Self {
        Self::with_cluster(db, port, crate::cluster::Config::from_env(port))
    }
    pub(crate) fn with_cluster(
        db: Arc<Mutex<Db>>,
        port: u16,
        cluster: Option<crate::cluster::Config>,
    ) -> Self {
        let path = crate::backups::database_path(&db.lock().unwrap()).ok();
        let discovery = crate::discovery::Discovery::start(&db, port);
        let cluster = cluster.and_then(|config| {
            crate::cluster::Node::start(db.clone(), config)
                .inspect_err(|error| eprintln!("Laptops koppelen kon niet starten: {error}"))
                .ok()
        });
        if let Some(node) = &cluster {
            node.set_discovery(discovery.clone());
        }
        Self {
            db,
            discovery,
            port,
            backups: Arc::new(crate::backup_service::Service::new(path)),
            cluster,
            reads: Arc::default(),
            history: Arc::new(Mutex::new(HistoryLog::new())),
            screens: Arc::default(),
        }
    }
}
type Reply = std::result::Result<Json<Value>, (StatusCode, Json<Value>)>;
fn reply(result: Result<Value>) -> Reply {
    result.map(Json).map_err(|message| {
        (
            StatusCode::CONFLICT,
            Json(json!({"error":{"message":message}})),
        )
    })
}
fn json_body(body: Bytes) -> Response {
    ([(header::CONTENT_TYPE, "application/json")], body).into_response()
}
fn error_body(message: String) -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({"error":{"message":message}})),
    )
        .into_response()
}
async fn snapshot_request(
    State(host): State<Host>,
    axum::extract::ConnectInfo(remote): axum::extract::ConnectInfo<std::net::SocketAddr>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(kind) = query.get("screen") {
        host.screens
            .lock()
            .unwrap()
            .seen(kind, remote.ip().to_canonical());
    }
    if let Some(after) = query.get("after") {
        let mut changes = host.db.lock().unwrap().subscribe();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if host.db.lock().unwrap().change_token() != *after {
                    break;
                }
                if changes.changed().await.is_err() {
                    break;
                }
            }
        }).await;
        if host.db.lock().unwrap().change_token() == *after {
            let mut state = json!({
                "unchanged": true,
                "changeToken": after,
                "host": crate::host::info(host.port),
                "screens": host.screens.lock().unwrap().active(),
            });
            if let Some(node) = &host.cluster {
                state["cluster"] = node.status();
            }
            return json_body(serde_json::to_vec(&state).unwrap().into());
        }
    }
    snapshot_with_history(host, &query).await
}
async fn snapshot(State(host): State<Host>) -> Response {
    snapshot_with_history(host, &Default::default()).await
}
async fn snapshot_with_history(host: Host, query: &std::collections::HashMap<String, String>) -> Response {
    let query = query.clone();
    let result = tokio::task::spawn_blocking(move || snapshot_read(host, &query)).await;
    match result {
        Ok(response) => response,
        Err(error) => error_body(error.to_string()),
    }
}
fn snapshot_read(host: Host, query: &std::collections::HashMap<String, String>) -> Response {
    let read = || -> Result<(Bytes, Option<Bytes>)> {
        let mut history = query
            .contains_key("history")
            .then(|| host.history.lock().unwrap());
        let (db, version, token, changes) = {
            let writer = host.db.lock().unwrap();
            let version = read_version(&writer)?;
            let db = writer.read_snapshot()?;
            if version != read_version(&writer)? {
                return Err("Database gewijzigd tijdens het lezen".into());
            }
            let changes = writer
                .history_changes_since(history.as_ref().and_then(|log| log.generation(version)));
            (db, version, writer.change_token(), changes)
        };
        let mut cache = host.reads.lock().unwrap();
        if cache.version != Some(version) || cache.snapshot.is_none() {
            let mut state = db.race_snapshot()?;
            state["changeToken"] = json!(token);
            if crate::latency::enabled() {
                state["latencyLap"] = db.rows("SELECT id FROM laps ORDER BY rowid DESC LIMIT 1", &[])?.first().map_or(Value::Null, |row| row["id"].clone());
            }
            let body = serde_json::to_vec(&state).map_err(|e| e.to_string())?;
            *cache = ReadCache {
                version: Some(version),
                snapshot: Some(body.into()),
            };
        }
        let cached = cache.snapshot.clone().unwrap();
        drop(cache);
        let history = if let Some(log) = history.as_mut() {
            log.refresh(&db, version, changes)?;
            Some(
                query
                    .get("since")
                    .and_then(|cursor| log.since(cursor))
                    .map(Ok)
                    .unwrap_or_else(|| log.full_body())?,
            )
        } else {
            None
        };
        Ok((cached, history))
    };
    match read() {
        Ok((cached, history)) => {
            // The cached object is reused as bytes; only the live fields are appended.
            let mut body = Vec::with_capacity(cached.len() + 512);
            body.extend_from_slice(&cached[..cached.len() - 1]);
            let mut field = |name: &str, value: &Value| {
                if body.len() > 1 {
                    body.push(b',');
                }
                body.extend_from_slice(format!("\"{name}\":").as_bytes());
                serde_json::to_writer(&mut body, value).unwrap();
            };
            field("host", &crate::host::info(host.port));
            if let Some(node) = &host.cluster {
                field("cluster", &node.status());
            }
            field("screens", &host.screens.lock().unwrap().active());
            if let Some(history) = history {
                body.extend_from_slice(b",\"stateHistory\":");
                body.extend_from_slice(&history);
            }
            body.push(b'}');
            json_body(body.into())
        }
        Err(message) => error_body(message),
    }
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryQuery {
    scope: Option<String>,
    runner_id: Option<String>,
    limit: Option<usize>,
    /// `cursor` of a full history the client holds: answer with only what changed since.
    since: Option<String>,
}
async fn history(State(host): State<Host>, Query(query): Query<HistoryQuery>) -> Response {
    match tokio::task::spawn_blocking(move || history_read(host, query)).await {
        Ok(response) => response,
        Err(error) => error_body(error.to_string()),
    }
}
fn history_read(host: Host, query: HistoryQuery) -> Response {
    match history_result(&host, query) {
        Ok(body) => json_body(body),
        Err(message) => error_body(message),
    }
}
fn history_result(host: &Host, query: HistoryQuery) -> Result<Bytes> {
    let mut log = host.history.lock().unwrap();
    let (db, version, changes) = {
        let writer = host.db.lock().unwrap();
        let version = read_version(&writer)?;
        let db = writer.read_snapshot()?;
        if version != read_version(&writer)? {
            return Err("Database gewijzigd tijdens het lezen".into());
        }
        let changes = writer.history_changes_since(log.generation(version));
        (db, version, changes)
    };
    let scope = query.scope.as_deref().unwrap_or("full");
    if scope != "full" {
        return db
            .history_scope(
                scope,
                query.runner_id.as_deref(),
                query.limit.unwrap_or(100),
            )
            .and_then(|value| {
                serde_json::to_vec(&value)
                    .map(Bytes::from)
                    .map_err(|e| e.to_string())
            });
    }
    log.refresh(&db, version, changes)?;
    if let Some(delta) = query.since.as_deref().and_then(|cursor| log.since(cursor)) {
        return Ok(delta);
    }
    log.full_body()
}
async fn registrations(State(host): State<Host>) -> Reply {
    reply(host.db.lock().unwrap().registrations())
}
async fn query_rpc(
    State(host): State<Host>,
    Path(method): Path<String>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Reply {
    let input: Value = match query.get("input") {
        Some(raw) => match serde_json::from_str(raw) {
            Ok(v) => v,
            Err(_) => return reply(Err("Ongeldige invoer".into())),
        },
        None => json!({}),
    };
    let db = host.db.lock().unwrap();
    reply(
        match method.as_str() {
            "runners.registrations" => db.registrations(),
            "activity.list" => db.activity(&input),
            "backups.list" => {
                crate::backups::database_path(&db).and_then(|path| crate::backups::list(&path))
            }
            "backups.preview" => crate::backups::database_path(&db).and_then(|path| {
                crate::backups::preview(&path, input["fileName"].as_str().unwrap_or(""))
            }),
            _ => Err("Onbekende leesactie".into()),
        }
        .map(|data| json!({"result":{"data":data}})),
    )
}
async fn label_image(State(host): State<Host>, Path(id): Path<String>) -> axum::response::Response {
    use base64::Engine;
    let row = host.db.lock().unwrap().one(
        "SELECT mime,data_base64 FROM label_images WHERE id=?",
        &[json!(id)],
    );
    match row {
        Ok(row) => match base64::engine::general_purpose::STANDARD
            .decode(row["data_base64"].as_str().unwrap_or(""))
        {
            Ok(bytes) => (
                [
                    (
                        axum::http::header::CONTENT_TYPE,
                        row["mime"].as_str().unwrap_or("image/png").to_owned(),
                    ),
                    (
                        axum::http::header::CACHE_CONTROL,
                        "public, max-age=31536000, immutable".to_owned(),
                    ),
                ],
                bytes,
            )
                .into_response(),
            Err(_) => StatusCode::NOT_FOUND.into_response(),
        },
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}
async fn health(State(host): State<Host>) -> Json<Value> {
    // The desktop app keeps the laptop awake and asks before closing while this is true.
    let race = host.db.lock().unwrap().race().unwrap_or(Value::Null);
    let active = !race["raceStartedAt"].is_null() && race["raceFinishedAt"].is_null();
    Json(json!({"ok":true,"runtime":"rust","releaseId":std::env::var("APOLLOON_RELEASE_ID").ok(),"schemaVersion":17,"race":{"active":active}}))
}
async fn net_profile() -> Json<Value> {
    let profile = tokio::task::spawn_blocking(crate::desktop::net_setup::profile).await;
    Json(match profile {
        Ok(profile) => json!({"ok":true,"profile":profile}),
        Err(_) => json!({"ok":false,"error":"Netwerkprofiel lezen mislukt"}),
    })
}
async fn net_action(
    Path(action): Path<String>,
    axum::extract::ConnectInfo(remote): axum::extract::ConnectInfo<std::net::SocketAddr>,
    Json(input): Json<Value>,
) -> axum::response::Response {
    if !remote.ip().to_canonical().is_loopback() {
        return (StatusCode::FORBIDDEN, Json(json!({"ok":false,"error":"Alleen op deze laptop zelf."}))).into_response();
    }
    let result = tokio::task::spawn_blocking(move || match action.as_str() {
        "make-static" => crate::desktop::net_setup::make_static(&input),
        "revert-dhcp" => crate::desktop::net_setup::revert_dhcp(&input),
        _ => json!({"ok":false,"error":"Onbekende netwerkactie"}),
    })
    .await
    .unwrap_or_else(|_| json!({"ok":false,"error":"Kon de netwerkactie niet starten."}));
    let status = if result["ok"] == true { StatusCode::OK } else { StatusCode::BAD_REQUEST };
    (status, Json(result)).into_response()
}
async fn clock() -> impl axum::response::IntoResponse {
    (
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        Json(json!({"serverNowMs":now()})),
    )
}
async fn action(host: Host, method: String, input: Value, origin: String) -> Result<Value> {
    tokio::task::spawn_blocking(move || match method.as_str() {
        "activity.list" | "activity.older" => {
            let db = host.db.lock().unwrap();
            Ok(json!({"entries":db.activity(&input)?,"revision":db.revision}))
        }
        "runners.registrations" => host.db.lock().unwrap().registrations(),
        "runners.profile" => {
            let db = host.db.lock().unwrap();
            let id = input["id"].as_str().ok_or("Loper ontbreekt")?;
            Ok(json!({"runner":db.runner(id)?,"registration":db.registrations()?[id]}))
        }
        "backups.create" => host.backups.create(),
        "backups.preview" => {
            crate::backups::database_path(&host.db.lock().unwrap()).and_then(|path| {
                crate::backups::preview(&path, input["fileName"].as_str().unwrap_or(""))
            })
        }
        "backups.restore" | "race.clear" => match &host.cluster {
            Some(node) => node.action(&method, &input, &origin),
            None => host.backups.recover(&host.db, &method, &input, host.port),
        },
        "backups.applyRestore" => Err("Deze herstelactie is alleen intern beschikbaar".into()),
        _ => match &host.cluster {
            Some(node) => node.action(&method, &input, &origin),
            None => host
                .db
                .lock()
                .unwrap()
                .mutation_from(&method, &input, &origin),
        },
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|v| v)
}
/// Beheer › Systeem: this laptop's network address, version, schema and data folder. The Rust
/// server cannot pin the address yet, so `elevateMethod` stays null and the address source unknown.
fn system_info(host: &Host) -> Value {
    let primary = crate::host::addresses().into_iter().next();
    let apipa = primary
        .as_ref()
        .is_some_and(|(_, ip, _)| ip.is_link_local());
    let data = crate::backups::database_path(&host.db.lock().unwrap())
        .ok()
        .and_then(|p| p.parent().map(|d| d.display().to_string()));
    json!({
        "profile": {
            "platform": std::env::consts::OS,
            "primary": primary.map(|(name, ip, _)| json!({"name":name,"address":ip.to_string(),"dhcp":null})),
            "apipa": apipa,
            "eventUrl": crate::host::info(host.port)["url"],
            "elevateMethod": null,
            "elevateHint": null,
            "manager": null,
            "suggestion": null,
        },
        "appVersion": crate::desktop::version(),
        "schemaVersion": 17,
        "dataPath": data,
        "nearbyLaptops": host.discovery.nearby(),
    })
}
/// Beheer › Systeem's laptop tools: network profile and pinning, updates and diagnostics.
/// Changing the laptop itself only works on the laptop, not from a browser on the network.
async fn desktop_action(method: &str, input: &Value, loopback: bool) -> Option<Result<Value>> {
    use crate::desktop as d;
    let local = matches!(method, "net.makeStatic" | "net.revertDhcp" | "update.check" | "update.install" | "desktop.openUrl");
    if !method.starts_with("net.") && !method.starts_with("update.") && !method.starts_with("desktop.") {
        return None;
    }
    if local && !loopback {
        return Some(Err("Dit kan alleen op de laptop zelf.".into()));
    }
    let (method, input) = (method.to_string(), input.clone());
    let run = tokio::task::spawn_blocking(move || -> Result<Value> {
        let net = |v: Value| if v["ok"] == true { Ok(v) } else { Err(v["error"].as_str().unwrap_or("Mislukt").to_string()) };
        match method.as_str() {
            "net.profile" => Ok(d::net_setup::profile()),
            "net.makeStatic" => net(d::net_setup::make_static(&input)),
            "net.revertDhcp" => net(d::net_setup::revert_dhcp(&input)),
            _ => d::control(&method, &input).unwrap_or_else(|| Err("Onbekende actie".into())),
        }
    });
    Some(run.await.unwrap_or_else(|_| Err("Mislukt".into())))
}
async fn mutation(
    State(host): State<Host>,
    Path(method): Path<String>,
    axum::extract::ConnectInfo(remote): axum::extract::ConnectInfo<std::net::SocketAddr>,
    headers: axum::http::HeaderMap,
    Json(input): Json<Value>,
) -> Reply {
    let loopback = remote.ip().to_canonical().is_loopback();
    let trace = if crate::latency::enabled() && method == "race.handoff" {
        crate::latency::handoff("server_received", &input, None);
        Some(crate::latency::handoff_id(&input))
    } else { None };
    if let Some(result) = desktop_action(&method, &input, loopback).await {
        return reply(result);
    }
    let result = action(
            host,
            method,
            input,
            crate::host::origin(
                headers
                    .get("x-apolloon-screen")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or(""),
                remote.ip(),
            ),
        )
        .await;
    if let Some(id) = trace {
        crate::latency::emit("ack_response", &id, result.as_ref().ok().and_then(|r| r["lapId"].as_str()));
    }
    reply(result)
}
async fn rpc(
    State(host): State<Host>,
    Path(method): Path<String>,
    axum::extract::ConnectInfo(remote): axum::extract::ConnectInfo<std::net::SocketAddr>,
    headers: axum::http::HeaderMap,
    Json(input): Json<Value>,
) -> Reply {
    reply(
        action(
            host,
            method,
            input,
            crate::host::origin(
                headers
                    .get("x-apolloon-screen")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or(""),
                remote.ip(),
            ),
        )
        .await
        .map(|data| json!({"result":{"data":data}})),
    )
}
async fn system(State(host): State<Host>) -> Reply {
    reply(host.backups.status())
}
async fn recovery_state(State(host): State<Host>) -> Reply {
    let status = host.backups.status();
    let records = crate::backups::database_path(&host.db.lock().unwrap())
        .and_then(|path| crate::backups::list(&path))
        .unwrap_or(json!([]));
    let system = system_info(&host);
    reply(status.map(|status| json!({"status":status,"backups":records,"system":system})))
}
async fn backup_download(
    State(host): State<Host>,
    Path(name): Path<String>,
) -> axum::response::Response {
    let path = crate::backups::database_path(&host.db.lock().unwrap())
        .and_then(|path| crate::backups::file(&path, &name));
    match path {
        Ok(path) => match tokio::fs::read(path).await {
            Ok(bytes) => (
                [
                    ("Content-Type", "application/vnd.sqlite3".to_owned()),
                    (
                        "Content-Disposition",
                        format!("attachment; filename=\"{name}\""),
                    ),
                ],
                bytes,
            )
                .into_response(),
            Err(_) => StatusCode::NOT_FOUND.into_response(),
        },
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}
async fn export(State(host): State<Host>, Path(file): Path<String>) -> axum::response::Response {
    match host.db.lock().unwrap().download(&file, host.port) {
        Ok(download) => (
            [
                ("Content-Type", download.mime.to_owned()),
                (
                    "Content-Disposition",
                    format!("attachment; filename=\"{}\"", download.name),
                ),
            ],
            download.body,
        )
            .into_response(),
        Err(message) => (
            StatusCode::NOT_FOUND,
            Json(json!({"error":{"message":message}})),
        )
            .into_response(),
    }
}
// These URLs also work when the installed binary starts outside the source checkout.
fn bundled_asset(directory: &str, file: &str) -> axum::response::Response {
    let (mime, bytes): (&str, &[u8]) = match (directory, file) {
        ("labels", "hilok.png") => ("image/png", include_bytes!("../../public/labels/hilok.png")),
        ("labels", "kinesia.png") => (
            "image/png",
            include_bytes!("../../public/labels/kinesia.png"),
        ),
        ("labels", "mesacosa.png" | "mesacosa.jpg") => (
            "image/png",
            include_bytes!("../../public/labels/mesacosa.png"),
        ),
        ("event-network", "Revert-ApolloonDhcp.ps1") => (
            "application/octet-stream",
            include_bytes!("../../public/event-network/Revert-ApolloonDhcp.ps1"),
        ),
        ("event-network", "Set-ApolloonStaticIp.ps1") => (
            "application/octet-stream",
            include_bytes!("../../public/event-network/Set-ApolloonStaticIp.ps1"),
        ),
        ("event-network", "Test-ApolloonNetwork.ps1") => (
            "application/octet-stream",
            include_bytes!("../../public/event-network/Test-ApolloonNetwork.ps1"),
        ),
        ("event-network", "revert-apolloon-dhcp.sh") => (
            "application/octet-stream",
            include_bytes!("../../public/event-network/revert-apolloon-dhcp.sh"),
        ),
        ("event-network", "set-apolloon-static-ip.sh") => (
            "application/octet-stream",
            include_bytes!("../../public/event-network/set-apolloon-static-ip.sh"),
        ),
        ("wrapped", "story.css") => (
            "text/css; charset=utf-8",
            include_bytes!("../../public/wrapped/wrapped.css"),
        ),
        ("wrapped", "ready.js") => (
            "text/javascript; charset=utf-8",
            include_bytes!("../web/wrapped/ready.js"),
        ),
        ("wrapped", "page-1.svg") => (
            "image/svg+xml",
            include_bytes!("../../public/wrapped/page-1.svg"),
        ),
        ("wrapped", "page-2.svg") => (
            "image/svg+xml",
            include_bytes!("../../public/wrapped/page-2.svg"),
        ),
        ("wrapped", "page-3.svg") => (
            "image/svg+xml",
            include_bytes!("../../public/wrapped/page-3.svg"),
        ),
        ("wrapped", "page-4.svg") => (
            "image/svg+xml",
            include_bytes!("../../public/wrapped/page-4.svg"),
        ),
        ("fonts", "bebas-neue-latin-400-normal.woff2") => (
            "font/woff2",
            include_bytes!("../../public/fonts/bebas-neue-latin-400-normal.woff2"),
        ),
        ("fonts", "bebas-neue-latin-ext-400-normal.woff2") => (
            "font/woff2",
            include_bytes!("../../public/fonts/bebas-neue-latin-ext-400-normal.woff2"),
        ),
        ("fonts", "racing-sans-one-latin-400-normal.woff2") => (
            "font/woff2",
            include_bytes!("../../public/fonts/racing-sans-one-latin-400-normal.woff2"),
        ),
        ("fonts", "racing-sans-one-latin-ext-400-normal.woff2") => (
            "font/woff2",
            include_bytes!("../../public/fonts/racing-sans-one-latin-ext-400-normal.woff2"),
        ),
        ("fonts", "geist-latin-wght-normal.woff2") => (
            "font/woff2",
            include_bytes!("../../public/fonts/geist-latin-wght-normal.woff2"),
        ),
        ("fonts", "league-spartan-bold-2014.otf") => (
            "font/otf",
            include_bytes!("../../public/fonts/league-spartan-bold-2014.otf"),
        ),
        ("brand", "apolloon-logo.png") => (
            "image/png",
            include_bytes!("../../public/brand/apolloon-logo.png"),
        ),
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    ([(axum::http::header::CONTENT_TYPE, mime)], bytes).into_response()
}

async fn wrapped_card(
    State(host): State<Host>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> std::result::Result<axum::response::Html<String>, StatusCode> {
    let id = query.get("runner").cloned().unwrap_or_default();
    tokio::task::spawn_blocking(move || crate::wrapped::card(&host.db.lock().unwrap(), &id))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map(axum::response::Html)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

/// JSON reads and actions, gzip or brotli compressed for clients that accept it. Images and
/// spreadsheets are compressed already and pass through unchanged.
fn api_routes() -> Router<Host> {
    use tower_http::compression::{
        CompressionLayer,
        predicate::{DefaultPredicate, NotForContentType, Predicate},
    };
    Router::new()
        .route("/api/health", get(health))
        .route("/api/net/profile", get(net_profile))
        .route("/api/net/{action}", post(net_action))
        .route("/api/backups/status", get(system))
        .route("/api/recovery", get(recovery_state))
        .route("/api/backups/{name}", get(backup_download))
        .route("/api/export/{file}", get(export))
        .route("/api/clock", get(clock))
        .route("/api/state", get(snapshot_request))
        .route("/api/history", get(history))
        .route("/api/registrations", get(registrations))
        .route("/api/label-images/{id}", get(label_image))
        .route("/api/action/{method}", post(mutation))
        .route("/trpc/{method}", post(rpc).get(query_rpc))
        .layer(
            CompressionLayer::new().no_deflate().no_zstd().compress_when(
                DefaultPredicate::new().and(NotForContentType::const_new(
                    "application/vnd.openxmlformats",
                )),
            ),
        )
}

pub fn router(host: Host) -> Router {
    Router::new()
        .merge(api_routes())
        .route("/wrapped/card", get(wrapped_card))
        .route(
            "/wrapped/{file}",
            get(|Path(file): Path<String>| async move { bundled_asset("wrapped", &file) }),
        )
        .route(
            "/fonts/{file}",
            get(|Path(file): Path<String>| async move { bundled_asset("fonts", &file) }),
        )
        .route(
            "/brand/{file}",
            get(|Path(file): Path<String>| async move { bundled_asset("brand", &file) }),
        )
        .route(
            "/labels/{file}",
            get(|Path(file): Path<String>| async move { bundled_asset("labels", &file) }),
        )
        .route(
            "/event-network/{file}",
            get(|Path(file): Path<String>| async move { bundled_asset("event-network", &file) }),
        )
        .fallback_service(
            tower_http::services::ServeDir::new(
                crate::desktop::config::current_web_dir(),
            )
            .precompressed_br()
            .precompressed_gzip()
            .fallback(tower_http::services::ServeFile::new(
                std::path::Path::new(
                    &crate::desktop::config::current_web_dir(),
                )
                .join("index.html"),
            )),
        )
        .merge(crate::cluster::routes::routes())
        .layer(axum::extract::DefaultBodyLimit::max(50 * 1024 * 1024))
        .with_state(host)
}
pub fn serve(db: Arc<Mutex<Db>>, port: u16) -> Result<()> {
    let runtime = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    runtime.block_on(async {
        let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
            .await
            .map_err(|e| e.to_string())?;
        println!("Apolloon Rust http://127.0.0.1:{port}");
        axum::serve(
            listener.tap_io(|socket| { let _ = socket.set_nodelay(true); }),
            router(Host::new(db, port))
                .into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .map_err(|e| e.to_string())
    })
}

/// Own the local server for exactly the desktop process's lifetime.
#[cfg(feature = "desktop")]
pub struct ServerHandle {
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
#[cfg(feature = "desktop")]
impl Drop for ServerHandle {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
#[cfg(feature = "desktop")]
pub fn start(db: Arc<Mutex<Db>>, port: u16) -> Result<ServerHandle> {
    // Bind before opening the window, so a port conflict is a startup error.
    let listener = std::net::TcpListener::bind(("0.0.0.0", port))
        .map_err(|e| format!("Serverpoort {port}: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let runtime = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    let (shutdown, stop) = tokio::sync::oneshot::channel();
    let thread = std::thread::spawn(move || {
        runtime.block_on(async move {
            let listener =
                tokio::net::TcpListener::from_std(listener).expect("bound server socket");
            if let Err(error) = axum::serve(
                listener.tap_io(|socket| { let _ = socket.set_nodelay(true); }),
                router(Host::new(db, port))
                    .into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = stop.await;
            })
            .await
            {
                eprintln!("Apolloon server: {error}");
            }
        })
    });
    Ok(ServerHandle {
        shutdown: Some(shutdown),
        thread: Some(thread),
    })
}

#[cfg(test)]
mod read_cache_tests {
    use super::*;

    #[tokio::test]
    async fn both_mesacosa_urls_serve_the_bundled_png() {
        let expected = include_bytes!("../../public/labels/mesacosa.png");
        for file in ["mesacosa.png", "mesacosa.jpg"] {
            let response = bundled_asset("labels", file);
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()["content-type"], "image/png");
            let body = axum::body::to_bytes(response.into_body(), expected.len())
                .await
                .unwrap();
            assert_eq!(body.as_ref(), expected);
        }
    }

    async fn body(response: Response) -> Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }
    fn query(scope: Option<&str>, limit: Option<usize>, since: Option<&str>) -> Query<HistoryQuery> {
        Query(HistoryQuery {
            scope: scope.map(Into::into),
            runner_id: None,
            limit,
            since: since.map(Into::into),
        })
    }

    #[tokio::test]
    async fn plain_state_does_not_wait_for_the_history_lane() {
        let db = Arc::new(Mutex::new(Db::open(std::path::Path::new(":memory:")).unwrap()));
        let host = Host::with_cluster(db, 5173, None);
        let _history = host.history.lock().unwrap();
        let state = tokio::time::timeout(std::time::Duration::from_secs(1), pushed(host.clone(), None, false)).await.unwrap();
        assert_eq!(state["runners"], json!([]));
        assert!(state.get("stateHistory").is_none());
    }

    #[test]
    fn wal_reader_is_read_only_and_does_not_hold_up_a_writer() {
        let path = std::env::temp_dir().join(format!("apolloon-reader-{}.sqlite", uuid::Uuid::new_v4()));
        {
            let writer = Db::open(&path).unwrap();
            assert_eq!(writer.one("PRAGMA journal_mode", &[]).unwrap()["journal_mode"], "wal");
            assert_eq!(writer.one("PRAGMA synchronous", &[]).unwrap()["synchronous"], 2);
            let reader = writer.read_snapshot().unwrap();
            assert!(reader.exec("INSERT INTO settings VALUES('forbidden','x')", &[]).is_err());
            writer.exec("INSERT INTO settings VALUES('concurrent','yes')", &[]).unwrap();
            assert!(reader.rows("SELECT * FROM settings WHERE key='concurrent'", &[]).unwrap().is_empty());
            assert_eq!(writer.read_snapshot().unwrap().one("SELECT value FROM settings WHERE key='concurrent'", &[]).unwrap()["value"], "yes");
        }
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn warm_reads_follow_local_changes_and_timing_writes() {
        let db = Arc::new(Mutex::new(
            Db::open(std::path::Path::new(":memory:")).unwrap(),
        ));
        let host = Host::with_cluster(db.clone(), 5173, None);
        let state = || async { body(snapshot(State(host.clone())).await).await };
        let full_history = || async { body(history(State(host.clone()), query(None, None, None)).await).await };
        let empty = state().await;
        assert_eq!(empty["runners"], json!([]));
        assert_eq!(empty["host"], crate::host::info(5173));
        assert_eq!(full_history().await["laps"], json!([]));
        let initial = pushed(host.clone(), None, true).await;
        let cursor = initial["stateHistory"]["cursor"].as_str().unwrap().to_owned();

        // Some local settings writes deliberately keep the same public revision.
        let revision = db.lock().unwrap().revision;
        db.lock()
            .unwrap()
            .exec(
                "INSERT INTO runners(id,name,status,created_at,updated_at)
             VALUES ('runner','Cached runner','running',0,0)",
                &[],
            )
            .unwrap();
        let state = state().await;
        assert_eq!(state["runners"][0]["name"], "Cached runner");
        assert_eq!(state["revision"], revision);
        {
            let mut db = db.lock().unwrap();
            db.exec(
                "UPDATE race_state SET active_runner_id='runner',active_started_at=1,race_started_at=1",
                &[],
            ).unwrap();
            db.mutation(
                "race.handoff",
                &json!({
                    "activeRunnerId":"runner", "activeStartedAt":1,
                }),
            )
            .unwrap();
        }
        let full = full_history().await;
        assert_eq!(full["laps"][0]["runnerId"], "runner");
        let bundle_query = std::collections::HashMap::from([
            ("history".into(), "1".into()),
            ("since".into(), cursor.clone()),
        ]);
        let bundled = body(snapshot_with_history(host.clone(), &bundle_query).await).await;
        assert_eq!(bundled["stateHistory"]["delta"], true);
        assert_eq!(bundled["stateHistory"]["since"], cursor);
        assert_eq!(bundled["stateHistory"]["revision"], bundled["revision"]);
        assert_eq!(bundled["stateHistory"]["changes"]["laps"]["changed"][0][1], full["laps"][0]);
        let recent = body(history(State(host), query(Some("recent"), Some(1), None)).await).await;
        assert_eq!(recent["laps"], full["laps"]);
        assert_eq!(recent["limit"], 1);
    }

    async fn pushed(host: Host, after: Option<String>, history: bool) -> Value {
        let mut query = std::collections::HashMap::new();
        if let Some(after) = after { query.insert("after".into(), after); }
        if history { query.insert("history".into(), "1".into()); }
        body(snapshot_request(State(host), axum::extract::ConnectInfo("127.0.0.1:1234".parse().unwrap()), Query(query)).await).await
    }

    #[tokio::test]
    async fn long_poll_wakes_on_raw_settings_commit_without_a_revision_change() {
        let db = Arc::new(Mutex::new(Db::open(std::path::Path::new(":memory:")).unwrap()));
        let host = Host::with_cluster(db.clone(), 5173, None);
        let initial = pushed(host.clone(), None, true).await;
        assert_eq!(initial["stateHistory"]["laps"], json!([]));
        let token = initial["changeToken"].as_str().unwrap().to_owned();
        let pending = tokio::spawn(pushed(host.clone(), Some(token.clone()), true));
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(!pending.is_finished());
        db.lock().unwrap().conn.execute("INSERT INTO settings(key,value) VALUES('push_test','changed')", []).unwrap();
        let result = tokio::time::timeout(std::time::Duration::from_millis(500), pending).await.unwrap().unwrap();
        assert_ne!(result["changeToken"], token);
        assert_eq!(result["revision"], initial["revision"]);
        let immediate = tokio::time::timeout(std::time::Duration::from_millis(500), pushed(host, Some(token), false)).await.unwrap();
        assert_eq!(immediate["changeToken"], result["changeToken"]);
        assert!(immediate.get("stateHistory").is_none());
    }

    #[tokio::test]
    async fn unchanged_state_times_out_and_foreign_restart_tokens_return_immediately() {
        let db = Arc::new(Mutex::new(Db::open(std::path::Path::new(":memory:")).unwrap()));
        let host = Host::with_cluster(db, 5173, None);
        let initial = pushed(host.clone(), Some("foreign-or-restarted".into()), false).await;
        let started = std::time::Instant::now();
        let current = pushed(host.clone(), initial["changeToken"].as_str().map(str::to_owned), true).await;
        assert!(started.elapsed() >= std::time::Duration::from_millis(1900));
        assert!(started.elapsed() < std::time::Duration::from_secs(4));
        assert_eq!(current["unchanged"], true);
        assert_eq!(current["changeToken"], initial["changeToken"]);
        assert_eq!(current["host"], initial["host"]);
        assert_eq!(current["screens"], initial["screens"]);
        assert!(current.get("runners").is_none());
        assert!(current.get("stateHistory").is_none());
        let legacy = pushed(host, None, true).await;
        assert_eq!(legacy["runners"], json!([]));
        assert!(legacy.get("unchanged").is_none());
        assert!(legacy["stateHistory"]["laps"].is_array());
        let other = Db::open(std::path::Path::new(":memory:")).unwrap();
        assert_ne!(other.change_token(), current["changeToken"].as_str().unwrap());
    }

    #[test]
    fn commit_and_rollback_notifiers_cover_direct_connection_writes() {
        let db = Db::open(std::path::Path::new(":memory:")).unwrap();
        let mut changes = db.subscribe();
        let before = db.change_token();
        db.conn.execute_batch("BEGIN; INSERT INTO settings(key,value) VALUES('push_test','first'); COMMIT;").unwrap();
        assert!(changes.has_changed().unwrap());
        changes.borrow_and_update();
        assert_ne!(before, db.change_token());
        let before = db.change_token();
        db.conn.execute_batch("BEGIN; UPDATE settings SET value='rolled back' WHERE key='push_test'; ROLLBACK;").unwrap();
        assert!(changes.has_changed().unwrap());
        assert_ne!(before, db.change_token());
        assert_eq!(db.one("SELECT value FROM settings WHERE key='push_test'", &[]).unwrap()["value"], "first");
    }

    #[tokio::test]
    async fn screen_presence_is_local_validated_refreshed_and_expires() {
        let db = Arc::new(Mutex::new(
            Db::open(std::path::Path::new(":memory:")).unwrap(),
        ));
        let host = Host::with_cluster(db.clone(), 5173, None);
        let remote = "192.168.88.20:34567".parse().unwrap();
        let register = |kind: &str| {
            let request = snapshot_request(
                State(host.clone()),
                axum::extract::ConnectInfo(remote),
                Query(std::collections::HashMap::from([(
                    "screen".into(),
                    kind.into(),
                )])),
            );
            async { body(request.await).await }
        };
        let state = |host: Host| async { body(snapshot(State(host)).await).await };
        assert_eq!(register("invalid").await["screens"], json!([]));
        let value = register("outside").await;
        assert_eq!(value["screens"][0]["kind"], "outside");
        assert_eq!(value["screens"][0]["address"], "192.168.88.20");
        assert_eq!(value["screens"], json!([{"kind":"outside","address":"192.168.88.20"}]));
        assert_eq!(register("outside").await, value);
        assert_eq!(state(host.clone()).await, value);
        let other = Host::with_cluster(db, 5174, None);
        assert_eq!(state(other).await["screens"], json!([]));
        host.screens
            .lock()
            .unwrap()
            .0
            .values_mut()
            .for_each(|seen| *seen -= std::time::Duration::from_secs(16));
        assert_eq!(state(host).await["screens"], json!([]));
    }

    #[tokio::test]
    async fn history_since_a_cursor_sends_only_changed_and_removed_rows() {
        let db = Arc::new(Mutex::new(
            Db::open(std::path::Path::new(":memory:")).unwrap(),
        ));
        let host = Host::with_cluster(db.clone(), 5173, None);
        let lap = |id: &str, finished: i64| {
            db.lock()
                .unwrap()
                .exec(
                    "INSERT INTO laps(id,runner_id,lap_number,started_at,finished_at,duration_ms,source,created_at,labels_json)
                     VALUES(?,'runner',0,?,?,60000,'spacebar',?,'[]')",
                    &[json!(id), json!(finished - 60_000), json!(finished), json!(finished)],
                )
                .unwrap();
        };
        db.lock()
            .unwrap()
            .exec(
                "INSERT INTO runners(id,name,status,created_at,updated_at) VALUES ('runner','Jana','running',0,0)",
                &[],
            )
            .unwrap();
        for (id, at) in [("a", 100_000), ("b", 200_000), ("c", 300_000)] {
            lap(id, at);
        }
        let get = |since: Option<String>| {
            let host = host.clone();
            async move { body(history(State(host), query(None, None, since.as_deref())).await).await }
        };
        let first = get(None).await;
        let cursor = first["cursor"].as_str().unwrap().to_owned();
        assert_eq!(first["laps"].as_array().unwrap().len(), 3);

        let same = get(Some(cursor.clone())).await;
        assert_eq!(same["delta"], true);
        assert_eq!(same["cursor"], cursor);
        assert_eq!(same["changes"]["laps"], json!({"changed":[],"removed":[],"count":3}));

        lap("d", 250_000);
        db.lock().unwrap().exec("DELETE FROM laps WHERE id='a'", &[]).unwrap();
        db.lock().unwrap().exec("UPDATE laps SET duration_ms=61000 WHERE id='c'", &[]).unwrap();
        let delta = get(Some(cursor.clone())).await;
        let full = get(None).await;
        assert_eq!(delta["revision"], full["revision"]);
        assert_eq!(delta["cursor"], full["cursor"]);
        let laps = &delta["changes"]["laps"];
        assert_eq!(laps["removed"], json!(["a"]));
        assert_eq!(laps["count"], 3);
        assert_eq!(laps["changed"][0], json!([0, full["laps"][0]]));
        assert_eq!(laps["changed"][1], json!([1, full["laps"][1]]));
        assert_eq!(laps["changed"].as_array().unwrap().len(), 2);
        assert!(delta.get("laps").is_none());
        let mut held = first.clone();
        assert!(crate::ui::merge_history(&mut held, &delta));
        assert_eq!(held, full);
        let mut wrong_count = first.clone();
        let mut bad = delta.clone();
        bad["changes"]["laps"]["count"] = json!(4);
        assert!(!crate::ui::merge_history(&mut wrong_count, &bad));

        db.lock().unwrap().exec("INSERT INTO race_events(id,type,message,occurred_at,created_at) VALUES('e1','burgie_gepakt','Burgie gepakt',5,5)", &[]).unwrap();
        let events = get(Some(full["cursor"].as_str().unwrap().into())).await;
        let mut after = full.clone();
        assert!(crate::ui::merge_history(&mut after, &events));
        assert_eq!(after, get(None).await);
        assert_eq!(events["changes"]["laps"]["changed"], json!([]));

        // A cursor from another server start or one older than the kept steps gets everything.
        for cursor in ["elsewhere.1", "nonsense", &format!("{}.99", &cursor[..12])] {
            let answer = get(Some(cursor.into())).await;
            assert!(answer.get("delta").is_none());
            assert_eq!(answer["laps"], full["laps"]);
        }
    }

    #[tokio::test]
    async fn json_replies_are_compressed_for_browsers_that_accept_it() {
        use tower::ServiceExt;
        let db = Arc::new(Mutex::new(
            Db::open(std::path::Path::new(":memory:")).unwrap(),
        ));
        let app = router(Host::with_cluster(db, 5173, None));
        let request = |encoding: &str| {
            axum::http::Request::get("/api/state")
                .header(header::ACCEPT_ENCODING, encoding)
                .extension(axum::extract::ConnectInfo(std::net::SocketAddr::from((
                    [127, 0, 0, 1],
                    1,
                ))))
                .body(axum::body::Body::empty())
                .unwrap()
        };
        let brotli = app.clone().oneshot(request("gzip, br")).await.unwrap();
        assert_eq!(brotli.headers()[header::CONTENT_ENCODING], "br");
        let gzip = app.clone().oneshot(request("gzip")).await.unwrap();
        assert_eq!(gzip.headers()[header::CONTENT_ENCODING], "gzip");
        let plain = app.oneshot(request("identity")).await.unwrap();
        assert!(plain.headers().get(header::CONTENT_ENCODING).is_none());
        assert!(body(plain).await["revision"].is_i64());
    }
}
