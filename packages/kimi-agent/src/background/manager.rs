/// BackgroundManager — manages background tasks for an agent.
///
/// Tracks background bash tasks, subagent tasks, and question tasks.
///
/// Each task gets a unique ID, captures output to a ring buffer,
/// and supports status query / output retrieval / stop operations.
///
/// Rust side is responsible for state tracking only. Actual process
/// management (spawn, kill, stream) is delegated to the JS host via
/// callbacks.

use std::collections::HashMap;

use crate::background::callbacks::BackgroundCallbacks;
use crate::background::managed_task::{ManagedTask, ManagedTaskState};
use crate::background::types::*;
use crate::cron::clock::ClockSources;

/// Maximum number of concurrently running tasks (None = no cap).
const MAX_RUNNING_TASKS_ENV: &str = "KIMI_CODE_BACKGROUND_MAX_RUNNING_TASKS";

/// Maximum bytes of combined output kept in the ring buffer per task.
const MAX_OUTPUT_BYTES: u64 = 1024 * 1024; // 1 MiB

/// Maximum combined output per process task before force-termination.
const MAX_TASK_OUTPUT_BYTES: u64 = 16 * 1024 * 1024; // 16 MiB

/// Available characters for task ID generation.
const ID_CHARS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";

/// Generate a task ID in the form `{prefix}-{8 base36 chars}`.
fn generate_task_id(prefix: &str) -> String {
    let mut id = String::with_capacity(prefix.len() + 9);
    id.push_str(prefix);
    id.push('-');
    for _ in 0..8 {
        let idx = fastrand::usize(0..ID_CHARS.len());
        id.push(ID_CHARS[idx] as char);
    }
    id
}

/// The BackgroundManager.
pub struct BackgroundManager {
    /// Active tasks.
    tasks: HashMap<String, ManagedTask>,
    /// Ghosts: tasks loaded from disk that have no live process.
    ghosts: HashMap<String, BackgroundTaskInfo>,
    /// Callbacks for process management (delegated to JS host).
    callbacks: Option<Box<dyn BackgroundCallbacks + Send>>,
    /// Clock source.
    clocks: ClockSources,
    /// Maximum running tasks (None = no cap).
    max_running_tasks: Option<usize>,
}

impl BackgroundManager {
    /// Create a new BackgroundManager.
    pub fn new(clocks: Option<ClockSources>) -> Self {
        let max_running = std::env::var(MAX_RUNNING_TASKS_ENV)
            .ok()
            .and_then(|v| v.trim().parse::<usize>().ok())
            .filter(|&n| n > 0);

        Self {
            tasks: HashMap::new(),
            ghosts: HashMap::new(),
            callbacks: None,
            clocks: clocks.unwrap_or_default(),
            max_running_tasks: max_running,
        }
    }

    /// Set the callbacks for process management.
    pub fn set_callbacks(&mut self, callbacks: Box<dyn BackgroundCallbacks + Send>) {
        self.callbacks = Some(callbacks);
    }

    /// Register a new background task. Returns the assigned task ID.
    /// Returns None if the concurrency cap is reached.
    pub fn register(
        &mut self,
        prefix: &str,
        kind: BackgroundTaskKind,
        description: String,
        options: Option<RegisterOptions>,
    ) -> Option<String> {
        // Check concurrency cap
        if let Some(max) = self.max_running_tasks {
            let running = self
                .tasks
                .values()
                .filter(|t| t.state == ManagedTaskState::Running)
                .count();
            if running >= max {
                return None;
            }
        }

        let task_id = generate_task_id(prefix);
        let now = (self.clocks.wall_now)();
        let opts = options.unwrap_or_default();

        let managed = ManagedTask::new(task_id.clone(), kind, description, now, opts);
        self.tasks.insert(task_id.clone(), managed);

        Some(task_id)
    }

    /// Get a task by ID.
    pub fn get(&self, task_id: &str) -> Option<&ManagedTask> {
        self.tasks.get(task_id)
    }

    /// Get a mutable reference to a task by ID.
    pub fn get_mut(&mut self, task_id: &str) -> Option<&mut ManagedTask> {
        self.tasks.get_mut(task_id)
    }

