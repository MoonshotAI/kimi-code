//! MCP ConnectionManager — Phase 7.4 of the Rust napi-rs migration roadmap.
//!
//! Central registry for active MCP server connections. Holds metadata
//! about each connection (server name, transport type, status, last
//! error) and lets the TS orchestrator introspect what's currently
//! connected.
//!
//! The actual transport interactions (stdio, http POST, sse stream) live
//! in their own modules — `mcp.rs`, `mcp_http.rs`, `mcp_sse.rs`. The
//! registry doesn't own the live stream objects; it tracks *metadata*
//! that the TS side uses to decide which transport function to call next.
//!
//! Concurrency: backed by `std::sync::RwLock<HashMap<…>>`. Reads are
//! cheap (callers may poll on every tool listing); writes are rare
//! (connect/disconnect) so the read bias is the right trade-off here.
//!
//! Handles: each `add_*` call returns a u64 `handle` the caller can use
//! to reference the connection later. Handles are monotonic and unique
//! per process. Dropping the JS-side handle doesn't disconnect — the
//! caller must invoke `remove` explicitly. (Mirrors the StdioClient
//! registry in `mcp.rs`.)

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;
use std::time::SystemTime;

use serde_json::Value;

/// Transport kind for a registered MCP connection.
///
/// `Sse` is the long-lived listener stream described in Streamable HTTP
/// spec §2.2 — opened via `GET` and used for unsolicited server messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportKind {
    Stdio,
    Http,
    Sse,
}

/// Lifecycle status of a registered connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionStatus {
    /// Successfully connected and ready to serve requests.
    Connected,
    /// Currently attempting to connect (or reconnect after a drop).
    Connecting,
    /// Intentionally disconnected; the registry still has metadata.
    Disconnected,
    /// Failed to connect; `last_error` carries the cause.
    Failed,
}

/// Metadata stored for each registered connection.
#[derive(Debug, Clone)]
pub struct ConnectionInfo {
    /// Stable name the caller chose when adding the connection. Used as
    /// the lookup key in `get_by_name`.
    pub server_name: String,
    /// Transport the connection uses.
    pub transport: TransportKind,
    /// Current lifecycle status.
    pub status: ConnectionStatus,
    /// Monotonic handle assigned at registration time.
    pub handle: u64,
    /// Last error string (if status == Failed), else None.
    pub last_error: Option<String>,
    /// Server-reported capabilities (from the JSON-RPC `initialize`
    /// response). `None` until `initialize` has been observed.
    pub capabilities: Option<Value>,
    /// Wall-clock timestamp of the most recent status change. Useful
    /// for the orchestrator to surface "connected 3 minutes ago" in UIs.
    pub updated_at: SystemTime,
}

/// Snapshot of the registry — a list of `ConnectionInfo` for every
/// registered server. Returned by `list()` and `snapshot()`.
#[derive(Debug, Clone)]
pub struct RegistrySnapshot {
    pub connections: Vec<ConnectionInfo>,
}

/// Thread-safe global registry. Constructed once at process startup;
/// the `OnceLock` pattern mirrors `StdioClient::clients()` in `mcp.rs`.
#[derive(Debug)]
pub struct ConnectionRegistry {
    inner: RwLock<HashMap<u64, ConnectionInfo>>,
    by_name: RwLock<HashMap<String, u64>>,
    next_handle: AtomicU64,
}

