/// SQLite storage engine for kimi-agent persistence.
///
/// Provides automatic table creation, connection management, and
/// transaction support via rusqlite.
use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

/// Centralized SQLite storage engine.
///
/// Wraps a `rusqlite::Connection` behind a `Mutex` so it can be shared
/// across threads. All tables are created automatically on construction.
pub struct SqliteStore {
    conn: Mutex<Connection>,
}

impl SqliteStore {
    /// Open (or create) the database file at `path` and ensure all
    /// required tables exist.
    pub fn open(path: impl AsRef<Path>) -> anyhow::Result<Self> {
        let conn = Connection::open(path.as_ref())?;
        let store = Self {
            conn: Mutex::new(conn),
        };
        store.create_tables()?;
        Ok(store)
    }

    /// Open an in-memory database (for testing or ephemeral use).
    pub fn in_memory() -> anyhow::Result<Self> {
        let conn = Connection::open_in_memory()?;
        let store = Self {
            conn: Mutex::new(conn),
        };
        store.create_tables()?;
        Ok(store)
    }

    /// Access the underlying connection inside a closure, holding the
    /// mutex for the duration.
    pub fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> anyhow::Result<T>) -> anyhow::Result<T> {
        let conn = self.conn.lock().unwrap();
        f(&conn)
    }

    /// Execute all operations inside a transaction. Commits on success,
    /// rolls back on error.
    pub fn with_tx<T>(
        &self,
        f: impl FnOnce(&Connection) -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let result = f(&tx)?;
        tx.commit()?;
        Ok(result)
    }

    // ── Table creation ──────────────────────────────────────────────────────

    fn create_tables(&self) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS sessions (
                id          TEXT PRIMARY KEY,
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL,
                config_json TEXT NOT NULL DEFAULT '{}',
                state_json  TEXT NOT NULL DEFAULT '{}'
            );

            CREATE TABLE IF NOT EXISTS records (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id  TEXT NOT NULL,
                turn_id     TEXT NOT NULL,
                record_type TEXT NOT NULL,
                data_json   TEXT NOT NULL DEFAULT '{}',
                created_at  TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_records_session
                ON records(session_id, id);

            CREATE TABLE IF NOT EXISTS cron_tasks (
                id          TEXT PRIMARY KEY,
                cron_expr   TEXT NOT NULL,
                prompt      TEXT NOT NULL,
                recurring   INTEGER NOT NULL DEFAULT 1,
                created_at  TEXT NOT NULL,
                last_fired  TEXT,
                next_fire   TEXT
            );

            CREATE TABLE IF NOT EXISTS bg_tasks (
                id          TEXT PRIMARY KEY,
                kind        TEXT NOT NULL,
                description TEXT NOT NULL,
                status      TEXT NOT NULL,
                output_path TEXT,
                created_at  TEXT NOT NULL,
                settled_at  TEXT
            );

            CREATE TABLE IF NOT EXISTS blob_store (
                key         TEXT PRIMARY KEY,
                data        BLOB NOT NULL,
                mime_type   TEXT NOT NULL DEFAULT 'application/octet-stream',
                created_at  TEXT NOT NULL,
                size_bytes  INTEGER NOT NULL DEFAULT 0
            );
            ",
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_in_memory_store_opens() {
        let store = SqliteStore::in_memory().unwrap();
        store.with_conn(|c| {
            // Verify tables exist
            let mut stmt = c.prepare(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
            )?;
            let tables: Vec<String> = stmt
                .query_map([], |row| row.get(0))?
                .filter_map(|r| r.ok())
                .collect();
            assert!(tables.contains(&"sessions".into()));
            assert!(tables.contains(&"records".into()));
            assert!(tables.contains(&"cron_tasks".into()));
            assert!(tables.contains(&"bg_tasks".into()));
            assert!(tables.contains(&"blob_store".into()));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn test_transaction_commit() {
        let store = SqliteStore::in_memory().unwrap();
        store
            .with_tx(|c| {
                c.execute(
                    "INSERT INTO sessions (id, created_at, updated_at) VALUES (?1, ?2, ?3)",
                    rusqlite::params!["sess-1", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z"],
                )?;
                Ok(())
            })
            .unwrap();

        let count: i64 = store
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
                    .map_err(Into::into)
            })
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn test_transaction_rollback_on_error() {
        let store = SqliteStore::in_memory().unwrap();
        let result = store.with_tx(|c| -> anyhow::Result<()> {
            c.execute(
                "INSERT INTO sessions (id, created_at, updated_at) VALUES (?1, ?2, ?3)",
                rusqlite::params!["sess-2", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z"],
            )?;
            // Return an error to trigger rollback
            Err(anyhow::anyhow!("forced rollback"))
        });
        assert!(result.is_err());

        let count: i64 = store
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
                    .map_err(Into::into)
            })
            .unwrap();
        assert_eq!(count, 0);
    }
}