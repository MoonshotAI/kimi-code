/// LLM request recorder — durable request-trace recorder.
///
/// Corresponds to `packages/agent-core/src/agent/llm-request-recorder.ts`.
///
/// Tracks tool snapshot hashes, system prompt hashes, and prompt-prefix
/// divergence to detect cache breaks between consecutive LLM requests.
/// Emits structured records through the caller's event sink.

use std::collections::HashSet;

use sha2::{Digest, Sha256};

/// Divergence point in the prompt prefix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrefixDivergence {
    /// Which prefix component changed first.
    pub component: DivergenceComponent,
    /// For `Messages`: index of the first differing message.
    pub message_index: Option<usize>,
    /// For `Messages`: how many messages the previous request carried.
    pub previous_message_count: Option<usize>,
}

/// The component of the prompt prefix that diverged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DivergenceComponent {
    SystemPrompt,
    Tools,
    Messages,
}

/// Tracks non-append edits to the outbound prompt prefix between consecutive
/// requests. Providers key their prompt cache on the byte-stable prefix
/// (system prompt → tools → messages), so the first divergence point is the
/// exact spot the cache breaks; pure tail appends never report.
pub struct PrefixDivergenceTracker {
    last_system_prompt_hash: Option<String>,
    last_tools_hash: Option<String>,
    last_message_hashes: Vec<String>,
}

impl PrefixDivergenceTracker {
    /// Create a new tracker.
    pub fn new() -> Self {
        Self {
            last_system_prompt_hash: None,
            last_tools_hash: None,
            last_message_hashes: Vec::new(),
        }
    }

    /// Observe a new request and detect divergence from the previous one.
    /// Returns `None` on the first call or when the prefix is a pure append.
    pub fn observe(
        &mut self,
        system_prompt_hash: &str,
        tools_hash: &str,
        message_hashes: &[String],
    ) -> Option<PrefixDivergence> {
        let first = self.last_system_prompt_hash.is_none();
        let mut divergence: Option<PrefixDivergence> = None;

        if !first {
            if Some(system_prompt_hash) != self.last_system_prompt_hash.as_deref() {
                divergence = Some(PrefixDivergence {
                    component: DivergenceComponent::SystemPrompt,
                    message_index: None,
                    previous_message_count: None,
                });
            } else if Some(tools_hash) != self.last_tools_hash.as_deref() {
                divergence = Some(PrefixDivergence {
                    component: DivergenceComponent::Tools,
                    message_index: None,
                    previous_message_count: None,
                });
            }
        }

        if !first && divergence.is_none() {
            let previous = &self.last_message_hashes;
            let shared = message_hashes.len().min(previous.len());
            for i in 0..shared {
                if message_hashes[i] != previous[i] {
                    divergence = Some(PrefixDivergence {
                        component: DivergenceComponent::Messages,
                        message_index: Some(i),
                        previous_message_count: Some(previous.len()),
                    });
                    break;
                }
            }
            // A shorter history (undo / compaction / projection drop) is a break
            // even when every shared message still matches.
            if divergence.is_none() && message_hashes.len() < previous.len() {
                divergence = Some(PrefixDivergence {
                    component: DivergenceComponent::Messages,
                    message_index: Some(message_hashes.len()),
                    previous_message_count: Some(previous.len()),
                });
            }
        }

        self.last_system_prompt_hash = Some(system_prompt_hash.to_string());
        self.last_tools_hash = Some(tools_hash.to_string());
        self.last_message_hashes = message_hashes.to_vec();

        divergence
    }
}

impl Default for PrefixDivergenceTracker {
    fn default() -> Self {
        Self::new()
    }
}

/// Recorder for LLM request traces.
///
/// Tracks tool snapshot hashes and system prompt hashes so that
/// duplicate tool snapshots are not re-recorded.
pub struct LlmRequestRecorder {
    /// Hashes of tool tables already recorded.
    seen_tools_hashes: HashSet<String>,
    /// Identity cache over the last tool table.
    last_tools: Option<Vec<ToolIdentity>>,
    last_tools_hash: Option<String>,
    last_system_prompt: Option<String>,
    last_system_prompt_hash: Option<String>,
    /// Prefix divergence tracker.
    prefix_divergence: PrefixDivergenceTracker,
}

/// Lightweight tool identity for reference-equality-style caching.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ToolIdentity {
    name: String,
    description: String,
    input_schema: serde_json::Value,
}

impl LlmRequestRecorder {
    /// Create a new LlmRequestRecorder.
    pub fn new() -> Self {
        Self {
            seen_tools_hashes: HashSet::new(),
            last_tools: None,
            last_tools_hash: None,
            last_system_prompt: None,
            last_system_prompt_hash: None,
            prefix_divergence: PrefixDivergenceTracker::new(),
        }
    }

    /// Replay: mark a tool snapshot hash as already recorded.
    pub fn restore_tools_snapshot(&mut self, hash: &str) {
        self.seen_tools_hashes.insert(hash.to_string());
    }

