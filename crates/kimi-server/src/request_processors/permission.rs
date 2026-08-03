//! Permission method family — the process-wide native gate (get / set mode).
//! The gate is shared with every session agent via `ServerState.permission`.

use kimi_agent::permission::gate::PermissionGate;
use kimi_protocol::rpc::JsonRpcError;

use crate::processor::{MessageProcessor, Processor};

/// Permission methods.
pub struct PermissionProcessor {
    permission: PermissionGate,
}

impl PermissionProcessor {
    /// Create from shared server state.
    pub fn with_state(state: crate::state::ServerState) -> Self {
        Self {
            permission: state.permission,
        }
    }
}

impl Processor for PermissionProcessor {
    fn register(&self, processor: &mut MessageProcessor) {
        // `permission/get` — the current permission snapshot.
        let perm = self.permission.clone();
        processor.register(kimi_protocol::methods::PERMISSION_GET, move |_| {
            let perm = perm.clone();
            Box::pin(async move {
                serde_json::to_value(perm.manager().data())
                    .map_err(|e| JsonRpcError::internal_error(format!("Serialize error: {e}")))
            })
        });

        // `permission/set_mode` — set the gate mode.
        let perm = self.permission.clone();
        processor.register(kimi_protocol::methods::PERMISSION_SET_MODE, move |params| {
            let perm = perm.clone();
            Box::pin(async move {
                let mode: kimi_agent::permission::types::PermissionMode =
                    serde_json::from_value(params.get("mode").cloned().unwrap_or(params))
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid mode: {e}")))?;
                perm.set_mode(mode);
                Ok(serde_json::json!({ "ok": true, "mode": mode }))
            })
        });

        // `permission/add_rule` — add a rule to the gate (SDK `addRule`
        // parity); the rule arrives as the whole params object.
        let perm = self.permission.clone();
        processor.register(kimi_protocol::methods::PERMISSION_ADD_RULE, move |params| {
            let perm = perm.clone();
            Box::pin(async move {
                let rule: kimi_agent::permission::types::PermissionRule =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid rule: {e}")))?;
                perm.add_rule(rule);
                Ok(serde_json::json!({ "ok": true }))
            })
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kimi_protocol::rpc::JsonRpcRequest;

    #[tokio::test]
    async fn add_rule_shows_up_in_snapshot() {
        let state = crate::state::ServerState::new().expect("state");
        let processor = PermissionProcessor::with_state(state);
        let mut server = MessageProcessor::new();
        processor.register(&mut server);

        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "permission/add_rule".into(),
                params: serde_json::json!({
                    "decision": "allow",
                    "scope": "user",
                    "pattern": "Read(**)",
                    "reason": "test rule",
                }),
            })
            .await;
        assert!(body.get("error").is_none(), "add_rule failed: {body}");
        assert_eq!(body["result"]["ok"], true);

        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(2),
                method: "permission/get".into(),
                params: serde_json::Value::Null,
            })
            .await;
        assert!(body.get("error").is_none());
        assert!(
            body["result"]["rules"]
                .as_array()
                .is_some_and(|r| r.iter().any(|x| x["pattern"] == "Read(**)")),
            "added rule should appear in snapshot: {body}"
        );
    }

    #[tokio::test]
    async fn set_mode_roundtrip() {
        let state = crate::state::ServerState::new().expect("state");
        let processor = PermissionProcessor::with_state(state);
        let mut server = MessageProcessor::new();
        processor.register(&mut server);

        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "permission/set_mode".into(),
                params: serde_json::json!({ "mode": "yolo" }),
            })
            .await;
        assert!(body.get("error").is_none(), "set_mode failed: {body}");
        assert_eq!(body["result"]["mode"], "yolo");

        // The snapshot reflects the new mode.
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(2),
                method: "permission/get".into(),
                params: serde_json::Value::Null,
            })
            .await;
        assert!(body.get("error").is_none());
        assert_eq!(body["result"]["mode"], "yolo", "snapshot: {body}");

        // Unknown modes are rejected, not silently accepted.
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(3),
                method: "permission/set_mode".into(),
                params: serde_json::json!({ "mode": "sometimes" }),
            })
            .await;
        assert!(body.get("error").is_some(), "unknown mode -> error: {body}");
    }
}