impl ConnectionRegistry {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(HashMap::new()),
            by_name: RwLock::new(HashMap::new()),
            next_handle: AtomicU64::new(1),
        }
    }

    /// Register a new connection. If a connection with the same
    /// `server_name` already exists, the old entry is evicted and its
    /// handle returned alongside the new one — the caller can decide
    /// whether to clean up the old handle explicitly.
    ///
    /// Returns `(new_handle, Some(replaced_handle))` if there was a
    /// name collision, otherwise `(new_handle, None)`.
    pub fn add(
        &self,
        server_name: String,
        transport: TransportKind,
    ) -> (u64, Option<u64>) {
        let handle = self.next_handle.fetch_add(1, Ordering::Relaxed);
        let info = ConnectionInfo {
            server_name: server_name.clone(),
            transport,
            status: ConnectionStatus::Connecting,
            handle,
            last_error: None,
            capabilities: None,
            updated_at: SystemTime::now(),
        };

        // Evict any existing entry with the same name.
        let mut by_name = self.by_name.write().unwrap();
        let replaced = by_name.insert(server_name.clone(), handle);

        let mut inner = self.inner.write().unwrap();
        if let Some(old) = replaced {
            inner.remove(&old);
        }
        inner.insert(handle, info);

        (handle, replaced)
    }

    /// Update the status of an existing connection.
    ///
    /// Returns `false` if the handle isn't registered — useful for the
    /// caller to detect races (e.g. concurrent `remove`).
    pub fn set_status(
        &self,
        handle: u64,
        status: ConnectionStatus,
        error: Option<String>,
    ) -> bool {
        let mut inner = self.inner.write().unwrap();
        if let Some(info) = inner.get_mut(&handle) {
            info.status = status;
            info.last_error = error;
            info.updated_at = SystemTime::now();
            true
        } else {
            false
        }
    }

    /// Attach the server-reported capabilities (from `initialize`).
    pub fn set_capabilities(&self, handle: u64, capabilities: Value) -> bool {
        let mut inner = self.inner.write().unwrap();
        if let Some(info) = inner.get_mut(&handle) {
            info.capabilities = Some(capabilities);
            info.updated_at = SystemTime::now();
            true
        } else {
            false
        }
    }

    /// Remove a connection by handle. Returns the `server_name` of the
    /// removed entry so the caller can clean up related state, or
    /// `None` if the handle wasn't found.
    pub fn remove(&self, handle: u64) -> Option<String> {
        let mut inner = self.inner.write().unwrap();
        let info = inner.remove(&handle)?;
        drop(inner); // release inner lock before grabbing by_name
        self.by_name.write().unwrap().remove(&info.server_name);
        Some(info.server_name)
    }

    /// Look up a connection by its stable server name. Returns a
    /// snapshot — caller may not mutate it.
    pub fn get_by_name(&self, server_name: &str) -> Option<ConnectionInfo> {
        let by_name = self.by_name.read().unwrap();
        let handle = *by_name.get(server_name)?;
        drop(by_name);
        self.inner.read().unwrap().get(&handle).cloned()
    }

    /// Look up a connection by its numeric handle.
    pub fn get(&self, handle: u64) -> Option<ConnectionInfo> {
        self.inner.read().unwrap().get(&handle).cloned()
    }

    /// Snapshot every registered connection. The orchestrator calls
    /// this when listing MCP servers in a UI or persisting state.
    pub fn snapshot(&self) -> RegistrySnapshot {
        let inner = self.inner.read().unwrap();
        RegistrySnapshot {
            connections: inner.values().cloned().collect(),
        }
    }

    /// Number of currently registered connections. Cheap O(1).
    pub fn len(&self) -> usize {
        self.inner.read().unwrap().len()
    }

    /// True iff `len() == 0`.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Default for ConnectionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Process-wide singleton — same pattern as `StdioClient::CLIENTS` in
/// `mcp.rs`. The TS side always operates on the global registry, so a
/// `OnceLock` here keeps the JS API ergonomic.
static REGISTRY: std::sync::OnceLock<ConnectionRegistry> = std::sync::OnceLock::new();

