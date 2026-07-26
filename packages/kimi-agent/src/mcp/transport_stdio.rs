/// MCP stdio transport client.
///
/// Mirrors the TS `packages/agent-core/src/mcp/client-stdio.ts`.
/// Communicates with an MCP server over stdin/stdout of a child process.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};

use crate::mcp::types::*;

/// An MCP stdio transport client.
pub struct MCPStdioTransport {
    /// The child process.
    child: Option<Child>,
    /// Stdin writer.
    stdin: Option<ChildStdin>,
    /// Next JSON-RPC request ID.
    next_id: AtomicU32,
}

impl MCPStdioTransport {
    /// Create a new MCP stdio transport and spawn the server process.
    pub fn spawn(command: &str, args: &[String]) -> Result<Self, String> {
        let mut child = Command::new(command)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn MCP server: {e}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to capture stdin".to_string())?;

        Ok(Self {
            child: Some(child),
            stdin: Some(stdin),
            next_id: AtomicU32::new(1),
        })
    }

    /// Call the MCP `tools/list` endpoint.
    pub fn list_tools(&mut self) -> Result<MCPToolsListResult, String> {
        let response = self.send_request("tools/list", serde_json::json!(null))?;
        serde_json::from_value(response)
            .map_err(|e| format!("Failed to parse tools/list response: {e}"))
    }

    /// Call the MCP `tools/call` endpoint.
    pub fn call_tool(
        &mut self,
        name: &str,
        arguments: Option<serde_json::Value>,
    ) -> Result<MCPToolCallResult, String> {
        let params = serde_json::json!({
            "name": name,
            "arguments": arguments,
        });
        let response = self.send_request("tools/call", params)?;
        serde_json::from_value(response)
            .map_err(|e| format!("Failed to parse tools/call response: {e}"))
    }

    /// Send a JSON-RPC request and read the response.
    fn send_request(&mut self, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let request = MCPJsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: serde_json::json!(id),
            method: method.into(),
            params: Some(params),
        };

        // Write request to stdin
        let request_json = serde_json::to_string(&request)
            .map_err(|e| format!("Serialize error: {e}"))?;

        let stdin = self.stdin.as_mut()
            .ok_or_else(|| "Transport not connected".to_string())?;
        writeln!(stdin, "{}", request_json)
            .map_err(|e| format!("Failed to write to stdin: {e}"))?;
        stdin.flush()
            .map_err(|e| format!("Failed to flush stdin: {e}"))?;

        // Read response from stdout
        let child = self.child.as_mut()
            .ok_or_else(|| "Transport not connected".to_string())?;
        let stdout = child.stdout.as_mut()
            .ok_or_else(|| "No stdout".to_string())?;
        let mut reader = BufReader::new(stdout);

        let mut line = String::new();
        reader.read_line(&mut line)
            .map_err(|e| format!("Failed to read response: {e}"))?;

        let rpc_response: MCPJsonRpcResponse = serde_json::from_str(&line)
            .map_err(|e| format!("Failed to parse JSON-RPC response: {e}"))?;

        if let Some(error) = rpc_response.error {
            return Err(format!("MCP error [{}]: {}", error.code, error.message));
        }

        rpc_response
            .result
            .ok_or_else(|| "MCP response has no result".into())
    }

    /// Close the transport.
    pub fn shutdown(&mut self) -> Result<(), String> {
        if let Some(mut child) = self.child.take() {
            child.kill().map_err(|e| format!("Failed to kill process: {e}"))?;
            child.wait().map_err(|e| format!("Failed to wait for process: {e}"))?;
        }
        self.stdin = None;
        Ok(())
    }
}

impl Drop for MCPStdioTransport {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_next_id_increments() {
        let transport = MCPStdioTransport {
            child: None,
            stdin: None,
            next_id: AtomicU32::new(1),
        };
        assert_eq!(transport.next_id.load(Ordering::SeqCst), 1);
    }
}