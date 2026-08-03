//! Background-task method family (register/list/get/stop), ported from
//! main.rs. The processor owns a `BackgroundManager` with the SQLite
//! background store for persistence/ghost restore.

use std::sync::{Arc, Mutex};

use kimi_agent::background::manager::BackgroundManager;
use kimi_agent::background::types::BackgroundTaskKind;
use kimi_agent::background::persist::BackgroundTaskPersistence;
use kimi_agent::persistence::SqliteBackgroundStore;
use kimi_protocol::rpc::JsonRpcError;
use kimi_protocol::wire_types::{
    BgGetParams, BgRegisterParams, BgRegisterResult, BgStopParams,
};

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

/// Background-task methods.
pub struct BgProcessor {
    manager: Arc<Mutex<BackgroundManager>>,
    persist: Arc<SqliteBackgroundStore>,
}

impl BgProcessor {
    /// Create with a fresh manager + persisted ghost restore.
    pub fn new() -> anyhow::Result<Self> {
        let store = open_task_store()?;
        let persist = Arc::new(SqliteBackgroundStore::new(store.clone()).map_err(anyhow::Error::msg)?);
        let manager = Arc::new(Mutex::new(BackgroundManager::new(None)));
        {
            let mut mgr = manager.lock().unwrap_or_else(|e| e.into_inner());
            match persist.list() {
                Ok(infos) => {
                    for info in infos {
                        mgr.add_ghost(info);
                    }
                }
                Err(e) => eprintln!("[background] restore from disk failed: {e}"),
            }
            mgr.set_persist(persist.clone());
        }
        Ok(Self { manager, persist })
    }
}

