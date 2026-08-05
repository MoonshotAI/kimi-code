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
    client: Arc<AppServerClient>,
    /// Engine event stream (embedded EventBus / remote captured stderr).
    events: Arc<Mutex<Option<kimi_ui::EventSource>>>,
    /// Whether to inject the engine's config native LLM into created sessions.
    /// Disabled when an explicit llm step is supplied (tests/hosts override
    /// the engine config).
    config_llm: bool,
}

impl Harness {
    /// Open an engine embedded in this process.
    pub fn embedded() -> anyhow::Result<Self> {
        Self::embedded_with_llm_step(None)
    }

    /// Open an engine embedded in this process with an optional LLM step
    /// override (SDK runtime-test hook; mirrors TS `createKimiHarness`'s
    /// `llmStep`). When set, real prompt turns run offline against it.
    pub fn embedded_with_llm_step(
        llm_step: Option<kimi_server::callbacks::LlmStep>,
    ) -> anyhow::Result<Self> {
        let has_step = llm_step.is_some();
        let server = match llm_step {
            Some(step) => kimi_server::Server::build_with_llm_step(step)?,
            None => kimi_server::Server::build()?,
        };
        Ok(Self {
            events: Arc::new(Mutex::new(Some(kimi_ui::EventSource::from_bus(
                server.state.subscribe_events(),
            )))),
            client: Arc::new(AppServerClient::InProcess(
                kimi_server::in_process::spawn(server.processor),
            )),
            config_llm: !has_step,
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
            client: Arc::new(AppServerClient::Remote(Box::new(client))),
            config_llm: true,
        })
    }

