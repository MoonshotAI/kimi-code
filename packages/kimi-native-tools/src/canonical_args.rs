/// Canonical JSON argument serialization for stable tool-call keys.
///
/// Corresponds to `packages/agent-core-v2/src/_base/utils/canonical-args.ts`.
use napi_derive::napi;
use serde_json::Value;

/// Canonical-json serialize `args_json` (a JSON string) by sorting object keys
/// depth-first, then re-serializing. Returns `None` if the input is not valid JSON.
#[napi]
pub fn native_canonical_telemetry_args(args_json: String) -> Option<String> {
    let value: Value = serde_json::from_str(&args_json).ok()?;
    let sorted = sort_json_value(value);
    Some(sorted.to_string())
}

/// Sort a JSON value's object keys depth-first (recursive).
fn sort_json_value(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut sorted = serde_json::Map::with_capacity(map.len());
            let mut keys: Vec<String> = map.keys().cloned().collect();
            keys.sort();
            for key in keys {
                if let Some(v) = map.get(&key) {
                    sorted.insert(key, sort_json_value(v.clone()));
                }
            }
            Value::Object(sorted)
        }
        Value::Array(arr) => Value::Array(arr.into_iter().map(sort_json_value).collect()),
        other => other,
    }
}

/// Check whether a JSON value is a plain object (`{}` with string keys).
/// Returns `None` if the input is not valid JSON.
#[napi]
pub fn native_is_plain_record(json_str: String) -> Option<bool> {
    let value: Value = serde_json::from_str(&json_str).ok()?;
    Some(value.is_object())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_canonical_telemetry_args_sorts_keys() {
        let input = r#"{"z":1,"a":2}"#.to_string();
        let result = native_canonical_telemetry_args(input);
        assert_eq!(result, Some(r#"{"a":2,"z":1}"#.to_string()));
    }

    #[test]
    fn test_canonical_telemetry_args_nested() {
        let input = r#"{"b":{"z":3,"a":1},"a":2}"#.to_string();
        let result = native_canonical_telemetry_args(input);
        assert_eq!(result, Some(r#"{"a":2,"b":{"a":1,"z":3}}"#.to_string()));
    }

    #[test]
    fn test_canonical_telemetry_args_array() {
        let input = r#"[{"z":2,"a":1}]"#.to_string();
        let result = native_canonical_telemetry_args(input);
        assert_eq!(result, Some(r#"[{"a":1,"z":2}]"#.to_string()));
    }

    #[test]
    fn test_canonical_telemetry_args_invalid_json() {
        let input = "not-json".to_string();
        let result = native_canonical_telemetry_args(input);
        assert_eq!(result, None);
    }

    #[test]
    fn test_is_plain_record_object() {
        let result = native_is_plain_record(r#"{"a":1}"#.to_string());
        assert_eq!(result, Some(true));
    }

    #[test]
    fn test_is_plain_record_array() {
        let result = native_is_plain_record(r#"[1,2,3]"#.to_string());
        assert_eq!(result, Some(false));
    }

    #[test]
    fn test_is_plain_record_null() {
        let result = native_is_plain_record(r#"null"#.to_string());
        assert_eq!(result, Some(false));
    }

    #[test]
    fn test_is_plain_record_invalid_json() {
        let result = native_is_plain_record("".to_string());
        assert_eq!(result, None);
    }
}