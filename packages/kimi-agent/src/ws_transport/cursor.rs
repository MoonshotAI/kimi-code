/// Session cursor management for WS v2 protocol.
///
/// In v2, each session has a cursor `{ seq, epoch }` that tracks:
/// - `seq`: the last durable event sequence number the client has applied
/// - `epoch`: identifies the journal incarnation (changes when recreated)
///
/// A cursor whose epoch does not match the server's current epoch is invalid
/// and triggers `resync_required(epoch_changed)`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use super::error::{WsError, WsResult};

/// Per-session sync cursor.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionCursor {
    /// Last durable event seq the client has applied (journal offset).
    pub seq: u64,
    /// Journal incarnation identifier. Changes when a session's journal
    /// is recreated.
    pub epoch: Option<String>,
}

impl SessionCursor {
    /// Create a fresh cursor with seq=0 and no epoch.
    pub fn new() -> Self {
        Self {
            seq: 0,
            epoch: None,
        }
    }

    /// Create a cursor with a specific seq and epoch.
    pub fn with_seq_and_epoch(seq: u64, epoch: Option<String>) -> Self {
        Self { seq, epoch }
    }

    /// Check if this cursor is compatible with the server's epoch.
    pub fn is_epoch_valid(&self, server_epoch: Option<&str>) -> bool {
        match (&self.epoch, server_epoch) {
            (Some(client), Some(server)) => client == server,
            (None, None) => true,
            // Client has no epoch (fresh cursor) — always valid.
            (None, Some(_)) => true,
            // Client has epoch but server doesn't — invalid.
            (Some(_), None) => false,
        }
    }

    /// Advance the cursor by one sequence number.
    pub fn advance(&mut self) {
        self.seq += 1;
    }

    /// Set the cursor to a specific seq.
    pub fn set_seq(&mut self, seq: u64) {
        self.seq = seq;
    }

    /// Update the epoch.
    pub fn set_epoch(&mut self, epoch: String) {
        self.epoch = Some(epoch);
    }
}

impl Default for SessionCursor {
    fn default() -> Self {
        Self::new()
    }
}

/// Type alias for the session_id → cursor map.
pub type CursorsBySession = HashMap<String, SessionCursor>;

/// Thread-safe cursor store that tracks cursors for multiple sessions.
#[derive(Debug, Clone)]
pub struct SessionCursorStore {
    cursors: Arc<Mutex<CursorsBySession>>,
}

impl SessionCursorStore {
    /// Create a new empty cursor store.
    pub fn new() -> Self {
        Self {
            cursors: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Get the cursor for a session, if any.
    pub fn get(&self, session_id: &str) -> Option<SessionCursor> {
        self.cursors
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session_id)
            .cloned()
    }

    /// Get all cursors as a snapshot.
    pub fn get_all(&self) -> CursorsBySession {
        self.cursors
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Set the cursor for a session.
    pub fn set(&self, session_id: String, cursor: SessionCursor) {
        self.cursors
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(session_id, cursor);
    }

    /// Advance a session's cursor (after applying a durable event).
    pub fn advance(&self, session_id: &str) -> WsResult<()> {
        let mut cursors = self
            .cursors
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(cursor) = cursors.get_mut(session_id) {
            cursor.advance();
            Ok(())
        } else {
            Err(WsError::ProtocolError(format!(
                "No cursor for session {session_id}"
            )))
        }
    }

    /// Validate a session's cursor against the server's epoch.
    pub fn validate_epoch(&self, session_id: &str, server_epoch: Option<&str>) -> WsResult<bool> {
        let cursors = self
            .cursors
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(cursor) = cursors.get(session_id) {
            Ok(cursor.is_epoch_valid(server_epoch))
        } else {
            // No cursor means fresh — always valid.
            Ok(true)
        }
    }

    /// Clear all cursors (e.g., after a full resync).
    pub fn clear(&self) {
        self.cursors
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }

    /// Remove a session's cursor.
    pub fn remove(&self, session_id: &str) -> Option<SessionCursor> {
        self.cursors
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(session_id)
    }
}

impl Default for SessionCursorStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cursor_new() {
        let cursor = SessionCursor::new();
        assert_eq!(cursor.seq, 0);
        assert_eq!(cursor.epoch, None);
    }

    #[test]
    fn test_cursor_advance() {
        let mut cursor = SessionCursor::new();
        cursor.advance();
        assert_eq!(cursor.seq, 1);
        cursor.advance();
        assert_eq!(cursor.seq, 2);
    }

    #[test]
    fn test_epoch_valid_both_none() {
        let cursor = SessionCursor::new();
        assert!(cursor.is_epoch_valid(None));
    }

    #[test]
    fn test_epoch_valid_client_none() {
        let cursor = SessionCursor::new();
        assert!(cursor.is_epoch_valid(Some("epoch-1")));
    }

    #[test]
    fn test_epoch_valid_matching() {
        let cursor = SessionCursor::with_seq_and_epoch(10, Some("epoch-1".into()));
        assert!(cursor.is_epoch_valid(Some("epoch-1")));
    }

    #[test]
    fn test_epoch_invalid_mismatch() {
        let cursor = SessionCursor::with_seq_and_epoch(10, Some("epoch-1".into()));
        assert!(!cursor.is_epoch_valid(Some("epoch-2")));
    }

    #[test]
    fn test_epoch_invalid_client_some_server_none() {
        let cursor = SessionCursor::with_seq_and_epoch(10, Some("epoch-1".into()));
        assert!(!cursor.is_epoch_valid(None));
    }

    #[test]
    fn test_cursor_store() {
        let store = SessionCursorStore::new();
        store.set(
            "session-1".into(),
            SessionCursor::with_seq_and_epoch(5, Some("epoch-1".into())),
        );

        let cursor = store.get("session-1").unwrap();
        assert_eq!(cursor.seq, 5);
        assert_eq!(cursor.epoch, Some("epoch-1".into()));

        store.advance("session-1").unwrap();
        let cursor = store.get("session-1").unwrap();
        assert_eq!(cursor.seq, 6);
    }

    #[test]
    fn test_cursor_store_validate() {
        let store = SessionCursorStore::new();
        store.set(
            "session-1".into(),
            SessionCursor::with_seq_and_epoch(5, Some("epoch-1".into())),
        );

        assert!(store.validate_epoch("session-1", Some("epoch-1")).unwrap());
        assert!(!store.validate_epoch("session-1", Some("epoch-2")).unwrap());
        assert!(store.validate_epoch("session-2", Some("epoch-1")).unwrap()); // no cursor = valid
    }
}
