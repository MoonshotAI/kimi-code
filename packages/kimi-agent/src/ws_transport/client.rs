/// WebSocket client implementation.
///
/// Features:
/// - Async connect with TLS support
/// - Automatic reconnection with exponential backoff
/// - Event subscription management
/// - Thread-safe event dispatch to handlers
/// - Heartbeat/ping-pong keepalive

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, mpsc, Mutex, RwLock};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use super::cursor::{SessionCursor, SessionCursorStore};
use super::error::{WsError, WsResult};
use super::event::{WsEvent, WsEventEnvelope};
use super::protocol::{WsMessage, WsProtocol};
use super::reconnect::{ReconnectConfig, ReconnectPolicy};

/// WS client configuration.
#[derive(Debug, Clone)]
pub struct WsClientConfig {
    /// Server URL (ws:// or wss://).
    pub url: String,
    /// Authentication token (if any).
    pub auth_token: Option<String>,
    /// Reconnection policy config.
    pub reconnect: ReconnectConfig,
    /// Heartbeat interval (if None, no client-side heartbeat).
    pub heartbeat_interval: Option<Duration>,
    /// Connection timeout.
    pub connect_timeout: Duration,
    /// Maximum number of events to buffer per subscription.
    pub event_buffer_size: usize,
    /// Custom headers to send during handshake.
    pub headers: HashMap<String, String>,
}

impl WsClientConfig {
    /// Create a new config for the given URL.
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            auth_token: None,
            reconnect: ReconnectConfig::default(),
            heartbeat_interval: Some(Duration::from_secs(30)),
            connect_timeout: Duration::from_secs(10),
            event_buffer_size: 10000,
            headers: HashMap::new(),
        }
    }

    /// Set the auth token.
    pub fn with_auth_token(mut self, token: impl Into<String>) -> Self {
        self.auth_token = Some(token.into());
        self
    }

    /// Set the reconnect config.
    pub fn with_reconnect(mut self, config: ReconnectConfig) -> Self {
        self.reconnect = config;
        self
    }

    /// Set the heartbeat interval.
    pub fn with_heartbeat(mut self, interval: Duration) -> Self {
        self.heartbeat_interval = Some(interval);
        self
    }

    /// Disable heartbeat.
    pub fn without_heartbeat(mut self) -> Self {
        self.heartbeat_interval = None;
        self
    }

    /// Add a custom header.
    pub fn with_header(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.insert(key.into(), value.into());
        self
    }
}

/// Builder for WsClient.
pub struct WsClientBuilder {
    config: WsClientConfig,
}

impl WsClientBuilder {
    /// Create a new builder for the given URL.
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            config: WsClientConfig::new(url),
        }
    }

    /// Set the auth token.
    pub fn auth_token(mut self, token: impl Into<String>) -> Self {
        self.config.auth_token = Some(token.into());
        self
    }

    /// Set the reconnect config.
    pub fn reconnect(mut self, config: ReconnectConfig) -> Self {
        self.config.reconnect = config;
        self
    }

    /// Set the heartbeat interval.
    pub fn heartbeat(mut self, interval: Duration) -> Self {
        self.config.heartbeat_interval = Some(interval);
        self
    }

    /// Add a custom header.
    pub fn header(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.config.headers.insert(key.into(), value.into());
        self
    }

    /// Build the client.
    pub fn build(self) -> WsClient {
        WsClient::new(self.config)
    }
}

/// Type alias for the WebSocket stream type.
type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Type alias for event handlers.
type EventHandler = Arc<dyn Fn(WsEvent) + Send + Sync>;

/// A WebSocket client connection.
#[derive(Clone)]
pub struct WsClient {
    config: WsClientConfig,
    state: Arc<RwLock<WsClientState>>,
    cursor_store: SessionCursorStore,
    reconnect_policy: Arc<Mutex<ReconnectPolicy>>,
    /// Channel for sending control messages to the server.
    control_tx: mpsc::Sender<ControlCommand>,
    /// Broadcast channel for connection state changes.
    state_tx: broadcast::Sender<ConnectionState>,
}

