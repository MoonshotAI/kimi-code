/// Tool call deduplication — same-step dedup and cross-step repeat breaker.
///
/// Corresponds to `packages/agent-core/src/agent/turn/tool-dedup.ts` at
/// upstream 0.31.1 (including #2313: count validation-rejected tool calls
/// toward the repeat breaker).
///
/// Two behaviours are layered:
/// - Same-step dedup: a duplicate `(toolName, args)` issued in the same LLM
///   step reuses the original call's result instead of executing twice.
/// - Cross-step dedup: when the exact same call is repeated consecutively
///   across steps, the result is suffixed with a system reminder once the
///   streak hits 3. It escalates: r1 (nudge) at 3, r2 (forced decision menu,
///   carries the streak count) at 5, r3 (final hand-off) at 8. From streak 12
///   the turn is force-stopped via `stop_turn: true`. Force-stop preserves
///   the underlying tool's `is_error`.

use std::collections::{HashMap, HashSet};

use super::types::ExecutableToolResult;
use crate::turn_loop::tool_args_parse::parse_tool_call_arguments;

const REMINDER_TEXT_1: &str = "\n\n<system-reminder>\n\
The same tool call has been repeated several times in a row. \
Before making your next call, write one sentence stating what new information you expect it to produce. \
Then act on that sentence: if it names something this result does not already give you, choose the action that best provides it; otherwise, continue with the evidence you already have.\
\n</system-reminder>";

fn make_reminder_text_2(repeat_count: u32) -> String {
    format!(
        "\n\n<system-reminder>\n\
The same tool call has now been issued {repeat_count} times in a row. \
Choose exactly one of the following and state your choice before acting:\n\
(1) Falsification check: run the cheapest test that could conclusively disprove your current approach, if such a test exists.\n\
(2) Missing input: tell the user precisely what information or decision you need to proceed, and ask for it.\n\
(3) Conclude: deliver your best result based on the evidence already gathered, listing anything that remains uncertain.\
\n</system-reminder>"
    )
}

const REMINDER_TEXT_3: &str = "\n\n<system-reminder>\n\
Write your final response now, without any further tool calls. \
Cover: the current blocker, each approach you have tried and what it established, and the specific information or decision you need from the user to unblock progress. \
Text only.\
\n</system-reminder>";

const REPEAT_REMINDER_1_START: u32 = 3;
const REPEAT_REMINDER_2_START: u32 = 5;
const REPEAT_REMINDER_3_START: u32 = 8;
const REPEAT_FORCE_STOP_STREAK: u32 = 12;

/// The action taken on the finalized call, for telemetry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RepeatAction {
    None,
    R1,
    R2,
    R3,
    Stop,
}

impl RepeatAction {
    fn as_str(&self) -> &'static str {
        match self {
            RepeatAction::None => "none",
            RepeatAction::R1 => "r1",
            RepeatAction::R2 => "r2",
            RepeatAction::R3 => "r3",
            RepeatAction::Stop => "stop",
        }
    }
}

/// Placeholder result returned for a same-step duplicate call. Never reaches
/// the model — it is replaced in `finalize_result` by the original's result.
/// Must not be an error so the batch is not short-circuited on the dup's
/// behalf.
fn dedup_placeholder() -> ExecutableToolResult {
    ExecutableToolResult {
        content: String::new(),
        is_error: false,
        is_prediction: false,
        stop_turn: false,
        media: Vec::new(),
    }
}

fn append_reminder(mut result: ExecutableToolResult, reminder: &str) -> ExecutableToolResult {
    result.content.push_str(reminder);
    result
}

fn force_stop_result(result: ExecutableToolResult) -> ExecutableToolResult {
    let mut with_reminder = append_reminder(result, REMINDER_TEXT_3);
    with_reminder.stop_turn = true;
    with_reminder
}

/// Build the dedup key: tool name + canonicalized args.
fn make_key(tool_name: &str, args: &serde_json::Value) -> String {
    let args_text = match serde_json::to_string(args) {
        Ok(s) => s,
        Err(_) => format!("{:?}", args),
    };
    format!("{tool_name} {args_text}")
}

/// Tool call deduplicator.
pub struct ToolCallDeduplicator {
    /// Keys registered this step, in registration order.
    step_calls: Vec<String>,
    /// The dedup key used at `check_same_step` time, keyed by `tool_call_id`.
    /// The loop may rewrite args between registration and finalize, so the
    /// `(toolName, args)` pair available at finalize may differ from what was
    /// registered; the key is pinned at registration time.
    call_key_by_call_id: HashMap<String, String>,
    /// Index of the first occurrence of each key within `step_calls`.
    original_call_index: HashMap<String, usize>,
    /// tool_call_ids that are same-step duplicates of an earlier call.
    synthetic_call_ids: HashSet<String>,
    /// Real results of first-occurrence calls, for synthetic backfill.
    step_results: HashMap<String, ExecutableToolResult>,
    /// Consecutive repeat tracking across steps.
    consecutive_key: Option<String>,
    consecutive_count: u32,
    /// Telemetry callback (optional): (tool_name, streak, action).
    telemetry: Option<Box<dyn Fn(&str, u32, &str) + Send + Sync>>,
}

