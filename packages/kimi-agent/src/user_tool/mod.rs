/// UserToolService — manages user-registered tools with ToolManager integration.
///
/// Corresponds to `packages/agent-core-v2/src/agent/userTool/`.
///
/// Holds the set of host-registered user tools, delegates to `ToolManager` for
/// registration/unregistration, and notifies a persistence delegate for wire-level
/// recording. Supports listing, inheritance from a parent service, and restore
/// from persisted state.
///
/// # Architecture
/// - `ToolManager`: actual registration of executable tools into the loop
/// - `UserToolDelegate`: persistence notifications (wire/ops dispatch)
/// - Restore: re-registers tools from persisted state after wire restoration

use std::sync::{Arc, Mutex};

use crate::rpc::server::RpcServer;
use crate::tools::manager::{ToolManager, UserToolRegistration};

/// RPC method for registering a user tool (host → engine), mirroring the TS
/// wire op `tools.register_user_tool` and the SDK `RegisterToolPayload`.
pub const REGISTER_TOOL_METHOD: &str = "session/register_tool";

/// RPC method for unregistering a user tool (host → engine), mirroring the
/// TS wire op `tools.unregister_user_tool` and the SDK `UnregisterToolPayload`.
pub const UNREGISTER_TOOL_METHOD: &str = "session/unregister_tool";

/// JSON-RPC payload of [`REGISTER_TOOL_METHOD`], matching the TS
/// `RegisterToolPayload` shape so the host can send `disclosure`.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct RegisterToolParams {
    /// Target session; when omitted the server resolves the active session.
    #[serde(default)]
    pub session_id: Option<String>,
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
    pub disclosure: Option<crate::tools::manager::ToolDisclosure>,
}

impl RegisterToolParams {
    /// Convert into a [`UserToolRegistration`] for the ToolManager.
    pub fn into_registration(self) -> UserToolRegistration {
        UserToolRegistration {
            name: self.name,
            description: self.description,
            parameters: self.parameters,
            disclosure: self.disclosure,
        }
    }
}

/// JSON-RPC payload of [`UNREGISTER_TOOL_METHOD`].
#[derive(Debug, Clone, serde::Deserialize)]
pub struct UnregisterToolParams {
    /// Target session; when omitted the server resolves the active session.
    #[serde(default)]
    pub session_id: Option<String>,
    pub name: String,
}

