//! Task method family (task/list), ported from main.rs. The processor owns a
//! `TaskService` with SQLite persistence + on-disk ghost restore.

use std::sync::{Arc, Mutex};

use kimi_agent::persistence::SqliteTaskStore;
use kimi_agent::task::TaskService;
use kimi_protocol::rpc::JsonRpcError;

use crate::processor::{MessageProcessor, Processor};

/// Open the task store (`$KIMI_AGENT_HOME/agent_tasks.db` or in-memory).
fn open_task_store() -> anyhow::Result<Arc<kimi_agent::persistence::SqliteStore>> {
    Ok(Arc::new(match std::env::var("KIMI_AGENT_HOME") {
        Ok(dir) if !dir.trim().is_empty() => {
            let path = std::path::Path::new(dir.trim()).join("agent_tasks.db");
            kimi_agent::persistence::SqliteStore::open(&path)?
        }
        _ => kimi_agent::persistence::SqliteStore::in_memory()?,
    }))
}

/// Task methods.
pub struct TaskProcessor {
    service: Arc<Mutex<TaskService>>,
}

impl TaskProcessor {
    /// Create with a fresh service + persistence + ghost restore.
    pub fn new() -> anyhow::Result<Self> {
        let store = open_task_store()?;
        let service = Arc::new(Mutex::new(TaskService::new(
            kimi_agent::task::TaskServiceConfig::default(),
        )));
        {
            let mut ts = service.lock().unwrap_or_else(|e| e.into_inner());
            match SqliteTaskStore::new(store.clone()) {
                Ok(store) => {
                    ts.set_persistence(Box::new(store));
                    if let Err(e) = ts.load_from_disk(false) {
                        eprintln!("[task] restore from disk failed: {e}");
                    }
                }
                Err(e) => eprintln!("[task] store init failed: {e}"),
            }
        }
        Ok(Self { service })
    }

    /// Expose the shared task service (tests).
    pub fn service(&self) -> Arc<Mutex<kimi_agent::task::TaskService>> {
        self.service.clone()
    }
}

impl Processor for TaskProcessor {
    fn register(&self, processor: &mut MessageProcessor) {
        // `task/list` — tracked tasks (live + ghosts).
        let ts = self.service.clone();
        processor.register(kimi_protocol::methods::TASK_LIST, move |_| {
            let ts = ts.clone();
            Box::pin(async move {
                let service = ts.lock().unwrap_or_else(|e| e.into_inner());
                let tasks = service.list(false, None);
                serde_json::to_value(&tasks)
                    .map_err(|e| JsonRpcError::internal_error(format!("Serialize error: {e}")))
            })
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kimi_protocol::rpc::JsonRpcRequest;

    #[tokio::test]
    async fn task_list_returns_array() {
        let processor = TaskProcessor::new().expect("task processor");
        let mut server = MessageProcessor::new();
        processor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "task/list".into(),
                params: serde_json::Value::Null,
            })
            .await;
        assert!(body.get("error").is_none(), "task/list failed: {body}");
        assert!(body["result"].is_array());
    }

    #[tokio::test]
    async fn task_list_shows_tracked_task() {
        let processor = TaskProcessor::new().expect("task processor");
        // Seed a tracked task through the service, as the tool runner does.
        processor
            .service()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .track(kimi_agent::task::AgentTaskTrackOptions {
                id_prefix: "bash".into(),
                description: "run tests".into(),
                kind: "process".into(),
                detached: false,
                timeout_ms: None,
                detach_timeout_ms: None,
                agent_id: None,
            })
            .expect("track");

        let mut server = MessageProcessor::new();
        processor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "task/list".into(),
                params: serde_json::Value::Null,
            })
            .await;
        assert!(body.get("error").is_none(), "task/list failed: {body}");
        let tasks = body["result"].as_array().expect("tasks array");
        assert!(
            tasks.iter().any(|t| {
                t["description"] == "run tests"
                    && t["status"] == "running"
                    && t["task_id"].as_str().is_some_and(|id| id.starts_with("bash-"))
            }),
            "tracked task listed: {body}"
        );
    }
}
