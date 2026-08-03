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
    }
}
