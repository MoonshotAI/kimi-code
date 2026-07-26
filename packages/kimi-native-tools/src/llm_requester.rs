/// LLM Requester — pure helper functions for v2 migration.
///
/// Pure utility functions used by the LLM requester service.
/// The TS side retains service orchestration, DI, event bus, etc.
///
/// Corresponds to `packages/agent-core-v2/src/agent/llmRequester/llmRequesterService.ts`.
use napi_derive::napi;

/// Compute a SHA256 fingerprint of a string.
#[napi]
pub fn native_fingerprint(content: String) -> String {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(content.as_bytes());
    let hash = hasher.finalize();
    format!("{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        hash[0], hash[1], hash[2], hash[3],
        hash[4], hash[5], hash[6], hash[7])
}

/// Filter tools to show only provider-visible ones (non-deferred).
/// tools_json: JSON array of Tool objects
/// Returns JSON array of filtered Tool objects.
#[napi]
pub fn native_provider_visible_tools(tools_json: String) -> String {
    let tools: Vec<serde_json::Value> =
        serde_json::from_str(&tools_json).unwrap_or_default();

    let has_deferred = tools.iter().any(|t| {
        t.get("deferred").and_then(|d| d.as_bool()) == Some(true)
    });

    if !has_deferred {
        return tools_json;
    }

    let result: Vec<serde_json::Value> = tools
        .into_iter()
        .filter(|t| t.get("deferred").and_then(|d| d.as_bool()) != Some(true))
        .collect();

    serde_json::to_string(&result).unwrap_or(tools_json)
}

/// Extract tool signature (name, description, parameters) from tools.
/// tools_json: JSON array of Tool objects
/// Returns JSON array of { name, description, parameters } objects.
#[napi]
pub fn native_tool_signature(tools_json: String) -> String {
    let tools: Vec<serde_json::Value> =
        serde_json::from_str(&tools_json).unwrap_or_default();

    let result: Vec<serde_json::Value> = tools
        .into_iter()
        .map(|t| {
            serde_json::json!({
                "name": t["name"],
                "description": t["description"],
                "parameters": t["parameters"],
            })
        })
        .collect();

    serde_json::to_string(&result).unwrap_or_else(|_| "[]".to_string())
}

/// Determine request kind for record from log fields.
/// Returns "compaction" or "loop".
#[napi]
pub fn native_request_kind_for_record(fields_json: String) -> String {
    let fields: serde_json::Value =
        serde_json::from_str(&fields_json).unwrap_or(serde_json::Value::Null);

    let kind = fields.get("kind").and_then(|v| v.as_str());
    let request_kind = fields.get("requestKind").and_then(|v| v.as_str());

    if kind == Some("compaction") || request_kind == Some("full_compaction") {
        "compaction".to_string()
    } else {
        "loop".to_string()
    }
}

/// Determine projection field value from log fields.
/// Returns "strict", "media-degraded", "media-stripped", or empty string.
#[napi]
pub fn native_projection_field(fields_json: String) -> String {
    let fields: serde_json::Value =
        serde_json::from_str(&fields_json).unwrap_or(serde_json::Value::Null);

    let value = fields.get("projection").and_then(|v| v.as_str());
    match value {
        Some("strict") | Some("media-degraded") | Some("media-stripped") => {
            value.unwrap().to_string()
        }
        _ => String::new(),
    }
}

