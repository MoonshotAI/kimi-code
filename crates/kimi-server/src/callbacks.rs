//! Host callbacks — the engine's back-channel to the host, provided by
//! kimi-server (the host protocol layer). Mirrors codex's model: the engine
//! stays zero-I/O and emits/requests through this trait; kimi-server owns the
//! implementation (event fan-out, LLM client, tool execution).
//!
//! This is the first slice: `emit_event` fans out to a broadcast channel the
//! interface layer subscribes to; llm/tool requests are not yet backed (the
//! native LLM + native toolset paths run engine-side), so they report a clear
//! "not configured" error rather than silently dropping.

use std::sync::Arc;

use kimi_agent::callbacks::HostCallbacks;
use kimi_protocol::wire_types::{
    BoxFuture, LlmChatRequest, LlmChatResponse, ToolExecuteRequest, ToolExecuteResponse,
};
use tokio::sync::broadcast;

/// An injectable LLM step override (SDK runtime-test hook, mirrors TS
/// `createKimiHarness({ llmStep })`). When set, `ServerHostCallbacks::llm_chat`
/// delegates to it instead of reporting "not configured", so integration tests
/// can drive real engine turns offline.
pub type LlmStep =
    Arc<dyn Fn(LlmChatRequest) -> BoxFuture<'static, Result<LlmChatResponse, String>> + Send + Sync>;

/// Event fan-out for engine `host/event` notifications.
#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<serde_json::Value>,
}

impl EventBus {
    /// Create with the given capacity (dropped when all receivers lag).
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity);
        Self { tx }
    }

    /// Subscribe to engine events.
    pub fn subscribe(&self) -> broadcast::Receiver<serde_json::Value> {
        self.tx.subscribe()
    }

    /// Clone the underlying sender, so transports (e.g. the HTTP/WS
    /// projection) can fan engine events out to every connected client.
    pub fn sender(&self) -> broadcast::Sender<serde_json::Value> {
        self.tx.clone()
    }

    /// Broadcast an event to all subscribers (lagging receivers are dropped,
    /// matching the engine's bounded fan-out).
    pub fn emit(&self, event: serde_json::Value) {
        let _ = self.tx.send(event);
    }
}

/// The kimi-server host-callback implementation.
pub struct ServerHostCallbacks {
    events: EventBus,
    /// Optional LLM step override; when absent `llm_chat` reports
    /// "not configured" (bare-server behavior).
    llm_step: Option<LlmStep>,
}

impl ServerHostCallbacks {
    /// Create with a fresh event bus.
    pub fn new() -> Self {
        Self::with_events(EventBus::new(256))
    }

    /// Create sharing a caller-provided event bus.
    pub fn with_events(events: EventBus) -> Self {
        Self {
            events,
            llm_step: None,
        }
    }

    /// Install an LLM step override (SDK runtime-test hook).
    pub fn with_llm_step(mut self, step: LlmStep) -> Self {
        self.llm_step = Some(step);
        self
    }

    /// Access the event bus (interface layer subscribes here).
    pub fn events(&self) -> EventBus {
        self.events.clone()
    }
}

impl HostCallbacks for ServerHostCallbacks {
    fn supports_tool_lifecycle(&self) -> bool {
        // No host tool-lifecycle handlers registered yet — native execution
        // is engine-side and host approval is wired via the approval store.
        false
    }

    fn llm_chat(
        &self,
        request: LlmChatRequest,
    ) -> kimi_agent::rpc::types::BoxFuture<'static, Result<LlmChatResponse, String>> {
        if let Some(step) = &self.llm_step {
            return step(request);
        }
        Box::pin(async { Err("llm_chat host callback not configured".into()) })
    }

    fn execute_tool(
        &self,
        _request: ToolExecuteRequest,
    ) -> kimi_agent::rpc::types::BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        Box::pin(async { Err("execute_tool host callback not configured".into()) })
    }

    fn emit_event(&self, event: serde_json::Value) {
        let _ = self.events.tx.send(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn emit_event_fans_out_to_subscribers() {
        let callbacks = ServerHostCallbacks::new();
        let mut rx = callbacks.events().subscribe();
        callbacks.emit_event(serde_json::json!({ "type": "session.turn.started" }));
        let event = rx.recv().await.expect("event");
        assert_eq!(event["type"], "session.turn.started");
    }
}
