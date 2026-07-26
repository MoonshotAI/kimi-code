/// LLM request logger — logs outbound LLM request configuration.
///
/// Corresponds to `packages/agent-core/src/agent/llm-request-logger.ts`.
///
/// Logs LLM request config (provider, model, tool count, system prompt
/// fingerprints) only when the config changes between consecutive requests,
/// avoiding repetitive log noise for the steady-state step loop.

use sha2::{Digest, Sha256};

/// Configuration snapshot used for dedup.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
struct ConfigSnapshot {
    provider: String,
    model: String,
    model_alias: Option<String>,
    thinking_effort: Option<String>,
    system_prompt_chars: usize,
    tool_count: usize,
    system_prompt_hash: String,
    tools_hash: String,
}

/// Logger for LLM request diagnostics.
pub struct LlmRequestLogger {
    last_config_signature: Option<String>,
}

impl LlmRequestLogger {
    /// Create a new LlmRequestLogger.
    pub fn new() -> Self {
        Self {
            last_config_signature: None,
        }
    }

    /// Log an LLM request. Returns the JSON-serializable log payload if the
    /// config changed, or `None` if the config is the same as the last request
    /// (no log emission needed).
    pub fn log_request(
        &mut self,
        provider_name: &str,
        model_name: &str,
        model_alias: Option<&str>,
        thinking_effort: Option<&str>,
        system_prompt: &str,
        tool_count: usize,
        tool_sig_json: &str,
    ) -> Option<serde_json::Value> {
        let system_prompt_hash = fingerprint(system_prompt);
        let tools_hash = fingerprint(tool_sig_json);

        let snapshot = ConfigSnapshot {
            provider: provider_name.to_string(),
            model: model_name.to_string(),
            model_alias: model_alias.map(String::from),
            thinking_effort: thinking_effort.map(String::from),
            system_prompt_chars: system_prompt.chars().count(),
            tool_count,
            system_prompt_hash,
            tools_hash,
        };

        let signature = serde_json::json!(&snapshot).to_string();
        if Some(&signature) == self.last_config_signature.as_ref() {
            return None; // Config unchanged, no log needed.
        }

        self.last_config_signature = Some(signature);

        Some(serde_json::json!({
            "type": "llm.config",
            "provider": snapshot.provider,
            "model": snapshot.model,
            "modelAlias": snapshot.model_alias,
            "thinkingEffort": snapshot.thinking_effort,
            "systemPromptChars": snapshot.system_prompt_chars,
            "toolCount": snapshot.tool_count,
            "systemPromptHash": snapshot.system_prompt_hash,
            "toolsHash": snapshot.tools_hash,
        }))
    }

    /// Log a lightweight "llm request" event with optional turn-step metadata.
    pub fn log_request_event(
        &self,
        kind: Option<&str>,
        turn_step: Option<u32>,
        attempt: Option<u32>,
    ) -> serde_json::Value {
        let mut event = serde_json::json!({
            "type": "llm.request",
        });
        if let Some(k) = kind {
            event["kind"] = serde_json::json!(k);
        }
        if let Some(step) = turn_step {
            event["turnStep"] = serde_json::json!(step);
        }
        if let Some(a) = attempt {
            event["attempt"] = serde_json::json!(a);
        }
        event
    }
}

impl Default for LlmRequestLogger {
    fn default() -> Self {
        Self::new()
    }
}

/// Compute a SHA-256 hex fingerprint of a string.
fn fingerprint(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    hex::encode(hasher.finalize())
}

/// Extract a tool signature JSON from tool definitions (name + description + input_schema).
pub fn tool_signature(tools: &[crate::turn_loop::types::ToolInfo]) -> String {
    let sigs: Vec<serde_json::Value> = tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "name": t.name,
                "description": t.description,
                "parameters": t.input_schema,
            })
        })
        .collect();
    serde_json::to_string(&sigs).unwrap_or_default()
}

/// Split generate options — extracts optional request-log fields.
/// Returns `(request_log_fields, remaining)` as serde Values.
pub fn split_generate_options(options: Option<serde_json::Value>) -> (Option<serde_json::Value>, Option<serde_json::Value>) {
    match options {
        None => (None, None),
        Some(mut opts) => {
            let request_fields = opts.as_object_mut()
                .and_then(|map| map.remove("requestLogFields"));
            let remaining = if opts.as_object().map_or(false, |m| m.is_empty()) {
                None
            } else {
                Some(opts)
            };
            (request_fields, remaining)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_logger_no_signature() {
        let mut logger = LlmRequestLogger::new();
        let result = logger.log_request(
            "openai", "gpt-4", Some("gpt4"), None,
            "You are a helpful assistant.", 3,
            r#"[{"name":"read","description":"Read a file","parameters":{}}]"#,
        );
        assert!(result.is_some());
    }

    #[test]
    fn test_identical_config_returns_none() {
        let mut logger = LlmRequestLogger::new();
        let _ = logger.log_request(
            "openai", "gpt-4", Some("gpt4"), Some("on"),
            "You are a helpful assistant.", 3,
            r#"[{"name":"read"}]"#,
        );
        let result = logger.log_request(
            "openai", "gpt-4", Some("gpt4"), Some("on"),
            "You are a helpful assistant.", 3,
            r#"[{"name":"read"}]"#,
        );
        assert!(result.is_none());
    }

    #[test]
    fn test_changed_config_returns_event() {
        let mut logger = LlmRequestLogger::new();
        let _ = logger.log_request(
            "openai", "gpt-4", Some("gpt4"), None,
            "system prompt", 2,
            r#"[{"name":"read"}]"#,
        );
        let result = logger.log_request(
            "openai", "gpt-4", None, None,
            "system prompt", 5,
            r#"[{"name":"read"},{"name":"write"}]"#,
        );
        assert!(result.is_some());
        let obj = result.unwrap();
        assert_eq!(obj["toolCount"], 5);
    }

    #[test]
    fn test_fingerprint_is_hex() {
        let fp = fingerprint("hello");
        assert_eq!(fp.len(), 64); // SHA-256 hex
    }

    #[test]
    fn test_tool_signature_produces_json() {
        let tools = vec![
            crate::turn_loop::types::ToolInfo {
                name: "read".into(),
                description: "Read a file".into(),
                input_schema: serde_json::json!({"type": "object"}),
            },
        ];
        let sig = tool_signature(&tools);
        assert!(sig.contains("read"));
        assert!(sig.contains("Read a file"));
    }

    #[test]
    fn test_log_request_event() {
        let logger = LlmRequestLogger::new();
        let event = logger.log_request_event(Some("loop"), Some(1), Some(0));
        assert_eq!(event["type"], "llm.request");
        assert_eq!(event["kind"], "loop");
        assert_eq!(event["turnStep"], 1);
        assert_eq!(event["attempt"], 0);
    }

    #[test]
    fn test_split_generate_options_none() {
        let (fields, remaining) = split_generate_options(None);
        assert!(fields.is_none());
        assert!(remaining.is_none());
    }

    #[test]
    fn test_split_generate_options_extracts_fields() {
        let opts = serde_json::json!({
            "requestLogFields": {"kind": "loop"},
            "temperature": 0.7,
        });
        let (fields, remaining) = split_generate_options(Some(opts));
        assert!(fields.is_some());
        assert_eq!(fields.unwrap()["kind"], "loop");
        assert!(remaining.is_some());
        assert_eq!(remaining.unwrap()["temperature"], 0.7);
    }
}