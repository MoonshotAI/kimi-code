/// WS v2 protocol implementation.
///
/// Handles:
/// - Protocol negotiation (version handshake)
/// - Event frame parsing and validation
/// - Volatile/Durable classification
/// - Epoch validation
/// - Resync detection

use serde::{Deserialize, Serialize};

use super::cursor::SessionCursor;
use super::error::{WsError, WsResult};
use super::event::{
    ResyncReason, ResyncRequiredPayload, ServerHelloPayload, WsAckEnvelope, WsControlEnvelope,
    WsEventEnvelope, WS_PROTOCOL_VERSION,
};

/// The WS protocol handler.
#[derive(Debug, Clone)]
pub struct WsProtocol {
    /// Protocol version negotiated with the server.
    negotiated_version: u32,
    /// Server capabilities.
    server_capabilities: Option<ServerCapabilities>,
    /// Server connection ID.
    connection_id: Option<String>,
}

/// Server capabilities.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerCapabilities {
    pub event_batching: bool,
    pub compression: bool,
}

impl WsProtocol {
    /// Create a new protocol handler.
    pub fn new() -> Self {
        Self {
            negotiated_version: WS_PROTOCOL_VERSION,
            server_capabilities: None,
            connection_id: None,
        }
    }

    /// Get the negotiated protocol version.
    pub fn version(&self) -> u32 {
        self.negotiated_version
    }

    /// Get server capabilities.
    pub fn capabilities(&self) -> Option<&ServerCapabilities> {
        self.server_capabilities.as_ref()
    }

    /// Get the server connection ID.
    pub fn connection_id(&self) -> Option<&str> {
        self.connection_id.as_deref()
    }

    /// Check if the server supports event batching.
    pub fn supports_batching(&self) -> bool {
        self.server_capabilities
            .as_ref()
            .map(|c| c.event_batching)
            .unwrap_or(false)
    }

    /// Parse a server hello message.
    pub fn parse_server_hello(&mut self, data: &str) -> WsResult<ServerHelloPayload> {
        let msg: serde_json::Value = serde_json::from_str(data)?;
        let msg_type = msg
            .get("type")
            .and_then(|v| v.as_str())
            .ok_or_else(|| WsError::ProtocolError("Missing 'type' field".into()))?;

        if msg_type != "server_hello" {
            return Err(WsError::ProtocolError(format!(
                "Expected 'server_hello', got '{msg_type}'"
            )));
        }

        let payload = msg
            .get("payload")
            .ok_or_else(|| WsError::ProtocolError("Missing 'payload' field".into()))?;

        let hello: ServerHelloPayload = serde_json::from_value(payload.clone())?;

        // Validate protocol version.
        if hello.protocol_version < 2 {
            return Err(WsError::ProtocolError(format!(
                "Unsupported protocol version: {} (minimum: 2)",
                hello.protocol_version
            )));
        }

        self.negotiated_version = hello.protocol_version;
        self.connection_id = Some(hello.ws_connection_id.clone());
        self.server_capabilities = Some(ServerCapabilities {
            event_batching: hello.capabilities.event_batching,
            compression: hello.capabilities.compression,
        });

        eprintln!(
            "[ws] v{} connected: id={}, batching={}, compression={}",
            self.negotiated_version,
            hello.ws_connection_id,
            hello.capabilities.event_batching,
            hello.capabilities.compression
        );

        Ok(hello)
    }

    /// Parse an incoming message into an event envelope or control message.
    pub fn parse_message(&self, data: &str) -> WsResult<WsMessage> {
        let value: serde_json::Value = serde_json::from_str(data)?;

        // Determine message type.
        let msg_type = value
            .get("type")
            .and_then(|v| v.as_str())
            .ok_or_else(|| WsError::ProtocolError("Missing 'type' field".into()))?;

        match msg_type {
            "ack" => {
                let ack: WsAckEnvelope = serde_json::from_value(value)?;
                Ok(WsMessage::Ack(ack))
            }
            "server_hello" => {
                let payload = value
                    .get("payload")
                    .ok_or_else(|| WsError::ProtocolError("Missing payload".into()))?;
                let hello: ServerHelloPayload = serde_json::from_value(payload.clone())?;
                Ok(WsMessage::ServerHello(hello))
            }
            "resync_required" => {
                let payload = value
                    .get("payload")
                    .ok_or_else(|| WsError::ProtocolError("Missing payload".into()))?;
                let resync: ResyncRequiredPayload = serde_json::from_value(payload.clone())?;
                Ok(WsMessage::ResyncRequired(resync))
            }
            "ping" => Ok(WsMessage::Ping),
            "pong" => Ok(WsMessage::Pong),
            "event_batch" => {
                let events: Vec<WsEventEnvelope> = if let Some(arr) = value.get("events") {
                    serde_json::from_value(arr.clone())?
                } else {
                    return Err(WsError::ProtocolError(
                        "event_batch missing 'events' array".into(),
                    ));
                };
                Ok(WsMessage::EventBatch(events))
            }
            // Any other type is treated as an event.
            _ => {
                let envelope: WsEventEnvelope = serde_json::from_value(value)?;
                Ok(WsMessage::Event(envelope))
            }
        }
    }

