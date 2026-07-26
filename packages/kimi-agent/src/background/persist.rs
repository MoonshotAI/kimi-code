/// Background task persistence.
///
/// Each task lives at `<sessionDir>/tasks/<taskId>/` with:
/// - `info.json` — task metadata
/// - `output.log` — full output log
///
/// The actual file I/O is delegated to the JS host via callbacks.

use crate::background::types::BackgroundTaskInfo;

/// Trait for background task persistence.
pub trait BackgroundTaskPersistence: Send + Sync {
    /// Write a task's info to persistent storage.
    fn write_info(&self, info: &BackgroundTaskInfo) -> Result<(), String>;

    /// Remove a task from persistent storage.
    fn remove(&self, task_id: &str) -> Result<(), String>;

    /// List all tasks from persistent storage.
    fn list(&self) -> Result<Vec<BackgroundTaskInfo>, String>;

    /// Append output to a task's output log.
    fn append_output(&self, task_id: &str, chunk: &str) -> Result<(), String>;

    /// Read the full output log for a task.
    fn read_output(&self, task_id: &str) -> Result<String, String>;
}

/// A no-op persistence that discards all writes.
/// Used for ephemeral sessions (subagents, tests).
pub struct NullBackgroundTaskPersistence;

impl BackgroundTaskPersistence for NullBackgroundTaskPersistence {
    fn write_info(&self, _info: &BackgroundTaskInfo) -> Result<(), String> {
        Ok(())
    }

    fn remove(&self, _task_id: &str) -> Result<(), String> {
        Ok(())
    }

    fn list(&self) -> Result<Vec<BackgroundTaskInfo>, String> {
        Ok(vec![])
    }

    fn append_output(&self, _task_id: &str, _chunk: &str) -> Result<(), String> {
        Ok(())
    }

    fn read_output(&self, _task_id: &str) -> Result<String, String> {
        Ok(String::new())
    }
}

/// A persistence backed by closure-based callbacks.
/// The JS host provides the closures.
pub struct CallbackBackgroundTaskPersistence {
    write_info_fn: Box<dyn Fn(&BackgroundTaskInfo) -> Result<(), String> + Send + Sync>,
    remove_fn: Box<dyn Fn(&str) -> Result<(), String> + Send + Sync>,
    list_fn: Box<dyn Fn() -> Result<Vec<BackgroundTaskInfo>, String> + Send + Sync>,
    append_output_fn: Box<dyn Fn(&str, &str) -> Result<(), String> + Send + Sync>,
    read_output_fn: Box<dyn Fn(&str) -> Result<String, String> + Send + Sync>,
}

impl CallbackBackgroundTaskPersistence {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        write_info_fn: Box<dyn Fn(&BackgroundTaskInfo) -> Result<(), String> + Send + Sync>,
        remove_fn: Box<dyn Fn(&str) -> Result<(), String> + Send + Sync>,
        list_fn: Box<dyn Fn() -> Result<Vec<BackgroundTaskInfo>, String> + Send + Sync>,
        append_output_fn: Box<dyn Fn(&str, &str) -> Result<(), String> + Send + Sync>,
        read_output_fn: Box<dyn Fn(&str) -> Result<String, String> + Send + Sync>,
    ) -> Self {
        Self {
            write_info_fn,
            remove_fn,
            list_fn,
            append_output_fn,
            read_output_fn,
        }
    }
}

impl BackgroundTaskPersistence for CallbackBackgroundTaskPersistence {
    fn write_info(&self, info: &BackgroundTaskInfo) -> Result<(), String> {
        (self.write_info_fn)(info)
    }

    fn remove(&self, task_id: &str) -> Result<(), String> {
        (self.remove_fn)(task_id)
    }

    fn list(&self) -> Result<Vec<BackgroundTaskInfo>, String> {
        (self.list_fn)()
    }

    fn append_output(&self, task_id: &str, chunk: &str) -> Result<(), String> {
        (self.append_output_fn)(task_id, chunk)
    }

    fn read_output(&self, task_id: &str) -> Result<String, String> {
        (self.read_output_fn)(task_id)
    }
}

/// Valid task ID pattern: `{prefix}-{8 base36 chars}`.
/// The prefix is intentionally open-ended so new task kinds don't need
/// persistence-layer changes.
pub fn is_valid_task_id(task_id: &str) -> bool {
    if !task_id.contains('-') {
        return false;
    }
    let parts: Vec<&str> = task_id.rsplitn(2, '-').collect();
    if parts.len() != 2 {
        return false;
    }
    let suffix = parts[0];
    let prefix = parts[1];
    if prefix.is_empty() || suffix.is_empty() {
        return false;
    }
    if suffix.len() != 8 {
        return false;
    }
    suffix.chars().all(|c| c.is_ascii_alphanumeric())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_task_id() {
        assert!(is_valid_task_id("bash-abc12345"));
        assert!(is_valid_task_id("agent-00000000"));
        assert!(is_valid_task_id("question-zzzzzzzz"));
    }

    #[test]
    fn test_invalid_task_id() {
        assert!(!is_valid_task_id(""));
        assert!(!is_valid_task_id("no-dash"));
        assert!(!is_valid_task_id("bash-abc"));
        assert!(!is_valid_task_id("bash-../etc/passwd"));
        assert!(!is_valid_task_id("bash-"));
        assert!(!is_valid_task_id("-abc12345"));
    }

    #[test]
    fn test_null_persistence() {
        let p = NullBackgroundTaskPersistence;
        let info = BackgroundTaskInfo::Process(crate::background::types::ProcessBackgroundTaskInfo {
            base: crate::background::types::BackgroundTaskInfoBase {
                task_id: "test-abc123".into(),
                description: "test".into(),
                status: crate::background::types::BackgroundTaskStatus::Running,
                detached: None,
                started_at: 0,
                ended_at: None,
                stop_reason: None,
                terminal_notification_suppressed: None,
                timeout_ms: None,
            },
            kind: crate::background::types::BackgroundTaskKind::Process,
            command: "echo".into(),
            pid: 0,
            exit_code: None,
        });
        assert!(p.write_info(&info).is_ok());
        assert!(p.remove("test-abc123").is_ok());
        assert!(p.list().unwrap().is_empty());
        assert!(p.append_output("test-abc123", "hello").is_ok());
        assert!(p.read_output("test-abc123").unwrap().is_empty());
    }
}