//! SQLite-backed [`BackgroundTaskPersistence`] — persists background task
//! metadata and output logs natively instead of delegating to the JS host.
//!
//! Task metadata is stored as a whole-record JSON document (the
//! `BackgroundTaskInfo` untagged enum round-trips through serde), keyed by task
//! id; output chunks accumulate in an append-only table. Both tables are
//! created on construction, so this store is self-contained.

use std::sync::Arc;

use crate::background::persist::BackgroundTaskPersistence;
use crate::background::types::BackgroundTaskInfo;
use crate::persistence::store::SqliteStore;

/// A [`BackgroundTaskPersistence`] backed by `bg_task_records` (one JSON row
/// per task) and `bg_task_output` (append-only output chunks).
pub struct SqliteBackgroundStore {
    store: Arc<SqliteStore>,
}

impl SqliteBackgroundStore {
    pub fn new(store: Arc<SqliteStore>) -> Result<Self, String> {
        store
            .with_conn(|c| {
                c.execute_batch(
                    "CREATE TABLE IF NOT EXISTS bg_task_records (
                         task_id   TEXT PRIMARY KEY,
                         info_json TEXT NOT NULL
                     );
                     CREATE TABLE IF NOT EXISTS bg_task_output (
                         id      INTEGER PRIMARY KEY AUTOINCREMENT,
                         task_id TEXT NOT NULL,
                         chunk   TEXT NOT NULL
                     );
                     CREATE INDEX IF NOT EXISTS idx_bg_output_task
                         ON bg_task_output(task_id, id);",
                )?;
                Ok(())
            })
            .map_err(|e| e.to_string())?;
        Ok(Self { store })
    }
}

impl BackgroundTaskPersistence for SqliteBackgroundStore {
    fn write_info(&self, info: &BackgroundTaskInfo) -> Result<(), String> {
        let json = serde_json::to_string(info).map_err(|e| e.to_string())?;
        let task_id = info.task_id().to_string();
        self.store
            .with_conn(|c| {
                c.execute(
                    "INSERT OR REPLACE INTO bg_task_records (task_id, info_json)
                     VALUES (?1, ?2)",
                    rusqlite::params![task_id, json],
                )?;
                Ok(())
            })
            .map_err(|e| e.to_string())
    }

    fn remove(&self, task_id: &str) -> Result<(), String> {
        self.store
            .with_conn(|c| {
                c.execute(
                    "DELETE FROM bg_task_records WHERE task_id = ?1",
                    rusqlite::params![task_id],
                )?;
                c.execute(
                    "DELETE FROM bg_task_output WHERE task_id = ?1",
                    rusqlite::params![task_id],
                )?;
                Ok(())
            })
            .map_err(|e| e.to_string())
    }

    fn list(&self) -> Result<Vec<BackgroundTaskInfo>, String> {
        self.store
            .with_conn(|c| {
                let mut stmt = c.prepare("SELECT info_json FROM bg_task_records")?;
                let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
                let mut out = Vec::new();
                for row in rows {
                    let json = row?;
                    if let Ok(info) = serde_json::from_str::<BackgroundTaskInfo>(&json) {
                        out.push(info);
                    }
                }
                Ok(out)
            })
            .map_err(|e| e.to_string())
    }

    fn append_output(&self, task_id: &str, chunk: &str) -> Result<(), String> {
        self.store
            .with_conn(|c| {
                c.execute(
                    "INSERT INTO bg_task_output (task_id, chunk) VALUES (?1, ?2)",
                    rusqlite::params![task_id, chunk],
                )?;
                Ok(())
            })
            .map_err(|e| e.to_string())
    }

    fn read_output(&self, task_id: &str) -> Result<String, String> {
        self.store
            .with_conn(|c| {
                let mut stmt = c.prepare(
                    "SELECT chunk FROM bg_task_output WHERE task_id = ?1 ORDER BY id",
                )?;
                let rows =
                    stmt.query_map(rusqlite::params![task_id], |row| row.get::<_, String>(0))?;
                let mut buf = String::new();
                for row in rows {
                    buf.push_str(&row?);
                }
                Ok(buf)
            })
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::background::types::{
        BackgroundTaskInfoBase, BackgroundTaskKind, BackgroundTaskStatus, ProcessBackgroundTaskInfo,
    };

    fn store() -> SqliteBackgroundStore {
        SqliteBackgroundStore::new(Arc::new(SqliteStore::in_memory().unwrap())).unwrap()
    }

    fn process(task_id: &str) -> BackgroundTaskInfo {
        BackgroundTaskInfo::Process(ProcessBackgroundTaskInfo {
            base: BackgroundTaskInfoBase {
                task_id: task_id.into(),
                description: "run".into(),
                status: BackgroundTaskStatus::Running,
                detached: None,
                started_at: 1_700_000_000_000,
                ended_at: None,
                stop_reason: None,
                terminal_notification_suppressed: None,
                timeout_ms: None,
            },
            kind: BackgroundTaskKind::Process,
            command: "echo hi".into(),
            pid: 4242,
            exit_code: None,
        })
    }

    #[test]
    fn write_then_list_roundtrips_process() {
        let s = store();
        s.write_info(&process("bash-abc12345")).unwrap();
        let all = s.list().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].task_id(), "bash-abc12345");
        match &all[0] {
            BackgroundTaskInfo::Process(p) => {
                assert_eq!(p.command, "echo hi");
                assert_eq!(p.pid, 4242);
            }
            _ => panic!("expected Process variant"),
        }
    }

    #[test]
    fn write_is_upsert() {
        let s = store();
        s.write_info(&process("bash-abc12345")).unwrap();
        s.write_info(&process("bash-abc12345")).unwrap();
        assert_eq!(s.list().unwrap().len(), 1);
    }

    #[test]
    fn remove_clears_info_and_output() {
        let s = store();
        s.write_info(&process("bash-abc12345")).unwrap();
        s.append_output("bash-abc12345", "hello ").unwrap();
        s.remove("bash-abc12345").unwrap();
        assert!(s.list().unwrap().is_empty());
        assert_eq!(s.read_output("bash-abc12345").unwrap(), "");
    }

    #[test]
    fn append_output_accumulates_in_order() {
        let s = store();
        s.append_output("bash-abc12345", "hello ").unwrap();
        s.append_output("bash-abc12345", "world").unwrap();
        assert_eq!(s.read_output("bash-abc12345").unwrap(), "hello world");
    }

    #[test]
    fn read_output_empty_for_unknown_task() {
        let s = store();
        assert_eq!(s.read_output("nope-00000000").unwrap(), "");
    }
}
