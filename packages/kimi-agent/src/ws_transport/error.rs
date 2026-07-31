/// Error types for the WebSocket transport layer.

use std::fmt;

/// Result type alias for WS operations.
pub type WsResult<T> = std::result::Result<T, WsError>;

/// WebSocket transport errors.
#[derive(Debug)]
pub enum WsError {
    /// Connection failed.
    ConnectionFailed(String),
    /// Connection closed unexpectedly.
    ConnectionClosed,
    /// Protocol error (invalid message format).
    ProtocolError(String),
    /// Serialization/deserialization error.
    SerializationError(String),
    /// Timeout waiting for response.
    Timeout,
    /// Epoch mismatch — session journal was recreated.
    EpochChanged {
        /// The epoch the client expected.
        expected: String,
        /// The epoch the server has.
        actual: String,
    },
    /// Server requires a full resync.
    ResyncRequired(String),
    /// Authentication failure.
    AuthError(String),
    /// Channel closed locally.
    ChannelClosed,
    /// URL parse error.
    UrlError(String),
    /// IO error.
    IoError(std::io::Error),
    /// WebSocket error.
    WsError(String),
}

impl fmt::Display for WsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WsError::ConnectionFailed(msg) => write!(f, "WS connection failed: {msg}"),
            WsError::ConnectionClosed => write!(f, "WS connection closed"),
            WsError::ProtocolError(msg) => write!(f, "WS protocol error: {msg}"),
            WsError::SerializationError(msg) => write!(f, "Serialization error: {msg}"),
            WsError::Timeout => write!(f, "WS operation timed out"),
            WsError::EpochChanged { expected, actual } => {
                write!(f, "Epoch changed: expected '{expected}', got '{actual}'")
            }
            WsError::ResyncRequired(reason) => write!(f, "Resync required: {reason}"),
            WsError::AuthError(msg) => write!(f, "WS auth error: {msg}"),
            WsError::ChannelClosed => write!(f, "WS channel closed"),
            WsError::UrlError(msg) => write!(f, "URL error: {msg}"),
            WsError::IoError(e) => write!(f, "IO error: {e}"),
            WsError::WsError(msg) => write!(f, "WebSocket error: {msg}"),
        }
    }
}

impl std::error::Error for WsError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            WsError::IoError(e) => Some(e),
            _ => None,
        }
    }
}

impl From<std::io::Error> for WsError {
    fn from(e: std::io::Error) -> Self {
        WsError::IoError(e)
    }
}

impl From<serde_json::Error> for WsError {
    fn from(e: serde_json::Error) -> Self {
        WsError::SerializationError(e.to_string())
    }
}

impl From<tokio_tungstenite::tungstenite::Error> for WsError {
    fn from(e: tokio_tungstenite::tungstenite::Error) -> Self {
        WsError::WsError(e.to_string())
    }
}
