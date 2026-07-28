/// Session commands — CLI integration for session management.
///
/// Provides clap subcommands for listing, restoring, deleting, and exporting
/// sessions.  Intended to be composed into the top-level CLI parser.
use clap::Subcommand;

use crate::session::manager::SessionManager;
use crate::session::types::SessionRecord;

// ── CLI subcommand ──────────────────────────────────────────────────────────

/// Session management commands.
#[derive(Debug, Subcommand)]
pub enum SessionCommand {
    /// List all sessions (most recent first).
    List {
        /// Maximum number of sessions to display.
        #[arg(long, default_value = "20")]
        limit: usize,
        /// Number of sessions to skip.
        #[arg(long, default_value = "0")]
        offset: usize,
    },
    /// Resume (restore) a session by id.
    Resume {
        /// Session id to resume.
        id: String,
    },
    /// Delete a session by id.
    Delete {
        /// Session id to delete.
        id: String,
        /// Skip confirmation prompt.
        #[arg(long)]
        force: bool,
    },
    /// Show details of the current (active) session.
    Current,
    /// Export a session to JSON on stdout.
    Export {
        /// Session id to export.  Exports the active session if omitted.
        #[arg(short, long)]
        id: Option<String>,
        /// Pretty-print the JSON output.
        #[arg(long)]
        pretty: bool,
    },
}

impl SessionCommand {
    /// Execute the command against the given session manager.
    ///
    /// Returns a human-readable result string for display.
    pub fn execute(&self, manager: &mut SessionManager) -> anyhow::Result<String> {
        match self {
            SessionCommand::List { limit, offset } => execute_list(manager, *limit, *offset),
            SessionCommand::Resume { id } => execute_resume(manager, id),
            SessionCommand::Delete { id, force: _ } => execute_delete(manager, id),
            SessionCommand::Current => execute_current(manager),
            SessionCommand::Export { id, pretty } => execute_export(manager, id.as_deref(), *pretty),
        }
    }
}

// ── Command implementations ─────────────────────────────────────────────────

fn execute_list(manager: &SessionManager, limit: usize, offset: usize) -> anyhow::Result<String> {
    let sessions = manager.list_sessions(limit, offset)?;
    if sessions.is_empty() {
        return Ok("No sessions found.".to_string());
    }

    let active_id = manager.active_session_id().unwrap_or("");
    let mut lines = Vec::with_capacity(sessions.len() + 2);

    lines.push(format!(
        "{:<24} {:<8} {:<8} {:<30} {}",
        "ID", "STATE", "MSGS", "MODEL", "UPDATED"
    ));
    lines.push("-".repeat(90));

    for session in &sessions {
        let marker = if session.id == active_id { "* " } else { "  " };
        let state = format!("{:?}", session.state);
        let msg_count = session.messages.len();
        let model = &session.model_config.model;
        let updated = &session.updated_at;

        // Truncate long fields for display.
        let model_short = if model.len() > 28 {
            format!("{}…", &model[..27])
        } else {
            model.clone()
        };

        lines.push(format!(
            "{}{:<22} {:<8} {:<8} {:<30} {}",
            marker, session.id, state, msg_count, model_short, updated
        ));
    }

    Ok(lines.join("\n"))
}

fn execute_resume(manager: &mut SessionManager, id: &str) -> anyhow::Result<String> {
    match manager.resume_session(id) {
        Some(session) => Ok(format!(
            "Resumed session {} ({} messages, model: {})",
            session.id,
            session.messages.len(),
            session.model_config.model,
        )),
        None => Ok(format!("Session not found: {id}")),
    }
}

fn execute_delete(manager: &mut SessionManager, id: &str) -> anyhow::Result<String> {
    manager.delete_session(id)?;
    Ok(format!("Deleted session {id}"))
}

fn execute_current(manager: &SessionManager) -> anyhow::Result<String> {
    match manager.active_session() {
        Some(session) => Ok(format!(
            "Active session: {} ({} messages, model: {}, state: {:?})",
            session.id,
            session.messages.len(),
            session.model_config.model,
            session.state,
        )),
        None => Ok("No active session.".to_string()),
    }
}

