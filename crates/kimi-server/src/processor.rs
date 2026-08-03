//! MessageProcessor — JSON-RPC dispatch over the engine.
//!
//! Ported from the engine's `RpcServer` (`packages/kimi-agent/src/main.rs`)
//! organization: a method → handler table, where each method-family lives in
//! its own `request_processors/*` module (thread / turn / fs / git / config /
//! mcp / approvals …). Handlers are plain async functions over
//! `serde_json::Value` params, returning `Result<Value, JsonRpcError>` —
//! exactly the envelope the engine's stdio speaks today, so an in-process
//! call and a transport call are interchangeable.

use std::collections::HashMap;
use std::sync::Arc;

use kimi_protocol::rpc::{
    JsonRpcError, JsonRpcErrorResponse, JsonRpcRequest, JsonRpcResponse,
};

/// One JSON-RPC method handler: params in, result out (or an RPC error).
pub type JsonRpcHandler =
    Arc<dyn Fn(serde_json::Value) -> BoxFuture<'static, Result<serde_json::Value, JsonRpcError>> + Send + Sync>;

/// A boxed future for async handlers.
pub type BoxFuture<'a, T> = std::pin::Pin<
    Box<dyn std::future::Future<Output = T> + Send + 'a>,
>;

/// Thread-safe method registry + dispatcher (the engine's `RpcServer`).
#[derive(Default)]
pub struct MessageProcessor {
    handlers: HashMap<&'static str, JsonRpcHandler>,
}

impl MessageProcessor {
    /// Create an empty processor.
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a method handler.
    pub fn register<F, Fut>(&mut self, method: &'static str, handler: F)
    where
        F: Fn(serde_json::Value) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = Result<serde_json::Value, JsonRpcError>> + Send + 'static,
    {
        self.handlers.insert(method, Arc::new(move |params| Box::pin(handler(params))));
    }

    /// Handle one request; returns the full wire response body (success
    /// `result` or `error` envelope). Never fails to produce a response —
    /// unknown methods yield `method_not_found`.
    pub async fn handle(&self, request: JsonRpcRequest) -> serde_json::Value {
        let id = request.id;
        let method = request.method.clone();
        let Some(handler) = self.handlers.get(method.as_str()) else {
            let error = JsonRpcErrorResponse::new(id, -32601, format!("Method not found: {method}"));
            return serde_json::to_value(&error).unwrap_or_default();
        };
        match handler(request.params).await {
            Ok(result) => serde_json::to_value(&JsonRpcResponse::ok(id, result)).unwrap_or_default(),
            Err(error) => serde_json::to_value(&JsonRpcErrorResponse {
                jsonrpc: "2.0".into(),
                id,
                error,
            })
            .unwrap_or_default(),
        }
    }

    /// True when a method is registered.
    pub fn has(&self, method: &str) -> bool {
        self.handlers.contains_key(method)
    }
}

/// Helper to register a processor module's handlers onto the processor.
pub trait Processor {
    /// Register this processor's methods.
    fn register(&self, processor: &mut MessageProcessor);
}

#[cfg(test)]
mod tests {
    use super::*;
    use kimi_protocol::rpc::JsonRpcRequest;

    fn test_processor() -> MessageProcessor {
        let mut p = MessageProcessor::new();
        crate::request_processors::HealthProcessor.register(&mut p);
        p
    }

    #[tokio::test]
    async fn dispatches_known_method() {
        let p = test_processor();
        let body = p
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "agent/health".into(),
                params: serde_json::Value::Null,
            })
            .await;
        assert_eq!(body["result"]["status"], "ok");
        assert!(body.get("error").is_none());
    }

    #[tokio::test]
    async fn unknown_method_yields_method_not_found() {
        let p = test_processor();
        let body = p
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(2),
                method: "agent/nope".into(),
                params: serde_json::Value::Null,
            })
            .await;
        assert_eq!(body["error"]["code"], -32601);
    }

    #[tokio::test]
    async fn handler_error_becomes_error_envelope() {
        let p = test_processor();
        let body = p
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(3),
                method: "agent/boom".into(),
                params: serde_json::Value::Null,
            })
            .await;
        assert_eq!(body["error"]["message"], "kaboom");
        assert!(body.get("result").is_none());
    }
}
