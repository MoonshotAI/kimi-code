/// Persistence module — SQLite-backed storage engine for sessions, records,
/// cron tasks, background tasks, and blob data.
pub mod background_store;
pub mod cron_store;
pub mod record_store;
pub mod session_store;
pub mod store;
pub mod task_store;

pub use background_store::SqliteBackgroundStore;
pub use cron_store::SqliteCronStore;
pub use record_store::{Record, RecordInput, RecordStore};
pub use session_store::{SessionRecord, SessionStore};
pub use store::SqliteStore;
pub use task_store::SqliteTaskStore;