/// Register RPC handlers that route host tool-registration calls into
/// `service`, keeping the ToolManager and the persistence delegate in sync.
///
/// Call once during server assembly, e.g. in `main` next to the other
/// `RpcServer::register_arc` calls:
/// `user_tool::register_rpc_handlers(&server, user_tools.clone())`.
pub fn register_rpc_handlers(server: &Arc<RpcServer>, service: Arc<Mutex<UserToolService>>) {
    RpcServer::register_arc(server, REGISTER_TOOL_METHOD, {
        let service = service.clone();
        move |params| {
            let service = service.clone();
            Box::pin(async move {
                let payload: RegisterToolParams = serde_json::from_value(params)
                    .map_err(|e| crate::rpc::types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                service.lock().unwrap().register(payload.into_registration());
                Ok(serde_json::json!({ "ok": true }))
            })
        }
    });
    RpcServer::register_arc(server, UNREGISTER_TOOL_METHOD, {
        let service = service.clone();
        move |params| {
            let service = service.clone();
            Box::pin(async move {
                let payload: UnregisterToolParams = serde_json::from_value(params)
                    .map_err(|e| crate::rpc::types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                service.lock().unwrap().unregister(&payload.name);
                Ok(serde_json::json!({ "ok": true }))
            })
        }
    });
}

/// Delegate for persisting user tool registrations at the wire/ops level.
pub trait UserToolDelegate: Send + Sync {
    /// Called after a tool is registered in the ToolManager.
    fn on_tool_registered(&self, registration: &UserToolRegistration);

    /// Called after a tool is unregistered from the ToolManager.
    fn on_tool_unregistered(&self, name: &str);
}

/// Service for managing the lifecycle of user-registered tools.
///
/// Each registration is stored in the `ToolManager` for loop execution
/// and optionally persisted via the delegate.
pub struct UserToolService {
    /// The core tool manager (for registration/unregistration into the loop).
    /// `Arc<Mutex<..>>` matches the agent's ownership of `ToolManager`
    /// (see `Agent::tool_manager`), so no raw pointers or unsafe are needed.
    tool_manager: Option<Arc<Mutex<ToolManager>>>,
    /// Persistence delegate for wire-level recording.
    delegate: Option<Box<dyn UserToolDelegate>>,
}

impl UserToolService {
    /// Create a new UserToolService. Call `set_tool_manager()` before use.
    pub fn new() -> Self {
        Self {
            tool_manager: None,
            delegate: None,
        }
    }

    /// Set the ToolManager reference. Required before calling register/unregister.
    pub fn set_tool_manager(&mut self, tm: Arc<Mutex<ToolManager>>) {
        self.tool_manager = Some(tm);
    }

    /// Set the persistence delegate for wire-level recording.
    pub fn set_delegate(&mut self, delegate: Box<dyn UserToolDelegate>) {
        self.delegate = Some(delegate);
    }

    /// Register a user tool in the ToolManager and notify the persistence delegate.
    pub fn register(&mut self, input: UserToolRegistration) {
        if let Some(ref tm) = self.tool_manager {
            if let Ok(mut tm) = tm.lock() {
                tm.register_user_tool(input.clone());
            }
        }
        if let Some(ref delegate) = self.delegate {
            delegate.on_tool_registered(&input);
        }
    }

    /// Unregister a user tool from the ToolManager and notify the persistence delegate.
    pub fn unregister(&mut self, name: &str) {
        if let Some(ref tm) = self.tool_manager {
            if let Ok(mut tm) = tm.lock() {
                tm.unregister_user_tool(name);
            }
        }
        if let Some(ref delegate) = self.delegate {
            delegate.on_tool_unregistered(name);
        }
    }

    /// List all registered user tools (from ToolManager).
    pub fn list(&self) -> Vec<UserToolRegistration> {
        if let Some(ref tm) = self.tool_manager {
            if let Ok(tm) = tm.lock() {
                return tm.list_user_tools();
            }
        }
        Vec::new()
    }

    /// Inherit all user tools from a parent service.
    /// Used when creating sub-agents that should share user tool registrations.
    pub fn inherit_from(&mut self, parent: &UserToolService) {
        let tools = parent.list();
        for tool in tools {
            self.register(tool);
        }
    }

    /// Restore tools from a persisted list (called after wire restoration).
    ///
    /// Re-registers each tool in the ToolManager. The persistence delegate
    /// IS NOT notified — this is a restore operation, not a new registration.
    pub fn restore_from(&mut self, registrations: &[UserToolRegistration]) {
        for reg in registrations {
            // Register in ToolManager only (no persistence notification)
            if let Some(ref tm) = self.tool_manager {
                if let Ok(mut tm) = tm.lock() {
                    tm.register_user_tool(reg.clone());
                }
            }
        }
    }

    /// Notify delegate about a registration (for external callers).
    pub fn notify_registered(&self, registration: &UserToolRegistration) {
        if let Some(ref delegate) = self.delegate {
            delegate.on_tool_registered(registration);
        }
    }

    /// Notify delegate about an unregistration (for external callers).
    pub fn notify_unregistered(&self, name: &str) {
        if let Some(ref delegate) = self.delegate {
            delegate.on_tool_unregistered(name);
        }
    }
}

impl Default for UserToolService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn make_tool_manager() -> ToolManager {
        ToolManager::new()
    }

    #[test]
    fn test_new_service() {
        let svc = UserToolService::new();
        assert!(svc.list().is_empty());
    }

    #[test]
    fn test_register_and_list() {
        let tm = Arc::new(Mutex::new(make_tool_manager()));
        let mut svc = UserToolService::new();
        svc.set_tool_manager(tm.clone());

        svc.register(UserToolRegistration {
            name: "my-tool".into(),
            description: "A test tool".into(),
            parameters: serde_json::json!({}),
            disclosure: None,
        });

        let tools = svc.list();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "my-tool");
    }

    #[test]
    fn test_unregister() {
        let tm = Arc::new(Mutex::new(make_tool_manager()));
        let mut svc = UserToolService::new();
        svc.set_tool_manager(tm.clone());

        svc.register(UserToolRegistration {
            name: "temp".into(),
            description: "Temporary".into(),
            parameters: serde_json::json!({}),
            disclosure: None,
        });
        assert_eq!(svc.list().len(), 1);

        svc.unregister("temp");
        assert_eq!(svc.list().len(), 0);
    }

    #[test]
    fn test_inherit_from_parent() {
        let parent_tm = Arc::new(Mutex::new(make_tool_manager()));
        let mut parent = UserToolService::new();
        parent.set_tool_manager(parent_tm.clone());
        parent.register(UserToolRegistration {
            name: "shared".into(),
            description: "Shared tool".into(),
            parameters: serde_json::json!({}),
            disclosure: None,
        });

        let child_tm = Arc::new(Mutex::new(make_tool_manager()));
        let mut child = UserToolService::new();
        child.set_tool_manager(child_tm.clone());
        child.inherit_from(&parent);

        assert_eq!(child.list().len(), 1);
        assert_eq!(child.list()[0].name, "shared");
    }

    #[test]
    fn test_restore_from_persisted() {
        let tm = Arc::new(Mutex::new(make_tool_manager()));
        let mut svc = UserToolService::new();
        svc.set_tool_manager(tm.clone());

        let persisted = vec![
            UserToolRegistration {
                name: "restored-1".into(),
                description: "First".into(),
                parameters: serde_json::json!({}),
                disclosure: None,
            },
            UserToolRegistration {
                name: "restored-2".into(),
                description: "Second".into(),
                parameters: serde_json::json!({}),
                disclosure: None,
            },
        ];
        svc.restore_from(&persisted);
        assert_eq!(svc.list().len(), 2);
    }

    #[test]
    fn test_delegate_notification() {
        let tm = Arc::new(Mutex::new(make_tool_manager()));
        let called = Arc::new(AtomicUsize::new(0));
        let c = called.clone();

        let mut svc = UserToolService::new();
        svc.set_tool_manager(tm.clone());
        struct D(Arc<AtomicUsize>);
        impl UserToolDelegate for D {
            fn on_tool_registered(&self, _r: &UserToolRegistration) { self.0.fetch_add(1, Ordering::SeqCst); }
            fn on_tool_unregistered(&self, _n: &str) {}
        }
        svc.set_delegate(Box::new(D(c)));

        svc.register(UserToolRegistration {
            name: "notified".into(),
            description: "Test".into(),
            parameters: serde_json::json!({}),
            disclosure: None,
        });
        assert_eq!(called.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn test_notify_unregistered() {
        let called = Arc::new(AtomicUsize::new(0));
        let c = called.clone();
        let mut svc = UserToolService::new();
        struct D(Arc<AtomicUsize>);
        impl UserToolDelegate for D {
            fn on_tool_registered(&self, _r: &UserToolRegistration) {}
            fn on_tool_unregistered(&self, _n: &str) { self.0.fetch_add(1, Ordering::SeqCst); }
        }
        svc.set_delegate(Box::new(D(c)));
        svc.notify_unregistered("test-tool");
        assert_eq!(called.load(Ordering::SeqCst), 1);
    }

    // ── RPC registration path ────────────────────────────────────────────

    fn rpc_fixture() -> (Arc<RpcServer>, Arc<Mutex<UserToolService>>) {
        let tm = Arc::new(Mutex::new(make_tool_manager()));
        let mut svc = UserToolService::new();
        svc.set_tool_manager(tm);
        let svc = Arc::new(Mutex::new(svc));
        let server = Arc::new(RpcServer::new());
        register_rpc_handlers(&server, svc.clone());
        (server, svc)
    }

    #[tokio::test]
    async fn test_rpc_register_tool_lands_in_service_and_manager() {
        let (server, svc) = rpc_fixture();
        let result = server
            .invoke(REGISTER_TOOL_METHOD, serde_json::json!({
                "name": "my-tool",
                "description": "A test tool",
                "parameters": { "type": "object" },
                "disclosure": "deferred",
            }))
            .await;
        assert!(result.is_ok(), "register failed: {:?}", result.err());

        let listed = svc.lock().unwrap().list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "my-tool");
        // The `disclosure` round-trips into the registration.
        assert_eq!(
            listed[0].disclosure,
            Some(crate::tools::manager::ToolDisclosure::Deferred)
        );
    }

    #[tokio::test]
    async fn test_rpc_unregister_tool_removes_it() {
        let (server, svc) = rpc_fixture();
        // Seed via the service directly, then remove over the RPC path.
        svc.lock().unwrap().register(UserToolRegistration {
            name: "temp".into(),
            description: "Temporary".into(),
            parameters: serde_json::json!({}),
            disclosure: None,
        });
        let result = server
            .invoke(UNREGISTER_TOOL_METHOD, serde_json::json!({ "name": "temp" }))
            .await;
        assert!(result.is_ok(), "unregister failed: {:?}", result.err());
        assert!(svc.lock().unwrap().list().is_empty());
    }

    #[tokio::test]
    async fn test_rpc_register_tool_rejects_bad_payload() {
        let (server, svc) = rpc_fixture();
        // Missing `name` / `parameters` — serde rejects it with an RPC error.
        let result = server
            .invoke(REGISTER_TOOL_METHOD, serde_json::json!({ "description": "nope" }))
            .await;
        assert!(result.is_err());
        assert!(svc.lock().unwrap().list().is_empty());
    }
}