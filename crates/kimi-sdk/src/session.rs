//! Typed session handle — a session id plus a shared protocol client.

use std::sync::Arc;

use kimi_server_client::AppServerClient;
use tokio::sync::Mutex;

/// A session in a host engine; every method is a thin typed RPC.
#[derive(Clone)]
pub struct Session {
    id: String,
    client: Arc<Mutex<AppServerClient>>,
}

impl Session {
    pub(crate) fn new(id: String, client: Arc<Mutex<AppServerClient>>) -> Self {
        Self { id, client }
    }

    /// The session id.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Run one prompt; resolves with the full wire response body.
    pub async fn prompt(&mut self, text: &str) -> serde_json::Value {
        self.client.lock().await.session_prompt(&self.id, text).await
    }

    /// The session's context (history + token count).
    pub async fn get_context(&mut self) -> serde_json::Value {
        self.client.lock().await.session_get_context(&self.id).await
    }

    /// The session's status snapshot.
    pub async fn get_status(&mut self) -> serde_json::Value {
        self.client.lock().await.session_get_status(&self.id).await
    }

    /// Run a shell command in the session workspace.
    pub async fn run_shell(&mut self, command: &str) -> serde_json::Value {
        self.client.lock().await.session_run_shell(&self.id, command).await
    }

    /// Request cancellation of a running turn.
    pub async fn cancel(&mut self) -> serde_json::Value {
        self.client.lock().await.session_cancel(&self.id).await
    }
}
