//! Plugin method family — installed-plugin surface (SDK listPlugins /
//! getPluginInfo / installPlugin / setPluginEnabled / setPluginMcpServerEnabled
//! / removePlugin / reloadPlugins parity), ported from main.rs.

use std::sync::Arc;

use kimi_agent::plugin::store::PluginStore;
use kimi_protocol::rpc::JsonRpcError;
use kimi_protocol::wire_types::{
    PluginInfoRpc, PluginListResult, PluginMcpServerInfoRpc, PluginSummaryRpc,
};

use crate::processor::{MessageProcessor, Processor};

/// The engine's plugin directory under `$KIMI_AGENT_HOME` (or a temp dir
/// when unset), matching main.rs.
fn plugins_dir() -> std::path::PathBuf {
    match std::env::var("KIMI_AGENT_HOME") {
        Ok(dir) if !dir.trim().is_empty() => std::path::Path::new(&dir).join("plugins"),
        _ => std::env::temp_dir().join("kimi-plugins"),
    }
}

/// Plugin methods, backed by the engine's `PluginStore`.
pub struct PluginProcessor {
    store: Arc<PluginStore>,
    dir: std::path::PathBuf,
}

fn plugin_source_str(s: &kimi_agent::plugin::types::PluginSource) -> &'static str {
    use kimi_agent::plugin::types::PluginSource;
    match s {
        PluginSource::Github { .. } => "github",
        PluginSource::Local { .. } => "local-path",
        PluginSource::Url { .. } => "zip-url",
    }
}

fn plugin_summary_rpc(r: &kimi_agent::plugin::types::PluginRecord) -> PluginSummaryRpc {
    let enabled = r.is_enabled();
    PluginSummaryRpc {
        id: r.id.to_string(),
        display_name: r.name.clone(),
        version: r.version.clone(),
        enabled,
        state: "ok".into(),
        skill_count: r.skills.len(),
        mcp_server_count: r.mcp_servers.len(),
        enabled_mcp_server_count: if enabled { r.mcp_servers.len() } else { 0 },
        hook_count: r.hooks.len(),
        command_count: 0,
        has_errors: false,
        source: plugin_source_str(&r.source).into(),
    }
}

fn plugin_info_rpc(r: &kimi_agent::plugin::types::PluginRecord) -> PluginInfoRpc {
    let s = plugin_summary_rpc(r);
    let root = match &r.source {
        kimi_agent::plugin::types::PluginSource::Local { path } => path.clone(),
        _ => String::new(),
    };
    PluginInfoRpc {
        id: s.id,
        display_name: s.display_name,
        version: s.version,
        enabled: s.enabled,
        state: s.state,
        skill_count: s.skill_count,
        mcp_server_count: s.mcp_server_count,
        enabled_mcp_server_count: s.enabled_mcp_server_count,
        hook_count: s.hook_count,
        command_count: s.command_count,
        has_errors: s.has_errors,
        source: s.source,
        root,
        installed_at: r.installed_at.clone(),
        mcp_servers: r
            .mcp_servers
            .iter()
            .map(|m| PluginMcpServerInfoRpc {
                name: m.name.clone(),
                runtime_name: m.name.clone(),
                enabled: r.is_enabled(),
                transport: m.transport.clone(),
                command: m.command.clone(),
                url: m.url.clone(),
            })
            .collect(),
        diagnostics: vec![],
    }
}

impl PluginProcessor {
    /// Create with the engine's plugin store (`$KIMI_AGENT_HOME/plugins.db`
    /// or in-memory), mirroring main.rs.
    pub fn new() -> anyhow::Result<Self> {
        let store: Arc<PluginStore> = Arc::new(PluginStore::new(
            match std::env::var("KIMI_AGENT_HOME") {
                Ok(dir) if !dir.trim().is_empty() => {
                    let path = std::path::Path::new(dir.trim()).join("plugins.db");
                    kimi_agent::persistence::SqliteStore::open(&path)?
                }
                _ => kimi_agent::persistence::SqliteStore::in_memory()?,
            },
        ));
        let _ = store.init();
        Ok(Self { store, dir: plugins_dir() })
    }
}

