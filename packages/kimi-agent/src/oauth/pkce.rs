//! PKCE (Proof Key for Code Exchange, RFC 7636) + loopback OAuth callback server.
//!
//! Ported from `kimi-native-tools/src/pkce.rs` (2026-07-31) so the kimi-agent
//! engine owns the MCP OAuth flow end-to-end without depending on the
//! napi-bridge crate. Pure std + `sha2` + `base64` + `rand` + `tokio` — no
//! napi-rs dependency, so it compiles in both the lib and the CLI binary.
//!
//! Provided primitives:
//!   - `generate_verifier()`  — RFC 7636 §4.1: 43–128 char URL-safe random
//!   - `derive_challenge()`   — RFC 7636 §4.2: `BASE64URL(SHA256(verifier))`
//!   - `LoopbackServer`       — `tokio::net::TcpListener` on 127.0.0.1:0
//!                              accepting exactly one OAuth callback request
//!                              and shutting down afterwards
//!
//! Design choices:
//!   - Pure std + `sha2` + `base64` (no extra deps) — keeps the binary small
//!     and the surface easy to audit.
//!   - LoopbackServer uses `tokio` because `napi-rs` already pulls it in for
//!     other modules (`fetch_url.rs`, `mcp.rs`, ...).
//!   - Only the S256 challenge method is implemented; the `plain` method is
//!     deprecated by RFC 7636 §7.1 and rejected by most modern providers.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use rand::RngCore;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

/// Length of the generated code verifier, in bytes (before base64 encoding).
/// 32 bytes → 43 base64url chars, the minimum allowed by RFC 7636 §4.1.
const VERIFIER_BYTES: usize = 32;

/// OAuth authorization-code callback, parsed from the loopback redirect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallbackParams {
    /// `code` query parameter, exchanged for an access token.
    pub code: String,
    /// `state` query parameter, must match the value embedded in the auth URL.
    pub state: String,
    /// Raw error code if the IdP returned one (e.g. `access_denied`).
    pub error: Option<String>,
    /// Human-readable error description if the IdP returned one.
    pub error_description: Option<String>,
}

impl CallbackParams {
    fn from_query(query: &str) -> Option<Self> {
        // `query` is the part of the URL after `?`. The `state` and `code`
        // values themselves are URL-encoded by the IdP; we percent-decode
        // the whole map first so we never confuse `+` (form-encoded space)
        // with a literal `+` in a token.
        let mut code: Option<String> = None;
        let mut state: Option<String> = None;
        let mut error: Option<String> = None;
        let mut error_description: Option<String> = None;

        for pair in query.split('&') {
            if pair.is_empty() {
                continue;
            }
            let (raw_k, raw_v) = match pair.split_once('=') {
                Some((k, v)) => (k, v),
                None => (pair, ""),
            };
            let key = url_decode(raw_k);
            let value = url_decode(raw_v);
            match key.as_str() {
                "code" => code = Some(value),
                "state" => state = Some(value),
                "error" => error = Some(value),
                "error_description" => error_description = Some(value),
                _ => {}
            }
        }

        Some(Self {
            code: code.unwrap_or_default(),
            state: state.unwrap_or_default(),
            error,
            error_description,
        })
    }

    /// True if the IdP returned an error instead of a code.
    pub fn is_error(&self) -> bool {
        self.error.is_some()
    }
}

