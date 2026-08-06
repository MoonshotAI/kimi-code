//! HTTP/REST projection — the `/api/v1` surface web hosts consume, served by
//! the same `MessageProcessor` as the stdio/WS transports.
//!
//! This is the Rust replacement for `kap-server`'s Fastify `/api/v1` routes
//! (kimi-web / vscode / kimi-inspect / vis connect here). Every REST handler
//! is a thin projection onto an existing JSON-RPC method; the `{ code, msg,
//! data, request_id }` envelope mirrors `kap-server/src/protocol/envelope`.
//!
//! The surface is additive: add a route here when a web host needs it, and
//! keep it a pure transport concern (no engine logic in this module).

use std::sync::Arc;

use base64::Engine as _;
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use kimi_protocol::rpc::JsonRpcRequest;
use kimi_server::processor::MessageProcessor;
use serde_json::{json, Value};

/// `{ code, msg, data, request_id }` envelope (kap-server `okEnvelope`).
fn ok(data: Value) -> Value {
    json!({ "code": 0, "msg": "success", "data": data, "request_id": "" })
}

/// `{ code, msg, data: null, request_id }` envelope (kap-server `errEnvelope`).
fn err(code: i64, msg: &str) -> Value {
    json!({ "code": code, "msg": msg, "data": null, "request_id": "" })
}

/// Expected bearer credential for REST + WS (mirrors kap-server's
/// `server.token` / `KIMI_CODE_PASSWORD`). `None` runs lenient (no auth).
#[derive(Clone, Debug)]
pub struct AuthConfig {
    pub token: Option<String>,
}

/// Shared handler state: the processor all transports serve, plus the engine
/// event source (when present) so WS clients receive live session events.
#[derive(Clone)]
pub struct HttpState {
    processor: Arc<MessageProcessor>,
    events: Option<tokio::sync::broadcast::Sender<serde_json::Value>>,
    auth: AuthConfig,
    /// Server self-info for `/api/v1/meta` (frozen at construction).
    server_version: String,
    server_id: String,
    started_at: String,
    /// `/api/v1/shutdown` fires this channel when configured. `Arc<Mutex>`
    /// so handler clones (per request) share the same sender.
    shutdown: Option<Arc<tokio::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>>>,
}

impl HttpState {
    pub fn new(processor: Arc<MessageProcessor>) -> Self {
        Self {
            processor,
            events: None,
            auth: AuthConfig { token: None },
            server_version: std::env::var("KIMI_CODE_VERSION")
                .unwrap_or_else(|_| "dev".to_string()),
            server_id: format!(
                "kimi-{:x}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0)
            ),
            started_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs().to_string())
                .unwrap_or_default(),
            shutdown: None,
        }
    }

    /// Build with the engine event source attached (WS clients get live
    /// session events fanned out).
    pub fn with_events(
        processor: Arc<MessageProcessor>,
        events: tokio::sync::broadcast::Sender<serde_json::Value>,
    ) -> Self {
        Self {
            processor,
            events: Some(events),
            auth: AuthConfig { token: None },
            server_version: std::env::var("KIMI_CODE_VERSION")
                .unwrap_or_else(|_| "dev".to_string()),
            server_id: format!(
                "kimi-{:x}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0)
            ),
            started_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs().to_string())
                .unwrap_or_default(),
            shutdown: None,
        }
    }

    /// Arm `/api/v1/shutdown` to fire `tx` (used with graceful shutdown).
    pub fn with_shutdown(
        mut self,
        tx: Arc<tokio::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
    ) -> Self {
        self.shutdown = Some(tx);
        self
    }

    /// Attach the expected bearer credential (REST `Authorization` header +
    /// WS `kimi-code.bearer.*` subprotocol).
    pub fn with_auth(mut self, auth: AuthConfig) -> Self {
        self.auth = auth;
        self
    }

    /// True when a credential is required.
    pub fn auth_required(&self) -> bool {
        self.auth.token.is_some()
    }

    /// Dispatch one JSON-RPC method and return the REST envelope.
    async fn rpc(&self, method: &str, params: Value) -> Value {
        let request = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: method.into(),
            params,
        };
        let body = self.processor.handle(request).await;
        if let Some(error) = body.get("error") {
            err(
                error["code"].as_i64().unwrap_or(-32603),
                error["message"].as_str().unwrap_or("error"),
            )
        } else {
            ok(body["result"].clone())
        }
    }
}