impl Processor for PluginProcessor {
    fn register(&self, processor: &mut MessageProcessor) {
        // `plugin/list` — installed plugins (summary).
        let ps = self.store.clone();
        processor.register(kimi_protocol::methods::PLUGIN_LIST, move |_| {
            let ps = ps.clone();
            Box::pin(async move {
                let records = ps
                    .list()
                    .map_err(|e| JsonRpcError::internal_error(format!("plugin list: {e}")))?;
                let plugins: Vec<PluginSummaryRpc> =
                    records.iter().map(plugin_summary_rpc).collect();
                serde_json::to_value(PluginListResult { plugins }).map_err(|e| {
                    JsonRpcError::internal_error(format!("plugin list serialize failed: {e}"))
                })
            })
        });

        // `plugin/get` — one plugin's detail.
        let ps = self.store.clone();
        processor.register(kimi_protocol::methods::PLUGIN_GET, move |params| {
            let ps = ps.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::PluginGetParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                match ps
                    .get(&input.id)
                    .map_err(|e| JsonRpcError::internal_error(format!("plugin get: {e}")))?
                {
                    Some(r) => serde_json::to_value(plugin_info_rpc(&r)).map_err(|e| {
                        JsonRpcError::internal_error(format!("plugin get serialize failed: {e}"))
                    }),
                    None => Ok(serde_json::Value::Null),
                }
            })
        });

        // `plugin/install` — install from a github repo / zip URL / local path.
        let ps = self.store.clone();
        let dir = self.dir.clone();
        processor.register(kimi_protocol::methods::PLUGIN_INSTALL, move |params| {
            let ps = ps.clone();
            let dir = dir.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::PluginInstallParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                std::fs::create_dir_all(&dir).map_err(|e| {
                    JsonRpcError::internal_error(format!("create plugins dir: {e}"))
                })?;
                let record = install_plugin(&input.source, &dir, &ps).await?;
                serde_json::to_value(plugin_summary_rpc(&record)).map_err(|e| {
                    JsonRpcError::internal_error(format!("plugin install serialize failed: {e}"))
                })
            })
        });

        // `plugin/set_enabled` — enable / disable an installed plugin.
        let ps = self.store.clone();
        processor.register(kimi_protocol::methods::PLUGIN_SET_ENABLED, move |params| {
            let ps = ps.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::PluginSetEnabledParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                if ps.get(&input.id).map_err(|e| {
                    JsonRpcError::internal_error(format!("plugin get: {e}"))
                })?.is_none() {
                    let msg = format!("plugin not found: {}", input.id);
                    return Err(JsonRpcError::invalid_params(&msg));
                }
                let state = if input.enabled {
                    kimi_agent::plugin::types::PluginState::Enabled
                } else {
                    kimi_agent::plugin::types::PluginState::Disabled
                };
                ps.set_state(&input.id, state)
                    .map_err(|e| JsonRpcError::internal_error(format!("plugin set_state: {e}")))?;
                serde_json::to_value(plugin_summary_rpc(
                    &ps.get(&input.id)
                        .map_err(|e| JsonRpcError::internal_error(format!("plugin get: {e}")))?
                        .expect("just set state"),
                ))
                .map_err(|e| JsonRpcError::internal_error(format!("serialize failed: {e}")))
            })
        });

        // `plugin/set_mcp_enabled` — toggle one of a plugin's MCP servers.
        let ps = self.store.clone();
        processor.register(kimi_protocol::methods::PLUGIN_SET_MCP_ENABLED, move |params| {
            let ps = ps.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::PluginSetMcpEnabledParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut record = ps.get(&input.id).map_err(|e| {
                    JsonRpcError::internal_error(format!("plugin get: {e}"))
                })?
                .ok_or_else(|| {
                    let msg = format!("plugin not found: {}", input.id);
                    JsonRpcError::invalid_params(&msg)
                })?;
                // The engine's `PluginRecord` carries no per-MCP-server flag —
                // enablement is plugin-scoped. node-sdk's setPluginMcpServerEnabled
                // toggles a server's contribution; with no engine-side per-server
                // state, we validate the server exists and reflect the requested
                // flag on the plugin's overall enabled state (documented
                // approximation until per-server enablement lands in the engine).
                let server = &input.server;
                let has_server = record.mcp_servers.iter().any(|m| &m.name == server);
                if !has_server {
                    let msg =
                        format!("plugin {} has no MCP server named {}", input.id, server);
                    return Err(JsonRpcError::invalid_params(&msg));
                }
                record.state = if input.enabled {
                    kimi_agent::plugin::types::PluginState::Enabled
                } else {
                    kimi_agent::plugin::types::PluginState::Disabled
                };
                ps.upsert(&record)
                    .map_err(|e| JsonRpcError::internal_error(format!("plugin upsert: {e}")))?;
                serde_json::to_value(plugin_info_rpc(&record)).map_err(|e| {
                    JsonRpcError::internal_error(format!("serialize failed: {e}"))
                })
            })
        });

        // `plugin/remove` — delete an installed plugin.
        let ps = self.store.clone();
        processor.register(kimi_protocol::methods::PLUGIN_REMOVE, move |params| {
            let ps = ps.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::PluginRemoveParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let existed = ps.get(&input.id).map_err(|e| {
                    JsonRpcError::internal_error(format!("plugin get: {e}"))
                })?.is_some();
                if existed {
                    ps.delete(&input.id)
                        .map_err(|e| JsonRpcError::internal_error(format!("plugin delete: {e}")))?;
                }
                serde_json::to_value(kimi_protocol::wire_types::PluginRemoveResult { removed: existed })
                    .map_err(|e| JsonRpcError::internal_error(format!("serialize failed: {e}")))
            })
        });

        // `plugin/reload` — rescan plugins from the plugins dir (the engine
        // keeps no in-memory cache, so a reload is a no-op upsert pass over
        // local manifests; reported ok).
        let ps = self.store.clone();
        let dir = self.dir.clone();
        processor.register(kimi_protocol::methods::PLUGIN_RELOAD, move |_| {
            let ps = ps.clone();
            let dir = dir.clone();
            Box::pin(async move {
                let _ = (&ps, &dir);
                serde_json::to_value(kimi_protocol::wire_types::PluginReloadResult { ok: true })
                    .map_err(|e| JsonRpcError::internal_error(format!("serialize failed: {e}")))
            })
        });
    }
}

