/// MCP protocol types.
///
/// Mirrors the TS `packages/agent-core/src/mcp/types.ts`.
/// Covers the wire-level surface: tool definitions, tool call results.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Protocol revision this client prefers (2026-07-28: stateless — no
/// `initialize` handshake, every request carries protocol metadata in
/// `_meta`).
pub const MCP_PROTOCOL_VERSION: &str = "2026-07-28";

/// Highest legacy revision (initialize-handshake era) the client offers when
/// falling back to a pre-2026-07-28 server. Servers negotiate down to their
/// own revision; the client accepts whatever they answer with.
pub const MCP_LEGACY_PROTOCOL_VERSION: &str = "2025-11-25";

/// Client identity sent in `initialize` and `_meta` (TS:
/// `KIMI_MCP_CLIENT_NAME`).
pub const MCP_CLIENT_NAME: &str = "kimi-code";

/// `_meta` keys defined by the 2026-07-28 revision.
pub const META_PROTOCOL_VERSION: &str = "io.modelcontextprotocol/protocolVersion";
pub const META_CLIENT_CAPABILITIES: &str = "io.modelcontextprotocol/clientCapabilities";
pub const META_CLIENT_INFO: &str = "io.modelcontextprotocol/clientInfo";
pub const META_SERVER_INFO: &str = "io.modelcontextprotocol/serverInfo";
pub const META_SUBSCRIPTION_ID: &str = "io.modelcontextprotocol/subscriptionId";

/// `subscriptions/listen` notification types.
pub const LISTEN_TOOLS_LIST_CHANGED: &str = "toolsListChanged";
pub const LISTEN_PROMPTS_LIST_CHANGED: &str = "promptsListChanged";
pub const LISTEN_RESOURCES_LIST_CHANGED: &str = "resourcesListChanged";
pub const LISTEN_RESOURCE_SUBSCRIPTIONS: &str = "resourceSubscriptions";

/// Notification methods delivered on a `subscriptions/listen` stream.
pub const NOTIFICATION_TOOLS_LIST_CHANGED: &str = "notifications/tools/list_changed";
pub const NOTIFICATION_PROMPTS_LIST_CHANGED: &str = "notifications/prompts/list_changed";
pub const NOTIFICATION_RESOURCES_LIST_CHANGED: &str = "notifications/resources/list_changed";
pub const NOTIFICATION_RESOURCES_UPDATED: &str = "notifications/resources/updated";
pub const NOTIFICATION_SUBSCRIPTIONS_ACKNOWLEDGED: &str =
    "notifications/subscriptions/acknowledged";

/// MCP-reserved JSON-RPC error codes (2026-07-28 revision allocates the
/// `-32020`..`-32099` range to the specification).
pub const ERROR_HEADER_MISMATCH: i32 = -32020;
pub const ERROR_MISSING_REQUIRED_CLIENT_CAPABILITY: i32 = -32021;
pub const ERROR_UNSUPPORTED_PROTOCOL_VERSION: i32 = -32022;

/// `resultType` values (2026-07-28 revision).
pub const RESULT_TYPE_COMPLETE: &str = "complete";
pub const RESULT_TYPE_INPUT_REQUIRED: &str = "input_required";

/// Negotiated protocol era. `Stateless2026` is the 2026-07-28 revision:
/// no handshake, each request carries `_meta` protocol metadata (and, on
/// streamable HTTP, the `MCP-Protocol-Version`/`Mcp-Method`/`Mcp-Name`
/// headers). `Legacy` is any initialize-handshake revision up to
/// `2025-11-25`, negotiated via `server/discover` fallback.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpProtocolMode {
    Stateless2026,
    Legacy,
}