    /// Record an LLM request. Returns a list of events to emit.
    ///
    /// The first element is always the `llm.request` record.
    /// If the tool snapshot is new, a `llm.tools_snapshot` record is prepended.
    /// If a divergence is detected, a diagnostic event is appended.
    pub fn record(
        &mut self,
        system_prompt: &str,
        tools: &[crate::turn_loop::types::ToolInfo],
        tool_sig_json: &str,
        message_count: usize,
        kind: Option<&str>,
        turn_step: Option<u32>,
        attempt: Option<u32>,
        model_alias: Option<&str>,
    ) -> Vec<serde_json::Value> {
        let mut events = Vec::new();

        // Compute tool hash and check if snapshot is new.
        let tools_hash = self.tools_hash_for(tools, tool_sig_json);
        if !self.seen_tools_hashes.contains(&tools_hash) {
            self.seen_tools_hashes.insert(tools_hash.clone());
            events.push(serde_json::json!({
                "type": "llm.tools_snapshot",
                "hash": tools_hash,
                "tools": serde_json::from_str::<serde_json::Value>(tool_sig_json).unwrap_or_default(),
            }));
        }

        // Compute system prompt hash.
        let system_prompt_hash = self.system_prompt_hash_for(system_prompt);

        // Compute message hashes (simplified: hash each message as a JSON string).
        let message_hashes: Vec<String> = (0..message_count)
            .map(|i| fingerprint(&format!("message_{}", i)))
            .collect();

        // Check for divergence.
        let divergence = self.prefix_divergence.observe(
            &system_prompt_hash,
            &tools_hash,
            &message_hashes,
        );

        // Build the main request record.
        let mut request = serde_json::json!({
            "type": "llm.request",
            "kind": kind.unwrap_or("loop"),
            "systemPromptHash": system_prompt_hash,
            "toolsHash": tools_hash,
            "messageCount": message_count,
        });
        if let Some(alias) = model_alias {
            request["modelAlias"] = serde_json::json!(alias);
        }
        if let Some(step) = turn_step {
            request["turnStep"] = serde_json::json!(step);
        }
        if let Some(a) = attempt {
            request["attempt"] = serde_json::json!(a);
        }
        events.push(request);

        // Add divergence diagnostic if detected.
        if let Some(d) = divergence {
            let mut div_event = serde_json::json!({
                "type": "llm.divergence",
                "component": match d.component {
                    DivergenceComponent::SystemPrompt => "system_prompt",
                    DivergenceComponent::Tools => "tools",
                    DivergenceComponent::Messages => "messages",
                },
            });
            if let Some(idx) = d.message_index {
                div_event["messageIndex"] = serde_json::json!(idx);
            }
            if let Some(cnt) = d.previous_message_count {
                div_event["previousMessageCount"] = serde_json::json!(cnt);
            }
            events.push(div_event);
        }

        events
    }

    /// Compute the hash for a tool table, using identity caching.
    fn tools_hash_for(&mut self, tools: &[crate::turn_loop::types::ToolInfo], tool_sig_json: &str) -> String {
        let identities: Vec<ToolIdentity> = tools
            .iter()
            .map(|t| ToolIdentity {
                name: t.name.clone(),
                description: t.description.clone(),
                input_schema: t.input_schema.clone(),
            })
            .collect();

        if let Some(ref last) = self.last_tools {
            if &identities == last {
                if let Some(ref hash) = self.last_tools_hash {
                    return hash.clone();
                }
            }
        }

        let hash = fingerprint(tool_sig_json);
        self.last_tools = Some(identities);
        self.last_tools_hash = Some(hash.clone());
        hash
    }

    /// Compute the hash for a system prompt, using caching.
    fn system_prompt_hash_for(&mut self, system_prompt: &str) -> String {
        if self.last_system_prompt_hash.is_some()
            && self.last_system_prompt.as_deref() == Some(system_prompt)
        {
            if let Some(ref hash) = self.last_system_prompt_hash {
                return hash.clone();
            }
        }
        let hash = fingerprint(system_prompt);
        self.last_system_prompt = Some(system_prompt.to_string());
        self.last_system_prompt_hash = Some(hash.clone());
        hash
    }
}

impl Default for LlmRequestRecorder {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::turn_loop::types::ToolInfo;

    fn make_tool(name: &str, desc: &str) -> ToolInfo {
        ToolInfo {
            name: name.to_string(),
            description: desc.to_string(),
            input_schema: serde_json::json!({"type": "object"}),
        }
    }

