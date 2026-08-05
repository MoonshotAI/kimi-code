//! Approval method family — pending tool approvals (web-facing cards).
//! The processor owns the shared `ApprovalStore` the way main.rs does;
//! decisions feed back into the waiting tool calls.

use std::sync::Arc;

use kimi_agent::approval::{ApprovalStore, SharedApprovalStore};
use kimi_protocol::rpc::JsonRpcError;
use kimi_protocol::wire_types::{SessionApprovalListParams, SessionApprovalResolveParams};

use crate::processor::{MessageProcessor, Processor};

/// Approval methods.
pub struct ApprovalProcessor {
    store: SharedApprovalStore,
}

impl ApprovalProcessor {
    /// Create with a fresh shared approval store.
    pub fn new() -> Self {
        Self {
            store: Arc::new(ApprovalStore::new()),
        }
    }

    /// Create from shared server state.
    pub fn with_state(state: crate::state::ServerState) -> Self {
        Self { store: state.approval }
    }

    /// Expose the shared store (tests / future processors).
    pub fn store(&self) -> SharedApprovalStore {
        self.store.clone()
    }
}

impl Processor for ApprovalProcessor {
    fn register(&self, processor: &mut MessageProcessor) {
        // `session/approval_list` — pending approvals for a session scope.
        let store = self.store.clone();
        processor.register(kimi_protocol::methods::SESSION_APPROVAL_LIST, move |params| {
            let store = store.clone();
            Box::pin(async move {
                let input: SessionApprovalListParams = serde_json::from_value(params)
                    .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let scope = input.session_id.as_deref().filter(|s| !s.is_empty());
                let pending = store.list(scope);
                serde_json::to_value(kimi_agent::approval::ApprovalListResult { pending })
                    .map_err(|e| JsonRpcError::internal_error(e.to_string()))
            })
        });

        // `session/approval_resolve` — feed a decision into the waiting tool.
        let store = self.store.clone();
        processor.register(kimi_protocol::methods::SESSION_APPROVAL_RESOLVE, move |params| {
            let store = store.clone();
            Box::pin(async move {
                let input: SessionApprovalResolveParams = serde_json::from_value(params)
                    .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let decision = match input.decision.as_str() {
                    "allow" => kimi_agent::approval::ApprovalDecision::Allow,
                    "deny" => kimi_agent::approval::ApprovalDecision::Deny {
                        reason: input.reason,
                    },
                    _ => {
                        return Err(JsonRpcError::invalid_params(
                            "decision must be 'allow' or 'deny'",
                        ));
                    }
                };
                let resolved = store.resolve(&input.id, decision);
                serde_json::to_value(kimi_agent::approval::ApprovalResolveResult { resolved })
                    .map_err(|e| {
                        JsonRpcError::internal_error(format!("approval_resolve serialize failed: {e}"))
                    })
            })
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kimi_protocol::rpc::JsonRpcRequest;

    #[tokio::test]
    async fn approval_resolve_unknown_id_returns_false() {
        let processor = ApprovalProcessor::new();
        let mut server = MessageProcessor::new();
        processor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "session/approval_resolve".into(),
                params: serde_json::json!({ "id": "nope", "decision": "allow" }),
            })
            .await;
        assert!(body.get("error").is_none(), "resolve should not error: {body}");
        assert_eq!(body["result"]["resolved"], false);
    }

    #[tokio::test]
    async fn approval_list_returns_empty() {
        let processor = ApprovalProcessor::new();
        let mut server = MessageProcessor::new();
        processor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "session/approval_list".into(),
                params: serde_json::json!({ "session_id": "s1" }),
            })
            .await;
        assert!(body.get("error").is_none());
        assert_eq!(body["result"]["pending"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn approval_roundtrip_request_list_resolve() {
        use kimi_agent::approval::ApprovalDecision;

        let processor = ApprovalProcessor::new();
        // Register a pending approval on the shared store, as the gated tool
        // path does; the wait handle resolves when the decision lands.
        let decision_rx = processor.store().request(
            Some("s1".to_string()),
            "tool-call-1".to_string(),
            "Bash".to_string(),
            serde_json::json!({ "cmd": "ls" }),
            "Bash(**)".to_string(),
        );
        let mut server = MessageProcessor::new();
        processor.register(&mut server);

        // session/approval_list surfaces it under the session scope.
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "session/approval_list".into(),
                params: serde_json::json!({ "session_id": "s1" }),
            })
            .await;
        assert!(body.get("error").is_none(), "list failed: {body}");
        let pending = body["result"]["pending"].as_array().expect("pending array");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0]["tool_name"], "Bash");
        let id = pending[0]["id"].as_str().expect("id").to_string();

        // session/approval_resolve feeds the decision back to the waiter.
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(2),
                method: "session/approval_resolve".into(),
                params: serde_json::json!({ "id": id, "decision": "allow" }),
            })
            .await;
        assert!(body.get("error").is_none(), "resolve failed: {body}");
        assert_eq!(body["result"]["resolved"], true);
        assert!(
            matches!(decision_rx.await, Ok(ApprovalDecision::Allow)),
            "waiting tool receives the allow decision"
        );

        // The queue drains; a second list is empty.
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(3),
                method: "session/approval_list".into(),
                params: serde_json::json!({ "session_id": "s1" }),
            })
            .await;
        assert_eq!(body["result"]["pending"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn approval_resolve_rejects_unknown_decision() {
        let processor = ApprovalProcessor::new();
        let mut server = MessageProcessor::new();
        processor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "session/approval_resolve".into(),
                params: serde_json::json!({ "id": "x", "decision": "maybe" }),
            })
            .await;
        assert!(body.get("error").is_some(), "unknown decision -> error: {body}");
    }

    #[tokio::test]
    async fn approval_resolve_missing_decision_is_rejected() {
        // A resolve without a decision is a parameter-level error (the
        // `decision` wire field is mandatory), surfacing the field name.
        let processor = ApprovalProcessor::new();
        let mut server = MessageProcessor::new();
        processor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "session/approval_resolve".into(),
                params: serde_json::json!({ "id": "x" }),
            })
            .await;
        assert!(body.get("error").is_some(), "missing decision -> error: {body}");
        let message = body["error"]["message"].as_str().unwrap_or("");
        assert!(message.contains("decision"), "error names the field: {message}");
    }
}
