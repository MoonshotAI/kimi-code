/// Session manager — lifecycle management for multiple sessions.
///
/// Provides create, resume, switch, and delete operations, tracking the
/// currently active session and integrating with the persistence layer.
use std::collections::HashMap;
use std::sync::Arc;

use crate::agent::agent::Agent;
use crate::agent::types::AgentOptions;
use crate::callbacks::HostCallbacks;
use crate::persistence::session_store::SessionStore;
use crate::session::types::{ModelConfig, SessionRecord, SessionState};

// ── Lifecycle events ───────────────────────────────────────────────────────

/// Events emitted by the session manager during session lifecycle transitions.
#[derive(Debug, Clone)]
pub enum SessionEvent {
    /// A new session was created.
    Created { id: String },
    /// The session was switched to (becomes the active session).
    Activated { id: String },
    /// The session was switched away from (another session was activated).
    Deactivated { id: String },
    /// The session was paused.
    Paused { id: String },
    /// The session was resumed (from paused state).
    Resumed { id: String },
    /// The session was closed.
    Closed { id: String },
    /// The session was permanently deleted.
    Deleted { id: String },
}

/// Optional callback for session lifecycle events.
pub type EventCallback = Box<dyn Fn(SessionEvent) + Send + Sync>;

// ── SessionManager ─────────────────────────────────────────────────────────

/// Manages session creation, activation, persistence, and lifecycle.
pub struct SessionManager {
    /// Persistence backend for session records.
    store: SessionStore,
    /// In-memory cache of loaded session records.
    sessions: HashMap<String, SessionRecord>,
    /// ID of the currently active session, if any.
    active_id: Option<String>,
    /// Optional lifecycle event callback.
    on_event: Option<EventCallback>,
    /// Agents attached to sessions (Phase A: Rust-native agent lifecycle).
    agents: HashMap<String, Agent>,
}

impl SessionManager {
    /// Create a new session manager backed by the given store.
    pub fn new(store: SessionStore) -> Self {
        Self {
            store,
            sessions: HashMap::new(),
            active_id: None,
            on_event: None,
            agents: HashMap::new(),
        }
    }

    /// Set a lifecycle event callback.
    pub fn set_event_callback(&mut self, callback: EventCallback) {
        self.on_event = Some(callback);
    }

    /// Fire a lifecycle event if a callback is registered.
    fn emit(&self, event: SessionEvent) {
        if let Some(ref cb) = self.on_event {
            cb(event);
        }
    }

    // ── Session creation ──────────────────────────────────────────────────

    /// Create a new session with the given id and model configuration.
    ///
    /// The new session becomes the active session.
    pub fn create_session(
        &mut self,
        id: impl Into<String>,
        model_config: ModelConfig,
    ) -> SessionRecord {
        let id = id.into();
        let record = SessionRecord::new(&id, model_config);

        // Persist immediately.
        if let Err(e) = self.save_to_store(&record) {
            eprintln!("[session] failed to persist new session {}: {e}", id);
        }

        // Deactivate the current session.
        if let Some(old_id) = self.active_id.as_ref() {
            if let Some(old) = self.sessions.get_mut(old_id) {
                old.state = SessionState::Active; // keep as active for now
            }
            self.emit(SessionEvent::Deactivated {
                id: old_id.clone(),
            });
        }

        let session_id = record.id.clone();
        self.sessions.insert(record.id.clone(), record.clone());
        self.active_id = Some(session_id.clone());
        self.emit(SessionEvent::Created {
            id: session_id.clone(),
        });
        self.emit(SessionEvent::Activated { id: session_id });

        record
    }

    // ── Session activation / switching ────────────────────────────────────

    /// Activate a session by id.  Loads from persistence if not in cache.
    ///
    /// Returns `None` if the session does not exist.
    pub fn activate_session(&mut self, id: &str) -> Option<&SessionRecord> {
        // Ensure the session is loaded into cache.
        if !self.sessions.contains_key(id) {
            let persisted = self.store.load_session(id).ok()??;
            let record: SessionRecord =
                serde_json::from_value(persisted.state_json).ok()?;
            self.sessions.insert(id.to_string(), record);
        }

        if let Some(old_id) = self.active_id.as_ref() {
            if old_id == id {
                // Already active — no-op.
                return self.sessions.get(id);
            }
            if let Some(old) = self.sessions.get_mut(old_id) {
                old.state = SessionState::Active;
                self.emit(SessionEvent::Deactivated {
                    id: old_id.clone(),
                });
            }
        }

        self.active_id = Some(id.to_string());
        if let Some(record) = self.sessions.get_mut(id) {
            record.state = SessionState::Active;
            record.touch();
            self.emit(SessionEvent::Activated { id: id.to_string() });
        }

        self.sessions.get(id)
    }