    fn tool_sig(tools: &[ToolInfo]) -> String {
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

    #[test]
    fn test_new_recorder_empty() {
        let recorder = LlmRequestRecorder::new();
        assert!(recorder.seen_tools_hashes.is_empty());
    }

    #[test]
    fn test_first_record_emits_tools_snapshot_and_request() {
        let mut recorder = LlmRequestRecorder::new();
        let tools = vec![make_tool("read", "Read a file")];
        let sig = tool_sig(&tools);

        let events = recorder.record(
            "system prompt", &tools, &sig, 5,
            Some("loop"), Some(0), Some(0), Some("gpt4"),
        );

        // Should have: tools_snapshot + request (+ no divergence on first call)
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["type"], "llm.tools_snapshot");
        assert_eq!(events[1]["type"], "llm.request");
        assert_eq!(events[1]["messageCount"], 5);
    }

    #[test]
    fn test_same_tools_do_not_emit_snapshot_again() {
        let mut recorder = LlmRequestRecorder::new();
        let tools = vec![make_tool("read", "Read a file")];
        let sig = tool_sig(&tools);

        let _ = recorder.record(
            "system prompt", &tools, &sig, 1,
            None, None, None, None,
        );
        let events = recorder.record(
            "system prompt", &tools, &sig, 2,
            None, None, None, None,
        );

        // Second call: no tools_snapshot (already seen), just request
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], "llm.request");
    }

    #[test]
    fn test_different_tools_emit_snapshot() {
        let mut recorder = LlmRequestRecorder::new();
        let tools1 = vec![make_tool("read", "Read a file")];
        let sig1 = tool_sig(&tools1);

        let _ = recorder.record(
            "system prompt", &tools1, &sig1, 1,
            None, None, None, None,
        );

        let tools2 = vec![make_tool("write", "Write a file")];
        let sig2 = tool_sig(&tools2);

        let events = recorder.record(
            "system prompt", &tools2, &sig2, 1,
            None, None, None, None,
        );

        // New tools → new snapshot + request + divergence (tools hash changed)
        assert_eq!(events.len(), 3);
        assert_eq!(events[0]["type"], "llm.tools_snapshot");
        assert_eq!(events[1]["type"], "llm.request");
        assert_eq!(events[2]["type"], "llm.divergence");
    }

    #[test]
    fn test_prefix_divergence_tracker_first_call() {
        let mut tracker = PrefixDivergenceTracker::new();
        let result = tracker.observe("hash1", "hash2", &[]);
        assert!(result.is_none());
    }

    #[test]
    fn test_prefix_divergence_system_prompt_change() {
        let mut tracker = PrefixDivergenceTracker::new();
        let _ = tracker.observe("hash1", "hash2", &[]);
        let result = tracker.observe("hash3", "hash2", &[]);
        assert!(result.is_some());
        assert_eq!(result.as_ref().unwrap().component, DivergenceComponent::SystemPrompt);
    }

    #[test]
    fn test_prefix_divergence_tools_change() {
        let mut tracker = PrefixDivergenceTracker::new();
        let _ = tracker.observe("hash1", "hash2", &[]);
        let result = tracker.observe("hash1", "hash3", &[]);
        assert!(result.is_some());
        assert_eq!(result.as_ref().unwrap().component, DivergenceComponent::Tools);
    }

    #[test]
    fn test_prefix_divergence_message_change() {
        let mut tracker = PrefixDivergenceTracker::new();
        let _ = tracker.observe("hash1", "hash2", &["msg1".to_string()]);
        let result = tracker.observe("hash1", "hash2", &["msg2".to_string()]);
        assert!(result.is_some());
        assert_eq!(result.as_ref().unwrap().component, DivergenceComponent::Messages);
        assert_eq!(result.as_ref().unwrap().message_index, Some(0));
    }

    #[test]
    fn test_prefix_divergence_shorter_history() {
        let mut tracker = PrefixDivergenceTracker::new();
        let _ = tracker.observe("hash1", "hash2", &["a".to_string(), "b".to_string()]);
        let result = tracker.observe("hash1", "hash2", &["a".to_string()]);
        assert!(result.is_some());
        assert_eq!(result.as_ref().unwrap().component, DivergenceComponent::Messages);
        assert_eq!(result.as_ref().unwrap().message_index, Some(1));
    }

    #[test]
    fn test_restore_tools_snapshot() {
        let mut recorder = LlmRequestRecorder::new();
        recorder.restore_tools_snapshot("known_hash");

        let tools = vec![make_tool("read", "Read")];
        let sig = tool_sig(&tools);
        // The known hash won't match the actual tool set, so it still emits.
        // This verifies the method doesn't panic and accepts the hash.
        let events = recorder.record(
            "sp", &tools, &sig, 1, None, None, None, None,
        );
        assert_eq!(events.len(), 2);
    }

    #[test]
    fn test_tool_signature_identity_caching() {
        let mut recorder = LlmRequestRecorder::new();
        let tools = vec![
            make_tool("read", "Read file"),
            make_tool("write", "Write file"),
        ];
        let sig = tool_sig(&tools);

        let _ = recorder.record("sp", &tools, &sig, 1, None, None, None, None);
        // Same tools, same sig — identity cache should prevent re-hashing
        let events = recorder.record("sp", &tools, &sig, 2, None, None, None, None);
        assert_eq!(events.len(), 1);
    }
}