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

/// Side-question channel reminder (mirrors the TS
/// `SIDE_QUESTION_SYSTEM_REMINDER`): the child answers from what it already
/// knows, never calls tools, and ignores the main agent's turn state.
const SIDE_QUESTION_SYSTEM_REMINDER: &str = r#"
This is a side-channel conversation with the user. You should answer user questions directly based on what you already know.

IMPORTANT:
- You are a separate, lightweight instance.
- The main agent continues independently; do not reference being interrupted.
- Do not call any tools. All tool calls are disabled and will be rejected.
- Respond only with text based on what you already know from the conversation
  and this side-channel conversation.
- Follow-up turns may happen in this side-channel conversation.
- If you do not know the answer, say so directly.
"#;

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
    /// Side-question ("between turns") subagents: session_id 鈫?child agent.
    /// One active side agent per session; a new `start_btw` replaces it.
    btw_agents: HashMap<String, Agent>,
    /// Creation specs for session agents, kept across `destroy` so a later
    /// `session/load` can rebuild the in-memory agent from its record.
    agent_specs: HashMap<String, AgentSpec>,
}

/// The minimal creation config needed to rebuild a session agent after a
/// destroy/load cycle. Captured at `create_agent` time.
#[derive(Clone)]
pub struct AgentSpec {
    pub callbacks: Arc<dyn HostCallbacks>,
    pub homedir: Option<String>,
    pub native_llm: Option<crate::rpc::types::NativeLlmConfig>,
    pub system_prompt: String,
    pub model_alias: Option<String>,
    pub max_steps_per_turn: u32,
    pub max_retries_per_step: u32,
    pub permission: crate::permission::gate::PermissionGate,
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
            btw_agents: HashMap::new(),
            agent_specs: HashMap::new(),
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
        let mut record = SessionRecord::new(&id, model_config.clone());

