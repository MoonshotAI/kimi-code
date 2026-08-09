//! `kimi-server-serve` — stand up a kimi-server over stdio.
//!
//! One JSON-RPC request per line in, one response per line out. Hosts that
//! cannot embed the engine (separate process, language boundary) spawn this
//! binary and talk to it through `kimi-server-client`'s Remote variant.
//!
//! Engine events are fanned out to stderr as JSON lines (unbounded) so a
//! `--verbose` host sees progress without a second channel; the request
//! stream on stdout stays untouched.

use std::sync::Arc;

use kimi_server::Server;

/// Resolve the expected bearer credential (kap-server parity): the
/// `KIMI_CODE_PASSWORD` env wins, then `<KIMI_CODE_HOME>/server.token`; when
/// neither exists a fresh token is generated and persisted (kap-server
/// `persistentToken` parity) so `kimi web` — which reads `server.token` to
/// build the browser URL — stays in sync. `--no-auth` disables validation
/// entirely (dev mode).
fn auth_config(no_auth: bool) -> kimi_server_transport::http::AuthConfig {
    let token = if no_auth {
        None
    } else {
        let home = kimi_code_home();
        let path = format!("{home}/server.token");
        let resolved = std::env::var("KIMI_CODE_PASSWORD").ok().or_else(|| {
            let value = std::fs::read_to_string(&path)
                .ok()
                // Strip a UTF-8 BOM (some editors/tools write one); Rust's
                // `trim()` does not treat U+FEFF as whitespace.
                .map(|s| s.trim().trim_start_matches('\u{FEFF}').trim().to_string())
                .filter(|s| !s.is_empty());
            if value.is_none() {
                eprintln!("kimi-server-serve: no bearer token at {path}");
            }
            value
        });
        match resolved {
            Some(token) => {
                eprintln!("kimi-server-serve: auth required (KIMI_CODE_PASSWORD or server.token)");
                Some(token)
            }
            None => {
                // Neither source present: mint + persist one so the web flow
                // (which hands the browser `#token=<server.token>`) works.
                let token = generate_token();
                if let Some(parent) = std::path::Path::new(&path).parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if std::fs::write(&path, &token).is_ok() {
                    eprintln!("kimi-server-serve: generated server.token at {path}");
                    Some(token)
                } else {
                    eprintln!(
                        "kimi-server-serve: could not persist server.token at {path}; running lenient"
                    );
                    None
                }
            }
        }
    };
    kimi_server_transport::http::AuthConfig { token }
}

/// Resolve `<KIMI_CODE_HOME>` (default `~/.kimi-code`).
fn kimi_code_home() -> String {
    std::env::var("KIMI_CODE_HOME").unwrap_or_else(|_| {
        std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .map(|h| format!("{h}/.kimi-code"))
            .unwrap_or_default()
    })
}

/// Generate a random-looking bearer token without a rand dependency.
fn generate_token() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("kimi-{:016x}{:08x}{:08x}", now.as_nanos() as u64, std::process::id(), n)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let server = Server::build()?;
    let processor = Arc::new(server.processor);

    // `kimi-server-serve --http <addr> [--assets <dir>]`: serve the same
    // processor over the HTTP/REST `/api/v1` projection (the web-host wire).
    // With `--assets`, also serve the bundled SPA (the `kimi web` replacement).
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(pos) = args.iter().position(|a| a == "--http") {
        let addr = args
            .get(pos + 1)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("--http requires an address, e.g. 127.0.0.1:8080"))?;
        let listener = tokio::net::TcpListener::bind(&addr).await?;
        let assets = args.iter().position(|a| a == "--assets").and_then(|p| args.get(p + 1).cloned());
        let no_auth = args.iter().any(|a| a == "--no-auth");
        let auth = auth_config(no_auth);
        eprintln!("kimi-server-serve: http on {addr}");
        let state = kimi_server_transport::http::HttpState::with_events(processor, server.state.event_sender())
            .with_auth(auth);
        let router = match assets.as_deref() {
            Some(assets_dir) => {
                eprintln!("kimi-server-serve: serving web assets from {assets_dir}");
                kimi_server_transport::http::router_with_assets(state, assets_dir)
            }
            None => kimi_server_transport::http::router(state),
        };
        axum::serve(listener, kimi_server_transport::http::colon_make_service(router)).await?;
        return Ok(());
    }

    // `kimi-server-serve --ws <addr>`: serve the same processor over
    // WebSocket instead of stdio (the future web-host wire).
    if let Some(pos) = args.iter().position(|a| a == "--ws") {
        let addr = args
            .get(pos + 1)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("--ws requires an address, e.g. 127.0.0.1:8080"))?;
        let listener = tokio::net::TcpListener::bind(&addr).await?;
        eprintln!("kimi-server-serve: websocket on {addr}");
        kimi_server_transport::websocket::serve(&processor, listener).await?;
        return Ok(());
    }

    // Fan engine events out to stderr. Unbounded: a long-lived host (TUI,
    // harness, `--verbose` CLI) consumes the stream for the whole process
    // lifetime, so a line cap would silently cut its event stream. StdioClient
    // spawns with stderr inherited, so Remote hosts get the stream for free.
    let events = server.state.subscribe_events();
    let event_printer = kimi_server_transport::stdio::spawn_event_printer(events, tokio::io::stderr());

    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();
    kimi_server_transport::stdio::serve(&processor, stdin, stdout).await;
    event_printer.abort();
    Ok(())
}
