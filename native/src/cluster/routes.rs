//! The endpoints between laptops (port of registerClusterRoutes and answerPeer in server/cluster.ts).
use super::Node;
use crate::server::Host;
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use std::sync::Arc;

const BODY_LIMIT: usize = 50 * 1024 * 1024;

pub fn routes(host: &Host) -> Router<Host> {
    // What laptops of one group ask each other: refused unless signed with the group's key.
    let group = Router::new()
        .route("/api/cluster/peer", post(peer))
        .route("/api/cluster/snapshot", get(snapshot))
        .route("/api/cluster/invite", post(invite))
        .route("/api/cluster/write", post(write))
        .route("/api/cluster/split/common", post(split_common))
        .route("/api/cluster/split/merge", post(split_merge))
        .route("/api/cluster/probe", get(probe))
        .layer(axum::middleware::from_fn_with_state(
            host.clone(),
            group_only,
        ));
    // Open to a laptop that is not in the group yet (and to browsers looking for a laptop).
    Router::new()
        .route("/api/cluster/status", get(status))
        .route("/api/cluster/members", post(members))
        .route("/api/time", get(time))
        .merge(group)
}

/// Whether the request carries a signature made with a key of this laptop's group.
#[derive(Clone, Copy)]
struct Signed(bool);

/// Lets a request through to the group's endpoints only when a laptop of this group signed it.
/// An invite also comes from a laptop that is not linked yet, so it passes with a note of
/// whether it was signed. A laptop without linking, with its cable pulled (tests) or hearing
/// another version answers what it always answered.
async fn group_only(
    State(host): State<Host>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let Ok(node) = node(&host, request.headers()) else {
        return next.run(request).await;
    };
    let (mut parts, body) = request.into_parts();
    let Ok(body) = axum::body::to_bytes(body, BODY_LIMIT).await else {
        return refusal(
            StatusCode::PAYLOAD_TOO_LARGE,
            "invalid_request",
            "Onbekende aanvraag.",
        );
    };
    let path = parts
        .uri
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or_default();
    let signed = parts
        .headers
        .get(super::key::HEADER)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|given| node.signed(parts.method.as_str(), path, &body, given));
    if !signed && parts.uri.path() != "/api/cluster/invite" {
        return refusal(
            StatusCode::UNAUTHORIZED,
            "not_in_group",
            "Deze laptops horen bij een andere groep.",
        );
    }
    parts.extensions.insert(Signed(signed));
    next.run(axum::extract::Request::from_parts(parts, axum::body::Body::from(body)))
        .await
}

fn refusal(status: StatusCode, code: &str, error: &str) -> Response {
    (
        status,
        Json(json!({"ok": false, "code": code, "error": error})),
    )
        .into_response()
}

/// The node, unless linking is off or (test hook) this laptop's cable is pulled for other laptops.
fn node(host: &Host, headers: &HeaderMap) -> Result<Arc<Node>, Response> {
    let Some(node) = host.cluster.clone() else {
        return Err(refusal(
            StatusCode::NOT_FOUND,
            "not_found",
            "Laptops koppelen staat uit op deze installatie.",
        ));
    };
    if node.offline() && headers.contains_key("x-apolloon-app-version") {
        return Err(refusal(
            StatusCode::SERVICE_UNAVAILABLE,
            "isolated",
            "isolated",
        ));
    }
    if headers
        .get("x-apolloon-app-version")
        .is_some_and(|v| v.to_str().ok() != Some(super::APP_VERSION))
    {
        return Err(refusal(
            StatusCode::UPGRADE_REQUIRED,
            "upgrade_required",
            "Die laptop draait een andere versie. Installeer overal dezelfde versie.",
        ));
    }
    Ok(node)
}

