/// UsageRecorder — token usage statistics for the agent.
///
/// Corresponds to `packages/agent-core/src/agent/usage/index.ts`.
///
/// Tracks per-model token usage across the session and per-turn usage.
/// Thread-safe via atomic operations on the field level; the by-model
/// map uses a `Mutex` for interior mutability.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::rpc::types::TokenUsage;

/// Per-model usage summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageStatus {
    /// Usage broken down by model alias.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by_model: Option<HashMap<String, TokenUsage>>,
    /// Total usage across all models.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<TokenUsage>,
    /// Usage for the current turn (if any).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_turn: Option<TokenUsage>,
}

/// Scope for a usage record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageRecordScope {
    Session,
    Turn,
}

/// Records token usage per model and per turn.
pub struct UsageRecorder {
    /// Per-model accumulated usage.
    by_model: Mutex<HashMap<String, TokenUsage>>,
    /// Current turn usage (cleared on beginTurn / endTurn).
    current_turn: Mutex<Option<TokenUsage>>,
}

impl UsageRecorder {
    /// Create a new UsageRecorder.
    pub fn new() -> Self {
        Self {
            by_model: Mutex::new(HashMap::new()),
            current_turn: Mutex::new(None),
        }
    }

    /// Begin a new turn — resets the current-turn usage window.
    pub fn begin_turn(&self) {
        *self.current_turn.lock().unwrap() = None;
    }

    /// End the current turn — clears the current-turn usage window.
    pub fn end_turn(&self) {
        *self.current_turn.lock().unwrap() = None;
    }

    /// Record token usage for a model.
    ///
    /// `scope` controls whether the usage is also counted toward the current turn.
    pub fn record(&self, model: &str, usage: &TokenUsage, scope: UsageRecordScope) {
        // Accumulate into per-model storage.
        {
            let mut by_model = self.by_model.lock().unwrap();
            let entry = by_model.entry(model.to_string()).or_default();
            *entry = add_usage(entry, usage);
        }

        // If turn-scoped, also accumulate into current_turn.
        if scope == UsageRecordScope::Turn {
            let mut current = self.current_turn.lock().unwrap();
            *current = Some(match current.take() {
                Some(existing) => add_usage(&existing, usage),
                None => usage.clone(),
            });
        }
    }

    /// Return the full usage status snapshot.
    pub fn data(&self) -> UsageStatus {
        let by_model = {
            let m = self.by_model.lock().unwrap();
            if m.is_empty() {
                None
            } else {
                Some(m.clone())
            }
        };
        let total = by_model.as_ref().and_then(|m| total_usage(m));
        let current_turn = self.current_turn.lock().unwrap().clone();

        UsageStatus {
            by_model,
            total,
            current_turn,
        }
    }

    /// Return `Some(UsageStatus)` only when there is actual usage data;
    /// returns `None` when everything is zero/empty (matching TS `status()`).
    pub fn status(&self) -> Option<UsageStatus> {
        let status = self.data();
        if status.by_model.is_none()
            && status.total.is_none()
            && status.current_turn.is_none()
        {
            return None;
        }
        Some(status)
    }
}

impl Default for UsageRecorder {
    fn default() -> Self {
        Self::new()
    }
}

/// Add two TokenUsage values together, producing a new aggregate.
fn add_usage(a: &TokenUsage, b: &TokenUsage) -> TokenUsage {
    TokenUsage {
        input_tokens: a.input_tokens + b.input_tokens,
        output_tokens: a.output_tokens + b.output_tokens,
        total_tokens: a.total_tokens + b.total_tokens,
    }
}