    /// Create a subscribe control message.
    pub fn create_subscribe(
        &self,
        session_id: &str,
        cursor: Option<&SessionCursor>,
        agent_ids: Option<&[String]>,
    ) -> WsResult<String> {
        let control = WsControlEnvelope {
            control_type: "subscribe".into(),
            id: Some(generate_id()),
            payload: serde_json::json!({
                "session_id": session_id,
                "cursor": cursor,
                "agent_ids": agent_ids,
            }),
        };
        Ok(serde_json::to_string(&control)?)
    }

    /// Create an unsubscribe control message.
    pub fn create_unsubscribe(&self, session_id: &str) -> WsResult<String> {
        let control = WsControlEnvelope {
            control_type: "unsubscribe".into(),
            id: Some(generate_id()),
            payload: serde_json::json!({
                "session_id": session_id,
            }),
        };
        Ok(serde_json::to_string(&control)?)
    }

    /// Create a ping message.
    pub fn create_ping() -> String {
        serde_json::json!({
            "type": "ping",
            "timestamp": super::event::current_timestamp(),
        })
        .to_string()
    }

    /// Create an ack response.
    pub fn create_ack(id: &str, code: i32, msg: &str) -> WsResult<String> {
        let ack = WsAckEnvelope {
            _type: Some("ack".into()),
            id: id.into(),
            code,
            msg: msg.into(),
            payload: None,
        };
        Ok(serde_json::to_string(&ack)?)
    }

    /// Check if a resync is required based on the server's response.
    pub fn check_resync_reason(
        &self,
        resync: &ResyncRequiredPayload,
    ) -> WsError {
        match resync.reason {
            ResyncReason::EpochChanged => WsError::EpochChanged {
                expected: "unknown".into(),
                actual: resync.epoch.clone().unwrap_or_default(),
            },
            ResyncReason::BufferOverflow => {
                WsError::ResyncRequired("Buffer overflow — events were dropped".into())
            }
            ResyncReason::ServerRestart => {
                WsError::ResyncRequired("Server restarted".into())
            }
            ResyncReason::Manual => {
                WsError::ResyncRequired("Manual resync requested".into())
            }
        }
    }
}

impl Default for WsProtocol {
    fn default() -> Self {
        Self::new()
    }
}

/// Generate a unique ID for control messages.
/// Uses fastrand for random generation (no uuid dependency).
fn generate_id() -> String {
    let r: u64 = fastrand::u64(..);
    format!("{:016x}", r)
}

/// A parsed WS message.
#[derive(Debug, Clone)]
pub enum WsMessage {
    /// Server hello (first message).
    ServerHello(ServerHelloPayload),
    /// An application event.
    Event(WsEventEnvelope),
    /// A batch of events.
    EventBatch(Vec<WsEventEnvelope>),
    /// An ack response.
    Ack(WsAckEnvelope),
    /// Resync required notification.
    ResyncRequired(ResyncRequiredPayload),
    /// Ping.
    Ping,
    /// Pong.
    Pong,
}

impl WsMessage {
    /// Check if this message is an event (or batch of events).
    pub fn is_event(&self) -> bool {
        matches!(self, WsMessage::Event(_) | WsMessage::EventBatch(_))
    }

    /// Check if this message requires a resync.
    pub fn is_resync_required(&self) -> bool {
        matches!(self, WsMessage::ResyncRequired(_))
    }