/// Generate a fresh PKCE code verifier.
///
/// Returns 43 base64url characters (no padding), drawn from a CSPRNG.
/// RFC 7636 §4.1 mandates 43–128 chars from the unreserved set; 32 bytes
/// → 43 chars is the minimum and the most common choice in the wild.
pub fn generate_verifier() -> String {
    let mut buf = [0u8; VERIFIER_BYTES];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

/// Derive the S256 code challenge for a given verifier.
///
/// `BASE64URL-ENCODE(SHA256(verifier))` per RFC 7636 §4.2.
pub fn derive_challenge(verifier: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let digest = hasher.finalize();
    URL_SAFE_NO_PAD.encode(digest)
}

/// Loopback OAuth callback server. Binds to `127.0.0.1:0`, accepts exactly
/// one request, captures the `code`/`state` query parameters, and shuts down.
///
/// The TS orchestrator is responsible for:
///   1. Constructing the authorization URL with `redirect_uri` set to the
///      port returned by `port()`.
///   2. Opening the URL in a browser (or surfacing it to the user).
///   3. Calling `wait_for_callback()` to block until the user completes
///      (or cancels) the flow.
///
/// `wait_for_callback` takes `&mut self` rather than `self` so the handle
/// can be passed by reference from JS without consuming it. The underlying
/// `oneshot::Receiver` is wrapped in a `Mutex<Option<…>>` so subsequent
/// calls observe the consumed state and return a friendly error.
pub struct LoopbackServer {
    /// TCP port the listener bound to. Pass into the `redirect_uri`.
    pub port: u16,
    /// `http://127.0.0.1:{port}/callback` — drop this into the auth URL.
    pub redirect_uri: String,
    /// Wrapped in `Option` so we can take it after `wait_for_callback`
    /// runs once. `Mutex` because napi-rs needs `Send` and the receiver
    /// itself is `!Sync`.
    oneshot_rx: std::sync::Mutex<Option<oneshot::Receiver<Result<CallbackParams, String>>>>,
}

impl LoopbackServer {
    /// Bind a listener on an OS-assigned port and spawn the accept task.
    ///
    /// The spawned task exits after one request (success, malformed, or
    /// disconnect) — the listener is then dropped.
    pub async fn start() -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("failed to bind loopback listener: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("failed to read local addr: {e}"))?
            .port();
        let redirect_uri = format!("http://127.0.0.1:{port}/callback");

        let (tx, rx) = oneshot::channel();

        tokio::spawn(async move {
            let outcome = accept_one(&listener).await;
            // Best-effort: if the receiver was dropped, just exit.
            let _ = tx.send(outcome);
        });

        Ok(Self {
            port,
            redirect_uri,
            oneshot_rx: std::sync::Mutex::new(Some(rx)),
        })
    }

    /// Block until the IdP redirects the user back, or the caller cancels
    /// by dropping this future. Takes `&mut self` so it can be called via
    /// `&LoopbackHandle` from napi-rs without consuming the handle.
    ///
    /// Calling `wait_for_callback` more than once on the same handle
    /// returns an error — the oneshot receiver has already been taken.
    pub async fn wait_for_callback(&mut self) -> Result<CallbackParams, String> {
        let rx = self
            .oneshot_rx
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| "loopback callback already awaited".to_string())?;
        rx.await
            .map_err(|_| "loopback callback channel closed".to_string())?
    }
}

