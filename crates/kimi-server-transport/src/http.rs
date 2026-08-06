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

use crate::v1;

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
    /// Active OAuth device flow for `/api/v1/oauth/login` (start/poll/cancel).
    oauth_flow: Arc<tokio::sync::Mutex<Option<OAuthFlowState>>>,
    /// Shared v1-contract turn state (async prompt submit ↔ WS projector).
    v1: Arc<v1::V1Shared>,
}

/// In-flight OAuth device flow state (POST start stores it; GET polls it).
struct OAuthFlowState {
    config: kimi_oauth::OAuthFlowConfig,
    auth: kimi_oauth::DeviceAuthorization,
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
            oauth_flow: Arc::new(tokio::sync::Mutex::new(None)),
            v1: v1::V1Shared::new(),
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
            oauth_flow: Arc::new(tokio::sync::Mutex::new(None)),
            v1: v1::V1Shared::new(),
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
        .route("/api/v1/healthz", get(health))
        .route("/api/v1/meta", get(meta))
        .route("/api/v1/shutdown", post(shutdown))
        .route("/api/v1/oauth/login", post(oauth_login_start).get(oauth_login_poll).delete(oauth_login_cancel))
        .route("/api/v1/connections", get(connections))
        .route("/api/v1/config", get(config_get).post(config_set))
        // v1-contract session surface (the browser wire): WireSession-shaped
        // list/create/detail + the runtime-status projection the web client
        // reads separately. The engine-shaped `/status` stays available.
        .route("/api/v1/sessions", get(sessions_list_v1).post(sessions_create_v1))
        .route(
            "/api/v1/sessions/{id}",
            get(session_detail_v1).post(session_update).delete(session_delete),
        )
        .route("/api/v1/sessions/{id}/status", get(session_runtime_status))
        .route("/api/v1/sessions/{id}/profile", post(session_profile))
        .route("/api/v1/sessions/{id}/goal", get(session_goal))
        .route("/api/v1/sessions/{id}/warnings", get(session_warnings))
        .route("/api/v1/sessions/{id}/messages", get(session_messages))
        .route("/api/v1/sessions/{id}/compact", post(session_compact))
        .route("/api/v1/sessions/{id}/undo", post(session_undo))
        .route("/api/v1/sessions/{id}/restore", post(session_restore))
        .route("/api/v1/sessions/{id}/prompts/steer", post(session_steer))
        .route("/api/v1/sessions/{id}/prompts/{prompt_id}/abort", post(session_prompt_abort))
        .route("/api/v1/sessions/{id}/abort", post(session_abort_session))
        .route("/api/v1/sessions/{id}/tasks", get(session_tasks))
        .route("/api/v1/sessions/{id}/tasks/{task_id}", get(session_task))
        .route("/api/v1/sessions/{id}/tasks/{task_id}/cancel", post(session_task_cancel))
        .route("/api/v1/sessions/{id}/skills/{skill_name}/activate", post(session_skill_activate))
        .route("/api/v1/sessions/{id}/approvals/{approval_id}", post(session_approval_resolve_v1))
        .route("/api/v1/sessions/{id}/fs:grep", post(fs_action_grep))
        .route("/api/v1/sessions/{id}/fs:git_status", post(fs_git_status))
        .route("/api/v1/sessions/{id}/fs:diff", post(fs_git_diff))
        .route("/api/v1/oauth/logout", post(oauth_logout))
        .route("/api/v1/sessions/{id}/prompt", post(session_prompt))
        .route("/api/v1/sessions/{id}/prompts", post(session_prompt_async))
        .route("/api/v1/sessions/{id}/cancel", post(session_cancel))
        .route("/api/v1/sessions/{id}/fork", post(session_fork))
        .route("/api/v1/sessions/{id}/archive", post(session_archive))
        .route("/api/v1/sessions/{id}/skills", get(session_skills))
        .route("/api/v1/sessions/{id}/tools", get(session_tools))
        .route("/api/v1/sessions/{id}/context", get(session_context))
        .route("/api/v1/sessions/{id}/snapshot", get(session_snapshot_v1))
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

/// Rewrite `{x}:{action}` path segments into `{x}/{action}` so the
/// frontend's colon-suffixed routes (`/sessions/{id}:compact`,
/// `/tasks/{task_id}:cancel`, `/skills/{name}:activate`, …) hit the
/// slash-form routes — axum cannot express a path parameter followed by a
/// literal in one segment. Only known action suffixes are rewritten; the
/// literal colon routes (`fs:grep`, `fs:git_status`, `fs:diff`, `fs:home`)
/// stay untouched. Returns the rewritten path (unchanged when nothing
/// matches).
fn rewrite_path(uri: &axum::http::Uri) -> String {
    /// Colon-suffixed actions the frontend sends (rewritten to slash form).
    const COLON_ACTIONS: &[&str] = &[
        "compact", "undo", "restore", "abort", "steer", "activate", "cancel", "download",
    ];
    let path = uri.path();
    if !path.contains(':') {
        return path.to_string();
    }
    // Expand `{x}:{action}` → `{x}` + `{action}` per segment when the
    // trailing `:word` is a known action.
    let mut parts: Vec<String> = Vec::new();
    for segment in path.split('/') {
        if let Some((base, action)) = segment.rsplit_once(':') {
            if !base.is_empty() && COLON_ACTIONS.contains(&action) {
                parts.push(base.to_string());
                parts.push(action.to_string());
                continue;
            }
        }
        parts.push(segment.to_string());
    }
    parts.join("/")
}

/// A tower `Service` that rewrites colon-suffixed path segments **before**
/// axum's router matches — `Router::layer` runs after matching (a `{id}`
/// segment would greedily capture `sess-1:compact`), so the rewrite must
/// wrap the router itself.
#[derive(Clone)]
pub struct ColonRewrite<S> {
    inner: S,
}

/// Wrap a router (or any service) with the colon-action rewrite.
pub fn colon_rewrite<S>(inner: S) -> ColonRewrite<S> {
    ColonRewrite { inner }
}

impl<S, B> tower::Service<axum::http::Request<B>> for ColonRewrite<S>
where
    S: tower::Service<axum::http::Request<B>>,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = S::Future;

