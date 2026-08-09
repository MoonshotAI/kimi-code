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
///
/// Requests are dispatched **concurrently** — one task per line — mirroring
/// the engine's own stdio loop, so a long-running handler (a prompt turn that
/// holds the session manager for the whole turn) never starves control-plane
/// requests (`session/cancel`, `session/steer`, status reads…) arriving on the
/// same pipe. Responses are written under a shared lock (one whole line each,
/// the same atomicity `println!` gives the engine), and clients correlate
/// them by request id.
/// Spawn a task that fans engine events out as `[event] {json}` lines.
///
/// Unbounded by design: hosts (a TUI, a harness, `--verbose` CLIs) consume
/// this stream for the whole process lifetime, so a line cap would silently
/// cut their event stream mid-session. Backpressure comes from the pipe
/// itself — a non-reading host blocks this task (never the RPC loop), and a
/// closed pipe (host exited) stops the printer. A broadcast lag (host slower
/// than the bus) drops the oldest event, matching the bus's own semantics.
pub fn spawn_event_printer<W>(
    mut events: tokio::sync::broadcast::Receiver<serde_json::Value>,
    mut writer: W,
) -> tokio::task::JoinHandle<()>
where
    W: AsyncWrite + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        while let Ok(event) = events.recv().await {
            let line = format!(
                "[event] {}\n",
                serde_json::to_string(&event).unwrap_or_default()
            );
            if writer.write_all(line.as_bytes()).await.is_err() {
                break; // pipe closed — the host is gone
            }
            let _ = writer.flush().await;
        }
    })
}

pub async fn serve<R, W>(processor: &Arc<MessageProcessor>, reader: R, writer: W)
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let writer = Arc::new(tokio::sync::Mutex::new(writer));
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        let processor = processor.clone();
        let writer = writer.clone();
        tokio::spawn(async move {
            let response = match serde_json::from_str::<kimi_protocol::rpc::JsonRpcRequest>(&line) {
                Ok(request) => processor.handle(request).await,
                Err(_) => serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": null,
                    "error": { "code": -32700, "message": "Parse error" },
                }),
            };
            let mut writer = writer.lock().await;
            if writer
                .write_all(format!("{response}\n").as_bytes())
                .await
                .is_err()
            {
                return;
            }
            let _ = writer.flush().await;
        });
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
        let (reader, writer) = tokio::io::split(server_side);
        let server = tokio::spawn(async move {
            serve(&processor, reader, writer).await;
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
        let (reader, writer) = tokio::io::split(server_side);
        let server = tokio::spawn(async move {
            serve(&processor, reader, writer).await;
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

    /// Concurrent dispatch: a slow handler does not stall a fast one. The
    /// requests go out back-to-back (slow first); the fast response is written
    /// back first, so responses arrive out of request order — the reader
    /// correlates them by id, exactly what a concurrent client does.
    #[tokio::test]
    async fn serve_dispatches_concurrently() {
        use kimi_server::request_processors::HealthProcessor;

        let mut processor = MessageProcessor::new();
        HealthProcessor.register(&mut processor);
        processor.register("test/slow", |_params| async move {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            Ok(serde_json::json!({ "slow": true }))
        });
        let processor = Arc::new(processor);

        let (server_side, mut client_side) = duplex(4096);
        let (reader, writer) = tokio::io::split(server_side);
        let server = tokio::spawn(async move {
            serve(&processor, reader, writer).await;
        });

        client_side
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"test/slow\",\"params\":null}\n")
            .await
            .unwrap();
        client_side
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"agent/health\",\"params\":null}\n")
            .await
            .unwrap();

        let first = read_line(&mut client_side).await;
        let second = read_line(&mut client_side).await;
        assert_eq!(first["id"], serde_json::json!(2), "fast first: {first}");
        assert_eq!(second["id"], serde_json::json!(1), "slow second: {second}");
        assert_eq!(first["result"]["status"], "ok", "health body: {first}");
        assert_eq!(second["result"]["slow"], true, "slow body: {second}");

        drop(client_side);
        let _ = server.await;
    }

    /// Read one JSON line from the client side of the duplex.
    async fn read_line(client: &mut tokio::io::DuplexStream) -> serde_json::Value {
        let mut buf = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            if client.read(&mut byte).await.unwrap() == 0 {
                break;
            }
            buf.push(byte[0]);
            if byte[0] == b'\n' {
                break;
            }
        }
        serde_json::from_slice(&buf).unwrap_or(serde_json::Value::Null)
    }

    /// The event stream is unbounded — a long-lived host (TUI, harness) must
    /// receive events beyond the old 512-line cap. Regression anchor: the
    /// printer used to stop after 512 lines, silently cutting every long
    /// session's event stream. 600 events all arrive; ordering is preserved.
    #[tokio::test]
    async fn event_printer_is_unbounded() {
        let (tx, rx) = tokio::sync::broadcast::channel::<serde_json::Value>(2048);
        let (sink, mut reader) = duplex(256 * 1024);
        let handle = spawn_event_printer(rx, sink);

        for i in 0..600 {
            tx.send(serde_json::json!({ "type": "probe", "n": i })).unwrap();
        }
        drop(tx);

        let mut lines = 0usize;
        let mut expected = 0usize;
        let mut byte = [0u8; 1];
        let mut buf = Vec::new();
        loop {
            if reader.read(&mut byte).await.unwrap_or(0) == 0 {
                break;
            }
            buf.push(byte[0]);
            if byte[0] == b'\n' {
                let text = String::from_utf8_lossy(&buf);
                let json = text.strip_prefix("[event] ").unwrap_or(&text);
                let line: serde_json::Value = serde_json::from_str(json).unwrap_or_default();
                assert_eq!(line["type"], "probe", "unparsed line: {text:?}");
                assert_eq!(line["n"], expected, "out of order at line {lines}");
                expected += 1;
                lines += 1;
                buf.clear();
                if lines >= 600 {
                    break;
                }
            }
        }
        assert_eq!(lines, 600, "all events must reach the host, not just the first 512");
        handle.abort();
    }

    /// A closed pipe (host exited) stops the printer instead of panicking —
    /// the correct backpressure terminal for an unbounded stream.
    #[tokio::test]
    async fn event_printer_stops_on_closed_pipe() {
        let (tx, rx) = tokio::sync::broadcast::channel::<serde_json::Value>(64);
        let (sink, reader) = duplex(1024);
        let handle = spawn_event_printer(rx, sink);
        drop(reader); // host closes the pipe immediately

        tx.send(serde_json::json!({ "type": "probe", "n": 1 })).unwrap();
        // Give the printer a chance to hit the closed pipe; it must terminate
        // quietly (no panic), not keep spinning.
        let _ = tokio::time::timeout(std::time::Duration::from_millis(200), handle).await;
    }
}
