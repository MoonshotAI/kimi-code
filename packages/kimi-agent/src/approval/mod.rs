//! Session-scoped pending-approval store (web-facing approval surface).
//!
//! Interactive tool approval is the host's job; the engine's gate defers
//! (`NativeAuth::Defer`) and the host decides. Two decision channels feed the
//! same wait: the host `authorize_tool_execution` callback (TUI / vscode
//! panels, unchanged) and the `session/approval_list` + `session/approval_resolve`
//! RPC pair (kap-server / web). Whichever arrives first wins.
//!
//! Every deferred approval registers a pending entry here, publishes
//! `session.approval.requested`, and waits on a oneshot; resolving the entry
//! (by either channel) wakes the waiting tool call.

use std::sync::Arc;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::oneshot;

/// The host's decision on one deferred tool call.
#[derive(Debug, Clone)]
pub enum ApprovalDecision {
    Allow,
    Deny { reason: Option<String> },
    /// A synthetic result stands in for real execution (host-returned).
    Synthetic {
        content: String,
        is_error: bool,
        note: Option<String>,
    },
}

/// One pending approval, visible to hosts via `session/approval_list`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ApprovalEntry {
    pub id: String,
    pub session_id: Option<String>,
    pub tool_call_id: String,
    pub tool_name: String,
    pub arguments: serde_json::Value,
    pub approval_rule: String,
    pub created_at_ms: u64,
}

/// Wire shape for `session/approval_list`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ApprovalListResult {
    pub pending: Vec<ApprovalEntry>,
}

/// Wire shape for `session/approval_resolve`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ApprovalResolveResult {
    /// True when the entry existed and was resolved.
    pub resolved: bool,
}

/// Input for `session/approval_resolve`.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ApprovalResolveParams {
    pub id: String,
    /// "allow" | "deny"; optional synthetic content on allow.
    pub decision: String,
    pub reason: Option<String>,
    pub synthetic_content: Option<String>,
}

/// Shared store of deferred approvals (engine-process singleton, keyed by
/// session id in each entry). Serialized access is fine: approvals are rare
/// and the wait happens off the lock.
pub struct ApprovalStore {
    pending: Mutex<Vec<PendingApproval>>,
}

struct PendingApproval {
    entry: ApprovalEntry,
    decision_tx: Option<oneshot::Sender<ApprovalDecision>>,
}

impl Default for ApprovalStore {
    fn default() -> Self {
        Self::new()
    }
}

