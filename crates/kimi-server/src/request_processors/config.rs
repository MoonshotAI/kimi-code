//! Config method family — engine config read, ported from the engine's
//! `config/get` handler. The engine owns the config source of truth
//! (`kimi_agent::config::loader`); this processor is the host-facing surface.

use kimi_protocol::rpc::JsonRpcError;

use crate::processor::{MessageProcessor, Processor};

/// Config methods.
pub struct ConfigProcessor;

impl Processor for ConfigProcessor {
    fn register(&self, processor: &mut MessageProcessor) {
        // `config/get` — the engine's parsed config.toml (KimiConfig shape).
        processor.register(kimi_protocol::methods::CONFIG_GET, |_params| async move {
            match kimi_agent::config::loader::load_config_with_env() {
                Ok(config) => serde_json::to_value(&config)
                    .map_err(|e| JsonRpcError::internal_error(format!("Serialize error: {e}"))),
                Err(error) => Err(JsonRpcError::internal_error(format!("config load: {error}"))),
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kimi_protocol::rpc::JsonRpcRequest;

    #[tokio::test]
    async fn config_get_returns_kimi_config() {
        let mut processor = MessageProcessor::new();
        ConfigProcessor.register(&mut processor);
        let body = processor
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "config/get".into(),
                params: serde_json::Value::Null,
            })
            .await;
        // KimiConfig serializes to an object; no error envelope.
        assert!(body.get("error").is_none(), "config/get should not error: {body}");
        assert!(body["result"].is_object() || body["result"].is_null());
    }
}
