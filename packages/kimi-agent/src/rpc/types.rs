/// JSON-RPC 2.0 protocol types for kimi-agent stdio communication.
///
/// The agent process speaks JSON-RPC 2.0 over stdio:
/// - Reads JSON-RPC requests from stdin
/// - Writes JSON-RPC responses (and notifications) to stdout
/// - Uses stderr for logging/diagnostics
///
/// The envelope types live in `kimi-protocol` (layer 1 of the Rust-first
/// migration); this module re-exports them and keeps the agent's params /
/// results wire types.

use serde::{Deserialize, Serialize};
// ── JSON-RPC 2.0 base types (from kimi-protocol) ──────────────────────────

pub use kimi_protocol::rpc::{
    JsonRpcError, JsonRpcErrorResponse, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse,
    RequestId,
};

/// Session RPC params/results wire types (from kimi-protocol).
pub use kimi_protocol::wire_types::*;


// ── Agent RPC method names (from kimi-protocol) ───────────────────────────

/// RPC method names for the kimi-agent protocol.
pub use kimi_protocol::methods;

// ── Message content blocks (multimodal) ─────────────────────────────────


// ── Native LLM configuration (Rust-side HTTP transport) ───────────────────


// ── RunTurn request/response types ─────────────────────────────────────────

/// Input for a run_turn RPC call.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct RunTurnParams {
    pub turn_id: String,
    pub system_prompt: String,
    pub model_name: String,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolDef>,
    pub max_steps: Option<u32>,
    /// Multiple LLM providers for concurrent execution (MultiLLM).
    /// When present, overrides `system_prompt` + `model_name`.
    #[serde(default)]
    pub providers: Vec<LlmProviderDef>,
    /// Optional goal context for budget-aware execution.
    /// When present, the loop checks budgets before each step and
    /// injects steering text into the system prompt.
    #[serde(default)]
    pub goal: Option<crate::turn_loop::types::GoalContext>,
    /// Native HTTP LLM transport. When present, the Rust engine calls the
    /// provider directly (streaming) instead of proxying through the host.
    #[serde(default)]
    pub native_llm: Option<NativeLlmConfig>,
    /// Workspace root used to sandbox native tool execution.
    #[serde(default)]
    pub workspace_root: Option<String>,
    /// When true (and `workspace_root` is set), read-only tools
    /// (Read/Grep/Glob/ListDirectory) execute inside the Rust process,
    /// bypassing the host round-trip.
    #[serde(default)]
    pub native_tools: bool,
}



// ── Session surface params ──

/// Input for session/create.
#[derive(Debug, Deserialize)]
pub struct SessionCreateParams {
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub homedir: Option<String>,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// Host-resolved max context tokens for the session's model (from the
    /// SDK config). Drives the engine's context-budget enforcement
    /// (import-overflow rejection, compaction window).
    #[serde(default)]
    pub max_context_size: Option<u64>,
    #[serde(default)]
    pub goal_enabled: Option<bool>,
    #[serde(default)]
    pub native_llm: Option<NativeLlmConfig>,
    /// Host tool definitions presented to the model; calls settle at the
    /// host via `host/execute_tool`.
    #[serde(default)]
    pub tools: Vec<ToolDef>,
    /// MCP servers to register into the session's runtime (host-resolved
    /// config + secrets). Each connects immediately unless disabled or from an
    /// untrusted project root. Empty on the RUN_TURN path (TS owns MCP there).
    #[serde(default)]
    pub mcp_servers: Vec<crate::mcp::runtime::McpServerSpecInput>,
    /// Workspace trust (C6, #2453): when `true`, stdio MCP servers from the
    /// repo's own `.mcp.json` connect immediately instead of being held in
    /// `pending-approval`. Defaults to `false` (untrusted).
    #[serde(default)]
    pub workspace_trusted: bool,
    /// Skills to register into the session's skill registry (host-discovered).
    /// Populates the model-facing `Skill` tool's native activation path.
    #[serde(default)]
    pub skills: Vec<crate::skill::SkillMetadataInput>,
    /// External lifecycle hooks (host-resolved from config.toml `[[hooks]]` +
    /// plugin contributions). Executed natively by the engine: PreToolUse /
    /// PostToolUse on the tool interceptor chain, UserPromptSubmit / Stop at
    /// the prompt boundary.
    #[serde(default)]
    pub hooks: Vec<crate::hooks::external::HookDef>,
    /// When true (default), write-class / bash / network tools execute in the
    /// engine (sandboxed to the session workspace) behind the permission gate
    /// and the pending-approval store. False keeps every tool at the host.
    #[serde(default = "default_true")]
    pub native_tools: bool,
}

