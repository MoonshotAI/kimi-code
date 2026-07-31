//! MCP SSE streaming client — Phase 7.2 of the Rust napi-rs migration roadmap.
//!
//! Companion to `mcp_http.rs`: where `mcp_http.rs` handles the
//! non-streaming JSON-RPC over HTTP POST branch of the Streamable HTTP
//! transport (spec 2025-03-26 §2.1), this module handles the SSE branch
//! (§2.2 — `Content-Type: text/event-stream`).
//!
//! Server-sent events from MCP carry:
//!   - `event: message` `data: <json-rpc-2.0>` — the common case for
//!     streaming JSON-RPC responses and server notifications.
//!   - `event: endpoint` `data: <relative-url>` — server telling the
//!     client where to GET a long-lived SSE stream for unsolicited
//!     messages. Not handled yet (tracked as Phase 7.4).
//!   - `event: close` — clean shutdown of the server-side stream. Honored
//!     by terminating our collection loop.
//!
//! Scope: collect the entire stream into a `Vec<SseEvent>` and return it.
//! True per-event push to JS requires ThreadsafeFunction (Phase 8 work).
//! For the current TS orchestrator — which awaits a complete RPC reply —
//! "collect, then yield" is functionally equivalent.
//!
//! Like `mcp_http_post`, the HTTP client is shared per-call. Session
//! ID, headers, and timeouts follow the same conventions.

use std::time::Duration;

use futures_util::StreamExt;
use eventsource_stream::Eventsource as _;
use serde_json::Value;

/// One Server-Sent Event from an MCP streamable-HTTP response.
///
/// `event` is the SSE `event:` field. Per the spec, almost every event
/// will be `event: message` with `data` carrying a JSON-RPC 2.0 payload.
/// The raw `data` is kept as `String` rather than parsed eagerly so
/// callers can decide whether to JSON-parse, log, or forward it.
#[derive(Debug, Clone)]
pub struct SseEvent {
    /// SSE `event:` field. Almost always `"message"` for MCP; `"endpoint"`
    /// and `"close"` are spec-compliant alternatives.
    pub event: String,
    /// SSE `data:` field. For MCP, this is a JSON-RPC 2.0 object/array.
    pub data: String,
    /// Optional SSE `id:` field. Used for resumability on retry.
    pub id: Option<String>,
}

/// Open an SSE stream against an MCP endpoint and collect every event
/// until the server closes the connection, an event type of `close` is
/// received, or the request times out.
///
/// `url` is the full MCP endpoint URL — usually the same one used by
/// `mcp_http_post`. The request is sent as a POST when `body` is `Some`
/// (the common case for a streamable JSON-RPC request that the server
/// will reply to via SSE); a `GET` is sent when `body` is `None` (used
/// for opening a long-lived listener stream per spec §2.2 — Phase 7.4).
pub async fn mcp_sse_collect(
    url: &str,
    method: SseMethod,
    body: Option<&Value>,
    session_id: Option<&str>,
    extra_headers: &Value,
    timeout_ms: u64,
) -> Result<Vec<SseEvent>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .user_agent(concat!("kimi-native-tools/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))?;

    let mut req = match method {
        SseMethod::Post => client.post(url),
        SseMethod::Get => client.get(url),
    };
    req = req
        .header("Accept", "text/event-stream, application/json")
        .header("Cache-Control", "no-store");

    if let Some(sid) = session_id {
        if !sid.is_empty() {
            req = req.header("Mcp-Session-Id", sid);
        }
    }

    if let Some(obj) = extra_headers.as_object() {
        for (k, v) in obj {
            if let Some(s) = v.as_str() {
                req = req.header(k.as_str(), s);
            }
        }
    }

    if let Some(b) = body {
        req = req
            .header("Content-Type", "application/json")
            .json(b);
    }

    let response = req
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "HTTP {} (non-SSE response): {}",
            status.as_u16(),
            body.chars().take(512).collect::<String>()
        ));
    }

    let content_type = response
        .headers()
        .get("Content-Type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    if !content_type.starts_with("text/event-stream") {
        return Err(format!(
            "expected text/event-stream, got `{}` — server may have returned a non-streaming response",
            content_type
        ));
    }

    let mut stream = response.bytes_stream().eventsource();
    let mut out = Vec::new();

    while let Some(event) = stream.next().await {
        let event = event.map_err(|e| format!("SSE stream error: {e}"))?;
        let is_close = event.event == "close";
        // `eventsource_stream` gives `id` as a `String` (empty when the
        // server didn't send an `id:` line). Squash the empty case so
        // downstream consumers can use `Option<String>`.
        let id = if event.id.is_empty() {
            None
        } else {
            Some(event.id)
        };
        out.push(SseEvent {
            event: event.event,
            data: event.data,
            id,
        });
        if is_close {
            break;
        }
    }

    Ok(out)
}