    /// Return the currently active session, if any.
    pub fn active_session(&self) -> Option<&SessionRecord> {
        self.active_id.as_ref().and_then(|id| self.sessions.get(id))
    }

    /// Return the ID of the currently active session, if any.
    pub fn active_session_id(&self) -> Option<&str> {
        self.active_id.as_deref()
    }

    // ── Session lifecycle transitions ─────────────────────────────────────

    /// Pause the active session.
    pub fn pause_session(&mut self) {
        let id = match self.active_id.clone() {
            Some(id) => id,
            None => return,
        };
        if let Some(record) = self.sessions.get_mut(&id) {
            record.state = SessionState::Paused;
            record.touch();
            self.emit(SessionEvent::Paused { id: id.clone() });
            self.persist_session(&id);
        }
    }

    /// Resume a paused session and make it active.
    pub fn resume_session(&mut self, id: &str) -> Option<&SessionRecord> {
        if !self.sessions.contains_key(id) {
            let persisted = self.store.load_session(id).ok()??;
            let record: SessionRecord =
                serde_json::from_value(persisted.state_json).ok()?;
            self.sessions.insert(id.to_string(), record);
        }

        if let Some(old_id) = self.active_id.as_ref() {
            if old_id == id {
                // Already active — just update state if it was paused.
                if let Some(record) = self.sessions.get_mut(id) {
                    record.state = SessionState::Active;
                    record.touch();
                    self.emit(SessionEvent::Resumed { id: id.to_string() });
                }
                return self.sessions.get(id);
            }
            if let Some(old) = self.sessions.get_mut(old_id) {
                old.state = SessionState::Active;
            }
        }

        self.active_id = Some(id.to_string());
        if let Some(record) = self.sessions.get_mut(id) {
            record.state = SessionState::Active;
            record.touch();
            self.emit(SessionEvent::Resumed { id: id.to_string() });
        }
        self.sessions.get(id)
    }

    /// Close the active session (mark as closed, cannot be resumed).
    pub fn close_session(&mut self) {
        let id = match self.active_id.take() {
            Some(id) => id,
            None => return,
        };
        if let Some(record) = self.sessions.get_mut(&id) {
            record.state = SessionState::Closed;
            record.touch();
            self.emit(SessionEvent::Closed { id: id.clone() });
            self.persist_session(&id);
        }
    }

    // ── Session deletion ──────────────────────────────────────────────────

    // ── Agent lifecycle ───────────────────────────────────────────────

    /// Create an Agent attached to the given session.
    ///
    /// The Agent is created with the session's model config and host callbacks,
    /// then stored in the in-memory agent registry for subsequent turn execution.
    pub fn create_agent(
        &mut self,
        session_id: &str,
        callbacks: Arc<dyn HostCallbacks>,
        options: AgentOptions,
    ) -> anyhow::Result<&mut Agent> {
        // Ensure the session exists.
        if !self.sessions.contains_key(session_id) {
            anyhow::bail!("session not found: {session_id}");
        }

        let agent = Agent::new(callbacks, options);
        self.agents.insert(session_id.to_string(), agent);

        self.emit(SessionEvent::Created {
            id: session_id.to_string(),
        });

        Ok(self.agents.get_mut(session_id).unwrap())
    }

    /// Get a mutable reference to an Agent by session id.
    pub fn get_agent(&mut self, session_id: &str) -> Option<&mut Agent> {
        self.agents.get_mut(session_id)
    }

    /// Destroy an Agent and all its associated state.
    pub fn destroy_agent(&mut self, session_id: &str) -> anyhow::Result<()> {
        self.agents.remove(session_id);
        Ok(())
    }

    /// List all running agents.
    pub fn list_agents(&self) -> Vec<(String, bool)> {
        self.agents
            .keys()
            .map(|id| (id.clone(), true))
            .collect()
    }

    /// Persist agent context state into the session record.
    ///
    /// Serialises the Agent's message history into `SessionRecord.state_json`
    /// and flushes to storage. Called after each turn to ensure state survives
    /// process restarts.
    pub fn persist_agent_context(
        &mut self,
        session_id: &str,
        messages_json: serde_json::Value,
    ) -> anyhow::Result<()> {
        let now = Self::iso_now();
        let mut record = self.store.load_session(session_id)?
            .unwrap_or_else(|| crate::persistence::session_store::SessionRecord {
                id: session_id.to_string(),
                created_at: now.clone(),
                updated_at: now.clone(),
                config_json: serde_json::Value::Null,
                state_json: serde_json::Value::Null,
            });
        record.state_json = serde_json::json!({
            "agent": {
                "messages": messages_json,
                "updated_at": &now,
            }
        });
        record.updated_at = now;
        self.store.save_session(&record)?;
        Ok(())
    }

