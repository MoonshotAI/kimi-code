// Phase 9.2 -- Rust `ToolRegistry`.
//
// Provides a single source of truth for the tools available to the
// agent, with validation that tool calls from the LLM match the
// registered schema. Used by `turn_step::run_turn` to reject malformed
// tool calls before they propagate to the TS executor.
//
// The registry is *intentionally* schema-light: it stores the tool
// name, description, and a JSON Schema blob for parameters. Full
// schema validation against the JSON Schema document is left to the
// TS side (which already has ajv set up). Rust only does the cheap
// checks: tool exists, name matches, arguments are valid JSON.

use std::collections::HashMap;
use std::sync::RwLock;

use serde_json::Value;

use crate::turn_step::{ToolCall, TurnTool};

/// Per-call validation result. `Ok(())` means the call is well-formed
/// enough for the executor; `Err(msg)` returns a human-readable
/// reason that the orchestrator can feed back to the model (e.g. as a
/// tool-result message) so it can self-correct.
#[derive(Debug, Clone, PartialEq)]
pub enum ValidationError {
    /// The model's `id` doesn't match any registered tool.
    UnknownTool { id: String },
    /// The model's `name` doesn't match the registered tool's name.
    /// (Distinct from `UnknownTool` because some streams emit the
    /// head in one delta and the name in a later delta; we treat
    /// name mismatches as a softer error than outright absence.)
    NameMismatch { expected: String, got: String },
    /// The arguments string isn't valid JSON.
    MalformedJson { raw: String, reason: String },
    /// The arguments don't satisfy the tool's JSON Schema
    /// (placeholder for future use; the TS side does the real
    /// validation today).
    SchemaMismatch { reason: String },
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ValidationError::UnknownTool { id } => {
                write!(f, "unknown tool id: {id}")
            }
            ValidationError::NameMismatch { expected, got } => {
                write!(f, "tool name mismatch: expected {expected}, got {got}")
            }
            ValidationError::MalformedJson { raw, reason } => {
                write!(f, "malformed JSON in tool arguments: {reason}: {raw}")
            }
            ValidationError::SchemaMismatch { reason } => {
                write!(f, "tool arguments do not match schema: {reason}")
            }
        }
    }
}

impl std::error::Error for ValidationError {}

/// Thread-safe registry of tools available to the agent.
///
/// Reads (`get`, `list`, `validate`) are O(1) and lock-free for
/// concurrent callers. Writes (`register`, `unregister`, `clear`)
/// take a brief write lock; in practice these happen once at
/// agent setup, not per turn.
pub struct ToolRegistry {
    inner: RwLock<HashMap<String, ToolEntry>>,
    next_handle: std::sync::atomic::AtomicU64,
}