impl ToolCallDeduplicator {
    /// Create a new deduplicator.
    pub fn new() -> Self {
        Self {
            step_calls: Vec::new(),
            call_key_by_call_id: HashMap::new(),
            original_call_index: HashMap::new(),
            synthetic_call_ids: HashSet::new(),
            step_results: HashMap::new(),
            consecutive_key: None,
            consecutive_count: 0,
            telemetry: None,
        }
    }

    /// Create with telemetry callback.
    pub fn with_telemetry(telemetry: Box<dyn Fn(&str, u32, &str) + Send + Sync>) -> Self {
        Self {
            telemetry: Some(telemetry),
            ..Self::new()
        }
    }

    /// Begin a new step: clears all per-step bookkeeping.
    pub fn begin_step(&mut self, _trace_id: &str) {
        self.step_calls.clear();
        self.call_key_by_call_id.clear();
        self.original_call_index.clear();
        self.synthetic_call_ids.clear();
        self.step_results.clear();
    }

    /// End the current step: fold this step's calls into the consecutive
    /// streak. Must be called once per step, after all finalizes.
    pub fn end_step(&mut self) {
        for key in &self.step_calls {
            if Some(key.as_str()) == self.consecutive_key.as_deref() {
                self.consecutive_count += 1;
            } else {
                self.consecutive_key = Some(key.clone());
                self.consecutive_count = 1;
            }
        }
    }

    /// Register a tool call for this step. If the same `(toolName, args)` was
    /// already seen in the current step, returns a placeholder result so the
    /// loop can skip executing the tool again; the real result is patched in
    /// during `finalize_result`. Returns `None` for the first occurrence so
    /// the normal execution path proceeds.
    pub fn check_same_step(
        &mut self,
        tool_call_id: &str,
        tool_name: &str,
        args: &serde_json::Value,
    ) -> Option<ExecutableToolResult> {
        let key = make_key(tool_name, args);
        let index = self.step_calls.len();
        self.step_calls.push(key.clone());
        self.call_key_by_call_id
            .insert(tool_call_id.to_string(), key.clone());

        if self.original_call_index.contains_key(&key) {
            self.synthetic_call_ids.insert(tool_call_id.to_string());
            return Some(dedup_placeholder());
        }
        self.original_call_index.insert(key, index);
        None
    }

    /// Register a call that bypassed the normal prepare path — e.g. args
    /// validation rejected it in preflight, so the prepare hook never ran.
    /// Must be called before `finalize_result` for such calls, otherwise the
    /// repeat circuit breaker never counts rejected calls and the model can
    /// re-issue the same invalid call without ever tripping the streak.
    /// No-op when the call was already registered through the normal path.
    ///
    /// `raw_arguments` is the provider's raw arguments value. Args that
    /// failed JSON parsing were normalized to `{}` by the loop, which would
    /// key every malformed-but-different attempt identically; those are keyed
    /// on the raw text so only true re-issues count as repeats.
    pub fn register_skipped(
        &mut self,
        tool_call_id: &str,
        tool_name: &str,
        args: &serde_json::Value,
        raw_arguments: Option<&serde_json::Value>,
    ) {
        if self.call_key_by_call_id.contains_key(tool_call_id) {
            return;
        }
        let key_args = match raw_arguments {
            Some(serde_json::Value::String(raw)) if parse_tool_call_arguments(raw).parse_failed => {
                serde_json::Value::String(raw.clone())
            }
            _ => args.clone(),
        };
        self.check_same_step(tool_call_id, tool_name, &key_args);
    }

