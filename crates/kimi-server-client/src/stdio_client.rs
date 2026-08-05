//! Remote stdio client — spawn a server process and speak line JSON-RPC.
//! The wire format matches the engine's stdio: one request per line out,
//! one response per line in.
//!
//! Unlike a naive request/response pairing, this client is **concurrent**:
//! a background task reads the response pipe and routes each line to the
//! waiting call by request id, so a long-running call (a prompt turn) does
//! not block a concurrent control call (`session/cancel`) from this same
//! client. The write side stays single-flight (one line at a time on the
//! pipe); only the waiting is decoupled.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, Mutex};

/// The pipe state of a spawned server process. The writer is shared by all
/// in-flight calls (write side is single-flight); `pending` routes responses
/// back to the right caller by request id.
struct StdioInner {
    child: Child,
    writer: tokio::process::ChildStdin,
    pending: HashMap<u64, oneshot::Sender<serde_json::Value>>,
    next_id: u64,
}

/// A spawned server process client.
pub struct StdioClient {
    inner: Arc<Mutex<StdioInner>>,
}

/// A JSON-RPC error envelope (client-side transport failure).
fn transport_error(code: i64, message: &str) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": null,
        "error": { "code": code, "message": message },
    })
}

impl StdioClient {
    /// Spawn `bin` (e.g. a kimi-server binary) with stdio piped.
    pub fn spawn(bin: &str) -> std::io::Result<Self> {
        let mut child = Command::new(bin)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        Ok(Self::from_parts(child, stdin, stdout))
    }

    /// Spawn with the server's stderr piped back to the caller (for hosts that
    /// want to render the engine's event stream instead of inheriting it).
    pub fn spawn_captured(
        bin: &str,
    ) -> std::io::Result<(Self, tokio::process::ChildStderr)> {
        let mut child = Command::new(bin)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let stderr = child.stderr.take().expect("stderr");
        Ok((Self::from_parts(child, stdin, stdout), stderr))
    }

    /// Assemble the client and start the background reader task.
    fn from_parts(
        child: Child,
        stdin: tokio::process::ChildStdin,
        stdout: tokio::process::ChildStdout,
    ) -> Self {
        let inner = Arc::new(Mutex::new(StdioInner {
            child,
            writer: stdin,
            pending: HashMap::new(),
            next_id: 1,
        }));
        spawn_reader(inner.clone(), stdout);
        Self { inner }
    }

    /// Make a JSON-RPC call; resolves with the full wire response body.
    ///
    /// The request is written under the lock (single-flight on the pipe), but
    /// the lock is **not** held for the response: the caller waits on a
    /// per-call channel that the background reader feeds, so a second,
    /// concurrent call from the same client (e.g. `session/cancel` while a
    /// prompt turn is in flight) is not blocked.
    pub async fn call(&self, method: &str, params: serde_json::Value) -> serde_json::Value {
        let rx = {
            let mut inner = self.inner.lock().await;
            let id = inner.next_id;
            inner.next_id += 1;
            let (tx, rx) = oneshot::channel();
            inner.pending.insert(id, tx);
            let request = serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": method,
                "params": params,
            });
            let mut line = serde_json::to_string(&request).unwrap_or_default();
            line.push('\n');
            if inner.writer.write_all(line.as_bytes()).await.is_err() {
                inner.pending.remove(&id);
                return transport_error(-32000, "write failed");
            }
            if inner.writer.flush().await.is_err() {
                inner.pending.remove(&id);
                return transport_error(-32000, "flush failed");
            }
            rx
        };
        match rx.await {
            Ok(body) => body,
            Err(_) => transport_error(-32000, "stdio closed"),
        }
    }

    /// Wait for the child to exit (closes stdin first).
    pub async fn wait(self) -> std::io::Result<std::process::ExitStatus> {
        let mut inner = self.inner.lock().await;
        // Shut down the write side so the child sees EOF, then reap it.
        // (`ChildStdin` cannot be moved out of the guard; `shutdown` closes the
        // write end without moving.)
        let _ = inner.writer.shutdown().await;
        inner.child.wait().await
    }
}

/// The background reader: consume response lines and hand each to the waiting
/// call by request id. On EOF (the server exited), every in-flight call is
/// failed so hosts unblock instead of hanging on a dead pipe.
fn spawn_reader(inner: Arc<Mutex<StdioInner>>, stdout: tokio::process::ChildStdout) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let Some(id) = value["id"].as_u64() else {
                continue;
            };
            let tx = {
                let mut guard = inner.lock().await;
                guard.pending.remove(&id)
            };
            if let Some(tx) = tx {
                let _ = tx.send(value);
            }
        }
        let pending = {
            let mut guard = inner.lock().await;
            std::mem::take(&mut guard.pending)
        };
        for (_, tx) in pending {
            let _ = tx.send(transport_error(-32000, "stdio closed"));
        }
    });
}