    fn poll_ready(
        &mut self,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: axum::http::Request<B>) -> Self::Future {
        let uri = req.uri().clone();
        let new_path = rewrite_path(&uri);
        let mut req = req;
        if new_path != uri.path() {
            let query = uri.query().map(|q| format!("?{q}")).unwrap_or_default();
            *req.uri_mut() = axum::http::Uri::try_from(format!("{new_path}{query}"))
                .unwrap_or_else(|_| uri.clone());
        }
        self.inner.call(req)
    }
}

/// Make-service: yields a fresh [`ColonRewrite`] wrapping the router per
/// connection. axum's `serve` demands `for<'a> Service<IncomingStream<'a, L>>`,
/// which `tower::service_fn` cannot express — hence the explicit impl.
pub struct ColonMake<L, S> {
    router: S,
    _marker: std::marker::PhantomData<L>,
}

impl<L, S> Clone for ColonMake<L, S>
where
    S: Clone,
{
    fn clone(&self) -> Self {
        Self { router: self.router.clone(), _marker: std::marker::PhantomData }
    }
}

impl<'a, L, S> tower::Service<axum::serve::IncomingStream<'a, L>> for ColonMake<L, S>
where
    L: axum::serve::Listener,
    S: Clone,
{
    type Response = ColonRewrite<S>;
    type Error = std::convert::Infallible;
    type Future = std::future::Ready<Result<ColonRewrite<S>, std::convert::Infallible>>;

    fn poll_ready(
        &mut self,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), Self::Error>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn call(&mut self, _conn: axum::serve::IncomingStream<'a, L>) -> Self::Future {
        std::future::ready(Ok(ColonRewrite { inner: self.router.clone() }))
    }
}

