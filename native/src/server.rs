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
}
impl Host {
    fn new(db: Arc<Mutex<Db>>, port: u16) -> Self {
        let path = crate::backups::database_path(&db.lock().unwrap()).ok();
        let discovery = crate::discovery::Discovery::start(&db, port);
        Self {
            db,
            discovery,
            port,
            backups: Arc::new(crate::backup_service::Service::new(path)),
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
    reply(host.db.lock().unwrap().snapshot(host.port))
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
async fn health() -> Json<Value> {
    Json(json!({"ok":true,"runtime":"rust","schemaVersion":17}))
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
        "backups.restore" | "race.clear" => {
            host.backups.recover(&host.db, &method, &input, host.port)
        }
        "backups.applyRestore" => Err("Deze herstelactie is alleen intern beschikbaar".into()),
        _ => host
            .db
            .lock()
            .unwrap()
            .mutation_from(&method, &input, &origin),
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
        "appVersion": env!("CARGO_PKG_VERSION"),
        "schemaVersion": 17,
        "dataPath": data,
        "nearbyLaptops": host.discovery.nearby(),
    })
}
async fn mutation(
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
pub fn router(host: Host) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/backups/status", get(system))
        .route("/api/recovery", get(recovery_state))
        .route("/api/backups/{name}", get(backup_download))
        .route("/api/export/{file}", get(export))
        .route("/api/clock", get(clock))
        .route("/api/state", get(snapshot))
        .route("/api/history", get(history))
        .route("/api/registrations", get(registrations))
        .route("/api/label-images/{id}", get(label_image))
        .nest_service(
            "/labels",
            tower_http::services::ServeDir::new("public/labels"),
        )
        .nest_service(
            "/event-network",
            tower_http::services::ServeDir::new("public/event-network"),
        )
        .route("/api/action/{method}", post(mutation))
        .route("/trpc/{method}", post(rpc).get(query_rpc))
        .fallback_service(
            tower_http::services::ServeDir::new(
                std::env::var("APOLLOON_WEB_DIR").unwrap_or_else(|_| "native/web-dist".into()),
            )
            .fallback(tower_http::services::ServeFile::new(
                std::path::Path::new(
                    &std::env::var("APOLLOON_WEB_DIR").unwrap_or_else(|_| "native/web-dist".into()),
                )
                .join("index.html"),
            )),
        )
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
