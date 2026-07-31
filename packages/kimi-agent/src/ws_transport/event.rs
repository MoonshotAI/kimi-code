/// WS event types and envelopes for the v2 protocol.

use serde::{Deserialize, Serialize};

/// The WS protocol version this implementation supports.
pub const WS_PROTOCOL_VERSION: u32 = 2;

/// Event type classification for WS v2 protocol.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WsEventType {
    /// Server hello — first message after connection.
    ServerHello,
    /// Acknowledge for a control message.
    Ack,
    /// Application event (durable or volatile).
    Event,
    /// Resync required notification.
    ResyncRequired,
    /// Ping (client→server or server→client).
    Ping,
    /// Pong (response to ping).
    Pong,
    /// Subscribe to a session's events.
    Subscribe,
    /// Unsubscribe from a session's events.
    Unsubscribe,
    /// Batched events (when server supports batching).
    EventBatch,
}

/// A WS event envelope — the wire format for events.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WsEventEnvelope {
    /// Event type identifier (e.g., "assistant.delta", "tool.result").
    #[serde(rename = "type")]
    pub event_type: String,
    /// Sequence number (durable events only). Absent for volatile events.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    /// Epoch identifier (durable events only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epoch: Option<String>,
    /// Whether this event is volatile (does not advance seq).
    #[serde(default)]
    pub volatile: bool,
    /// For volatile text-delta frames: cumulative character offset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u64>,
    /// Session ID this event belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Timestamp (ISO 8601).
    pub timestamp: String,
    /// The event payload.
    pub payload: serde_json::Value,
}

impl WsEventEnvelope {
    /// Create a new durable event envelope.
    pub fn durable(
        event_type: impl Into<String>,
        seq: u64,
        epoch: impl Into<String>,
        session_id: impl Into<String>,
        payload: serde_json::Value,
    ) -> Self {
        Self {
            event_type: event_type.into(),
            seq: Some(seq),
            epoch: Some(epoch.into()),
            volatile: false,
            offset: None,
            session_id: Some(session_id.into()),
            timestamp: current_timestamp(),
            payload,
        }
    }

    /// Create a new volatile event envelope (no seq/epoch advancement).
    pub fn volatile(
        event_type: impl Into<String>,
        session_id: impl Into<String>,
        offset: Option<u64>,
        payload: serde_json::Value,
    ) -> Self {
        Self {
            event_type: event_type.into(),
            seq: None,
            epoch: None,
            volatile: true,
            offset,
            session_id: Some(session_id.into()),
            timestamp: current_timestamp(),
            payload,
        }
    }

    /// Check if this is a durable event.
    pub fn is_durable(&self) -> bool {
        !self.volatile
    }

    /// Check if this is a volatile event.
    pub fn is_volatile(&self) -> bool {
        self.volatile
    }
}

/// Get current timestamp as ISO 8601 string (simplified).
pub fn current_timestamp() -> String {
    use std::time::SystemTime;
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    // Simple formatting - good enough for event timestamps
    format!("2024-01-01T{:02}:{:02}:{:02}Z", (secs / 3600) % 24, (secs / 60) % 60, secs % 60)
}

/// A control message envelope (request/response).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WsControlEnvelope {
    #[serde(rename = "type")]
    pub control_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub payload: serde_json::Value,
}

/// An ack envelope (response to a control message).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WsAckEnvelope {
    #[serde(rename = "type")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub _type: Option<String>,
    pub id: String,
    pub code: i32,
    pub msg: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
}

/// Server hello payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerHelloPayload {
    pub ws_connection_id: String,
    pub protocol_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heartbeat_ms: Option<u64>,
    pub max_event_buffer_size: u64,
    pub capabilities: ServerCapabilities,
}

/// Server capabilities.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerCapabilities {
    pub event_batching: bool,
    pub compression: bool,
}

/// Subscribe payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscribePayload {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<super::cursor::SessionCursor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_ids: Option<Vec<String>>,
}

/// Resync required payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResyncRequiredPayload {
    pub reason: ResyncReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epoch: Option<String>,
}

/// Reasons a resync may be required.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResyncReason {
    EpochChanged,
    BufferOverflow,
    ServerRestart,
    Manual,
}

/// A processed WS event with metadata.
#[derive(Debug, Clone)]
pub struct WsEvent {
    /// The raw envelope.
    pub envelope: WsEventEnvelope,
    /// The session this event belongs to.
    pub session_id: String,
    /// Whether this event advances the session cursor.
    pub advances_cursor: bool,
    /// The seq number if durable.
    pub seq: Option<u64>,
}

impl WsEvent {
    /// Create a WsEvent from an envelope.
    pub fn from_envelope(envelope: WsEventEnvelope) -> Self {
        let advances_cursor = envelope.is_durable();
        let seq = envelope.seq;
        let session_id = envelope.session_id.clone().unwrap_or_default();
        Self {
            envelope,
            session_id,
            advances_cursor,
            seq,
        }
    }

    /// Get the event type.
    pub fn event_type(&self) -> &str {
        &self.envelope.event_type
    }

    /// Check if this is a volatile event.
    pub fn is_volatile(&self) -> bool {
        self.envelope.is_volatile()
    }

    /// Check if this is a durable event.
    pub fn is_durable(&self) -> bool {
        self.envelope.is_durable()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_durable_event() {
        let event = WsEventEnvelope::durable(
            "tool.result",
            42,
            "epoch-1",
            "session-1",
            serde_json::json!({"tool_call_id": "tc1", "output": "result"}),
        );
        assert!(event.is_durable());
        assert!(!event.is_volatile());
        assert_eq!(event.seq, Some(42));
        assert_eq!(event.epoch, Some("epoch-1".into()));
    }

    #[test]
    fn test_volatile_event() {
        let event = WsEventEnvelope::volatile(
            "assistant.delta",
            "session-1",
            Some(100),
            serde_json::json!({"delta": "Hello"}),
        );
        assert!(!event.is_durable());
        assert!(event.is_volatile());
        assert_eq!(event.seq, None);
        assert_eq!(event.offset, Some(100));
    }

    #[test]
    fn test_ws_event_from_envelope() {
        let envelope = WsEventEnvelope::durable(
            "tool.result",
            10,
            "epoch-2",
            "session-5",
            serde_json::json!({}),
        );
        let ws_event = WsEvent::from_envelope(envelope);
        assert_eq!(ws_event.session_id, "session-5");
        assert!(ws_event.advances_cursor);
        assert_eq!(ws_event.seq, Some(10));
    }

    #[test]
    fn test_server_hello_serialization() {
        let hello = ServerHelloPayload {
            ws_connection_id: "conn-123".into(),
            protocol_version: 2,
            heartbeat_ms: None,
            max_event_buffer_size: 10000,
            capabilities: ServerCapabilities {
                event_batching: true,
                compression: false,
            },
        };
        let json = serde_json::to_string(&hello).unwrap();
        assert!(json.contains("conn-123"));
        assert!(json.contains("\"protocol_version\":2"));
    }
}
