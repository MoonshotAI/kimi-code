//! Session method family — the engine's session surface, ported from
//! `packages/kimi-agent/src/main.rs`. The processor owns a
//! `SessionManager` (engine state) exactly as the stdio server does;
//! handlers are the same logic, organized by method family.

use std::sync::Arc;

use kimi_agent::persistence::{SessionStore, SqliteStore};
use kimi_agent::session::manager::SessionManager;
use kimi_protocol::rpc::JsonRpcError;
use kimi_protocol::wire_types::SessionGoalParams;
use tokio::sync::Mutex;

use crate::processor::{MessageProcessor, Processor};

/// Open the engine's session store (`$KIMI_AGENT_HOME/sessions.db` or
/// in-memory) — mirrors `open_session_store` in main.rs.
pub fn open_session_store() -> anyhow::Result<SqliteStore> {
    match std::env::var("KIMI_AGENT_HOME") {
        Ok(dir) if !dir.trim().is_empty() => {
            let path = std::path::Path::new(dir.trim()).join("sessions.db");
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            SqliteStore::open(&path)
        }
        _ => SqliteStore::in_memory(),
    }
}

/// Session methods, backed by a shared engine `SessionManager`.
pub struct SessionProcessor {
    manager: Arc<Mutex<SessionManager>>,
}

impl SessionProcessor {
    /// Create with a fresh engine session manager (own store).
    pub fn new() -> anyhow::Result<Self> {
        let store = open_session_store()?;
        let manager = Arc::new(Mutex::new(SessionManager::new(SessionStore::new(store))));
        Ok(Self { manager })
    }

    /// Expose the shared manager (for tests / future processors).
    pub fn manager(&self) -> Arc<Mutex<SessionManager>> {
        self.manager.clone()
    }
}

impl Processor for SessionProcessor {
    fn register(&self, processor: &mut MessageProcessor) {
        // `session/get_status` — live engine status snapshot.
        let mgr = self.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_GET_STATUS, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: SessionGoalParams = serde_json::from_value(params)
                    .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = mgr.lock().await;
                let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                    JsonRpcError::internal_error(format!(
                        "no agent for session: {}",
                        input.session_id
                    ))
                })?;
                serde_json::to_value(agent.session_status())
                    .map_err(|e| JsonRpcError::internal_error(format!("serialize: {e}")))
            })
        });

        // `session/list` — persisted session summaries.
        let mgr = self.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_LIST, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: kimi_protocol::wire_types::SessionListParams =
                    serde_json::from_value(params).unwrap_or_default();
                let manager = mgr.lock().await;
                let sessions = manager
                    .list_persisted(input.limit.unwrap_or(50), input.offset.unwrap_or(0))
                    .map_err(|e| JsonRpcError::internal_error(e.to_string()))?
                    .into_iter()
                    .map(|record| {
                        // The rich session record (work_dir/title) lives inside
                        // state_json; degrade gracefully to the id-only shape.
                        let rich =
                            serde_json::from_value::<kimi_agent::session::types::SessionRecord>(
                                record.state_json.clone(),
                            )
                            .unwrap_or_else(|_| {
                                kimi_agent::session::types::SessionRecord::new(
                                    record.id.clone(),
                                    kimi_agent::session::types::ModelConfig::default(),
                                )
                            });
                        kimi_protocol::wire_types::SessionSummaryRpc {
                            id: record.id,
                            created_at: record.created_at,
                            updated_at: record.updated_at,
                            title: rich.title,
                            work_dir: rich.work_dir,
                        }
                    })
                    .collect::<Vec<_>>();
                serde_json::to_value(kimi_protocol::wire_types::SessionListResult { sessions })
                    .map_err(|e| JsonRpcError::internal_error(format!("session/list serialize failed: {e}")))
            })
        });

        // `session/get_usage` — cumulative token usage.
        let mgr = self.manager.clone();
        processor.register(kimi_protocol::methods::SESSION_GET_USAGE, move |params| {
            let mgr = mgr.clone();
            Box::pin(async move {
                let input: SessionGoalParams = serde_json::from_value(params)
                    .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut manager = mgr.lock().await;
                let agent = manager.get_agent(&input.session_id).ok_or_else(|| {
                    JsonRpcError::internal_error(format!(
                        "no agent for session: {}",
                        input.session_id
                    ))
                })?;
                serde_json::to_value(agent.usage.data())
                    .map_err(|e| JsonRpcError::internal_error(e.to_string()))
            })
        });
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use kimi_protocol::rpc::JsonRpcRequest;

    #[tokio::test]
    async fn get_status_missing_session_yields_engine_error() {
        let processor = SessionProcessor::new().expect("session processor");
        let mut server = MessageProcessor::new();
        processor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "session/get_status".into(),
                params: serde_json::json!({ "session_id": "does-not-exist" }),
            })
            .await;
        assert_eq!(body["error"]["message"], "no agent for session: does-not-exist");
    }

    #[tokio::test]
    async fn list_returns_empty_page() {
        let processor = SessionProcessor::new().expect("session processor");
        let mut server = MessageProcessor::new();
        processor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "session/list".into(),
                params: serde_json::json!({ "limit": 5 }),
            })
            .await;
        assert!(body.get("error").is_none(), "session/list should not error: {body}");
        assert_eq!(body["result"]["sessions"], serde_json::json!([]));
    }


    #[tokio::test]
    async fn get_usage_missing_session_yields_engine_error() {
        let processor = SessionProcessor::new().expect("session processor");
        let mut server = MessageProcessor::new();
        processor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "session/get_usage".into(),
                params: serde_json::json!({ "session_id": "nope" }),
            })
            .await;
        assert_eq!(body["error"]["message"], "no agent for session: nope");
    }
}
