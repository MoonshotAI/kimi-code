//! WebSocket transport — serve a `MessageProcessor` over WebSocket frames.
//!
//! Mirrors the stdio contract one message at a time: each JSON-RPC request
//! arrives as a text frame, each response leaves as a text frame. Ping/pong
//! keep the connection warm; close frames end the connection cleanly.
//!
//! This is the future wire for web hosts (the TS `kap-server` WS projection
//! replaced by the same Rust processor), so the transport is a pure frame
//! shim — no protocol logic of its own.

use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use kimi_server::processor::MessageProcessor;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;

/// Accept connections from `listener` forever, serving one processor per
/// connection. Returns on listener error.
pub async fn serve(processor: &Arc<MessageProcessor>, listener: TcpListener) -> anyhow::Result<()> {
    loop {
        let (stream, _) = listener.accept().await?;
        let processor = processor.clone();
        tokio::spawn(async move {
            if let Err(e) = serve_connection(&processor, stream).await {
                eprintln!("ws connection error: {e}");
            }
        });
    }
}

/// Serve one established TCP stream after the WS handshake.
async fn serve_connection(
    processor: &Arc<MessageProcessor>,
    stream: TcpStream,
) -> anyhow::Result<()> {
    let ws = tokio_tungstenite::accept_async(stream).await?;
    let (mut sink, mut source) = ws.split();
    while let Some(msg) = source.next().await {
        let msg = msg?;
        match msg {
            Message::Text(text) => {
                let line = text.trim();
                if line.is_empty() {
                    continue;
                }
                let response = match serde_json::from_str::<kimi_protocol::rpc::JsonRpcRequest>(line)
                {
                    Ok(request) => processor.handle(request).await,
                    Err(_) => serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": null,
                        "error": { "code": -32700, "message": "Parse error" },
                    }),
                };
                if sink
                    .send(Message::Text(response.to_string()))
                    .await
                    .is_err()
                {
                    return Ok(());
                }
            }
            Message::Ping(payload) => {
                if sink.send(Message::Pong(payload)).await.is_err() {
                    return Ok(());
                }
            }
            Message::Close(_) => return Ok(()),
            // Binary / pong / frame continuations carry no protocol meaning here.
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use kimi_server::processor::Processor;
    use kimi_server::request_processors::HealthProcessor;
    use tokio_tungstenite::tungstenite::Message as WsMessage;

    /// A processor with just the health method (no store/env needed).
    fn health_processor() -> Arc<MessageProcessor> {
        let mut processor = MessageProcessor::new();
        HealthProcessor.register(&mut processor);
        Arc::new(processor)
    }

    #[tokio::test]
    async fn websocket_round_trip() {
        let processor = health_processor();
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = tokio::spawn(async move { serve(&processor, listener).await });

        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}"))
            .await
            .expect("connect");
        ws.send(WsMessage::Text(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"agent/health\",\"params\":null}"
                .to_string()
                .into(),
        ))
        .await
        .expect("send");
        let response = ws.next().await.expect("response").expect("frame");
        let WsMessage::Text(text) = response else {
            panic!("expected text frame, got: {response:?}");
        };
        let body: serde_json::Value = serde_json::from_str(&text).expect("json");
        assert_eq!(body["result"]["status"], "ok", "body: {body}");
        assert!(body.get("error").is_none());

        // Ping is answered with a pong; close ends cleanly.
        ws.send(WsMessage::Ping(vec![1, 2, 3].into())).await.expect("ping");
        if let Some(msg) = ws.next().await {
            assert!(matches!(msg.expect("frame"), WsMessage::Pong(_)), "pong expected");
        }
        ws.close(None).await.expect("close");
        server.abort();
    }

    #[tokio::test]
    async fn websocket_parse_error() {
        let processor = health_processor();
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = tokio::spawn(async move { serve(&processor, listener).await });

        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}"))
            .await
            .expect("connect");
        ws.send(WsMessage::Text("not json".to_string().into())).await.expect("send");
        let response = ws.next().await.expect("response").expect("frame");
        let WsMessage::Text(text) = response else {
            panic!("expected text frame, got: {response:?}");
        };
        let body: serde_json::Value = serde_json::from_str(&text).expect("json");
        assert_eq!(body["error"]["code"], -32700, "body: {body}");
        ws.close(None).await.expect("close");
        server.abort();
    }
}
