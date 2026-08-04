//! Kimi Code client SDK — the high-level door into a host engine, mirroring
//! node-sdk's `createKimiHarness`. A `Harness` owns an engine (embedded
//! in-process, or a spawned `kimi-server-serve` process) and hands out typed
//! `Session` handles; interface layers (TUI controllers, ACP adapter, future
//! SDK consumers) code against this instead of raw RPC.

pub mod catalog;
pub mod session;

pub use session::Session;

use std::sync::Arc;

use base64::Engine;
use kimi_server_client::AppServerClient;
use tokio::sync::Mutex;

/// Engine lifecycle + typed session factory.
#[derive(Clone)]
pub struct Harness {
    client: Arc<Mutex<AppServerClient>>,
    /// Engine event stream (embedded EventBus / remote captured stderr).
    events: Arc<Mutex<Option<kimi_ui::EventSource>>>,
}

impl Harness {
    /// Open an engine embedded in this process.
    pub fn embedded() -> anyhow::Result<Self> {
        let server = kimi_server::Server::build()?;
        Ok(Self {
            events: Arc::new(Mutex::new(Some(kimi_ui::EventSource::from_bus(
                server.state.subscribe_events(),
            )))),
            client: Arc::new(Mutex::new(AppServerClient::InProcess(
                kimi_server::in_process::spawn(server.processor),
            ))),
        })
    }

    /// Open a separate engine process over stdio (`kimi-server-serve`); its
    /// stderr fan-out becomes the harness event stream.
    pub fn remote(bin: &str) -> anyhow::Result<Self> {
        let (client, stderr) =
            kimi_server_client::stdio_client::StdioClient::spawn_captured(bin)?;
        Ok(Self {
            events: Arc::new(Mutex::new(Some(kimi_ui::EventSource::from_lines(
                stderr,
            )))),
            client: Arc::new(Mutex::new(AppServerClient::Remote(client))),
        })
    }

    /// The engine event stream (poll with `EventSource::next`), if the
    /// transport provides one.
    pub async fn events(
        &self,
    ) -> tokio::sync::MutexGuard<'_, Option<kimi_ui::EventSource>> {
        self.events.lock().await
    }

    /// Engine health (`ok` on success).
    pub async fn health(&self) -> anyhow::Result<String> {
        let body = self.client.lock().await.health().await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("health: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"]["status"].as_str().unwrap_or("?").to_string())
    }

    /// Create (or resume) a session by id and return a typed handle.
    pub async fn create_session(&self, session_id: &str) -> anyhow::Result<Session> {
        let body = self.client.lock().await.session_create(session_id).await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("create session: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(Session::new(session_id.to_string(), self.client.clone()))
    }

    /// Persisted sessions (newest first), as their summary objects.
    pub async fn list_sessions(&self, limit: u32) -> anyhow::Result<Vec<serde_json::Value>> {
        let body = self.client.lock().await.session_list(limit).await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("list sessions: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"]["sessions"].as_array().cloned().unwrap_or_default())
    }

    /// The engine's parsed config.
    pub async fn config(&self) -> anyhow::Result<serde_json::Value> {
        let body = self.client.lock().await.config_get().await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("config: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"].clone())
    }

    /// Configured model aliases (keys) plus the default model, if any.
    pub async fn list_models(&self) -> anyhow::Result<(Vec<String>, Option<String>)> {
        let config = self.config().await?;
        let aliases = config["models"]
            .as_object()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default();
        let default_model = config["defaultModel"].as_str().map(|s| s.to_string());
        Ok((aliases, default_model))
    }

    /// Permanently delete a persisted session (engine-side `session/delete`).
    pub async fn delete_session(&self, session_id: &str) -> anyhow::Result<bool> {
        let body = self
            .client
            .lock()
            .await
            .call(
                kimi_protocol::methods::SESSION_DELETE,
                serde_json::json!({ "session_id": session_id }),
            )
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("delete session: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"]["deleted"].as_bool().unwrap_or(false))
    }

    /// Export a session as a ZIP archive (decoded from the wire base64).
    pub async fn export_session(&self, session_id: &str) -> anyhow::Result<Vec<u8>> {
        let body = self
            .client
            .lock()
            .await
            .call(
                kimi_protocol::methods::SESSION_EXPORT,
                serde_json::json!({ "session_id": session_id }),
            )
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("export session: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        let b64 = body["result"]["zip_base64"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("export returned no zip_base64"))?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| anyhow::anyhow!("zip_base64 decode failed: {e}"))?;
        Ok(bytes)
    }

    /// Pending approvals (a session scope, or all when `None`).
    pub async fn approvals(
        &self,
        session_id: Option<&str>,
    ) -> anyhow::Result<Vec<serde_json::Value>> {
        let body = self.client.lock().await.approval_list(session_id).await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("approval list: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"]["pending"].as_array().cloned().unwrap_or_default())
    }

    /// Resolve a pending approval: `allow`, or `deny` with a reason. Returns
    /// whether the approval was found and resolved.
    pub async fn resolve_approval(
        &self,
        id: &str,
        allow: bool,
        reason: Option<&str>,
    ) -> anyhow::Result<bool> {
        let body = self.client.lock().await.approval_resolve(id, allow, reason).await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("approval resolve: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"]["resolved"].as_bool().unwrap_or(false))
    }

    /// The protocol client (borrowed) — advanced callers escape to raw RPC.
    pub async fn client(&self) -> tokio::sync::MutexGuard<'_, AppServerClient> {
        self.client.lock().await
    }

    /// One-shot: create (or resume) a session, run a prompt, and return the
    /// last assistant transcript — the SDK's `print` equivalent. Requires a
    /// reachable LLM (engine-side config).
    pub async fn run_prompt(&self, session_id: &str, text: &str) -> anyhow::Result<String> {
        let mut session = self.create_session(session_id).await?;
        let result = session.prompt(text).await;
        if let Some(error) = result.get("error") {
            anyhow::bail!("run_prompt: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(session
            .transcript()
            .await?
            .unwrap_or_else(|| result.to_string()))
    }
}
