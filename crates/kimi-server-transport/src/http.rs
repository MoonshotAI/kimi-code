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

/// Host-header allowlist (DNS-rebinding defence, kap-server `hostnames.ts`
/// parity). Default-allow set: `localhost` / `*.localhost`, loopback IPs, any
/// literal IP, the bound host, and caller-supplied extras (a leading `.`
/// matches the bare domain and any subdomain).
#[derive(Clone, Debug, Default)]
pub struct HostCheckConfig {
    /// The host the server bound to; always allowed (port stripped both sides).
    pub bound_host: Option<String>,
    /// Extra allowed hosts / domain-suffix patterns (from `--allowed-host` /
    /// `KIMI_CODE_ALLOWED_HOSTS`).
    pub extra: Vec<String>,
    /// Disable the check entirely (`KIMI_CODE_DISABLE_HOST_CHECK=1`; test-only).
    pub disable: bool,
}

/// Strip a trailing `:port` from a `Host` value and lowercase it. Handles
/// bracketed IPv6 with a port (`[::1]:80` → `[::1]`), host/IPv4 with a port
/// (`localhost:80` → `localhost`), and bare IPv6 without brackets (multiple
/// colons — no unambiguous port to strip).
fn strip_port(host: &str) -> String {
    if host.starts_with('[') {
        return match host.find(']') {
            Some(end) => host[..=end].to_ascii_lowercase(),
            None => host.to_ascii_lowercase(),
        };
    }
    let first_colon = host.find(':');
    if first_colon.is_none() {
        return host.to_ascii_lowercase();
    }
    let last_colon = host.rfind(':');
    if first_colon == last_colon {
        let after = &host[last_colon.unwrap() + 1..];
        if !after.is_empty() && after.chars().all(|c| c.is_ascii_digit()) {
            return host[..last_colon.unwrap()].to_ascii_lowercase();
        }
    }
    // Multiple colons (bare IPv6) or a non-digit suffix — no port to strip.
    host.to_ascii_lowercase()
}

/// True when `host` parses as a literal IP address.
fn is_literal_ip(host: &str) -> bool {
    host.parse::<std::net::IpAddr>().is_ok()
}

/// Decide whether a `Host` value is allowed under the given options
/// (kap-server `isAllowedHost` parity). Missing/empty `Host` is rejected
/// (HTTP/1.1 requires it); the check is a no-op when `disable` is set.
pub fn is_allowed_host(host: Option<&str>, opts: &HostCheckConfig) -> bool {
    if opts.disable {
        return true;
    }
    let Some(host) = host else {
        return false;
    };
    if host.is_empty() {
        return false;
    }
    let h = strip_port(host);
    if h == "localhost" || h == "127.0.0.1" || h == "::1" || h == "[::1]" {
        return true;
    }
    if h.ends_with(".localhost") {
        return true;
    }
    if is_literal_ip(&h) {
        return true;
    }
    if let Some(bound) = &opts.bound_host {
        if h == strip_port(bound) {
            return true;
        }
    }
    for entry in &opts.extra {
        if let Some(base) = entry.strip_prefix('.') {
            if h == base || h.ends_with(entry) {
                return true;
            }
        } else if h == *entry {
            return true;
        }
    }
    false
}

/// True when the bound host is a loopback address (drives the shutdown-route
/// gate and the non-loopback TLS refusal, kap-server `classify` parity).
pub fn is_loopback_host(host: &str) -> bool {
    let h = strip_port(host);
    h == "localhost" || h == "127.0.0.1" || h == "::1" || h == "[::1]"
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
    /// Host-header allowlist (DNS-rebinding defence).
    host_check: HostCheckConfig,
    /// When false (non-loopback bind without `--allow-remote-shutdown`), the
    /// `/api/v1/shutdown` route answers a refusal instead of firing.
    allow_remote_shutdown: bool,
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
            host_check: HostCheckConfig::default(),
            allow_remote_shutdown: true,
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
            host_check: HostCheckConfig::default(),
            allow_remote_shutdown: true,
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

    /// Attach the host-header allowlist (DNS-rebinding defence).
    pub fn with_host_check(mut self, check: HostCheckConfig) -> Self {
        self.host_check = check;
        self
    }

    /// Gate `/api/v1/shutdown`: when `false` (non-loopback bind without
    /// `--allow-remote-shutdown`), the route answers a refusal.
    pub fn with_allow_remote_shutdown(mut self, allow: bool) -> Self {
        self.allow_remote_shutdown = allow;
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
    let host_middleware = axum::middleware::from_fn_with_state(state.clone(), require_allowed_host);
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
        // Deliberately unsupported surfaces — the routes exist so web hosts
        // get a clear error envelope instead of a bare 404. Terminals: the
        // engine has no WS terminal surface. Questions: engine question
        // requests surface as tool content, answered by the next prompt.
        .route(
            "/api/v1/sessions/{id}/terminals",
            get(terminals_unsupported).post(terminals_unsupported),
        )
        .route(
            "/api/v1/sessions/{id}/terminals/{terminal_id}",
            get(terminals_unsupported).post(terminals_unsupported),
        )
        .route("/api/v1/sessions/{id}/terminals/{terminal_id}/close", post(terminals_unsupported))
        .route("/api/v1/sessions/{id}/questions/{question_id}", post(questions_unsupported))
        .route(
            "/api/v1/sessions/{id}/questions/{question_id}/dismiss",
            post(questions_unsupported),
        )
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
        .route("/api/v1/sessions/{id}/fs:open", post(fs_action_open))
        .route("/api/v1/sessions/{id}/fs:reveal", post(fs_action_reveal))
        .route("/api/v1/sessions/{id}/fs:open-in", post(fs_action_open_in))
        // File download: the frontend GETs `/fs/{path}:download`; the colon
        // rewrite turns the `:download` suffix into a `/download` segment.
        .route("/api/v1/sessions/{id}/fs/{*rest}", get(fs_download))
        .route("/api/v1/fs:browse", get(fs_browse))
        .route("/api/v1/fs:home", get(fs_home))
        .route("/api/v1/workspaces", get(workspaces_list))
        .route("/api/v1/workspaces/{id}", get(workspace_get))
        // Subdirectories of a workspace root (`{ items, truncated }`, the
        // fs:list entry shape — the folder-picker surface).
        .route("/api/v1/workspaces/{id}/children", get(workspace_children))
        .route("/api/v1/auth", get(auth_status))
        .route("/api/v1/models", get(models_list))
        .route("/api/v1/providers", get(providers_list).post(provider_create))
        .route("/api/v1/providers/{id}", put(provider_replace).delete(provider_delete))
        // Provider refresh — no-op (the engine manages models from config;
        // nothing auto-discovers). `/providers:refresh` and
        // `/providers/{id}:refresh` arrive slash-form after the colon rewrite;
        // `providers:refresh_oauth` stays a literal colon route.
        .route("/api/v1/providers/refresh", post(providers_refresh_all))
        .route("/api/v1/providers/{id}/refresh", post(providers_refresh_one))
        .route("/api/v1/providers:refresh_oauth", post(providers_refresh_oauth))
        .route("/api/v1/ws", get(ws_upgrade))
        // axum layers are LIFO: the last-added runs first. The host check
        // must run before auth (kap-server hook order parity) so a rebinding
        // attacker is rejected even before the credential gate.
        .layer(middleware)
        .layer(host_middleware)
        .with_state(state)
}

/// Rewrite `{x}:{action}` path segments into `{x}/{action}` so the
/// frontend's colon-suffixed routes (`/sessions/{id}:compact`,
/// `/tasks/{task_id}:cancel`, `/skills/{name}:activate`, `/providers/{id}:refresh`,
/// `/fs/{path}:download`, …) hit the slash-form routes — axum cannot express
/// a path parameter followed by a literal in one segment. Only known action
/// suffixes are rewritten; the literal colon routes (`fs:grep`, `fs:git_status`,
/// `fs:diff`, `fs:home`, `fs:list`, `fs:read`, `fs:search`, `fs:open`,
/// `fs:reveal`, `fs:open-in`, `providers:refresh_oauth`) stay untouched.
/// Returns the rewritten path (unchanged when nothing matches).
fn rewrite_path(uri: &axum::http::Uri) -> String {
    /// Colon-suffixed actions the frontend sends (rewritten to slash form).
    const COLON_ACTIONS: &[&str] = &[
        "compact", "undo", "restore", "abort", "steer", "activate", "cancel", "download",
        "refresh", "close", "dismiss",
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
/// `GET /api/v1/healthz` is bypassed (liveness probe for supervisors / load
/// balancers, kap-server `defaultIsBypassed` parity).
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
        let is_healthz =
            req.method() == axum::http::Method::GET && req.uri().path() == "/api/v1/healthz";
        if !is_healthz {
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
    }
    next.run(req).await
}

/// Host-header allowlist guard (DNS-rebinding defence, kap-server
/// `createHostCheck` parity): rejects requests whose `Host` header is not in
/// the allowlist with a `403 Invalid Host header` envelope. WebSocket-upgrade
/// requests are checked too (the WS facade is equally reachable by a rebinding
/// attacker).
async fn require_allowed_host(
    State(state): State<HttpState>,
    req: axum::http::Request<axum::body::Body>,
    next: axum::middleware::Next,
) -> Response {
    let host = req
        .headers()
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok());
    if !is_allowed_host(host, &state.host_check) {
        let label = host.map(|h| strip_port(h)).unwrap_or_else(|| "<missing>".to_string());
        return Json(err(
            40301,
            &format!(
                "Invalid Host header: {label}; allow this host with KIMI_CODE_ALLOWED_HOSTS={label} or 'kimi web --allowed-host {label}'."
            ),
        ))
        .into_response();
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
/// `host_check` / `allow_remote_shutdown` mirror the kap-server startup
/// options (`--allowed-host` / `--allow-remote-shutdown`); the shutdown route
/// is armed so `POST /api/v1/shutdown` stops the server gracefully.
pub async fn serve_web(
    processor: Arc<MessageProcessor>,
    events: tokio::sync::broadcast::Sender<serde_json::Value>,
    assets_dir: &str,
    listener: tokio::net::TcpListener,
    host_check: HostCheckConfig,
    allow_remote_shutdown: bool,
) -> anyhow::Result<()> {
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let state = HttpState::with_events(processor, events)
        .with_host_check(host_check)
        .with_allow_remote_shutdown(allow_remote_shutdown)
        .with_shutdown(Arc::new(tokio::sync::Mutex::new(Some(shutdown_tx))));
    axum::serve(listener, colon_make_service(router_with_assets(state, assets_dir)))
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        })
        .await?;
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
            // The engine has no WS terminal surface — the terminal routes
            // answer a clear error envelope (see `terminals_unsupported`).
            "terminal": false
        },
        "server_id": state.server_id,
        "started_at": state.started_at,
        "open_in_apps": [],
        "dangerous_bypass_auth": state.auth.token.is_none(),
        "backend": "v2"
    })))
}

