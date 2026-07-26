/// Usage — token usage accounting pure functions for v2 migration.
///
/// Pure computation functions for token usage aggregation. The TS side
/// retains wire dispatch, DI registration, and event publishing.
///
/// Corresponds to `packages/agent-core-v2/src/kosong/contract/usage.ts`
/// and `packages/agent-core-v2/src/agent/usage/usageOps.ts`.
use napi_derive::napi;
use serde::{Deserialize, Serialize};

// ── TokenUsage shape (matches v2 TS contract) ───────────────────────────

/// Token usage breakdown for a single LLM generation.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[napi(object)]
pub struct NativeTokenUsage {
    pub input_other: f64,
    pub output: f64,
    pub input_cache_read: f64,
    pub input_cache_creation: f64,
}

/// Usage status snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[napi(object)]
pub struct NativeUsageStatus {
    pub by_model: Option<String>,  // JSON string of Record<string, NativeTokenUsage>
    pub total: Option<String>,     // JSON string of NativeTokenUsage
    pub current_turn: Option<String>, // JSON string of NativeTokenUsage
}

// ── Pure functions ──────────────────────────────────────────────────────

/// Add two TokenUsage values together.
#[napi]
pub fn native_usage_add(a_json: String, b_json: String) -> String {
    let a: NativeTokenUsage = serde_json::from_str(&a_json).unwrap_or_default();
    let b: NativeTokenUsage = serde_json::from_str(&b_json).unwrap_or_default();
    let result = NativeTokenUsage {
        input_other: a.input_other + b.input_other,
        output: a.output + b.output,
        input_cache_read: a.input_cache_read + b.input_cache_read,
        input_cache_creation: a.input_cache_creation + b.input_cache_creation,
    };
    serde_json::to_string(&result).unwrap_or_default()
}

/// Create an empty TokenUsage (all zeros).
#[napi]
pub fn native_usage_empty() -> String {
    let result = NativeTokenUsage::default();
    serde_json::to_string(&result).unwrap_or_default()
}

/// Compute the total input tokens (sum of all input fields).
#[napi]
pub fn native_usage_input_total(usage_json: String) -> f64 {
    let usage: NativeTokenUsage = serde_json::from_str(&usage_json).unwrap_or_default();
    usage.input_other + usage.input_cache_read + usage.input_cache_creation
}

/// Compute the grand total (input + output).
#[napi]
pub fn native_usage_grand_total(usage_json: String) -> f64 {
    let usage: NativeTokenUsage = serde_json::from_str(&usage_json).unwrap_or_default();
    usage.input_other + usage.input_cache_read + usage.input_cache_creation + usage.output
}

/// Sum all usage values in a per-model map (JSON string).
/// Returns JSON string of the total TokenUsage, or empty string if empty.
#[napi]
pub fn native_usage_total(by_model_json: String) -> String {
    let by_model: serde_json::Value =
        serde_json::from_str(&by_model_json).unwrap_or(serde_json::Value::Null);

    let mut total: Option<NativeTokenUsage> = None;

    if let serde_json::Value::Object(obj) = &by_model {
        for value in obj.values() {
            let usage: NativeTokenUsage =
                serde_json::from_value(value.clone()).unwrap_or_default();
            total = Some(match total {
                Some(existing) => NativeTokenUsage {
                    input_other: existing.input_other + usage.input_other,
                    output: existing.output + usage.output,
                    input_cache_read: existing.input_cache_read + usage.input_cache_read,
                    input_cache_creation: existing.input_cache_creation + usage.input_cache_creation,
                },
                None => usage,
            });
        }
    }

    match total {
        Some(t) => serde_json::to_string(&t).unwrap_or_default(),
        None => String::new(),
    }
}

/// Build a UsageStatus from a UsageModel state and optional current turn.
///
/// model_json: JSON { by_model: Record<string, TokenUsage> }
/// current_turn_json: JSON TokenUsage or empty string for none
///
/// Returns JSON UsageStatus { by_model, total, current_turn }
#[napi]
pub fn native_usage_status_from_state(model_json: String, current_turn_json: String) -> String {
    let model: serde_json::Value =
        serde_json::from_str(&model_json).unwrap_or(serde_json::Value::Null);

    let by_model = model.get("by_model").and_then(|v| {
        if v.is_null() || v.as_object().map_or(true, |o| o.is_empty()) {
            None
        } else {
            Some(serde_json::to_string(v).unwrap_or_default())
        }
    });

    let total = by_model.as_ref().and_then(|bm| {
        let result = native_usage_total(bm.clone());
        if result.is_empty() { None } else { Some(result) }
    });

    let current_turn = if current_turn_json.is_empty() {
        None
    } else {
        Some(current_turn_json)
    };

    let status = serde_json::json!({
        "by_model": by_model,
        "total": total,
        "current_turn": current_turn,
    });

    serde_json::to_string(&status).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_usage(input_other: f64, output: f64, cache_read: f64, cache_creation: f64) -> String {
        serde_json::to_string(&NativeTokenUsage {
            input_other,
            output,
            input_cache_read: cache_read,
            input_cache_creation: cache_creation,
        }).unwrap()
    }

    #[test]
    fn test_empty_usage() {
        let result = native_usage_empty();
        let parsed: NativeTokenUsage = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed.input_other, 0.0);
        assert_eq!(parsed.output, 0.0);
        assert_eq!(parsed.input_cache_read, 0.0);
        assert_eq!(parsed.input_cache_creation, 0.0);
    }

    #[test]
    fn test_add_usage() {
        let a = make_usage(10.0, 5.0, 3.0, 1.0);
        let b = make_usage(20.0, 10.0, 6.0, 2.0);
        let result = native_usage_add(a, b);
        let parsed: NativeTokenUsage = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed.input_other, 30.0);
        assert_eq!(parsed.output, 15.0);
        assert_eq!(parsed.input_cache_read, 9.0);
        assert_eq!(parsed.input_cache_creation, 3.0);
    }

    #[test]
    fn test_input_total() {
        let usage = make_usage(10.0, 5.0, 3.0, 2.0);
        let total = native_usage_input_total(usage);
        assert_eq!(total, 15.0); // 10 + 3 + 2
    }

    #[test]
    fn test_grand_total() {
        let usage = make_usage(10.0, 5.0, 3.0, 2.0);
        let total = native_usage_grand_total(usage);
        assert_eq!(total, 20.0); // 10 + 5 + 3 + 2
    }

    #[test]
    fn test_total_usage_empty() {
        let result = native_usage_total(r#"{}"#.to_string());
        assert!(result.is_empty());
    }

    #[test]
    fn test_total_usage_sums() {
        let by_model = serde_json::json!({
            "model-a": { "input_other": 10.0, "output": 5.0, "input_cache_read": 0.0, "input_cache_creation": 0.0 },
            "model-b": { "input_other": 100.0, "output": 50.0, "input_cache_read": 0.0, "input_cache_creation": 0.0 },
        });
        let result = native_usage_total(by_model.to_string());
        let parsed: NativeTokenUsage = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed.input_other, 110.0);
        assert_eq!(parsed.output, 55.0);
    }

    #[test]
    fn test_status_from_state() {
        let model = serde_json::json!({
            "by_model": {
                "model-a": { "input_other": 10.0, "output": 5.0, "input_cache_read": 0.0, "input_cache_creation": 0.0 }
            }
        });
        let current = make_usage(5.0, 3.0, 0.0, 0.0);
        let result = native_usage_status_from_state(model.to_string(), current);
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert!(parsed["by_model"].is_string());
        assert!(parsed["total"].is_string());
        assert!(parsed["current_turn"].is_string());
    }
}