fn execute_export(
    manager: &SessionManager,
    id: Option<&str>,
    pretty: bool,
) -> anyhow::Result<String> {
    let sessions = match id {
        Some(sid) => {
            let list = manager.list_sessions(1, 0)?;
            list.into_iter().filter(|s| s.id == sid).collect::<Vec<_>>()
        }
        None => {
            if let Some(active) = manager.active_session() {
                vec![active.clone()]
            } else {
                vec![]
            }
        }
    };

    let record = match sessions.into_iter().next() {
        Some(r) => r,
        None => return Ok("No session to export.".to_string()),
    };

    if pretty {
        Ok(serde_json::to_string_pretty(&record)?)
    } else {
        Ok(serde_json::to_string(&record)?)
    }
}

/// Format a list of session records as a compact one-line-per-session table.
pub fn format_session_table(sessions: &[SessionRecord], active_id: Option<&str>) -> String {
    if sessions.is_empty() {
        return "No sessions.".to_string();
    }

    let mut lines = vec![format!(
        "{:<3} {:<24} {:<8} {:<8} {:<30} {}",
        "", "ID", "STATE", "MSGS", "MODEL", "UPDATED"
    )];
    lines.push("-".repeat(90));

    for session in sessions {
        let marker = if active_id == Some(&session.id) {
            " *"
        } else {
            "  "
        };
        let model_short = if session.model_config.model.len() > 28 {
            format!("{}…", &session.model_config.model[..27])
        } else {
            session.model_config.model.clone()
        };
        lines.push(format!(
            "{:<3} {:<24} {:<8} {:<8} {:<30} {}",
            marker,
            session.id,
            format!("{:?}", session.state),
            session.messages.len(),
            model_short,
            session.updated_at,
        ));
    }

    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::session_store::SessionStore;
    use crate::persistence::store::SqliteStore;
    use crate::session::types::ModelConfig;
    use crate::session::SessionManager;

    fn test_manager() -> SessionManager {
        let store = SessionStore::new(SqliteStore::in_memory().unwrap());
        SessionManager::new(store)
    }

    fn test_model() -> ModelConfig {
        ModelConfig {
            provider: "anthropic".into(),
            model: "claude-sonnet-4-20250514".into(),
            max_tokens: Some(8192),
        }
    }

    #[test]
    fn test_list_empty() {
        let mgr = test_manager();
        let output = execute_list(&mgr, 10, 0).unwrap();
        assert_eq!(output, "No sessions found.");
    }

    #[test]
    fn test_list_with_sessions() {
        let mut mgr = test_manager();
        mgr.create_session("sess-1", test_model());
        mgr.create_session("sess-2", test_model());
        let output = execute_list(&mgr, 10, 0).unwrap();
        assert!(output.contains("sess-1"));
        assert!(output.contains("sess-2"));
    }

    #[test]
    fn test_resume_nonexistent() {
        let mut mgr = test_manager();
        let output = execute_resume(&mut mgr, "missing").unwrap();
        assert!(output.contains("not found"));
    }

    #[test]
    fn test_delete() {
        let mut mgr = test_manager();
        mgr.create_session("sess-1", test_model());
        let output = execute_delete(&mut mgr, "sess-1").unwrap();
        assert!(output.contains("Deleted"));
    }

    #[test]
    fn test_current_no_active() {
        let mgr = test_manager();
        let output = execute_current(&mgr).unwrap();
        assert_eq!(output, "No active session.");
    }

    #[test]
    fn test_current_with_active() {
        let mut mgr = test_manager();
        mgr.create_session("sess-1", test_model());
        let output = execute_current(&mgr).unwrap();
        assert!(output.contains("sess-1"));
    }

    #[test]
    fn test_export_active() {
        let mut mgr = test_manager();
        mgr.create_session("sess-1", test_model());
        let output = execute_export(&mgr, None, false).unwrap();
        assert!(output.contains("sess-1"));
    }

    #[test]
    fn test_format_table() {
        let sessions = vec![SessionRecord::new("sess-1", test_model())];
        let table = format_session_table(&sessions, Some("sess-1"));
        assert!(table.contains("sess-1"));
        assert!(table.contains("*"));
    }
}