    /// The engine event stream (poll with `EventSource::next`), if the
    /// transport provides one.
    pub async fn events(
        &self,
    ) -> tokio::sync::MutexGuard<'_, Option<kimi_ui::EventSource>> {
        self.events.lock().await
    }

    /// The protocol client — shared, so concurrent calls (a prompt turn and a
    /// `session/cancel` racing it) reach the engine without a caller-owned lock.
    pub fn client(&self) -> &AppServerClient {
        &self.client
    }

    /// Engine health (`ok` on success).
    pub async fn health(&self) -> anyhow::Result<String> {
        let body = self.client.health().await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("health: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"]["status"].as_str().unwrap_or("?").to_string())
    }

    /// The engine's version string (from `agent/version`).
    pub async fn core_version(&self) -> anyhow::Result<String> {
        let body = self
            .client
            .call("agent/version", serde_json::Value::Null)
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("version: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"]["version"].as_str().unwrap_or("?").to_string())
    }

    /// Create (or resume) a session by id and return a typed handle. The
    /// engine's native LLM config (config.toml / KIMI_MODEL_* env) is
    /// injected automatically when present and no explicit llm step was
    /// supplied, so hosts that do not pass one explicitly still reach a real
    /// LLM.
    pub async fn create_session(&self, session_id: &str) -> anyhow::Result<Session> {
        let mut params = serde_json::json!({ "session_id": session_id });
        if self.config_llm {
            if let Some(nllm) = kimi_agent::config::native_llm::load_native_llm_from_config() {
                if let Ok(value) = serde_json::to_value(&nllm) {
                    params["native_llm"] = value;
                }
            }
        }
        let body = self.client.call(kimi_protocol::methods::SESSION_CREATE, params).await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("create session: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(Session::new(session_id.to_string(), self.client.clone()))
    }

    /// Close a session: persist it and release its handler state (node-sdk
    /// `closeSession` parity — the record is kept on disk).
    pub async fn close_session(&self, session_id: &str) -> anyhow::Result<()> {
        let mut session = Session::new(session_id.to_string(), self.client.clone());
        session.save().await
    }

    /// Fork a persisted session under a new id (node-sdk `forkSession`
    /// parity) and return a typed handle to the fork. Optional `turn_index`
    /// keeps only the conversation up to and including that 0-based turn.
    pub async fn fork_session(
        &self,
        source_id: &str,
        fork_id: &str,
        turn_index: Option<i64>,
    ) -> anyhow::Result<Session> {
        let mut source = Session::new(source_id.to_string(), self.client.clone());
        source.fork(fork_id, None, turn_index).await?;
        Ok(Session::new(fork_id.to_string(), self.client.clone()))
    }

    /// Persist a new session title (node-sdk `renameSession` parity).
    pub async fn rename_session(&self, session_id: &str, title: &str) -> anyhow::Result<()> {
        let mut session = Session::new(session_id.to_string(), self.client.clone());
        session.rename(title).await?;
        Ok(())
    }

    /// Persisted sessions (newest first), as their summary objects.
    pub async fn list_sessions(&self, limit: u32) -> anyhow::Result<Vec<serde_json::Value>> {
        let body = self.client.session_list(limit).await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("list sessions: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"]["sessions"].as_array().cloned().unwrap_or_default())
    }

    /// The engine's parsed config.
    pub async fn config(&self) -> anyhow::Result<serde_json::Value> {
        let body = self.client.config_get().await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("config: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"].clone())
    }

    /// Apply a config patch (nested object; `null` deletes keys), merged over
    /// the loaded config and persisted. Resolves with the write result
    /// (`{ ok, path }`); read the merged config back via `config()`.
    pub async fn set_config(&self, patch: serde_json::Value) -> anyhow::Result<serde_json::Value> {
        let body = self
            .client
            .call(kimi_protocol::methods::CONFIG_SET, serde_json::json!({ "patch": patch }))
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("set config: {}", error["message"].as_str().unwrap_or("unknown"));
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
        let body = self.client.approval_list(session_id).await;
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
        let body = self.client.approval_resolve(id, allow, reason).await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("approval resolve: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"]["resolved"].as_bool().unwrap_or(false))
    }

    /// One-shot: create (or resume) a session, run a prompt, and return the
    /// last assistant transcript — the SDK's `print` equivalent. Requires a
    /// reachable LLM (engine-side config).
    pub async fn run_prompt(&self, session_id: &str, text: &str) -> anyhow::Result<String> {
        let mut session = self.create_session(session_id).await?;
        // Resume an existing session: create rebuilds a fresh agent, load
        // re-applies the persisted context + goal (no-op for new sessions).
        let _ = session.load().await;
        let result = session.prompt(text).await;
        if let Some(error) = result.get("error") {
            anyhow::bail!("run_prompt: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(session
            .transcript()
            .await?
            .unwrap_or_else(|| result.to_string()))
    }

    /// Run a prompt and capture the `llm.delta` text chunks streamed by the
    /// engine during the turn, in order. Returns the full assistant transcript
    /// plus the delta sequence (for hosts that want chunk-granular updates,
    /// e.g. the ACP adapter's `agent_message_chunk` notifications).
    pub async fn run_prompt_stream(
        &self,
        session_id: &str,
        text: &str,
    ) -> anyhow::Result<(String, Vec<String>)> {
        // Bound the whole turn so a stuck event-source consumer (e.g. a
        // Remote harness whose stderr fan-out stalls) cannot hang the caller.
        let fut = self.run_prompt_stream_inner(session_id, text);
        tokio::pin!(fut);
        match tokio::time::timeout(
            std::time::Duration::from_secs(3600),
            &mut fut,
        )
        .await
        {
            Ok(res) => res,
            Err(_) => anyhow::bail!("run_prompt_stream timed out after 1 hour"),
        }
    }

    async fn run_prompt_stream_inner(
        &self,
        session_id: &str,
        text: &str,
    ) -> anyhow::Result<(String, Vec<String>)> {
        let mut session = self.create_session(session_id).await?;
        let _ = session.load().await;
        // Drain the shared event source for llm.delta text chunks while the
        // prompt turn runs. The guard is held for the whole turn — acceptable
        // here because the ACP serve loop is single-threaded per connection.
        let mut guard = self.events.lock().await;
        let source = guard.as_mut().ok_or_else(|| {
            anyhow::anyhow!("no event source available for streaming")
        })?;
        let mut deltas: Vec<String> = Vec::new();
        let prompt_result = {
            let prompt_fut = session.prompt(text);
            tokio::pin!(prompt_fut);
            loop {
                tokio::select! {
                    result = &mut prompt_fut => break result,
                    event = source.next() => {
                        match event {
                            Some(e) if e["type"] == "llm.delta" => {
                                if let Some(delta) = e["part"]["text"].as_str() {
                                    if !delta.is_empty() {
                                        deltas.push(delta.to_string());
                                    }
                                }
                            }
                            Some(_) => {}
                            None => break serde_json::Value::Null,
                        }
                    }
                }
            }
        };
        if let Some(error) = prompt_result.get("error") {
            anyhow::bail!("run_prompt: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        drop(guard);
        let full_text = session.transcript().await?.unwrap_or_default();
        Ok((full_text, deltas))
    }

    /// Installed plugins (summary objects) — the engine side of node-sdk
    /// `listPlugins`.
    pub async fn list_plugins(&self) -> anyhow::Result<Vec<serde_json::Value>> {
        let body = self
            .client
            .call(kimi_protocol::methods::PLUGIN_LIST, serde_json::Value::Null)
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("list plugins: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"]["plugins"].as_array().cloned().unwrap_or_default())
    }

    /// One plugin's detail, or `None` when not installed — the engine side of
    /// node-sdk `getPluginInfo`.
    pub async fn get_plugin(&self, id: &str) -> anyhow::Result<Option<serde_json::Value>> {
        let body = self
            .client
            .call(
                kimi_protocol::methods::PLUGIN_GET,
                serde_json::json!({ "id": id }),
            )
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("get plugin: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok((!body["result"].is_null()).then(|| body["result"].clone()))
    }

    /// Install a plugin from a github repo (`owner/repo[@tag]`), a zip URL, or
    /// a local path — the engine side of node-sdk `installPlugin`. Returns the
    /// installed plugin summary.
    pub async fn install_plugin(&self, source: &str) -> anyhow::Result<serde_json::Value> {
        let body = self
            .client
            .call(
                kimi_protocol::methods::PLUGIN_INSTALL,
                serde_json::json!({ "source": source }),
            )
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("install plugin: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"].clone())
    }

    /// Enable or disable an installed plugin — the engine side of node-sdk
    /// `setPluginEnabled`.
    pub async fn set_plugin_enabled(&self, id: &str, enabled: bool) -> anyhow::Result<()> {
        let body = self
            .client
            .call(
                kimi_protocol::methods::PLUGIN_SET_ENABLED,
                serde_json::json!({ "id": id, "enabled": enabled }),
            )
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("set plugin enabled: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(())
    }

    /// Toggle one of a plugin's MCP servers — the engine side of node-sdk
    /// `setPluginMcpServerEnabled`.
    pub async fn set_plugin_mcp_enabled(
        &self,
        id: &str,
        server: &str,
        enabled: bool,
    ) -> anyhow::Result<()> {
        let body = self
            .client
            .call(
                kimi_protocol::methods::PLUGIN_SET_MCP_ENABLED,
                serde_json::json!({ "id": id, "server": server, "enabled": enabled }),
            )
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!(
                "set plugin mcp enabled: {}",
                error["message"].as_str().unwrap_or("unknown")
            );
        }
        Ok(())
    }

    /// Remove an installed plugin — the engine side of node-sdk `removePlugin`.
    pub async fn remove_plugin(&self, id: &str) -> anyhow::Result<bool> {
        let body = self
            .client
            .call(
                kimi_protocol::methods::PLUGIN_REMOVE,
                serde_json::json!({ "id": id }),
            )
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("remove plugin: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(body["result"]["removed"].as_bool().unwrap_or(false))
    }

    /// Reload plugins from disk — the engine side of node-sdk `reloadPlugins`.
    pub async fn reload_plugins(&self) -> anyhow::Result<()> {
        let body = self
            .client
            .call(kimi_protocol::methods::PLUGIN_RELOAD, serde_json::json!({}))
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!("reload plugins: {}", error["message"].as_str().unwrap_or("unknown"));
        }
        Ok(())
    }

    /// A plugin's slash-style commands — the engine side of node-sdk
    /// `listPluginCommands`.
    pub async fn list_plugin_commands(
        &self,
        plugin_id: &str,
    ) -> anyhow::Result<Vec<serde_json::Value>> {
        let body = self
            .client
            .call(
                kimi_protocol::methods::PLUGIN_LIST_COMMANDS,
                serde_json::json!({ "id": plugin_id }),
            )
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!(
                "list plugin commands: {}",
                error["message"].as_str().unwrap_or("unknown")
            );
        }
        Ok(body["result"]["commands"].as_array().cloned().unwrap_or_default())
    }

    /// Activate a plugin command on a session: expands `$ARGUMENTS` in the
    /// command body and sends it as a prompt turn. Requires a reachable LLM.
    /// The engine side of node-sdk `activatePluginCommand`.
    pub async fn activate_plugin_command(
        &self,
        session_id: &str,
        plugin_id: &str,
        command_name: &str,
        args: Option<&str>,
    ) -> anyhow::Result<()> {
        let mut params =
            serde_json::json!({ "session_id": session_id, "plugin_id": plugin_id, "command_name": command_name });
        if let Some(args) = args {
            params["args"] = serde_json::json!(args);
        }
        let body = self
            .client
            .call(kimi_protocol::methods::PLUGIN_ACTIVATE_COMMAND, params)
            .await;
        if let Some(error) = body.get("error") {
            anyhow::bail!(
                "activate plugin command: {}",
                error["message"].as_str().unwrap_or("unknown")
            );
        }
        Ok(())
    }
}