async fn blocking(work: impl FnOnce() -> Response + Send + 'static) -> Response {
    tokio::task::spawn_blocking(work)
        .await
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn status(State(host): State<Host>, headers: HeaderMap) -> Response {
    let headers_out = [
        ("Cache-Control", "no-store"),
        ("Access-Control-Allow-Origin", "*"),
    ];
    match node(&host, &headers) {
        Ok(node) => blocking(move || (headers_out, Json(node.status())).into_response()).await,
        Err(_) if host.cluster.is_none() => {
            (headers_out, Json(json!({"enabled": false}))).into_response()
        }
        Err(refused) => refused,
    }
}

/// What a group test asks every laptop: its copy of the test mark and how far its log is.
async fn probe(
    State(host): State<Host>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    let id = query.get("id").cloned().unwrap_or_default();
    match node(&host, &headers) {
        Ok(node) => blocking(move || Json(node.probe_here(&id)).into_response()).await,
        Err(refused) => refused,
    }
}

async fn peer(
    State(host): State<Host>,
    axum::extract::ConnectInfo(remote): axum::extract::ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    let node = match node(&host, &headers) {
        Ok(node) => node,
        Err(refused) => return refused,
    };
    blocking(move || {
        let body = &request["body"];
        // A laptop of another split is neither followed nor voted for; a joining laptop takes everything.
        let joining = node.busy() == Some("joining");
        if !joining
            && body["split"].as_str().unwrap_or("") != node.split()["id"].as_str().unwrap_or("")
        {
            return refusal(
                StatusCode::CONFLICT,
                "other_split",
                "Deze laptops werkten apart verder.",
            );
        }
        match request["type"].as_str() {
            Some("append") => {
                if body["clusterId"].as_str() != Some(&node.cluster_id()) {
                    return refusal(
                        StatusCode::CONFLICT,
                        "cluster_mismatch",
                        "Deze laptops horen bij een andere groep.",
                    );
                }
                Json(node.handle_append(body, Some(remote.ip()))).into_response()
            }
            Some("vote") => {
                let candidate = body["candidateId"].as_str().unwrap_or("");
                let cluster_id = body["clusterId"].as_str().unwrap_or("");
                if cluster_id == node.cluster_id() && node.was_removed(candidate) {
                    return Json(json!({"term": node.term(), "granted": false, "removed": true}))
                        .into_response();
                }
                node.welcome_back(
                    candidate,
                    body["candidateUrl"].as_str().unwrap_or(""),
                    cluster_id,
                );
                Json(node.handle_vote(body)).into_response()
            }
            _ => refusal(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "Onbekende aanvraag.",
            ),
        }
    })
    .await
}

fn not_leader() -> Response {
    refusal(
        StatusCode::CONFLICT,
        "not_leader",
        "Deze laptop is niet de hoofdlaptop.",
    )
}

async fn snapshot(State(host): State<Host>, headers: HeaderMap) -> Response {
    let node = match node(&host, &headers) {
        Ok(node) => node,
        Err(refused) => return refused,
    };
    blocking(move || {
        if !node.is_leader() || node.busy().is_some() {
            return not_leader();
        }
        let term = node.term();
        // A database on disk is copied without holding its lock: the copy takes a while for a
        // long race, and the other laptops must keep hearing from this one meanwhile.
        let on_disk = crate::backups::database_path(&node.db.lock().unwrap()).ok();
        let image = match on_disk {
            Some(path) => super::log::serialize_file(&path),
            None => super::log::serialize(&node.db.lock().unwrap()),
        };
        match image {
            Ok(image) => {
                use base64::Engine;
                (
                    [("Cache-Control", "no-store".to_owned()), ("X-Apolloon-Epoch", term.to_string())],
                    Json(json!({"term": term, "image": base64::engine::general_purpose::STANDARD.encode(image)})),
                )
                    .into_response()
            }
            Err(error) => refusal(StatusCode::INTERNAL_SERVER_ERROR, "snapshot_failed", &error),
        }
    })
    .await
}

async fn members(
    State(host): State<Host>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    let node = match node(&host, &headers) {
        Ok(node) => node,
        Err(refused) => return refused,
    };
    blocking(move || {
        let host_id = request["hostId"]
            .as_str()
            .filter(|h| !h.is_empty() && h.len() <= 128);
        let url = request["url"].as_str().and_then(super::join::normalize_url);
        let (Some(host_id), Some(url)) = (host_id, url) else {
            return refusal(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "Ongeldige koppelaanvraag.",
            );
        };
        if !node.is_leader() || node.busy().is_some() {
            return not_leader();
        }
        let member = super::log::Member {
            host_id: host_id.into(),
            url,
            name: request["name"]
                .as_str()
                .map(|n| n.chars().take(64).collect()),
        };
        if let Err(error) = node.make_room_for(&member) {
            return refusal(StatusCode::CONFLICT, "refused", &error);
        }
        // Making room waits for the other laptops: this one may have stopped leading meanwhile.
        if !node.is_leader() || node.busy().is_some() {
            return not_leader();
        }
        match node.add_member(&member, request["autoLinkedWith"].as_str()) {
            // The laptop that joins signs with this group's key from here on.
            Ok(()) => Json(json!({
                "ok": true,
                "term": node.term(),
                "groupKey": node.group_keys().first(),
            }))
            .into_response(),
            Err(error) => refusal(StatusCode::CONFLICT, "refused", &error),
        }
    })
    .await
}

async fn invite(
    State(host): State<Host>,
    signed: Option<axum::Extension<Signed>>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    let node = match node(&host, &headers) {
        Ok(node) => node,
        Err(refused) => return refused,
    };
    blocking(move || {
        if !request["url"].is_string() || !request["clusterId"].is_string() {
            return refusal(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "Ongeldige koppelaanvraag.",
            );
        }
        match node.accept_invite(&request, signed.is_some_and(|s| s.0.0)) {
            Ok(merged) => Json(json!({"ok": true, "merged": merged})).into_response(),
            Err(error) => refusal(StatusCode::CONFLICT, "refused", &error),
        }
    })
    .await
}

/// A write another laptop passes on; refused before anything runs when this one no longer leads.
async fn write(
    State(host): State<Host>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    let node = match node(&host, &headers) {
        Ok(node) => node,
        Err(refused) => return refused,
    };
    blocking(move || {
        if !node.is_leader() || node.busy().is_some() {
            return not_leader();
        }
        let (Some(method), Some(request_id)) =
            (request["method"].as_str(), request["requestId"].as_str())
        else {
            return refusal(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "Ongeldige schrijfaanvraag.",
            );
        };
        match node.commit_local(
            method,
            &request["input"],
            request["origin"].as_str().unwrap_or(""),
            request_id,
        ) {
            Ok((result, seq)) => Json(json!({"result": result, "seq": seq})).into_response(),
            Err(failure) => refusal(
                StatusCode::CONFLICT,
                if failure.retry {
                    "unavailable"
                } else {
                    "refused"
                },
                &failure.message,
            ),
        }
    })
    .await
}

/// Where the log of another split of this group still matches this leader's.
async fn split_common(
    State(host): State<Host>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    let node = match node(&host, &headers) {
        Ok(node) => node,
        Err(refused) => return refused,
    };
    blocking(move || {
        if !node.is_leader() || node.busy().is_some() {
            return not_leader();
        }
        Json(json!({"ok": true, "seq": node.common_entry(&request["marks"])})).into_response()
    })
    .await
}

/// What another split of this group saved while apart, added here before that split follows.
async fn split_merge(
    State(host): State<Host>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    let node = match node(&host, &headers) {
        Ok(node) => node,
        Err(refused) => return refused,
    };
    blocking(move || {
        if !node.is_leader() || node.busy().is_some() {
            return not_leader();
        }
        match node.merge_split(&request) {
            Ok(result) => Json(result).into_response(),
            Err((retry, message)) => refusal(
                StatusCode::CONFLICT,
                if retry { "unavailable" } else { "refused" },
                &message,
            ),
        }
    })
    .await
}

async fn time() -> Response {
    (
        [("Cache-Control", "no-store")],
        Json(json!({"serverNowMs": crate::db::now()})),
    )
        .into_response()
}