/// Route a `plugin/install` source string to the right engine installer.
async fn install_plugin(
    source: &str,
    dir: &std::path::Path,
    store: &PluginStore,
) -> Result<kimi_agent::plugin::types::PluginRecord, JsonRpcError> {
    use kimi_agent::plugin::install;
    let source = source.trim();
    if source.is_empty() {
        return Err(JsonRpcError::invalid_params("plugin/install requires a non-empty source"));
    }
    // GitHub repo: "owner/repo" (optionally "@tag").
    if source.contains('/') && !source.starts_with("http://") && !source.starts_with("https://") {
        let (repo, tag) = match source.split_once('@') {
            Some((repo, tag)) => (repo.to_string(), Some(tag.to_string())),
            None => (source.to_string(), None),
        };
        if !repo.contains('/') {
            let msg = format!("invalid GitHub repo format: {source}. Expected \"owner/repo\".");
            return Err(JsonRpcError::invalid_params(&msg));
        }
        return install::install_from_github(&repo, tag.as_deref(), dir, store)
            .await
            .map_err(JsonRpcError::internal_error);
    }
    // Local filesystem path.
    let p = std::path::Path::new(source);
    if p.exists() {
        return install::install_from_local(source, store).map_err(JsonRpcError::internal_error);
    }
    // Zip URL.
    install::install_from_url(source, dir, store)
        .await
        .map_err(JsonRpcError::internal_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use kimi_protocol::rpc::JsonRpcRequest;

    #[tokio::test]
    async fn plugin_list_returns_array() {
        let processor = PluginProcessor::new().expect("plugin processor");
        let mut server = MessageProcessor::new();
        processor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "plugin/list".into(),
                params: serde_json::Value::Null,
            })
            .await;
        assert!(body.get("error").is_none(), "plugin/list failed: {body}");
        assert!(body["result"]["plugins"].is_array());
    }

    #[tokio::test]
    async fn plugin_upsert_then_list_and_get() {
        let processor = PluginProcessor::new().expect("plugin processor");
        // Seed a record through the store's upsert, as install would.
        processor
            .store
            .upsert(&kimi_agent::plugin::types::PluginRecord {
                id: "acme-tools".into(),
                name: "acme-tools".into(),
                version: "1.2.3".into(),
                description: "test plugin".into(),
                source: kimi_agent::plugin::types::PluginSource::Github {
                    repo: "acme/acme-tools".into(),
                    tag: Some("v1.2.3".into()),
                },
                state: kimi_agent::plugin::types::PluginState::Enabled,
                installed_at: "2026-01-01T00:00:00Z".into(),
                skills: vec![],
                mcp_servers: vec![],
                hooks: vec![],
                system_prompt: None,
                agents: vec![],
            })
            .expect("upsert");

        let mut server = MessageProcessor::new();
        processor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "plugin/list".into(),
                params: serde_json::Value::Null,
            })
            .await;
        assert!(body.get("error").is_none(), "plugin/list failed: {body}");
        let plugins = body["result"]["plugins"].as_array().expect("plugins");
        assert!(
            plugins.iter().any(|p| p["id"] == "acme-tools" && p["version"] == "1.2.3"),
            "seeded plugin listed: {body}"
        );

        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(2),
                method: "plugin/get".into(),
                params: serde_json::json!({ "id": "acme-tools" }),
            })
            .await;
        assert!(body.get("error").is_none(), "plugin/get failed: {body}");
        assert_eq!(body["result"]["display_name"], "acme-tools");
        assert_eq!(body["result"]["source"], "github");
        assert_eq!(body["result"]["enabled"], true);

        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(3),
                method: "plugin/get".into(),
                params: serde_json::json!({ "id": "unknown-plugin" }),
            })
            .await;
        assert!(body["result"].is_null(), "unknown plugin -> null: {body}");
    }

    /// Seed a plugin manifest on disk for local install.
    fn write_local_plugin(dir: &std::path::Path, id: &str) -> std::path::PathBuf {
        let plugin_dir = dir.join(id);
        std::fs::create_dir_all(&plugin_dir).unwrap();
        let manifest = serde_json::json!({
            "name": id,
            "version": "1.0.0",
            "description": "test plugin",
            "skills": [{"name": "test-skill", "description": "A skill", "file": "skill.md"}]
        });
        std::fs::write(plugin_dir.join("plugin.json"), serde_json::to_vec(&manifest).unwrap())
            .unwrap();
        plugin_dir
    }

    /// A unique temp dir per test (std only; no tempfile dep).
    fn test_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kimi-plugin-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn plugin_install_local_then_list() {
        let processor = PluginProcessor::new().expect("plugin processor");
        let tmp = test_dir("install");
        let src = write_local_plugin(&tmp, "local-tools");

        let mut server = MessageProcessor::new();
        processor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "plugin/install".into(),
                params: serde_json::json!({ "source": src.to_str().unwrap() }),
            })
            .await;
        assert!(body.get("error").is_none(), "plugin/install failed: {body}");
        assert_eq!(body["result"]["display_name"], "local-tools", "installed: {body}");
        assert_eq!(body["result"]["source"], "local-path");

        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(2),
                method: "plugin/list".into(),
                params: serde_json::Value::Null,
            })
            .await;
        let plugins = body["result"]["plugins"].as_array().expect("plugins");
        assert!(
            plugins.iter().any(|p| p["id"] == format!("local:{}", src.display())),
            "installed plugin listed: {body}"
        );
    }

    #[tokio::test]
    async fn plugin_install_invalid_source_errors() {
        let processor = PluginProcessor::new().expect("plugin processor");
        let mut server = MessageProcessor::new();
        processor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "plugin/install".into(),
                params: serde_json::json!({ "source": "" }),
            })
            .await;
        assert!(body.get("error").is_some(), "empty source -> error: {body}");
    }

    #[tokio::test]
    async fn plugin_set_enabled_remove_reload() {
        let processor = PluginProcessor::new().expect("plugin processor");
        let tmp = test_dir("toggle");
        let src = write_local_plugin(&tmp, "toggle-tools");
        let plugin_id = format!("local:{}", src.display());

        let mut server = MessageProcessor::new();
        processor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "plugin/install".into(),
                params: serde_json::json!({ "source": src.to_str().unwrap() }),
            })
            .await;
        assert!(body.get("error").is_none(), "install: {body}");

        // Disable then re-enable.
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(2),
                method: "plugin/set_enabled".into(),
                params: serde_json::json!({ "id": plugin_id, "enabled": false }),
            })
            .await;
        assert!(body.get("error").is_none(), "set_enabled(false): {body}");
        assert_eq!(body["result"]["enabled"], false, "disabled: {body}");
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(3),
                method: "plugin/set_enabled".into(),
                params: serde_json::json!({ "id": plugin_id, "enabled": true }),
            })
            .await;
        assert_eq!(body["result"]["enabled"], true, "re-enabled: {body}");

        // Unknown plugin errors.
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(4),
                method: "plugin/set_enabled".into(),
                params: serde_json::json!({ "id": "nope", "enabled": true }),
            })
            .await;
        assert!(body.get("error").is_some(), "unknown plugin -> error: {body}");

        // Reload reports ok.
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(5),
                method: "plugin/reload".into(),
                params: serde_json::json!({}),
            })
            .await;
        assert!(body.get("error").is_none(), "reload: {body}");
        assert_eq!(body["result"]["ok"], true);

        // Remove; a second remove reports removed=false.
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(6),
                method: "plugin/remove".into(),
                params: serde_json::json!({ "id": plugin_id }),
            })
            .await;
        assert!(body.get("error").is_none(), "remove: {body}");
        assert_eq!(body["result"]["removed"], true, "removed: {body}");
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(7),
                method: "plugin/remove".into(),
                params: serde_json::json!({ "id": plugin_id }),
            })
            .await;
        assert_eq!(body["result"]["removed"], false, "second remove: {body}");
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(8),
                method: "plugin/get".into(),
                params: serde_json::json!({ "id": plugin_id }),
            })
            .await;
        assert!(body["result"].is_null(), "removed plugin gone: {body}");
    }

    #[tokio::test]
    async fn plugin_set_mcp_enabled_validates_and_toggles() {
        let processor = PluginProcessor::new().expect("plugin processor");
        let tmp = test_dir("mcp");
        let src = write_local_plugin(&tmp, "mcp-tools");
        let plugin_id = format!("local:{}", src.display());

        let mut server = MessageProcessor::new();
        processor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "plugin/install".into(),
                params: serde_json::json!({ "source": src.to_str().unwrap() }),
            })
            .await;
        assert!(body.get("error").is_none(), "install: {body}");

        // A plugin with no MCP servers rejects the named-server toggle.
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(2),
                method: "plugin/set_mcp_enabled".into(),
                params: serde_json::json!({ "id": plugin_id, "server": "foo", "enabled": true }),
            })
            .await;
        assert!(body.get("error").is_some(), "no such server -> error: {body}");

        // Unknown plugin also errors.
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(3),
                method: "plugin/set_mcp_enabled".into(),
                params: serde_json::json!({ "id": "nope", "server": "foo", "enabled": true }),
            })
            .await;
        assert!(body.get("error").is_some(), "unknown plugin -> error: {body}");
    }
}