/// Build the make-service that serves `router` with the colon rewrite applied
/// per connection (axum's `serve` needs a `Service<IncomingStream>` make —
/// the rewritten router itself is the per-request service).
pub fn colon_make_service<S>(router: S) -> ColonMake<tokio::net::TcpListener, S>
where
    S: Clone + Send + 'static,
{
    ColonMake { router, _marker: std::marker::PhantomData }
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
    axum::serve(listener, colon_make_service(router(state)))
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
    axum::serve(listener, colon_make_service(router(HttpState::with_events(processor, events)))).await?;
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
    axum::serve(listener, colon_make_service(router_with_assets(state, assets_dir))).await?;
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

/// `POST /api/v1/oauth/login` — start a kimi device-code flow and return the
/// verification info (URI + user code) for the caller to show the user.
async fn oauth_login_start(State(state): State<HttpState>) -> Json<Value> {
    let config = kimi_oauth::OAuthFlowConfig::kimi();
    match kimi_oauth::request_device_authorization(&config).await {
        Ok(auth) => {
            *state.oauth_flow.lock().await = Some(OAuthFlowState {
                config,
                auth: auth.clone(),
            });
            Json(ok(json!({
                "verification_uri": auth.verification_uri,
                "verification_uri_complete": auth.verification_uri_complete,
                "user_code": auth.user_code,
                "expires_in": auth.expires_in,
                "interval": auth.interval,
                "device_code": auth.device_code,
            })))
        }
        Err(e) => Json(err(50001, &format!("oauth start failed: {e}"))),
    }
}

/// `GET /api/v1/oauth/login` — poll the active flow. Resolves with the token
/// pair on success; otherwise the current status (`pending`/`expired`/
/// `denied`). Mirrors kap-server's login poll route.
async fn oauth_login_poll(State(state): State<HttpState>) -> Json<Value> {
    let (config, device_code) = {
        let guard = state.oauth_flow.lock().await;
        match guard.as_ref() {
            Some(f) => (f.config.clone(), f.auth.device_code.clone()),
            None => return Json(err(40401, "no active oauth flow")),
        }
    };
    match kimi_oauth::poll_device_token(&config, &device_code).await {
        Ok(kimi_oauth::DevicePollResult::Success {
            access_token,
            refresh_token,
            expires_in,
        }) => Json(ok(json!({
            "status": "success",
            "access_token": access_token,
            "refresh_token": refresh_token,
            "expires_in": expires_in,
        }))),
        Ok(kimi_oauth::DevicePollResult::Pending) => Json(ok(json!({ "status": "pending" }))),
        Ok(kimi_oauth::DevicePollResult::Expired) => Json(ok(json!({ "status": "expired" }))),
        Ok(kimi_oauth::DevicePollResult::Denied) => Json(ok(json!({ "status": "denied" }))),
        Err(e) => Json(err(50002, &format!("oauth poll failed: {e}"))),
    }
}

/// `DELETE /api/v1/oauth/login` — cancel any pending flow.
async fn oauth_login_cancel(State(state): State<HttpState>) -> Json<Value> {
    let mut guard = state.oauth_flow.lock().await;
    let cancelled = guard.take().is_some();
    Json(ok(json!({ "cancelled": cancelled, "status": "cancelled" })))
}

/// `GET /api/v1/connections` — active WebSocket clients (count via the event
/// broadcast's receiver count; per-connection details are tracked by the WS
/// layer, out of scope here).
async fn connections(State(state): State<HttpState>) -> Json<Value> {
    let count = state.events.as_ref().map(|e| e.receiver_count()).unwrap_or(0);
    Json(ok(json!({ "connections": [], "count": count })))
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

/// Fetch the raw engine envelopes backing one session's v1 wire record:
/// `(list_entry, status, context)`.
async fn session_detail_rpc(
    state: &HttpState,
    id: &str,
) -> Option<(Value, Value, Value)> {
    let list = state
        .rpc(kimi_protocol::methods::SESSION_LIST, json!({ "limit": 500 }))
        .await;
    let list_entry = list["data"]["sessions"]
        .as_array()?
        .iter()
        .find(|s| s["id"] == id)?
        .clone();
    let status = state
        .rpc(kimi_protocol::methods::SESSION_GET_STATUS, json!({ "session_id": id }))
        .await;
    let context = state
        .rpc(kimi_protocol::methods::SESSION_GET_CONTEXT, json!({ "session_id": id }))
        .await;
    if status["code"].as_i64() != Some(0) {
        return None;
    }
    Some((list_entry, status, context))
}

/// `GET /api/v1/sessions` — persisted sessions as v1 `WireSession` records
/// (`{ items, has_more }`), the shape kimi-web's session list expects.
async fn sessions_list_v1(State(state): State<HttpState>) -> Json<Value> {
    let list = state
        .rpc(kimi_protocol::methods::SESSION_LIST, json!({ "limit": 500 }))
        .await;
    if list["code"].as_i64() != Some(0) {
        return Json(list);
    }
    let Some(entries) = list["data"]["sessions"].as_array().cloned() else {
        return Json(ok(v1::wire_page(Vec::new())));
    };
    let mut items = Vec::with_capacity(entries.len());
    for entry in &entries {
        let id = entry["id"].as_str().unwrap_or_default();
        let status = state
            .rpc(kimi_protocol::methods::SESSION_GET_STATUS, json!({ "session_id": id }))
            .await;
        let context = state
            .rpc(kimi_protocol::methods::SESSION_GET_CONTEXT, json!({ "session_id": id }))
            .await;
        let busy = state.v1.is_busy(id);
        items.push(v1::wire_session(entry, &status, &context, busy));
    }
    Json(ok(v1::wire_page(items)))
}

/// `POST /api/v1/sessions` — create a session from the v1 body
/// (`{ metadata: { cwd }, title?, agent_config: { model } }`). The engine
/// `session/create` takes `homedir`/`model`; a missing `metadata.cwd` is an
/// error (kap-server parity) — the browser always sends one.
async fn sessions_create_v1(State(state): State<HttpState>, Json(body): Json<Value>) -> Json<Value> {
    let cwd = body["metadata"]["cwd"].as_str().unwrap_or_default();
    if cwd.is_empty() {
        return Json(err(-32602, "metadata.cwd is required"));
    }
    let path = std::path::Path::new(cwd);
    if !path.is_dir() {
        return Json(err(-40001, &format!("workspace directory not found: {cwd}")));
    }
    let mut params = json!({ "homedir": cwd });
    if let Some(title) = body.get("title").and_then(|v| v.as_str()) {
        params["title"] = json!(title);
    }
    if let Some(model) = body["agent_config"]["model"].as_str() {
        params["model"] = json!(model);
    }
    let created = state.rpc(kimi_protocol::methods::SESSION_CREATE, params).await;
    if created["code"].as_i64() != Some(0) {
        return Json(created);
    }
    let id = created["data"]["session_id"]
        .as_str()
        .or_else(|| created["data"]["id"].as_str())
        .unwrap_or_default();
    if let Some((entry, status, context)) = session_detail_rpc(&state, id).await {
        return Json(ok(v1::wire_session(&entry, &status, &context, false)));
    }
    Json(ok(json!({ "id": id })))
}

/// `GET /api/v1/sessions/{id}` — one session as a v1 `WireSession`.
async fn session_detail_v1(State(state): State<HttpState>, Path(id): Path<String>) -> Json<Value> {
    match session_detail_rpc(&state, &id).await {
        Some((entry, status, context)) => {
            let busy = state.v1.is_busy(&id);
            Json(ok(v1::wire_session(&entry, &status, &context, busy)))
        }
        None => Json(err(-40401, "session not found")),
    }
}

/// `GET /api/v1/sessions/{id}/status` — the v1 runtime-status projection
/// (`WireSessionRuntimeStatus`) the web client reads separately from the
/// session record.
async fn session_runtime_status(State(state): State<HttpState>, Path(id): Path<String>) -> Json<Value> {
    let status = state
        .rpc(kimi_protocol::methods::SESSION_GET_STATUS, json!({ "session_id": id }))
        .await;
    if status["code"].as_i64() != Some(0) {
        return Json(status);
    }
    Json(ok(v1::wire_session_runtime_status(&status)))
}

/// `POST /api/v1/sessions/{id}/prompt` — run one prompt (`{ input }`),
/// blocking until the turn completes (engine RPC direct).
async fn session_prompt(State(state): State<HttpState>, Path(id): Path<String>, Json(body): Json<Value>) -> Json<Value> {
    let input = body.get("input").cloned().unwrap_or(Value::Null);
    Json(state.rpc(kimi_protocol::methods::SESSION_PROMPT, json!({ "session_id": id, "input": input })).await)
}

/// `POST /api/v1/sessions/{id}/prompts` — v1 async prompt submission. Returns
/// immediately with `{ prompt_id, user_message_id }` and runs the turn in the
/// background; progress streams over the WS `event.*` envelopes (the kimi-web
/// chat flow).
async fn session_prompt_async(
    State(state): State<HttpState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Json<Value> {
    let content = body.get("content").cloned().unwrap_or(Value::Null);
    if !content.is_array() {
        return Json(err(-32602, "content must be a WireMessageContent[]"));
    }
    let prompt_text: String = content
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| {
                    if p["type"].as_str() == Some("text") {
                        p["text"].as_str().map(|s| s.to_string())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    let prompt_id = v1::gen_id("prompt_");
    let user_message_id = v1::gen_id("msg_");
    let assistant_msg_id = v1::gen_id("msg_");
    let processor = state.processor.clone();
    let v1 = state.v1.clone();
    let sid = id.clone();
    let session_key = sid.clone();
    v1.begin_turn(
        &sid,
        v1::TurnContext {
            prompt_id: prompt_id.clone(),
            user_message_id: user_message_id.clone(),
            assistant_msg_id,
            prompt_text,
            buffer: String::new(),
        },
    );
    // Run the turn in the background; the engine's events (turn.started /
    // llm.delta / turn.ended) are projected onto the WS v1 event stream by
    // the transport. The WS projector clears the turn bookkeeping on
    // `turn.ended`; when no WS client consumed the stream we clear it here
    // (after a short grace so a subscribed projector wins the context) so the
    // busy flag can never wedge.
    tokio::spawn(async move {
        let request = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: json!(2),
            method: kimi_protocol::methods::SESSION_PROMPT.into(),
            params: json!({ "session_id": sid, "input": content }),
        };
        let response = processor.handle(request).await;
        if response.get("error").is_some() {
            eprintln!("v1 prompt turn failed: {response}");
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let _ = v1.take_turn(&session_key);
    });
    Json(ok(json!({
        "prompt_id": prompt_id,
        "user_message_id": user_message_id,
        "status": "accepted",
    })))
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

/// `GET /api/v1/sessions/{id}/snapshot` — v1 IM-style initial sync: the
/// `WireSession` record + `WireMessage` list + empty pending queues (the
/// kimi-web snapshot contract; missing `pending_*` arrays crash the client).
async fn session_snapshot_v1(State(state): State<HttpState>, Path(id): Path<String>) -> Json<Value> {
    let Some((entry, status, context)) = session_detail_rpc(&state, &id).await else {
        return Json(err(-40401, "session not found"));
    };
    let busy = state.v1.is_busy(&id);
    let session = v1::wire_session(&entry, &status, &context, busy);
    let messages: Vec<Value> = context["data"]["history"]
        .as_array()
        .map(|msgs| {
            msgs.iter()
                .enumerate()
                .map(|(i, m)| v1::wire_message_from_context(m, &id, i))
                .collect()
        })
        .unwrap_or_default();
    let snapshot = json!({
        "as_of_seq": 0,
        "epoch": "engine",
        "session": session,
        "messages": { "items": messages, "has_more": false },
        "in_flight_turn": null,
        "pending_approvals": [],
        "pending_questions": [],
        "subagents": [],
    });
    Json(ok(snapshot))
}

/// `POST /api/v1/sessions/{id}/profile` — update the session's title /
/// metadata / agent config (model, thinking, plan/swarm mode, permission)
/// and return the updated `WireSession` (kimi-web profile route).
async fn session_profile(State(state): State<HttpState>, Path(id): Path<String>, Json(body): Json<Value>) -> Json<Value> {
    if let Some(title) = body.get("title").and_then(|v| v.as_str()) {
        let r = state.rpc(kimi_protocol::methods::SESSION_RENAME, json!({ "session_id": id, "title": title })).await;
        if r["code"].as_i64() != Some(0) {
            return Json(r);
        }
    }
    if let Some(meta) = body.get("metadata").and_then(|m| m.as_object()) {
        let r = state.rpc(kimi_protocol::methods::SESSION_UPDATE_METADATA, json!({ "session_id": id, "metadata": meta })).await;
        if r["code"].as_i64() != Some(0) {
            return Json(r);
        }
    }
    if let Some(ac) = body.get("agent_config") {
        if let Some(model) = ac.get("model").and_then(|v| v.as_str()) {
            let r = state.rpc(kimi_protocol::methods::SESSION_SET_MODEL, json!({ "session_id": id, "model": model })).await;
            if r["code"].as_i64() != Some(0) {
                return Json(r);
            }
        }
        if let Some(thinking) = ac.get("thinking").and_then(|v| v.as_str()) {
            let r = state.rpc(kimi_protocol::methods::SESSION_SET_THINKING, json!({ "session_id": id, "effort": thinking })).await;
            if r["code"].as_i64() != Some(0) {
                return Json(r);
            }
        }
        if let Some(plan) = ac.get("plan_mode").and_then(|v| v.as_bool()) {
            let r = state.rpc(kimi_protocol::methods::SESSION_SET_PLAN_MODE, json!({ "session_id": id, "enabled": plan })).await;
            if r["code"].as_i64() != Some(0) {
                return Json(r);
            }
        }
        if let Some(swarm) = ac.get("swarm_mode").and_then(|v| v.as_bool()) {
            let r = state.rpc(kimi_protocol::methods::SESSION_SET_SWARM_MODE, json!({ "session_id": id, "enabled": swarm, "trigger": "task" })).await;
            if r["code"].as_i64() != Some(0) {
                return Json(r);
            }
        }
        if let Some(mode) = ac.get("permission_mode").and_then(|v| v.as_str()) {
            let r = state.rpc(kimi_protocol::methods::PERMISSION_SET_MODE, json!({ "session_id": id, "mode": mode })).await;
            if r["code"].as_i64() != Some(0) {
                return Json(r);
            }
        }
    }
    // Return the updated session record.
    match session_detail_rpc(&state, &id).await {
        Some((entry, status, context)) => {
            let busy = state.v1.is_busy(&id);
            Json(ok(v1::wire_session(&entry, &status, &context, busy)))
        }
        None => Json(err(-40401, "session not found")),
    }
}

/// `GET /api/v1/sessions/{id}/goal` — the active goal snapshot (camelCase,
/// same shape as the `goal.updated` event), or `null` when none.
async fn session_goal(State(state): State<HttpState>, Path(id): Path<String>) -> Json<Value> {
    let body = state.rpc(kimi_protocol::methods::SESSION_GOAL_GET, json!({ "session_id": id })).await;
    if body["code"].as_i64() != Some(0) {
        return Json(body);
    }
    Json(ok(body["data"]["goal"].clone()))
}

/// `GET /api/v1/sessions/{id}/warnings` — session-level warnings
/// (`{ warnings: [{ code, message, severity }] }`).
async fn session_warnings(State(state): State<HttpState>, Path(id): Path<String>) -> Json<Value> {
    let body = state.rpc(kimi_protocol::methods::SESSION_GET_WARNINGS, json!({ "session_id": id })).await;
    if body["code"].as_i64() != Some(0) {
        return Json(body);
    }
    Json(ok(json!({ "warnings": body["data"]["warnings"] })))
}

/// `GET /api/v1/sessions/{id}/messages` — the session messages as a v1
/// `{ items, has_more }` page of `WireMessage` (from the engine context).
async fn session_messages(State(state): State<HttpState>, Path(id): Path<String>, Query(query): Query<Value>) -> Json<Value> {
    let context = state.rpc(kimi_protocol::methods::SESSION_GET_CONTEXT, json!({ "session_id": id })).await;
    if context["code"].as_i64() != Some(0) {
        return Json(context);
    }
    let page_size = query.get("page_size").and_then(|v| v.as_u64()).unwrap_or(100) as usize;
    let messages: Vec<Value> = context["data"]["history"]
        .as_array()
        .map(|msgs| {
            msgs.iter()
                .enumerate()
                .map(|(i, m)| v1::wire_message_from_context(m, &id, i))
                .collect()
        })
        .unwrap_or_default();
    let page: Vec<Value> = if messages.len() > page_size {
        messages[messages.len() - page_size..].to_vec()
    } else {
        messages
    };
    Json(ok(v1::wire_page(page)))
}

/// `POST /api/v1/sessions/{id}:compact` — request history compaction.
async fn session_compact(State(state): State<HttpState>, Path(id): Path<String>, Json(body): Json<Value>) -> Json<Value> {
    let mut params = json!({ "session_id": id });
    if let Some(instruction) = body.get("instruction").and_then(|v| v.as_str()) {
        params["instruction"] = json!(instruction);
    }
    Json(state.rpc(kimi_protocol::methods::SESSION_COMPACT, params).await)
}

/// `POST /api/v1/sessions/{id}:undo` — remove the last `count` turns.
async fn session_undo(State(state): State<HttpState>, Path(id): Path<String>, Json(body): Json<Value>) -> Json<Value> {
    let count = body.get("count").and_then(|v| v.as_u64()).unwrap_or(1);
    Json(state.rpc(kimi_protocol::methods::SESSION_UNDO_HISTORY, json!({ "session_id": id, "count": count })).await)
}

/// `POST /api/v1/sessions/{id}:restore` — clear the archived flag and return
/// the restored `WireSession`.
async fn session_restore(State(state): State<HttpState>, Path(id): Path<String>) -> Json<Value> {
    let r = state.rpc(
        kimi_protocol::methods::SESSION_UPDATE_METADATA,
        json!({ "session_id": id, "metadata": { "archived": false } }),
    ).await;
    if r["code"].as_i64() != Some(0) {
        return Json(r);
    }
    match session_detail_rpc(&state, &id).await {
        Some((entry, status, context)) => {
            let busy = state.v1.is_busy(&id);
            Json(ok(v1::wire_session(&entry, &status, &context, busy)))
        }
        None => Json(err(-40401, "session not found")),
    }
}

/// `POST /api/v1/sessions/{id}/prompts:steer` — steer queued prompts into the
/// active turn (`{ prompt_ids }` → `{ steered, prompt_ids }`).
async fn session_steer(State(state): State<HttpState>, Path(id): Path<String>, Json(body): Json<Value>) -> Json<Value> {
    let prompt_ids = body.get("prompt_ids").cloned().unwrap_or(json!([]));
    let r = state.rpc(kimi_protocol::methods::SESSION_STEER, json!({ "session_id": id, "prompt_ids": prompt_ids })).await;
    if r["code"].as_i64() != Some(0) {
        return Json(r);
    }
    Json(ok(json!({ "steered": true, "prompt_ids": body.get("prompt_ids").cloned().unwrap_or(json!([])) })))
}

/// `POST /api/v1/sessions/{id}/prompts/{prompt_id}:abort` — cancel the running
/// turn (`{ aborted }`; the prompt id is accepted for wire parity — the
/// engine cancels the active turn).
async fn session_prompt_abort(State(state): State<HttpState>, Path((id, _prompt_id)): Path<(String, String)>) -> Json<Value> {
    let r = state.rpc(kimi_protocol::methods::SESSION_CANCEL, json!({ "session_id": id })).await;
    if r["code"].as_i64() != Some(0) {
        return Json(r);
    }
    Json(ok(json!({ "aborted": true, "at_seq": 0 })))
}

/// `POST /api/v1/sessions/{id}:abort` — cancel whatever is running in the
/// session.
async fn session_abort_session(State(state): State<HttpState>, Path(id): Path<String>) -> Json<Value> {
    let r = state.rpc(kimi_protocol::methods::SESSION_CANCEL, json!({ "session_id": id })).await;
    if r["code"].as_i64() != Some(0) {
        return Json(r);
    }
    Json(ok(json!({ "aborted": true })))
}

/// `GET /api/v1/sessions/{id}/tasks` — background tasks (`{ items }`).
async fn session_tasks(State(state): State<HttpState>, Path(id): Path<String>) -> Json<Value> {
    let r = state.rpc(kimi_protocol::methods::BG_LIST, Value::Null).await;
    if r["code"].as_i64() != Some(0) {
        return Json(r);
    }
    // The engine's bg tasks carry an optional `session_id`; scope to the
    // session when present, else surface everything (TS parity is per-session).
    let items = r["data"].as_array().cloned().unwrap_or_default();
    let scoped: Vec<Value> = items
        .into_iter()
        .filter(|t| {
            t.get("session_id")
                .and_then(|s| s.as_str())
                .map(|s| s == id)
                .unwrap_or(true)
        })
        .collect();
    Json(ok(json!({ "items": scoped })))
}

/// `GET /api/v1/sessions/{id}/tasks/{task_id}` — one background task.
async fn session_task(State(state): State<HttpState>, Path((id, task_id)): Path<(String, String)>) -> Json<Value> {
    let r = state.rpc(kimi_protocol::methods::BG_GET, json!({ "task_id": task_id })).await;
    if r["code"].as_i64() != Some(0) {
        return Json(r);
    }
    if r["data"].is_null() {
        return Json(err(-40406, "task not found"));
    }
    Json(ok(r["data"].clone()))
}

/// `POST /api/v1/sessions/{id}/tasks/{task_id}:cancel` — stop a task.
async fn session_task_cancel(State(state): State<HttpState>, Path((_id, task_id)): Path<(String, String)>) -> Json<Value> {
    let r = state.rpc(kimi_protocol::methods::BG_STOP, json!({ "task_id": task_id })).await;
    if r["code"].as_i64() != Some(0) {
        return Json(r);
    }
    Json(ok(json!({ "cancelled": true })))
}

/// `POST /api/v1/sessions/{id}/skills/{skill_name}:activate` — activate a
/// skill (`{ args? }` → `{ activated, skill_name }`).
async fn session_skill_activate(State(state): State<HttpState>, Path((id, skill_name)): Path<(String, String)>, Json(body): Json<Value>) -> Json<Value> {
    let args = body.get("args").cloned().unwrap_or(json!({}));
    let r = state.rpc(
        kimi_protocol::methods::SESSION_ACTIVATE_SKILL,
        json!({ "session_id": id, "name": skill_name, "args": args }),
    ).await;
    if r["code"].as_i64() != Some(0) {
        return Json(r);
    }
    Json(ok(json!({ "activated": true, "skill_name": skill_name })))
}

/// `POST /api/v1/sessions/{id}/approvals/{approval_id}` — resolve a pending
/// approval (no `/resolve` suffix; the v1 body uses `approved|rejected`
/// decisions, mapped onto the engine's `allow|deny`).
async fn session_approval_resolve_v1(
    State(state): State<HttpState>,
    Path((_id, approval_id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Json<Value> {
    let mut params = json!({ "id": approval_id });
    if let Some(decision) = body.get("decision").and_then(|v| v.as_str()) {
        let engine_decision = match decision {
            "approved" => "allow",
            "rejected" => "deny",
            other => other,
        };
        params["decision"] = json!(engine_decision);
    }
    if let Some(reason) = body.get("feedback").and_then(|v| v.as_str()) {
        params["reason"] = json!(reason);
    }
    let r = state.rpc(kimi_protocol::methods::SESSION_APPROVAL_RESOLVE, params).await;
    if r["code"].as_i64() != Some(0) {
        return Json(r);
    }
    Json(ok(json!({ "resolved": true, "resolved_at": v1::iso_now() })))
}

/// `POST /api/v1/oauth/logout` — sign out of the kimi OAuth provider
/// (`{ logged_out }`; removes `providers.kimi` from the engine config).
async fn oauth_logout(State(state): State<HttpState>) -> Json<Value> {
    let r = state.rpc(
        kimi_protocol::methods::CONFIG_SET,
        json!({ "patch": { "providers": { "kimi": null } } }),
    ).await;
    if r["code"].as_i64() != Some(0) {
        return Json(r);
    }
    Json(ok(json!({ "logged_out": true })))
}

/// `POST /api/v1/sessions/{id}/fs:grep` — search session workspace files
/// (`{ pattern, regex?, case_sensitive? }` → grep result).
async fn fs_action_grep(State(state): State<HttpState>, Path(id): Path<String>, Json(body): Json<Value>) -> Json<Value> {
    let mut params = json!({ "session_id": id, "action": "grep" });
    if let Some(h) = session_workdir(&state, &id).await {
        params["homedir"] = json!(h);
        params["path"] = json!(h);
    }
    if let Some(pattern) = body.get("pattern").and_then(|v| v.as_str()) {
        params["query"] = json!(pattern);
    }
    if let Some(regex) = body.get("regex").and_then(|v| v.as_bool()) {
        params["regex"] = json!(regex);
    }
    if let Some(cs) = body.get("case_sensitive").and_then(|v| v.as_bool()) {
        params["case_sensitive"] = json!(cs);
    }
    Json(state.rpc(kimi_protocol::methods::SESSION_FS, params).await)
}

/// `POST /api/v1/sessions/{id}/fs:git_status` — git status of the session
/// workspace (`{ paths? }` → `{ branch, ahead, behind, entries, … }`).
async fn fs_git_status(State(state): State<HttpState>, Path(id): Path<String>, Json(_body): Json<Value>) -> Json<Value> {
    let Some(cwd) = session_workdir(&state, &id).await else {
        return Json(err(-40401, "session not found"));
    };
    Json(state.rpc(kimi_protocol::methods::GIT_STATUS, json!({ "cwd": cwd })).await)
}

/// `POST /api/v1/sessions/{id}/fs:diff` — git diff of one workspace file
/// (`{ path }` → `{ path, diff }`).
async fn fs_git_diff(State(state): State<HttpState>, Path(id): Path<String>, Json(body): Json<Value>) -> Json<Value> {
    let Some(cwd) = session_workdir(&state, &id).await else {
        return Json(err(-40401, "session not found"));
    };
    let path = body.get("path").and_then(|v| v.as_str()).unwrap_or_default();
    if path.is_empty() {
        return Json(err(-32602, "fs:diff requires a path"));
    }
    Json(state.rpc(kimi_protocol::methods::GIT_DIFF, json!({ "cwd": cwd, "path": path })).await)
}

/// `GET /api/v1/sessions/{id}/transcript` — turn-granular transcript rebuilt
/// from the engine context messages (kap-server transcript projection).
async fn session_transcript(State(state): State<HttpState>, Path(id): Path<String>) -> Json<Value> {
    let context = state.rpc(kimi_protocol::methods::SESSION_GET_CONTEXT, json!({ "session_id": id })).await;
    if context["code"].as_i64() != Some(0) {
        return Json(context);
    }
    let messages = context["data"].get("history").and_then(|m| m.as_array()).cloned().unwrap_or_default();
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

/// `GET /api/v1/ws` — upgrade to the WebSocket v1 facade: `server_hello` /
/// `client_hello` / `subscribe` / `ack` control frames plus `event.*` event
/// envelopes projected from the engine stream (the kimi-web wire). Auth: the
/// client offers the `kimi-code.bearer.<credential>` subprotocol (kap-server
/// parity).
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
            .on_upgrade(move |socket| v1::serve_v1_ws(socket, state.events.clone(), state.v1.clone()));
    }
    let events = state.events.clone();
    let shared = state.v1.clone();
    ws.on_upgrade(move |socket| v1::serve_v1_ws(socket, events, shared))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kimi_server::processor::Processor;
    use kimi_server::request_processors::HealthProcessor;

    /// `{x}:{action}` path segments are rewritten to `{x}/{action}` so the
    /// frontend's colon-suffixed routes hit the slash-form handlers.
    #[test]
    fn colon_actions_rewrite_to_slash() {
        let cases = [
            (
                "/api/v1/sessions/sess-1:compact",
                "/api/v1/sessions/sess-1/compact",
            ),
            (
                "/api/v1/sessions/sess-1/prompts:steer",
                "/api/v1/sessions/sess-1/prompts/steer",
            ),
            (
                "/api/v1/sessions/sess-1/tasks/t-1:cancel",
                "/api/v1/sessions/sess-1/tasks/t-1/cancel",
            ),
            (
                "/api/v1/sessions/sess-1/skills/skill-x:activate",
                "/api/v1/sessions/sess-1/skills/skill-x/activate",
            ),
            // Plain routes are untouched.
            ("/api/v1/sessions/sess-1/fs:grep", "/api/v1/sessions/sess-1/fs:grep"),
            ("/api/v1/sessions/sess-1/prompt", "/api/v1/sessions/sess-1/prompt"),
        ];
        for (input, expected) in cases {
            let uri = axum::http::Uri::try_from(input).expect("uri");
            let rewritten = rewrite_path(&uri);
            assert_eq!(rewritten, *expected, "rewrite {input}");
        }
    }

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