impl ApprovalStore {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(Vec::new()),
        }
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    /// Register a deferred approval and return the wait handle. The caller
    /// (gated tool execution) awaits it; `resolve` or the authorize callback
    /// feeds the decision.
    pub fn request(
        &self,
        session_id: Option<String>,
        tool_call_id: String,
        tool_name: String,
        arguments: serde_json::Value,
        approval_rule: String,
    ) -> oneshot::Receiver<ApprovalDecision> {
        let id = format!("approval-{}-{}", Self::now_ms(), tool_call_id);
        let (tx, rx) = oneshot::channel();
        let entry = ApprovalEntry {
            id: id.clone(),
            session_id,
            tool_call_id,
            tool_name,
            arguments,
            approval_rule,
            created_at_ms: Self::now_ms(),
        };
        let mut guard = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        // Stale entries (from a previous interrupted turn) never block a new
        // decision; cap the queue so a runaway loop cannot grow it forever.
        if guard.len() >= 64 {
            guard.remove(0);
        }
        guard.push(PendingApproval {
            entry,
            decision_tx: Some(tx),
        });
        rx
    }

    /// All pending approvals for a session (or all when session is None).
    pub fn list(&self, session_id: Option<&str>) -> Vec<ApprovalEntry> {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|p| {
                session_id.is_none() || p.entry.session_id.as_deref() == session_id
            })
            .map(|p| p.entry.clone())
            .collect()
    }

    /// Resolve a pending approval by id. Returns false when unknown.
    pub fn resolve(&self, id: &str, decision: ApprovalDecision) -> bool {
        let mut guard = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let Some(index) = guard.iter().position(|p| p.entry.id == id) else {
            return false;
        };
        let mut pending = guard.remove(index);
        if let Some(tx) = pending.decision_tx.take() {
            let _ = tx.send(decision);
        }
        true
    }

    /// Resolve by tool-call id (authorize-callback path). Returns false when
    /// unknown — the callback then falls back to its own inline decision.
    pub fn resolve_by_tool_call(
        &self,
        tool_call_id: &str,
        decision: ApprovalDecision,
    ) -> bool {
        let mut guard = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let Some(index) = guard
            .iter()
            .position(|p| p.entry.tool_call_id == tool_call_id)
        else {
            return false;
        };
        let mut pending = guard.remove(index);
        if let Some(tx) = pending.decision_tx.take() {
            let _ = tx.send(decision);
        }
        true
    }

    /// Pending count (health / tests).
    pub fn pending_count(&self) -> usize {
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

/// Convenience: build the `session.approval.requested` event payload.
pub fn approval_requested_event(entry: &ApprovalEntry) -> serde_json::Value {
    serde_json::json!({
        "type": "session.approval.requested",
        "session_id": entry.session_id,
        "approval_id": entry.id,
        "tool_call_id": entry.tool_call_id,
        "tool_name": entry.tool_name,
        "arguments": entry.arguments,
        "approval_rule": entry.approval_rule,
        "created_at_ms": entry.created_at_ms,
    })
}

/// Convenience: shared store handle for callbacks and RPC handlers.
pub type SharedApprovalStore = Arc<ApprovalStore>;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn request_and_resolve_wakes_the_waiter() {
        let store = ApprovalStore::new();
        let mut rx = store.request(
            Some("s1".to_string()),
            "c1".to_string(),
            "Write".to_string(),
            serde_json::json!({ "path": "/tmp/x" }),
            "Write(path=/tmp/x)".to_string(),
        );
        assert_eq!(store.pending_count(), 1);

        let listed = store.list(Some("s1"));
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].tool_name, "Write");
        assert_eq!(listed[0].approval_rule, "Write(path=/tmp/x)");
        // Other sessions are invisible.
        assert!(store.list(Some("s2")).is_empty());

        let resolved = store.resolve(&listed[0].id, ApprovalDecision::Deny { reason: Some("nope".into()) });
        assert!(resolved);
        let decision = rx.await.ok();
        assert!(matches!(decision, Some(ApprovalDecision::Deny { .. })));
        assert_eq!(store.pending_count(), 0);
        // Unknown ids resolve false.
        assert!(!store.resolve("missing", ApprovalDecision::Allow));
    }

    #[tokio::test]
    async fn resolve_by_tool_call_feeds_the_callback_channel() {
        let store = ApprovalStore::new();
        let mut rx = store.request(None, "c9".to_string(), "Bash".to_string(), serde_json::json!({}), "Bash()".to_string());
        let ok = store.resolve_by_tool_call("c9", ApprovalDecision::Allow);
        assert!(ok);
        let decision = rx.await.ok();
        assert!(matches!(decision, Some(ApprovalDecision::Allow)));
        // Second resolve by the same id is a miss (already consumed).
        assert!(!store.resolve_by_tool_call("c9", ApprovalDecision::Allow));
    }

    #[test]
    fn event_payload_carries_the_approval_shape() {
        let entry = ApprovalEntry {
            id: "approval-1-c1".to_string(),
            session_id: Some("s1".to_string()),
            tool_call_id: "c1".to_string(),
            tool_name: "Write".to_string(),
            arguments: serde_json::json!({ "path": "/tmp/x" }),
            approval_rule: "Write(path=/tmp/x)".to_string(),
            created_at_ms: 1,
        };
        let v = approval_requested_event(&entry);
        assert_eq!(v["type"], "session.approval.requested");
        assert_eq!(v["approval_id"], "approval-1-c1");
        assert_eq!(v["tool_name"], "Write");
        assert_eq!(v["session_id"], "s1");
    }
}