/// Extract a string field from a JSON object.
/// Returns the string value, or None (JSON null) if not found or not a string.
#[napi]
pub fn native_string_field(fields_json: String, key: String) -> Option<String> {
    let fields: serde_json::Value =
        serde_json::from_str(&fields_json).unwrap_or(serde_json::Value::Null);
    fields.get(&key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

/// Extract a number field from a JSON object.
/// Returns the number value, or None (JSON null) if not found or not a number.
#[napi]
pub fn native_number_field(fields_json: String, key: String) -> Option<f64> {
    let fields: serde_json::Value =
        serde_json::from_str(&fields_json).unwrap_or(serde_json::Value::Null);
    fields.get(&key).and_then(|v| v.as_f64())
}

/// Extract API status code from an error object.
/// error_json: JSON representation of an error
/// Returns the status code, or None.
#[napi]
pub fn native_api_status_code(error_json: String) -> Option<i32> {
    let err: serde_json::Value =
        serde_json::from_str(&error_json).unwrap_or(serde_json::Value::Null);

    // Check top-level statusCode
    if let Some(code) = err.get("statusCode").and_then(|v| v.as_i64()) {
        return Some(code as i32);
    }
    // Check top-level status
    if let Some(code) = err.get("status").and_then(|v| v.as_i64()) {
        return Some(code as i32);
    }
    // Check details.statusCode
    if let Some(details) = err.get("details") {
        if let Some(code) = details.get("statusCode").and_then(|v| v.as_i64()) {
            return Some(code as i32);
        }
    }
    None
}

/// Extract API trace ID from an error object.
/// error_json: JSON representation of an error
/// Returns the trace ID, or None.
#[napi]
pub fn native_api_trace_id(error_json: String) -> Option<String> {
    let err: serde_json::Value =
        serde_json::from_str(&error_json).unwrap_or(serde_json::Value::Null);

    // Check top-level traceId
    if let Some(id) = err.get("traceId").and_then(|v| v.as_str()) {
        return Some(id.to_string());
    }
    // Check details.traceId
    if let Some(details) = err.get("details") {
        if let Some(id) = details.get("traceId").and_then(|v| v.as_str()) {
            return Some(id.to_string());
        }
    }
    None
}

/// Extract log fields for a request source.
/// source_json: JSON of AgentLLMRequestSource or undefined (null)
/// Returns JSON log fields object.
#[napi]
pub fn native_log_fields_for_source(source_json: String) -> String {
    let source: serde_json::Value =
        serde_json::from_str(&source_json).unwrap_or(serde_json::Value::Null);

    let source_type = source.get("type").and_then(|t| t.as_str());
    let log_fields = source.get("logFields");

    let result = match source_type {
        Some("turn") => {
            let mut fields = log_fields
                .and_then(|f| f.as_object())
                .map(|o| serde_json::Value::Object(o.clone()))
                .unwrap_or(serde_json::json!({}));

            let turn_id = source.get("turnId").and_then(|t| t.as_i64());
            let step = source.get("step").and_then(|s| s.as_i64());
            if let (Some(tid), Some(st)) = (turn_id, step) {
                if let Some(obj) = fields.as_object_mut() {
                    obj.insert(
                        "turnStep".to_string(),
                        serde_json::Value::String(format!("{}.{}", tid, st)),
                    );
                }
            }

            fields
        }
        Some("operation") => {
            let mut fields = log_fields
                .and_then(|f| f.as_object())
                .map(|o| serde_json::Value::Object(o.clone()))
                .unwrap_or(serde_json::json!({}));

            if let Some(rk) = source.get("requestKind").and_then(|v| v.as_str()) {
                if let Some(obj) = fields.as_object_mut() {
                    obj.insert("requestKind".to_string(), serde_json::json!(rk));
                }
            }

            fields
        }
        _ => serde_json::json!({}),
    };

    serde_json::to_string(&result).unwrap_or_else(|_| "{}".to_string())
}

/// Convert a fault injection kind to an error.
/// Returns JSON: { statusCode: number, message: string }
#[napi]
pub fn native_fault_to_error(kind_json: String) -> String {
    let kind = kind_json.trim_matches('"');
    let result = match kind {
        "request-too-large" => serde_json::json!({
            "statusCode": 413,
            "message": "Request Entity Too Large (fault injection)",
        }),
        _ => serde_json::json!({
            "statusCode": 400,
            "message": "unsupported image format: image/avif (fault injection)",
        }),
    };
    serde_json::to_string(&result).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fingerprint() {
        let result = native_fingerprint("hello".to_string());
        assert_eq!(result.len(), 16); // 8 bytes = 16 hex chars
        // SHA256 of "hello" starts with:
        // 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
        assert_eq!(&result, "2cf24dba5fb0a30e");
    }

    #[test]
    fn test_provider_visible_tools() {
        let tools = serde_json::json!([
            {"name": "read", "description": "read file", "parameters": {}, "deferred": true},
            {"name": "write", "description": "write file", "parameters": {}},
        ]);
        let result = native_provider_visible_tools(tools.to_string());
        let parsed: Vec<serde_json::Value> = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0]["name"], "write");
    }

    #[test]
    fn test_tool_signature() {
        let tools = serde_json::json!([
            {"name": "read", "description": "read file", "parameters": {"type": "object"}, "extra": 1},
        ]);
        let result = native_tool_signature(tools.to_string());
        let parsed: Vec<serde_json::Value> = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed[0]["name"], "read");
        assert_eq!(parsed[0]["extra"], serde_json::Value::Null); // not in signature
    }

    #[test]
    fn test_request_kind_for_record() {
        let fields = serde_json::json!({"kind": "compaction"});
        assert_eq!(native_request_kind_for_record(fields.to_string()), "compaction");

        let fields = serde_json::json!({"requestKind": "full_compaction"});
        assert_eq!(native_request_kind_for_record(fields.to_string()), "compaction");

        let fields = serde_json::json!({});
        assert_eq!(native_request_kind_for_record(fields.to_string()), "loop");
    }

    #[test]
    fn test_projection_field() {
        let fields = serde_json::json!({"projection": "media-degraded"});
        assert_eq!(native_projection_field(fields.to_string()), "media-degraded");

        let fields = serde_json::json!({"projection": "invalid"});
        assert!(native_projection_field(fields.to_string()).is_empty());
    }

    #[test]
    fn test_string_field() {
        let fields = serde_json::json!({"name": "test", "count": 42});
        assert_eq!(
            native_string_field(fields.to_string(), "name".to_string()),
            Some("test".to_string())
        );
        assert_eq!(native_string_field(fields.to_string(), "count".to_string()), None);
        assert_eq!(native_string_field(fields.to_string(), "missing".to_string()), None);
    }

    #[test]
    fn test_number_field() {
        let fields = serde_json::json!({"count": 42});
        assert_eq!(native_number_field(fields.to_string(), "count".to_string()), Some(42.0));
    }

    #[test]
    fn test_api_status_code() {
        let err = serde_json::json!({"statusCode": 413});
        assert_eq!(native_api_status_code(err.to_string()), Some(413));
    }

    #[test]
    fn test_api_trace_id() {
        let err = serde_json::json!({"traceId": "abc123"});
        assert_eq!(
            native_api_trace_id(err.to_string()),
            Some("abc123".to_string())
        );
    }

    #[test]
    fn test_log_fields_for_source_turn() {
        let source = serde_json::json!({
            "type": "turn",
            "turnId": 1,
            "step": 3,
            "logFields": {"attempt": "1"},
        });
        let result = native_log_fields_for_source(source.to_string());
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["turnStep"], "1.3");
        assert_eq!(parsed["attempt"], "1");
    }

    #[test]
    fn test_fault_to_error() {
        let result = native_fault_to_error(r#""request-too-large""#.to_string());
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["statusCode"], 413);
    }
}