        // Resume path: a session that already exists in the store is being
        // re-created under its old id before `session/load`. The store copy
        // carries the durable agent state (context history + goal) written by
        // `save_agent_session` — load it into the cache verbatim so any later
        // write (work_dir, touch, save) does not clobber that state with a
        // fresh empty record. Only the caller's model config is refreshed; the
        // rest (work_dir/title/messages/agent_state) stays persisted.
        match self.store.load_session(&id) {
            Ok(Some(persisted)) => {
                if let Some(mut rich) = serde_json::from_value::<SessionRecord>(
                    persisted.state_json,
                )
                .ok()
                .filter(SessionRecord::is_valid_shape)
                {
                    rich.model_config = model_config;
                    rich.state = SessionState::Active;
                    record = rich;
                }
            }
            _ => {
                if let Err(e) = self.save_to_store(&record) {
                    eprintln!("[session] failed to persist new session {}: {e}", id);
                }
            }
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

    /// Record the session's working directory (set at creation so
    /// `session/list` can filter by workspace). The first non-empty value
    /// wins; later calls are ignored. Persisted immediately: the store copy
    /// written at creation carries an empty work_dir, and `session/list`
    /// reads from the store, so a cache-only update would never surface.
    pub fn set_work_dir(&mut self, id: &str, work_dir: &str) {
        if work_dir.is_empty() {
            return;
        }
        if let Some(record) = self.sessions.get_mut(id) {
            if record.work_dir.is_empty() {
                record.work_dir = work_dir.to_string();
                let updated = record.clone();
                if let Err(e) = self.save_to_store(&updated) {
                    eprintln!("[session] failed to persist work_dir for {}: {e}", id);
                }
            }
        }
    }

    /// Force-record the session's working directory, overwriting any value.
    /// Used by `session/create` when the host passes an explicit `work_dir` —
    /// the host is authoritative at creation, even when the store still holds
    /// a stale value from an earlier run with the same session id.
    pub fn set_work_dir_force(&mut self, id: &str, work_dir: &str) {
        if work_dir.is_empty() {
            return;
        }
        if let Some(record) = self.sessions.get_mut(id) {
            if record.work_dir != work_dir {
                record.work_dir = work_dir.to_string();
                let updated = record.clone();
                if let Err(e) = self.save_to_store(&updated) {
                    eprintln!("[session] failed to persist work_dir for {}: {e}", id);
                }
            }
        }
    }

    /// Rename a session: update the persisted title (SDK `renameSession`
    /// parity). Returns the updated record, or `None` when the session is
    /// not in the live cache (must be created/loaded first).
    pub fn rename_session(&mut self, id: &str, title: &str) -> anyhow::Result<Option<SessionRecord>> {
        if title.trim().is_empty() {
            anyhow::bail!("title must not be empty");
        }
        let Some(record) = self.sessions.get_mut(id) else {
            return Ok(None);
        };
        record.title = title.to_string();
        record.updated_at = Self::iso_now();
        let updated = record.clone();
        self.save_to_store(&updated)?;
        Ok(Some(updated))
    }

    /// Mark a session as archived: set `metadata.archived = true`, persist it,
    /// and drop it from the live agent cache so it no longer lists as active
    /// (SDK `archiveSession` parity). The record itself is kept — archive is
    /// a flag, not a delete. Returns `None` when the session is unknown.
    pub fn archive_session(&mut self, id: &str) -> anyhow::Result<Option<SessionRecord>> {
        let Some(record) = self.sessions.get_mut(id) else {
            return Ok(None);
        };
        let mut metadata = record.metadata.as_object().cloned().unwrap_or_default();
        metadata.insert("archived".to_string(), serde_json::json!(true));
        record.metadata = serde_json::Value::Object(metadata);
        record.updated_at = Self::iso_now();
        let updated = record.clone();
        // Drop the live agent so the archived session is not resumed in-process.
        self.agents.remove(id);
        self.save_to_store(&updated)?;
        Ok(Some(updated))
    }

    // ── Session activation / switching ────────────────────────────────────

    /// Activate a session by id.  Loads from persistence if not in cache.
    ///
    /// Returns `None` if the session does not exist.
    pub fn activate_session(&mut self, id: &str) -> Option<&SessionRecord> {
        // Ensure the session is loaded into cache; a cached entry that fails
        // the shape check is a cold miss and gets rebuilt from the store.
        if !self.ensure_loaded(id) {
            return None;
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
        if !self.ensure_loaded(id) {
            return None;
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

        // Record the creation spec so a destroy/load cycle can rebuild the
        // agent. `permission` defaults to a fresh env-seeded gate when the
        // caller did not inject one.
        let permission = options
            .permission
            .clone()
            .unwrap_or_else(crate::permission::gate::PermissionGate::from_env);
        self.agent_specs.insert(
            session_id.to_string(),
            AgentSpec {
                callbacks: callbacks.clone(),
                homedir: options.homedir.clone(),
                native_llm: options.native_llm.clone(),
                system_prompt: options
                    .config
                    .as_ref()
                    .map(|c| c.system_prompt.clone())
                    .unwrap_or_default(),
                model_alias: options.config.as_ref().and_then(|c| c.model_alias.clone()),
                max_steps_per_turn: options.max_steps_per_turn,
                max_retries_per_step: options.max_retries_per_step,
                permission,
            },
        );

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

    /// Spawn a side-question ("between turns") subagent for a session. The
    /// child inherits the main agent's transport config and system prompt,
    /// carries a projection of the main context plus the side-channel
    /// reminder, and runs with NO tools (answers from what it already knows).
    /// Returns the child agent id (`btw-<session_id>`). A previous side agent
    /// for the same session is replaced.
    pub fn start_btw(
        &mut self,
        session_id: &str,
        callbacks: Arc<dyn HostCallbacks>,
    ) -> Result<String, String> {
        let main = self
            .agents
            .get_mut(session_id)
            .ok_or_else(|| format!("no agent for session: {session_id}"))?;
        let options = crate::agent::types::AgentOptions {
            session_id: Some(format!("btw-{session_id}")),
            homedir: main.homedir.clone(),
            config: Some(crate::agent::types::AgentConfig {
                cwd: main.config.cwd.clone(),
                model_alias: main.config.model_alias.clone(),
                system_prompt: format!(
                    "{}\n\n{}",
                    main.config.system_prompt,
                    SIDE_QUESTION_SYSTEM_REMINDER.trim()
                ),
                has_provider: true,
                has_model: true,
            }),
            goal_enabled: false,
            native_llm: main.native_llm.clone(),
            max_steps_per_turn: main.max_steps_per_turn,
            max_retries_per_step: main.max_retries_per_step,
            permission: Some(main.permission.clone()),
            ..Default::default()
        };
        let mut child = Agent::new(callbacks, options);
        // Project the main conversation into the child's context so it can
        // answer "what were we doing" questions from context.
        let projected = main.context.messages().to_vec();
        for msg in projected {
            child.context.append_message(msg);
        }
        let btw_id = format!("btw-{session_id}");
        self.btw_agents.insert(session_id.to_string(), child);
        Ok(btw_id)
    }

    /// Get the active side-question agent for a session.
    pub fn get_btw_agent(&mut self, session_id: &str) -> Option<&mut Agent> {
        self.btw_agents.get_mut(session_id)
    }

    /// Destroy the active side-question agent for a session.
    pub fn end_btw(&mut self, session_id: &str) -> bool {
        self.btw_agents.remove(session_id).is_some()
    }

    /// Destroy an Agent and all its associated state.
    pub fn destroy_agent(&mut self, session_id: &str) -> anyhow::Result<()> {
        self.agents.remove(session_id);
        self.btw_agents.remove(session_id);
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
        let record: SessionRecord = serde_json::from_value(persisted.state_json)
            .ok()
            .filter(SessionRecord::is_valid_shape)
            .unwrap_or_else(|| SessionRecord::new(session_id, ModelConfig::default()));
        let agent_state = record.agent_state.clone();
        self.sessions.insert(session_id.to_string(), record);
        match self.agents.get_mut(session_id) {
            Some(agent) => {
                agent.restore_durable_state(&agent_state);
            }
            // The agent was destroyed (or the process restarted): rebuild it
            // from the recorded creation spec, then restore state.
            None => {
                if let Some(spec) = self.agent_specs.get(session_id).cloned() {
                    let homedir = spec.homedir.clone();
                    let agent = Agent::new(
                        spec.callbacks,
                        crate::agent::types::AgentOptions {
                            session_id: Some(session_id.to_string()),
                            homedir: spec.homedir,
                            config: Some(crate::agent::types::AgentConfig {
                                cwd: homedir.unwrap_or_default(),
                                model_alias: spec.model_alias,
                                system_prompt: spec.system_prompt,
                                has_provider: true,
                                has_model: true,
                            }),
                            goal_enabled: false,
                            native_llm: spec.native_llm,
                            max_steps_per_turn: spec.max_steps_per_turn,
                            max_retries_per_step: spec.max_retries_per_step,
                            permission: Some(spec.permission),
                            ..Default::default()
                        },
                    );
                    let mut agent = agent;
                    agent.restore_durable_state(&agent_state);
                    self.agents.insert(session_id.to_string(), agent);
                }
            }
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

    /// Permanently delete a persisted session (SDK `deleteSession` parity).
    /// Returns whether the record existed, so hosts can raise
    /// `session.not_found` for unknown ids without an engine error code.
    pub fn delete_persisted_session(&mut self, id: &str) -> anyhow::Result<bool> {
        let exists = self.store.load_session(id)?.is_some();
        if exists {
            self.delete_session(id)?;
        }
        Ok(exists)
    }

    /// Fork a persisted session under a new id (SDK `forkSession` parity):
    /// copies the source's conversation + durable context, drops the goal
    /// state, and registers the fork as the active session. Returns `None`
    /// when the source session is unknown.
    pub fn fork_session(
        &mut self,
        source_id: &str,
        fork_id: &str,
        title: Option<&str>,
        turn_index: Option<i64>,
    ) -> anyhow::Result<Option<SessionRecord>> {
        // Refuse to fork a session with an active turn: the conversation is
        // mid-flight and the copy would be inconsistent (SDK
        // `session.fork_active_turn`).
        if self.agents.get(source_id).is_some_and(|agent| agent.has_active_turn()) {
            anyhow::bail!("session has an active turn; cancel it before forking");
        }
        let Some(persisted) = self.store.load_session(source_id)? else {
            return Ok(None);
        };
        let mut record: SessionRecord = serde_json::from_value(persisted.state_json)
            .ok()
            .filter(SessionRecord::is_valid_shape)
            .unwrap_or_else(|| SessionRecord::new(source_id, ModelConfig::default()));

        // The store may be stale (agent context is persisted on
        // `session/save`, not after every turn): when the source agent is
        // live, its durable state is the authoritative conversation to copy.
        if let Some(agent) = self.agents.get(source_id) {
            record.agent_state = agent.durable_state();
        }

        // Historical fork: keep only the conversation through the selected
        // turn (each user-originated message starts a turn). The fork's next
        // turn id continues after the kept history (`turn_index + 1`).
        if let Some(turn_index) = turn_index {
            let context = record
                .agent_state
                .get("context")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let available_turns = context
                .iter()
                .filter(|msg| is_user_turn_message(msg))
                .count() as i64;
            if turn_index < 0 {
                anyhow::bail!("turn index must not be negative: {turn_index}");
            }
            if turn_index >= available_turns {
                anyhow::bail!("turn index out of range: {turn_index} >= {available_turns}");
            }
            let keep_user_messages = turn_index as usize + 1;
            let mut user_seen = 0usize;
            let mut kept: Vec<serde_json::Value> = Vec::new();
            for msg in &context {
                if is_user_turn_message(msg) {
                    user_seen += 1;
                    if user_seen > keep_user_messages {
                        break;
                    }
                }
                kept.push(msg.clone());
            }
            if let Some(state) = record.agent_state.as_object_mut() {
                state.insert("context".to_string(), serde_json::Value::Array(kept));
                state.insert("turn_counter".to_string(), serde_json::json!(turn_index + 1));
            }
        }

        // New identity + timestamps; the fork is an active session.
        record.id = fork_id.to_string();
        record.created_at = Self::iso_now();
        record.updated_at = record.created_at.clone();
        if let Some(title) = title {
            record.title = title.to_string();
        }
        record.state = SessionState::Active;
        // Drop the goal: a fork is a fresh start from the same context.
        if let Some(state) = record.agent_state.as_object_mut() {
            state.insert("goal".to_string(), serde_json::Value::Null);
        }

        self.save_to_store(&record)?;
        self.sessions.insert(fork_id.to_string(), record.clone());
        self.active_id = Some(fork_id.to_string());
        // Carry the creation spec so `session/load` can rebuild the fork's
        // agent from its copied state.
        if let Some(spec) = self.agent_specs.get(source_id).cloned() {
            self.agent_specs.insert(fork_id.to_string(), spec);
        }
        // Rebuild the fork's agent from the copied state so RPCs can drive
        // it immediately (a missing agent surfaces as "no agent for session").
        let _ = self.load_agent_session(fork_id);
        self.emit(SessionEvent::Created {
            id: fork_id.to_string(),
        });
        self.emit(SessionEvent::Activated {
            id: fork_id.to_string(),
        });
        Ok(Some(record))
    }

    // ── Listing ───────────────────────────────────────────────────────────

    /// List all persisted sessions (most recent first).
    pub fn list_sessions(&self, limit: usize, offset: usize) -> anyhow::Result<Vec<SessionRecord>> {
        let persisted = self.store.list_sessions(limit, offset)?;
        let mut records = Vec::with_capacity(persisted.len());
        for p in persisted {
            if let Ok(record) = serde_json::from_value::<SessionRecord>(p.state_json) {
                // Records whose key fields are empty (e.g. an `id` or
                // timestamp dropped during JSON serialization) are treated as
                // cold misses and skipped rather than surfaced as partial
                // data.
                if record.is_valid_shape() {
                    records.push(record);
                }
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

    /// Ensure a session is cached under a valid shape, loading it from the
    /// store otherwise.
    ///
    /// A cached entry that fails [`SessionRecord::is_valid_shape`] is treated
    /// as a cold miss: it is dropped, re-read from the store, and the rebuilt
    /// record overwrites the bad entry (self-healing entries poisoned before
    /// the shape check existed). Returns `false` — without touching the cache
    /// — when the session does not exist or its persisted record cannot be
    /// trusted.
    fn ensure_loaded(&mut self, id: &str) -> bool {
        let needs_rebuild = match self.sessions.get(id) {
            Some(record) => !record.is_valid_shape(),
            None => true,
        };
        if !needs_rebuild {
            return true;
        }
        self.sessions.remove(id);
        let persisted = match self.store.load_session(id) {
            Ok(Some(persisted)) => persisted,
            _ => return false,
        };
        let record: SessionRecord = match serde_json::from_value(persisted.state_json) {
            Ok(record) => record,
            Err(_) => return false,
        };
        // The rebuilt entry is only trusted when it also passes the shape
        // check; a broken persisted record stays a miss rather than
        // re-poisoning the cache.
        if !record.is_valid_shape() {
            return false;
        }
        self.sessions.insert(id.to_string(), record);
        true
    }

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

    #[test]
    fn test_set_work_dir_records_first_value_and_persists() {
        let mut mgr = SessionManager::new(test_store());
        mgr.create_session("sess-1", test_model());
        mgr.set_work_dir("sess-1", "/work/a");
        // A later call with a different directory is ignored (first wins).
        mgr.set_work_dir("sess-1", "/work/b");
        assert_eq!(mgr.sessions.get("sess-1").unwrap().work_dir, "/work/a");

        // The store picks the workdir up on the next full save (the TUI
        // saves on close, so resumed listings see it).
        mgr.persist_session("sess-1");
        let listed = mgr.list_persisted(10, 0).unwrap();
        let rich: SessionRecord =
            serde_json::from_value(listed[0].state_json.clone()).unwrap();
        assert_eq!(rich.work_dir, "/work/a");
    }

    #[test]
    fn test_create_session_preserves_an_existing_persisted_record() {
        let mut mgr = SessionManager::new(test_store());
        mgr.create_session("sess-1", test_model());
        mgr.set_work_dir("sess-1", "/work/a");
        // Simulate a durable save (as `save_agent_session` does): the cached
        // record carries work_dir + agent_state into the store.
        {
            let mut record = mgr.sessions.get_mut("sess-1").cloned().unwrap();
            record.agent_state = serde_json::json!({ "context": [] });
            mgr.save_to_store(&record).unwrap();
        }
        // Re-creating the same id (a resume does this before session/load)
        // must not wipe the persisted agent state or work dir.
        mgr.create_session("sess-1", test_model());
        let listed = mgr.list_persisted(10, 0).unwrap();
        let rich: SessionRecord =
            serde_json::from_value(listed[0].state_json.clone()).unwrap();
        assert_eq!(rich.work_dir, "/work/a");
        assert_eq!(rich.agent_state, serde_json::json!({ "context": [] }));
    }

    // ── Cache shape validation (cold miss on poisoned entries) ────────────

    #[test]
    fn test_activate_serves_valid_cached_entry_without_reload() {
        let mut mgr = SessionManager::new(test_store());
        mgr.create_session("sess-1", test_model());
        // Give the cache copy a distinctive work dir, then persist an older
        // copy to the store. A direct cache hit must keep the cached copy; a
        // reload would overwrite it with the store copy.
        let mut cached = mgr.sessions.get("sess-1").unwrap().clone();
        cached.work_dir = "/cached".into();
        mgr.sessions.insert("sess-1".into(), cached);
        let mut on_disk = mgr.sessions.get("sess-1").unwrap().clone();
        on_disk.work_dir = "/disk".into();
        mgr.save_to_store(&on_disk).unwrap();

        let active = mgr.activate_session("sess-1").unwrap();
        assert_eq!(active.work_dir, "/cached");
    }

    #[test]
    fn test_activate_rebuilds_poisoned_cached_entry() {
        let mut mgr = SessionManager::new(test_store());
        mgr.create_session("sess-1", test_model());
        mgr.set_work_dir("sess-1", "/disk");
        mgr.persist_session("sess-1");

        // Poison the cache: timestamps wiped (as if a pre-fix writer dropped
        // the fields during JSON serialization) and a stale work dir.
        let mut poisoned = mgr.sessions.get("sess-1").unwrap().clone();
        poisoned.created_at.clear();
        poisoned.updated_at.clear();
        poisoned.work_dir = "/stale".into();
        mgr.sessions.insert("sess-1".into(), poisoned);

        let active = mgr.activate_session("sess-1").unwrap();
        // Rebuilt from the store, not the poisoned cache copy.
        assert_eq!(active.work_dir, "/disk");
        assert!(!active.created_at.is_empty());
        assert!(!active.updated_at.is_empty());
        // The bad entry was overwritten with the rebuilt record.
        assert!(mgr.sessions.get("sess-1").unwrap().is_valid_shape());
    }

    #[test]
    fn test_resume_rebuilds_poisoned_cached_entry() {
        let mut mgr = SessionManager::new(test_store());
        mgr.create_session("sess-1", test_model());
        mgr.set_work_dir("sess-1", "/disk");
        mgr.persist_session("sess-1");
        mgr.pause_session();

        // Poison the cache copy, then resume — must heal from the store.
        let mut poisoned = mgr.sessions.get("sess-1").unwrap().clone();
        poisoned.created_at.clear();
        poisoned.work_dir = "/stale".into();
        mgr.sessions.insert("sess-1".into(), poisoned);

        let resumed = mgr.resume_session("sess-1").unwrap();
        assert_eq!(resumed.work_dir, "/disk");
        assert_eq!(resumed.state, SessionState::Active);
        assert!(!mgr.sessions.get("sess-1").unwrap().created_at.is_empty());
    }

    #[test]
    fn test_activate_misses_on_broken_persisted_record() {
        let store = test_store();
        store
            .save_session(&crate::persistence::session_store::SessionRecord {
                id: "sess-broken".into(),
                created_at: "2025-01-01T00:00:00Z".into(),
                updated_at: "2025-01-01T00:00:00Z".into(),
                config_json: serde_json::Value::Null,
                // Parses as a SessionRecord, but the key fields are empty —
                // the persisted record itself fails the shape check.
                state_json: serde_json::json!({
                    "id": "sess-broken",
                    "created_at": "",
                    "updated_at": "",
                }),
            })
            .unwrap();
        let mut mgr = SessionManager::new(store);
        // A poisoned cache entry for the same id.
        let mut poisoned = SessionRecord::new("sess-broken", test_model());
        poisoned.id.clear();
        mgr.sessions.insert("sess-broken".into(), poisoned);

        let active = mgr.activate_session("sess-broken");
        assert!(active.is_none());
        // The poisoned entry was dropped, not left behind to surface later.
        assert!(!mgr.sessions.contains_key("sess-broken"));
    }

    #[test]
    fn test_list_skips_records_failing_shape_check() {
        let store = test_store();
        let good = SessionRecord::new("good", test_model());
        store
            .save_session(&crate::persistence::session_store::SessionRecord {
                id: "good".into(),
                created_at: good.created_at.clone(),
                updated_at: good.updated_at.clone(),
                config_json: serde_json::to_value(&good.model_config).unwrap(),
                state_json: serde_json::to_value(&good).unwrap(),
            })
            .unwrap();
        // A record that parses but whose key fields are empty (the analog of
        // a pre-fix cache entry that lost fields during JSON serialization).
        store
            .save_session(&crate::persistence::session_store::SessionRecord {
                id: "bad".into(),
                created_at: "2025-01-01T00:00:00Z".into(),
                updated_at: "2025-01-01T00:00:00Z".into(),
                config_json: serde_json::Value::Null,
                state_json: serde_json::json!({
                    "id": "bad",
                    "created_at": "",
                    "updated_at": "",
                }),
            })
            .unwrap();

        let mgr = SessionManager::new(store);
        let list = mgr.list_sessions(10, 0).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "good");
    }

    #[test]
    fn test_load_agent_session_does_not_cache_broken_record() {
        let store = test_store();
        store
            .save_session(&crate::persistence::session_store::SessionRecord {
                id: "sess-1".into(),
                created_at: "2025-01-01T00:00:00Z".into(),
                updated_at: "2025-01-01T00:00:00Z".into(),
                config_json: serde_json::Value::Null,
                state_json: serde_json::json!({
                    "id": "sess-1",
                    "created_at": "",
                    "updated_at": "",
                }),
            })
            .unwrap();
        let mut mgr = SessionManager::new(store);
        mgr.load_agent_session("sess-1").unwrap();
        // The cache holds a freshly-built valid record, not the broken one.
        let cached = mgr.sessions.get("sess-1").unwrap();
        assert!(cached.is_valid_shape());
        assert_eq!(cached.id, "sess-1");
    }
}

/// A user-originated message starts a new turn (matches the SDK replay
/// filter: `role == "user"` with a `{ kind: "user" }` origin).
fn is_user_turn_message(message: &serde_json::Value) -> bool {
    message.get("role").and_then(|r| r.as_str()) == Some("user")
        && message
            .get("origin")
            .and_then(|o| o.get("kind"))
            .and_then(|k| k.as_str())
            == Some("user")
}