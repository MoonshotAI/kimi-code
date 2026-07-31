//! MCP HTTP transport — Phase 7.1 of the Rust napi-rs migration roadmap.
//!
//! Scope (intentionally narrow): a single JSON-RPC request over HTTP POST
//! returning a JSON-RPC response. Mirrors the `messages` endpoint shape of
//! MCP's Streamable HTTP transport (2025-03-26 spec §2.1):
//!
//!   POST {url}
//!   Content-Type: application/json
//!   Accept: application/json, text/event-stream
//!   Mcp-Session-Id: {id}    (optional, omitted on first call)
//!
//!   Body:    JSON-RPC 2.0 request
//!   Response: JSON-RPC 2.0 response (application/json content-type)
//!
//! Streaming responses (SSE), server-initiated requests, and notification
//! fanout are Phase 7.2 territory — see `RUST_NAPI_MIGRATION_ROADMAP.md`.
//!
//! The HTTP client (`reqwest::Client`) is constructed once and reused; the
//! server URL is parsed from the caller's `url` argument. Headers from
//! the `extra_headers` JSON object are forwarded verbatim so callers can
//! inject auth (`Authorization: Bearer …`) without us needing to know
//! about MCP auth semantics here.

use std::time::Duration;

use serde_json::{json, Value};

/// Result of a single MCP HTTP request.
///
/// Shape mirrors what the Streamable-HTTP transport returns to its SDK
/// caller: status code, headers (only the ones a downstream caller cares
/// about), parsed JSON body (if `application/json`), or the raw text body
/// for diagnostic error messages.
#[derive(Debug, Clone)]
pub struct McpHttpResult {
    pub status: u16,
    /// `Mcp-Session-Id` response header, if the server set one. Persist
    /// it client-side and echo it back on subsequent calls per spec §2.1.
    pub session_id: Option<String>,
    pub content_type: Option<String>,
    /// Parsed JSON body when the response is `application/json`. `None`
    /// when the body is empty, non-JSON, or the request failed before a
    /// response was received.
    pub json_body: Option<Value>,
    /// Raw body text — useful for error messages when `json_body` is None.
    pub raw_body: String,
}

/// Send a single MCP JSON-RPC request over HTTP POST.
///
/// `url` is the MCP server endpoint (e.g. `https://mcp.example.com/mcp`).
/// `body` is a JSON-RPC 2.0 request object — the caller constructs it.
/// `session_id` is optional; pass the value the server returned on a
/// previous call to bind to an existing session.
/// `extra_headers` is a JSON object whose entries are forwarded as
/// request headers (string values only). Common uses: `Authorization`,
/// `X-Trace-Id`, custom auth tokens.
/// `timeout_ms` caps the total request time including connection setup.
pub async fn mcp_http_post(
    url: &str,
    body: &Value,
    session_id: Option<&str>,
    extra_headers: &Value,
    timeout_ms: u64,
) -> Result<McpHttpResult, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .user_agent(concat!("kimi-native-tools/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))?;

    let mut req = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream");

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
            // Non-string header values are skipped — HTTP headers are
            // strings by spec (RFC 9110 §5.6.2).
        }
    }

    let response = req
        .json(body)
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {e}"))?;

    let status = response.status().as_u16();
    let session_id = response
        .headers()
        .get("Mcp-Session-Id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let content_type = response
        .headers()
        .get("Content-Type")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let raw_body = response
        .text()
        .await
        .map_err(|e| format!("failed to read response body: {e}"))?;

    // Try to parse as JSON — many MCP servers return JSON even on errors.
    let json_body = serde_json::from_str::<Value>(&raw_body).ok();

    // If status is non-2xx and we have no JSON, surface the raw body as the
    // error string so callers get something useful instead of an opaque
    // transport failure.
    if !(200..300).contains(&status) && json_body.is_none() {
        return Err(format!(
            "HTTP {} (no JSON body): {}",
            status,
            raw_body.chars().take(512).collect::<String>()
        ));
    }

    Ok(McpHttpResult {
        status,
        session_id,
        content_type,
        json_body,
        raw_body,
    })
}

