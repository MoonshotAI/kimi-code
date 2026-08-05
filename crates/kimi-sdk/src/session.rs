//! Typed session handle — a session id plus a shared protocol client.

use std::sync::Arc;

use kimi_server_client::AppServerClient;

/// A session in a host engine; every method is a thin typed RPC.
#[derive(Clone)]
pub struct Session {
    id: String,
    client: Arc<AppServerClient>,
}

impl Session {
    pub(crate) fn new(id: String, client: Arc<AppServerClient>) -> Self {
        Self { id, client }
    }

    /// The session id.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Run one prompt; resolves with the full wire response body.
    pub async fn prompt(&mut self, text: &str) -> serde_json::Value {
        self.prompt_parts(serde_json::json!([{ "type": "text", "text": text }]))
            .await
    }

    /// Run one prompt with explicit content parts (the context wire shape
    /// `[{"type":"text","text":…}, …]`); resolves with the full wire response
    /// body. Mirrors the SDK's parts-based `Session.prompt` input.
    pub async fn prompt_parts(&mut self, parts: serde_json::Value) -> serde_json::Value {
        self.client
            .call(
                kimi_protocol::methods::SESSION_PROMPT,
                serde_json::json!({ "session_id": self.id, "input": parts }),
            )
            .await
    }

    /// The last assistant message's text from the session context, if any.
    pub async fn transcript(&mut self) -> anyhow::Result<Option<String>> {
        let body = self.client.session_get_context(&self.id).await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("get_context: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(kimi_ui::last_assistant_text(&body["result"]))
    }

    /// The session's context (history + token count).
    pub async fn get_context(&mut self) -> serde_json::Value {
        self.client.session_get_context(&self.id).await
    }

    /// The session's status snapshot.
    pub async fn get_status(&mut self) -> serde_json::Value {
        self.client.session_get_status(&self.id).await
    }

    /// Run a shell command in the session workspace.
    pub async fn run_shell(&mut self, command: &str) -> serde_json::Value {
        self.client.session_run_shell(&self.id, command).await
    }

    /// Request cancellation of a running turn.
    pub async fn cancel(&mut self) -> serde_json::Value {
        self.client.session_cancel(&self.id).await
    }

    /// Persist the session to the store (engine-side `session/save`).
    pub async fn save(&mut self) -> anyhow::Result<()> {
        let body = self
            .client
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
        let body = self.client.call(method, params).await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("goal change: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"].clone())
    }

    /// Toggle plan mode on the session.
    pub async fn set_plan_mode(&mut self, enabled: bool) -> anyhow::Result<()> {
        self.mode_toggle(kimi_protocol::methods::SESSION_SET_PLAN_MODE, enabled).await
    }