/// Internal client state.
struct WsClientState {
    connected: bool,
    protocol: WsProtocol,
    /// Event handlers by session: session_id → handler.
    event_handlers: HashMap<String, EventHandler>,
}

/// Control commands sent to the connection loop.
#[derive(Debug)]
enum ControlCommand {
    Subscribe {
        session_id: String,
        cursor: Option<SessionCursor>,
        agent_ids: Option<Vec<String>>,
        response_tx: mpsc::Sender<WsResult<()>>,
    },
    Unsubscribe {
        session_id: String,
        response_tx: mpsc::Sender<WsResult<()>>,
    },
    Send {
        message: String,
        response_tx: mpsc::Sender<WsResult<()>>,
    },
    Shutdown,
}

/// Connection state broadcast.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    Failed,
}

impl WsClient {
    /// Create a new WS client with the given config.
    pub fn new(config: WsClientConfig) -> Self {
        let (control_tx, control_rx) = mpsc::channel(100);
        let (state_tx, _) = broadcast::channel(16);

        let client = Self {
            config: config.clone(),
            state: Arc::new(RwLock::new(WsClientState {
                connected: false,
                protocol: WsProtocol::new(),
                event_handlers: HashMap::new(),
            })),
            cursor_store: SessionCursorStore::new(),
            reconnect_policy: Arc::new(Mutex::new(ReconnectPolicy::new(config.reconnect.clone()))),
            control_tx,
            state_tx,
        };

        // Spawn the connection management loop.
        let state = client.state.clone();
        let cursor_store = client.cursor_store.clone();
        let reconnect_policy = client.reconnect_policy.clone();
        let state_tx = client.state_tx.clone();

        tokio::spawn(async move {
            connection_loop(config, state, cursor_store, reconnect_policy, control_rx, state_tx)
                .await;
        });

        client
    }

    /// Subscribe to a session's events.
    pub async fn subscribe(
        &self,
        session_id: &str,
        cursor: Option<SessionCursor>,
        handler: EventHandler,
    ) -> WsResult<()> {
        // Register the handler.
        {
            let mut state = self.state.write().await;
            state
                .event_handlers
                .insert(session_id.to_string(), handler);
        }

        // Send subscribe command.
        let (tx, mut rx) = mpsc::channel(1);
        self.control_tx
            .send(ControlCommand::Subscribe {
                session_id: session_id.to_string(),
                cursor,
                agent_ids: None,
                response_tx: tx,
            })
            .await
            .map_err(|_| WsError::ChannelClosed)?;

        match timeout(Duration::from_secs(5), rx.recv()).await {
            Ok(Some(result)) => result,
            Ok(None) => Err(WsError::ChannelClosed),
            Err(_) => Err(WsError::Timeout),
        }
    }

    /// Unsubscribe from a session's events.
    pub async fn unsubscribe(&self, session_id: &str) -> WsResult<()> {
        {
            let mut state = self.state.write().await;
            state.event_handlers.remove(session_id);
        }

        let (tx, mut rx) = mpsc::channel(1);
        self.control_tx
            .send(ControlCommand::Unsubscribe {
                session_id: session_id.to_string(),
                response_tx: tx,
            })
            .await
            .map_err(|_| WsError::ChannelClosed)?;

        match timeout(Duration::from_secs(5), rx.recv()).await {
            Ok(Some(result)) => result,
            Ok(None) => Err(WsError::ChannelClosed),
            Err(_) => Err(WsError::Timeout),
        }
    }

    /// Get the current connection state.
    pub async fn is_connected(&self) -> bool {
        self.state.read().await.connected
    }

    /// The client's configuration.
    pub fn config(&self) -> &WsClientConfig {
        &self.config
    }

