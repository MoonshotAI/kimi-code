//! Cron method family — scheduled prompt tasks (create/delete/list/
//! get_next_fire), ported from main.rs. The processor owns a `CronManager`.

use std::sync::{Arc, Mutex};

use kimi_agent::cron::manager::CronManager;
use kimi_protocol::rpc::JsonRpcError;
use kimi_protocol::wire_types::{
    CronCreateParams, CronCreateResult, CronDeleteParams, CronDeleteResult,
    CronGetNextFireParams, CronGetNextFireResult, CronListResult, CronTaskSnapshotRpc,
};

use crate::processor::{MessageProcessor, Processor};

/// Cron methods.
pub struct CronProcessor {
    manager: Arc<Mutex<CronManager>>,
}

impl CronProcessor {
    /// Create with a fresh cron manager + initialized scheduler (main.rs
    /// calls `start()` once at engine init; the scheduler computes next-fire
    /// times on demand — no background loop is spawned).
    pub fn new() -> Self {
        let manager = Arc::new(Mutex::new(CronManager::new(None)));
        {
            let mut mgr = manager.lock().unwrap_or_else(|e| e.into_inner());
            mgr.start();
        }
        Self { manager }
    }
}

impl Processor for CronProcessor {
    fn register(&self, processor: &mut MessageProcessor) {
        // `cron/create` — add a scheduled prompt task.
        let cm = self.manager.clone();
        processor.register(kimi_protocol::methods::CRON_CREATE, move |params| {
            let cm = cm.clone();
            Box::pin(async move {
                let input: CronCreateParams = serde_json::from_value(params)
                    .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = cm.lock().unwrap_or_else(|e| e.into_inner());
                let task = manager.add_task(kimi_agent::cron::types::CronTaskInit {
                    cron: input.cron,
                    prompt: input.prompt,
                    recurring: input.recurring,
                });
                let recurring = task.is_recurring();
                serde_json::to_value(&CronCreateResult {
                    id: task.id,
                    cron: task.cron,
                    prompt: task.prompt,
                    created_at: task.created_at,
                    recurring,
                })
                .map_err(|e| JsonRpcError::internal_error(format!("Serialize error: {e}")))
            })
        });

        // `cron/delete` — remove tasks by id.
        let cm = self.manager.clone();
        processor.register(kimi_protocol::methods::CRON_DELETE, move |params| {
            let cm = cm.clone();
            Box::pin(async move {
                let input: CronDeleteParams = serde_json::from_value(params)
                    .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let ids: Vec<&str> = input.ids.iter().map(|s| s.as_str()).collect();
                let mut manager = cm.lock().unwrap_or_else(|e| e.into_inner());
                let removed = manager.remove_tasks(&ids);
                serde_json::to_value(&CronDeleteResult { removed })
                    .map_err(|e| JsonRpcError::internal_error(format!("Serialize error: {e}")))
            })
        });

        // `cron/list` — snapshot all tasks.
        let cm = self.manager.clone();
        processor.register(kimi_protocol::methods::CRON_LIST, move |_| {
            let cm = cm.clone();
            Box::pin(async move {
                let mut manager = cm.lock().unwrap_or_else(|e| e.into_inner());
                let snapshots = manager.list_task_snapshots();
                let tasks: Vec<CronTaskSnapshotRpc> = snapshots
                    .into_iter()
                    .map(|s| CronTaskSnapshotRpc {
                        id: s.id,
                        cron: s.cron,
                        recurring: s.recurring,
                        created_at: s.created_at,
                        last_fired_at: s.last_fired_at,
                        next_fire_at: s.next_fire_at,
                    })
                    .collect();
                serde_json::to_value(&CronListResult { tasks })
                    .map_err(|e| JsonRpcError::internal_error(format!("Serialize error: {e}")))
            })
        });

        // `cron/get_next_fire` — next fire time (task or global).
        let cm = self.manager.clone();
        processor.register(kimi_protocol::methods::CRON_GET_NEXT_FIRE, move |params| {
            let cm = cm.clone();
            Box::pin(async move {
                let input: CronGetNextFireParams = serde_json::from_value(params)
                    .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = cm.lock().unwrap_or_else(|e| e.into_inner());
                let next_fire_at = match input.task_id {
                    Some(id) => manager.get_next_fire_for_task(&id),
                    None => manager.get_next_fire_time(),
                };
                serde_json::to_value(&CronGetNextFireResult { next_fire_at })
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
    async fn cron_create_then_list() {
        let processor = CronProcessor::new();
        let mut server = MessageProcessor::new();
        processor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "cron/create".into(),
                params: serde_json::json!({
                    "cron": "0 9 * * *",
                    "prompt": "morning",
                    "recurring": true,
                }),
            })
            .await;
        assert!(body.get("error").is_none(), "cron/create failed: {body}");
        let id = body["result"]["id"].as_str().expect("id").to_string();
        assert!(id.len() >= 8, "id should be generated: {id}");

        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(2),
                method: "cron/list".into(),
                params: serde_json::Value::Null,
            })
            .await;
        let tasks = body["result"]["tasks"].as_array().expect("tasks");
        assert!(tasks.iter().any(|t| t["id"] == id), "created task in list");
    }

    #[tokio::test]
    async fn cron_get_next_fire_then_delete() {
        let processor = CronProcessor::new();
        let mut server = MessageProcessor::new();
        processor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "cron/create".into(),
                params: serde_json::json!({
                    "cron": "0 9 * * *",
                    "prompt": "morning",
                    "recurring": true,
                }),
            })
            .await;
        assert!(body.get("error").is_none(), "cron/create failed: {body}");
        let id = body["result"]["id"].as_str().expect("id").to_string();

        // The scheduler computes a next fire time for the task.
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(2),
                method: "cron/get_next_fire".into(),
                params: serde_json::json!({ "task_id": id }),
            })
            .await;
        assert!(body.get("error").is_none(), "get_next_fire failed: {body}");
        assert!(
            body["result"]["next_fire_at"].is_u64(),
            "a next fire time is scheduled: {body}"
        );

        // Global next-fire mirrors the only task's slot (params must be an
        // object — `{}` — matching the engine contract; null is rejected).
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(3),
                method: "cron/get_next_fire".into(),
                params: serde_json::json!({}),
            })
            .await;
        assert!(body.get("error").is_none(), "global next fire failed: {body}");
        assert!(body["result"]["next_fire_at"].is_u64(), "global next fire: {body}");

        // Deleting the task empties the schedule again.
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(4),
                method: "cron/delete".into(),
                params: serde_json::json!({ "ids": [id] }),
            })
            .await;
        assert!(body.get("error").is_none(), "cron/delete failed: {body}");

        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(5),
                method: "cron/get_next_fire".into(),
                params: serde_json::json!({}),
            })
            .await;
        assert_eq!(body["result"]["next_fire_at"], serde_json::Value::Null);
    }
}
