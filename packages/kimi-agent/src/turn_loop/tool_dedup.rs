/// Tool call deduplication — same-step and cross-step dedup.
///
/// Corresponds to `packages/agent-core/src/agent/turn/tool-dedup.ts`.

use std::collections::HashMap;

/// A tool call key for dedup detection.
#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct ToolCallKey {
    name: String,
    args_hash: String,
}

/// Dedup level for escalating reminders.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DedupLevel {
    R1,
    R2,
    R3,
    Stop,
}

/// Tool call deduplicator.
pub struct ToolCallDeduplicator {
    /// Same-step duplicate tracking: (tool_call_id) → original result.
    same_step_dups: HashMap<String, serde_json::Value>,
    /// Cross-step tool call keys seen this step.
    step_keys: Vec<ToolCallKey>,
    /// Cross-step tool call keys seen across all steps.
    cross_step_keys: HashMap<ToolCallKey, DedupLevel>,
    /// Telemetry callback (optional).
    telemetry: Option<Box<dyn Fn(&str) + Send + Sync>>,
}

impl ToolCallDeduplicator {
    /// Create a new deduplicator.
    pub fn new() -> Self {
        Self {
            same_step_dups: HashMap::new(),
            step_keys: Vec::new(),
            cross_step_keys: HashMap::new(),
            telemetry: None,
        }
    }

    /// Create with telemetry callback.
    pub fn with_telemetry(telemetry: Box<dyn Fn(&str) + Send + Sync>) -> Self {
        Self {
            same_step_dups: HashMap::new(),
            step_keys: Vec::new(),
            cross_step_keys: HashMap::new(),
            telemetry: Some(telemetry),
        }
    }

    /// Begin a new step.
    pub fn begin_step(&mut self, _trace_id: &str) {
        self.step_keys.clear();
    }

    /// End the current step.
    pub fn end_step(&mut self) {
        // Move step keys to cross-step tracking.
        for key in self.step_keys.drain(..) {
            let level = self.cross_step_keys.entry(key).or_insert(DedupLevel::R1);
            *level = match *level {
                DedupLevel::R1 => DedupLevel::R2,
                DedupLevel::R2 => DedupLevel::R3,
                DedupLevel::R3 => DedupLevel::Stop,
                DedupLevel::Stop => DedupLevel::Stop,
            };
        }
    }

    /// Check if a tool call is a same-step duplicate.
    /// Returns the cached result if it is, None otherwise.
    pub fn check_same_step(
        &mut self,
        tool_call_id: &str,
        name: &str,
        args: &serde_json::Value,
    ) -> Option<serde_json::Value> {
        let key = ToolCallKey {
            name: name.to_string(),
            args_hash: format!("{:?}", args),
        };

        // Check if this key was already seen in this step.
        if self.step_keys.contains(&key) {
            // Same-step duplicate — mark it.
            self.same_step_dups.insert(tool_call_id.to_string(), args.clone());
            return Some(serde_json::json!({
                "output": format!("Tool call \"{name}\" was already executed in this step with the same arguments. Using the previous result."),
                "is_error": false,
            }));
        }

        self.step_keys.push(key);
        None
    }

    /// Finalize a tool result, resolving dedup.
    pub fn finalize_result(
        &mut self,
        tool_call_id: &str,
        name: &str,
        args: &serde_json::Value,
        result: serde_json::Value,
    ) -> serde_json::Value {
        // If this is a same-step duplicate, return the original result.
        if self.same_step_dups.remove(tool_call_id).is_some() {
            return result;
        }

        // Check cross-step dedup level.
        let key = ToolCallKey {
            name: name.to_string(),
            args_hash: format!("{:?}", args),
        };

        if let Some(level) = self.cross_step_keys.get(&key) {
            let reminder = match level {
                DedupLevel::R1 => {
                    "Note: This tool was also called in a previous step. \
                     If you need the same data, re-read it."
                }
                DedupLevel::R2 => {
                    "Note: This tool was called multiple times across steps. \
                     Consider consolidating your calls."
                }
                DedupLevel::R3 => {
                    "Note: Repeated tool calls across steps. \
                     Review what you're doing and consolidate."
                }
                DedupLevel::Stop => {
                    return serde_json::json!({
                        "output": "This tool call was blocked because it has been repeated \
                                   excessively across multiple steps.",
                        "is_error": true,
                    });
                }
            };

            if let Some(ref telemetry) = self.telemetry {
                telemetry(&format!("cross_step_dedup: {} {}", name, reminder));
            }

            // Append reminder to result.
            let mut result = result;
            if let Some(obj) = result.as_object_mut() {
                if let Some(output) = obj.get("output") {
                    if let Some(text) = output.as_str() {
                        obj.insert("output".to_string(), serde_json::json!(
                            format!("{}\n\n{}", text, reminder)
                        ));
                    }
                }
            }
            return result;
        }

        result
    }
}

impl Default for ToolCallDeduplicator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_same_step_dedup() {
        let mut deduper = ToolCallDeduplicator::new();
        deduper.begin_step("trace-1");

        let args = serde_json::json!({"path": "/a.txt"});
        let result = deduper.check_same_step("call-1", "read", &args);
        assert!(result.is_none()); // First call, not a dup

        let result = deduper.check_same_step("call-2", "read", &args);
        assert!(result.is_some()); // Same args, same step → dup
    }

    #[test]
    fn test_different_args_not_deduped() {
        let mut deduper = ToolCallDeduplicator::new();
        deduper.begin_step("trace-1");

        let args1 = serde_json::json!({"path": "/a.txt"});
        let args2 = serde_json::json!({"path": "/b.txt"});

        assert!(deduper.check_same_step("call-1", "read", &args1).is_none());
        assert!(deduper.check_same_step("call-2", "read", &args2).is_none()); // Different args
    }

    #[test]
    fn test_cross_step_escalation() {
        let mut deduper = ToolCallDeduplicator::new();
        let args = serde_json::json!({"path": "/a.txt"});

        // Step 1
        deduper.begin_step("trace-1");
        deduper.check_same_step("call-1", "read", &args);
        deduper.end_step();

        // Step 2
        deduper.begin_step("trace-2");
        deduper.check_same_step("call-2", "read", &args);
        let result = deduper.finalize_result(
            "call-2", "read", &args,
            serde_json::json!({"output": "content", "is_error": false}),
        );
        // Should have reminder appended
        assert!(result.to_string().contains("Note"));
        deduper.end_step();

        // Step 3
        deduper.begin_step("trace-3");
        deduper.check_same_step("call-3", "read", &args);
        let result = deduper.finalize_result(
            "call-3", "read", &args,
            serde_json::json!({"output": "content", "is_error": false}),
        );
        assert!(result.to_string().contains("consolidate"));
        deduper.end_step();
    }

    #[test]
    fn test_empty() {
        let mut deduper = ToolCallDeduplicator::new();
        deduper.begin_step("trace-1");
        deduper.end_step();
        // Should not panic
    }
}