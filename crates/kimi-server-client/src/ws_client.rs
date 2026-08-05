//! Remote WebSocket client — speak frame JSON-RPC to a kimi-server serving
//! over WebSocket (`kimi-server-serve --ws <addr>`). Same envelope as stdio,
//! one request per text frame out, one response per text frame in.
//!
//! Concurrent like the stdio client: a background task reads response frames
//! and routes each to the waiting call by request id, so a long-running call
//! (a prompt turn) does not block a concurrent control call
//! (`session/cancel`) from this same client. The write side stays
//! single-flight (one frame at a time); only the waiting is decoupled.

use std::collections::HashMap;
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::{oneshot, Mutex};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

/// The connection state. The sink is shared by all in-flight calls (write
/// side is single-flight); `pending` routes responses back to the right
/// caller by request id. The read side lives in the background reader task.
struct WsInner {
    sink: futures_util::stream::SplitSink<
        WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
        Message,
    >,
    pending: HashMap<u64, oneshot::Sender<serde_json::Value>>,
    next_id: u64,
}

/// A client connected to a WS-served kimi-server.
pub struct WsClient {
    inner: Arc<Mutex<WsInner>>,
}

/// A JSON-RPC error envelope (client-side transport failure).
fn transport_error(code: i64, message: &str) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": null,
        "error": { "code": code, "message": message },
    })
}

impl WsClient {
    /// Connect to `ws://<addr>` (e.g. `127.0.0.1:8080`).
    pub async fn connect(addr: &str) -> anyhow::Result<Self> {
        let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}")).await?;
        let (sink, source) = ws.split();
        let inner = Arc::new(Mutex::new(WsInner {
            sink,
            pending: HashMap::new(),
            next_id: 1,
        }));
        spawn_reader(inner.clone(), source);
        Ok(Self { inner })
    }

    /// Make a JSON-RPC call; resolves with the full wire response body.
    ///
    /// The request is sent under the lock (single-flight on the sink), but the
    /// lock is **not** held for the response: the caller waits on a per-call
    /// channel that the background reader feeds, so a second, concurrent call
    /// from the same client (e.g. `session/cancel` while a prompt turn is in
    /// flight) is not blocked.
    pub async fn call(&self, method: &str, params: serde_json::Value) -> serde_json::Value {
        let rx = {
            let mut inner = self.inner.lock().await;
            let id = inner.next_id;
            inner.next_id += 1;
            let (tx, rx) = oneshot::channel();
            inner.pending.insert(id, tx);
            let request = serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": method,
                "params": params,
            });
            if inner
                .sink
                .send(Message::Text(request.to_string()))
                .await
                .is_err()
            {
                inner.pending.remove(&id);
                return transport_error(-32000, "ws send failed");
            }
            rx
        };
        match rx.await {
            Ok(body) => body,
            Err(_) => transport_error(-32000, "ws closed"),
        }
    }

    /// Close the connection cleanly.
    pub async fn close(self) -> anyhow::Result<()> {
        let mut inner = self.inner.lock().await;
        inner.sink.close().await?;
        Ok(())
    }
}

/// The background reader: consume response frames and hand each to the
/// waiting call by request id; answer pings with pongs. On close/EOF every
/// in-flight call is failed so hosts unblock instead of hanging.
fn spawn_reader(
    inner: Arc<Mutex<WsInner>>,
    mut source: futures_util::stream::SplitStream<
        WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    >,
) {
    tokio::spawn(async move {
        while let Some(msg) = source.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
                        continue;
                    };
                    let Some(id) = value["id"].as_u64() else {
                        continue;
                    };
                    let tx = {
                        let mut guard = inner.lock().await;
                        guard.pending.remove(&id)
                    };
                    if let Some(tx) = tx {
                        let _ = tx.send(value);
                    }
                }
                Ok(Message::Ping(payload)) => {
                    let mut guard = inner.lock().await;
                    let _ = guard.sink.send(Message::Pong(payload)).await;
                }
                Ok(Message::Close(_)) | Err(_) => break,
                _ => {}
            }
        }
        let pending = {
            let mut guard = inner.lock().await;
            std::mem::take(&mut guard.pending)
        };
        for (_, tx) in pending {
            let _ = tx.send(transport_error(-32000, "ws closed"));
        }
    });
}
