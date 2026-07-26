/// MCP protocol types.
///
/// Mirrors the TS `packages/agent-core/src/mcp/types.ts`.
/// Covers the wire-level surface: tool definitions, tool call results.

use serde::{Deserialize, Serialize};

/// A tool definition returned by `tools/list`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MCPTool {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<serde_json::Value>,
}

/// A content block returned by `tools/call`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MCPContentBlock {
    Text { text: String },
    Image { data: String, mime_type: String },
    Resource { resource: MCPResourceContents },
    EmbeddedResource { resource: MCPResourceContents },
}

/// Resource contents (text or blob).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MCPResourceContents {
    pub uri: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob: Option<String>,
}

/// A tool call result from `tools/call`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MCPToolCallResult {
    pub content: Vec<MCPContentBlock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Value>,
}

/// Parameters for `tools/call`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MCPToolCallParams {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<serde_json::Value>,
}

/// The full `tools/list` result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MCPToolsListResult {
    pub tools: Vec<MCPTool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// A JSON-RPC request in MCP protocol.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MCPJsonRpcRequest {
    pub jsonrpc: String,
    pub id: serde_json::Value,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

/// A JSON-RPC response in MCP protocol.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MCPJsonRpcResponse {
    pub jsonrpc: String,
    pub id: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<MCPJsonRpcError>,
}

/// A JSON-RPC error in MCP protocol.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MCPJsonRpcError {
    pub code: i32,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

/// Convert MCP content blocks to plain text.
pub fn mcp_content_to_text(blocks: &[MCPContentBlock]) -> String {
    blocks
        .iter()
        .map(|block| match block {
            MCPContentBlock::Text { text } => text.clone(),
            MCPContentBlock::Image { data, mime_type } => {
                format!("[Image: {mime_type}, {data_len} bytes]", data_len = data.len())
            }
            MCPContentBlock::Resource { resource } | MCPContentBlock::EmbeddedResource { resource } => {
                resource.text.clone().unwrap_or_else(|| {
                    resource.blob.as_ref().map(|b| format!("[Blob: {} bytes]", b.len())).unwrap_or_default()
                })
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mcp_tool_serialize() {
        let tool = MCPTool {
            name: "read_file".into(),
            description: Some("Read a file".into()),
            input_schema: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string"}
                }
            })),
        };
        let json = serde_json::to_value(&tool).unwrap();
        assert_eq!(json["name"], "read_file");
        assert!(json["input_schema"].is_object());
    }

    #[test]
    fn test_tool_call_result() {
        let result = MCPToolCallResult {
            content: vec![MCPContentBlock::Text {
                text: "file content".into(),
            }],
            is_error: Some(false),
            meta: None,
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["content"][0]["text"], "file content");
        assert_eq!(json["is_error"], false);
    }

    #[test]
    fn test_content_to_text() {
        let blocks = vec![
            MCPContentBlock::Text { text: "Hello".into() },
            MCPContentBlock::Text { text: "World".into() },
        ];
        assert_eq!(mcp_content_to_text(&blocks), "Hello\nWorld");
    }

    #[test]
    fn test_tool_list_response() {
        let list = MCPToolsListResult {
            tools: vec![
                MCPTool {
                    name: "tool1".into(),
                    description: None,
                    input_schema: None,
                },
            ],
            next_cursor: None,
        };
        let json = serde_json::to_value(&list).unwrap();
        assert_eq!(json["tools"][0]["name"], "tool1");
    }

    #[test]
    fn test_json_rpc_roundtrip() {
        let req = MCPJsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: serde_json::json!(1),
            method: "tools/list".into(),
            params: None,
        };
        let json = serde_json::to_value(&req).unwrap();
        let deserialized: MCPJsonRpcRequest = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.method, "tools/list");
        assert_eq!(deserialized.id, serde_json::json!(1));
    }
}