/// The `resultType: "input_required"` interim result (MRTR, 2026-07-28).
///
/// `inputRequests` is a **map** of server-assigned ids to request objects
/// (`ListRootsRequest` / `CreateMessageRequest` / `ElicitRequest`), matching
/// the 2026-07-28 schema; `requestState` is an opaque string the client must
/// pass back verbatim on the retry. An `input_required` result with an empty
/// (or absent) `inputRequests` map is a pure retry signal (e.g. load
/// shedding).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MCPInputRequiredResult {
    /// Server-assigned request id → request object.
    #[serde(default)]
    pub input_requests: HashMap<String, serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_state: Option<String>,
}

/// `resultType` of a result payload; missing means `"complete"` — clients
/// MUST treat results from earlier-protocol servers that omit the field as
/// `"complete"` (2026-07-28 changelog, item 8).
pub fn result_type_of(result: &serde_json::Value) -> &str {
    result
        .get("resultType")
        .and_then(|v| v.as_str())
        .unwrap_or(RESULT_TYPE_COMPLETE)
}

/// Inject `_meta` protocol metadata into request params (2026-07-28
/// stateless mode): protocol version, client identity, and (empty) client
/// capabilities.
pub fn inject_protocol_meta(params: &mut serde_json::Value, client_version: &str) {
    let Some(obj) = params.as_object_mut() else {
        return;
    };
    let meta = obj.entry("_meta").or_insert_with(|| serde_json::json!({}));
    if let Some(meta_obj) = meta.as_object_mut() {
        meta_obj.insert(
            META_PROTOCOL_VERSION.to_string(),
            serde_json::json!(MCP_PROTOCOL_VERSION),
        );
        meta_obj.insert(META_CLIENT_CAPABILITIES.to_string(), serde_json::json!({}));
        meta_obj.insert(
            META_CLIENT_INFO.to_string(),
            serde_json::json!({
                "name": MCP_CLIENT_NAME,
                "version": client_version,
            }),
        );
    }
}

/// Extract the JSON-RPC error code from a transport error string formatted
/// as `MCP error [-32601]: Method not found`; `None` when the error carries
/// no parseable code (timeouts, HTTP status failures, closed streams).
pub fn error_code_of(message: &str) -> Option<i32> {
    let start = message.find('[')?;
    let end = message[start..].find(']')? + start;
    message[start + 1..end].parse().ok()
}

/// Whether a `server/discover` probe failure means "older server, fall back
/// to the initialize handshake" rather than a real error: the method is
/// unknown (`-32601`, pre-2026-07-28 servers) or the version is unsupported
/// (`-32022`).
pub fn is_discover_fallback(error: &str) -> bool {
    matches!(
        error_code_of(error),
        Some(-32601 | ERROR_UNSUPPORTED_PROTOCOL_VERSION)
    )
}

/// Encode a header value per the 2026-07-28 value-encoding rules: plain
/// visible-ASCII (no leading/trailing whitespace) passes through unless it
/// matches the Base64 sentinel pattern; anything else is carried as
/// `=?base64?{utf8-base64}?=`.
pub fn encode_header_value(value: &str) -> String {
    let is_plain = value.chars().all(|c| matches!(c, '\x20'..='\x7e' | '\t'))
        && value == value.trim()
        && !(value.starts_with("=?base64?") && value.ends_with("?="));
    if is_plain {
        value.to_string()
    } else {
        let encoded = base64::engine::general_purpose::STANDARD.encode(value.as_bytes());
        format!("=?base64?{encoded}?=")
    }
}

/// Format a descriptive error for an `input_required` result the engine
/// cannot satisfy (it has no mid-call input-gathering path).
pub fn input_required_error(required: &MCPInputRequiredResult, after_retry: bool) -> String {
    let asks: Vec<String> = required
        .input_requests
        .values()
        .filter_map(|request| {
            request
                .get("description")
                .and_then(|d| d.as_str())
                .map(str::to_string)
        })
        .collect();
    let detail = if asks.is_empty() {
        format!("{} input request(s)", required.input_requests.len())
    } else {
        asks.join("; ")
    };
    if after_retry {
        format!("MCP server still requires input after retry: {detail}")
    } else {
        format!("MCP server requires input: {detail}")
    }
}