    /// Restore agent context from the session record.
    ///
    /// Returns the previously persisted context as JSON (empty object if no
    /// history exists).
    pub fn restore_agent_context(
        &self,
        session_id: &str,
    ) -> anyhow::Result<serde_json::Value> {
        let record = self.store.load_session(session_id)?;
        Ok(record
            .and_then(|r| r.state_json.get("agent").cloned())
            .unwrap_or(serde_json::Value::Null))
    }

    /// Persist the FULL agent state (context history + goal) via
    /// `Agent::save_session`. Merges into the manager's own `SessionRecord`
    /// (so `session list`/`export` still see it) by storing the agent blob
    /// under `SessionRecord.agent_state`.
    pub fn save_agent_session(&mut self, session_id: &str) -> anyhow::Result<()> {
        let Some(agent) = self.agents.get(session_id) else {
            anyhow::bail!("no agent for session: {session_id}");
        };
        let agent_state = agent.durable_state();
        // Update the cached record if present, else create a minimal one so a
        // save without a prior create_session still lists. The clone ends the
        // cache borrow before `save_to_store` re-borrows `self`.
        let updated = {
            let record = self.sessions.entry(session_id.to_string()).or_insert_with(|| {
                crate::session::types::SessionRecord::new(
                    session_id,
                    crate::session::types::ModelConfig::default(),
                )
            });
            record.agent_state = agent_state;
            record.touch();
            record.clone()
        };
        self.save_to_store(&updated)
    }

    /// Restore the full agent state saved by `save_agent_session`. Applies
    /// the GOAL.md restart rule: an `active` goal comes back `paused`.
    /// Returns false when no record exists.
    pub fn load_agent_session(&mut self, session_id: &str) -> anyhow::Result<bool> {
        let Some(persisted) = self.store.load_session(session_id)? else {
            return Ok(false);
        };
        let record: crate::session::types::SessionRecord =
            serde_json::from_value(persisted.state_json).unwrap_or_else(|_| {
                crate::session::types::SessionRecord::new(
                    session_id,
                    crate::session::types::ModelConfig::default(),
                )
            });
        let agent_state = record.agent_state.clone();
        self.sessions.insert(session_id.to_string(), record);
        if let Some(agent) = self.agents.get_mut(session_id) {
            agent.restore_durable_state(&agent_state);
        }
        Ok(true)
    }

    /// List persisted session records (most recent first).
    pub fn list_persisted(
        &self,
        limit: usize,
        offset: usize,
    ) -> anyhow::Result<Vec<crate::persistence::session_store::SessionRecord>> {
        self.store.list_sessions(limit, offset)
    }

    fn iso_now() -> String {
        // ISO 8601 timestamp without external crate dependency.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        let secs = now.as_secs();
        // Format as ISO 8601: YYYY-MM-DDTHH:MM:SSZ
        let (y, m, d, hh, mm, ss) = {
            let days = secs / 86400;
            let time = secs % 86400;
            let y = 1970 + days / 365; // approximate
            let doy = days % 365;
            let m = (doy * 12) / 365 + 1;
            let d = doy - ((m - 1) * 365) / 12 + 1;
            let hh = time / 3600;
            let mm = (time % 3600) / 60;
            let ss = time % 60;
            (y, m, d, hh, mm, ss)
        };
        format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
    }

    // ── Session deletion ──────────────────────────────────────────────────

    /// Delete a session by id — removes from cache and persistence.
    pub fn delete_session(&mut self, id: &str) -> anyhow::Result<()> {
        self.agents.remove(id);
        self.sessions.remove(id);
        self.store.delete_session(id)?;

        if self.active_id.as_deref() == Some(id) {
            self.active_id = None;
        }

        self.emit(SessionEvent::Deleted { id: id.to_string() });
        Ok(())
    }

    // ── Listing ───────────────────────────────────────────────────────────

    /// List all persisted sessions (most recent first).
    pub fn list_sessions(&self, limit: usize, offset: usize) -> anyhow::Result<Vec<SessionRecord>> {
        let persisted = self.store.list_sessions(limit, offset)?;
        let mut records = Vec::with_capacity(persisted.len());
        for p in persisted {
            if let Ok(record) = serde_json::from_value(p.state_json) {
                records.push(record);
            }
        }
        Ok(records)
    }

    // ── Message management ───────────────────────────────────────────

    /// Push a message to the active session and persist.
    /// Returns the updated message count.
    pub fn push_message(&mut self, message: crate::rpc::types::Message) -> usize {
        let id = match self.active_id.clone() {
            Some(id) => id,
            None => return 0,
        };
        let len = if let Some(record) = self.sessions.get_mut(&id) {
            record.push_message(message);
            record.touch();
            let len = record.messages.len();
            len
        } else {
            return 0;
        };
        self.persist_session(&id);
        len
    }