/// Sum all usage values in a per-model map.
fn total_usage(by_model: &HashMap<String, TokenUsage>) -> Option<TokenUsage> {
    let mut total: Option<TokenUsage> = None;
    for usage in by_model.values() {
        total = Some(match total {
            Some(existing) => add_usage(&existing, usage),
            None => usage.clone(),
        });
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_usage(input: u32, output: u32) -> TokenUsage {
        TokenUsage {
            input_tokens: input,
            output_tokens: output,
            total_tokens: input + output,
        }
    }

    #[test]
    fn test_new_recorder_is_empty() {
        let recorder = UsageRecorder::new();
        assert!(recorder.status().is_none());
    }

    #[test]
    fn test_begin_turn_clears_current() {
        let recorder = UsageRecorder::new();
        recorder.record(
            "model-a",
            &sample_usage(10, 5),
            UsageRecordScope::Turn,
        );
        assert!(recorder.data().current_turn.is_some());

        recorder.begin_turn();
        assert!(recorder.data().current_turn.is_none());
    }

    #[test]
    fn test_end_turn_clears_current() {
        let recorder = UsageRecorder::new();
        recorder.record(
            "model-a",
            &sample_usage(10, 5),
            UsageRecordScope::Turn,
        );
        assert!(recorder.data().current_turn.is_some());

        recorder.end_turn();
        assert!(recorder.data().current_turn.is_none());
    }

    #[test]
    fn test_record_session_scope_does_not_affect_turn() {
        let recorder = UsageRecorder::new();
        recorder.record(
            "model-a",
            &sample_usage(10, 5),
            UsageRecordScope::Session,
        );
        let data = recorder.data();
        assert!(data.current_turn.is_none());
        assert!(data.by_model.is_some());
    }

    #[test]
    fn test_record_turn_scope_affects_both() {
        let recorder = UsageRecorder::new();
        recorder.record(
            "model-a",
            &sample_usage(10, 5),
            UsageRecordScope::Turn,
        );
        let data = recorder.data();
        assert!(data.current_turn.is_some());
        assert_eq!(data.current_turn.as_ref().unwrap().input_tokens, 10);
        assert!(data.by_model.is_some());
    }

    #[test]
    fn test_accumulates_across_calls() {
        let recorder = UsageRecorder::new();
        recorder.record(
            "model-a",
            &sample_usage(10, 5),
            UsageRecordScope::Session,
        );
        recorder.record(
            "model-a",
            &sample_usage(20, 10),
            UsageRecordScope::Session,
        );
        let data = recorder.data();
        let model_a = data.by_model.as_ref().unwrap().get("model-a").unwrap();
        assert_eq!(model_a.input_tokens, 30);
        assert_eq!(model_a.output_tokens, 15);
        assert_eq!(model_a.total_tokens, 45);
    }

    #[test]
    fn test_separate_models() {
        let recorder = UsageRecorder::new();
        recorder.record(
            "model-a",
            &sample_usage(10, 5),
            UsageRecordScope::Session,
        );
        recorder.record(
            "model-b",
            &sample_usage(100, 50),
            UsageRecordScope::Session,
        );
        let data = recorder.data();
        let by_model = data.by_model.unwrap();
        assert_eq!(by_model.get("model-a").unwrap().input_tokens, 10);
        assert_eq!(by_model.get("model-b").unwrap().input_tokens, 100);
        let total = data.total.unwrap();
        assert_eq!(total.input_tokens, 110);
        assert_eq!(total.output_tokens, 55);
        assert_eq!(total.total_tokens, 165);
    }

    #[test]
    fn test_status_returns_none_when_empty() {
        let recorder = UsageRecorder::new();
        assert!(recorder.status().is_none());
    }

    #[test]
    fn test_status_returns_some_when_usage_exists() {
        let recorder = UsageRecorder::new();
        recorder.record(
            "model-a",
            &sample_usage(1, 1),
            UsageRecordScope::Session,
        );
        assert!(recorder.status().is_some());
    }

    #[test]
    fn test_current_turn_accumulates() {
        let recorder = UsageRecorder::new();
        recorder.record(
            "model-a",
            &sample_usage(10, 5),
            UsageRecordScope::Turn,
        );
        recorder.record(
            "model-a",
            &sample_usage(20, 10),
            UsageRecordScope::Turn,
        );
        let current = recorder.data().current_turn.unwrap();
        assert_eq!(current.input_tokens, 30);
        assert_eq!(current.output_tokens, 15);
    }

    #[test]
    fn test_add_usage_combines() {
        let a = sample_usage(10, 5);
        let b = sample_usage(20, 10);
        let c = add_usage(&a, &b);
        assert_eq!(c.input_tokens, 30);
        assert_eq!(c.output_tokens, 15);
        assert_eq!(c.total_tokens, 45);
    }

    #[test]
    fn test_total_usage_empty_map() {
        let map: HashMap<String, TokenUsage> = HashMap::new();
        assert!(total_usage(&map).is_none());
    }

    #[test]
    fn test_total_usage_sums() {
        let mut map = HashMap::new();
        map.insert("a".into(), sample_usage(10, 5));
        map.insert("b".into(), sample_usage(100, 50));
        let total = total_usage(&map).unwrap();
        assert_eq!(total.input_tokens, 110);
        assert_eq!(total.output_tokens, 55);
    }
}