/// Build the `/api/v1` router.
pub fn router(state: HttpState) -> Router {
    let middleware = axum::middleware::from_fn_with_state(state.clone(), require_auth);
    Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/meta", get(meta))
        .route("/api/v1/shutdown", post(shutdown))
        .route("/api/v1/config", get(config_get).post(config_set))
        .route("/api/v1/sessions", get(sessions_list).post(sessions_create))
        .route(
            "/api/v1/sessions/{id}",
            get(session_status).post(session_update).delete(session_delete),
        )
        .route("/api/v1/sessions/{id}/prompt", post(session_prompt))
        .route("/api/v1/sessions/{id}/cancel", post(session_cancel))
        .route("/api/v1/sessions/{id}/fork", post(session_fork))
        .route("/api/v1/sessions/{id}/archive", post(session_archive))
        .route("/api/v1/sessions/{id}/skills", get(session_skills))
        .route("/api/v1/sessions/{id}/tools", get(session_tools))
        .route("/api/v1/sessions/{id}/context", get(session_context))
        .route("/api/v1/sessions/{id}/snapshot", get(session_snapshot))
        .route("/api/v1/sessions/{id}/transcript", get(session_transcript))
        .route("/api/v1/sessions/{id}/usage", get(session_usage))
        .route("/api/v1/sessions/{id}/plan", get(session_plan))
        .route("/api/v1/sessions/{id}/mcp-servers", get(session_mcp_servers))
        .route("/api/v1/sessions/{id}/export", post(session_export))
        .route(
            "/api/v1/sessions/{id}/approvals/{approval_id}/resolve",
            post(session_approval_resolve),
        )
        .route("/api/v1/sessions/{id}/fs:list", post(fs_action_list))
        .route("/api/v1/sessions/{id}/fs:read", post(fs_action_read))
        .route("/api/v1/sessions/{id}/fs:search", post(fs_action_search))
        .route("/api/v1/fs:browse", get(fs_browse))
        .route("/api/v1/fs:home", get(fs_home))
        .route("/api/v1/workspaces", get(workspaces_list))
        .route("/api/v1/workspaces/{id}", get(workspace_get))
        .route("/api/v1/auth", get(auth_status))
        .route("/api/v1/models", get(models_list))
        .route("/api/v1/providers", get(providers_list).post(provider_create))
        .route("/api/v1/providers/{id}", put(provider_replace).delete(provider_delete))
        .route("/api/v1/ws", get(ws_upgrade))
        .layer(middleware)
        .with_state(state)
}

/// Bearer-credential guard for the REST surface (mirrors kap-server's auth
/// middleware). Skips WebSocket-upgrade requests — WS carries the credential
/// in the `kimi-code.bearer.*` subprotocol, validated in `ws_upgrade`.
async fn require_auth(
    State(state): State<HttpState>,
    req: axum::http::Request<axum::body::Body>,
    next: axum::middleware::Next,
) -> Response {
    let expected = match &state.auth.token {
        None => return next.run(req).await,
        Some(token) => token.clone(),
    };
    let is_ws = req
        .headers()
        .get(axum::http::header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false);
    if !is_ws {
        let authorized = req
            .headers()
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(|t| t == expected)
            .unwrap_or(false);
        if !authorized {
            return Json(err(40101, "unauthorized")).into_response();
        }
    }
    next.run(req).await
}

/// Build the full web server router: the `/api/v1` projection plus the
/// bundled SPA static assets served from `assets_dir` (any non-API path,
/// SPA-style fallback to `index.html`).
pub fn router_with_assets(state: HttpState, assets_dir: &str) -> Router {
    let assets = tower_http::services::ServeDir::new(assets_dir)
        .append_index_html_on_directories(true);
    router(state).fallback_service(assets)
}

/// Serve the HTTP/REST projection on `listener` until it errors or
/// `/api/v1/shutdown` is called (graceful shutdown).
pub async fn serve(
    processor: Arc<MessageProcessor>,
    listener: tokio::net::TcpListener,
) -> anyhow::Result<()> {
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let state = HttpState::new(processor).with_shutdown(Arc::new(tokio::sync::Mutex::new(
        Some(shutdown_tx),
    )));
    axum::serve(listener, router(state))
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        })
        .await?;
    Ok(())
}

