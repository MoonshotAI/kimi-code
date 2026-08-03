//! Kimi Code client SDK — the high-level door into a host engine, mirroring
//! node-sdk's `createKimiHarness`. A `Harness` owns an engine (embedded
//! in-process, or a spawned `kimi-server-serve` process) and hands out typed
//! `Session` handles; interface layers (TUI controllers, ACP adapter, future
//! SDK consumers) code against this instead of raw RPC.

pub mod session;

pub use session::Session;

use std::sync::Arc;

use kimi_server_client::AppServerClient;
use tokio::sync::Mutex;

/// Engine lifecycle + typed session factory.
#[derive(Clone)]
pub struct Harness {
    client: Arc<Mutex<AppServerClient>>,
}

impl Harness {
    /// Open an engine embedded in this process.
    pub fn embedded() -> anyhow::Result<Self> {
        let server = kimi_server::Server::build()?;
        Ok(Self {
            client: Arc::new(Mutex::new(AppServerClient::InProcess(
                kimi_server::in_process::spawn(server.processor),
            ))),
        })
    }

    /// Open a separate engine process over stdio (`kimi-server-serve`).
    pub fn remote(bin: &str) -> anyhow::Result<Self> {
        Ok(Self {
            client: Arc::new(Mutex::new(AppServerClient::Remote(
                kimi_server_client::stdio_client::StdioClient::spawn(bin)?,
            ))),
        })
    }

    /// Engine health (`ok` on success).
    pub async fn health(&mut self) -> anyhow::Result<String> {
        let body = self.client.lock().await.health().await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("health: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"]["status"].as_str().unwrap_or("?").to_string())
    }

    /// Create (or resume) a session by id and return a typed handle.
    pub async fn create_session(&mut self, session_id: &str) -> anyhow::Result<Session> {
        let body = self.client.lock().await.session_create(session_id).await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("create session: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(Session::new(session_id.to_string(), self.client.clone()))
    }

    /// The protocol client (borrowed) — advanced callers escape to raw RPC.
    pub async fn client(&mut self) -> tokio::sync::MutexGuard<'_, AppServerClient> {
        self.client.lock().await
    }
}
