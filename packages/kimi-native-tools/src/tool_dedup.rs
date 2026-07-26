/// Tool call deduplication — pure state machine for v2 migration.
///
/// This module implements the cross-step tool call tracking and reminder
/// escalation logic that was previously only in TypeScript. The TS side
/// retains hook registration, deferred/promise orchestration, and telemetry.
///
/// Corresponds to `packages/agent-core-v2/src/agent/toolDedupe/toolDedupeService.ts`.
use napi_derive::napi;

// ── Thresholds (must match TS constants) ────────────────────────────────
pub const REPEAT_REMINDER_1_START: u32 = 3;
pub const REPEAT_REMINDER_2_START: u32 = 5;
pub const REPEAT_REMINDER_3_START: u32 = 8;
pub const REPEAT_FORCE_STOP_STREAK: u32 = 12;

// ── Result types ────────────────────────────────────────────────────────

/// Result of a tool call check.

/// Canonical JSON serialization: sort object keys for stable hashing.
/// Mirrors `canonicalTelemetryArgs()` in `_base/utils/canonical-args.ts`.
fn sort_json_value(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(obj) => {
            let mut keys: Vec<&String> = obj.keys().collect();
            keys.sort();
            let sorted: serde_json::Map<String, serde_json::Value> = keys
                .iter()
                .map(|k| ((*k).clone(), sort_json_value(&obj[k.as_str()])))
                .collect();
            serde_json::Value::Object(sorted)
        }
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(|v| sort_json_value(v)).collect())
        }
        other => other.clone(),
    }
}

/// Create a canonical JSON string from args, with sorted keys.
/// Mirrors `canonicalTelemetryArgs()` in TS.
#[napi]
pub fn native_tool_dedup_canonical_json(args_json: String) -> String {
    match serde_json::from_str::<serde_json::Value>(&args_json) {
        Ok(value) => {
            let sorted = sort_json_value(&value);
            serde_json::to_string(&sorted).unwrap_or(args_json)
        }
        Err(_) => args_json,
    }
}

/// Create a stable dedup key from tool name + canonical args.
#[napi]
pub fn native_tool_dedup_make_key(tool_name: String, canonical_args: String) -> String {
    format!("{} {}", tool_name, canonical_args)
}

/// SHA256 hash of canonical args (first 8 hex chars).
/// Mirrors `argsHash()` in TS.
#[napi]
pub fn native_tool_dedup_args_hash(canonical_args: String) -> String {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(canonical_args.as_bytes());
    let hash = hasher.finalize();
    // first 4 bytes → 8 hex chars
    format!("{:02x}{:02x}{:02x}{:02x}", hash[0], hash[1], hash[2], hash[3])
}

/// Determine reminder level from cross-step streak.
/// Mirrors the escalation logic in `finalizeResult()`.
#[napi]
pub fn native_tool_dedup_reminder_level(streak: u32) -> u32 {
    if streak >= REPEAT_FORCE_STOP_STREAK {
        4 // stop
    } else if streak >= REPEAT_REMINDER_3_START {
        3 // r3
    } else if streak >= REPEAT_REMINDER_2_START {
        2 // r2
    } else if streak >= REPEAT_REMINDER_1_START {
        1 // r1
    } else {
        0 // none
    }
}

/// Check if a tool call is a same-step duplicate.
/// Returns whether it's a dup and the current cross-step streak.
///
/// step_keys_json: JSON array of keys already seen in this step, e.g. ["read /a.txt", "write /b.txt"]
/// key: the new tool call key
/// consecutive_key: the current cross-step consecutive key (or null)
/// consecutive_count: the current cross-step consecutive count
///
/// Returns JSON: { step_keys, is_same_step_dup, cross_step_streak }
#[napi]
pub fn native_tool_dedup_check(
    step_keys_json: String,
    key: String,
    consecutive_key: Option<String>,
    consecutive_count: u32,
) -> String {
    let mut step_keys: Vec<String> =
        serde_json::from_str(&step_keys_json).unwrap_or_default();

    let is_same_step_dup = step_keys.contains(&key);
    if !is_same_step_dup {
        step_keys.push(key.clone());
    }

    let cross_step_streak = if is_same_step_dup {
        // Same-step dup: cross-step streak stays the same
        consecutive_count
    } else if consecutive_key.as_deref() == Some(&key) && consecutive_count > 0 {
        // Cross-step repeat
        consecutive_count + 1
    } else if consecutive_key.as_deref() == Some(&key) {
        // First repeat of the same key
        1
    } else {
        0
    };

    let result = serde_json::json!({
        "step_keys": step_keys,
        "is_same_step_dup": is_same_step_dup,
        "cross_step_streak": cross_step_streak,
    });

    serde_json::to_string(&result).unwrap_or_default()
}