    /// Finalize a tool result. For first-occurrence calls, projects the
    /// consecutive streak ending at this call and, if a threshold is reached,
    /// appends the system reminder (or force-stops at 12). For synthetic
    /// duplicates, returns the original's real result, discarding the
    /// placeholder. Returns the result unchanged when the call was never
    /// registered.
    pub fn finalize_result(
        &mut self,
        tool_call_id: &str,
        tool_name: &str,
        result: ExecutableToolResult,
    ) -> ExecutableToolResult {
        // Use the key recorded at registration time, NOT a fresh key from any
        // args passed here — the loop may have rewritten args.
        let key = match self.call_key_by_call_id.remove(tool_call_id) {
            Some(key) => key,
            None => return result,
        };

        if self.synthetic_call_ids.remove(tool_call_id) {
            return self
                .step_results
                .get(&key)
                .cloned()
                .unwrap_or(result);
        }

        let Some(index) = self.original_call_index.remove(&key) else {
            return result;
        };
        if index >= self.step_calls.len() {
            return result;
        }

        // Project the streak ending at this call: replay the consecutive
        // state from the last committed end_step forward to `index`.
        let mut last_key = self.consecutive_key.clone();
        let mut streak = self.consecutive_count;
        for i in 0..=index {
            let k = &self.step_calls[i];
            if Some(k.as_str()) == last_key.as_deref() {
                streak += 1;
            } else {
                last_key = Some(k.clone());
                streak = 1;
            }
        }

        let final_result = if streak >= REPEAT_FORCE_STOP_STREAK {
            force_stop_result(result)
        } else if streak >= REPEAT_REMINDER_3_START {
            append_reminder(result, REMINDER_TEXT_3)
        } else if streak >= REPEAT_REMINDER_2_START {
            append_reminder(result, &make_reminder_text_2(streak))
        } else if streak >= REPEAT_REMINDER_1_START {
            append_reminder(result, REMINDER_TEXT_1)
        } else {
            result
        };

        let action = if final_result.stop_turn {
            RepeatAction::Stop
        } else if streak >= REPEAT_REMINDER_3_START {
            RepeatAction::R3
        } else if streak >= REPEAT_REMINDER_2_START {
            RepeatAction::R2
        } else if streak >= REPEAT_REMINDER_1_START {
            RepeatAction::R1
        } else {
            RepeatAction::None
        };

        if streak >= 2 {
            if let Some(ref telemetry) = self.telemetry {
                telemetry(tool_name, streak, action.as_str());
            }
        }

        self.step_results.insert(key, final_result.clone());
        final_result
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
    use std::sync::Arc;

    fn result(content: &str) -> ExecutableToolResult {
        ExecutableToolResult {
            content: content.to_string(),
            is_error: false,
            is_prediction: false,
            stop_turn: false,
            media: Vec::new(),
        }
    }

    #[test]
    fn test_same_step_dedup_returns_placeholder_then_real_result() {
        let mut deduper = ToolCallDeduplicator::new();
        deduper.begin_step("trace-1");

        let args = serde_json::json!({"path": "/a.txt"});
        assert!(deduper
            .check_same_step("call-1", "read", &args)
            .is_none());

        let placeholder = deduper.check_same_step("call-2", "read", &args);
        assert!(placeholder.is_some(), "dup should return a placeholder");
        assert!(!placeholder.unwrap().is_error);

        let real = deduper.finalize_result(
            "call-1",
            "read",
            result("file content"),
        );
        assert_eq!(real.content, "file content");
        assert!(!real.stop_turn);

        let dup = deduper.finalize_result(
            "call-2",
            "read",
            dedup_placeholder(),
        );
        assert_eq!(dup.content, "file content", "dup must reuse the original result");
    }

    #[test]
    fn test_different_args_not_deduped() {
        let mut deduper = ToolCallDeduplicator::new();
        deduper.begin_step("trace-1");

        let args1 = serde_json::json!({"path": "/a.txt"});
        let args2 = serde_json::json!({"path": "/b.txt"});

        assert!(deduper.check_same_step("call-1", "read", &args1).is_none());
        assert!(deduper.check_same_step("call-2", "read", &args2).is_none());
    }

    #[test]
    fn test_register_skipped_noop_when_registered() {
        let mut deduper = ToolCallDeduplicator::new();
        deduper.begin_step("trace-1");

        let args = serde_json::json!({"path": "/a.txt"});
        deduper.check_same_step("call-1", "read", &args);
        // Second registration must be a no-op (same id).
        deduper.register_skipped("call-1", "read", &args, None);

        let real = deduper.finalize_result("call-1", "read", result("content"));
        assert_eq!(real.content, "content");
    }

    #[test]
    fn test_register_skipped_keys_parse_failed_on_raw_text() {
        let mut deduper = ToolCallDeduplicator::new();
        deduper.begin_step("trace-1");

        let args = serde_json::json!({});
        let raw1 = serde_json::Value::String("{malformed-1".into());
        let raw2 = serde_json::Value::String("{malformed-2".into());
        // Two malformed calls with different raw text must NOT be deduped
        // against each other: they are keyed on the raw text (which differs),
        // not on the normalized {}.
        deduper.register_skipped("call-1", "read", &args, Some(&raw1));
        deduper.register_skipped("call-2", "read", &args, Some(&raw2));

        let r1 = deduper.finalize_result("call-1", "read", result("first"));
        let r2 = deduper.finalize_result("call-2", "read", result("second"));
        assert_eq!(r1.content, "first");
        assert_eq!(r2.content, "second");
    }

    #[test]
    fn test_cross_step_escalation_r1_r2_r3() {
        let mut deduper = ToolCallDeduplicator::new();
        let args = serde_json::json!({"path": "/a.txt"});

        // Steps 1-2: streak 2, no reminder.
        for step in 0..2 {
            deduper.begin_step(&format!("t{step}"));
            deduper.check_same_step("call", "read", &args);
            let r = deduper.finalize_result("call", "read", result("data"));
            assert!(!r.content.contains("system-reminder"));
            deduper.end_step();
        }

        // Step 3: streak 3 → r1.
        deduper.begin_step("t3");
        deduper.check_same_step("call", "read", &args);
        let r = deduper.finalize_result("call", "read", result("data"));
        assert!(r.content.contains("The same tool call has been repeated several times"));
        deduper.end_step();

        // Steps 4-5: streak 5 → r2 with count.
        for step in 4..=5 {
            deduper.begin_step(&format!("t{step}"));
            deduper.check_same_step("call", "read", &args);
            let r = deduper.finalize_result("call", "read", result("data"));
            if step == 5 {
                assert!(r.content.contains("5 times in a row"));
                assert!(r.content.contains("Falsification check"));
            }
            deduper.end_step();
        }

        // Steps 6-8: streak 8 → r3.
        for step in 6..=8 {
            deduper.begin_step(&format!("t{step}"));
            deduper.check_same_step("call", "read", &args);
            let r = deduper.finalize_result("call", "read", result("data"));
            if step == 8 {
                assert!(r.content.contains("Write your final response now"));
                assert!(!r.stop_turn, "r3 appends the reminder but must not stop");
            }
            deduper.end_step();
        }
    }

    #[test]
    fn test_force_stop_at_streak_12() {
        let mut deduper = ToolCallDeduplicator::new();
        let args = serde_json::json!({"path": "/a.txt"});

        let mut stopped = None;
        for step in 0..12 {
            deduper.begin_step(&format!("t{step}"));
            deduper.check_same_step("call", "read", &args);
            let r = deduper.finalize_result("call", "read", result("data"));
            deduper.end_step();
            if r.stop_turn {
                stopped = Some(step);
            }
        }
        assert_eq!(stopped, Some(11), "force-stop must fire at streak 12");
    }

    #[test]
    fn test_streak_broken_by_different_call() {
        let mut deduper = ToolCallDeduplicator::new();
        let read = serde_json::json!({"path": "/a.txt"});
        let write = serde_json::json!({"path": "/a.txt", "content": "x"});

        for step in 0..2 {
            deduper.begin_step(&format!("t{step}"));
            deduper.check_same_step("call", "read", &read);
            deduper.finalize_result("call", "read", result("data"));
            deduper.end_step();
        }
        // Interleave a different call.
        deduper.begin_step("t3");
        deduper.check_same_step("call2", "write", &write);
        deduper.finalize_result("call2", "write", result("ok"));
        deduper.end_step();

        // Streak resets to 1 for read.
        deduper.begin_step("t4");
        deduper.check_same_step("call", "read", &read);
        let r = deduper.finalize_result("call", "read", result("data"));
        assert!(!r.content.contains("system-reminder"));
        deduper.end_step();
    }

    #[test]
    fn test_force_stop_preserves_is_error() {
        let mut deduper = ToolCallDeduplicator::new();
        let args = serde_json::json!({"path": "/a.txt"});

        for step in 0..12 {
            deduper.begin_step(&format!("t{step}"));
            deduper.check_same_step("call", "read", &args);
            let r = deduper.finalize_result(
                "call",
                "read",
                ExecutableToolResult {
                    content: "boom".into(),
                    is_error: true,
                    is_prediction: false,
                    stop_turn: false,
                    media: Vec::new(),
                },
            );
            deduper.end_step();
            if step == 11 {
                assert!(r.stop_turn);
                assert!(r.is_error, "force-stop must preserve the original is_error");
            }
        }
    }

    #[test]
    fn test_telemetry_fired_on_streak() {
        use std::sync::Mutex;

        let events: Arc<Mutex<Vec<(String, u32, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let ev = events.clone();
        let mut deduper = ToolCallDeduplicator::with_telemetry(Box::new(move |name, streak, action| {
            ev.lock().unwrap_or_else(|e| e.into_inner())
                .push((name.to_string(), streak, action.to_string()));
        }));

        let args = serde_json::json!({"path": "/a.txt"});
        for step in 0..3 {
            deduper.begin_step(&format!("t{step}"));
            deduper.check_same_step("call", "read", &args);
            deduper.finalize_result("call", "read", result("data"));
            deduper.end_step();
        }
        let events = events.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(events.len(), 2, "telemetry fires from streak 2");
        let last = events.last().unwrap();
        assert_eq!(last.0, "read");
        assert_eq!(last.1, 3);
        assert_eq!(last.2, "r1");
    }
}
