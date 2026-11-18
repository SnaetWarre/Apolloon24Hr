use crate::db::{Db, Result, now};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, post},
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
#[derive(Clone)]
pub struct Host {
    pub db: Arc<Mutex<Db>>,
    pub port: u16,
    discovery: Arc<crate::discovery::Discovery>,
    pub backups: Arc<crate::backup_service::Service>,
    /// Linked-laptop runtime (`CLUSTER_ENABLED=true`); writes then replicate to a majority.
    pub cluster: Option<Arc<crate::cluster::Node>>,
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
async fn snapshot(State(host): State<Host>) -> Reply {
    let mut snapshot = host.db.lock().unwrap().snapshot(host.port);
    if let (Ok(value), Some(node)) = (&mut snapshot, &host.cluster) {
        value["cluster"] = node.status();
    }
    reply(snapshot)
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryQuery {
    scope: Option<String>,
    runner_id: Option<String>,
    limit: Option<usize>,
}
async fn history(State(host): State<Host>, Query(query): Query<HistoryQuery>) -> Reply {
    reply(host.db.lock().unwrap().history_scope(
        query.scope.as_deref().unwrap_or("full"),
        query.runner_id.as_deref(),
        query.limit.unwrap_or(100),
    ))
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
    use axum::response::IntoResponse;
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
    Json(json!({"ok":true,"runtime":"rust","schemaVersion":17,"race":{"active":active}}))
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
    use axum::response::IntoResponse;
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
    if let Some(result) = desktop_action(&method, &input, loopback).await {
        return reply(result);
    }
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
        .await,
    )
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
    use axum::response::IntoResponse;
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
    use axum::response::IntoResponse;
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
    use axum::response::IntoResponse;
    let (mime, bytes): (&str, &[u8]) = match (directory, file) {
        ("labels", "hilok.png") => ("image/png", include_bytes!("../../public/labels/hilok.png")),
        ("labels", "kinesia.png") => (
            "image/png",
            include_bytes!("../../public/labels/kinesia.png"),
        ),
        ("labels", "mesacosa.jpg") => (
            "image/jpeg",
            include_bytes!("../../public/labels/mesacosa.jpg"),
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
            include_bytes!("../../src/styles/wrapped.css"),
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

pub fn router(host: Host) -> Router {
    Router::new()
        .route("/api/health", get(health))
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
        .route("/api/net/profile", get(net_profile))
        .route("/api/net/{action}", post(net_action))
        .route("/api/backups/status", get(system))
        .route("/api/recovery", get(recovery_state))
        .route("/api/backups/{name}", get(backup_download))
        .route("/api/export/{file}", get(export))
        .route("/api/clock", get(clock))
        .route("/api/state", get(snapshot))
        .route("/api/history", get(history))
        .route("/api/registrations", get(registrations))
        .route("/api/label-images/{id}", get(label_image))
        .route(
            "/labels/{file}",
            get(|Path(file): Path<String>| async move { bundled_asset("labels", &file) }),
        )
        .route(
            "/event-network/{file}",
            get(|Path(file): Path<String>| async move { bundled_asset("event-network", &file) }),
        )
        .route("/api/action/{method}", post(mutation))
        .route("/trpc/{method}", post(rpc).get(query_rpc))
        .fallback_service(
            tower_http::services::ServeDir::new(
                crate::desktop::config::current_web_dir(),
            )
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
            listener,
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
                listener,
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