    /// Return the number of sessions currently in cache.
    pub fn cached_count(&self) -> usize {
        self.sessions.len()
    }

    // ── Persistence helpers ───────────────────────────────────────────────

    /// Persist a session record to the store.
    fn save_to_store(&self, record: &SessionRecord) -> anyhow::Result<()> {
        let state_json = serde_json::to_value(record)?;
        let persisted = crate::persistence::session_store::SessionRecord {
            id: record.id.clone(),
            created_at: record.created_at.clone(),
            updated_at: record.updated_at.clone(),
            config_json: serde_json::to_value(&record.model_config)?,
            state_json,
        };
        self.store.save_session(&persisted)
    }

    /// Persist the session with the given id (if cached).
    fn persist_session(&self, id: &str) {
        if let Some(record) = self.sessions.get(id) {
            if let Err(e) = self.save_to_store(record) {
                eprintln!("[session] failed to persist session {id}: {e}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::store::SqliteStore;

    fn test_store() -> SessionStore {
        SessionStore::new(SqliteStore::in_memory().unwrap())
    }

    fn test_model() -> ModelConfig {
        ModelConfig {
            provider: "anthropic".into(),
            model: "claude-sonnet-4-20250514".into(),
            max_tokens: Some(8192),
        }
    }

    #[test]
    fn test_create_and_active() {
        let mut mgr = SessionManager::new(test_store());
        let session = mgr.create_session("sess-1", test_model());
        assert_eq!(session.id, "sess-1");
        assert_eq!(session.state, SessionState::Active);
        assert_eq!(mgr.active_session_id(), Some("sess-1"));
    }

    #[test]
    fn test_switch_session() {
        let mut mgr = SessionManager::new(test_store());
        mgr.create_session("sess-1", test_model());
        mgr.create_session("sess-2", test_model());

        // sess-2 should be active now.
        assert_eq!(mgr.active_session_id(), Some("sess-2"));

        // Switch back to sess-1.
        let switched = mgr.activate_session("sess-1");
        assert!(switched.is_some());
        assert_eq!(mgr.active_session_id(), Some("sess-1"));
    }

    #[test]
    fn test_pause_resume() {
        let mut mgr = SessionManager::new(test_store());
        mgr.create_session("sess-1", test_model());

        mgr.pause_session();
        let active = mgr.active_session().unwrap();
        assert_eq!(active.state, SessionState::Paused);

        let resumed = mgr.resume_session("sess-1");
        assert!(resumed.is_some());
        assert_eq!(resumed.unwrap().state, SessionState::Active);
    }

    #[test]
    fn test_close_session() {
        let mut mgr = SessionManager::new(test_store());
        mgr.create_session("sess-1", test_model());
        mgr.close_session();

        assert!(mgr.active_session().is_none());
        // Cache still has it, but state is closed.
        let cached = mgr.sessions.get("sess-1");
        assert_eq!(cached.unwrap().state, SessionState::Closed);
    }

    #[test]
    fn test_delete_session() {
        let mut mgr = SessionManager::new(test_store());
        mgr.create_session("sess-1", test_model());
        mgr.delete_session("sess-1").unwrap();
        assert!(mgr.active_session().is_none());
        assert!(mgr.sessions.is_empty());
    }

    #[test]
    fn test_activate_nonexistent() {
        let mut mgr = SessionManager::new(test_store());
        let result = mgr.activate_session("does-not-exist");
        assert!(result.is_none());
    }

    #[test]
    fn test_events() {
        use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

        let mut mgr = SessionManager::new(test_store());
        let counter = Arc::new(AtomicUsize::new(0));
        let c = Arc::clone(&counter);
        mgr.set_event_callback(Box::new(move |_event| {
            c.fetch_add(1, Ordering::SeqCst);
        }));

        mgr.create_session("sess-1", test_model());
        mgr.create_session("sess-2", test_model());
        mgr.close_session();

        // 5 events: Created, Activated, Deactivated, Created, Activated, Closed + Deactivated
        // Actually: create_session("sess-1") → Created + Activated (2)
        //           create_session("sess-2") → Deactivated(sess-1) + Created(sess-2) + Activated(sess-2) (5)
        //           close_session() → Closed(sess-2) (6)
        assert!(counter.load(Ordering::SeqCst) >= 6);
    }

    #[test]
    fn test_list_sessions() {
        let mut mgr = SessionManager::new(test_store());
        mgr.create_session("sess-1", test_model());
        mgr.create_session("sess-2", test_model());

        let list = mgr.list_sessions(10, 0).unwrap();
        assert_eq!(list.len(), 2);
    }

    #[test]
    fn test_cached_count() {
        let mut mgr = SessionManager::new(test_store());
        assert_eq!(mgr.cached_count(), 0);
        mgr.create_session("sess-1", test_model());
        assert_eq!(mgr.cached_count(), 1);
    }
}