//! In-process client — bounded channel bridging a caller to the
//! `MessageProcessor`, mirroring codex's `in_process` module: the same
//! JSON-RPC envelope is used for in-process and transport calls, so a host
//! cannot tell (and does not need to tell) which path a call took.

use std::sync::Arc;

use kimi_protocol::rpc::JsonRpcRequest;
use tokio::sync::{mpsc, oneshot};

use crate::processor::MessageProcessor;

/// Request in flight on the channel.
struct Call {
    request: JsonRpcRequest,
    reply: oneshot::Sender<serde_json::Value>,
}

/// A handle for making in-process JSON-RPC calls.
#[derive(Clone)]
pub struct InProcessClient {
    tx: mpsc::Sender<Call>,
}

impl InProcessClient {
    /// Make a JSON-RPC call; resolves with the full wire response body.
    pub async fn call(&self, method: &str, params: serde_json::Value) -> serde_json::Value {
        let (reply, rx) = oneshot::channel();
        let request = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: serde_json::json!(1),
            method: method.to_string(),
            params,
        };
        if self.tx.send(Call { request, reply }).await.is_err() {
            return serde_json::json!({ "jsonrpc": "2.0", "id": 1, "error": { "code": -32000, "message": "processor dropped" } });
        }
        rx.await.unwrap_or_default()
    }
}

/// Spawn the worker task that dispatches calls onto `processor`, returning a
/// client handle. The worker owns the processor; callers only see the handle.
///
/// Requests are handled **concurrently**: each call spawns its own task so a
/// long-running handler (a prompt turn that holds the manager lock for the
/// whole turn) never starves control-plane requests (`session/cancel`,
/// `session/steer`, status reads…). Those handlers cooperate via the
/// per-session cancel/steer flags and the `busy` map, which is exactly why a
/// blocked prompt must not also block the worker.
pub fn spawn(processor: MessageProcessor) -> InProcessClient {
    let processor = Arc::new(processor);
    let (tx, mut rx) = mpsc::channel::<Call>(64);
    tokio::spawn(async move {
        while let Some(call) = rx.recv().await {
            let processor = processor.clone();
            tokio::spawn(async move {
                let response = processor.handle(call.request).await;
                let _ = call.reply.send(response);
            });
        }
    });
    InProcessClient { tx }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::processor::{MessageProcessor, Processor};
    use crate::request_processors::HealthProcessor;

    #[tokio::test]
    async fn in_process_round_trip() {
        let mut processor = MessageProcessor::new();
        HealthProcessor.register(&mut processor);
        let client = spawn(processor);
        let body = client
            .call("agent/health", serde_json::Value::Null)
            .await;
        assert_eq!(body["result"]["status"], "ok");

        let body = client
            .call("agent/nope", serde_json::Value::Null)
            .await;
        assert_eq!(body["error"]["code"], -32601);
    }
}