/// Serve the HTTP/REST projection with the engine event source attached, so
/// `/api/v1/ws` clients receive live session events.
pub async fn serve_with_events(
    processor: Arc<MessageProcessor>,
    events: tokio::sync::broadcast::Sender<serde_json::Value>,
    listener: tokio::net::TcpListener,
) -> anyhow::Result<()> {
    axum::serve(listener, router(HttpState::with_events(processor, events))).await?;
    Ok(())
}

/// Serve the full web server — the `/api/v1` projection with engine events,
/// plus the bundled SPA from `assets_dir` — the `kimi web` Rust replacement.
pub async fn serve_web(
    processor: Arc<MessageProcessor>,
    events: tokio::sync::broadcast::Sender<serde_json::Value>,
    assets_dir: &str,
    listener: tokio::net::TcpListener,
) -> anyhow::Result<()> {
    let state = HttpState::with_events(processor, events);
    axum::serve(listener, router_with_assets(state, assets_dir)).await?;
    Ok(())
}

// ── Handlers ────────────────────────────────────────────────────────────

/// `GET /api/v1/health` — engine health (`{ status }`).
async fn health(State(state): State<HttpState>) -> Json<Value> {
    Json(state.rpc(kimi_protocol::methods::HEALTH, Value::Null).await)
}

/// `GET /api/v1/meta` — server self-info (version, capabilities, id).
async fn meta(State(state): State<HttpState>) -> Json<Value> {
    Json(ok(json!({
        "server_version": state.server_version,
        "capabilities": {
            "websocket": true,
            "file_upload": true,
            "fs_query": true,
            "mcp": true,
            "tasks": true,
            "terminal": true
        },
        "server_id": state.server_id,
        "started_at": state.started_at,
        "open_in_apps": [],
        "dangerous_bypass_auth": state.auth.token.is_none(),
        "backend": "v2"
    })))
}

/// `POST /api/v1/shutdown` — fire the graceful-shutdown channel (reply first
/// so the caller gets a clean 200 instead of a dropped connection).
async fn shutdown(State(state): State<HttpState>) -> Json<Value> {
    if let Some(arc) = &state.shutdown {
        let mut guard = arc.lock().await;
        if let Some(tx) = guard.take() {
            let _ = tx.send(());
        }
    }
    Json(ok(json!({ "shutting_down": true })))
}

/// `GET /api/v1/config` — the engine's parsed config.
async fn config_get(State(state): State<HttpState>) -> Json<Value> {
    Json(state.rpc(kimi_protocol::methods::CONFIG_GET, Value::Null).await)
}

/// `POST /api/v1/config` — apply a config patch (`{ patch }`).
async fn config_set(State(state): State<HttpState>, Json(body): Json<Value>) -> Json<Value> {
    let patch = body.get("patch").cloned().unwrap_or(json!({}));
    Json(state.rpc(kimi_protocol::methods::CONFIG_SET, json!({ "patch": patch })).await)
}

/// `GET /api/v1/sessions` — persisted sessions (`{ limit }` query).
async fn sessions_list(State(state): State<HttpState>, Query(query): Query<Value>) -> Json<Value> {
    let limit = query.get("limit").and_then(|v| v.as_u64()).unwrap_or(50);
    Json(state.rpc(kimi_protocol::methods::SESSION_LIST, json!({ "limit": limit })).await)
}

/// `POST /api/v1/sessions` — create a session (`{ session_id }` body).
async fn sessions_create(State(state): State<HttpState>, Json(body): Json<Value>) -> Json<Value> {
    let session_id = body.get("session_id").and_then(|v| v.as_str()).unwrap_or_default();
    Json(state.rpc(kimi_protocol::methods::SESSION_CREATE, json!({ "session_id": session_id })).await)
}

/// `GET /api/v1/sessions/{id}` — session status.
async fn session_status(State(state): State<HttpState>, Path(id): Path<String>) -> Json<Value> {
    Json(state.rpc(kimi_protocol::methods::SESSION_GET_STATUS, json!({ "session_id": id })).await)
}

