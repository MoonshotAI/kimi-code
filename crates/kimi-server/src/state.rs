//! Server-level shared state — the engine state that method families must
//! share (session manager, host callbacks, approval store, permission gate).
//! Mirrors how main.rs assembles these once and passes clones to handlers;
//! here the processors borrow from a single `ServerState`.

use std::sync::Arc;

use kimi_agent::approval::{ApprovalStore, SharedApprovalStore};
use kimi_agent::callbacks::HostCallbacks;
use kimi_agent::permission::gate::PermissionGate;
use kimi_agent::persistence::{SessionStore, SqliteStore};
use kimi_agent::session::manager::SessionManager;
use tokio::sync::Mutex;

use crate::callbacks::ServerHostCallbacks;

/// Open the engine's session store (`$KIMI_AGENT_HOME/sessions.db` or
/// in-memory) — mirrors `open_session_store` in main.rs.
pub fn open_session_store() -> anyhow::Result<SqliteStore> {
    match std::env::var("KIMI_AGENT_HOME") {
        Ok(dir) if !dir.trim().is_empty() => {
            let path = std::path::Path::new(dir.trim()).join("sessions.db");
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            SqliteStore::open(&path)
        }
        _ => SqliteStore::in_memory(),
    }
}

/// Shared engine state for all method families.
#[derive(Clone)]
pub struct ServerState {
    /// Session lifecycle + agent registry.
    pub manager: Arc<Mutex<SessionManager>>,
    /// Host back-channel (events fan out here).
    pub callbacks: Arc<dyn HostCallbacks>,
    /// Web-facing approval store (shared with session agents).
    pub approval: SharedApprovalStore,
    /// Process-wide permission gate (shared with session agents).
    pub permission: PermissionGate,
}

impl ServerState {
    /// Assemble fresh shared state (own store, own approval/permission).
    pub fn new() -> anyhow::Result<Self> {
        let store = open_session_store()?;
        let manager = Arc::new(Mutex::new(SessionManager::new(SessionStore::new(store))));
        let callbacks: Arc<dyn HostCallbacks> = Arc::new(ServerHostCallbacks::new());
        let approval = Arc::new(ApprovalStore::new());
        let permission = PermissionGate::from_env();
        Ok(Self {
            manager,
            callbacks,
            approval,
            permission,
        })
    }
}
