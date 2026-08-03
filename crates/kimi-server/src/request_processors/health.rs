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