/// `POST /api/v1/sessions/{id}` — session update (metadata / model).
async fn session_update(State(state): State<HttpState>, Path(id): Path<String>, Json(body): Json<Value>) -> Json<Value> {
    let method = if let Some(model) = body.get("model").and_then(|v| v.as_str()) {
        state.rpc(kimi_protocol::methods::SESSION_SET_MODEL, json!({ "session_id": id, "model": model })).await
    } else if let Some(title) = body.get("title").and_then(|v| v.as_str()) {
        state.rpc(kimi_protocol::methods::SESSION_RENAME, json!({ "session_id": id, "title": title })).await
    } else {
        err(-32602, "no recognized update field")
    };
    Json(method)
}

/// `POST /api/v1/sessions/{id}/prompt` — run one prompt (`{ input }`).
async fn session_prompt(State(state): State<HttpState>, Path(id): Path<String>, Json(body): Json<Value>) -> Json<Value> {
    let input = body.get("input").cloned().unwrap_or(Value::Null);
    Json(state.rpc(kimi_protocol::methods::SESSION_PROMPT, json!({ "session_id": id, "input": input })).await)
}

/// `DELETE /api/v1/sessions/{id}` — permanently delete a session.
async fn session_delete(State(state): State<HttpState>, Path(id): Path<String>) -> Json<Value> {
    Json(state.rpc(kimi_protocol::methods::SESSION_DELETE, json!({ "session_id": id })).await)
}

/// `GET /api/v1/sessions/{id}/skills` — skills available to the session.
async fn session_skills(State(state): State<HttpState>, Path(id): Path<String>) -> Json<Value> {
    Json(state.rpc(kimi_protocol::methods::SESSION_LIST_SKILLS, json!({ "session_id": id })).await)
}

/// `GET /api/v1/sessions/{id}/tools` — tools available to the session.
async fn session_tools(State(state): State<HttpState>, Path(id): Path<String>) -> Json<Value> {
    Json(state.rpc(kimi_protocol::methods::SESSION_LIST_TOOLS, json!({ "session_id": id })).await)
}

/// `GET /api/v1/sessions/{id}/context` — the session context.
async fn session_context(State(state): State<HttpState>, Path(id): Path<String>) -> Json<Value> {
    Json(state.rpc(kimi_protocol::methods::SESSION_GET_CONTEXT, json!({ "session_id": id })).await)
}

/// `POST /api/v1/sessions/{id}/fork` — fork the session under a new id.
async fn session_fork(State(state): State<HttpState>, Path(id): Path<String>, Json(body): Json<Value>) -> Json<Value> {
    let mut params = json!({ "session_id": id });
    if let Some(fork_id) = body.get("fork_id").and_then(|v| v.as_str()) {
        params["fork_id"] = json!(fork_id);
    }
    if let Some(title) = body.get("title").and_then(|v| v.as_str()) {
        params["title"] = json!(title);
    }
    Json(state.rpc(kimi_protocol::methods::SESSION_FORK, params).await)
}

/// `POST /api/v1/sessions/{id}/archive` — archive the session.
async fn session_archive(State(state): State<HttpState>, Path(id): Path<String>) -> Json<Value> {
    Json(state.rpc(kimi_protocol::methods::SESSION_ARCHIVE, json!({ "session_id": id })).await)
}

/// `GET /api/v1/sessions/{id}/snapshot` — IM-style initial sync: the session
/// status plus its accumulated context messages (kap-server snapshot
/// projection over the engine).
async fn session_snapshot(State(state): State<HttpState>, Path(id): Path<String>) -> Json<Value> {
    let status = state.rpc(kimi_protocol::methods::SESSION_GET_STATUS, json!({ "session_id": id })).await;
    if status["code"].as_i64() != Some(0) {
        return Json(status);
    }
    let context = state.rpc(kimi_protocol::methods::SESSION_GET_CONTEXT, json!({ "session_id": id })).await;
    let messages = context["data"].get("messages").cloned().unwrap_or(Value::Null);
    let snapshot = json!({
        "as_of_seq": 0,
        "epoch": "engine",
        "session": status["data"],
        "messages": { "items": messages, "has_more": false },
        "in_flight_turn": null,
    });
    Json(ok(snapshot))
}