/// Accessor for the process-wide registry. `pub` so the `napi_bindings`
/// glue can reach it; not part of the Rust public API in spirit.
pub fn registry() -> &'static ConnectionRegistry {
    REGISTRY.get_or_init(ConnectionRegistry::new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fresh_registry() -> ConnectionRegistry {
        ConnectionRegistry::new()
    }

    #[test]
    fn add_returns_monotonic_handles() {
        let r = fresh_registry();
        let (h1, _) = r.add("a".into(), TransportKind::Stdio);
        let (h2, _) = r.add("b".into(), TransportKind::Http);
        assert!(h2 > h1);
    }

    #[test]
    fn add_with_same_name_evicts_old_handle() {
        let r = fresh_registry();
        let (h1, replaced1) = r.add("server".into(), TransportKind::Stdio);
        assert!(replaced1.is_none());
        let (h2, replaced2) = r.add("server".into(), TransportKind::Http);
        assert_eq!(replaced2, Some(h1));
        assert!(h2 != h1);
        // The old handle is gone from the inner table.
        assert!(r.get(h1).is_none());
        // The new handle is in both tables.
        assert!(r.get(h2).is_some());
        assert_eq!(r.get_by_name("server").unwrap().handle, h2);
    }

    #[test]
    fn set_status_updates_existing_handle() {
        let r = fresh_registry();
        let (h, _) = r.add("srv".into(), TransportKind::Sse);
        assert!(r.set_status(h, ConnectionStatus::Connected, None));
        let info = r.get(h).unwrap();
        assert_eq!(info.status, ConnectionStatus::Connected);
        assert!(info.last_error.is_none());
    }

    #[test]
    fn set_status_returns_false_for_unknown_handle() {
        let r = fresh_registry();
        assert!(!r.set_status(999, ConnectionStatus::Failed, Some("nope".into())));
    }

    #[test]
    fn set_capabilities_round_trips() {
        let r = fresh_registry();
        let (h, _) = r.add("srv".into(), TransportKind::Http);
        let caps = json!({"tools": {"listChanged": true}});
        assert!(r.set_capabilities(h, caps.clone()));
        let info = r.get(h).unwrap();
        assert_eq!(info.capabilities, Some(caps));
    }

    #[test]
    fn remove_clears_both_tables() {
        let r = fresh_registry();
        let (h, _) = r.add("srv".into(), TransportKind::Stdio);
        assert_eq!(r.remove(h).as_deref(), Some("srv"));
        assert!(r.get(h).is_none());
        assert!(r.get_by_name("srv").is_none());
        // Idempotent — removing again returns None.
        assert!(r.remove(h).is_none());
    }

    #[test]
    fn snapshot_returns_all_entries() {
        let r = fresh_registry();
        r.add("a".into(), TransportKind::Stdio);
        r.add("b".into(), TransportKind::Http);
        r.add("c".into(), TransportKind::Sse);
        let snap = r.snapshot();
        let names: Vec<_> = snap.connections.iter().map(|c| c.server_name.clone()).collect();
        assert_eq!(names.len(), 3);
        assert!(names.contains(&"a".into()));
        assert!(names.contains(&"b".into()));
        assert!(names.contains(&"c".into()));
    }

    #[test]
    fn len_and_is_empty_track_state() {
        let r = fresh_registry();
        assert!(r.is_empty());
        assert_eq!(r.len(), 0);
        let (h, _) = r.add("x".into(), TransportKind::Stdio);
        assert_eq!(r.len(), 1);
        assert!(!r.is_empty());
        r.remove(h);
        assert!(r.is_empty());
    }

    #[test]
    fn default_impl_constructs_empty_registry() {
        let r = ConnectionRegistry::default();
        assert!(r.is_empty());
    }

    #[test]
    fn status_and_transport_enum_values_match_spec() {
        // The mapping is part of the napi contract — if we ever rename a
        // variant, the TS bridge breaks. Asserting here keeps the mapping
        // honest.
        assert_eq!(format!("{:?}", TransportKind::Stdio), "Stdio");
        assert_eq!(format!("{:?}", TransportKind::Http), "Http");
        assert_eq!(format!("{:?}", TransportKind::Sse), "Sse");
        assert_eq!(format!("{:?}", ConnectionStatus::Connected), "Connected");
        assert_eq!(format!("{:?}", ConnectionStatus::Disconnected), "Disconnected");
    }

    #[test]
    fn replaced_handle_is_removed_from_snapshot() {
        let r = fresh_registry();
        let (h1, _) = r.add("dup".into(), TransportKind::Stdio);
        let (h2, replaced) = r.add("dup".into(), TransportKind::Http);
        assert_eq!(replaced, Some(h1));
        let snap = r.snapshot();
        // Only one entry for "dup" survives — the new one.
        let dup_count = snap.connections.iter().filter(|c| c.server_name == "dup").count();
        assert_eq!(dup_count, 1);
        let entry = snap
            .connections
            .iter()
            .find(|c| c.server_name == "dup")
            .unwrap();
        assert_eq!(entry.handle, h2);
        assert_eq!(entry.transport, TransportKind::Http);
    }
}