fn default_true() -> bool {
    true
}






































// ── LLM proxy types (Rust → JS host) ───────────────────────────────────────





// ── Tool execution proxy types (Rust → JS host) ────────────────────────────




// ── Tool hook request/response types (tool_call.rs lifecycle) ─────────────









// ── Session RPC result aliases (wire.gen.ts consumers) ────────────────────
// These mirror existing crate result types so the generated wire contract
// covers every session-level RPC result. Field shapes must match what the
// handlers serialize today — do not rename or re-shape here.

/// Result of `session/get_usage` — engine cumulative usage.
pub type SessionUsageResult = crate::usage::UsageStatus;

/// Result of `session/get_plan` — active plan data, or null.
pub type SessionPlanResult = Option<crate::plan::PlanData>;

/// Result of `task/list` — flat array of task records (no `{tasks}` wrapper).
pub type TaskListResult = Vec<crate::task::types::TaskInfoBase>;

/// Result of `session/get_context` — engine context snapshot.
pub type SessionContextResult = crate::context::types::AgentContextData;















/// Result of `session/get_status` — live engine status snapshot. Wire shape
/// mirrors the previous `serde_json::json!` literal: `model` and `usage`
/// serialize as `null` when absent (no skip), `permission` is the stringified
/// permission mode.
#[derive(Debug, Serialize)]
pub struct SessionStatusResult {
    pub model: Option<String>,
    pub thinking_effort: String,
    pub permission: String,
    pub plan_mode: bool,
    pub swarm_mode: bool,
    pub goal_enabled: bool,
    pub context_tokens: u64,
    pub max_context_tokens: u64,
    pub context_usage: f64,
    pub usage: Option<crate::usage::UsageStatus>,
}

// ── Cron RPC types ────────────────────────────────────────────────────────────










// ── Background RPC types ───────────────────────────────────────────────────────