/// `GET /api/v1/sessions/{id}/transcript` — turn-granular transcript rebuilt
/// from the engine context messages (kap-server transcript projection).
async fn session_transcript(State(state): State<HttpState>, Path(id): Path<String>) -> Json<Value> {
    let context = state.rpc(kimi_protocol::methods::SESSION_GET_CONTEXT, json!({ "session_id": id })).await;
    if context["code"].as_i64() != Some(0) {
        return Json(context);
    }
    let messages = context["data"].get("messages").and_then(|m| m.as_array()).cloned().unwrap_or_default();
    let items: Vec<Value> = messages
        .into_iter()
        .map(|m| json!({
            "kind": "message",
            "role": m["role"],
            "content": m["content"],
        }))
        .collect();
    Json(ok(json!({ "items": items, "has_more": false })))
}

/// `GET /api/v1/sessions/{id}/usage` — token usage snapshot.
async fn session_usage(State(state): State<HttpState>, Path(id): Path<String>) -> Json<Value> {
    Json(state.rpc(kimi_protocol::methods::SESSION_GET_USAGE, json!({ "session_id": id })).await)
}

/// `GET /api/v1/sessions/{id}/plan` — the active plan, if any.
async fn session_plan(State(state): State<HttpState>, Path(id): Path<String>) -> Json<Value> {
    Json(state.rpc(kimi_protocol::methods::SESSION_GET_PLAN, json!({ "session_id": id })).await)
}

/// `POST /api/v1/sessions/{id}/export` — stream the session diagnostic
/// archive as a ZIP download (`session/export` → base64 → decode → binary).
async fn session_export(State(state): State<HttpState>, Path(id): Path<String>) -> Response {
    let envelope = state.rpc(kimi_protocol::methods::SESSION_EXPORT, json!({ "session_id": id })).await;
    if envelope["code"].as_i64() != Some(0) {
        return Json(envelope).into_response();
    }
    let b64 = envelope["data"]["zip_base64"].as_str().unwrap_or_default();
    match base64::engine::general_purpose::STANDARD.decode(b64) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/zip")
            .header("content-disposition", "attachment")
            .body(Body::from(bytes))
            .expect("response")
            .into_response(),
        Err(error) => Json(err(-32603, &format!("zip decode failed: {error}"))).into_response(),
    }
}

/// `GET /api/v1/sessions/{id}/mcp-servers` — configured MCP servers.
async fn session_mcp_servers(State(state): State<HttpState>, Path(id): Path<String>) -> Json<Value> {
    Json(state.rpc(kimi_protocol::methods::SESSION_LIST_MCP_SERVERS, json!({ "session_id": id })).await)
}

