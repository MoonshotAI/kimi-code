/// Background task callbacks — delegates actual process management to the JS host.
///
/// The Rust side is responsible for state tracking only. The JS host provides
/// the actual implementations for spawning/killing processes and subagents.

use crate::background::types::{AgentHandle, ProcessHandle};

/// Callbacks for background task process management.
pub trait BackgroundCallbacks {
    /// Spawn a process and return a handle.
    fn spawn_process(
        &self,
        command: &str,
        args: &[String],
    ) -> Result<ProcessHandle, String>;

    /// Kill a process by PID.
    fn kill_process(&self, pid: u32) -> Result<(), String>;

    /// Spawn a subagent and return a handle.
    fn spawn_subagent(
        &self,
        subagent_type: &str,
        prompt: &str,
    ) -> Result<AgentHandle, String>;

    /// Kill a subagent by agent ID.
    fn kill_subagent(&self, agent_id: &str) -> Result<(), String>;
}

/// A mock implementation for testing.
pub struct MockBackgroundCallbacks {
    pub next_pid: std::sync::atomic::AtomicU32,
    pub spawn_results: std::sync::Mutex<Vec<Result<ProcessHandle, String>>>,
}

impl MockBackgroundCallbacks {
    pub fn new() -> Self {
        Self {
            next_pid: std::sync::atomic::AtomicU32::new(1000),
            spawn_results: std::sync::Mutex::new(Vec::new()),
        }
    }
}

impl Default for MockBackgroundCallbacks {
    fn default() -> Self {
        Self::new()
    }
}

impl BackgroundCallbacks for MockBackgroundCallbacks {
    fn spawn_process(&self, _command: &str, _args: &[String]) -> Result<ProcessHandle, String> {
        let mut results = self.spawn_results.lock().unwrap();
        if !results.is_empty() {
            results.remove(0)
        } else {
            let pid = self.next_pid.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(ProcessHandle {
                pid,
                native_process_id: format!("mock-{}", pid),
            })
        }
    }

    fn kill_process(&self, pid: u32) -> Result<(), String> {
        eprintln!("[mock] kill process {}", pid);
        Ok(())
    }

    fn spawn_subagent(&self, _subagent_type: &str, _prompt: &str) -> Result<AgentHandle, String> {
        Ok(AgentHandle {
            agent_id: "mock-agent-1".into(),
        })
    }

    fn kill_subagent(&self, agent_id: &str) -> Result<(), String> {
        eprintln!("[mock] kill subagent {}", agent_id);
        Ok(())
    }
}