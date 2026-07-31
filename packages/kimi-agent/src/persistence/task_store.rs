//! SQLite-backed [`TaskPersistence`] — persists task records and output logs
//! natively instead of delegating to the JS host.
//!
//! `TaskInfoBase` is stored as one JSON row per task in `task_records`; output
//! chunks accumulate in the append-only `task_output` table. Both tables are
//! created on construction, so the store is self-contained.

use std::sync::Arc;

use crate::persistence::store::SqliteStore;
use crate::task::types::{TaskInfoBase, TaskOutputSnapshot};
use crate::task::TaskPersistence;

/// A [`TaskPersistence`] backed by `task_records` (one JSON row per task) and
/// `task_output` (append-only output chunks).
pub struct SqliteTaskStore {
    store: Arc<SqliteStore>,
}

impl SqliteTaskStore {
    pub fn new(store: Arc<SqliteStore>) -> Result<Self, String> {
        store
            .with_conn(|c| {
                c.execute_batch(
                    "CREATE TABLE IF NOT EXISTS task_records (
                         task_id   TEXT PRIMARY KEY,
                         info_json TEXT NOT NULL
                     );
                     CREATE TABLE IF NOT EXISTS task_output (
                         id      INTEGER PRIMARY KEY AUTOINCREMENT,
                         task_id TEXT NOT NULL,
                         chunk   TEXT NOT NULL
                     );
                     CREATE INDEX IF NOT EXISTS idx_task_output_task
                         ON task_output(task_id, id);",
                )?;
                Ok(())
            })
            .map_err(|e| e.to_string())?;
        Ok(Self { store })
    }

    fn read_full_output(&self, task_id: &str) -> Result<String, String> {
        self.store
            .with_conn(|c| {
                let mut stmt =
                    c.prepare("SELECT chunk FROM task_output WHERE task_id = ?1 ORDER BY id")?;
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

impl TaskPersistence for SqliteTaskStore {
    fn write_task(&self, info: &TaskInfoBase) -> Result<(), String> {
        let json = serde_json::to_string(info).map_err(|e| e.to_string())?;
        let task_id = info.task_id.clone();
        self.store
            .with_conn(|c| {
                c.execute(
                    "INSERT OR REPLACE INTO task_records (task_id, info_json) VALUES (?1, ?2)",
                    rusqlite::params![task_id, json],
                )?;
                Ok(())
            })
            .map_err(|e| e.to_string())
    }

    fn list_tasks(&self) -> Result<Vec<TaskInfoBase>, String> {
        self.store
            .with_conn(|c| {
                let mut stmt = c.prepare("SELECT info_json FROM task_records")?;
                let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
                let mut out = Vec::new();
                for row in rows {
                    let json = row?;
                    if let Ok(info) = serde_json::from_str::<TaskInfoBase>(&json) {
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
                    "INSERT INTO task_output (task_id, chunk) VALUES (?1, ?2)",
                    rusqlite::params![task_id, chunk],
                )?;
                Ok(())
            })
            .map_err(|e| e.to_string())
    }

    fn read_output_snapshot(
        &self,
        task_id: &str,
        max_preview_bytes: usize,
    ) -> Result<Option<TaskOutputSnapshot>, String> {
        let full = self.read_full_output(task_id)?;
        if full.is_empty() {
            return Ok(None);
        }
        let total = full.len();
        let preview = if total > max_preview_bytes {
            // Truncate on a UTF-8 char boundary at or below the byte budget.
            let mut end = max_preview_bytes;
            while end > 0 && !full.is_char_boundary(end) {
                end -= 1;
            }
            full[..end].to_string()
        } else {
            full.clone()
        };
        let truncated = preview.len() < total;
        Ok(Some(TaskOutputSnapshot {
            output_path: None,
            output_size_bytes: total,
            preview_bytes: preview.len(),
            truncated,
            full_output_available: true,
            preview,
        }))
    }

    fn remove_task(&self, task_id: &str) -> Result<(), String> {
        self.store
            .with_conn(|c| {
                c.execute(
                    "DELETE FROM task_records WHERE task_id = ?1",
                    rusqlite::params![task_id],
                )?;
                c.execute(
                    "DELETE FROM task_output WHERE task_id = ?1",
                    rusqlite::params![task_id],
                )?;
                Ok(())
            })
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task::types::TaskStatus;

    fn store() -> SqliteTaskStore {
        SqliteTaskStore::new(Arc::new(SqliteStore::in_memory().unwrap())).unwrap()
    }

    fn info(task_id: &str) -> TaskInfoBase {
        TaskInfoBase {
            task_id: task_id.into(),
            description: "work".into(),
            status: TaskStatus::Running,
            kind: "process".into(),
            started_at: 1_700_000_000_000,
            ended_at: None,
            detached: false,
            stop_reason: None,
            terminal_notification_suppressed: false,
            timeout_ms: None,
            agent_id: None,
        }
    }

    #[test]
    fn write_then_list_roundtrips() {
        let s = store();
        s.write_task(&info("bash-abc12345")).unwrap();
        let all = s.list_tasks().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].task_id, "bash-abc12345");
        assert_eq!(all[0].kind, "process");
        assert_eq!(all[0].status, TaskStatus::Running);
    }

    #[test]
    fn write_is_upsert() {
        let s = store();
        s.write_task(&info("bash-abc12345")).unwrap();
        let mut updated = info("bash-abc12345");
        updated.status = TaskStatus::Completed;
        s.write_task(&updated).unwrap();
        let all = s.list_tasks().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].status, TaskStatus::Completed);
    }

    #[test]
    fn output_snapshot_none_when_empty() {
        let s = store();
        assert!(s
            .read_output_snapshot("bash-abc12345", 1024)
            .unwrap()
            .is_none());
    }

    #[test]
    fn output_snapshot_reports_size_and_preview() {
        let s = store();
        s.append_output("bash-abc12345", "hello ").unwrap();
        s.append_output("bash-abc12345", "world").unwrap();
        let snap = s
            .read_output_snapshot("bash-abc12345", 1024)
            .unwrap()
            .unwrap();
        assert_eq!(snap.output_size_bytes, 11);
        assert_eq!(snap.preview, "hello world");
        assert!(!snap.truncated);
        assert!(snap.full_output_available);
    }

    #[test]
    fn output_snapshot_truncates_preview() {
        let s = store();
        s.append_output("bash-abc12345", "abcdefghij").unwrap();
        let snap = s.read_output_snapshot("bash-abc12345", 4).unwrap().unwrap();
        assert_eq!(snap.output_size_bytes, 10);
        assert_eq!(snap.preview, "abcd");
        assert!(snap.truncated);
        assert_eq!(snap.preview_bytes, 4);
    }

    #[test]
    fn remove_clears_info_and_output() {
        let s = store();
        s.write_task(&info("bash-abc12345")).unwrap();
        s.append_output("bash-abc12345", "x").unwrap();
        s.remove_task("bash-abc12345").unwrap();
        assert!(s.list_tasks().unwrap().is_empty());
        assert!(s
            .read_output_snapshot("bash-abc12345", 1024)
            .unwrap()
            .is_none());
    }
}
