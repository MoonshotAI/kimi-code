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

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let server = Server::build()?;
    let processor = Arc::new(server.processor);

    // `kimi-server-serve --ws <addr>`: serve the same processor over
    // WebSocket instead of stdio (the future web-host wire).
    let args: Vec<String> = std::env::args().skip(1).collect();
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
