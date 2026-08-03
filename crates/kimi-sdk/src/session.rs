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

    /// The last assistant message's text from the session context, if any.
    pub async fn transcript(&mut self) -> anyhow::Result<Option<String>> {
        let body = self.client.lock().await.session_get_context(&self.id).await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("get_context: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(kimi_ui::last_assistant_text(&body["result"]))
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

    /// Persist the session to the store (engine-side `session/save`).
    pub async fn save(&mut self) -> anyhow::Result<()> {
        let body = self
            .client
            .lock()
            .await
            .call(
                kimi_protocol::methods::SESSION_SAVE,
                serde_json::json!({ "session_id": self.id }),
            )
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("save session: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(())
    }

    /// Load the persisted session state into the runtime agent.
    pub async fn load(&mut self) -> anyhow::Result<()> {
        let body = self
            .client
            .lock()
            .await
            .call(
                kimi_protocol::methods::SESSION_LOAD,
                serde_json::json!({ "session_id": self.id }),
            )
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("load session: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(())
    }

    /// Switch the session's model.
    pub async fn set_model(&mut self, model: &str) -> anyhow::Result<()> {
        let body = self
            .client
            .lock()
            .await
            .call(
                kimi_protocol::methods::SESSION_SET_MODEL,
                serde_json::json!({ "session_id": self.id, "model": model }),
            )
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("set model: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(())
    }

    /// Compact the session's context.
    pub async fn compact(&mut self) -> anyhow::Result<serde_json::Value> {
        let body = self
            .client
            .lock()
            .await
            .call(
                kimi_protocol::methods::SESSION_COMPACT,
                serde_json::json!({ "session_id": self.id }),
            )
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("compact: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"].clone())
    }
}