/// Finalize a step: update cross-step tracking.
/// Returns the new consecutive_key, consecutive_count, and reminder_level.
///
/// step_keys_json: JSON array of keys seen in this step
/// consecutive_key: the current cross-step consecutive key (or null)
/// consecutive_count: the current cross-step consecutive count
///
/// Returns JSON: { consecutive_key, consecutive_count, reminder_level }
#[napi]
pub fn native_tool_dedup_end_step(
    step_keys_json: String,
    consecutive_key: Option<String>,
    consecutive_count: u32,
) -> String {
    let step_keys: Vec<String> =
        serde_json::from_str(&step_keys_json).unwrap_or_default();

    let (new_consecutive_key, new_consecutive_count) = if step_keys.is_empty() {
        // No calls this step, keep state
        (consecutive_key, consecutive_count)
    } else {
        // Use the last unique key in this step
        // Find the first key (typical case: all calls in this step are the same)
        let first_key = step_keys[0].clone();
        if consecutive_key.as_deref() == Some(&first_key) {
            (Some(first_key), consecutive_count + step_keys.len() as u32)
        } else {
            (Some(first_key), step_keys.len() as u32)
        }
    };

    let reminder_level = native_tool_dedup_reminder_level(new_consecutive_count);

    let result = serde_json::json!({
        "consecutive_key": new_consecutive_key,
        "consecutive_count": new_consecutive_count,
        "reminder_level": reminder_level,
    });

    serde_json::to_string(&result).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_canonical_json_sorts_keys() {
        let input = r#"{"z": 1, "a": 2}"#.to_string();
        let result = native_tool_dedup_canonical_json(input);
        assert_eq!(result, r#"{"a":2,"z":1}"#);
    }

    #[test]
    fn test_canonical_json_nested() {
        let input = r#"{"b": {"z": 1, "a": 2}, "a": 1}"#.to_string();
        let result = native_tool_dedup_canonical_json(input);
        assert_eq!(result, r#"{"a":1,"b":{"a":2,"z":1}}"#);
    }

    #[test]
    fn test_args_hash_is_stable() {
        let args = r#"{"a": 1, "z": 2}"#.to_string();
        let canonical = native_tool_dedup_canonical_json(args);
        let hash1 = native_tool_dedup_args_hash(canonical.clone());
        let hash2 = native_tool_dedup_args_hash(canonical);
        assert_eq!(hash1, hash2);
        assert_eq!(hash1.len(), 8);
    }

    #[test]
    fn test_reminder_levels() {
        assert_eq!(native_tool_dedup_reminder_level(0), 0);
        assert_eq!(native_tool_dedup_reminder_level(2), 0);
        assert_eq!(native_tool_dedup_reminder_level(3), 1); // r1
        assert_eq!(native_tool_dedup_reminder_level(4), 1); // r1
        assert_eq!(native_tool_dedup_reminder_level(5), 2); // r2
        assert_eq!(native_tool_dedup_reminder_level(7), 2); // r2
        assert_eq!(native_tool_dedup_reminder_level(8), 3); // r3
        assert_eq!(native_tool_dedup_reminder_level(11), 3); // r3
        assert_eq!(native_tool_dedup_reminder_level(12), 4); // stop
    }

    #[test]
    fn test_check_same_step_dup() {
        let step_keys = r#"[]"#.to_string();
        let key = "read /a.txt".to_string();
        let result = native_tool_dedup_check(step_keys, key, None, 0);

        let parsed: serde_json::Value =
            serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["is_same_step_dup"], false);
        assert_eq!(parsed["step_keys"][0], "read /a.txt");
    }

    #[test]
    fn test_check_same_step_dup_detected() {
        let step_keys = r#"["read /a.txt"]"#.to_string();
        let key = "read /a.txt".to_string();
        let result = native_tool_dedup_check(step_keys, key, None, 0);

        let parsed: serde_json::Value =
            serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["is_same_step_dup"], true);
        // step_keys should still have only one entry
        assert_eq!(parsed["step_keys"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn test_end_step_tracking() {
        let step_keys = r#"["read /a.txt"]"#.to_string();
        let result = native_tool_dedup_end_step(step_keys, None, 0);

        let parsed: serde_json::Value =
            serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["consecutive_key"], "read /a.txt");
        assert_eq!(parsed["consecutive_count"], 1);
    }

    #[test]
    fn test_end_step_consecutive() {
        let step_keys = r#"["read /a.txt"]"#.to_string();
        let result = native_tool_dedup_end_step(
            step_keys,
            Some("read /a.txt".to_string()),
            2,
        );

        let parsed: serde_json::Value =
            serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["consecutive_key"], "read /a.txt");
        assert_eq!(parsed["consecutive_count"], 3);
        assert_eq!(parsed["reminder_level"], 1); // r1 at 3
    }
}