/// `POST /api/v1/shutdown` — fire the graceful-shutdown channel (reply first
/// so the caller gets a clean 200 instead of a dropped connection). On a
/// non-loopback bind without `--allow-remote-shutdown` the route answers a
/// refusal instead (kap-server parity: remote shutdown is opt-in).
async fn shutdown(State(state): State<HttpState>) -> Json<Value> {
    if !state.allow_remote_shutdown {
        return Json(err(
            40302,
            "remote shutdown is disabled on this bind; restart with --allow-remote-shutdown to enable it",
        ));
    }
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

/// `GET /api/v1/config` — the engine's parsed config projected onto the v1
/// `WireConfig` wire shape: camelCase engine keys → snake_case, provider
/// credentials redacted to `has_api_key` (mirrors kap-server
/// `toConfigResponse`).
async fn config_get(State(state): State<HttpState>) -> Json<Value> {
    let envelope = state.rpc(kimi_protocol::methods::CONFIG_GET, Value::Null).await;
    if envelope["code"].as_i64() != Some(0) {
        return Json(envelope);
    }
    let config = envelope["data"].as_object().cloned().unwrap_or_default();
    Json(ok(wire_config(&config)))
}

/// Project the engine's camelCase `KimiConfig` JSON into the v1 `WireConfig`
/// shape. Top-level keys map camelCase→snake_case generically; the only
/// domain-specific transforms are `providers` (credentials → `has_api_key`)
/// and the `default_permission_mode` / `yolo` echo derived from the nested
/// `[agent.permission] mode`. Pure projection: no engine calls.
fn wire_config(config: &serde_json::Map<String, Value>) -> Value {
    let mut wire = serde_json::Map::new();
    for (key, value) in config {
        if key == "providers" {
            wire.insert("providers".into(), wire_providers(value));
        } else {
            // Non-provider subtrees pass the engine's raw (deliberately
            // unredacted) `config/get` envelope through — e.g.
            // `services.moonshot.api_key`, `model_catalog.api_key` and
            // `mcp.servers.*.env` — so credentials are stripped recursively
            // here (providers are already projected to `has_api_key`).
            wire.insert(camel_to_snake(key), redact_secrets(value.clone()));
        }
    }
    // v1 wire echo: surface the effective permission mode as
    // `default_permission_mode` + derived `yolo`. The engine stores it as
    // `[agent.permission] mode`; a legacy top-level `defaultPermissionMode`
    // (if the engine ever reports one) wins over the nested read.
    let mode = config
        .get("defaultPermissionMode")
        .or_else(|| {
            config
                .get("agent")
                .and_then(|a| a.get("permission"))
                .and_then(|p| p.get("mode"))
        })
        .and_then(Value::as_str);
    if let Some(mode) = mode {
        wire.insert("default_permission_mode".into(), json!(mode));
        wire.insert("yolo".into(), json!(mode == "yolo"));
    }
    // `providers` is required by `WireConfig` even when none is configured.
    wire.entry("providers".to_string()).or_insert(json!({}));
    Value::Object(wire)
}

/// `camelCase` → `snake_case` for a wire key (kap-server `camelToSnake`).
fn camel_to_snake(key: &str) -> String {
    let mut out = String::with_capacity(key.len() + 4);
    for ch in key.chars() {
        if ch.is_ascii_uppercase() {
            out.push('_');
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

/// `snake_case` → `camelCase` (kap-server `snakeToCamel`): the wire config
/// patch uses snake_case keys while the engine `config/set` patch is camelCase
/// `KimiConfig`.
fn snake_to_camel(key: &str) -> String {
    let mut out = String::with_capacity(key.len());
    let mut upper = false;
    for ch in key.chars() {
        if ch == '_' {
            upper = true;
        } else if upper && ch.is_ascii_lowercase() {
            out.push(ch.to_ascii_uppercase());
            upper = false;
        } else {
            out.push(ch);
            upper = false;
        }
    }
    out
}

/// Recursively convert wire keys snake_case → camelCase (kap-server
/// `convertKeysSnakeToCamel`), so a flat wire patch becomes an engine-shaped
/// `KimiConfig` patch.
fn wire_keys_to_camel(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, v)| (snake_to_camel(&key), wire_keys_to_camel(v)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(wire_keys_to_camel).collect()),
        other => other,
    }
}

/// Project the engine's `providers` map (`{ id: { type, apiKey, baseUrl,
/// defaultModel, oauth, env, … } }`) into `WireConfigProvider` records:
/// `apiKey` is never emitted — `has_api_key` reflects apiKey / oauth / env
/// presence (mirrors kap-server `toProviderResponses`).
fn wire_providers(value: &Value) -> Value {
    let Some(providers) = value.as_object() else {
        return json!({});
    };
    let mut out = serde_json::Map::new();
    for (id, raw) in providers {
        let Some(provider) = raw.as_object() else {
            continue;
        };
        let mut rec = serde_json::Map::new();
        rec.insert(
            "type".into(),
            json!(provider.get("type").and_then(Value::as_str).unwrap_or("")),
        );
        if let Some(base_url) = provider
            .get("baseUrl")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            rec.insert("base_url".into(), json!(base_url));
        }
        if let Some(default_model) = provider
            .get("defaultModel")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            rec.insert("default_model".into(), json!(default_model));
        }
        rec.insert(
            "has_api_key".into(),
            json!(
                provider
                    .get("apiKey")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.trim().is_empty())
                    || provider.contains_key("oauth")
                    || provider.contains_key("env")
            ),
        );
        out.insert(id.clone(), Value::Object(rec));
    }
    Value::Object(out)
}

