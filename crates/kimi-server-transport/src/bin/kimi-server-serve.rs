//! `kimi-server-serve` — stand up a kimi-server over stdio.
//!
//! One JSON-RPC request per line in, one response per line out. Hosts that
//! cannot embed the engine (separate process, language boundary) spawn this
//! binary and talk to it through `kimi-server-client`'s Remote variant.

use std::sync::Arc;

use kimi_server::Server;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let server = Server::build()?;
    let processor = Arc::new(server.processor);
    let stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    kimi_server_transport::stdio::serve(&processor, stdin, &mut stdout).await;
    Ok(())
}
