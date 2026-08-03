//! Plugin method family — the read surface for installed plugins
//! (SDK listPlugins / getPluginInfo parity), ported from main.rs.

use std::sync::Arc;

use kimi_agent::plugin::store::PluginStore;
use kimi_protocol::rpc::JsonRpcError;
use kimi_protocol::wire_types::{
    PluginInfoRpc, PluginListResult, PluginMcpServerInfoRpc, PluginSummaryRpc,
};

use crate::processor::{MessageProcessor, Processor};

/// Plugin methods, backed by the engine's `PluginStore`.
pub struct PluginProcessor {
    store: Arc<PluginStore>,
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
        Ok(Self { store })
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
    }
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
}
