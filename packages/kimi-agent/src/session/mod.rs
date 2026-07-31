/// Session module — comprehensive session lifecycle management.
///
/// Provides session data types, a manager for create/resume/switch/delete
/// operations, and CLI subcommands for interactive use.
pub mod commands;
pub mod export;
pub mod manager;
pub mod types;

// Re-exports
pub use commands::SessionCommand;
pub use manager::{SessionEvent, SessionManager};
pub use types::{MessageRecord, ModelConfig, SessionRecord, SessionState};