//! Remote stdio client — spawn a server process and speak line JSON-RPC.
//! The wire format matches the engine's stdio: one request per line out,
//! one response per line in.

use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};

/// A spawned server process client.
pub struct StdioClient {
    child: Child,
    stdin: tokio::process::ChildStdin,
    reader: BufReader<tokio::process::ChildStdout>,
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
        Ok(Self {
            child,
            stdin,
            reader: BufReader::new(stdout),
        })
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
        Ok((
            Self {
                child,
                stdin,
                reader: BufReader::new(stdout),
            },
            stderr,
        ))
    }

    /// Make a JSON-RPC call; resolves with the full wire response body.
    pub async fn call(&mut self, method: &str, params: serde_json::Value) -> serde_json::Value {
        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        });
        let mut line = serde_json::to_string(&request).unwrap_or_default();
        line.push('\n');
        if self.stdin.write_all(line.as_bytes()).await.is_err() {
            return serde_json::json!({ "jsonrpc": "2.0", "id": 1, "error": { "code": -32000, "message": "write failed" } });
        }
        if self.stdin.flush().await.is_err() {
            return serde_json::json!({ "jsonrpc": "2.0", "id": 1, "error": { "code": -32000, "message": "flush failed" } });
        }
        let mut response = String::new();
        if self.reader.read_line(&mut response).await.is_err() || response.is_empty() {
            return serde_json::json!({ "jsonrpc": "2.0", "id": 1, "error": { "code": -32000, "message": "read failed" } });
        }
        serde_json::from_str(response.trim()).unwrap_or_else(|_| {
            serde_json::json!({ "jsonrpc": "2.0", "id": 1, "error": { "code": -32000, "message": "parse failed" } })
        })
    }

    /// Wait for the child to exit (closes stdin first).
    pub async fn wait(mut self) -> std::io::Result<std::process::ExitStatus> {
        drop(self.stdin);
        self.child.wait().await
    }
}