/// Build the `inputResponses` map for an `InputRequiredResult`'s requests
/// that the engine can answer automatically (MRTR, 2026-07-28). Currently
/// only `ListRootsRequest` (`roots/list`) is answered — with an empty roots
/// list, which the Roots feature permits. Any other request type (sampling,
/// elicitation) needs a data source the engine does not have mid-call, so
/// the whole exchange errors out rather than partially answering.
pub fn build_auto_input_responses(
    requests: &HashMap<String, serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let mut responses = serde_json::Map::new();
    for (id, request) in requests {
        let method = request.get("method").and_then(|m| m.as_str()).unwrap_or("");
        match method {
            "roots/list" => {
                responses.insert(id.clone(), serde_json::json!({ "roots": [] }));
            }
            other => {
                return Err(format!(
                    "MCP server requested unsupported input {:?} ({}); cannot answer automatically",
                    other,
                    id
                ));
            }
        }
    }
    Ok(serde_json::Value::Object(responses))
}

/// RFC 9110 `tchar` — valid characters in an HTTP header field name.
fn is_tchar(c: char) -> bool {
    matches!(c, 'a'..='z' | 'A'..='Z' | '0'..='9' | '!' | '#' | '$' | '%' | '&' | '\'' | '*'
        | '+' | '-' | '.' | '^' | '_' | '`' | '|' | '~')
}

/// Validate the `x-mcp-header` annotations of one tool's `inputSchema` per
/// the 2026-07-28 constraints: header names must be non-empty token syntax
/// without control characters and case-insensitively unique; only primitive
/// `string`/`integer`/`boolean` properties (never `number`) that are
/// statically reachable through `properties` alone (no `items`, composition,
/// conditionals, or `$ref` in the chain) may carry the annotation. An
/// annotation anywhere else makes the tool definition invalid — clients MUST
/// exclude such tools from `tools/list`.
pub fn validate_x_mcp_headers(schema: &serde_json::Value) -> Result<(), String> {
    let mut seen: Vec<String> = Vec::new();
    fn walk(
        schema: &serde_json::Value,
        path: &str,
        seen: &mut Vec<String>,
    ) -> Result<(), String> {
        let Some(props) = schema.get("properties").and_then(|p| p.as_object()) else {
            return Ok(());
        };
        for (name, prop) in props {
            let path = if path.is_empty() {
                name.clone()
            } else {
                format!("{path}.{name}")
            };
            if let Some(header) = prop.get("x-mcp-header").and_then(|v| v.as_str()) {
                if header.is_empty() {
                    return Err(format!("{path}: x-mcp-header must not be empty"));
                }
                if !header.chars().all(is_tchar) {
                    return Err(format!(
                        "{path}: x-mcp-header {header:?} is not valid HTTP token syntax"
                    ));
                }
                let lower = header.to_ascii_lowercase();
                if seen.contains(&lower) {
                    return Err(format!(
                        "{path}: duplicate x-mcp-header {header:?} (case-insensitive)"
                    ));
                }
                seen.push(lower);
                match prop.get("type").and_then(|t| t.as_str()) {
                    Some("string" | "integer" | "boolean") => {}
                    Some("number") => {
                        return Err(format!(
                            "{path}: x-mcp-header on type \"number\" is not permitted"
                        ));
                    }
                    Some(other) => {
                        return Err(format!(
                            "{path}: x-mcp-header requires a primitive type, got {other:?}"
                        ));
                    }
                    None => {
                        return Err(format!(
                            "{path}: x-mcp-header property must declare an explicit primitive type"
                        ));
                    }
                }
            }
            // Statically reachable means the chain passes through `properties`
            // only. `items`, composition, conditionals, and `$ref` break the
            // chain: an annotation anywhere in such a subtree makes the tool
            // definition invalid.
            let blocked = ["items", "oneOf", "anyOf", "allOf", "not", "if", "then", "else", "$ref"]
                .iter()
                .any(|key| prop.get(*key).is_some());
            if blocked {
                if contains_annotation(prop) {
                    return Err(format!(
                        "{path}: x-mcp-header not statically reachable (chain passes through a non-properties keyword)"
                    ));
                }
            } else {
                walk(prop, &path, seen)?;
            }
        }
        Ok(())
    }
    walk(schema, "", &mut seen)
}