#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_run_turn_params_serialization() {
        let json = serde_json::json!({
            "turn_id": "turn-1",
            "system_prompt": "You are a helpful assistant.",
            "model_name": "gpt-4",
            "messages": [
                {"role": "user", "content": "Hello"}
            ],
            "tools": [
                {"name": "read", "description": "Read a file", "input_schema": {"type": "object"}}
            ],
            "max_steps": 10
        });
        let params: RunTurnParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.turn_id, "turn-1");
        assert_eq!(params.model_name, "gpt-4");
        assert_eq!(params.messages.len(), 1);
        assert_eq!(params.tools.len(), 1);
        assert_eq!(params.max_steps, Some(10));
        assert!(params.providers.is_empty());
    }

    #[test]
    fn test_run_turn_params_with_providers() {
        let json = serde_json::json!({
            "turn_id": "turn-1",
            "system_prompt": "",
            "model_name": "",
            "messages": [],
            "tools": [],
            "providers": [
                {"name": "fast", "model": "gpt-4o-mini", "system_prompt": "You are fast."},
                {"name": "smart", "model": "claude-opus-4", "system_prompt": "You are smart."}
            ]
        });
        let params: RunTurnParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.providers.len(), 2);
        assert_eq!(params.providers[0].name, "fast");
        assert_eq!(params.providers[0].model, "gpt-4o-mini");
        assert_eq!(params.providers[1].name, "smart");
    }

    #[test]
    fn test_run_turn_result_roundtrip() {
        let result = RunTurnResult {
            stop_reason: "EndTurn".to_string(),
            steps: 3,
            usage: TokenUsage { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["stop_reason"], "EndTurn");
        assert_eq!(json["steps"], 3);
        assert_eq!(json["usage"]["input_tokens"], 100);

        let deserialized: RunTurnResult = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.stop_reason, "EndTurn");
        assert_eq!(deserialized.steps, 3);
    }

    #[test]
    fn test_llm_chat_request_roundtrip() {
        let req = LlmChatRequest {
            session_id: None,
            system_prompt: "You are helpful.".to_string(),
            model_name: "gpt-4".to_string(),
            messages: vec![
                LlmChatMessage { role: "user".to_string(), content: "Hi".to_string(), blocks: Vec::new() },
            ],
            tools: vec![
                ToolDef {
                    name: "read".to_string(),
                    description: "Read file".to_string(),
                    input_schema: serde_json::json!({"type": "object"}),
                },
            ],
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["system_prompt"], "You are helpful.");
        assert_eq!(json["messages"][0]["role"], "user");

        let deserialized: LlmChatRequest = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.system_prompt, req.system_prompt);
        assert_eq!(deserialized.messages.len(), 1);
        assert_eq!(deserialized.tools.len(), 1);
    }

    #[test]
    fn test_llm_chat_response_roundtrip() {
        let resp = LlmChatResponse {
            content: String::new(),
            tool_calls: vec![
                LlmToolCall {
                    id: "call_1".to_string(),
                    name: "read".to_string(),
                    arguments: serde_json::json!({"path": "/tmp/test.txt"}),
                },
            ],
            finish_reason: Some("stop".to_string()),
            usage: TokenUsage { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["tool_calls"][0]["name"], "read");
        assert_eq!(json["finish_reason"], "stop");

        let deserialized: LlmChatResponse = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.tool_calls.len(), 1);
        assert_eq!(deserialized.tool_calls[0].id, "call_1");
        assert_eq!(deserialized.finish_reason, Some("stop".to_string()));
    }

    #[test]
    fn test_tool_execute_request_roundtrip() {
        let req = ToolExecuteRequest {
            session_id: None,
            turn_id: "turn-1".to_string(),
            tool_call_id: "call_1".to_string(),
            tool_name: "read".to_string(),
            arguments: serde_json::json!({"path": "/tmp/test.txt", "line_offset": 1}),
            force_precise: false,
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["tool_name"], "read");
        assert_eq!(json["arguments"]["path"], "/tmp/test.txt");

        let deserialized: ToolExecuteRequest = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.turn_id, "turn-1");
        assert_eq!(deserialized.tool_name, "read");
    }

    #[test]
    fn test_tool_execute_request_force_precise_default() {
        // Test that force_precise defaults to false when deserializing
        let json = serde_json::json!({
            "turn_id": "turn-1",
            "tool_call_id": "call_1",
            "tool_name": "read",
            "arguments": {"path": "/tmp/test.txt"}
        });
        let req: ToolExecuteRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.turn_id, "turn-1");
        assert!(!req.force_precise);
    }

    #[test]
    fn test_tool_execute_request_force_precise_true() {
        let req = ToolExecuteRequest {
            session_id: None,
            turn_id: "turn-1".to_string(),
            tool_call_id: "call_1".to_string(),
            tool_name: "read".to_string(),
            arguments: serde_json::json!({"path": "/tmp/test.txt"}),
            force_precise: true,
        };
        assert!(req.force_precise);
        let json = serde_json::to_value(&req).unwrap();
        assert!(json["force_precise"].as_bool().unwrap());
    }

    #[test]
    fn test_tool_execute_response_roundtrip() {
        let resp = ToolExecuteResponse {
            content: "file content here".to_string(),
            is_error: false,
            is_prediction: false,
            stop_turn: false,
            ..Default::default()
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["content"], "file content here");
        assert!(!json["is_error"].as_bool().unwrap());

        let deserialized: ToolExecuteResponse = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.content, "file content here");
        assert!(!deserialized.is_error);
    }

    #[test]
    fn test_tool_execute_response_error() {
        let resp = ToolExecuteResponse {
            content: "File not found".to_string(),
            is_error: true,
            is_prediction: false,
            stop_turn: false,
            ..Default::default()
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert!(json["is_error"].as_bool().unwrap());

        let deserialized: ToolExecuteResponse = serde_json::from_value(json).unwrap();
        assert!(deserialized.is_error);
    }

    #[test]
    fn test_health_status() {
        let status = HealthStatus {
            status: "ok".to_string(),
            version: "0.1.0".to_string(),
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["status"], "ok");
        assert_eq!(json["version"], "0.1.0");
    }

    #[test]
    fn test_message_roundtrip() {
        let msg = Message {
            role: "user".to_string(),
            content: "Hello world".to_string(),
            blocks: Vec::new(),
            tool_calls: Vec::new(),
            tool_call_id: None,
        };
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["role"], "user");

        let deserialized: Message = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.role, "user");
        assert_eq!(deserialized.content, "Hello world");
    }

    #[test]
    fn test_tool_def_roundtrip() {
        let def = ToolDef {
            name: "grep".to_string(),
            description: "Search text".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "pattern": {"type": "string"}
                }
            }),
        };
        let json = serde_json::to_value(&def).unwrap();
        let deserialized: ToolDef = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.name, "grep");
        assert!(deserialized.input_schema["properties"]["pattern"]["type"].as_str().is_some());
    }

    #[test]
    fn test_token_usage_default() {
        let usage = TokenUsage::default();
        assert_eq!(usage.input_tokens, 0);
        assert_eq!(usage.output_tokens, 0);
        assert_eq!(usage.total_tokens, 0);
    }

    #[test]
    fn test_token_usage_roundtrip() {
        let usage = TokenUsage { input_tokens: 100, output_tokens: 50, total_tokens: 150 };
        let json = serde_json::to_value(&usage).unwrap();
        assert_eq!(json["input_tokens"], 100);
        assert_eq!(json["output_tokens"], 50);
        assert_eq!(json["total_tokens"], 150);

        let deserialized: TokenUsage = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.input_tokens, 100);
        assert_eq!(deserialized.output_tokens, 50);
    }

    #[test]
    fn test_json_rpc_request_parse() {
        let json = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 42,
            "method": "agent/run_turn",
            "params": {"key": "value"}
        });
        let req: JsonRpcRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.jsonrpc, "2.0");
        assert_eq!(req.id, 42);
        assert_eq!(req.method, "agent/run_turn");
        assert_eq!(req.params["key"], "value");
    }

    #[test]
    fn test_json_rpc_request_notification() {
        // Notification has no id
        let json = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "agent/notify",
            "params": {}
        });
        let req: JsonRpcRequest = serde_json::from_value(json).unwrap();
        assert!(req.id.is_null());
    }

    #[test]
    fn test_json_rpc_response_ok() {
        let resp = JsonRpcResponse::ok(serde_json::json!(1), serde_json::json!({"result": "ok"}));
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["jsonrpc"], "2.0");
        assert_eq!(json["id"], 1);
        assert_eq!(json["result"]["result"], "ok");
    }

    #[test]
    fn test_json_rpc_error_response() {
        let err = JsonRpcErrorResponse::new(serde_json::json!(null), -32700, "Parse error".to_string());
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["error"]["code"], -32700);
        assert_eq!(json["error"]["message"], "Parse error");
        assert!(json["error"].get("data").is_none());
    }

    #[test]
    fn test_json_rpc_error_with_data() {
        let err = JsonRpcError {
            code: -32000,
            message: "Custom error".to_string(),
            data: Some(serde_json::json!({"detail": "something broke"})),
        };
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], -32000);
        assert_eq!(json["data"]["detail"], "something broke");
    }

    #[test]
    fn test_methods_constants() {
        assert_eq!(methods::RUN_TURN, "agent/run_turn");
        assert_eq!(methods::CANCEL_TURN, "agent/cancel_turn");
        assert_eq!(methods::HEALTH, "agent/health");
        assert_eq!(methods::SHUTDOWN, "agent/shutdown");
        assert_eq!(methods::HOST_LLM_CHAT, "host/llm_chat");
        assert_eq!(methods::HOST_EXECUTE_TOOL, "host/execute_tool");
    }

    #[test]
    fn test_llm_provider_def_deserialize() {
        let json = serde_json::json!({
            "name": "fast-llm",
            "model": "gpt-4o-mini",
            "system_prompt": "You are fast."
        });
        let def: LlmProviderDef = serde_json::from_value(json).unwrap();
        assert_eq!(def.name, "fast-llm");
        assert_eq!(def.model, "gpt-4o-mini");
        assert_eq!(def.system_prompt, "You are fast.");
    }

    #[test]
    fn test_notification_parse() {
        let json = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "host/event",
            "params": {"type": "progress"}
        });
        let notif: JsonRpcNotification = serde_json::from_value(json).unwrap();
        assert_eq!(notif.jsonrpc, "2.0");
        assert_eq!(notif.method, "host/event");
        assert_eq!(notif.params["type"], "progress");
    }

    #[test]
    fn test_llm_tool_call_roundtrip() {
        let tc = LlmToolCall {
            id: "call_abc".to_string(),
            name: "read_file".to_string(),
            arguments: serde_json::json!({"path": "/tmp/x.txt"}),
        };
        let json = serde_json::to_value(&tc).unwrap();
        let deserialized: LlmToolCall = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.id, "call_abc");
        assert_eq!(deserialized.name, "read_file");
    }

    #[test]
    fn test_empty_providers_default() {
        let json = serde_json::json!({
            "turn_id": "t1",
            "system_prompt": "hi",
            "model_name": "m",
            "messages": [],
            "tools": []
        });
        let params: RunTurnParams = serde_json::from_value(json).unwrap();
        assert!(params.providers.is_empty());
    }

    #[test]
    fn test_tool_def_empty_schema() {
        let def = ToolDef {
            name: "bash".to_string(),
            description: "Run shell".to_string(),
            input_schema: serde_json::Value::Object(Default::default()),
        };
        let json = serde_json::to_value(&def).unwrap();
        let deserialized: ToolDef = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.name, "bash");
        assert!(deserialized.input_schema.as_object().unwrap().is_empty());
    }

    // ── Cron RPC roundtrip tests ──────────────────────────────────────────────

    #[test]
    fn test_cron_create_params_roundtrip() {
        let json = serde_json::json!({
            "cron": "0 9 * * *",
            "prompt": "morning reminder",
            "recurring": true
        });
        let params: CronCreateParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.cron, "0 9 * * *");
        assert_eq!(params.prompt, "morning reminder");
        assert_eq!(params.recurring, Some(true));
    }

    #[test]
    fn test_cron_create_params_defaults() {
        let json = serde_json::json!({
            "cron": "*/5 * * * *",
            "prompt": "every 5"
        });
        let params: CronCreateParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.cron, "*/5 * * * *");
        assert_eq!(params.recurring, None); // default
    }

    #[test]
    fn test_cron_delete_params_roundtrip() {
        let json = serde_json::json!({
            "ids": ["abc12345", "def67890"]
        });
        let params: CronDeleteParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.ids.len(), 2);
        assert_eq!(params.ids[0], "abc12345");
    }

    #[test]
    fn test_cron_create_result_roundtrip() {
        let result = CronCreateResult {
            id: "abc12345".into(),
            cron: "0 9 * * *".into(),
            prompt: "test".into(),
            created_at: 1000,
            recurring: true,
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["id"], "abc12345");
        assert_eq!(json["recurring"], true);
        assert_eq!(json["created_at"], 1000);
    }

    // ── Background RPC roundtrip tests ─────────────────────────────────────────

    #[test]
    fn test_bg_register_params_roundtrip() {
        let json = serde_json::json!({
            "prefix": "bash",
            "kind": "process",
            "description": "echo hello",
            "detached": true,
            "timeout_ms": 30000
        });
        let params: BgRegisterParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.prefix, "bash");
        assert_eq!(params.kind, "process");
        assert_eq!(params.detached, Some(true));
        assert_eq!(params.timeout_ms, Some(30000));
    }

    #[test]
    fn test_bg_register_params_minimal() {
        let json = serde_json::json!({
            "prefix": "agent",
            "kind": "agent",
            "description": "subagent task"
        });
        let params: BgRegisterParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.prefix, "agent");
        assert!(params.detached.is_none());
        assert!(params.timeout_ms.is_none());
    }

    #[test]
    fn test_bg_settle_params_roundtrip() {
        let json = serde_json::json!({
            "task_id": "bash-abc123",
            "status": "completed",
            "stop_reason": "finished successfully"
        });
        let params: BgSettleParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.task_id, "bash-abc123");
        assert_eq!(params.status, "completed");
        assert_eq!(params.stop_reason.unwrap(), "finished successfully");
    }

    #[test]
    fn test_cron_fire_event_payload() {
        let payload = CronFireEventPayload {
            r#type: "cron.fired".into(),
            job_id: "abc12345".into(),
            cron: "0 9 * * *".into(),
            recurring: true,
            coalesced_count: 1,
            stale: false,
            prompt: "morning reminder".into(),
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["type"], "cron.fired");
        assert_eq!(json["job_id"], "abc12345");
        assert_eq!(json["coalesced_count"], 1);
    }
}