/// Whether a config key carries a credential: the engine's secret spellings
/// (`apiKey` / `api_key` / `token` / `secret`) plus arbitrary env-style keys
/// (`MY_API_KEY`, `CLIENT_SECRET`, …) found in nested maps. Presence flags
/// like `has_api_key` never reach this pass — providers are projected before
/// `redact_secrets` runs, and `max_tokens`/`total_tokens` (plural) are not
/// credentials.
fn is_secret_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    lower == "apikey"
        || lower == "api_key"
        || lower == "token"
        || lower == "secret"
        || lower.ends_with("_key")
        || lower.ends_with("_token")
        || lower.ends_with("_secret")
        || lower.ends_with("_apikey")
}

/// Recursively drop credential-carrying keys from a config subtree, keeping
/// everything else byte-identical (arrays are walked so `env`-style maps in
/// any position are covered).
fn redact_secrets(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter(|(key, _)| !is_secret_key(key))
                .map(|(key, value)| (key, redact_secrets(value)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(redact_secrets).collect()),
        other => other,
    }
}

/// `POST /api/v1/config` — apply a config patch. The body is the flat wire
/// patch (`{ default_model, providers, … }` — kimi-web `setConfig` sends the
/// keys directly; kap-server parity, not an engine `{ patch }` wrapper). Wire
/// keys are converted snake_case→camelCase before the engine call (kap-server
/// `convertKeysSnakeToCamel`), with the v1 sugar folded: `yolo: true` is an
/// alias for `defaultPermissionMode: "yolo"` (never persisted) and
/// `default_permission_mode` maps onto the engine's nested `[agent.permission]
/// mode`. The engine's `config/set` result is only a write receipt
/// (`{ ok, path }`), so on success the config is re-read and projected onto
/// the v1 `WireConfig` shape (kap-server parity); error envelopes pass
/// through unchanged.
async fn config_set(State(state): State<HttpState>, Json(body): Json<Value>) -> Json<Value> {
    // A non-object body is an empty patch (kap-server zod validation rejects
    // it; an empty merge is a harmless no-op, while a non-config value would
    // be dropped by the engine's config deserializer and could wipe defaults).
    let mut patch = if body.is_object() { wire_keys_to_camel(body) } else { json!({}) };
    if let Some(obj) = patch.as_object_mut() {
        // `yolo: true` → `defaultPermissionMode = "yolo"`; the alias is never
        // persisted (kap-server parity).
        if obj.get("yolo").and_then(Value::as_bool) == Some(true) {
            obj.insert("defaultPermissionMode".into(), json!("yolo"));
        }
        obj.remove("yolo");
        // `default_permission_mode` → `[agent.permission] mode` (the engine
        // owns config.toml and has no top-level permission key).
        if let Some(mode) = obj.remove("defaultPermissionMode") {
            obj.entry("agent")
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .expect("agent is object")
                .entry("permission")
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .expect("permission is object")
                .insert("mode".into(), mode);
        }
    }
    // An empty patch (non-object body, `{}`, or only non-persisting sugar
    // like `yolo: false`) would still trigger the engine's full config
    // reload + rewrite: CONFIG_SET merges `load_config_with_env` — applying
    // `KIMI_PROVIDER_*` overrides — and persists the merged result, baking
    // env-carried secrets into config.toml. Short-circuit to the plain
    // re-read: same wire result, no write.
    let get = if patch.as_object().is_some_and(|m| m.is_empty()) {
        state.rpc(kimi_protocol::methods::CONFIG_GET, Value::Null).await
    } else {
        let set = state
            .rpc(kimi_protocol::methods::CONFIG_SET, json!({ "patch": patch }))
            .await;
        if set["code"].as_i64() != Some(0) {
            return Json(set);
        }
        state.rpc(kimi_protocol::methods::CONFIG_GET, Value::Null).await
    };
    if get["code"].as_i64() != Some(0) {
        return Json(get);
    }
    let config = get["data"].as_object().cloned().unwrap_or_default();
    Json(ok(wire_config(&config)))
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
        // Grace period before clearing the shared turn context. WS projectors
        // snapshot it at `turn.started`; a slow/backlogged projector may only
        // reach that event after the RPC returned, so the fallback must stay
        // well past the last plausible turn.started processing (100ms was too
        // tight — a lagging connection dropped the whole turn projection and
        // left its messages stuck in `pending`). The projector path never
        // deletes the context itself (per-connection consumers race), so this
        // window is the only bound on the busy flag for REST-only clients.
        tokio::time::sleep(std::time::Duration::from_millis(2_000)).await;
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

/// `GET /api/v1/sessions/{id}/tasks` — background tasks as v1 `WireTask`
/// records (`{ items, has_more }`), projected from the engine's `task/list`
/// (kap-server parity: kind/status literal remap, epoch-ms → ISO timestamps,
/// `session_id` filled from the route). The engine roster is process-wide; no
/// session scoping exists in the engine, so every task is listed.
async fn session_tasks(State(state): State<HttpState>, Path(id): Path<String>) -> Json<Value> {
    let r = state.rpc(kimi_protocol::methods::TASK_LIST, Value::Null).await;
    if r["code"].as_i64() != Some(0) {
        return Json(r);
    }
    let items: Vec<Value> = r["data"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|t| wire_task(&id, t))
        .collect();
    Json(ok(json!({ "items": items, "has_more": false })))
}

/// Project one engine `task/list` record (flat `TaskInfoBase`: `task_id`,
/// `kind` `process|agent|question`, `status`, epoch-ms `started_at` /
/// `ended_at`) onto the v1 `WireTask` shape (mirrors kap-server
/// `TASK_KIND_REMAP` / `TASK_STATUS_REMAP`).
fn wire_task(session_id: &str, t: &Value) -> Value {
    let kind = match t["kind"].as_str() {
        Some("process") => "bash",
        Some("agent") => "subagent",
        // `question` (and any unknown kind) falls back to `tool`.
        _ => "tool",
    };
    let status = match t["status"].as_str() {
        Some("running") => "running",
        Some("completed") => "completed",
        Some("failed") | Some("timed_out") | Some("lost") => "failed",
        Some("killed") => "cancelled",
        _ => "failed",
    };
    let started_at = iso_from_millis(t["started_at"].as_u64().unwrap_or(0));
    let mut item = json!({
        "id": t["task_id"],
        "session_id": session_id,
        "kind": kind,
        "description": t["description"],
        "status": status,
        "created_at": started_at,
        "started_at": started_at,
    });
    if let Some(ended_at) = t["ended_at"].as_u64() {
        item["completed_at"] = json!(iso_from_millis(ended_at));
    }
    item
}

/// `GET /api/v1/sessions/{id}/tasks/{task_id}` — one background task as a
/// `WireTask` record (same `task/list` roster + projection as the list route).
async fn session_task(State(state): State<HttpState>, Path((id, task_id)): Path<(String, String)>) -> Json<Value> {
    let r = state.rpc(kimi_protocol::methods::TASK_LIST, Value::Null).await;
    if r["code"].as_i64() != Some(0) {
        return Json(r);
    }
    let task = r["data"]
        .as_array()
        .and_then(|items| items.iter().find(|t| t["task_id"] == task_id));
    let Some(task) = task else {
        return Json(err(-40406, "task not found"));
    };
    Json(ok(wire_task(&id, task)))
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
/// workspace (`{ paths? }` → `{ branch, ahead, behind, entries, additions,
/// deletions, pullRequest }`). Non-repo workspaces come back as an error
/// envelope — the engine's bare `{ unavailable }` would crash the web
/// client's `Object.entries(entries)`.
async fn fs_git_status(State(state): State<HttpState>, Path(id): Path<String>, Json(_body): Json<Value>) -> Json<Value> {
    let Some(cwd) = session_workdir(&state, &id).await else {
        return Json(err(-40401, "session not found"));
    };
    let r = state.rpc(kimi_protocol::methods::GIT_STATUS, json!({ "cwd": cwd })).await;
    if r["code"].as_i64() != Some(0) {
        return Json(r);
    }
    let data = &r["data"];
    if let Some(reason) = data.get("unavailable").and_then(|v| v.as_str()) {
        return Json(err(-32603, &format!("git status unavailable: {reason}")));
    }
    let out = json!({
        "branch": data["branch"],
        "ahead": data["ahead"],
        "behind": data["behind"],
        "entries": data["entries"],
        "additions": data["additions"],
        "deletions": data["deletions"],
        // The web wire spells it camelCase (`pullRequest`); the engine's
        // `GitStatusResponse` field is `pull_request`.
        "pullRequest": data["pull_request"],
    });
    Json(ok(out))
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

/// Project the engine's `UsageStatus` JSON onto the v1 `WireSessionUsage`
/// shape. The engine reports `{ by_model?, total?: { input_tokens,
/// output_tokens, total_tokens }, current_turn? }` (kimi-protocol
/// `UsageStatus` / `TokenUsage`) — the aggregate lives under `total`, absent
/// before any turn produced usage. The wire shape only carries the
/// aggregate; cache/context/cost/turn counts have no engine counterpart and
/// are pinned to zero.
fn wire_usage(usage: &Value) -> Value {
    let total = usage.get("total").and_then(Value::as_object);
    let read = |key: &str| total.and_then(|t| t.get(key)).and_then(Value::as_u64).unwrap_or(0);
    json!({
        "input_tokens": read("input_tokens"),
        "output_tokens": read("output_tokens"),
        "cache_read_tokens": 0,
        "cache_creation_tokens": 0,
        "total_cost_usd": 0.0,
        "context_tokens": 0,
        "context_limit": 0,
        "turn_count": 0,
    })
}

/// `GET /api/v1/sessions/{id}/usage` — token usage snapshot.
async fn session_usage(State(state): State<HttpState>, Path(id): Path<String>) -> Json<Value> {
    let mut resp = state
        .rpc(kimi_protocol::methods::SESSION_GET_USAGE, json!({ "session_id": id }))
        .await;
    // The engine reports an empty structure before any turn produced usage;
    // project it onto the v1 zero-valued `WireSessionUsage` shape so the
    // frontend's field reads never see `undefined` (wire.ts parity).
    if resp["code"].as_i64() == Some(0) {
        let usage = resp.get_mut("data").cloned().unwrap_or_else(|| json!({}));
        resp["data"] = wire_usage(&usage);
    }
    Json(resp)
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

/// `POST /api/v1/sessions/{id}/fs:list` — list a workspace directory as
/// `{ items: WireFsEntry[], truncated }` (the kimi-web file tree). The
/// engine's Glob emits only files as plain text — no directories, sizes or
/// mtimes — so the projection lists the directory directly under the session
/// workspace root (same containment rules as the engine sandbox).
async fn fs_action_list(State(state): State<HttpState>, Path(id): Path<String>, Json(body): Json<Value>) -> Json<Value> {
    let Some(workdir) = session_workdir(&state, &id).await else {
        return Json(err(-40401, "session not found"));
    };
    let requested = body.get("path").and_then(|v| v.as_str()).unwrap_or(".");
    let Some((root_canon, dir)) = fs_resolve_workspace(std::path::Path::new(&workdir), requested) else {
        return Json(err(-32603, &format!("fs:list: {requested} is outside the session workspace or does not exist")));
    };
    let items = match fs_entries(&root_canon, &dir, false) {
        Ok(items) => items,
        Err(error) => {
            return Json(err(-32603, &format!("fs:list: failed to read {requested}: {error}")))
        }
    };
    Json(ok(json!({ "items": items, "truncated": false })))
}

/// `POST /api/v1/sessions/{id}/fs:read` — read a file as `{ path, content,
/// encoding, size, truncated, etag, mime, is_binary, line_count }` (the
/// kimi-web file viewer). The engine Read tool emits line-numbered text and
/// refuses binaries, so the projection reads the file directly under the
/// session workspace root.
async fn fs_action_read(State(state): State<HttpState>, Path(id): Path<String>, Json(body): Json<Value>) -> Json<Value> {
    let Some(workdir) = session_workdir(&state, &id).await else {
        return Json(err(-40401, "session not found"));
    };
    let requested = body.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if requested.is_empty() {
        return Json(err(-32602, "fs:read requires a path"));
    }
    let Some((_, resolved)) = fs_resolve_workspace(std::path::Path::new(&workdir), requested) else {
        return Json(err(-32603, &format!("fs:read: {requested} is outside the session workspace or does not exist")));
    };
    let meta = match std::fs::metadata(&resolved) {
        Ok(meta) => meta,
        Err(error) => return Json(err(-32603, &format!("fs:read: failed to stat {requested}: {error}"))),
    };
    if !meta.is_file() {
        return Json(err(-32603, &format!("fs:read: {requested} is not a file")));
    }
    let bytes = match std::fs::read(&resolved) {
        Ok(bytes) => bytes,
        Err(error) => return Json(err(-32603, &format!("fs:read: failed to read {requested}: {error}"))),
    };
    let truncated = bytes.len() > FS_READ_MAX_BYTES;
    let content_bytes = if truncated { &bytes[..FS_READ_MAX_BYTES] } else { &bytes[..] };
    let is_binary = content_bytes.contains(&0);
    let mut item = json!({
        "path": requested,
        "size": meta.len(),
        "truncated": truncated,
        "etag": fs_etag(&meta),
        "mime": fs_mime(requested),
        "is_binary": is_binary,
    });
    if is_binary {
        item["encoding"] = json!("base64");
        item["content"] = json!(base64::engine::general_purpose::STANDARD.encode(content_bytes));
    } else {
        let text = String::from_utf8_lossy(content_bytes);
        item["encoding"] = json!("utf-8");
        item["content"] = json!(text);
        item["line_count"] = json!(text.lines().count());
    }
    Json(ok(item))
}

/// `POST /api/v1/sessions/{id}/fs:search` — filename search for the `@`
/// mention picker as `{ items, truncated }`. The engine's FsSearch output is
/// one workspace-relative path per line (directories suffixed `/`); this
/// projection parses it into the wire entry shape.
async fn fs_action_search(State(state): State<HttpState>, Path(id): Path<String>, Json(body): Json<Value>) -> Json<Value> {
    let query = body.get("query").and_then(|v| v.as_str()).unwrap_or("");
    let mut params = json!({ "session_id": id, "action": "search", "query": query });
    if let Some(workdir) = session_workdir(&state, &id).await {
        params["homedir"] = json!(workdir.clone());
        params["path"] = json!(workdir);
    }
    if let Some(limit) = body.get("limit").and_then(|v| v.as_u64()) {
        params["limit"] = json!(limit);
    }
    let r = state.rpc(kimi_protocol::methods::SESSION_FS, params).await;
    if r["code"].as_i64() != Some(0) {
        return Json(r);
    }
    let data = &r["data"];
    if data["is_error"].as_bool() == Some(true) {
        return Json(err(-32603, data["content"].as_str().unwrap_or("fs:search refused")));
    }
    let content = data["content"].as_str().unwrap_or("");
    let mut items: Vec<Value> = Vec::new();
    for line in content.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() || line == "No files found." {
            continue;
        }
        let is_dir = line.ends_with('/');
        let path = line.trim_end_matches('/');
        let name = path.rsplit('/').next().unwrap_or(path);
        items.push(json!({
            "path": path,
            "name": name,
            "kind": if is_dir { "directory" } else { "file" },
            "score": 1.0,
            "match_positions": [],
        }));
    }
    let truncated = body
        .get("limit")
        .and_then(|v| v.as_u64())
        .is_some_and(|l| items.len() as u64 >= l);
    Json(ok(json!({ "items": items, "truncated": truncated })))
}

// ── fs projection helpers ────────────────────────────────────────────────

/// Read cap for `fs:read` — mirrors the engine Read tool's byte budget
/// (`kimi-agent` `READ_MAX_BYTES`); larger files come back truncated.
const FS_READ_MAX_BYTES: usize = 4 * 1024 * 1024;

/// Resolve a session-relative path under the workspace root, returning the
/// canonical root and the canonical joined path. Absolute paths and escapes
/// (via `..` or symlinks) are refused — the engine sandbox's containment —
/// and missing targets resolve to `None`.
fn fs_resolve_workspace(root: &std::path::Path, path: &str) -> Option<(std::path::PathBuf, std::path::PathBuf)> {
    let root_canon = std::fs::canonicalize(root).ok()?;
    if path.is_empty() {
        return Some((root_canon.clone(), root_canon));
    }
    let candidate = std::path::Path::new(path);
    if candidate.is_absolute() {
        return None;
    }
    let joined_canon = std::fs::canonicalize(root_canon.join(candidate)).ok()?;
    if !joined_canon.starts_with(&root_canon) {
        return None;
    }
    Some((root_canon, joined_canon))
}

/// One directory listing as fs:list-shaped entries (`{ path, name, kind,
/// modified_at, … }`). Hidden entries and `.git` are skipped (matching the
/// engine's Glob); entries are sorted directories-first then name ascending
/// (the @-mention picker's order). `only_dirs` keeps just the directories —
/// the workspace-children surface. A failed read surfaces as the io error.
fn fs_entries(root: &std::path::Path, dir: &std::path::Path, only_dirs: bool) -> std::io::Result<Vec<Value>> {
    let mut items: Vec<Value> = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" || name.starts_with('.') {
            continue;
        }
        let symlink_target = entry
            .file_type()
            .ok()
            .filter(|t| t.is_symlink())
            .and_then(|_| std::fs::read_link(entry.path()).ok());
        let meta = entry.metadata().ok();
        let kind = if symlink_target.is_some() {
            "symlink"
        } else if meta.as_ref().is_some_and(|m| m.is_dir()) {
            "directory"
        } else {
            "file"
        };
        if only_dirs && kind != "directory" {
            continue;
        }
        let rel = dir.strip_prefix(root).unwrap_or(dir).join(&name);
        let rel = rel.to_string_lossy().replace('\\', "/");
        let mut item = json!({
            "path": rel,
            "name": name,
            "kind": kind,
            "modified_at": iso_from_system_time(meta.as_ref().and_then(|m| m.modified().ok())),
        });
        if let Some(meta) = &meta {
            if meta.is_file() {
                item["size"] = json!(meta.len());
                item["etag"] = json!(fs_etag(meta));
                item["mime"] = json!(fs_mime(&name));
            }
        }
        if let Some(target) = symlink_target {
            item["is_symlink_to"] = json!(target.to_string_lossy());
        }
        items.push(item);
    }
    items.sort_by(|a, b| {
        let rank = |v: &Value| if v["kind"] == "directory" { 0 } else { 1 };
        rank(a)
            .cmp(&rank(b))
            .then_with(|| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")))
    });
    Ok(items)
}

/// Format an epoch-millis timestamp as ISO-8601 (`YYYY-MM-DDTHH:MM:SS.mmmZ`),
/// same civil-date math as `v1::iso_now` (no chrono dependency). Shared by
/// `iso_from_system_time` and engine timestamps that arrive as raw millis
/// (e.g. `started_at` on `task/list` records).
fn iso_from_millis(ms: u64) -> String {
    let secs = ms / 1000;
    let millis = ms % 1000;
    let days = secs / 86_400;
    let secs_of_day = secs % 86_400;
    // Howard Hinnant's civil-from-days (days is u64, so z is never negative).
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    let h = secs_of_day / 3600;
    let mi = (secs_of_day % 3600) / 60;
    let s = secs_of_day % 60;
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{millis:03}Z")
}

/// `SystemTime` as an ISO-8601 timestamp (`YYYY-MM-DDTHH:MM:SS.mmmZ`), same
/// civil-date math as `v1::iso_now`; `None` (unreadable mtime) falls back
/// to now.
fn iso_from_system_time(t: Option<std::time::SystemTime>) -> String {
    let t = t.unwrap_or_else(std::time::SystemTime::now);
    let millis = t
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0) as u64;
    iso_from_millis(millis)
}

/// Stable content tag: `{size:x}-{mtime_secs:x}`.
fn fs_etag(meta: &std::fs::Metadata) -> String {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{:x}-{:x}", meta.len(), mtime)
}

/// Best-effort MIME from the file name extension (drives the viewer's
/// text/binary handling); unknown extensions fall back to octet-stream.
fn fs_mime(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().map(|e| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("md" | "markdown") => "text/markdown",
        Some("html" | "htm") => "text/html",
        Some("css") => "text/css",
        Some("js" | "mjs" | "cjs") => "text/javascript",
        Some("json" | "toml" | "yaml" | "yml" | "xml" | "csv" | "txt" | "log") => "text/plain",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    }
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

/// `GET /api/v1/models` — configured model aliases as `{ items:
/// WireModel[], default_model }` (kap-server catalog projection over the
/// engine config).
async fn models_list(State(state): State<HttpState>) -> Json<Value> {
    let config = state.rpc(kimi_protocol::methods::CONFIG_GET, Value::Null).await;
    if config["code"].as_i64() != Some(0) {
        return Json(config);
    }
    let data = &config["data"];
    let items: Vec<Value> = data["models"]
        .as_object()
        .map(|m| {
            m.iter()
                .map(|(id, v)| {
                    json!({
                        "provider": v["provider"],
                        "model": v["model"],
                        "display_name": id,
                        "max_context_size": v["max_tokens"].as_u64().unwrap_or(1_000_000),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let default_model = data["defaultModel"].as_str().map(|s| s.to_string());
    Json(ok(json!({ "items": items, "default_model": default_model })))
}

/// `GET /api/v1/providers` — configured providers as `{ items:
/// WireProvider[] }` (kap-server catalog projection over the engine config;
/// credentials never leave the server).
async fn providers_list(State(state): State<HttpState>) -> Json<Value> {
    let config = state.rpc(kimi_protocol::methods::CONFIG_GET, Value::Null).await;
    if config["code"].as_i64() != Some(0) {
        return Json(config);
    }
    let items: Vec<Value> = config["data"]["providers"]
        .as_object()
        .map(|p| {
            p.iter()
                .map(|(id, v)| {
                    let has_api_key = v["apiKey"].as_str().is_some_and(|k| !k.is_empty());
                    let mut item = json!({
                        "id": id,
                        "type": v["type"].as_str().unwrap_or("unknown"),
                        "has_api_key": has_api_key,
                        "status": if has_api_key || v["oauth"].is_object() {
                            "connected"
                        } else {
                            "unconfigured"
                        },
                    });
                    if let Some(base_url) = v["baseUrl"].as_str() {
                        item["base_url"] = json!(base_url);
                    }
                    if let Some(default_model) = v["defaultModel"].as_str() {
                        item["default_model"] = json!(default_model);
                    }
                    item
                })
                .collect()
        })
        .unwrap_or_default();
    Json(ok(json!({ "items": items })))
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
        // The engine's ProviderConfig serde key is `defaultModel` (alias
        // `default_model`); a bare `model` key is silently dropped.
        provider["defaultModel"] = json!(model);
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

// ── fs open / reveal / open-in / download ────────────────────────────────

/// A spawn-friendly absolute path — strips the Windows `\\?\` verbatim
/// prefix that `std::fs::canonicalize` produces (cmd/explorer cannot parse
/// verbatim paths).
fn spawn_path(path: &std::path::Path) -> std::path::PathBuf {
    if cfg!(windows) {
        let s = path.to_string_lossy();
        s.strip_prefix(r"\\?\")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| path.to_path_buf())
    } else {
        path.to_path_buf()
    }
}

/// Build the OS file-manager / default-app open command for `path`
/// (pure — never spawns). `reveal` selects the file in the file manager;
/// Linux has no reveal verb, so the containing directory is opened instead.
fn open_command(path: &std::path::Path, reveal: bool) -> (&'static str, Vec<String>) {
    let path = spawn_path(path);
    let path_str = path.to_string_lossy();
    if cfg!(windows) {
        if reveal {
            ("explorer", vec![format!("/select,{path_str}")])
        } else {
            ("cmd", vec!["/c".into(), "start".into(), "".into(), path_str.into_owned()])
        }
    } else if cfg!(target_os = "macos") {
        let mut args = Vec::new();
        if reveal {
            args.push("-R".into());
        }
        args.push(path_str.into_owned());
        ("open", args)
    } else if reveal {
        // No reveal verb on Linux — open the containing directory.
        let target: &std::path::Path = if path.is_dir() {
            &path
        } else {
            path.parent().unwrap_or(path.as_path())
        };
        ("xdg-open", vec![target.to_string_lossy().into_owned()])
    } else {
        ("xdg-open", vec![path_str.into_owned()])
    }
}

/// Spawn the OS file-manager / default-app open for `path` (best-effort,
/// never fails the caller — mirrors `kimi-cli`'s `open_browser`).
/// Setting `KIMI_TEST_NO_SPAWN=1` skips the actual spawn so e2e tests never
/// pop the OS file manager on the test machine.
fn open_in_file_manager(path: &std::path::Path, reveal: bool) {
    if std::env::var_os("KIMI_TEST_NO_SPAWN").is_some() {
        return;
    }
    let (program, args) = open_command(path, reveal);
    let _ = std::process::Command::new(program).args(&args).spawn().map(|_| ());
}

/// `POST /api/v1/sessions/{id}/fs:open` — open a workspace file in the OS
/// default application (`{ path, line? }` → `{ opened: true }`; the line is
/// advisory — the platform open command has no line concept).
async fn fs_action_open(State(state): State<HttpState>, Path(id): Path<String>, Json(body): Json<Value>) -> Json<Value> {
    let Some(workdir) = session_workdir(&state, &id).await else {
        return Json(err(-40401, "session not found"));
    };
    let path = body.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let Some(resolved) = fs_resolve_workspace(std::path::Path::new(&workdir), path) else {
        return Json(err(-32603, &format!("fs:open: {path} does not exist or is outside the session workspace")));
    };
    open_in_file_manager(&resolved.1, false);
    Json(ok(json!({ "opened": true })))
}

/// `POST /api/v1/sessions/{id}/fs:reveal` — select a workspace file in the
/// OS file manager (`{ path }` → `{ revealed: true }`).
async fn fs_action_reveal(State(state): State<HttpState>, Path(id): Path<String>, Json(body): Json<Value>) -> Json<Value> {
    let Some(workdir) = session_workdir(&state, &id).await else {
        return Json(err(-40401, "session not found"));
    };
    let path = body.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let Some(resolved) = fs_resolve_workspace(std::path::Path::new(&workdir), path) else {
        return Json(err(-32603, &format!("fs:reveal: {path} does not exist or is outside the session workspace")));
    };
    open_in_file_manager(&resolved.1, true);
    Json(ok(json!({ "revealed": true })))
}

/// `POST /api/v1/sessions/{id}/fs:open-in` — open a workspace path with an
/// external app (`{ app_id, path, line? }` → `{ opened: true }`). The engine
/// exposes no app registry (`meta.open_in_apps` is empty), so `app_id` is
/// accepted for wire parity and the platform default application is used.
async fn fs_action_open_in(State(state): State<HttpState>, Path(id): Path<String>, Json(body): Json<Value>) -> Json<Value> {
    let Some(workdir) = session_workdir(&state, &id).await else {
        return Json(err(-40401, "session not found"));
    };
    let path = body.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let Some(resolved) = fs_resolve_workspace(std::path::Path::new(&workdir), path) else {
        return Json(err(-32603, &format!("fs:open-in: {path} does not exist or is outside the session workspace")));
    };
    open_in_file_manager(&resolved.1, false);
    Json(ok(json!({ "opened": true })))
}

/// `GET /api/v1/sessions/{id}/fs/{path}:download` — the file's raw bytes
/// with an attachment disposition (the browser navigates the URL directly;
/// mirrors kap-server's download route). The colon rewrite turns the
/// `:download` suffix into a `/download` segment.
async fn fs_download(State(state): State<HttpState>, Path((id, rest)): Path<(String, String)>) -> Response {
    let Some(rel) = rest.strip_suffix("/download").filter(|s| !s.is_empty()) else {
        return Json(err(-32602, &format!("unsupported action: {rest}"))).into_response();
    };
    let Some(workdir) = session_workdir(&state, &id).await else {
        return Json(err(-40401, "session not found")).into_response();
    };
    let Some(resolved) = fs_resolve_workspace(std::path::Path::new(&workdir), rel) else {
        return Json(err(-32603, &format!("fs:download: {rel} does not exist or is outside the session workspace"))).into_response();
    };
    let meta = match std::fs::metadata(&resolved.1) {
        Ok(meta) => meta,
        Err(error) => return Json(err(-32603, &format!("fs:download: failed to stat {rel}: {error}"))).into_response(),
    };
    if !meta.is_file() {
        return Json(err(-32603, &format!("fs:download: {rel} is not a file"))).into_response();
    }
    let bytes = match std::fs::read(&resolved.1) {
        Ok(bytes) => bytes,
        Err(error) => return Json(err(-32603, &format!("fs:download: failed to read {rel}: {error}"))).into_response(),
    };
    let filename = resolved
        .1
        .file_name()
        .map(|f| f.to_string_lossy().replace('"', "\\\""))
        .unwrap_or_default();
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", fs_mime(rel))
        .header("content-disposition", format!("attachment; filename=\"{filename}\""))
        .body(Body::from(bytes))
        .expect("response")
        .into_response()
}

// ── workspaces children ─────────────────────────────────────────────────

/// `GET /api/v1/workspaces/{id}/children` — the subdirectories of a
/// workspace root as `{ items, truncated }` fs:list-shaped entries (the
/// folder-picker surface; files are not workspace children).
async fn workspace_children(State(state): State<HttpState>, Path(id): Path<String>) -> Json<Value> {
    let workspaces = workspaces_list(State(state.clone())).await;
    let path = workspaces.0["data"]["workspaces"]
        .as_array()
        .and_then(|ws| ws.iter().find(|w| w["id"] == id))
        .and_then(|w| w.get("path").and_then(|v| v.as_str()))
        .map(str::to_string);
    let Some(path) = path else {
        return Json(err(-40401, "workspace not found"));
    };
    let root = std::path::Path::new(&path);
    let root_canon = match std::fs::canonicalize(root) {
        Ok(canon) => canon,
        Err(error) => {
            return Json(err(-32603, &format!("workspace children: failed to resolve {path}: {error}")))
        }
    };
    let items = match fs_entries(&root_canon, &root_canon, true) {
        Ok(items) => items,
        Err(error) => {
            return Json(err(-32603, &format!("workspace children: failed to read {path}: {error}")))
        }
    };
    Json(ok(json!({ "items": items, "truncated": false })))
}

// ── providers refresh ────────────────────────────────────────────────────

/// The configured provider ids (sorted), or `None` when the engine config
/// cannot be read.
async fn provider_ids(state: &HttpState) -> Option<Vec<String>> {
    let config = state.rpc(kimi_protocol::methods::CONFIG_GET, Value::Null).await;
    if config["code"].as_i64() != Some(0) {
        return None;
    }
    let mut ids: Vec<String> = config["data"]["providers"]
        .as_object()
        .map(|p| p.keys().cloned().collect())
        .unwrap_or_default();
    ids.sort();
    Some(ids)
}

/// `POST /api/v1/providers:refresh` (arrives slash-form after the colon
/// rewrite) — refresh every provider's model metadata. The engine manages
/// models from config and auto-discovers nothing, so every known provider is
/// reported unchanged (mirrors kap-server's no-op single-provider refresh).
async fn providers_refresh_all(State(state): State<HttpState>) -> Json<Value> {
    let Some(ids) = provider_ids(&state).await else {
        return Json(err(-32603, "providers:refresh: failed to read the engine config"));
    };
    Json(ok(json!({ "changed": [], "unchanged": ids, "failed": [] })))
}

/// `POST /api/v1/providers/{id}:refresh` (arrives slash-form after the colon
/// rewrite) — single-provider no-op refresh (kap-server parity:
/// `{ changed: [], unchanged: [id], failed: [] }`).
async fn providers_refresh_one(State(_state): State<HttpState>, Path(id): Path<String>) -> Json<Value> {
    Json(ok(json!({ "changed": [], "unchanged": [id], "failed": [] })))
}

/// `POST /api/v1/providers:refresh_oauth` — no-op OAuth-model refresh (same
/// shape; nothing auto-discovers).
async fn providers_refresh_oauth(State(state): State<HttpState>) -> Json<Value> {
    let Some(ids) = provider_ids(&state).await else {
        return Json(err(-32603, "providers:refresh_oauth: failed to read the engine config"));
    };
    Json(ok(json!({ "changed": [], "unchanged": ids, "failed": [] })))
}

// ── deliberately unsupported surfaces ────────────────────────────────────

/// JSON-RPC "method not found" — the code for surfaces the engine
/// deliberately does not serve (terminals, questions): the route exists so
/// web hosts get a clear envelope, the capability does not.
const ERR_METHOD_NOT_FOUND: i64 = -32601;

/// `GET/POST /api/v1/sessions/{id}/terminals…` — the engine has no WS
/// terminal surface (terminal frames are not emitted; the WS facade ignores
/// `terminal_*` control frames), so every terminal route answers a clear
/// error envelope instead of a bare 404.
async fn terminals_unsupported(State(_state): State<HttpState>) -> Json<Value> {
    Json(err(
        ERR_METHOD_NOT_FOUND,
        "terminals are not supported: the engine has no WS terminal surface (use a system terminal)",
    ))
}

/// `POST /api/v1/sessions/{id}/questions/{question_id}…` — engine question
/// requests surface as tool content and are answered by the next prompt;
/// there is no standalone question endpoint, so the routes answer a clear
/// error envelope instead of a bare 404.
async fn questions_unsupported(State(_state): State<HttpState>) -> Json<Value> {
    Json(err(
        ERR_METHOD_NOT_FOUND,
        "questions are not supported: engine question requests surface as tool content, answered by the next prompt",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kimi_server::processor::Processor;
    use kimi_server::request_processors::HealthProcessor;

    /// The OS-open command is built pure (never spawned from unit tests):
    /// reveal selects the file, plain open launches the default app.
    #[test]
    fn open_command_builds_platform_commands() {
        let path = std::path::Path::new("C:/work/hello.txt");
        let (program, args) = open_command(path, true);
        if cfg!(windows) {
            assert_eq!(program, "explorer");
            assert!(args[0].starts_with("/select,"), "args: {args:?}");
            assert!(args[0].contains("hello.txt"), "args: {args:?}");
        } else {
            assert!(!args.is_empty());
        }
        let (program, args) = open_command(path, false);
        if cfg!(windows) {
            assert_eq!(program, "cmd");
            assert_eq!(args[0], "/c");
        } else {
            assert!(!args.is_empty());
        }
    }

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
            (
                "/api/v1/sessions/sess-1/fs/src/main.ts:download",
                "/api/v1/sessions/sess-1/fs/src/main.ts/download",
            ),
            (
                "/api/v1/providers/mock:refresh",
                "/api/v1/providers/mock/refresh",
            ),
            (
                "/api/v1/sessions/sess-1/terminals/t-1:close",
                "/api/v1/sessions/sess-1/terminals/t-1/close",
            ),
            (
                "/api/v1/sessions/sess-1/questions/q-1:dismiss",
                "/api/v1/sessions/sess-1/questions/q-1/dismiss",
            ),
            // Plain routes are untouched.
            ("/api/v1/sessions/sess-1/fs:grep", "/api/v1/sessions/sess-1/fs:grep"),
            ("/api/v1/sessions/sess-1/fs:open", "/api/v1/sessions/sess-1/fs:open"),
            ("/api/v1/sessions/sess-1/fs:open-in", "/api/v1/sessions/sess-1/fs:open-in"),
            ("/api/v1/sessions/sess-1/prompt", "/api/v1/sessions/sess-1/prompt"),
            ("/api/v1/providers:refresh_oauth", "/api/v1/providers:refresh_oauth"),
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

    /// Host-header allowlist (kap-server `isAllowedHost` parity): loopback
    /// names/IPs and literal IPs are always allowed, the bound host is allowed,
    /// `.suffix` extras match the bare domain and subdomains, and a missing
    /// `Host` is rejected.
    #[test]
    fn host_check_allows_loopback_and_extras() {
        let opts = HostCheckConfig {
            bound_host: Some("192.168.1.5".into()),
            extra: vec![".example.com".into(), "app.test".into()],
            disable: false,
        };
        for allowed in [
            "localhost",
            "localhost:58627",
            "sub.localhost",
            "127.0.0.1",
            "127.0.0.1:8080",
            "::1",
            "[::1]:8080",
            "10.0.0.1",
            "192.168.1.5",
            "192.168.1.5:58627",
            "example.com",
            "a.example.com",
            "app.test",
        ] {
            assert!(is_allowed_host(Some(allowed), &opts), "should allow {allowed}");
        }
        for denied in ["evil.test", "example.com.evil.net", "app.test.evil.net", ""] {
            assert!(!is_allowed_host(Some(denied), &opts), "should deny {denied}");
        }
        assert!(!is_allowed_host(None, &opts), "missing Host is denied");
        // `disable` bypasses the check entirely.
        let disabled = HostCheckConfig { disable: true, ..Default::default() };
        assert!(is_allowed_host(None, &disabled), "disabled check allows everything");
    }

    /// `strip_port` handles bracketed IPv6, host:port, and bare IPv6.
    #[test]
    fn strip_port_normalizes_host_values() {
        assert_eq!(strip_port("localhost:80"), "localhost");
        assert_eq!(strip_port("1.2.3.4:5678"), "1.2.3.4");
        assert_eq!(strip_port("[::1]:80"), "[::1]");
        assert_eq!(strip_port("::1"), "::1");
        assert_eq!(strip_port("EXAMPLE.com"), "example.com");
        assert_eq!(strip_port("host:notaport"), "host:notaport");
    }

    /// `is_loopback_host` drives the shutdown gate and the TLS refusal.
    #[test]
    fn loopback_classification() {
        for host in ["127.0.0.1", "localhost", "::1", "[::1]", "127.0.0.1:58627"] {
            assert!(is_loopback_host(host), "loopback: {host}");
        }
        for host in ["0.0.0.0", "192.168.1.5", "example.com"] {
            assert!(!is_loopback_host(host), "non-loopback: {host}");
        }
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

    /// Engine `task/list` records (`TaskInfoBase`) project onto the v1
    /// `WireTask` shape: kind/status literal remap (kap-server
    /// `TASK_KIND_REMAP` / `TASK_STATUS_REMAP`), epoch-ms → ISO timestamps,
    /// `session_id` filled from the route.
    #[test]
    fn wire_task_projects_kinds_and_statuses() {
        let cases = [
            // kind remap: process → bash, agent → subagent, question → tool,
            // unknown → tool.
            ("process", "bash"),
            ("agent", "subagent"),
            ("question", "tool"),
            ("mystery", "tool"),
        ];
        for (kind, expected) in cases {
            let wire = wire_task(
                "sess-1",
                &json!({
                    "task_id": "t-1",
                    "description": "run tests",
                    "kind": kind,
                    "status": "running",
                    "started_at": 1762560000000u64,
                }),
            );
            assert_eq!(wire["kind"], expected, "kind {kind}: {wire}");
            assert_eq!(wire["id"], "t-1", "id: {wire}");
            assert_eq!(wire["session_id"], "sess-1", "session_id: {wire}");
            assert_eq!(wire["description"], "run tests", "description: {wire}");
            assert_eq!(wire["status"], "running", "status: {wire}");
            assert_eq!(wire["created_at"], "2025-11-08T00:00:00.000Z", "created_at: {wire}");
            assert_eq!(wire["started_at"], "2025-11-08T00:00:00.000Z", "started_at: {wire}");
            assert!(wire.get("completed_at").is_none(), "no completed_at while running: {wire}");
        }

        // status remap: timed_out/lost → failed, killed → cancelled,
        // unknown → failed; a terminal task carries `completed_at`.
        let status_cases = [
            ("running", "running"),
            ("completed", "completed"),
            ("failed", "failed"),
            ("timed_out", "failed"),
            ("lost", "failed"),
            ("killed", "cancelled"),
            ("mystery", "failed"),
        ];
        for (status, expected) in status_cases {
            let wire = wire_task(
                "sess-1",
                &json!({
                    "task_id": "t-2",
                    "description": "d",
                    "kind": "agent",
                    "status": status,
                    "started_at": 1000u64,
                    "ended_at": 9000u64,
                }),
            );
            assert_eq!(wire["status"], expected, "status {status}: {wire}");
            assert_eq!(wire["kind"], "subagent", "kind: {wire}");
            assert_eq!(wire["completed_at"], "1970-01-01T00:00:09.000Z", "completed_at: {wire}");
        }

        // A missing `ended_at` leaves `completed_at` absent.
        let wire = wire_task(
            "sess-1",
            &json!({
                "task_id": "t-3",
                "description": "d",
                "kind": "process",
                "status": "completed",
                "started_at": 1000u64,
            }),
        );
        assert!(wire.get("completed_at").is_none(), "no completed_at: {wire}");
    }

    /// Walk a JSON value asserting no object carries a credential key — the
    /// redaction invariant every config/providers/models response must hold.
    /// The check targets the credential keys themselves (`apiKey`/`api_key`/
    /// `token`/`secret`); presence flags like `has_api_key` are deliberate
    /// wire fields and are not credentials.
    fn assert_no_secret_keys(value: &Value) {
        match value {
            Value::Object(map) => {
                for key in map.keys() {
                    let lower = key.to_ascii_lowercase();
                    assert!(
                        !matches!(lower.as_str(), "apikey" | "api_key" | "token" | "secret"),
                        "credential key leaked: {key} in {value}"
                    );
                }
                for value in map.values() {
                    assert_no_secret_keys(value);
                }
            }
            Value::Array(items) => {
                for item in items {
                    assert_no_secret_keys(item);
                }
            }
            _ => {}
        }
    }

    /// The engine's `config/get` envelope is deliberately unredacted; the
    /// wire projection must strip credentials everywhere, not just under
    /// `providers`: `services.moonshot.api_key`, `model_catalog.api_key` and
    /// env-style keys in `mcp.servers.*.env` must never cross the wire, while
    /// non-credential neighbors survive untouched. The input mirrors the
    /// engine's serialized `KimiConfig` shape: top-level keys are camelCase
    /// where the serde renames say so, nested struct fields are mostly
    /// snake_case already.
    #[test]
    fn wire_config_redacts_nested_credentials() {
        let config = json!({
            "defaultModel": "m1",
            "providers": {
                "openai": { "type": "openai", "apiKey": "sk-raw", "baseUrl": "https://api.example.com/v1", "defaultModel": "gpt-4o" },
            },
            "models": { "m1": { "provider": "openai", "model": "gpt-4o", "max_tokens": 4096 } },
            "services": { "moonshot": { "base_url": "https://api.moonshot.ai/v1", "api_key": "sk-moonshot" } },
            "model_catalog": { "endpoint": "https://models.example.com", "api_key": "sk-catalog" },
            "mcp": { "servers": { "filesystem": { "command": "npx", "env": { "OPENAI_API_KEY": "sk-env", "DATABASE_URL": "postgres://localhost/db" } } } },
        });
        let wire = wire_config(config.as_object().expect("object"));
        assert_no_secret_keys(&wire);

        // Providers project as before (`has_api_key`, never the key itself).
        assert_eq!(wire["providers"]["openai"]["has_api_key"], true, "wire: {wire}");
        assert!(wire["providers"]["openai"].get("apiKey").is_none(), "wire: {wire}");
        // Nested non-provider secrets are gone, benign neighbors kept.
        assert_eq!(
            wire["services"]["moonshot"]["base_url"],
            "https://api.moonshot.ai/v1",
            "wire: {wire}"
        );
        assert!(wire["services"]["moonshot"].get("api_key").is_none(), "wire: {wire}");
        assert_eq!(
            wire["model_catalog"]["endpoint"],
            "https://models.example.com",
            "wire: {wire}"
        );
        assert!(wire["model_catalog"].get("api_key").is_none(), "wire: {wire}");
        assert!(
            wire["mcp"]["servers"]["filesystem"]["env"].get("OPENAI_API_KEY").is_none(),
            "wire: {wire}"
        );
        assert_eq!(
            wire["mcp"]["servers"]["filesystem"]["env"]["DATABASE_URL"],
            "postgres://localhost/db",
            "non-secret env survives: {wire}"
        );
        // No collateral: `max_tokens` on model aliases is not a credential.
        assert_eq!(wire["models"]["m1"]["max_tokens"], 4096, "max_tokens kept: {wire}");
    }

    /// The engine's usage status nests the aggregate under `total`
    /// (`{ by_model?, total?: TokenUsage, current_turn? }`); the wire
    /// projection reads it there — a real (non-zero) total must pass through,
    /// and the empty pre-turn structure must still project to zeros.
    #[test]
    fn wire_usage_reads_engine_total() {
        let usage = json!({
            "total": { "input_tokens": 10, "output_tokens": 20, "total_tokens": 30 }
        });
        let wire = wire_usage(&usage);
        assert_eq!(wire["input_tokens"], 10, "wire: {wire}");
        assert_eq!(wire["output_tokens"], 20, "wire: {wire}");
        assert_eq!(wire["cache_read_tokens"], 0, "wire: {wire}");
        assert_eq!(wire["turn_count"], 0, "wire: {wire}");

        let empty = wire_usage(&json!({}));
        for field in [
            "input_tokens",
            "output_tokens",
            "cache_read_tokens",
            "cache_creation_tokens",
            "context_tokens",
            "context_limit",
            "turn_count",
        ] {
            assert_eq!(empty[field], 0, "zero field {field}: {empty}");
        }
        assert_eq!(empty["total_cost_usd"], 0.0, "cost: {empty}");
    }
}
