//! Kimi Code client SDK — the high-level door into a host engine, mirroring
//! node-sdk's `createKimiHarness`. A `Harness` owns an engine (embedded
//! in-process, or a spawned `kimi-server-serve` process) and hands out typed
//! `Session` handles; interface layers (TUI controllers, ACP adapter, future
//! SDK consumers) code against this instead of raw RPC.

pub mod auth;
pub mod catalog;
pub mod config;
pub mod errors;
pub mod mcp_config;
pub mod session;
pub mod skills;

pub use auth::KimiAuth;
pub use session::Session;

use std::collections::HashMap;
use std::sync::Arc;

use base64::Engine;
use kimi_protocol::wire_types::{BoxFuture, ToolExecuteRequest, ToolExecuteResponse};
use kimi_server_client::AppServerClient;
use tokio::sync::Mutex;

/// An approval handler installed via `Session::set_approval_handler` —
/// receives the engine's `session.approval.requested` event payload and
/// resolves with the approval decision body (`{ "decision": "approved" | …,
/// "feedback": … }`), mirroring the TS `ApprovalHandler`.
pub type ApprovalHandler =
    Arc<dyn Fn(serde_json::Value) -> BoxFuture<'static, serde_json::Value> + Send + Sync>;

/// A host-tool handler installed via `Session::set_tool_handler` — receives
/// one engine `host/execute_tool` request and resolves with the engine wire
/// response, mirroring the TS `ToolCallHandler`. Only reachable when the
/// engine is embedded (the stdio transport has no reverse channel).
pub type ToolCallHandler =
    Arc<dyn Fn(ToolExecuteRequest) -> BoxFuture<'static, ToolExecuteResponse> + Send + Sync>;

/// Per-session handler registry (approval + host tools), shared by all
/// sessions of a harness.
#[derive(Default)]
pub(crate) struct HandlerRegistry {
    pub(crate) approvals: HashMap<String, ApprovalHandler>,
    pub(crate) tools: HashMap<String, ToolCallHandler>,
}

/// Shared harness state handed to every `Session` handle — the event
/// broadcast, the handler registry, and the host-tool step handle.
pub(crate) struct HarnessShared {
    pub(crate) events_tx: tokio::sync::broadcast::Sender<serde_json::Value>,
    pub(crate) handlers: Arc<Mutex<HandlerRegistry>>,
    /// Shared host-tool step (embedded engines only); set when a tool handler
    /// is registered, so `ServerHostCallbacks::execute_tool` routes to it.
    pub(crate) tool_step:
        Arc<std::sync::Mutex<Option<kimi_server::callbacks::ToolExecuteStep>>>,
    /// Lazy-spawned approval event loop (one per harness).
    pub(crate) approval_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

/// A live engine-event subscription; dropping it unsubscribes.
pub struct EventSubscription {
    task: Option<tokio::task::JoinHandle<()>>,
}

impl Drop for EventSubscription {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

/// Engine lifecycle + typed session factory.
#[derive(Clone)]
pub struct Harness {
    client: Arc<AppServerClient>,
    /// Engine event fan-out (every subscriber gets every event).
    events_tx: tokio::sync::broadcast::Sender<serde_json::Value>,
    /// Kept alive so the fan-out task keeps forwarding after `Harness` moves.
    _fanout: Arc<tokio::task::JoinHandle<()>>,
    /// Shared per-session state (handlers, tool step, approvals).
    shared: Arc<HarnessShared>,
    /// Kimi home dir for host-side files (`mcp.json`, user skills).
    home_dir: String,
    /// Host-side MCP OAuth flow registry (begin → complete/cancel).
    mcp_flows: Arc<mcp_config::GlobalMcpAuthFlows>,
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
        let (events_tx, _fanout) = spawn_event_fanout(kimi_ui::EventSource::from_bus(
            server.state.subscribe_events(),
        ));
        Ok(Self {
            shared: Arc::new(HarnessShared {
                events_tx: events_tx.clone(),
                handlers: Arc::new(Mutex::new(HandlerRegistry::default())),
                // Embedded engines share the server's tool-step handle, so a
                // registered `set_tool_handler` reaches the engine's
                // `HostCallbacks::execute_tool`.
                tool_step: server.state.tool_step.clone(),
                approval_task: Mutex::new(None),
            }),
            home_dir: config::resolve_kimi_home().unwrap_or_default(),
            mcp_flows: Arc::new(mcp_config::GlobalMcpAuthFlows::new()),
            events_tx,
            _fanout: Arc::new(_fanout),
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
        let (events_tx, _fanout) =
            spawn_event_fanout(kimi_ui::EventSource::from_lines(stderr));
        Ok(Self {
            shared: Arc::new(HarnessShared {
                events_tx: events_tx.clone(),
                handlers: Arc::new(Mutex::new(HandlerRegistry::default())),
                // The stdio transport has no reverse channel, so host tools
                // stay unreachable; the handle is kept for API symmetry.
                tool_step: Arc::new(std::sync::Mutex::new(None)),
                approval_task: Mutex::new(None),
            }),
            home_dir: config::resolve_kimi_home().unwrap_or_default(),
            mcp_flows: Arc::new(mcp_config::GlobalMcpAuthFlows::new()),
            events_tx,
            _fanout: Arc::new(_fanout),
            client: Arc::new(AppServerClient::Remote(Box::new(client))),
            config_llm: true,
        })
    }

    /// Subscribe to the engine event stream. Every subscriber receives every
    /// event (`session.*` / `llm.*` wire shapes); a lagging subscriber
    /// re-syncs instead of terminating.
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<serde_json::Value> {
        self.events_tx.subscribe()
    }

    /// Register an engine-event listener (every event, unfiltered). Returns a
    /// subscription handle; dropping it unsubscribes.
    pub fn on_event(
        &self,
        handler: impl Fn(serde_json::Value) + Send + Sync + 'static,
    ) -> EventSubscription {
        let mut rx = self.events_tx.subscribe();
        let task = tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(event) => handler(event),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        });
        EventSubscription { task: Some(task) }
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
        Ok(Session::new(
            session_id.to_string(),
            self.client.clone(),
            self.shared.clone(),
        ))
    }

