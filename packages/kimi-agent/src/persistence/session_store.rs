/// Session storage — save, load, list, and delete session records.
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::persistence::store::SqliteStore;

/// A persisted session record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRecord {
    pub id: String,
    pub created_at: String,
    pub updated_at: String,
    /// Snapshot of the agent configuration at the time of saving.
    #[serde(default)]
    pub config_json: Value,
    /// Arbitrary agent state (message history, context, etc.).
    #[serde(default)]
    pub state_json: Value,
}

/// Store and retrieve session records via SQLite.
pub struct SessionStore {
    store: SqliteStore,
}

impl SessionStore {
    /// Create a new session store backed by the given SQLite store.
    pub fn new(store: SqliteStore) -> Self {
        Self { store }
    }

    /// Save (insert or replace) a session record.
    pub fn save_session(&self, session: &SessionRecord) -> anyhow::Result<()> {
        self.store.with_conn(|c| {
            c.execute(
                "INSERT OR REPLACE INTO sessions (id, created_at, updated_at, config_json, state_json)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    session.id,
                    session.created_at,
                    session.updated_at,
                    serde_json::to_string(&session.config_json)?,
                    serde_json::to_string(&session.state_json)?,
                ],
            )?;
            Ok(())
        })
    }

    /// Load a session record by ID.
    pub fn load_session(&self, id: &str) -> anyhow::Result<Option<SessionRecord>> {
        self.store.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT id, created_at, updated_at, config_json, state_json
                 FROM sessions WHERE id = ?1",
            )?;
            let mut rows = stmt.query_map(rusqlite::params![id], |row| {
                let config_str: String = row.get(3)?;
                let state_str: String = row.get(4)?;
                Ok(SessionRecord {
                    id: row.get(0)?,
                    created_at: row.get(1)?,
                    updated_at: row.get(2)?,
                    config_json: serde_json::from_str(&config_str)
                        .unwrap_or_default(),
                    state_json: serde_json::from_str(&state_str)
                        .unwrap_or_default(),
                })
            })?;
            match rows.next() {
                Some(Ok(session)) => Ok(Some(session)),
                _ => Ok(None),
            }
        })
    }

    /// List all session records with pagination (most recent first).
    pub fn list_sessions(
        &self,
        limit: usize,
        offset: usize,
    ) -> anyhow::Result<Vec<SessionRecord>> {
        self.store.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT id, created_at, updated_at, config_json, state_json
                 FROM sessions ORDER BY updated_at DESC LIMIT ?1 OFFSET ?2",
            )?;
            let rows = stmt.query_map(rusqlite::params![limit as i64, offset as i64], |row| {
                let config_str: String = row.get(3)?;
                let state_str: String = row.get(4)?;
                Ok(SessionRecord {
                    id: row.get(0)?,
                    created_at: row.get(1)?,
                    updated_at: row.get(2)?,
                    config_json: serde_json::from_str(&config_str)
                        .unwrap_or_default(),
                    state_json: serde_json::from_str(&state_str)
                        .unwrap_or_default(),
                })
            })?;
            let mut sessions = Vec::new();
            for row in rows {
                sessions.push(row?);
            }
            Ok(sessions)
        })
    }

    /// Delete a session record by ID.
    pub fn delete_session(&self, id: &str) -> anyhow::Result<()> {
        self.store.with_conn(|c| {
            c.execute("DELETE FROM sessions WHERE id = ?1", rusqlite::params![id])?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::store::SqliteStore;

    #[test]
    fn test_save_and_load_session() {
        let store = SessionStore::new(SqliteStore::in_memory().unwrap());

        let session = SessionRecord {
            id: "sess-1".into(),
            created_at: "2025-01-01T00:00:00Z".into(),
            updated_at: "2025-01-01T01:00:00Z".into(),
            config_json: serde_json::json!({"model": "gpt-4"}),
            state_json: serde_json::json!({"turns": 5}),
        };

        store.save_session(&session).unwrap();
        let loaded = store.load_session("sess-1").unwrap().unwrap();
        assert_eq!(loaded.id, "sess-1");
        assert_eq!(loaded.config_json["model"], "gpt-4");
        assert_eq!(loaded.state_json["turns"], 5);
    }

    #[test]
    fn test_load_nonexistent_session() {
        let store = SessionStore::new(SqliteStore::in_memory().unwrap());
        let loaded = store.load_session("nonexistent").unwrap();
        assert!(loaded.is_none());
    }

    #[test]
    fn test_list_sessions() {
        let store = SessionStore::new(SqliteStore::in_memory().unwrap());

        for i in 0..5 {
            store
                .save_session(&SessionRecord {
                    id: format!("sess-{i}"),
                    created_at: "2025-01-01T00:00:00Z".into(),
                    updated_at: format!("2025-01-01T00:0{i}:00Z"),
                    config_json: Value::Null,
                    state_json: Value::Null,
                })
                .unwrap();
        }

        let sessions = store.list_sessions(3, 0).unwrap();
        assert_eq!(sessions.len(), 3);
        // Most recent first
        assert_eq!(sessions[0].id, "sess-4");
    }

    #[test]
    fn test_delete_session() {
        let store = SessionStore::new(SqliteStore::in_memory().unwrap());

        store
            .save_session(&SessionRecord {
                id: "sess-1".into(),
                created_at: "2025-01-01T00:00:00Z".into(),
                updated_at: "2025-01-01T00:00:00Z".into(),
                config_json: Value::Null,
                state_json: Value::Null,
            })
            .unwrap();

        store.delete_session("sess-1").unwrap();
        assert!(store.load_session("sess-1").unwrap().is_none());
    }
}