    /// Send a raw text message over the active WebSocket connection.
    pub async fn send_text(&self, message: String) -> WsResult<()> {
        let (tx, mut rx) = mpsc::channel(1);
        self.control_tx
            .send(ControlCommand::Send {
                message,
                response_tx: tx,
            })
            .await
            .map_err(|_| WsError::ChannelClosed)?;

        match timeout(Duration::from_secs(5), rx.recv()).await {
            Ok(Some(result)) => result,
            Ok(None) => Err(WsError::ChannelClosed),
            Err(_) => Err(WsError::Timeout),
        }
    }

    /// Get the cursor store.
    pub fn cursor_store(&self) -> &SessionCursorStore {
        &self.cursor_store
    }

    /// Subscribe to connection state changes.
    pub fn on_state_change(&self) -> broadcast::Receiver<ConnectionState> {
        self.state_tx.subscribe()
    }

    /// Shutdown the client.
    pub async fn shutdown(&self) -> WsResult<()> {
        let (_tx, _rx): (mpsc::Sender<WsResult<()>>, _) = mpsc::channel(1);
        let _ = self.control_tx.send(ControlCommand::Shutdown).await;
        Ok(())
    }
}

/// The main connection loop that manages the WebSocket lifecycle.
async fn connection_loop(
    config: WsClientConfig,
    state: Arc<RwLock<WsClientState>>,
    cursor_store: SessionCursorStore,
    reconnect_policy: Arc<Mutex<ReconnectPolicy>>,
    mut control_rx: mpsc::Receiver<ControlCommand>,
    state_tx: broadcast::Sender<ConnectionState>,
) {
    let mut shutdown = false;

    while !shutdown {
        // Update state to connecting.
        {
            let mut s = state.write().await;
            s.connected = false;
        }
        let _ = state_tx.send(ConnectionState::Connecting);

        // Attempt to connect.
        match connect_with_timeout(&config).await {
            Ok((ws_stream, _response)) => {
                // Reset reconnect policy on successful connection.
                reconnect_policy.lock().await.reset();
                {
                    let mut s = state.write().await;
                    s.connected = true;
                }
                let _ = state_tx.send(ConnectionState::Connected);

                eprintln!("[ws] connected to {}", config.url);

                // Run the message loop.
                let msg_result = message_loop(
                    ws_stream,
                    &config,
                    &state,
                    &cursor_store,
                    &mut control_rx,
                    &state_tx,
                )
                .await;

                match msg_result {
                    MessageLoopResult::Shutdown => {
                        shutdown = true;
                    }
                    MessageLoopResult::Disconnected => {
                        // Will reconnect below.
                    }
                }

                {
                    let mut s = state.write().await;
                    s.connected = false;
                }
                let _ = state_tx.send(ConnectionState::Disconnected);
            }
            Err(e) => {
                eprintln!("[ws] connection failed: {e}");
                let _ = state_tx.send(ConnectionState::Failed);
            }
        }

        if shutdown {
            break;
        }

        // Wait before reconnecting.
        let backoff = {
            let mut policy = reconnect_policy.lock().await;
            policy.next_backoff()
        };

        match backoff {
            Some(duration) => {
                eprintln!("[ws] reconnecting in {duration:?}...");
                let _ = state_tx.send(ConnectionState::Reconnecting);
                tokio::time::sleep(duration).await;
            }
            None => {
                eprintln!("[ws] max reconnection attempts reached, giving up");
                break;
            }
        }
    }
}

/// Result of the message loop.
enum MessageLoopResult {
    Shutdown,
    Disconnected,
}

/// Connect to the server with timeout.
async fn connect_with_timeout(config: &WsClientConfig) -> WsResult<(WsStream, tokio_tungstenite::tungstenite::handshake::client::Response)> {
    // tokio_tungstenite's connect_async accepts a string URL directly.
    let result = timeout(config.connect_timeout, connect_async(&config.url)).await;
    match result {
        Ok(Ok(pair)) => Ok(pair),
        Ok(Err(e)) => Err(WsError::WsError(e.to_string())),
        Err(_) => Err(WsError::Timeout),
    }
}