    /// Get the events from this message, if any.
    pub fn events(&self) -> Vec<&WsEventEnvelope> {
        match self {
            WsMessage::Event(e) => vec![e],
            WsMessage::EventBatch(events) => events.iter().collect(),
            _ => vec![],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_server_hello() {
        let mut proto = WsProtocol::new();
        let hello_json = serde_json::json!({
            "type": "server_hello",
            "timestamp": "2024-01-01T00:00:00Z",
            "payload": {
                "ws_connection_id": "conn-123",
                "protocol_version": 2,
                "max_event_buffer_size": 10000,
                "capabilities": {
                    "event_batching": true,
                    "compression": false
                }
            }
        });

        let hello = proto.parse_server_hello(&hello_json.to_string()).unwrap();
        assert_eq!(hello.ws_connection_id, "conn-123");
        assert_eq!(hello.protocol_version, 2);
        assert!(hello.capabilities.event_batching);
        assert_eq!(proto.version(), 2);
        assert!(proto.supports_batching());
    }

    #[test]
    fn test_parse_server_hello_wrong_type() {
        let mut proto = WsProtocol::new();
        let json = serde_json::json!({
            "type": "event",
            "payload": {}
        });
        assert!(proto.parse_server_hello(&json.to_string()).is_err());
    }

    #[test]
    fn test_parse_event_message() {
        let proto = WsProtocol::new();
        let json = serde_json::json!({
            "type": "tool.result",
            "seq": 42,
            "epoch": "epoch-1",
            "session_id": "session-1",
            "timestamp": "2024-01-01T00:00:00Z",
            "payload": {"tool_call_id": "tc1", "output": "done"}
        });

        let msg = proto.parse_message(&json.to_string()).unwrap();
        match msg {
            WsMessage::Event(env) => {
                assert_eq!(env.event_type, "tool.result");
                assert_eq!(env.seq, Some(42));
                assert_eq!(env.session_id, Some("session-1".into()));
            }
            _ => panic!("Expected Event message"),
        }
    }

    #[test]
    fn test_parse_volatile_event() {
        let proto = WsProtocol::new();
        let json = serde_json::json!({
            "type": "assistant.delta",
            "volatile": true,
            "offset": 100,
            "session_id": "session-1",
            "timestamp": "2024-01-01T00:00:00Z",
            "payload": {"delta": "Hello"}
        });

        let msg = proto.parse_message(&json.to_string()).unwrap();
        match msg {
            WsMessage::Event(env) => {
                assert!(env.is_volatile());
                assert_eq!(env.offset, Some(100));
                assert_eq!(env.seq, None);
            }
            _ => panic!("Expected Event message"),
        }
    }

    #[test]
    fn test_create_subscribe() {
        let proto = WsProtocol::new();
        let cursor = SessionCursor::with_seq_and_epoch(10, Some("epoch-1".into()));
        let json = proto
            .create_subscribe("session-1", Some(&cursor), None)
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["type"], "subscribe");
        assert_eq!(value["payload"]["session_id"], "session-1");
        assert_eq!(value["payload"]["cursor"]["seq"], 10);
    }

    #[test]
    fn test_create_ping() {
        let ping = WsProtocol::create_ping();
        let value: serde_json::Value = serde_json::from_str(&ping).unwrap();
        assert_eq!(value["type"], "ping");
    }

    #[test]
    fn test_parse_ack() {
        let proto = WsProtocol::new();
        let json = serde_json::json!({
            "type": "ack",
            "id": "req-1",
            "code": 0,
            "msg": "ok"
        });

        let msg = proto.parse_message(&json.to_string()).unwrap();
        match msg {
            WsMessage::Ack(ack) => {
                assert_eq!(ack.id, "req-1");
                assert_eq!(ack.code, 0);
            }
            _ => panic!("Expected Ack message"),
        }
    }

    #[test]
    fn test_parse_resync_required() {
        let proto = WsProtocol::new();
        let json = serde_json::json!({
            "type": "resync_required",
            "payload": {
                "reason": "epoch_changed",
                "epoch": "epoch-2"
            }
        });

        let msg = proto.parse_message(&json.to_string()).unwrap();
        match msg {
            WsMessage::ResyncRequired(resync) => {
                assert!(matches!(resync.reason, ResyncReason::EpochChanged));
                assert_eq!(resync.epoch, Some("epoch-2".into()));
            }
            _ => panic!("Expected ResyncRequired message"),
        }
    }

    #[test]
    fn test_parse_event_batch() {
        let proto = WsProtocol::new();
        let json = serde_json::json!({
            "type": "event_batch",
            "events": [
                {
                    "type": "tool.result",
                    "seq": 1,
                    "epoch": "e1",
                    "session_id": "s1",
                    "timestamp": "2024-01-01T00:00:00Z",
                    "payload": {}
                },
                {
                    "type": "tool.result",
                    "seq": 2,
                    "epoch": "e1",
                    "session_id": "s1",
                    "timestamp": "2024-01-01T00:00:01Z",
                    "payload": {}
                }
            ]
        });

        let msg = proto.parse_message(&json.to_string()).unwrap();
        match msg {
            WsMessage::EventBatch(events) => {
                assert_eq!(events.len(), 2);
            }
            _ => panic!("Expected EventBatch message"),
        }
    }
}
