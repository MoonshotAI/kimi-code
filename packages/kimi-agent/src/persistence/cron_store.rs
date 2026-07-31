//! SQLite-backed [`CronPersistStore`] — persists cron tasks natively instead
//! of delegating file I/O to the JS host.
//!
//! Rows live in the shared `cron_tasks` table (created by [`SqliteStore`]).
//! Holds an `Arc<SqliteStore>` so the standalone binary shares one connection
//! across the session / record / cron stores.

use std::sync::Arc;

use crate::cron::persist::CronPersistStore;
use crate::cron::types::CronTask;
use crate::persistence::store::SqliteStore;

/// A [`CronPersistStore`] that reads and writes the `cron_tasks` table.
pub struct SqliteCronStore {
    store: Arc<SqliteStore>,
}

impl SqliteCronStore {
    pub fn new(store: Arc<SqliteStore>) -> Self {
        Self { store }
    }
}

impl CronPersistStore for SqliteCronStore {
    fn write(&self, task: &CronTask) -> Result<(), String> {
        self.store
            .with_conn(|c| {
                c.execute(
                    "INSERT OR REPLACE INTO cron_tasks
                       (id, cron_expr, prompt, recurring, created_at, last_fired, next_fire)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)",
                    rusqlite::params![
                        task.id,
                        task.cron,
                        task.prompt,
                        task.is_recurring() as i64,
                        task.created_at.to_string(),
                        task.last_fired_at.map(|v| v.to_string()),
                    ],
                )?;
                Ok(())
            })
            .map_err(|e| e.to_string())
    }

    fn remove(&self, id: &str) -> Result<(), String> {
        self.store
            .with_conn(|c| {
                c.execute("DELETE FROM cron_tasks WHERE id = ?1", rusqlite::params![id])?;
                Ok(())
            })
            .map_err(|e| e.to_string())
    }

    fn list(&self) -> Result<Vec<CronTask>, String> {
        self.store
            .with_conn(|c| {
                let mut stmt = c.prepare(
                    "SELECT id, cron_expr, prompt, recurring, created_at, last_fired
                     FROM cron_tasks",
                )?;
                let rows = stmt.query_map([], |row| {
                    let created_at_str: String = row.get(4)?;
                    let last_fired_str: Option<String> = row.get(5)?;
                    let recurring_int: i64 = row.get(3)?;
                    Ok(CronTask {
                        id: row.get(0)?,
                        cron: row.get(1)?,
                        prompt: row.get(2)?,
                        created_at: created_at_str.parse().unwrap_or(0),
                        recurring: Some(recurring_int != 0),
                        last_fired_at: last_fired_str.and_then(|s| s.parse().ok()),
                    })
                })?;
                let mut tasks = Vec::new();
                for row in rows {
                    tasks.push(row?);
                }
                Ok(tasks)
            })
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> SqliteCronStore {
        SqliteCronStore::new(Arc::new(SqliteStore::in_memory().unwrap()))
    }

    fn sample(id: &str, recurring: Option<bool>) -> CronTask {
        CronTask {
            id: id.to_string(),
            cron: "*/5 * * * *".to_string(),
            prompt: "ping".to_string(),
            created_at: 1_700_000_000_000,
            recurring,
            last_fired_at: None,
        }
    }

    #[test]
    fn write_then_list_roundtrips() {
        let s = store();
        s.write(&sample("aabbccdd", Some(true))).unwrap();
        let all = s.list().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "aabbccdd");
        assert_eq!(all[0].cron, "*/5 * * * *");
        assert!(all[0].is_recurring());
        assert_eq!(all[0].created_at, 1_700_000_000_000);
    }

    #[test]
    fn write_is_upsert() {
        let s = store();
        s.write(&sample("dead0001", Some(true))).unwrap();
        let mut t = sample("dead0001", Some(false));
        t.prompt = "changed".to_string();
        s.write(&t).unwrap();
        let all = s.list().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].prompt, "changed");
        assert!(!all[0].is_recurring());
    }

    #[test]
    fn remove_deletes_row() {
        let s = store();
        s.write(&sample("beef0001", Some(true))).unwrap();
        s.remove("beef0001").unwrap();
        assert!(s.list().unwrap().is_empty());
    }

    #[test]
    fn last_fired_at_roundtrips() {
        let s = store();
        let mut t = sample("cafe0001", Some(true));
        t.last_fired_at = Some(1_700_000_100_000);
        s.write(&t).unwrap();
        let all = s.list().unwrap();
        assert_eq!(all[0].last_fired_at, Some(1_700_000_100_000));
    }
}
