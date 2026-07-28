/// Record storage — append and query agent records.
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::persistence::store::SqliteStore;

/// A single persisted record entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Record {
    pub id: i64,
    pub session_id: String,
    pub turn_id: String,
    pub record_type: String,
    pub data_json: Value,
    pub created_at: String,
}

/// Input for appending a new record (id is auto-generated).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordInput {
    pub session_id: String,
    pub turn_id: String,
    pub record_type: String,
    pub data_json: Value,
    pub created_at: String,
}

/// Store and query agent records via SQLite.
pub struct RecordStore {
    store: SqliteStore,
}

impl RecordStore {
    /// Create a new record store backed by the given SQLite store.
    pub fn new(store: SqliteStore) -> Self {
        Self { store }
    }

    /// Append a new record and return the auto-generated ID.
    pub fn append_record(&self, input: &RecordInput) -> anyhow::Result<i64> {
        self.store.with_conn(|c| {
            c.execute(
                "INSERT INTO records (session_id, turn_id, record_type, data_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    input.session_id,
                    input.turn_id,
                    input.record_type,
                    serde_json::to_string(&input.data_json)?,
                    input.created_at,
                ],
            )?;
            Ok(c.last_insert_rowid())
        })
    }

    /// Get records for a session, optionally starting after a given ID.
    ///
    /// - `session_id` — which session's records to fetch.
    /// - `after_id` — if `Some`, only return records with `id > after_id`.
    /// - `limit` — maximum number of records to return.
    pub fn get_records(
        &self,
        session_id: &str,
        after_id: Option<i64>,
        limit: usize,
    ) -> anyhow::Result<Vec<Record>> {
        self.store.with_conn(|c| {
            let sql = match after_id {
                Some(_) => {
                    "SELECT id, session_id, turn_id, record_type, data_json, created_at
                     FROM records
                     WHERE session_id = ?1 AND id > ?2
                     ORDER BY id ASC
                     LIMIT ?3"
                }
                None => {
                    "SELECT id, session_id, turn_id, record_type, data_json, created_at
                     FROM records
                     WHERE session_id = ?1
                     ORDER BY id ASC
                     LIMIT ?2"
                }
            };

            let mut stmt = c.prepare(sql)?;

            let rows: Vec<Record> = if let Some(after) = after_id {
                stmt.query_map(
                    rusqlite::params![session_id, after, limit as i64],
                    |row| {
                        let data_str: String = row.get(4)?;
                        Ok(Record {
                            id: row.get(0)?,
                            session_id: row.get(1)?,
                            turn_id: row.get(2)?,
                            record_type: row.get(3)?,
                            data_json: serde_json::from_str(&data_str)
                                .unwrap_or_default(),
                            created_at: row.get(5)?,
                        })
                    },
                )?
                .filter_map(|r| r.ok())
                .collect()
            } else {
                stmt.query_map(
                    rusqlite::params![session_id, limit as i64],
                    |row| {
                        let data_str: String = row.get(4)?;
                        Ok(Record {
                            id: row.get(0)?,
                            session_id: row.get(1)?,
                            turn_id: row.get(2)?,
                            record_type: row.get(3)?,
                            data_json: serde_json::from_str(&data_str)
                                .unwrap_or_default(),
                            created_at: row.get(5)?,
                        })
                    },
                )?
                .filter_map(|r| r.ok())
                .collect()
            };

            Ok(rows)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::store::SqliteStore;

    #[test]
    fn test_append_and_get_records() {
        let store = RecordStore::new(SqliteStore::in_memory().unwrap());

        let id = store
            .append_record(&RecordInput {
                session_id: "sess-1".into(),
                turn_id: "turn-1".into(),
                record_type: "user_message".into(),
                data_json: serde_json::json!({"text": "hello"}),
                created_at: "2025-01-01T00:00:00Z".into(),
            })
            .unwrap();

        let records = store.get_records("sess-1", None, 10).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].id, id);
        assert_eq!(records[0].record_type, "user_message");
        assert_eq!(records[0].data_json["text"], "hello");
    }

    #[test]
    fn test_get_records_after_id() {
        let store = RecordStore::new(SqliteStore::in_memory().unwrap());

        let id1 = store
            .append_record(&RecordInput {
                session_id: "sess-1".into(),
                turn_id: "turn-1".into(),
                record_type: "type_a".into(),
                data_json: Value::Null,
                created_at: "2025-01-01T00:00:00Z".into(),
            })
            .unwrap();
        let _id2 = store
            .append_record(&RecordInput {
                session_id: "sess-1".into(),
                turn_id: "turn-2".into(),
                record_type: "type_b".into(),
                data_json: Value::Null,
                created_at: "2025-01-01T00:00:01Z".into(),
            })
            .unwrap();

        // Fetch only records after id1
        let records = store.get_records("sess-1", Some(id1), 10).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].record_type, "type_b");
    }

    #[test]
    fn test_get_records_respects_limit() {
        let store = RecordStore::new(SqliteStore::in_memory().unwrap());

        for i in 0..10 {
            store
                .append_record(&RecordInput {
                    session_id: "sess-1".into(),
                    turn_id: format!("turn-{i}"),
                    record_type: "test".into(),
                    data_json: Value::Null,
                    created_at: format!("2025-01-01T00:00:{i:02}Z"),
                })
                .unwrap();
        }

        let records = store.get_records("sess-1", None, 3).unwrap();
        assert_eq!(records.len(), 3);
    }

    #[test]
    fn test_get_records_empty_session() {
        let store = RecordStore::new(SqliteStore::in_memory().unwrap());
        let records = store.get_records("nonexistent", None, 10).unwrap();
        assert!(records.is_empty());
    }

    #[test]
    fn test_get_records_scoped_to_session() {
        let store = RecordStore::new(SqliteStore::in_memory().unwrap());
        store
            .append_record(&RecordInput {
                session_id: "sess-1".into(),
                turn_id: "turn-1".into(),
                record_type: "a".into(),
                data_json: Value::Null,
                created_at: "2025-01-01T00:00:00Z".into(),
            })
            .unwrap();

        let records = store.get_records("sess-2", None, 10).unwrap();
        assert!(records.is_empty());
    }
}