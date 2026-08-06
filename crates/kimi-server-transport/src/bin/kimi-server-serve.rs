//! `kimi-server-serve` — stand up a kimi-server over stdio.
//!
//! One JSON-RPC request per line in, one response per line out. Hosts that
//! cannot embed the engine (separate process, language boundary) spawn this
//! binary and talk to it through `kimi-server-client`'s Remote variant.
//!
//! Engine events are fanned out to stderr as JSON lines (bounded) so a
//! `--verbose` host sees progress without a second channel; the request
//! stream on stdout stays untouched.

use std::sync::Arc;

use kimi_server::Server;

/// Resolve the expected bearer credential (kap-server parity): the
/// `KIMI_CODE_PASSWORD` env wins, then `<KIMI_CODE_HOME>/server.token`; when
/// neither exists the server runs lenient unless `--no-auth` is absent and
/// auth is forced. `no_auth` disables validation entirely (dev mode).
fn auth_config(no_auth: bool) -> kimi_server_transport::http::AuthConfig {
    let token = if no_auth {
        None
    } else {
        let resolved = std::env::var("KIMI_CODE_PASSWORD").ok().or_else(|| {
            let home = std::env::var("KIMI_CODE_HOME").unwrap_or_else(|_| {
                std::env::var("HOME")
                    .or_else(|_| std::env::var("USERPROFILE"))
                    .map(|h| format!("{h}/.kimi-code"))
                    .unwrap_or_default()
            });
            let path = format!("{home}/server.token");
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
        eprintln!(
            "kimi-server-serve: auth required (KIMI_CODE_PASSWORD or server.token)"
        );
        resolved
    };
    kimi_server_transport::http::AuthConfig { token }
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
        axum::serve(listener, router).await?;
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

    // Fan engine events out to stderr (fire-and-forget; bounded so a chatty
    // turn cannot flood the host terminal). StdioClient spawns with stderr
    // inherited, so Remote hosts get the stream for free.
    let mut events = server.state.subscribe_events();
    let event_printer = tokio::spawn(async move {
        let mut lines = 0usize;
        while let Ok(event) = events.recv().await {
            eprintln!("[event] {}", serde_json::to_string(&event).unwrap_or_default());
            lines += 1;
            if lines >= 512 {
                break; // bound verbose output
            }
        }
    });

    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();
    kimi_server_transport::stdio::serve(&processor, stdin, stdout).await;
    event_printer.abort();
    Ok(())
}
