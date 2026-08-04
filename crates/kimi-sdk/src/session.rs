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

    /// Create a goal on the session; returns the goal snapshot.
    pub async fn create_goal(&mut self, objective: &str) -> anyhow::Result<serde_json::Value> {
        let body = self
            .client
            .lock()
            .await
            .call(
                kimi_protocol::methods::SESSION_GOAL_CREATE,
                serde_json::json!({ "session_id": self.id, "objective": objective }),
            )
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("create goal: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"].clone())
    }

    /// The current goal snapshot (or null when none is active).
    pub async fn goal(&mut self) -> anyhow::Result<serde_json::Value> {
        let body = self
            .client
            .lock()
            .await
            .call(
                kimi_protocol::methods::SESSION_GOAL_GET,
                serde_json::json!({ "session_id": self.id }),
            )
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("get goal: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"].clone())
    }

    /// Pause the active goal (optional reason).
    pub async fn pause_goal(&mut self, reason: Option<&str>) -> anyhow::Result<serde_json::Value> {
        self.goal_state_change(kimi_protocol::methods::SESSION_GOAL_PAUSE, reason).await
    }

    /// Resume the paused goal (optional reason).
    pub async fn resume_goal(&mut self, reason: Option<&str>) -> anyhow::Result<serde_json::Value> {
        self.goal_state_change(kimi_protocol::methods::SESSION_GOAL_RESUME, reason).await
    }

    /// Cancel the active goal.
    pub async fn cancel_goal(&mut self) -> anyhow::Result<serde_json::Value> {
        self.goal_state_change(kimi_protocol::methods::SESSION_GOAL_CANCEL, None).await
    }

    async fn goal_state_change(
        &mut self,
        method: &str,
        reason: Option<&str>,
    ) -> anyhow::Result<serde_json::Value> {
        let mut params = serde_json::json!({ "session_id": self.id });
        if let Some(reason) = reason {
            params["reason"] = serde_json::json!(reason);
        }
        let body = self.client.lock().await.call(method, params).await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("goal change: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"].clone())
    }

    /// Toggle plan mode on the session.
    pub async fn set_plan_mode(&mut self, enabled: bool) -> anyhow::Result<()> {
        self.mode_toggle(kimi_protocol::methods::SESSION_SET_PLAN_MODE, enabled).await
    }

    /// Toggle swarm mode on the session.
    pub async fn set_swarm_mode(&mut self, enabled: bool) -> anyhow::Result<()> {
        self.mode_toggle(kimi_protocol::methods::SESSION_SET_SWARM_MODE, enabled).await
    }

    /// Set the thinking effort (`low` / `medium` / `high`, or `None` to clear).
    pub async fn set_thinking(&mut self, effort: Option<&str>) -> anyhow::Result<()> {
        let mut params = serde_json::json!({ "session_id": self.id });
        if let Some(effort) = effort {
            params["effort"] = serde_json::json!(effort);
        }
        let body = self.client.lock().await.call(kimi_protocol::methods::SESSION_SET_THINKING, params).await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("set thinking: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(())
    }

    /// Undo the last turn; returns the undo result body.
    pub async fn undo_history(&mut self) -> anyhow::Result<serde_json::Value> {
        let body = self
            .client
            .lock()
            .await
            .call(
                kimi_protocol::methods::SESSION_UNDO_HISTORY,
                serde_json::json!({ "session_id": self.id }),
            )
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("undo history: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"].clone())
    }

    /// Steer the running turn with extra content parts.
    pub async fn steer(&mut self, parts: serde_json::Value) -> anyhow::Result<bool> {
        let body = self
            .client
            .lock()
            .await
            .call(
                kimi_protocol::methods::SESSION_STEER,
                serde_json::json!({ "session_id": self.id, "input": parts }),
            )
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("steer: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"]["queued"].as_bool().unwrap_or(false))
    }

    /// Registered skills on the session.
    pub async fn list_skills(&mut self) -> anyhow::Result<serde_json::Value> {
        self.simple_call(kimi_protocol::methods::SESSION_LIST_SKILLS).await
    }

    /// The active plan, if any.
    pub async fn get_plan(&mut self) -> anyhow::Result<serde_json::Value> {
        self.simple_call(kimi_protocol::methods::SESSION_GET_PLAN).await
    }

    /// Usage snapshot for the session.
    pub async fn get_usage(&mut self) -> anyhow::Result<serde_json::Value> {
        self.simple_call(kimi_protocol::methods::SESSION_GET_USAGE).await
    }

    /// Fork this session into a new id (copies the persisted record).
    pub async fn fork(&mut self, fork_id: &str, title: Option<&str>) -> anyhow::Result<()> {
        let mut params = serde_json::json!({ "session_id": self.id, "fork_id": fork_id });
        if let Some(title) = title {
            params["title"] = serde_json::json!(title);
        }
        let body = self.client.lock().await.call(kimi_protocol::methods::SESSION_FORK, params).await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("fork: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(())
    }

    /// Append an imported transcript chunk to the session context.
    pub async fn import_context(&mut self, content: &str, source: &str) -> anyhow::Result<()> {
        let body = self
            .client
            .lock()
            .await
            .call(
                kimi_protocol::methods::SESSION_IMPORT_CONTEXT,
                serde_json::json!({ "session_id": self.id, "content": content, "source": source }),
            )
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("import context: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(())
    }

    /// Clear the session context.
    pub async fn clear_context(&mut self) -> anyhow::Result<bool> {
        let body = self
            .client
            .lock()
            .await
            .call(
                kimi_protocol::methods::SESSION_CLEAR_CONTEXT,
                serde_json::json!({ "session_id": self.id }),
            )
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("clear context: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"]["cleared"].as_bool().unwrap_or(false))
    }

    /// Spawn the side (btw) agent; returns its id (`btw-<session_id>`).
    pub async fn start_btw(&mut self) -> anyhow::Result<String> {
        let body = self
            .client
            .lock()
            .await
            .call(
                kimi_protocol::methods::SESSION_START_BTW,
                serde_json::json!({ "session_id": self.id }),
            )
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("start_btw: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"]["btw_id"].as_str().unwrap_or("").to_string())
    }

    /// Tear down the side (btw) agent.
    pub async fn end_btw(&mut self) -> anyhow::Result<()> {
        let body = self
            .client
            .lock()
            .await
            .call(
                kimi_protocol::methods::SESSION_END_BTW,
                serde_json::json!({ "session_id": self.id }),
            )
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("end_btw: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(())
    }

    async fn simple_call(&mut self, method: &str) -> anyhow::Result<serde_json::Value> {
        let body = self
            .client
            .lock()
            .await
            .call(method, serde_json::json!({ "session_id": self.id }))
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("{method}: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"].clone())
    }

    async fn mode_toggle(&mut self, method: &str, enabled: bool) -> anyhow::Result<()> {
        let body = self
            .client
            .lock()
            .await
            .call(
                method,
                serde_json::json!({ "session_id": self.id, "enabled": enabled }),
            )
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("mode toggle: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(())
    }
}
