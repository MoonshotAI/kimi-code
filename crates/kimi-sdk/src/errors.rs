//! Error protocol — the SDK's wire-facing counterpart of node-sdk's
//! `legacy/errors.ts`. `KimiError` carries the numeric JSON-RPC code the
//! engine emits in response `error` envelopes; `ErrorCodes` keeps the
//! agent-level string codes from the TS registry verbatim.

use std::fmt;

use serde_json::Value;

/// A JSON-RPC-shaped engine error: numeric transport `code`, human `message`,
/// and optional structured `data` (the JSON-RPC detail member). Mirrors the
/// response shape `{ error: { code, message, data? } }` the host protocol
/// uses. TS `KimiError` parity in spirit — its string `code` / `details`
/// live here as the [`ErrorCodes`] registry and `data`, respectively, while
/// the numeric code matches the wire.
#[derive(Debug, Clone, PartialEq)]
pub struct KimiError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl KimiError {
    /// Build an error without structured details.
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    /// Build an error carrying JSON-serializable structured details.
    pub fn with_data(code: i64, message: impl Into<String>, data: Value) -> Self {
        Self {
            code,
            message: message.into(),
            data: Some(data),
        }
    }
}

impl fmt::Display for KimiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "KimiError({}): {}", self.code, self.message)
    }
}

impl std::error::Error for KimiError {}

/// A catalog fetch failed with a non-2xx HTTP response. Carries the wire
/// `status` so callers can branch on it — TS `CatalogFetchError` parity
/// (node-sdk `catalog.ts` throws it with the same message shape).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogFetchError {
    pub status: u16,
}

impl fmt::Display for CatalogFetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Failed to fetch catalog (HTTP {}).", self.status)
    }
}

impl std::error::Error for CatalogFetchError {}

/// JSON-RPC error-shape discrimination over a wire value: accepts the
/// response envelope (`{ "error": { code, message } }`) or the flat JSON-RPC
/// error object (`{ code, message }`). `code` must be an integer and
/// `message` a string; `data` is optional and unconstrained. TS
/// `isKimiError` is an `instanceof` class check that cannot run on
/// serialized values — this is its value-level counterpart.
pub fn is_kimi_error(value: &Value) -> bool {
    let error = match value.get("error") {
        Some(inner) => inner,
        None => value,
    };
    error.get("code").and_then(Value::as_i64).is_some()
        && error.get("message").and_then(Value::as_str).is_some()
}

// TS `ErrorCodes` — the public agent-error code registry (`domain.reason`
// strings), copied verbatim from node-sdk's `legacy/errors.ts`. Downstream
// consumers branch on these rather than class identity; the numeric
// `KimiError.code` is the transport-level JSON-RPC code.

pub const CONFIG_INVALID: &str = "config.invalid";

pub const SESSION_NOT_FOUND: &str = "session.not_found";
pub const SESSION_ALREADY_EXISTS: &str = "session.already_exists";
pub const SESSION_ID_INVALID: &str = "session.id_invalid";
pub const SESSION_ID_REQUIRED: &str = "session.id_required";
pub const SESSION_ID_EMPTY: &str = "session.id_empty";
pub const SESSION_TITLE_EMPTY: &str = "session.title_empty";
pub const SESSION_STATE_NOT_FOUND: &str = "session.state_not_found";
pub const SESSION_STATE_INVALID: &str = "session.state_invalid";
pub const SESSION_FORK_ACTIVE_TURN: &str = "session.fork_active_turn";
pub const SESSION_EXPORT_NOT_FOUND: &str = "session.export_not_found";
pub const SESSION_EXPORT_MISSING_VERSION: &str = "session.export_missing_version";
pub const SESSION_CLOSED: &str = "session.closed";
pub const SESSION_PERMISSION_MODE_INVALID: &str = "session.permission_mode_invalid";
pub const SESSION_THINKING_EMPTY: &str = "session.thinking_empty";
pub const SESSION_MODEL_EMPTY: &str = "session.model_empty";
pub const SESSION_PLAN_MODE_INVALID: &str = "session.plan_mode_invalid";
pub const SESSION_APPROVAL_HANDLER_ERROR: &str = "session.approval_handler_error";
pub const SESSION_QUESTION_HANDLER_ERROR: &str = "session.question_handler_error";
pub const SESSION_INIT_FAILED: &str = "session.init_failed";

pub const AGENT_NOT_FOUND: &str = "agent.not_found";
pub const TURN_AGENT_BUSY: &str = "turn.agent_busy";

pub const GOAL_ALREADY_EXISTS: &str = "goal.already_exists";
pub const GOAL_NOT_FOUND: &str = "goal.not_found";
pub const GOAL_OBJECTIVE_EMPTY: &str = "goal.objective_empty";
pub const GOAL_OBJECTIVE_TOO_LONG: &str = "goal.objective_too_long";
pub const GOAL_STATUS_INVALID: &str = "goal.status_invalid";
pub const GOAL_METADATA_RESERVED: &str = "goal.metadata_reserved";
pub const GOAL_NOT_RESUMABLE: &str = "goal.not_resumable";

pub const MODEL_NOT_CONFIGURED: &str = "model.not_configured";
pub const MODEL_CONFIG_INVALID: &str = "model.config_invalid";
pub const AUTH_LOGIN_REQUIRED: &str = "auth.login_required";

pub const CONTEXT_OVERFLOW: &str = "context.overflow";
pub const LOOP_MAX_STEPS_EXCEEDED: &str = "loop.max_steps_exceeded";
pub const PROVIDER_API_ERROR: &str = "provider.api_error";
pub const PROVIDER_FILTERED: &str = "provider.filtered";
pub const PROVIDER_RATE_LIMIT: &str = "provider.rate_limit";
pub const PROVIDER_AUTH_ERROR: &str = "provider.auth_error";
pub const PROVIDER_CONNECTION_ERROR: &str = "provider.connection_error";