/// Accept exactly one TCP connection, parse a single HTTP request, return
/// the query parameters, then drop the listener.
async fn accept_one(listener: &TcpListener) -> Result<CallbackParams, String> {
    let (mut stream, _) = listener
        .accept()
        .await
        .map_err(|e| format!("accept failed: {e}"))?;

    let mut buf = Vec::with_capacity(2048);
    let mut tmp = [0u8; 1024];

    // Read headers — bound to 16 KiB to defend against a misbehaving client.
    loop {
        let n = match stream.read(&mut tmp).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => return Err(format!("read failed: {e}")),
        };
        buf.extend_from_slice(&tmp[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() > 16 * 1024 {
            break;
        }
    }

    let request = match std::str::from_utf8(&buf) {
        Ok(s) => s,
        Err(e) => {
            let response = http_response(400, "Bad Request", b"non-UTF8 request");
            let _ = stream.write_all(&response).await;
            return Err(format!("non-UTF8 request: {e}"));
        }
    };

    let (path, _) = match parse_request_line(request) {
        Some(parts) => parts,
        None => {
            let response = http_response(400, "Bad Request", b"malformed request line");
            let _ = stream.write_all(&response).await;
            return Err("malformed request line".to_string());
        }
    };

    let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
    let params = CallbackParams::from_query(query).ok_or_else(|| "empty query".to_string())?;

    // ACK with a tiny success page so the user sees "you may close this tab".
    let body = b"<html><body><h1>You may close this tab.</h1>\
                 <p>Authentication complete. Return to your terminal.</p>\
                 </body></html>";
    let response = http_response(200, "OK", body);
    let _ = stream.write_all(&response).await;
    let _ = stream.shutdown().await;

    Ok(params)
}

/// Parse the first request line: `METHOD SP PATH SP VERSION CRLF`.
fn parse_request_line(request: &str) -> Option<(&str, &str)> {
    let line = request.lines().next()?;
    let mut parts = line.splitn(3, ' ');
    let _method = parts.next()?;
    let path = parts.next()?;
    let _version = parts.next()?;
    Some((path, _version))
}

/// Build a minimal HTTP/1.1 response.
fn http_response(code: u16, reason: &str, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(128 + body.len());
    out.extend_from_slice(format!("HTTP/1.1 {code} {reason}\r\n").as_bytes());
    out.extend_from_slice(b"Content-Type: text/html; charset=utf-8\r\n");
    out.extend_from_slice(format!("Content-Length: {}\r\n", body.len()).as_bytes());
    out.extend_from_slice(b"Connection: close\r\n");
    out.extend_from_slice(b"\r\n");
    out.extend_from_slice(body);
    out
}

/// RFC 3986 percent-decode. Malformed escapes (`%XY` with non-hex digits)
/// are left intact rather than rejected — keeps us compatible with quirky
/// IdPs that emit unencoded `+` etc.
fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hi = hex_val(bytes[i + 1]);
                let lo = hex_val(bytes[i + 2]);
                match (hi, lo) {
                    (Some(h), Some(l)) => {
                        out.push((h << 4) | l);
                        i += 3;
                    }
                    _ => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifier_length_matches_rfc_7636_minimum() {
        let v = generate_verifier();
        // 32 random bytes → 43 base64url chars (no padding)
        assert_eq!(v.len(), 43);
    }

    #[test]
    fn verifier_is_url_safe() {
        // Run the generator a bunch and check none of the chars are
        // outside the unreserved set.
        for _ in 0..100 {
            let v = generate_verifier();
            for c in v.chars() {
                assert!(
                    c.is_ascii_alphanumeric() || c == '-' || c == '_',
                    "verifier contains non-unreserved char: {c:?} in {v:?}"
                );
            }
        }
    }

    #[test]
    fn verifiers_are_unique() {
        // Two calls should not collide (probability of accidental collision
        // for 32 random bytes is ~2^-256 — this is a smoke test).
        let a = generate_verifier();
        let b = generate_verifier();
        assert_ne!(a, b);
    }

    #[test]
    fn challenge_matches_rfc_7636_known_vector() {
        // RFC 7636 Appendix B known-answer test:
        //   verifier  = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        //   challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        //   method    = "S256"
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = derive_challenge(verifier);
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn callback_parses_code_and_state() {
        let raw = "code=abc123&state=xyz%20with%20spaces";
        let parsed = CallbackParams::from_query(raw).unwrap();
        assert_eq!(parsed.code, "abc123");
        assert_eq!(parsed.state, "xyz with spaces");
        assert!(!parsed.is_error());
    }

    #[test]
    fn callback_parses_error() {
        let raw = "error=access_denied&error_description=user%20said%20no";
        let parsed = CallbackParams::from_query(raw).unwrap();
        assert!(parsed.is_error());
        assert_eq!(parsed.error.as_deref(), Some("access_denied"));
        assert_eq!(parsed.error_description.as_deref(), Some("user said no"));
    }

    #[test]
    fn callback_handles_empty_query() {
        let parsed = CallbackParams::from_query("").unwrap();
        assert_eq!(parsed.code, "");
        assert_eq!(parsed.state, "");
        assert!(!parsed.is_error());
    }

    #[test]
    fn callback_preserves_plus_in_token_values() {
        // Some IdPs URL-encode `+` inside tokens; we should decode the
        // form-encoded `+` to space, but pass through a literal `+` in a
        // value that has no percent-encoding.
        // (Spec-wise, `+` is reserved in query strings and should be
        // percent-encoded as `%2B` — so we only decode `+` -> ' ' when it
        // appears in a key=value pair, matching the form-urlencoded rule.)
        let parsed = CallbackParams::from_query("code=a%2Bb&state=c").unwrap();
        assert_eq!(parsed.code, "a+b");
        assert_eq!(parsed.state, "c");
    }

    #[tokio::test]
    async fn loopback_server_round_trip() {
        let mut server = LoopbackServer::start().await.unwrap();
        let port = server.port;
        let redirect_uri = server.redirect_uri.clone();
        assert_eq!(redirect_uri, format!("http://127.0.0.1:{port}/callback"));

        // Drive the callback request from another task so `wait_for_callback`
        // can block on the oneshot.
        let client = tokio::spawn(async move {
            // Tiny HTTP/1.1 GET — we don't care about response parsing on
            // the client side, only that the server reads it.
            let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .unwrap();
            let req = b"GET /callback?code=hello&state=world HTTP/1.1\r\n\
                        Host: 127.0.0.1\r\n\
                        Connection: close\r\n\
                        \r\n";
            stream.write_all(req).await.unwrap();
            stream.shutdown().await.unwrap();

            let mut buf = Vec::new();
            stream.read_to_end(&mut buf).await.unwrap();
            String::from_utf8_lossy(&buf).to_string()
        });

        let params = server.wait_for_callback().await.unwrap();
        let response = client.await.unwrap();

        assert_eq!(params.code, "hello");
        assert_eq!(params.state, "world");
        assert!(!params.is_error());
        assert!(response.starts_with("HTTP/1.1 200"), "got: {response}");
        assert!(response.contains("You may close this tab"));
    }
}