    /// Toggle swarm mode on the session. `trigger` is one of `manual` (the
    /// persistent toggle, default), `task` (one-shot prompt), or `tool`
    /// (silent); ignored on disable. Mirrors the SDK's
    /// `Session.setSwarmMode(enabled, trigger)`.
    pub async fn set_swarm_mode(&mut self, enabled: bool, trigger: Option<&str>) -> anyhow::Result<()> {
        let mut params = serde_json::json!({ "session_id": self.id, "enabled": enabled });
        if let Some(trigger) = trigger {
            params["trigger"] = serde_json::json!(trigger);
        }
        let body = self
            .client
            .call(kimi_protocol::methods::SESSION_SET_SWARM_MODE, params)
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("set swarm mode: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(())
    }

    /// Set the thinking effort (`low` / `medium` / `high`, or `None` to clear).
    pub async fn set_thinking(&mut self, effort: Option<&str>) -> anyhow::Result<()> {
        let mut params = serde_json::json!({ "session_id": self.id });
        if let Some(effort) = effort {
            params["effort"] = serde_json::json!(effort);
        }
        let body = self.client.call(kimi_protocol::methods::SESSION_SET_THINKING, params).await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("set thinking: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(())
    }

    /// Set the process-wide permission mode (`manual` / `plan` / `ask` /
    /// `yolo`). Mirrors the SDK's `Session.setPermission`.
    pub async fn set_permission(&mut self, mode: &str) -> anyhow::Result<()> {
        let body = self
            .client
            .call(
                kimi_protocol::methods::PERMISSION_SET_MODE,
                serde_json::json!({ "mode": mode }),
            )
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("set permission: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(())
    }

    /// Undo the last `count` turns (default 1); returns the undo result body.
    /// Mirrors the SDK's `Session.undoHistory(count)`.
    pub async fn undo_history(&mut self, count: u32) -> anyhow::Result<serde_json::Value> {
        let body = self
            .client
            .call(
                kimi_protocol::methods::SESSION_UNDO_HISTORY,
                serde_json::json!({ "session_id": self.id, "count": count }),
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
    /// Fork this session. `title` and `turn_index` are optional: with a
    /// `turn_index`, the fork keeps only the conversation up to and including
    /// that 0-based turn (each user-originated message starts a turn), and
    /// the fork starts with the active goal flagged — mirroring the SDK's
    /// `Session.fork({ title?, turnIndex? })`.
    pub async fn fork(
        &mut self,
        fork_id: &str,
        title: Option<&str>,
        turn_index: Option<i64>,
    ) -> anyhow::Result<()> {
        let mut params = serde_json::json!({ "session_id": self.id, "fork_id": fork_id });
        if let Some(title) = title {
            params["title"] = serde_json::json!(title);
        }
        if let Some(index) = turn_index {
            params["turn_index"] = serde_json::json!(index);
        }
        let body = self.client.call(kimi_protocol::methods::SESSION_FORK, params).await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("fork: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(())
    }

    /// Append an imported transcript chunk to the session context.
    pub async fn import_context(&mut self, content: &str, source: &str) -> anyhow::Result<()> {
        let body = self
            .client
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

    /// Activate a skill (renders the skill prompt + runs a turn — requires a
    /// reachable LLM). Unknown skills error before any turn.
    pub async fn activate_skill(&mut self, name: &str, args: serde_json::Value) -> anyhow::Result<serde_json::Value> {
        let body = self
            .client
            .call(
                kimi_protocol::methods::SESSION_ACTIVATE_SKILL,
                serde_json::json!({ "session_id": self.id, "name": name, "args": args }),
            )
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("activate_skill: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"].clone())
    }

    /// Registered MCP servers for the session.
    pub async fn list_mcp_servers(&mut self) -> anyhow::Result<serde_json::Value> {
        self.simple_call(kimi_protocol::methods::SESSION_LIST_MCP_SERVERS).await
    }

    /// MCP startup metrics (warn/error counts) for the session.
    pub async fn get_mcp_startup_metrics(&mut self) -> anyhow::Result<serde_json::Value> {
        self.simple_call(kimi_protocol::methods::SESSION_GET_MCP_STARTUP_METRICS).await
    }

    /// Reconnect a named MCP server (re-runs its startup).
    pub async fn reconnect_mcp_server(&mut self, name: &str) -> anyhow::Result<serde_json::Value> {
        let body = self
            .client
            .call(
                kimi_protocol::methods::SESSION_RECONNECT_MCP_SERVER,
                serde_json::json!({ "session_id": self.id, "name": name }),
            )
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("reconnect_mcp_server: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"].clone())
    }

    /// Session warnings (e.g. failed MCP servers).
    pub async fn get_warnings(&mut self) -> anyhow::Result<serde_json::Value> {
        self.simple_call(kimi_protocol::methods::SESSION_GET_WARNINGS).await
    }

    /// Tools available to the session.
    pub async fn list_tools(&mut self) -> anyhow::Result<serde_json::Value> {
        self.simple_call(kimi_protocol::methods::SESSION_LIST_TOOLS).await
    }

    /// Add an additional workspace directory to the session sandbox.
    pub async fn add_additional_dir(&mut self, path: &str) -> anyhow::Result<serde_json::Value> {
        self.dir_change(kimi_protocol::methods::SESSION_ADD_DIR, path).await
    }

    /// Remove an additional workspace directory from the session sandbox.
    pub async fn remove_additional_dir(&mut self, path: &str) -> anyhow::Result<serde_json::Value> {
        self.dir_change(kimi_protocol::methods::SESSION_REMOVE_DIR, path).await
    }

    async fn dir_change(&mut self, method: &str, path: &str) -> anyhow::Result<serde_json::Value> {
        let body = self
            .client
            .call(method, serde_json::json!({ "session_id": self.id, "path": path }))
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("{method}: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"].clone())
    }

    /// Shallow-merge custom metadata into the session's persisted record.
    pub async fn update_metadata(&mut self, metadata: serde_json::Value) -> anyhow::Result<serde_json::Value> {
        let body = self
            .client
            .call(
                kimi_protocol::methods::SESSION_UPDATE_METADATA,
                serde_json::json!({ "session_id": self.id, "metadata": metadata }),
            )
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("update_metadata: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"].clone())
    }

    /// Persist a new session title (`session/rename` parity).
    pub async fn rename(&mut self, title: &str) -> anyhow::Result<serde_json::Value> {
        let body = self
            .client
            .call(
                kimi_protocol::methods::SESSION_RENAME,
                serde_json::json!({ "session_id": self.id, "title": title }),
            )
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("rename: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"].clone())
    }

    /// Clear the active plan.
    pub async fn clear_plan(&mut self) -> anyhow::Result<serde_json::Value> {
        self.simple_call(kimi_protocol::methods::SESSION_CLEAR_PLAN).await
    }

    /// Tear the session down (releases engine-side state).
    pub async fn destroy(&mut self) -> anyhow::Result<serde_json::Value> {
        self.simple_call(kimi_protocol::methods::SESSION_DESTROY).await
    }

    /// Run the engine's AGENTS.md initialization for the session workspace.
    pub async fn init(&mut self) -> anyhow::Result<()> {
        let body = self
            .client
            .call(kimi_protocol::methods::SESSION_INIT, serde_json::json!({ "session_id": self.id }))
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("init: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(())
    }

    /// Cancel a running shell command by its id.
    pub async fn cancel_shell_command(&mut self, command_id: &str) -> anyhow::Result<serde_json::Value> {
        let body = self
            .client
            .call(
                kimi_protocol::methods::SESSION_CANCEL_SHELL_COMMAND,
                serde_json::json!({ "session_id": self.id, "command_id": command_id }),
            )
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("cancel_shell_command: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"].clone())
    }

    /// List background tasks (live + persisted ghosts). Mirrors the SDK's
    /// `Session.listBackgroundTasks`.
    pub async fn list_background_tasks(&mut self) -> serde_json::Value {
        self.client
            .call(kimi_protocol::methods::BG_LIST, serde_json::Value::Null)
            .await
    }

    /// Output snapshot for a background task. Mirrors
    /// `Session.getBackgroundTaskOutput`.
    pub async fn get_background_task_output(&mut self, task_id: &str) -> serde_json::Value {
        self.client
            .call(
                kimi_protocol::methods::BG_OUTPUT,
                serde_json::json!({ "task_id": task_id }),
            )
            .await
    }

    /// Stop a background task. Mirrors `Session.stopBackgroundTask`.
    pub async fn stop_background_task(
        &mut self,
        task_id: &str,
        reason: Option<&str>,
    ) -> serde_json::Value {
        let mut params = serde_json::json!({ "task_id": task_id });
        if let Some(reason) = reason {
            params["reason"] = serde_json::json!(reason);
        }
        self.client
            .call(kimi_protocol::methods::BG_STOP, params)
            .await
    }

    /// Detach a background task, returning its info. Mirrors
    /// `Session.detachBackgroundTask`.
    pub async fn detach_background_task(&mut self, task_id: &str) -> serde_json::Value {
        self.client
            .call(
                kimi_protocol::methods::BG_DETACH,
                serde_json::json!({ "task_id": task_id }),
            )
            .await
    }

    /// Scheduled cron tasks (snapshot view). Mirrors node-sdk
    /// `Session.getCronTasks`.
    pub async fn list_cron_tasks(&mut self) -> serde_json::Value {
        self.client
            .call(kimi_protocol::methods::CRON_LIST, serde_json::Value::Null)
            .await
    }

    /// Create a scheduled cron task; returns its id.
    pub async fn create_cron_task(
        &mut self,
        cron: &str,
        prompt: &str,
        recurring: bool,
    ) -> serde_json::Value {
        self.client
            .call(
                kimi_protocol::methods::CRON_CREATE,
                serde_json::json!({ "cron": cron, "prompt": prompt, "recurring": recurring }),
            )
            .await
    }

    /// Delete cron tasks by id; returns how many were removed.
    pub async fn delete_cron_tasks(&mut self, ids: Vec<String>) -> serde_json::Value {
        self.client
            .call(
                kimi_protocol::methods::CRON_DELETE,
                serde_json::json!({ "ids": ids }),
            )
            .await
    }

    async fn simple_call(&mut self, method: &str) -> anyhow::Result<serde_json::Value> {
        let body = self
            .client
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