/// `POST /api/v1/sessions/{id}/approvals/{approval_id}/resolve` — resolve a
/// pending approval (`{ decision: "allow"|"deny", reason? }`).
async fn session_approval_resolve(
    State(state): State<HttpState>,
    Path((_id, approval_id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Json<Value> {
    let mut params = json!({ "id": approval_id });
    if let Some(decision) = body.get("decision").and_then(|v| v.as_str()) {
        params["decision"] = json!(decision);
    }
    if let Some(reason) = body.get("reason").and_then(|v| v.as_str()) {
        params["reason"] = json!(reason);
    }
    Json(state.rpc(kimi_protocol::methods::SESSION_APPROVAL_RESOLVE, params).await)
}

/// `POST /api/v1/sessions/{id}/cancel` — cancel the active turn.
async fn session_cancel(State(state): State<HttpState>, Path(id): Path<String>) -> Json<Value> {
    Json(state.rpc(kimi_protocol::methods::SESSION_CANCEL, json!({ "session_id": id })).await)
}

/// The session's workspace root (from `session/list`'s session summary),
/// used as the `session/fs` sandbox root. Falls back to the server's process
/// working directory when the session has no recorded workspace.
async fn session_workdir(state: &HttpState, id: &str) -> Option<String> {
    let sessions = state.rpc(kimi_protocol::methods::SESSION_LIST, json!({ "limit": 500 })).await;
    let recorded = sessions["data"]["sessions"]
        .as_array()?
        .iter()
        .find(|s| s["id"] == id)?
        .get("work_dir")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    if recorded.is_some() {
        return recorded;
    }
    std::env::current_dir().ok().map(|d| d.to_string_lossy().into_owned())
}

/// `POST /api/v1/sessions/{id}/fs:list` — list a workspace directory
/// (`{ path }` body; `session/fs` `action=list` → native Glob).
async fn fs_action_list(State(state): State<HttpState>, Path(id): Path<String>, Json(body): Json<Value>) -> Json<Value> {
    fs_action(state, &id, "list", body).await
}

/// `POST /api/v1/sessions/{id}/fs:read` — read a file (`{ path }` body).
async fn fs_action_read(State(state): State<HttpState>, Path(id): Path<String>, Json(body): Json<Value>) -> Json<Value> {
    fs_action(state, &id, "read", body).await
}

/// `POST /api/v1/sessions/{id}/fs:search` — search a workspace (`{ path }`).
async fn fs_action_search(State(state): State<HttpState>, Path(id): Path<String>, Json(body): Json<Value>) -> Json<Value> {
    fs_action(state, &id, "search", body).await
}

/// Shared `session/fs` projection for the `fs:action` routes.
async fn fs_action(state: HttpState, id: &str, action: &str, body: Value) -> Json<Value> {
    let workdir = session_workdir(&state, id).await;
    let mut params = json!({ "session_id": id, "action": action });
    if let Some(h) = workdir.clone() {
        params["homedir"] = json!(h);
    }
    if action == "list" {
        // The engine's Glob lists a pattern under a search root: map the
        // client's directory request (`path`) to a pattern, rooted at the
        // session workspace (`.` → the workspace root itself).
        let requested = body.get("path").and_then(|v| v.as_str()).unwrap_or("*");
        let pattern = if requested == "." || requested.is_empty() {
            "*".to_string()
        } else {
            format!("{}/**", requested.trim_end_matches('/'))
        };
        params["query"] = json!(pattern);
        if let Some(h) = workdir {
            params["path"] = json!(h);
        }
    } else if let Some(path) = body.get("path").and_then(|v| v.as_str()) {
        params["path"] = json!(path);
    }
    Json(state.rpc(kimi_protocol::methods::SESSION_FS, params).await)
}

/// `GET /api/v1/fs:browse?path=` — daemon folder browser (list a directory).
async fn fs_browse(State(state): State<HttpState>, Query(query): Query<Value>) -> Json<Value> {
    let mut params = json!({ "session_id": "", "action": "list" });
    if let Some(path) = query.get("path").and_then(|v| v.as_str()) {
        params["path"] = json!(path);
    }
    if let Ok(cwd) = std::env::current_dir() {
        params["homedir"] = json!(cwd.to_string_lossy());
    }
    Json(state.rpc(kimi_protocol::methods::SESSION_FS, params).await)
}

/// `GET /api/v1/fs:home` — the daemon's home directory + recent roots.
async fn fs_home(State(_state): State<HttpState>) -> Json<Value> {
    let home = std::env::current_dir()
        .map(|d| d.to_string_lossy().into_owned())
        .unwrap_or_default();
    Json(ok(json!({ "home": home, "recent_roots": [] })))
}

/// `GET /api/v1/workspaces` — distinct session workspace roots.
async fn workspaces_list(State(state): State<HttpState>) -> Json<Value> {
    let sessions = state.rpc(kimi_protocol::methods::SESSION_LIST, json!({ "limit": 500 })).await;
    if sessions["code"].as_i64() != Some(0) {
        return Json(sessions);
    }
    let mut seen = std::collections::BTreeSet::new();
    for session in sessions["data"]["sessions"].as_array().unwrap_or(&Vec::new()) {
        let workdir = session["workDir"]
            .as_str()
            .or_else(|| session["work_dir"].as_str())
            .or_else(|| session["metadata"]["cwd"].as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .or_else(|| std::env::current_dir().ok().map(|d| d.to_string_lossy().into_owned()));
        if let Some(wd) = workdir {
            seen.insert(wd);
        }
    }
    if seen.is_empty() {
        if let Ok(cwd) = std::env::current_dir() {
            seen.insert(cwd.to_string_lossy().into_owned());
        }
    }
    let workspaces: Vec<Value> = seen
        .into_iter()
        .enumerate()
        .map(|(i, id)| json!({ "id": format!("wd_{}", i + 1), "path": id }))
        .collect();
    Json(ok(json!({ "workspaces": workspaces })))
}

/// `GET /api/v1/workspaces/{id}` — one workspace by id.
async fn workspace_get(State(state): State<HttpState>, Path(id): Path<String>) -> Json<Value> {
    let workspaces = workspaces_list(State(state)).await;
    let ws = workspaces.0["data"]["workspaces"]
        .as_array()
        .and_then(|ws| ws.iter().find(|w| w["id"] == id))
        .cloned()
        .unwrap_or(Value::Null);
    if ws.is_null() {
        return Json(err(-40401, "workspace not found"));
    }
    Json(ok(ws))
}

/// `GET /api/v1/auth` — readiness probe projected from the engine config
/// (kap-server `AuthSummary`: `{ ready, providers_count, default_model,
/// managed_provider }`).
async fn auth_status(State(state): State<HttpState>) -> Json<Value> {
    let config = state.rpc(kimi_protocol::methods::CONFIG_GET, Value::Null).await;
    if config["code"].as_i64() != Some(0) {
        return Json(config);
    }
    let data = &config["data"];
    let providers = data["providers"].as_object().map(|p| p.len()).unwrap_or(0);
    let summary = json!({
        "ready": providers > 0 || data["defaultModel"].as_str().is_some(),
        "providers_count": providers,
        "default_model": data["defaultModel"],
        "managed_provider": null,
    });
    Json(ok(summary))
}

/// `GET /api/v1/models` — configured model aliases + default (kap-server
/// catalog projection over the engine config).
async fn models_list(State(state): State<HttpState>) -> Json<Value> {
    let config = state.rpc(kimi_protocol::methods::CONFIG_GET, Value::Null).await;
    if config["code"].as_i64() != Some(0) {
        return Json(config);
    }
    let data = &config["data"];
    let aliases: Vec<Value> = data["models"]
        .as_object()
        .map(|m| m.keys().cloned().map(Value::String).collect())
        .unwrap_or_default();
    let default_model = data["defaultModel"].as_str().map(|s| s.to_string());
    Json(ok(json!({ "models": aliases, "default_model": default_model })))
}

/// `GET /api/v1/providers` — configured providers (kap-server catalog
/// projection over the engine config).
async fn providers_list(State(state): State<HttpState>) -> Json<Value> {
    let config = state.rpc(kimi_protocol::methods::CONFIG_GET, Value::Null).await;
    if config["code"].as_i64() != Some(0) {
        return Json(config);
    }
    let providers: Vec<Value> = config["data"]["providers"]
        .as_object()
        .map(|p| {
            p.iter()
                .map(|(id, v)| {
                    json!({
                        "id": id,
                        "type": v["type"].as_str().unwrap_or("openai"),
                        "model": v["model"],
                        "base_url": v["baseUrl"],
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Json(ok(json!({ "providers": providers })))
}

/// `POST /api/v1/providers` — create a provider (`{ id, type, api_key,
/// base_url, default_model, models }`) as a config patch.
async fn provider_create(State(state): State<HttpState>, Json(body): Json<Value>) -> Json<Value> {
    let id = body.get("id").and_then(|v| v.as_str()).unwrap_or_default();
    if id.is_empty() {
        return Json(err(-32602, "provider create requires an id"));
    }
    let mut provider = json!({ "type": body.get("type").and_then(|v| v.as_str()).unwrap_or("openai") });
    if let Some(api_key) = body.get("api_key").and_then(|v| v.as_str()) {
        provider["apiKey"] = json!(api_key);
    }
    if let Some(base_url) = body.get("base_url").and_then(|v| v.as_str()) {
        provider["baseUrl"] = json!(base_url);
    }
    if let Some(model) = body.get("default_model").and_then(|v| v.as_str()) {
        provider["model"] = json!(model);
    }
    let patch = json!({ "providers": { id: provider } });
    Json(state.rpc(kimi_protocol::methods::CONFIG_SET, json!({ "patch": patch })).await)
}

/// `PUT /api/v1/providers/{id}` — replace a provider (same projection as
/// create, keyed by the path id).
async fn provider_replace(State(state): State<HttpState>, Path(id): Path<String>, Json(body): Json<Value>) -> Json<Value> {
    let mut body = body;
    body["id"] = json!(id);
    provider_create(State(state), Json(body)).await
}

/// `DELETE /api/v1/providers/{id}` — delete a provider (null-patch).
async fn provider_delete(State(state): State<HttpState>, Path(id): Path<String>) -> Json<Value> {
    let patch = json!({ "providers": { id: null } });
    Json(state.rpc(kimi_protocol::methods::CONFIG_SET, json!({ "patch": patch })).await)
}

/// `GET /api/v1/ws` — upgrade to the WebSocket JSON-RPC transport; when the
/// engine event source is attached, live session events are also fanned out
/// to the connection as text frames. Auth: the client offers the
/// `kimi-code.bearer.<credential>` subprotocol (kap-server parity).
async fn ws_upgrade(
    State(state): State<HttpState>,
    ws: axum::extract::WebSocketUpgrade,
) -> Response {
    if let Some(expected) = &state.auth.token {
        let expected_protocol = format!("kimi-code.bearer.{expected}");
        let authorized = ws
            .requested_protocols()
            .any(|p| p == expected_protocol.as_str());
        if !authorized {
            return Json(err(40101, "unauthorized")).into_response();
        }
        return ws
            .protocols([expected_protocol])
            .on_upgrade(move |socket| {
                serve_ws(socket, state.processor.clone(), state.events.clone())
            });
    }
    let processor = state.processor.clone();
    let events = state.events.clone();
    ws.on_upgrade(move |socket| serve_ws(socket, processor, events))
}

/// Serve one upgraded WebSocket connection (JSON-RPC frames, same as
/// `websocket::serve_connection` but over an axum socket), plus engine-event
/// fan-out when an event source is attached.
async fn serve_ws(
    socket: axum::extract::ws::WebSocket,
    processor: Arc<MessageProcessor>,
    events: Option<tokio::sync::broadcast::Sender<serde_json::Value>>,
) {
    use axum::extract::ws::Message as AxumMessage;
    use futures_util::{SinkExt, StreamExt};
    let (sink, mut source) = socket.split();
    let sink = Arc::new(tokio::sync::Mutex::new(sink));

    // Forward engine events to this client (fire-and-forget task; ends when
    // the channel closes or the connection drops).
    if let Some(events) = events {
        let sink = sink.clone();
        tokio::spawn(async move {
            let mut rx = events.subscribe();
            loop {
                match rx.recv().await {
                    Ok(event) => {
                        let mut sink = sink.lock().await;
                        if sink
                            .send(AxumMessage::Text(serde_json::to_string(&event).unwrap_or_default().into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    while let Some(msg) = source.next().await {
        let Ok(msg) = msg else { break };
        match msg {
            AxumMessage::Text(text) => {
                let line = text.trim().to_string();
                if line.is_empty() {
                    continue;
                }
                let processor = processor.clone();
                let sink = sink.clone();
                tokio::spawn(async move {
                    let response = match serde_json::from_str::<JsonRpcRequest>(&line) {
                        Ok(request) => processor.handle(request).await,
                        Err(_) => json!({
                            "jsonrpc": "2.0",
                            "id": null,
                            "error": { "code": -32700, "message": "Parse error" },
                        }),
                    };
                    let mut sink = sink.lock().await;
                    let _ = sink.send(AxumMessage::Text(response.to_string().into())).await;
                });
            }
            AxumMessage::Close(_) => break,
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kimi_server::processor::Processor;
    use kimi_server::request_processors::HealthProcessor;

    /// A processor with just the health method (no store/env needed).
    fn health_processor() -> Arc<MessageProcessor> {
        let mut processor = MessageProcessor::new();
        HealthProcessor.register(&mut processor);
        Arc::new(processor)
    }

    /// Spawn the HTTP projection on an ephemeral port and return its base URL.
    async fn spawn_server() -> String {
        let processor = health_processor();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = tokio::spawn(async move { serve(processor, listener).await });
        let url = format!("http://{addr}");
        // Detach the server task; it runs for the test's lifetime.
        std::mem::forget(server);
        url
    }

    #[tokio::test]
    async fn health_route_returns_ok_envelope() {
        let base = spawn_server().await;
        let resp = reqwest::get(format!("{base}/api/v1/health"))
            .await
            .expect("request")
            .json::<Value>()
            .await
            .expect("json");
        assert_eq!(resp["code"], 0, "resp: {resp}");
        assert_eq!(resp["msg"], "success", "resp: {resp}");
        assert_eq!(resp["data"]["status"], "ok", "resp: {resp}");
    }

    #[tokio::test]
    async fn unknown_route_returns_404() {
        let base = spawn_server().await;
        let resp = reqwest::get(format!("{base}/api/v1/nope"))
            .await
            .expect("request");
        assert_eq!(resp.status(), axum::http::StatusCode::NOT_FOUND);
    }
}