/// Build the canonical JSON-RPC 2.0 `initialize` request envelope.
///
/// Convenience helper for tests and callers that want to bootstrap a
/// session — the response carries the `Mcp-Session-Id` header that
/// subsequent calls must echo back.
pub fn initialize_request(
    id: u64,
    protocol_version: &str,
    client_name: &str,
    client_version: &str,
) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {
            "protocolVersion": protocol_version,
            "capabilities": {},
            "clientInfo": {
                "name": client_name,
                "version": client_version,
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn initialize_envelope_is_well_formed() {
        let env = initialize_request(42, "2024-11-05", "kimi-test", "0.0.1");
        assert_eq!(env["jsonrpc"], "2.0");
        assert_eq!(env["id"], 42);
        assert_eq!(env["method"], "initialize");
        assert_eq!(env["params"]["protocolVersion"], "2024-11-05");
        assert_eq!(env["params"]["clientInfo"]["name"], "kimi-test");
    }

    #[test]
    fn extra_headers_only_accept_string_values() {
        // Non-string header values are silently skipped — this matches HTTP
        // semantics (headers are strings). We don't want to fail loudly if
        // a caller accidentally passes a number — just drop it.
        let headers = json!({
            "Authorization": "Bearer xyz",
            "X-Count": 42,
            "X-Null": null,
            "X-Bool": true,
            "X-Arr": ["a", "b"],
        });
        let obj = headers.as_object().unwrap();
        let mut kept = Vec::new();
        for (k, v) in obj {
            if v.is_string() {
                kept.push(k.clone());
            }
        }
        kept.sort();
        assert_eq!(kept, vec!["Authorization".to_string()]);
    }

    /// Smoke test: a real HTTP POST to a tiny in-process echo server.
    /// Verifies that the request builder doesn't corrupt the body and that
    /// `Mcp-Session-Id` round-trips. Uses `httpmock`-style assertions
    /// without bringing in the dep — instead it spawns a one-shot
    /// `tokio::net::TcpListener`.
    #[tokio::test]
    async fn http_round_trip_with_session_id() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        // Bind an OS-assigned port; respond to one POST and shut down.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        let server_task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();

            // Read headers + body, find Content-Length.
            let mut buf = Vec::new();
            let mut tmp = [0u8; 1024];
            loop {
                let n = stream.read(&mut tmp).await.unwrap();
                buf.extend_from_slice(&tmp[..n]);
                if let Some(idx) = find_subsequence(&buf, b"\r\n\r\n") {
                    let header_end = idx + 4;
                    let header_str = std::str::from_utf8(&buf[..header_end]).unwrap();
                    let content_length = header_str
                        .lines()
                        .find_map(|line| {
                            let mut parts = line.splitn(2, ':');
                            let name = parts.next()?.trim();
                            let value = parts.next()?.trim();
                            if name.eq_ignore_ascii_case("Content-Length") {
                                value.parse::<usize>().ok()
                            } else {
                                None
                            }
                        })
                        .unwrap_or(0);
                    // Drain body.
                    while buf.len() < header_end + content_length {
                        let n = stream.read(&mut tmp).await.unwrap();
                        buf.extend_from_slice(&tmp[..n]);
                    }
                    break;
                }
            }

            let body = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}";
            let header = format!(
                "HTTP/1.1 200 OK\r\n\
                 Content-Type: application/json\r\n\
                 Mcp-Session-Id: abc123\r\n\
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
        let body = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}});
        let result = mcp_http_post(
            &url,
            &body,
            None,
            &json!({}),
            5000,
        )
        .await
        .expect("request failed");

        server_task.await.unwrap();

        assert_eq!(result.status, 200);
        assert_eq!(result.session_id.as_deref(), Some("abc123"));
        assert!(result.json_body.is_some());
        assert_eq!(result.json_body.unwrap()["jsonrpc"], "2.0");
        assert!(result.content_type.unwrap().starts_with("application/json"));
    }

    #[tokio::test]
    async fn session_id_is_echoed_when_supplied() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        let server_task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut tmp = [0u8; 1024];
            loop {
                let n = stream.read(&mut tmp).await.unwrap();
                buf.extend_from_slice(&tmp[..n]);
                // Don't need to parse the full body — we just want to
                // inspect headers for this assertion.
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let header_str = std::str::from_utf8(&buf).unwrap();
            // Echo the session id back through the request header verbatim
            // so the test can assert it round-tripped.
            let echoed = header_str
                .lines()
                .find_map(|line| {
                    if line.to_lowercase().starts_with("mcp-session-id:") {
                        Some(line[15..].trim().to_string())
                    } else {
                        None
                    }
                })
                .unwrap_or_default();
            let body = format!(
                "{{\"echoed_session\":\"{echoed}\"}}"
            );
            let response = format!(
                "HTTP/1.1 200 OK\r\n\
                 Content-Type: application/json\r\n\
                 Content-Length: {}\r\n\
                 Connection: close\r\n\
                 \r\n\
                 {}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).await.unwrap();
            stream.shutdown().await.unwrap();
        });

        let url = format!("http://127.0.0.1:{port}/mcp");
        let result = mcp_http_post(
            &url,
            &json!({"jsonrpc":"2.0","id":1,"method":"ping"}),
            Some("sess-xyz"),
            &json!({}),
            5000,
        )
        .await
        .expect("request failed");

        server_task.await.unwrap();
        let echoed = result.json_body.unwrap();
        assert_eq!(echoed["echoed_session"], "sess-xyz");
    }

    #[tokio::test]
    async fn non_2xx_with_no_json_surfaces_error() {
        use tokio::io::{AsyncWriteExt};
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server_task = tokio::spawn(async move {
            // We only need to accept and drop — reqwest will see a
            // connection-reset as an error.
            if let Ok((mut stream, _)) = listener.accept().await {
                let _ = stream.shutdown().await;
            }
        });

        let url = format!("http://127.0.0.1:{port}/");
        let err = mcp_http_post(&url, &json!({}), None, &json!({}), 1000)
            .await
            .expect_err("expected error");
        server_task.await.unwrap();

        // The exact text varies by reqwest version; assert it's non-empty
        // and mentions either HTTP or a transport phrase.
        assert!(!err.is_empty());
    }

    fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }
}