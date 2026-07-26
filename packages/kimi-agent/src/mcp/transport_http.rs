/// MCP HTTP transport client.
///
/// Mirrors the TS `packages/agent-core/src/mcp/client-http.ts`.
/// Handles `tools/list` and `tools/call` over HTTP transport.

use crate::mcp::types::*;

/// An MCP HTTP transport client.
pub struct MCPHttpTransport {
    /// The base URL of the MCP server.
    base_url: String,
    /// Optional API key for authentication.
    api_key: Option<String>,
    /// HTTP client (reused).
    client: reqwest::Client,
}

impl MCPHttpTransport {
    /// Create a new MCP HTTP transport.
    pub fn new(base_url: String, api_key: Option<String>) -> Self {
        Self {
            base_url,
            api_key,
            client: reqwest::Client::new(),
        }
    }

    /// Call the MCP `tools/list` endpoint.
    pub async fn list_tools(&self) -> Result<MCPToolsListResult, String> {
        let response = self
            .send_request("tools/list", serde_json::json!(null))
            .await?;
        serde_json::from_value(response)
            .map_err(|e| format!("Failed to parse tools/list response: {e}"))
    }

    /// Call the MCP `tools/call` endpoint.
    pub async fn call_tool(
        &self,
        name: &str,
        arguments: Option<serde_json::Value>,
    ) -> Result<MCPToolCallResult, String> {
        let params = serde_json::json!({
            "name": name,
            "arguments": arguments,
        });
        let response = self.send_request("tools/call", params).await?;
        serde_json::from_value(response)
            .map_err(|e| format!("Failed to parse tools/call response: {e}"))
    }

    /// Send a JSON-RPC request to the MCP server.
    async fn send_request(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let request = MCPJsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: serde_json::json!(1),
            method: method.into(),
            params: Some(params),
        };

        let mut req = self
            .client
            .post(&self.base_url)
            .json(&request);

        if let Some(ref api_key) = self.api_key {
            if !api_key.is_empty() {
                req = req.header("Authorization", format!("Bearer {}", api_key));
            }
        }

        let response = req
            .send()
            .await
            .map_err(|e| format!("HTTP request failed: {e}"))?;

        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|e| format!("Failed to read response body: {e}"))?;

        if !status.is_success() {
            return Err(format!("HTTP {}: {}", status.as_u16(), body));
        }

        let rpc_response: MCPJsonRpcResponse = serde_json::from_str(&body)
            .map_err(|e| format!("Failed to parse JSON-RPC response: {e}"))?;

        if let Some(error) = rpc_response.error {
            return Err(format!("MCP error [{}]: {}", error.code, error.message));
        }

        rpc_response
            .result
            .ok_or_else(|| "MCP response has no result".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_http_transport_creation() {
        let transport = MCPHttpTransport::new(
            "http://localhost:8080/mcp".into(),
            Some("sk-test".into()),
        );
        assert_eq!(transport.base_url, "http://localhost:8080/mcp");
        assert_eq!(transport.api_key, Some("sk-test".into()));
    }

    #[test]
    fn test_http_transport_no_auth() {
        let transport = MCPHttpTransport::new(
            "http://localhost:8080/mcp".into(),
            None,
        );
        assert!(transport.api_key.is_none());
    }
}