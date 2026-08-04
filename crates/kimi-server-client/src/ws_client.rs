//! Remote WebSocket client — speak frame JSON-RPC to a kimi-server serving
//! over WebSocket (`kimi-server-serve --ws <addr>`). Same envelope as stdio,
//! one request per text frame out, one response per text frame in.

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::MaybeTlsStream;

/// A client connected to a WS-served kimi-server.
pub struct WsClient {
    ws: tokio_tungstenite::WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    next_id: u64,
}

impl WsClient {
    /// Connect to `ws://<addr>` (e.g. `127.0.0.1:8080`).
    pub async fn connect(addr: &str) -> anyhow::Result<Self> {
        let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}")).await?;
        Ok(Self { ws, next_id: 1 })
    }

    /// Make a JSON-RPC call; resolves with the full wire response body.
    /// Pings are answered with pongs; non-text frames are skipped.
    pub async fn call(&mut self, method: &str, params: serde_json::Value) -> serde_json::Value {
        let id = self.next_id;
        self.next_id += 1;
        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let error = |code: i64, message: &str| {
            serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
        };
        if self
            .ws
            .send(Message::Text(request.to_string()))
            .await
            .is_err()
        {
            return error(-32000, "ws send failed");
        }
        loop {
            let Some(msg) = self.ws.next().await else {
                return error(-32000, "ws closed");
            };
            match msg {
                Ok(Message::Text(text)) => {
                    return serde_json::from_str(&text).unwrap_or_else(|_| {
                        error(-32000, "ws parse failed")
                    });
                }
                Ok(Message::Ping(payload)) => {
                    if self.ws.send(Message::Pong(payload)).await.is_err() {
                        return error(-32000, "ws pong failed");
                    }
                }
                Ok(Message::Close(_)) => return error(-32000, "ws closed"),
                _ => continue,
            }
        }
    }

    /// Close the connection cleanly.
    pub async fn close(mut self) -> anyhow::Result<()> {
        self.ws.close(None).await?;
        Ok(())
    }
}