/// Whether any `x-mcp-header` annotation exists anywhere in a (sub)schema.
fn contains_annotation(schema: &serde_json::Value) -> bool {
    if schema.get("x-mcp-header").is_some() {
        return true;
    }
    schema
        .as_object()
        .is_some_and(|object| object.values().any(contains_annotation))
}

/// Extract `Mcp-Param-{Name}` header values for a `tools/call` from the
/// tool's validated `inputSchema` annotations and the call arguments. The
/// value is taken at the exact `properties` path of the annotated property;
/// absent or `null` values omit the header.
pub fn x_mcp_header_args(
    schema: &serde_json::Value,
    arguments: &serde_json::Value,
) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    fn walk(
        schema: &serde_json::Value,
        args: &serde_json::Value,
        prefix: &str,
        out: &mut Vec<(String, String)>,
    ) {
        let Some(props) = schema.get("properties").and_then(|p| p.as_object()) else {
            return;
        };
        for (name, prop) in props {
            let Some(header) = prop.get("x-mcp-header").and_then(|v| v.as_str()) else {
                if let Some(sub) = args.get(name)
                    && prop.get("properties").is_some()
                    && !["items", "oneOf", "anyOf", "allOf", "not", "if", "then", "else", "$ref"]
                        .iter()
                        .any(|key| prop.get(*key).is_some())
                {
                    let path = if prefix.is_empty() {
                        name.clone()
                    } else {
                        format!("{prefix}.{name}")
                    };
                    walk(prop, sub, &path, out);
                }
                continue;
            };
            match args.get(name) {
                Some(value) if !value.is_null() => {
                    let value = match value {
                        serde_json::Value::String(s) => s.clone(),
                        serde_json::Value::Bool(b) => b.to_string(),
                        serde_json::Value::Number(n) => n.to_string(),
                        _ => continue,
                    };
                    out.push((format!("Mcp-Param-{header}"), encode_header_value(&value)));
                }
                _ => {}
            }
        }
    }
    walk(schema, arguments, "", &mut out);
    out
}

