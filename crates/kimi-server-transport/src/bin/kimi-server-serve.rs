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
    let mut stdout = tokio::io::stdout();
    kimi_server_transport::stdio::serve(&processor, stdin, &mut stdout).await;
    event_printer.abort();
    Ok(())
}
