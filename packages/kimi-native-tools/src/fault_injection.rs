/// Fault injection — one-shot latch for v2 migration.
///
/// Pure state machine: arm → take → fired. The TS side retains
/// DI registration, flag gating, and error throwing.
///
/// Corresponds to `packages/agent-core-v2/src/agent/faultInjection/`.
use napi_derive::napi;

/// Arm a one-shot fault.
/// Returns JSON: { armed: string | null, fired: string[] }
#[napi]
pub fn native_fault_injection_arm(
    state_json: String,
    kind: String,
) -> String {
    let mut state: serde_json::Value =
        serde_json::from_str(&state_json).unwrap_or(serde_json::json!({
            "armed": null,
            "fired": []
        }));

    state["armed"] = serde_json::Value::String(kind);
    serde_json::to_string(&state).unwrap_or_default()
}

/// Take the armed fault (consume it and record as fired).
/// Returns JSON: { armed: null, fired: string[], taken: string | null }
#[napi]
pub fn native_fault_injection_take(
    state_json: String,
) -> String {
    let mut state: serde_json::Value =
        serde_json::from_str(&state_json).unwrap_or(serde_json::json!({
            "armed": null,
            "fired": []
        }));

    let taken = state["armed"].take();
    if !taken.is_null() {
        if let Some(fired) = state["fired"].as_array_mut() {
            fired.push(taken.clone());
        }
    }

    let result = serde_json::json!({
        "armed": null,
        "fired": state["fired"],
        "taken": taken,
    });

    serde_json::to_string(&result).unwrap_or_default()
}

/// Clear the state.
/// Returns JSON: { armed: null, fired: [] }
#[napi]
pub fn native_fault_injection_clear() -> String {
    serde_json::json!({
        "armed": null,
        "fired": []
    }).to_string()
}

/// Get status snapshot.
/// Returns JSON: { armed: string | null, fired: string[] }
#[napi]
pub fn native_fault_injection_status(state_json: String) -> String {
    let state: serde_json::Value =
        serde_json::from_str(&state_json).unwrap_or(serde_json::json!({
            "armed": null,
            "fired": []
        }));
    serde_json::to_string(&state).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_state() -> String {
        r#"{"armed": null, "fired": []}"#.to_string()
    }

    #[test]
    fn test_arm_and_take() {
        let state = native_fault_injection_arm(empty_state(), "request-too-large".to_string());
        let result = native_fault_injection_take(state);
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["taken"], "request-too-large");
        assert!(parsed["armed"].is_null());
        assert_eq!(parsed["fired"][0], "request-too-large");
    }

    #[test]
    fn test_take_none() {
        let result = native_fault_injection_take(empty_state());
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert!(parsed["taken"].is_null());
    }

    #[test]
    fn test_clear() {
        let state = native_fault_injection_arm(empty_state(), "image-format".to_string());
        let cleared = native_fault_injection_clear();
        let parsed: serde_json::Value = serde_json::from_str(&cleared).unwrap();
        assert!(parsed["armed"].is_null());
        assert!(parsed["fired"].as_array().unwrap().is_empty());
    }

    #[test]
    fn test_status() {
        let state = native_fault_injection_arm(empty_state(), "image-format".to_string());
        let status = native_fault_injection_status(state);
        let parsed: serde_json::Value = serde_json::from_str(&status).unwrap();
        assert_eq!(parsed["armed"], "image-format");
    }
}