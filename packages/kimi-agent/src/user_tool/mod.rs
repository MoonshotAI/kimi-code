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

use crate::tools::manager::{ToolManager, UserToolRegistration};

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
    tool_manager: Option<*mut ToolManager>,
    /// Persistence delegate for wire-level recording.
    delegate: Option<Box<dyn UserToolDelegate>>,
}

// Safety: UserToolService is Send + Sync because access to ToolManager
// is only through exclusive references (set/register) or read-only (list).
unsafe impl Send for UserToolService {}
unsafe impl Sync for UserToolService {}

impl UserToolService {
    /// Create a new UserToolService. Call `set_tool_manager()` before use.
    pub fn new() -> Self {
        Self {
            tool_manager: None,
            delegate: None,
        }
    }

    /// Set the ToolManager reference. Required before calling register/unregister.
    pub fn set_tool_manager(&mut self, tm: &mut ToolManager) {
        self.tool_manager = Some(tm as *mut ToolManager);
    }

    /// Set the persistence delegate for wire-level recording.
    pub fn set_delegate(&mut self, delegate: Box<dyn UserToolDelegate>) {
        self.delegate = Some(delegate);
    }

    /// Register a user tool in the ToolManager and notify the persistence delegate.
    pub fn register(&mut self, input: UserToolRegistration) {
        if let Some(ref tm_ptr) = self.tool_manager {
            let tm = unsafe { &mut **tm_ptr };
            tm.register_user_tool(input.clone());
        }
        if let Some(ref delegate) = self.delegate {
            delegate.on_tool_registered(&input);
        }
    }

    /// Unregister a user tool from the ToolManager and notify the persistence delegate.
    pub fn unregister(&mut self, name: &str) {
        if let Some(ref tm_ptr) = self.tool_manager {
            let tm = unsafe { &mut **tm_ptr };
            tm.unregister_user_tool(name);
        }
        if let Some(ref delegate) = self.delegate {
            delegate.on_tool_unregistered(name);
        }
    }

    /// List all registered user tools (from ToolManager).
    pub fn list(&self) -> Vec<UserToolRegistration> {
        if let Some(ref tm_ptr) = self.tool_manager {
            let tm = unsafe { &**tm_ptr };
            return tm.list_user_tools();
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
            if let Some(ref tm_ptr) = self.tool_manager {
                let tm = unsafe { &mut **tm_ptr };
                tm.register_user_tool(reg.clone());
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
        let mut tm = make_tool_manager();
        let mut svc = UserToolService::new();
        svc.set_tool_manager(&mut tm);

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
        let mut tm = make_tool_manager();
        let mut svc = UserToolService::new();
        svc.set_tool_manager(&mut tm);

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
        let mut parent_tm = make_tool_manager();
        let mut parent = UserToolService::new();
        parent.set_tool_manager(&mut parent_tm);
        parent.register(UserToolRegistration {
            name: "shared".into(),
            description: "Shared tool".into(),
            parameters: serde_json::json!({}),
            disclosure: None,
        });

        let mut child_tm = make_tool_manager();
        let mut child = UserToolService::new();
        child.set_tool_manager(&mut child_tm);
        child.inherit_from(&parent);

        assert_eq!(child.list().len(), 1);
        assert_eq!(child.list()[0].name, "shared");
    }

    #[test]
    fn test_restore_from_persisted() {
        let mut tm = make_tool_manager();
        let mut svc = UserToolService::new();
        svc.set_tool_manager(&mut tm);

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
        let mut tm = make_tool_manager();
        let called = Arc::new(AtomicUsize::new(0));
        let c = called.clone();

        let mut svc = UserToolService::new();
        svc.set_tool_manager(&mut tm);
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
}