pub const SKILL_NOT_FOUND: &str = "skill.not_found";
pub const SKILL_TYPE_UNSUPPORTED: &str = "skill.type_unsupported";
pub const SKILL_NAME_EMPTY: &str = "skill.name_empty";

pub const RECORDS_WRITE_FAILED: &str = "records.write_failed";
pub const COMPACTION_FAILED: &str = "compaction.failed";
pub const COMPACTION_UNABLE: &str = "compaction.unable";

pub const BACKGROUND_TASK_ID_EMPTY: &str = "task.task_id_empty";
pub const MCP_SERVER_NOT_FOUND: &str = "mcp.server_not_found";
pub const MCP_SERVER_DISABLED: &str = "mcp.server_disabled";
pub const MCP_STARTUP_FAILED: &str = "mcp.startup_failed";
pub const MCP_TOOL_NAME_COLLISION: &str = "mcp.tool_name_collision";

pub const PLUGIN_NOT_FOUND: &str = "plugin.not_found";
pub const PLUGIN_LOAD_FAILED: &str = "plugin.load_failed";

pub const REQUEST_INVALID: &str = "request.invalid";
pub const REQUEST_WORK_DIR_REQUIRED: &str = "request.work_dir_required";
pub const REQUEST_PROMPT_INPUT_EMPTY: &str = "request.prompt_input_empty";

pub const SHELL_GIT_BASH_NOT_FOUND: &str = "shell.git_bash_not_found";

pub const NOT_IMPLEMENTED: &str = "not_implemented";
pub const INTERNAL: &str = "internal";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_constructs_and_formats() {
        let error = KimiError::new(-32601, "Method not found");
        assert_eq!(error.code, -32601);
        assert_eq!(error.message, "Method not found");
        assert_eq!(error.data, None);
        assert_eq!(error.to_string(), "KimiError(-32601): Method not found");

        let error = KimiError::with_data(-32000, "kaboom", serde_json::json!({ "x": 1 }));
        assert_eq!(error.data, Some(serde_json::json!({ "x": 1 })));

        // The `Error` trait is implemented: boxed errors downcast back.
        let boxed: Box<dyn std::error::Error> = Box::new(error);
        assert!(boxed.downcast_ref::<KimiError>().is_some());
    }

    #[test]
    fn catalog_fetch_error_carries_status() {
        let error = CatalogFetchError { status: 404 };
        assert_eq!(error.status, 404);
        assert_eq!(error.to_string(), "Failed to fetch catalog (HTTP 404).");
        // The `Error` trait is implemented: boxed errors downcast back.
        let boxed: Box<dyn std::error::Error> = Box::new(error);
        assert!(boxed.downcast_ref::<CatalogFetchError>().is_some());
    }

    #[test]
    fn discriminates_wire_error_shapes() {
        // Wrapped envelope — the shape `call` responses use.
        assert!(is_kimi_error(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "error": { "code": -32601, "message": "Method not found" }
        })));
        // Flat JSON-RPC error object.
        assert!(is_kimi_error(&serde_json::json!({ "code": -32601, "message": "x" })));
        // `data` is optional and unconstrained.
        assert!(is_kimi_error(&serde_json::json!({
            "code": 1,
            "message": "x",
            "data": [1, 2],
        })));

        // Non-errors are rejected.
        assert!(!is_kimi_error(&serde_json::json!({ "result": { "status": "ok" } })));
        assert!(!is_kimi_error(&serde_json::json!({ "error": { "message": "no code" } })));
        assert!(!is_kimi_error(&serde_json::json!({ "error": { "code": "not-a-number" } })));
        assert!(!is_kimi_error(&serde_json::json!({ "error": { "code": 1 } })));
        assert!(!is_kimi_error(&serde_json::json!({})));
        assert!(!is_kimi_error(&serde_json::Value::Null));
    }

    #[test]
    fn error_codes_match_ts_registry() {
        // Representative values across every code domain; the full set is
        // copied verbatim from node-sdk `legacy/errors.ts`.
        assert_eq!(CONFIG_INVALID, "config.invalid");
        assert_eq!(SESSION_ID_INVALID, "session.id_invalid");
        assert_eq!(TURN_AGENT_BUSY, "turn.agent_busy");
        assert_eq!(GOAL_NOT_RESUMABLE, "goal.not_resumable");
        assert_eq!(MODEL_NOT_CONFIGURED, "model.not_configured");
        assert_eq!(AUTH_LOGIN_REQUIRED, "auth.login_required");
        assert_eq!(CONTEXT_OVERFLOW, "context.overflow");
        assert_eq!(PROVIDER_RATE_LIMIT, "provider.rate_limit");
        assert_eq!(SKILL_NAME_EMPTY, "skill.name_empty");
        assert_eq!(COMPACTION_UNABLE, "compaction.unable");
        assert_eq!(BACKGROUND_TASK_ID_EMPTY, "task.task_id_empty");
        assert_eq!(MCP_SERVER_NOT_FOUND, "mcp.server_not_found");
        assert_eq!(PLUGIN_LOAD_FAILED, "plugin.load_failed");
        assert_eq!(REQUEST_PROMPT_INPUT_EMPTY, "request.prompt_input_empty");
        assert_eq!(SHELL_GIT_BASH_NOT_FOUND, "shell.git_bash_not_found");
        assert_eq!(NOT_IMPLEMENTED, "not_implemented");
        assert_eq!(INTERNAL, "internal");
    }
}
