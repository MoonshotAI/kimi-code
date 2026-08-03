//! stdio transport — serve a `MessageProcessor` over any async byte stream
//! (stdin/stdout in production, an in-memory duplex in tests).
//!
//! Wire format matches the engine's stdio today: one JSON-RPC request per
//! line on the way in, one JSON-RPC response per line on the way out. The
//! processor is the same object an in-process client talks to, so swapping
//! between embedded and stdio hosting is a transport choice, not a code path.

use std::sync::Arc;

use kimi_server::processor::MessageProcessor;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

/// Serve requests from `reader`, writing responses to `writer`, until EOF.
pub async fn serve<R, W>(processor: &Arc<MessageProcessor>, reader: R, writer: &mut W)
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<kimi_protocol::rpc::JsonRpcRequest>(line) {
            Ok(request) => processor.handle(request).await,
            Err(_) => serde_json::json!({
                "jsonrpc": "2.0",
                "id": null,
                "error": { "code": -32700, "message": "Parse error" },
            }),
        };
        if writer
            .write_all(format!("{response}\n").as_bytes())
            .await
            .is_err()
        {
            return;
        }
        if writer.flush().await.is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kimi_server::request_processors::HealthProcessor;
    use kimi_server::processor::Processor;
    use tokio::io::{duplex, AsyncReadExt};

    #[tokio::test]
    async fn stdio_round_trip() {
        let mut processor = MessageProcessor::new();
        HealthProcessor.register(&mut processor);
        let processor = Arc::new(processor);

        // Client side writes requests and reads responses over the duplex.
        let (server_side, mut client_side) = duplex(1024);
        let (reader, mut writer) = tokio::io::split(server_side);
        let server = tokio::spawn(async move {
            serve(&processor, reader, &mut writer).await;
        });

        client_side
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"agent/health\",\"params\":null}\n")
            .await
            .unwrap();
        let mut buf = Vec::new();
        // Read until newline.
        let mut byte = [0u8; 1];
        loop {
            if client_side.read(&mut byte).await.unwrap() == 0 {
                break;
            }
            buf.push(byte[0]);
            if byte[0] == b'\n' {
                break;
            }
        }
        let body: serde_json::Value = serde_json::from_slice(&buf).unwrap();
        assert_eq!(body["result"]["status"], "ok");
        assert!(body.get("error").is_none());

        drop(client_side);
        let _ = server.await;
    }

    #[tokio::test]
    async fn stdio_parse_error() {
        let processor = MessageProcessor::new();
        let processor = Arc::new(processor);
        let (server_side, mut client_side) = duplex(1024);
        let (reader, mut writer) = tokio::io::split(server_side);
        let server = tokio::spawn(async move {
            serve(&processor, reader, &mut writer).await;
        });
        client_side.write_all(b"not json\n").await.unwrap();
        let mut buf = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            if client_side.read(&mut byte).await.unwrap() == 0 {
                break;
            }
            buf.push(byte[0]);
            if byte[0] == b'\n' {
                break;
            }
        }
        let body: serde_json::Value = serde_json::from_slice(&buf).unwrap();
        assert_eq!(body["error"]["code"], -32700);
        drop(client_side);
        let _ = server.await;
    }
}
