//! Health / version processors — the canonical minimal example for a
//! method-family module, and the smoke check for the protocol layer.

use kimi_protocol::rpc::JsonRpcError;

use crate::processor::{MessageProcessor, Processor};

/// Health + version methods.
pub struct HealthProcessor;

impl Processor for HealthProcessor {
    fn register(&self, processor: &mut MessageProcessor) {
        processor.register(kimi_protocol::methods::HEALTH, |_params| async move {
            Ok(serde_json::json!({ "status": "ok" }))
        });
        // A second method to prove multi-method dispatch.
        processor.register("agent/version", |_params| async move {
            Ok(serde_json::json!({ "version": env!("CARGO_PKG_VERSION") }))
        });
        // An error path to prove error envelopes round-trip.
        processor.register("agent/boom", |_params| async move {
            Err(JsonRpcError::internal_error("kaboom".into()))
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kimi_protocol::rpc::JsonRpcRequest;

    #[tokio::test]
    async fn health_returns_ok() {
        let mut server = MessageProcessor::new();
        HealthProcessor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "agent/health".into(),
                params: serde_json::Value::Null,
            })
            .await;
        assert!(body.get("error").is_none(), "health errored: {body}");
        assert_eq!(body["result"]["status"], "ok");
    }

    #[tokio::test]
    async fn version_returns_crate_version() {
        let mut server = MessageProcessor::new();
        HealthProcessor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "agent/version".into(),
                params: serde_json::Value::Null,
            })
            .await;
        assert!(body.get("error").is_none());
        assert!(
            body["result"]["version"].as_str().is_some_and(|v| !v.is_empty()),
            "version present: {body}"
        );
    }

    #[tokio::test]
    async fn boom_returns_error_envelope() {
        let mut server = MessageProcessor::new();
        HealthProcessor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "agent/boom".into(),
                params: serde_json::Value::Null,
            })
            .await;
        assert!(body.get("error").is_some(), "boom should error: {body}");
        assert_eq!(body["error"]["code"], -32603);
    }
}