/// The message loop that handles incoming and outgoing messages.
async fn message_loop(
    mut ws_stream: WsStream,
    config: &WsClientConfig,
    state: &Arc<RwLock<WsClientState>>,
    cursor_store: &SessionCursorStore,
    control_rx: &mut mpsc::Receiver<ControlCommand>,
    _state_tx: &broadcast::Sender<ConnectionState>,
) -> MessageLoopResult {
        let mut heartbeat = config
            .heartbeat_interval
            .map(|dur| tokio::time::interval(dur));

    loop {
        tokio::select! {
            // Incoming WS message.
            msg = ws_stream.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        handle_incoming_message(&text, state, cursor_store, &mut ws_stream).await;
                    }
                    Some(Ok(Message::Binary(bin))) => {
                        if let Ok(text) = String::from_utf8(bin.to_vec()) {
                            handle_incoming_message(&text, state, cursor_store, &mut ws_stream).await;
                        }
                    }
                    Some(Ok(Message::Ping(data))) => {
                        let _ = ws_stream.send(Message::Pong(data)).await;
                    }
                    Some(Ok(Message::Pong(_))) => {
                        // Heartbeat acknowledged.
                    }
                    Some(Ok(Message::Close(_))) => {
                        eprintln!("[ws] connection closed by server");
                        return MessageLoopResult::Disconnected;
                    }
                    Some(Ok(Message::Frame(_))) => {
                        // Ignore raw frames.
                    }
                    Some(Err(e)) => {
                        eprintln!("[ws] error: {e}");
                        return MessageLoopResult::Disconnected;
                    }
                    None => {
                        eprintln!("[ws] stream ended");
                        return MessageLoopResult::Disconnected;
                    }
                }
            }

            // Control command.
            cmd = control_rx.recv() => {
                match cmd {
                    Some(ControlCommand::Subscribe { session_id, cursor, agent_ids, response_tx }) => {
                        let result = send_subscribe(state, &mut ws_stream, &session_id, cursor.as_ref(), agent_ids.as_deref()).await;
                        let _ = response_tx.send(result).await;
                    }
                    Some(ControlCommand::Unsubscribe { session_id, response_tx }) => {
                        let result = send_unsubscribe(state, &mut ws_stream, &session_id).await;
                        let _ = response_tx.send(result).await;
                    }
                    Some(ControlCommand::Send { message, response_tx }) => {
                        let result = ws_stream.send(Message::Text(message)).await
                            .map(|_| ())
                            .map_err(|e| WsError::WsError(e.to_string()));
                        let _ = response_tx.send(result).await;
                    }
                    Some(ControlCommand::Shutdown) => {
                        let _ = ws_stream.close(None).await;
                        return MessageLoopResult::Shutdown;
                    }
                    None => {
                        return MessageLoopResult::Disconnected;
                    }
                }
            }

            // Heartbeat.
            _ = async {
                match &mut heartbeat {
                    Some(interval) => interval.tick().await,
                    None => std::future::pending().await,
                }
            }, if heartbeat.is_some() => {
                let ping = WsProtocol::create_ping();
                if ws_stream.send(Message::Text(ping)).await.is_err() {
                    return MessageLoopResult::Disconnected;
                }
            }
        }
    }
}