    /// Remove a task from the active map.
    pub fn unregister(&mut self, task_id: &str) -> Option<ManagedTask> {
        self.tasks.remove(task_id)
    }

    /// List all active tasks.
    pub fn list(&self) -> Vec<&ManagedTask> {
        self.tasks.values().collect()
    }

    /// List all tasks as info objects.
    pub fn list_infos(&self) -> Vec<BackgroundTaskInfo> {
        self.tasks.values().map(|t| t.to_info()).collect()
    }

    /// List all ghosts (lost tasks from previous session).
    pub fn list_ghosts(&self) -> Vec<&BackgroundTaskInfo> {
        self.ghosts.values().collect()
    }

    /// Append output to a task.
    pub fn append_output(&mut self, task_id: &str, chunk: &str) -> Result<(), String> {
        let task = self
            .tasks
            .get_mut(task_id)
            .ok_or_else(|| format!("Task {} not found", task_id))?;

        let limit_exceeded = task.append_output(chunk);
        if limit_exceeded {
            // Request stop — output limit exceeded
            task.request_stop();
            task.stop_reason = Some(format!(
                "Output limit exceeded ({} MiB)",
                MAX_TASK_OUTPUT_BYTES / (1024 * 1024)
            ));
        }
        Ok(())
    }

    /// Settle a task with a terminal status.
    pub fn settle(
        &mut self,
        task_id: &str,
        settlement: BackgroundTaskSettlement,
    ) -> Result<(), String> {
        let now = (self.clocks.wall_now)();
        let task = self
            .tasks
            .get_mut(task_id)
            .ok_or_else(|| format!("Task {} not found", task_id))?;
        task.settle(settlement, now);
        Ok(())
    }

    /// Request stop for a task.
    pub fn stop(&mut self, task_id: &str, reason: Option<String>) -> Result<(), String> {
        let task = self
            .tasks
            .get_mut(task_id)
            .ok_or_else(|| format!("Task {} not found", task_id))?;
        task.request_stop();
        task.stop_reason = reason;
        Ok(())
    }

    /// Get the output snapshot for a task.
    pub fn get_output_snapshot(&self, task_id: &str) -> Option<BackgroundTaskOutputSnapshot> {
        let task = self.tasks.get(task_id)?;
        let preview = task.output.preview(MAX_OUTPUT_BYTES as usize);
        Some(BackgroundTaskOutputSnapshot {
            output_path: None,
            output_size_bytes: task.output_size_bytes,
            preview_bytes: preview.len() as u64,
            truncated: task.output_size_bytes > MAX_OUTPUT_BYTES,
            full_output_available: false,
            preview,
        })
    }

    /// Add a ghost task (from persistence / previous session).
    pub fn add_ghost(&mut self, info: BackgroundTaskInfo) {
        self.ghosts.insert(info.task_id().to_string(), info);
    }

    /// Clear all ghosts.
    pub fn clear_ghosts(&mut self) {
        self.ghosts.clear();
    }

    /// Number of active tasks.
    pub fn task_count(&self) -> usize {
        self.tasks.len()
    }

