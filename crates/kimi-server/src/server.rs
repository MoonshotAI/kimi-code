//! Server assembly — build the shared state and register every method
//! family onto one `MessageProcessor`.

use crate::processor::{MessageProcessor, Processor};
use crate::request_processors::{
    ApprovalProcessor, ConfigProcessor, FsProcessor, GitProcessor, HealthProcessor,
    PermissionProcessor, PluginProcessor, SessionProcessor,
};
use crate::state::ServerState;

/// A fully-assembled kimi-server: shared state + processor with every
/// method family registered.
pub struct Server {
    /// The processor hosts all methods; serve it via in_process or a
    /// transport.
    pub processor: MessageProcessor,
    /// Shared engine state (session manager, callbacks, approval, permission).
    pub state: ServerState,
}

impl Server {
    /// Build a server with fresh shared state and all method families.
    pub fn build() -> anyhow::Result<Self> {
        let state = ServerState::new()?;
        let mut processor = MessageProcessor::new();

        HealthProcessor.register(&mut processor);
        ConfigProcessor.register(&mut processor);
        FsProcessor.register(&mut processor);
        GitProcessor.register(&mut processor);
        PluginProcessor::new()?.register(&mut processor);
        SessionProcessor::with_state(state.clone()).register(&mut processor);
        ApprovalProcessor::with_state(state.clone()).register(&mut processor);
        PermissionProcessor::with_state(state.clone()).register(&mut processor);

        Ok(Self { processor, state })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kimi_protocol::rpc::JsonRpcRequest;

    #[tokio::test]
    async fn server_build_serves_all_families() {
        let server = Server::build().expect("server");
        // health (stateless)
        let body = server
            .processor
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "agent/health".into(),
                params: serde_json::Value::Null,
            })
            .await;
        assert_eq!(body["result"]["status"], "ok");
        // session/list (shared state)
        let body = server
            .processor
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(2),
                method: "session/list".into(),
                params: serde_json::json!({ "limit": 5 }),
            })
            .await;
        assert!(body.get("error").is_none());
        // approval_list (shared approval store)
        let body = server
            .processor
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(3),
                method: "session/approval_list".into(),
                params: serde_json::json!({}),
            })
            .await;
        assert!(body.get("error").is_none());
    }
}