/// Handle an incoming message from the server.
async fn handle_incoming_message(
    text: &str,
    state: &Arc<RwLock<WsClientState>>,
    cursor_store: &SessionCursorStore,
    _ws_stream: &mut WsStream,
) {
    let protocol = {
        let state = state.read().await;
        state.protocol.clone()
    };

    match protocol.parse_message(text) {
        Ok(WsMessage::ServerHello(hello)) => {
            let mut state = state.write().await;
            state.protocol = {
                let mut p = WsProtocol::new();
                let _ = p.parse_server_hello(text);
                p
            };
            eprintln!("[ws] received server hello: id={}", hello.ws_connection_id);
        }
        Ok(WsMessage::Event(envelope)) => {
            dispatch_event(envelope, state, cursor_store).await;
        }
        Ok(WsMessage::EventBatch(events)) => {
            for envelope in events {
                dispatch_event(envelope, state, cursor_store).await;
            }
        }
        Ok(WsMessage::Ack(ack)) => {
            // Ack received: id={}, code={}
            let _ = (ack.id, ack.code);
        }
        Ok(WsMessage::ResyncRequired(resync)) => {
            eprintln!("[ws] resync required: {:?}", resync.reason);
            cursor_store.clear();
        }
        Ok(WsMessage::Ping) => {
            // Server sent ping, respond with pong.
            // (Handled at the WS layer, but just in case.)
        }
        Ok(WsMessage::Pong) => {
            // Heartbeat acknowledged.
        }
        Err(e) => {
            eprintln!("[ws] failed to parse message: {e}");
        }
    }
}

/// Dispatch an event to the appropriate handler.
async fn dispatch_event(
    envelope: WsEventEnvelope,
    state: &Arc<RwLock<WsClientState>>,
    cursor_store: &SessionCursorStore,
) {
    let session_id = envelope.session_id.clone().unwrap_or_default();

    // Update cursor for durable events.
    if envelope.is_durable() {
        if let Some(seq) = envelope.seq {
            let mut cursor = cursor_store
                .get(&session_id)
                .unwrap_or_else(SessionCursor::new);
            cursor.set_seq(seq);
            if let Some(ref epoch) = envelope.epoch {
                cursor.set_epoch(epoch.clone());
            }
            cursor_store.set(session_id.clone(), cursor);
        }
    }

    // Find and call the handler.
    let handler = {
        let state = state.read().await;
        state.event_handlers.get(&session_id).cloned()
    };

    if let Some(handler) = handler {
        let event = WsEvent::from_envelope(envelope);
        handler(event);
    }
}

/// Send a subscribe message.
async fn send_subscribe(
    state: &Arc<RwLock<WsClientState>>,
    ws_stream: &mut WsStream,
    session_id: &str,
    cursor: Option<&SessionCursor>,
    agent_ids: Option<&[String]>,
) -> WsResult<()> {
    let protocol = {
        let state = state.read().await;
        state.protocol.clone()
    };

    let msg = protocol.create_subscribe(session_id, cursor, agent_ids)?;
    ws_stream
        .send(Message::Text(msg))
        .await
        .map_err(|e| WsError::WsError(e.to_string()))?;
    Ok(())
}

/// Send an unsubscribe message.
async fn send_unsubscribe(
    state: &Arc<RwLock<WsClientState>>,
    ws_stream: &mut WsStream,
    session_id: &str,
) -> WsResult<()> {
    let protocol = {
        let state = state.read().await;
        state.protocol.clone()
    };

    let msg = protocol.create_unsubscribe(session_id)?;
    ws_stream
        .send(Message::Text(msg))
        .await
        .map_err(|e| WsError::WsError(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_client_config_builder() {
        let config = WsClientConfig::new("wss://example.com/ws")
            .with_auth_token("token-123")
            .with_heartbeat(Duration::from_secs(15))
            .with_header("X-Custom", "value");

        assert_eq!(config.url, "wss://example.com/ws");
        assert_eq!(config.auth_token, Some("token-123".into()));
        assert_eq!(config.heartbeat_interval, Some(Duration::from_secs(15)));
        assert_eq!(config.headers.get("X-Custom"), Some(&"value".into()));
    }

    #[tokio::test]
    async fn test_client_builder() {
        let client = WsClientBuilder::new("wss://example.com/ws")
            .auth_token("token-123")
            .heartbeat(Duration::from_secs(15))
            .header("X-Custom", "value")
            .build();

        // Just verify it builds without panicking.
        let _ = client;
    }
}