    /// Close a session: persist it and release its handler state (node-sdk
    /// `closeSession` parity — the record is kept on disk).
    pub async fn close_session(&self, session_id: &str) -> anyhow::Result<()> {
        let mut session =
            Session::new(session_id.to_string(), self.client.clone(), self.shared.clone());
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
        let mut source =
            Session::new(source_id.to_string(), self.client.clone(), self.shared.clone());
        source.fork(fork_id, None, turn_index).await?;
        Ok(Session::new(
            fork_id.to_string(),
            self.client.clone(),
            self.shared.clone(),
        ))
    }

    /// Persist a new session title (node-sdk `renameSession` parity).
    pub async fn rename_session(&self, session_id: &str, title: &str) -> anyhow::Result<()> {
        let mut session =
            Session::new(session_id.to_string(), self.client.clone(), self.shared.clone());
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
        // Subscribe a private receiver for llm.delta text chunks while the
        // prompt turn runs. Every subscriber gets every event (broadcast), so
        // this never contends with other consumers.
        let mut rx = self.events_tx.subscribe();
        let mut deltas: Vec<String> = Vec::new();
        let prompt_result = {
            let prompt_fut = session.prompt(text);
            tokio::pin!(prompt_fut);
            loop {
                tokio::select! {
                    result = &mut prompt_fut => break result,
                    event = rx.recv() => {
                        match event {
                            Ok(e) if e["type"] == "llm.delta" => {
                                if let Some(delta) = e["part"]["text"].as_str() {
                                    if !delta.is_empty() {
                                        deltas.push(delta.to_string());
                                    }
                                }
                            }
                            Ok(_) => {}
                            Err(_) => break serde_json::Value::Null,
                        }
                    }
                }
            }
        };
        if let Some(error) = prompt_result.get("error") {
            anyhow::bail!("run_prompt: {}", error["message"].as_str().unwrap_or("unknown"));
        }
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

    /// Skills visible to a new session in `work_dir`, without creating that
    /// session — node-sdk `listWorkspaceSkills` parity.
    pub fn list_workspace_skills(&self, work_dir: &str) -> Result<Vec<skills::SkillSummary>, String> {
        skills::list_workspace_skills(work_dir)
    }

    /// Warnings from the most recent config.toml load; empty when the config
    /// is fully valid — node-sdk `getConfigDiagnostics` parity.
    pub fn get_config_diagnostics(&self) -> Vec<String> {
        config::get_config_diagnostics()
    }

    /// Materialize the default config scaffold under the resolved config path
    /// (no-op when the file already exists) — node-sdk `ensureConfigFile`
    /// parity.
    pub fn ensure_config_file(&self) -> Result<(), String> {
        config::ensure_config_file()
    }

    /// Remove a provider section from the config (`null`-patch delete,
    /// persisted) — node-sdk `removeProvider` parity.
    pub async fn remove_provider(&self, provider_id: &str) -> Result<serde_json::Value, String> {
        self.set_config(serde_json::json!({ "providers": { provider_id: null } }))
            .await
            .map_err(|e| e.to_string())
    }

    /// Experimental feature flags. The engine gates flags in config but
    /// exposes no RPC, and the node-sdk surface is a stub returning an empty
    /// list — kept for API parity only.
    pub fn get_experimental_features(&self) -> Vec<String> {
        Vec::new()
    }

    /// The user-global MCP config store (`<KIMI_CODE_HOME>/mcp.json`).
    pub fn mcp_store(&self) -> mcp_config::GlobalMcpConfigStore {
        mcp_config::GlobalMcpConfigStore::new(Some(&self.home_dir))
    }

    /// User-global MCP entries from `<KIMI_CODE_HOME>/mcp.json` only —
    /// node-sdk `listMcpServers` parity.
    pub fn list_mcp_servers(&self) -> Result<Vec<mcp_config::GlobalMcpServerConfig>, String> {
        self.mcp_store().list()
    }

    /// Add a user-global MCP server; errors when the name already exists.
    /// Returns the new full list — node-sdk `addMcpServer` parity.
    pub fn add_mcp_server(
        &self,
        server: mcp_config::GlobalMcpServerConfig,
    ) -> Result<Vec<mcp_config::GlobalMcpServerConfig>, String> {
        self.mcp_store().add(server)
    }

    /// Update a user-global MCP server; errors when absent. Returns the new
    /// full list — node-sdk `updateMcpServer` parity.
    pub fn update_mcp_server(
        &self,
        server: mcp_config::GlobalMcpServerConfig,
    ) -> Result<Vec<mcp_config::GlobalMcpServerConfig>, String> {
        self.mcp_store().update(server)
    }

    /// Remove a user-global MCP server (absent is a no-op). Returns the new
    /// full list — node-sdk `removeMcpServer` parity.
    pub fn remove_mcp_server(&self, name: &str) -> Result<Vec<mcp_config::GlobalMcpServerConfig>, String> {
        self.mcp_store().remove(name)
    }

    /// Begin the OAuth flow for a user-global remote MCP server: returns the
    /// `authorizationUrl` the host should open in a browser — node-sdk
    /// `beginGlobalMcpServerAuth` parity (the host owns the token store).
    pub fn authenticate_mcp_server(
        &self,
        name: &str,
    ) -> Result<mcp_config::BeginGlobalMcpServerAuthResult, String> {
        let server = self.mcp_store().get(name)?;
        self.mcp_flows.begin(&server)
    }

    /// Complete an in-flight MCP OAuth flow (the browser flow finished).
    pub fn complete_mcp_server_auth(&self, flow_id: &str) -> Result<(), String> {
        self.mcp_flows.complete(flow_id)
    }

    /// Cancel an in-flight MCP OAuth flow (idempotent).
    pub fn cancel_mcp_server_auth(&self, flow_id: &str) {
        self.mcp_flows.cancel(flow_id);
    }

    /// Validate a user-global MCP server is remote so the host can expose a
    /// reset/login control (clearing stored credentials is the host's job).
    pub fn reset_mcp_server_auth(&self, name: &str) -> Result<(), String> {
        let server = self.mcp_store().get(name)?;
        self.mcp_flows.reset(&server)
    }

    /// Probe a user-global MCP server (stdio only) and report its discovered
    /// tools — node-sdk `testMcpServer` parity.
    pub async fn test_mcp_server(
        &self,
        name: &str,
    ) -> Result<mcp_config::McpTestResult, String> {
        let server = self.mcp_store().get(name)?;
        mcp_config::test_global_mcp_server(&server).await
    }

    /// Register (or clear, with `None`) the per-session approval handler.
    /// When registered, the harness's shared event loop answers every
    /// `session.approval.requested` event for this session by invoking the
    /// handler and resolving the pending approval with its decision —
    /// mirroring TS `Session.setApprovalHandler`. Transport-independent
    /// (embedded and stdio engines both emit the event).
    pub async fn set_approval_handler(
        &self,
        session_id: &str,
        handler: Option<ApprovalHandler>,
    ) {
        set_approval_handler_impl(&self.client, &self.shared, session_id, handler).await;
    }

    /// Register (or clear, with `None`) the per-session host-tool handler,
    /// mirroring TS `Session.setToolHandler`. Engine `host/execute_tool`
    /// requests route to the registered handler; without one they fail with
    /// the SDK's unsupported-tool result. Only embedded engines can reach the
    /// handler (the stdio transport has no reverse channel), matching the
    /// node-sdk napi-embedded behavior.
    pub async fn set_tool_handler(&self, session_id: &str, handler: Option<ToolCallHandler>) {
        set_tool_handler_impl(&self.shared, session_id, handler).await;
    }
}

/// Register (or clear) a per-session approval handler and ensure the shared
/// approval event loop is running.
pub(crate) async fn set_approval_handler_impl(
    client: &Arc<AppServerClient>,
    shared: &Arc<HarnessShared>,
    session_id: &str,
    handler: Option<ApprovalHandler>,
) {
    {
        let mut registry = shared.handlers.lock().await;
        match handler.as_ref() {
            Some(h) => {
                registry.approvals.insert(session_id.to_string(), h.clone());
            }
            None => {
                registry.approvals.remove(session_id);
            }
        }
    }
    if handler.is_some() {
        ensure_approval_loop_impl(client, shared).await;
    }
}

/// Register (or clear) a per-session host-tool handler and (re)install the
/// routing step so engine `execute_tool` reaches the registry. Embedded
/// engines share the server's handle; remote harnesses keep a private no-op
/// handle (no reverse channel).
pub(crate) async fn set_tool_handler_impl(
    shared: &Arc<HarnessShared>,
    session_id: &str,
    handler: Option<ToolCallHandler>,
) {
    {
        let mut registry = shared.handlers.lock().await;
        match handler.as_ref() {
            Some(h) => {
                registry.tools.insert(session_id.to_string(), h.clone());
            }
            None => {
                registry.tools.remove(session_id);
            }
        }
    }
    let handlers = shared.handlers.clone();
    let step: kimi_server::callbacks::ToolExecuteStep = Arc::new(move |request| {
        let handlers = handlers.clone();
        Box::pin(async move {
            let raw = request.session_id.clone().unwrap_or_default();
            let session_id = normalize_session_id(&raw);
            let handler = handlers.lock().await.tools.get(&session_id).cloned();
            match handler {
                Some(h) => Ok(h(request).await),
                None => Ok(ToolExecuteResponse {
                    content: "SDK custom tool calls are not supported".to_string(),
                    is_error: true,
                    ..Default::default()
                }),
            }
        })
    });
    *shared.tool_step.lock().unwrap() = Some(step);
}

/// Lazy-start the shared approval event loop (one per harness).
pub(crate) async fn ensure_approval_loop_impl(
    client: &Arc<AppServerClient>,
    shared: &Arc<HarnessShared>,
) {
    let mut slot = shared.approval_task.lock().await;
    if slot.is_some() {
        return;
    }
    let client = client.clone();
    let handlers = shared.handlers.clone();
    let mut rx = shared.events_tx.subscribe();
    *slot = Some(tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) if event["type"] == "session.approval.requested" => {
                    let session_id = event["session_id"].as_str().unwrap_or("").to_string();
                    let session_id = normalize_session_id(&session_id);
                    let handler = handlers
                        .lock()
                        .await
                        .approvals
                        .get(&session_id)
                        .cloned();
                    if let Some(handler) = handler {
                        let decision = handler(event.clone()).await;
                        let id = event["approval_id"].as_str().unwrap_or("").to_string();
                        let allow = decision["decision"].as_str() == Some("approved");
                        let reason = decision["feedback"].as_str();
                        let _ = client.approval_resolve(&id, allow, reason).await;
                    }
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    }));
}