/// A tool definition returned by `tools/list`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MCPTool {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "inputSchema"
    )]
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
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "mimeType")]
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
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "isError")]
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
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "nextCursor")]
    pub next_cursor: Option<String>,
    /// CacheableResult (2026-07-28): freshness hint in milliseconds,
    /// allowing clients to cache the listing and reduce polling.
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "ttlMs")]
    pub ttl_ms: Option<u64>,
    /// CacheableResult scope: `"public"` (shared intermediaries may cache) or
    /// `"private"`. Parsed and surfaced for hosts; the engine does not cache.
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "cacheScope")]
    pub cache_scope: Option<String>,
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
        assert!(json["inputSchema"].is_object());
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
        assert_eq!(json["isError"], false);
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
            ttl_ms: None,
            cache_scope: None,
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

    #[test]
    fn result_type_defaults_to_complete() {
        assert_eq!(result_type_of(&serde_json::json!({})), "complete");
        assert_eq!(result_type_of(&serde_json::json!({ "resultType": "complete" })), "complete");
        assert_eq!(
            result_type_of(&serde_json::json!({ "resultType": "input_required" })),
            "input_required"
        );
    }

    #[test]
    fn protocol_meta_injection_carries_version_and_identity() {
        let mut params = serde_json::json!({ "name": "echo" });
        inject_protocol_meta(&mut params, "1.2.3");
        let meta = &params["_meta"];
        assert_eq!(
            meta[META_PROTOCOL_VERSION],
            serde_json::json!(MCP_PROTOCOL_VERSION)
        );
        assert_eq!(meta[META_CLIENT_INFO]["name"], serde_json::json!("kimi-code"));
        assert_eq!(meta[META_CLIENT_INFO]["version"], serde_json::json!("1.2.3"));
        assert!(meta[META_CLIENT_CAPABILITIES].is_object());
        // Existing request fields survive.
        assert_eq!(params["name"], "echo");
    }

    #[test]
    fn input_required_result_parses_map_shape() {
        // The 2026-07-28 schema carries inputRequests as an id → request
        // map; the engine must accept that shape (not the array draft shape).
        let json = serde_json::json!({
            "resultType": "input_required",
            "inputRequests": {
                "req-1": { "method": "roots/list", "description": "workspace roots" },
                "req-2": { "method": "elicitation/create", "description": "pick a number" }
            },
            "requestState": "opaque-blob"
        });
        let required: MCPInputRequiredResult = serde_json::from_value(json).unwrap();
        assert_eq!(required.input_requests.len(), 2);
        assert_eq!(
            required.input_requests["req-1"]["method"],
            "roots/list"
        );
        assert_eq!(required.request_state.as_deref(), Some("opaque-blob"));
        let err = input_required_error(&required, false);
        assert!(err.contains("workspace roots"), "error: {err}");
        assert!(err.contains("pick a number"), "error: {err}");
    }

    #[test]
    fn auto_responses_answer_roots_list_only() {
        let requests = serde_json::json!({
            "req-1": { "method": "roots/list" }
        });
        let requests: HashMap<String, serde_json::Value> =
            serde_json::from_value(requests).unwrap();
        let responses = build_auto_input_responses(&requests).expect("roots answered");
        assert_eq!(responses["req-1"]["roots"], serde_json::json!([]));

        let mixed = serde_json::json!({
            "req-1": { "method": "roots/list" },
            "req-2": { "method": "sampling/createMessage" }
        });
        let mixed: HashMap<String, serde_json::Value> =
            serde_json::from_value(mixed).unwrap();
        let err = build_auto_input_responses(&mixed).expect_err("sampling cannot be answered");
        assert!(err.contains("sampling/createMessage"), "error: {err}");
    }

    #[test]
    fn tools_list_result_parses_cacheable_result() {
        let json = serde_json::json!({
            "tools": [],
            "ttlMs": 60000,
            "cacheScope": "private"
        });
        let result: MCPToolsListResult = serde_json::from_value(json).unwrap();
        assert_eq!(result.ttl_ms, Some(60_000));
        assert_eq!(result.cache_scope.as_deref(), Some("private"));
        // Absent fields stay absent (no cache hints on legacy servers).
        let plain: MCPToolsListResult =
            serde_json::from_value(serde_json::json!({ "tools": [] })).unwrap();
        assert_eq!(plain.ttl_ms, None);
        assert_eq!(plain.cache_scope, None);
    }

    #[test]
    fn error_code_extraction_and_fallback_detection() {
        assert_eq!(
            error_code_of("MCP error [-32601]: Method not found"),
            Some(-32601)
        );
        assert_eq!(
            error_code_of("MCP error [-32022]: Unsupported protocol version"),
            Some(-32022)
        );
        assert_eq!(error_code_of("HTTP 400: boom"), None);
        assert!(is_discover_fallback("MCP error [-32601]: Method not found"));
        assert!(is_discover_fallback("MCP error [-32022]: Unsupported protocol version"));
        assert!(!is_discover_fallback("HTTP 400: boom"));
        assert!(!is_discover_fallback("MCP error [-32600]: Invalid Request"));
    }

    #[test]
    fn header_value_encoding_plain_and_base64() {
        assert_eq!(encode_header_value("us-west1"), "us-west1");
        assert_eq!(encode_header_value("Hello, 世界"), "=?base64?SGVsbG8sIOS4lueVjA==?=");
        assert_eq!(encode_header_value(" line1\nline2 "), "=?base64?IGxpbmUxCmxpbmUyIA==?=");
        // Sentinel lookalikes are double-encoded to avoid ambiguity.
        let sentinel = encode_header_value("=?base64?literal?=");
        assert!(sentinel.starts_with("=?base64?"), "got: {sentinel}");
        assert_ne!(sentinel, "=?base64?literal?=");
    }

    #[test]
    fn x_mcp_header_validation_accepts_static_primitive_annotations() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "region": { "type": "string", "x-mcp-header": "Region" },
                "retries": { "type": "integer", "x-mcp-header": "Retries" },
                "dry_run": { "type": "boolean", "x-mcp-header": "Dry-Run" },
                "nested": { "type": "object", "properties": {
                    "tenant": { "type": "string", "x-mcp-header": "Tenant" },
                } },
            },
        });
        assert!(validate_x_mcp_headers(&schema).is_ok());
    }

    #[test]
    fn x_mcp_header_validation_rejects_invalid_annotations() {
        // Empty header name.
        let empty = serde_json::json!({ "properties": {
            "a": { "type": "string", "x-mcp-header": "" },
        } });
        assert!(validate_x_mcp_headers(&empty).unwrap_err().contains("empty"));
        // Non-token characters.
        let bad_token = serde_json::json!({ "properties": {
            "a": { "type": "string", "x-mcp-header": "Region Header" },
        } });
        assert!(validate_x_mcp_headers(&bad_token).unwrap_err().contains("token"));
        // number is not permitted.
        let number = serde_json::json!({ "properties": {
            "a": { "type": "number", "x-mcp-header": "A" },
        } });
        assert!(validate_x_mcp_headers(&number).unwrap_err().contains("number"));
        // Case-insensitive duplicates.
        let dup = serde_json::json!({ "properties": {
            "a": { "type": "string", "x-mcp-header": "Region" },
            "b": { "type": "string", "x-mcp-header": "region" },
        } });
        assert!(validate_x_mcp_headers(&dup).unwrap_err().contains("duplicate"));
        // Annotation below a $ref / items / composition is unreachable.
        let refd = serde_json::json!({ "properties": {
            "a": { "$ref": "#/defs/x", "properties": {
                "b": { "type": "string", "x-mcp-header": "B" },
            } },
        } });
        assert!(validate_x_mcp_headers(&refd).is_err());
        let items = serde_json::json!({ "properties": {
            "a": { "type": "array", "items": { "x-mcp-header": "A" } },
        } });
        assert!(validate_x_mcp_headers(&items).is_err());
    }

    #[test]
    fn x_mcp_header_args_extract_values_at_static_paths() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "region": { "type": "string", "x-mcp-header": "Region" },
                "nested": { "type": "object", "properties": {
                    "tenant": { "type": "string", "x-mcp-header": "Tenant" },
                } },
            },
        });
        let args = serde_json::json!({
            "region": "us-west1",
            "nested": { "tenant": "acme 世界" },
        });
        let headers = x_mcp_header_args(&schema, &args);
        assert!(headers.contains(&("Mcp-Param-Region".to_string(), "us-west1".to_string())));
        assert!(headers.contains(&(
            "Mcp-Param-Tenant".to_string(),
            "=?base64?YWNtZSDkuJbnlYw=?=".to_string()
        )));
        // Absent and null values omit the header.
        let sparse = serde_json::json!({ "region": null });
        let headers = x_mcp_header_args(&schema, &sparse);
        assert!(headers.is_empty());
        // Nested values only extracted when present.
        let shallow = serde_json::json!({ "region": "east" });
        let headers = x_mcp_header_args(&schema, &shallow);
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0], ("Mcp-Param-Region".to_string(), "east".to_string()));
    }
}