    /// Clean up terminal tasks that have been settled for a while.
    pub fn clean_terminal_tasks(&mut self) {
        self.tasks.retain(|_, t| t.state != ManagedTaskState::Terminal);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_register_and_get() {
        let mut mgr = BackgroundManager::new(None);
        let task_id = mgr
            .register("bash", BackgroundTaskKind::Process, "echo hello".into(), None)
            .unwrap();
        assert!(task_id.starts_with("bash-"));

        let task = mgr.get(&task_id);
        assert!(task.is_some());
        assert_eq!(task.unwrap().description, "echo hello");
    }

    #[test]
    fn test_list() {
        let mut mgr = BackgroundManager::new(None);
        mgr.register("bash", BackgroundTaskKind::Process, "t1".into(), None);
        mgr.register("agent", BackgroundTaskKind::Agent, "t2".into(), None);
        assert_eq!(mgr.list().len(), 2);
    }

    #[test]
    fn test_unregister() {
        let mut mgr = BackgroundManager::new(None);
        let task_id = mgr
            .register("bash", BackgroundTaskKind::Process, "test".into(), None)
            .unwrap();
        assert!(mgr.unregister(&task_id).is_some());
        assert!(mgr.get(&task_id).is_none());
    }

    #[test]
    fn test_settle() {
        let mut mgr = BackgroundManager::new(None);
        let task_id = mgr
            .register("bash", BackgroundTaskKind::Process, "test".into(), None)
            .unwrap();
        mgr.settle(
            &task_id,
            BackgroundTaskSettlement {
                status: BackgroundTaskSettlementStatus::Completed,
                stop_reason: None,
            },
        )
        .unwrap();

        let task = mgr.get(&task_id).unwrap();
        assert_eq!(task.status, BackgroundTaskStatus::Completed);
        assert!(task.ended_at.is_some());
    }

    #[test]
    fn test_append_output() {
        let mut mgr = BackgroundManager::new(None);
        let task_id = mgr
            .register("bash", BackgroundTaskKind::Process, "test".into(), None)
            .unwrap();
        mgr.append_output(&task_id, "hello world").unwrap();
        let snapshot = mgr.get_output_snapshot(&task_id).unwrap();
        assert_eq!(snapshot.output_size_bytes, 11);
    }

    #[test]
    fn test_stop() {
        let mut mgr = BackgroundManager::new(None);
        let task_id = mgr
            .register("bash", BackgroundTaskKind::Process, "test".into(), None)
            .unwrap();
        mgr.stop(&task_id, Some("user requested".into()))
            .unwrap();

        let task = mgr.get(&task_id).unwrap();
        assert_eq!(task.state, ManagedTaskState::Stopping);
        assert_eq!(task.stop_reason.as_deref(), Some("user requested"));
    }

    #[test]
    fn test_ghosts() {
        let mut mgr = BackgroundManager::new(None);
        let info = BackgroundTaskInfo::Process(ProcessBackgroundTaskInfo {
            base: BackgroundTaskInfoBase {
                task_id: "lost-abc123".into(),
                description: "lost task".into(),
                status: BackgroundTaskStatus::Lost,
                detached: None,
                started_at: 1000,
                ended_at: None,
                stop_reason: None,
                terminal_notification_suppressed: None,
                timeout_ms: None,
            },
            kind: BackgroundTaskKind::Process,
            command: "sleep 100".into(),
            pid: 12345,
            exit_code: None,
        });
        mgr.add_ghost(info);
        assert_eq!(mgr.list_ghosts().len(), 1);
    }

    #[test]
    fn test_clean_terminal() {
        let mut mgr = BackgroundManager::new(None);
        let id1 = mgr
            .register("bash", BackgroundTaskKind::Process, "t1".into(), None)
            .unwrap();
        let id2 = mgr
            .register("bash", BackgroundTaskKind::Process, "t2".into(), None)
            .unwrap();

        mgr.settle(
            &id1,
            BackgroundTaskSettlement {
                status: BackgroundTaskSettlementStatus::Completed,
                stop_reason: None,
            },
        )
        .unwrap();

        assert_eq!(mgr.task_count(), 2);
        mgr.clean_terminal_tasks();
        assert_eq!(mgr.task_count(), 1);
        assert!(mgr.get(&id2).is_some());
    }

    // ── Direct-call RPC integration tests ─────────────────────────────────────

    #[test]
    fn test_bg_register_via_rpc() {
        let server = std::sync::Arc::new(crate::rpc::server::RpcServer::new());
        let mgr = std::sync::Arc::new(std::sync::Mutex::new(BackgroundManager::new(None)));

        // Register bg/register handler
        let bm = mgr.clone();
        crate::rpc::server::RpcServer::register_arc(
            &server,
            crate::rpc::types::methods::BG_REGISTER,
            move |params| {
                let bm = bm.clone();
                Box::pin(async move {
                    let input: crate::rpc::types::BgRegisterParams = serde_json::from_value(params)
                        .map_err(|e| crate::rpc::types::JsonRpcError::internal_error(e.to_string()))?;
                    let kind = match input.kind.as_str() {
                        "process" => BackgroundTaskKind::Process,
                        "agent" => BackgroundTaskKind::Agent,
                        "question" => BackgroundTaskKind::Question,
                        _ => return Ok(serde_json::json!({ "task_id": null, "error": "unknown kind" })),
                    };
                    let mut mgr = bm.lock().unwrap_or_else(|e| e.into_inner());
                    let opts = RegisterOptions {
                        detached: input.detached.unwrap_or(false),
                        timeout_ms: input.timeout_ms,
                        ..Default::default()
                    };
                    let task_id = mgr.register(&input.prefix, kind, input.description, Some(opts));
                    Ok(serde_json::json!({ "task_id": task_id, "error": null }))
                })
            },
        );

        // Call via RPC
        let params = serde_json::json!({
            "prefix": "bash",
            "kind": "process",
            "description": "echo hello",
            "detached": true
        });
        let result = futures::executor::block_on(
            server.direct_call(crate::rpc::types::methods::BG_REGISTER, params)
        );
        assert!(result.is_ok());
        let val = result.unwrap();
        assert!(val["task_id"].as_str().is_some());
        assert!(val["task_id"].as_str().unwrap().starts_with("bash-"));
    }

    #[test]
    fn test_bg_settle_via_rpc() {
        let server = std::sync::Arc::new(crate::rpc::server::RpcServer::new());
        let mgr = std::sync::Arc::new(std::sync::Mutex::new(BackgroundManager::new(None)));

        // Register handler
        let bm = mgr.clone();
        crate::rpc::server::RpcServer::register_arc(
            &server,
            crate::rpc::types::methods::BG_REGISTER,
            move |params| {
                let bm = bm.clone();
                Box::pin(async move {
                    let input: crate::rpc::types::BgRegisterParams = serde_json::from_value(params)
                        .map_err(|e| crate::rpc::types::JsonRpcError::internal_error(e.to_string()))?;
                    let mut mgr = bm.lock().unwrap_or_else(|e| e.into_inner());
                    let task_id = mgr.register(&input.prefix, BackgroundTaskKind::Process, input.description, None);
                    Ok(serde_json::json!({ "task_id": task_id, "error": null }))
                })
            },
        );
        let bm = mgr.clone();
        crate::rpc::server::RpcServer::register_arc(
            &server,
            crate::rpc::types::methods::BG_SETTLE,
            move |params| {
                let bm = bm.clone();
                Box::pin(async move {
                    let input: crate::rpc::types::BgSettleParams = serde_json::from_value(params)
                        .map_err(|e| crate::rpc::types::JsonRpcError::internal_error(e.to_string()))?;
                    let status = match input.status.as_str() {
                        "completed" => BackgroundTaskSettlementStatus::Completed,
                        "failed" => BackgroundTaskSettlementStatus::Failed,
                        _ => return Err(crate::rpc::types::JsonRpcError::internal_error("unknown status".into())),
                    };
                    let mut mgr = bm.lock().unwrap_or_else(|e| e.into_inner());
                    mgr.settle(&input.task_id, BackgroundTaskSettlement {
                        status,
                        stop_reason: input.stop_reason,
                    }).map_err(|e| crate::rpc::types::JsonRpcError::internal_error(e))?;
                    Ok(serde_json::json!({ "ok": true }))
                })
            },
        );

        // Register a task first
        let reg_params = serde_json::json!({
            "prefix": "bash",
            "kind": "process",
            "description": "test task"
        });
        let reg_result = futures::executor::block_on(
            server.direct_call(crate::rpc::types::methods::BG_REGISTER, reg_params)
        ).unwrap();
        let task_id = reg_result["task_id"].as_str().unwrap().to_string();

        // Settle it
        let settle_params = serde_json::json!({
            "task_id": task_id,
            "status": "completed"
        });
        let settle_result = futures::executor::block_on(
            server.direct_call(crate::rpc::types::methods::BG_SETTLE, settle_params)
        );
        assert!(settle_result.is_ok());
        assert_eq!(settle_result.unwrap()["ok"], true);
    }
}