/// HTTP method to use for the SSE request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SseMethod {
    Post,
    Get,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Spawn a one-shot HTTP server that responds with a chunked
    /// `text/event-stream` body. Used by the round-trip tests below.
    ///
    /// Returns the port it bound to so the test client can connect.
    async fn spawn_sse_server(events: Vec<(&'static str, &'static str)>) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut tmp = [0u8; 1024];
            // Read the request headers (we don't care about the body).
            loop {
                let n = stream.read(&mut tmp).await.unwrap();
                buf.extend_from_slice(&tmp[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            // Send response.
            let mut body = String::new();
            for (event_type, data) in &events {
                body.push_str(&format!("event: {event_type}\ndata: {data}\n\n"));
            }
            let header = format!(
                "HTTP/1.1 200 OK\r\n\
                 Content-Type: text/event-stream\r\n\
                 Cache-Control: no-cache\r\n\
                 Connection: close\r\n\
                 Content-Length: {}\r\n\
                 \r\n",
                body.len()
            );
            stream.write_all(header.as_bytes()).await.unwrap();
            stream.write_all(body.as_bytes()).await.unwrap();
            stream.shutdown().await.unwrap();
        });
        port
    }

    #[tokio::test]
    async fn sse_round_trip_collects_multiple_message_events() {
        let port = spawn_sse_server(vec![
            ("message", r#"{"jsonrpc":"2.0","id":1,"result":{"step":1}}"#),
            ("message", r#"{"jsonrpc":"2.0","id":1,"result":{"step":2}}"#),
            ("message", r#"{"jsonrpc":"2.0","id":1,"result":{"step":3}}"#),
        ])
        .await;

        let url = format!("http://127.0.0.1:{port}/mcp");
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "stream_progress"}
        });
        let events = mcp_sse_collect(
            &url,
            SseMethod::Post,
            Some(&body),
            None,
            &json!({}),
            5000,
        )
        .await
        .expect("sse collect failed");

        assert_eq!(events.len(), 3);
        for (i, ev) in events.iter().enumerate() {
            assert_eq!(ev.event, "message");
            let parsed: Value = serde_json::from_str(&ev.data).unwrap();
            assert_eq!(parsed["result"]["step"], i + 1);
        }
    }

    #[tokio::test]
    async fn sse_close_event_terminates_collection() {
        let port = spawn_sse_server(vec![
            ("message", r#"{"jsonrpc":"2.0","id":1,"result":"first"}"#),
            ("close", ""),
            // This event should NOT be collected — `close` ends the loop.
            ("message", r#"{"jsonrpc":"2.0","id":1,"result":"never_seen"}"#),
        ])
        .await;

        let url = format!("http://127.0.0.1:{port}/mcp");
        let events = mcp_sse_collect(&url, SseMethod::Get, None, None, &json!({}), 5000)
            .await
            .expect("sse collect failed");

        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event, "message");
        assert_eq!(events[1].event, "close");
    }

    #[tokio::test]
    async fn sse_session_id_is_forwarded() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut tmp = [0u8; 1024];
            loop {
                let n = stream.read(&mut tmp).await.unwrap();
                buf.extend_from_slice(&tmp[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            // Echo the session id back as data so the test can verify it
            // round-tripped from caller → server.
            let echoed = String::from_utf8_lossy(&buf);
            let sid = echoed
                .lines()
                .find_map(|line| {
                    if line.to_lowercase().starts_with("mcp-session-id:") {
                        Some(line[15..].trim().to_string())
                    } else {
                        None
                    }
                })
                .unwrap_or_default();
            let body = format!(r#"event: message
data: {{"echoed_session":"{sid}"}}

"#);
            let header = format!(
                "HTTP/1.1 200 OK\r\n\
                 Content-Type: text/event-stream\r\n\
                 Content-Length: {}\r\n\
                 Connection: close\r\n\
                 \r\n",
                body.len()
            );
            stream.write_all(header.as_bytes()).await.unwrap();
            stream.write_all(body.as_bytes()).await.unwrap();
            stream.shutdown().await.unwrap();
        });

        let url = format!("http://127.0.0.1:{port}/mcp");
        let events = mcp_sse_collect(
            &url,
            SseMethod::Get,
            None,
            Some("sess-abc"),
            &json!({}),
            5000,
        )
        .await
        .expect("sse collect failed");

        assert_eq!(events.len(), 1);
        let echoed: Value = serde_json::from_str(&events[0].data).unwrap();
        assert_eq!(echoed["echoed_session"], "sess-abc");
    }

    #[tokio::test]
    async fn non_event_stream_response_rejected() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut tmp = [0u8; 1024];
            loop {
                let n = stream.read(&mut tmp).await.unwrap();
                buf.extend_from_slice(&tmp[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let body = b"{\"error\":\"oops\"}";
            let header = format!(
                "HTTP/1.1 200 OK\r\n\
                 Content-Type: application/json\r\n\
                 Content-Length: {}\r\n\
                 Connection: close\r\n\
                 \r\n",
                body.len()
            );
            stream.write_all(header.as_bytes()).await.unwrap();
            stream.write_all(body).await.unwrap();
            stream.shutdown().await.unwrap();
        });

        let url = format!("http://127.0.0.1:{port}/mcp");
        let err = mcp_sse_collect(&url, SseMethod::Get, None, None, &json!({}), 5000)
            .await
            .expect_err("expected error");
        assert!(
            err.contains("text/event-stream"),
            "got: {err}"
        );
    }

    #[test]
    fn sse_event_struct_carries_id() {
        // Lightweight unit test that doesn't need a server — just makes
        // sure the public type's fields are accessible.
        let ev = SseEvent {
            event: "message".into(),
            data: "{}".into(),
            id: Some("evt-42".into()),
        };
        assert_eq!(ev.id.as_deref(), Some("evt-42"));
    }
}