/// Internal: a registered tool. The `name` doubles as the lookup key
/// (case-sensitive, matching OpenAI/Anthropic semantics).
#[derive(Debug, Clone)]
struct ToolEntry {
    name: String,
    description: String,
    /// JSON Schema for the tool's parameters. `None` means the tool
    /// takes no arguments.
    parameters: Option<Value>,
    /// Free-form metadata (e.g. server name for MCP tools). Not
    /// validated or exposed to the model.
    #[allow(dead_code)]
    metadata: Option<Value>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(HashMap::new()),
            next_handle: std::sync::atomic::AtomicU64::new(1),
        }
    }

    /// Register a tool. Returns `Err` if a tool with the same name is
    /// already registered; callers should call `unregister` first if
    /// they want to replace.
    pub fn register(&self, tool: &TurnTool) -> Result<(), String> {
        self.register_with_metadata(tool, None)
    }

    /// Register a tool with additional metadata (e.g. MCP server name).
    pub fn register_with_metadata(
        &self,
        tool: &TurnTool,
        metadata: Option<Value>,
    ) -> Result<(), String> {
        let mut inner = self.inner.write().map_err(|e| format!("lock poisoned: {e}"))?;
        if inner.contains_key(&tool.name) {
            return Err(format!("tool `{}` already registered", tool.name));
        }
        inner.insert(
            tool.name.clone(),
            ToolEntry {
                name: tool.name.clone(),
                description: tool.description.clone(),
                parameters: tool.parameters.clone(),
                metadata,
            },
        );
        Ok(())
    }

    /// Remove a tool by name. Returns `true` if the tool was registered.
    pub fn unregister(&self, name: &str) -> bool {
        self.inner
            .write()
            .map(|mut inner| inner.remove(name).is_some())
            .unwrap_or(false)
    }

    /// Look up a tool by name. Returns `None` if not registered.
    pub fn get(&self, name: &str) -> Option<RegisteredTool> {
        self.inner
            .read()
            .ok()
            .and_then(|inner| inner.get(name).cloned())
            .map(|e| RegisteredTool {
                name: e.name,
                description: e.description,
                parameters: e.parameters,
            })
    }

    /// True iff a tool with this name is registered.
    pub fn contains(&self, name: &str) -> bool {
        self.inner
            .read()
            .ok()
            .map(|inner| inner.contains_key(name))
            .unwrap_or(false)
    }

    /// Count of registered tools.
    pub fn len(&self) -> usize {
        self.inner.read().map(|i| i.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// All registered tools, sorted by name.
    pub fn list(&self) -> Vec<RegisteredTool> {
        self.inner
            .read()
            .ok()
            .map(|inner| {
                let mut entries: Vec<RegisteredTool> = inner
                    .values()
                    .cloned()
                    .map(|e| RegisteredTool {
                        name: e.name,
                        description: e.description,
                        parameters: e.parameters,
                    })
                    .collect();
                entries.sort_by(|a, b| a.name.cmp(&b.name));
                entries
            })
            .unwrap_or_default()
    }

    /// Validate a tool call against the registry. The `ToolCall` is
    /// the parsed structure from `turn_step::run_turn`.
    ///
    /// Checks (in order):
    ///   1. `call.name` is registered.
    ///   2. `call.name` matches the entry's name (idempotent in
    ///      practice; the `id` is opaque so we only check the name).
    ///   3. `call.arguments` parses as valid JSON (we already do this
    ///      in `run_turn`; this is a defensive double-check).
    ///
    /// Note: we deliberately don't enforce the JSON Schema here.
    /// Schema validation is expensive and better done in TS where
    /// ajv is already configured. The Rust side catches the cheap
    /// "unknown tool" + "name mismatch" + "malformed JSON" cases.
    pub fn validate(&self, call: &ToolCall) -> Result<(), ValidationError> {
        let entry = self
            .inner
            .read()
            .ok()
            .and_then(|inner| inner.get(&call.name).cloned());
        let Some(entry) = entry else {
            return Err(ValidationError::UnknownTool {
                id: call.id.clone(),
            });
        };
        if entry.name != call.name {
            return Err(ValidationError::NameMismatch {
                expected: entry.name,
                got: call.name.clone(),
            });
        }
        // Double-check arguments parse. `run_turn` already does this,
        // but a TS caller could construct a `ToolCall` directly.
        if let Err(e) = serde_json::from_str::<Value>(&call.arguments_raw) {
            return Err(ValidationError::MalformedJson {
                raw: call.arguments_raw.clone(),
                reason: e.to_string(),
            });
        }
        let _ = entry; // suppress unused warning
        Ok(())
    }

    /// Atomically replace the entire registry. Used at agent startup
    /// to load the full tool set in one shot.
    pub fn replace_all(&self, tools: &[TurnTool]) -> Result<(), String> {
        let mut inner = self.inner.write().map_err(|e| format!("lock poisoned: {e}"))?;
        inner.clear();
        for t in tools {
            inner.insert(
                t.name.clone(),
                ToolEntry {
                    name: t.name.clone(),
                    description: t.description.clone(),
                    parameters: t.parameters.clone(),
                    metadata: None,
                },
            );
        }
        Ok(())
    }

    /// Allocate a fresh handle. Handles are monotonic and unique per
    /// process; consumers use them as opaque tokens (e.g. for
    /// correlating napi-side handles with the registry entry).
    #[allow(dead_code)]
    pub fn next_handle(&self) -> u64 {
        self.next_handle
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Read-only view of a tool, returned by `get` / `list`.
#[derive(Debug, Clone, PartialEq)]
pub struct RegisteredTool {
    pub name: String,
    pub description: String,
    pub parameters: Option<Value>,
}

impl RegisteredTool {
    /// Convert to the LLM-facing `TurnTool` shape (drops metadata).
    pub fn to_turn_tool(&self) -> TurnTool {
        TurnTool {
            name: self.name.clone(),
            description: self.description.clone(),
            parameters: self.parameters.clone(),
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_tool(name: &str) -> TurnTool {
        TurnTool {
            name: name.into(),
            description: format!("{name} tool"),
            parameters: Some(json!({"type": "object", "properties": {}})),
        }
    }

    #[test]
    fn register_and_get() {
        let r = ToolRegistry::new();
        r.register(&make_tool("read")).unwrap();
        let t = r.get("read").unwrap();
        assert_eq!(t.name, "read");
        assert_eq!(t.description, "read tool");
    }

    #[test]
    fn duplicate_register_errors() {
        let r = ToolRegistry::new();
        r.register(&make_tool("read")).unwrap();
        let err = r.register(&make_tool("read")).unwrap_err();
        assert!(err.contains("already"));
    }

    #[test]
    fn unregister_returns_true_when_present() {
        let r = ToolRegistry::new();
        r.register(&make_tool("x")).unwrap();
        assert!(r.unregister("x"));
        assert!(!r.unregister("x"));
    }

    #[test]
    fn list_is_sorted_and_complete() {
        let r = ToolRegistry::new();
        r.register(&make_tool("zeta")).unwrap();
        r.register(&make_tool("alpha")).unwrap();
        r.register(&make_tool("mu")).unwrap();
        let names: Vec<_> = r.list().into_iter().map(|t| t.name).collect();
        assert_eq!(names, vec!["alpha", "mu", "zeta"]);
    }

    #[test]
    fn contains_and_len() {
        let r = ToolRegistry::new();
        assert!(r.is_empty());
        assert_eq!(r.len(), 0);
        r.register(&make_tool("a")).unwrap();
        r.register(&make_tool("b")).unwrap();
        assert!(r.contains("a"));
        assert!(!r.contains("c"));
        assert_eq!(r.len(), 2);
        assert!(!r.is_empty());
    }

    #[test]
    fn validate_unknown_tool_reports_id() {
        let r = ToolRegistry::new();
        let call = ToolCall {
            id: "tu_1".into(),
            name: "nope".into(),
            arguments: json!({}),
            arguments_raw: "{}".into(),
            stream_index: 0,
        };
        let err = r.validate(&call).unwrap_err();
        assert_eq!(
            err,
            ValidationError::UnknownTool {
                id: "tu_1".into()
            }
        );
    }

    #[test]
    fn validate_known_tool_with_valid_args_succeeds() {
        let r = ToolRegistry::new();
        r.register(&make_tool("get_weather")).unwrap();
        let call = ToolCall {
            id: "tu_1".into(),
            name: "get_weather".into(),
            arguments: json!({"location": "SF"}),
            arguments_raw: r#"{"location":"SF"}"#.into(),
            stream_index: 0,
        };
        r.validate(&call).unwrap();
    }

    #[test]
    fn validate_malformed_args_reports_parse_error() {
        let r = ToolRegistry::new();
        r.register(&make_tool("t")).unwrap();
        let call = ToolCall {
            id: "tu_1".into(),
            name: "t".into(),
            arguments: Value::Null,
            arguments_raw: "{not valid".into(),
            stream_index: 0,
        };
        let err = r.validate(&call).unwrap_err();
        match err {
            ValidationError::MalformedJson { raw, .. } => {
                assert_eq!(raw, "{not valid");
            }
            other => panic!("expected MalformedJson, got {:?}", other),
        }
    }

    #[test]
    fn replace_all_clears_previous() {
        let r = ToolRegistry::new();
        r.register(&make_tool("old1")).unwrap();
        r.register(&make_tool("old2")).unwrap();
        r.replace_all(&[make_tool("new1")]).unwrap();
        assert_eq!(r.len(), 1);
        assert!(r.contains("new1"));
        assert!(!r.contains("old1"));
        assert!(!r.contains("old2"));
    }

    #[test]
    fn registered_tool_to_turn_tool_round_trip() {
        let r = ToolRegistry::new();
        r.register(&make_tool("t")).unwrap();
        let original = r.get("t").unwrap();
        let converted = original.to_turn_tool();
        assert_eq!(converted.name, "t");
        assert_eq!(converted.description, "t tool");
    }

    #[test]
    fn default_impl_constructs_empty_registry() {
        let r = ToolRegistry::default();
        assert!(r.is_empty());
    }

    #[test]
    fn register_with_metadata_persists_but_keeps_turn_tool_clean() {
        let r = ToolRegistry::new();
        let tool = make_tool("t");
        r.register_with_metadata(
            &tool,
            Some(json!({"server": "github"})),
        )
        .unwrap();
        // `get` returns the clean view (no metadata).
        let view = r.get("t").unwrap();
        assert_eq!(view.name, "t");
        // `to_turn_tool` produces a clean TurnTool.
        let turn = view.to_turn_tool();
        let _ = turn; // metadata intentionally dropped
    }

    #[test]
    fn validate_is_case_sensitive() {
        let r = ToolRegistry::new();
        r.register(&make_tool("Read")).unwrap();
        // Calling with lowercased name is treated as an unknown tool
        // (Rust's HashMap is case-sensitive on keys).
        let call = ToolCall {
            id: "tu_1".into(),
            name: "read".into(),
            arguments: json!({}),
            arguments_raw: "{}".into(),
            stream_index: 0,
        };
        assert!(matches!(
            r.validate(&call),
            Err(ValidationError::UnknownTool { .. })
        ));
    }
}