/// Map an engine session id back onto its parent session (side-question
/// `btw-<sid>` turns belong to the parent session) — same rule as the TS
/// `dispatchEngineEvent`.
pub(crate) fn normalize_session_id(raw: &str) -> String {
    raw.strip_prefix("btw-").unwrap_or(raw).to_string()
}

/// Spawn a task that forwards a single-consumer `EventSource` onto a
/// broadcast channel, so the harness supports any number of subscribers
/// (`on_event` listeners, `run_prompt_stream`, the approval loop).
fn spawn_event_fanout(
    source: kimi_ui::EventSource,
) -> (
    tokio::sync::broadcast::Sender<serde_json::Value>,
    tokio::task::JoinHandle<()>,
) {
    let (tx, _rx) = tokio::sync::broadcast::channel(256);
    let tx_task = tx.clone();
    let task = tokio::spawn(async move {
        let mut source = source;
        while let Some(event) = source.next().await {
            // No receivers left is not fatal — keep consuming until the
            // source closes.
            let _ = tx_task.send(event);
        }
    });
    (tx, task)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    async fn trigger_goal_updated(harness: &Harness, session_id: &str) {
        // session/load emits a goal.updated event on the harness stream
        // (same trick as the tests/harness.rs integration test).
        harness.create_session(session_id).await.expect("create");
        harness
            .client()
            .call(
                kimi_protocol::methods::SESSION_LOAD,
                serde_json::json!({ "session_id": session_id }),
            )
            .await;
    }

    #[tokio::test]
    async fn broadcast_reaches_all_subscribers() {
        let harness = Harness::embedded().expect("embedded");
        let mut rx1 = harness.subscribe();
        let mut rx2 = harness.subscribe();
        trigger_goal_updated(&harness, "s-bcast").await;
        let e1 = tokio::time::timeout(Duration::from_secs(5), rx1.recv())
            .await
            .expect("subscriber 1 event")
            .expect("stream alive");
        let e2 = tokio::time::timeout(Duration::from_secs(5), rx2.recv())
            .await
            .expect("subscriber 2 event")
            .expect("stream alive");
        assert_eq!(e1["type"], "session.goal.updated", "event: {e1}");
        assert_eq!(e1["type"], e2["type"], "both subscribers see the same event");
    }

    #[tokio::test]
    async fn on_event_callback_receives_events() {
        let harness = Harness::embedded().expect("embedded");
        let seen: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen_task = seen.clone();
        let _sub = harness.on_event(move |event| {
            if let Some(kind) = event["type"].as_str() {
                seen_task.lock().unwrap().push(kind.to_string());
            }
        });
        trigger_goal_updated(&harness, "s-once").await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            seen.lock().unwrap().iter().any(|t| t == "session.goal.updated"),
            "callback saw: {:?}",
            seen.lock().unwrap()
        );
    }

    #[tokio::test]
    async fn session_on_event_filters_by_session_id() {
        let harness = Harness::embedded().expect("embedded");
        let hits: Arc<AtomicUsize> = Arc::new(AtomicUsize::new(0));
        let hits_a = hits.clone();
        let session = harness.create_session("s-filter-a").await.expect("create a");
        let _sub_a = session.on_event(move |event| {
            if event["type"] == "session.goal.updated" {
                hits_a.fetch_add(1, Ordering::SeqCst);
            }
        });
        // A different session's load must not reach session A's listener.
        trigger_goal_updated(&harness, "s-filter-b").await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(hits.load(Ordering::SeqCst), 0, "foreign events filtered out");
        // Session A's own load reaches the listener.
        trigger_goal_updated(&harness, "s-filter-a").await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(hits.load(Ordering::SeqCst), 1, "own event delivered");
    }

    #[tokio::test]
    async fn approval_handler_receives_requested_events() {
        let harness = Harness::embedded().expect("embedded");
        let decisions: Arc<std::sync::Mutex<Vec<String>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let decisions_task = decisions.clone();
        harness
            .set_approval_handler(
                "s-approve",
                Some(Arc::new(move |event| {
                    let decisions = decisions_task.clone();
                    Box::pin(async move {
                        decisions
                            .lock()
                            .unwrap()
                            .push(event["approval_id"].as_str().unwrap_or("").to_string());
                        serde_json::json!({ "decision": "approved", "feedback": "auto" })
                    })
                })),
            )
            .await;
        // Broadcast a synthetic approval request (the engine emits this shape
        // when a gated tool waits for a decision).
        harness
            .events_tx
            .send(serde_json::json!({
                "type": "session.approval.requested",
                "session_id": "s-approve",
                "approval_id": "approval-test-1",
                "tool_call_id": "call_1",
                "tool_name": "Bash",
            }))
            .expect("broadcast");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(
            decisions.lock().unwrap().as_slice(),
            &["approval-test-1".to_string()],
            "handler routed the event"
        );
    }

    #[tokio::test]
    async fn approval_handler_ignores_foreign_sessions() {
        let harness = Harness::embedded().expect("embedded");
        let hits: Arc<AtomicUsize> = Arc::new(AtomicUsize::new(0));
        let hits_task = hits.clone();
        harness
            .set_approval_handler(
                "s-owner",
                Some(Arc::new(move |_event| {
                    let hits = hits_task.clone();
                    Box::pin(async move {
                        hits.fetch_add(1, Ordering::SeqCst);
                        serde_json::json!({ "decision": "denied", "feedback": "nope" })
                    })
                })),
            )
            .await;
        harness
            .events_tx
            .send(serde_json::json!({
                "type": "session.approval.requested",
                "session_id": "s-other",
                "approval_id": "approval-test-2",
            }))
            .expect("broadcast");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(hits.load(Ordering::SeqCst), 0, "other session's request ignored");
    }
}