impl Processor for BgProcessor {
    fn register(&self, processor: &mut MessageProcessor) {
        // `bg/register` — register a background task.
        let bm = self.manager.clone();
        processor.register(kimi_protocol::methods::BG_REGISTER, move |params| {
            let bm = bm.clone();
            Box::pin(async move {
                let input: BgRegisterParams = serde_json::from_value(params)
                    .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let kind = match input.kind.as_str() {
                    "process" => BackgroundTaskKind::Process,
                    "agent" => BackgroundTaskKind::Agent,
                    "question" => BackgroundTaskKind::Question,
                    other => {
                        return Ok(serde_json::to_value(&BgRegisterResult {
                            task_id: None,
                            error: Some(format!("Unknown task kind: {other}")),
                        })
                        .unwrap());
                    }
                };
                let mut manager = bm.lock().unwrap_or_else(|e| e.into_inner());
                let opts = kimi_agent::background::types::RegisterOptions {
                    detached: input.detached.unwrap_or(false),
                    timeout_ms: input.timeout_ms,
                    ..Default::default()
                };
                let task_id = manager.register(&input.prefix, kind, input.description, Some(opts));
                serde_json::to_value(&BgRegisterResult {
                    task_id,
                    error: None,
                })
                .map_err(|e| JsonRpcError::internal_error(format!("Serialize error: {e}")))
            })
        });

        // `bg/list` — all background task infos.
        let bm = self.manager.clone();
        processor.register(kimi_protocol::methods::BG_LIST, move |_| {
            let bm = bm.clone();
            Box::pin(async move {
                let manager = bm.lock().unwrap_or_else(|e| e.into_inner());
                let infos = manager.list_infos();
                serde_json::to_value(&infos)
                    .map_err(|e| JsonRpcError::internal_error(format!("Serialize error: {e}")))
            })
        });

        // `bg/get` — one task.
        let bm = self.manager.clone();
        processor.register(kimi_protocol::methods::BG_GET, move |params| {
            let bm = bm.clone();
            Box::pin(async move {
                let input: BgGetParams = serde_json::from_value(params)
                    .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let manager = bm.lock().unwrap_or_else(|e| e.into_inner());
                match manager.get(&input.task_id) {
                    Some(t) => serde_json::to_value(&t.to_info()).map_err(|e| {
                        JsonRpcError::internal_error(format!("Serialize error: {e}"))
                    }),
                    None => Ok(serde_json::Value::Null),
                }
            })
        });

        // `bg/stop` — stop a task.
        let bm = self.manager.clone();
        processor.register(kimi_protocol::methods::BG_STOP, move |params| {
            let bm = bm.clone();
            Box::pin(async move {
                let input: BgStopParams = serde_json::from_value(params)
                    .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = bm.lock().unwrap_or_else(|e| e.into_inner());
                match manager.stop(&input.task_id, input.reason) {
                    Ok(()) => Ok(serde_json::json!({ "ok": true })),
                    Err(e) => Err(JsonRpcError::internal_error(e)),
                }
            })
        });

        // `bg/output` — output snapshot (live or ghost-fallback).
        let bm = self.manager.clone();
        let bp = self.persist.clone();
        processor.register(kimi_protocol::methods::BG_OUTPUT, move |params| {
            let bm = bm.clone();
            let bp = bp.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::BgOutputParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let manager = bm.lock().unwrap_or_else(|e| e.into_inner());
                let snapshot = manager.get_output_snapshot(&input.task_id);
                match snapshot {
                    Some(s) => serde_json::to_value(&kimi_protocol::wire_types::BgOutputResult {
                        output_path: s.output_path,
                        output_size_bytes: s.output_size_bytes,
                        preview_bytes: s.preview_bytes,
                        truncated: s.truncated,
                        full_output_available: s.full_output_available,
                        preview: s.preview,
                        error: None,
                    })
                    .map_err(|e| JsonRpcError::internal_error(format!("Serialize error: {e}"))),
                    None => {
                        let output = bp.read_output(&input.task_id);
                        match output {
                            Ok(text) => {
                                let max_preview = 1024 * 1024usize;
                                let preview: String = text.chars().take(max_preview).collect();
                                let size = text.len() as u64;
                                Ok(serde_json::to_value(
                                    &kimi_protocol::wire_types::BgOutputResult {
                                        output_path: None,
                                        output_size_bytes: size,
                                        preview_bytes: preview.len() as u64,
                                        truncated: size > preview.len() as u64,
                                        full_output_available: true,
                                        preview,
                                        error: None,
                                    },
                                )
                                .map_err(|e| {
                                    JsonRpcError::internal_error(format!("Serialize error: {e}"))
                                })?)
                            }
                            Err(e) => Ok(serde_json::to_value(
                                &kimi_protocol::wire_types::BgOutputResult {
                                    output_path: None,
                                    output_size_bytes: 0,
                                    preview_bytes: 0,
                                    truncated: false,
                                    full_output_available: false,
                                    preview: String::new(),
                                    error: Some(e),
                                },
                            )
                            .unwrap()),
                        }
                    }
                }
            })
        });

        // `bg/append_output` — append a chunk to a task's output.
        let bm = self.manager.clone();
        let bp = self.persist.clone();
        processor.register(kimi_protocol::methods::BG_APPEND_OUTPUT, move |params| {
            let bm = bm.clone();
            let bp = bp.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::BgAppendOutputParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = bm.lock().unwrap_or_else(|e| e.into_inner());
                match manager.append_output(&input.task_id, &input.chunk) {
                    Ok(()) => {
                        let _ = bp.append_output(&input.task_id, &input.chunk);
                        Ok(serde_json::json!({ "ok": true }))
                    }
                    Err(e) => Err(JsonRpcError::internal_error(e)),
                }
            })
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kimi_protocol::rpc::JsonRpcRequest;

    #[tokio::test]
    async fn bg_register_then_list() {
        let processor = BgProcessor::new().expect("bg processor");
        let mut server = MessageProcessor::new();
        processor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "bg/register".into(),
                params: serde_json::json!({
                    "prefix": "test",
                    "kind": "process",
                    "description": "smoke",
                }),
            })
            .await;
        assert!(body.get("error").is_none(), "bg/register failed: {body}");
        let id = body["result"]["task_id"].as_str().expect("task_id").to_string();

        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(2),
                method: "bg/list".into(),
                params: serde_json::Value::Null,
            })
            .await;
        assert!(body.get("error").is_none());
        let tasks = body["result"].as_array().expect("array");
        assert!(
            tasks.iter().any(|t| t["base"]["task_id"] == id),
            "registered task listed: {body}"
        );
    }
}
