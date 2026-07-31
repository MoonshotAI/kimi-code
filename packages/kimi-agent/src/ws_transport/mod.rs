/// WebSocket transport layer for kimi-agent.
///
/// Implements the WS v2 protocol with:
/// - Epoch-based session cursor validation
/// - Volatile/Durable event classification
/// - Automatic reconnection with exponential backoff
/// - Event batching and ordering guarantees
///
/// This module replaces the TypeScript WS transport in:
/// - `packages/protocol/src/ws-control.ts`
/// - `packages/klient/src/core/channel.ts`
/// - `packages/kap-server/src/transport/ws/*`

pub mod client;
pub mod cursor;
pub mod error;
pub mod event;
pub mod protocol;
pub mod reconnect;

pub use client::{WsClient, WsClientBuilder, WsClientConfig};
pub use cursor::{SessionCursor, SessionCursorStore};
pub use error::{WsError, WsResult};
pub use event::{WsEvent, WsEventEnvelope, WsEventType};
pub use protocol::WsProtocol;
pub use reconnect::{ReconnectConfig, ReconnectPolicy};
