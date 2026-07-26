/// Activity view — pure helpers for agent activity state comparison.
///
/// Pure comparison function for activity state deduplication.
/// The TS side retains event bus integration and state management.
///
/// Corresponds to `packages/agent-core-v2/src/agent/activityView/activityViewService.ts`.
use napi_derive::napi;

/// Deep-compare two AgentActivityState JSON objects.
/// state_json_a, state_json_b: JSON serializations of AgentActivityState.
/// Returns true if they are deeply equal.
#[napi]
pub fn native_activity_equal(state_json_a: String, state_json_b: String) -> bool {
    let a: serde_json::Value =
        serde_json::from_str(&state_json_a).unwrap_or(serde_json::Value::Null);
    let b: serde_json::Value =
        serde_json::from_str(&state_json_b).unwrap_or(serde_json::Value::Null);

    // lifecycle
    if a.get("lifecycle").and_then(|v| v.as_str()) != b.get("lifecycle").and_then(|v| v.as_str()) {
        return false;
    }

    // turn
    let a_turn = a.get("turn");
    let b_turn = b.get("turn");
    match (a_turn, b_turn) {
        (None, None) => {}
        (Some(_), None) | (None, Some(_)) => return false,
        (Some(at), Some(bt)) => {
            if at.get("turnId") != bt.get("turnId")
                || at.get("phase").and_then(|v| v.as_str()) != bt.get("phase").and_then(|v| v.as_str())
                || at.get("stream").and_then(|v| v.as_str()) != bt.get("stream").and_then(|v| v.as_str())
                || at.get("step") != bt.get("step")
                || at.get("ending").and_then(|v| v.as_bool()) != bt.get("ending").and_then(|v| v.as_bool())
                || at.get("endingReason").and_then(|v| v.as_str()) != bt.get("endingReason").and_then(|v| v.as_str())
            {
                return false;
            }
            // Compare pendingApprovals length
            let a_pa_len = at.get("pendingApprovals").and_then(|a| a.as_array()).map(|a| a.len()).unwrap_or(0);
            let b_pa_len = bt.get("pendingApprovals").and_then(|a| a.as_array()).map(|a| a.len()).unwrap_or(0);
            if a_pa_len != b_pa_len {
                return false;
            }
            // Compare activeToolCalls length
            let a_at_len = at.get("activeToolCalls").and_then(|a| a.as_array()).map(|a| a.len()).unwrap_or(0);
            let b_at_len = bt.get("activeToolCalls").and_then(|a| a.as_array()).map(|a| a.len()).unwrap_or(0);
            if a_at_len != b_at_len {
                return false;
            }
            // Compare retry
            let a_retry = at.get("retry");
            let b_retry = bt.get("retry");
            match (a_retry, b_retry) {
                (None, None) => {}
                (Some(_), None) | (None, Some(_)) => return false,
                (Some(ar), Some(br)) => {
                    if ar.get("nextAttempt") != br.get("nextAttempt") {
                        return false;
                    }
                }
            }
        }
    }

    // lastTurn
    let a_last = a.get("lastTurn");
    let b_last = b.get("lastTurn");
    match (a_last, b_last) {
        (None, None) => {}
        (Some(_), None) | (None, Some(_)) => return false,
        (Some(al), Some(bl)) => {
            if al.get("turnId") != bl.get("turnId")
                || al.get("reason").and_then(|v| v.as_str()) != bl.get("reason").and_then(|v| v.as_str())
            {
                return false;
            }
        }
    }

    // background
    let a_bg = a.get("background").and_then(|a| a.as_array());
    let b_bg = b.get("background").and_then(|a| a.as_array());
    match (a_bg, b_bg) {
        (None, None) => {}
        (Some(_), None) | (None, Some(_)) => return false,
        (Some(ab), Some(bb)) => {
            if ab.len() != bb.len() {
                return false;
            }
            for (i, a_item) in ab.iter().enumerate() {
                if let Some(b_item) = bb.get(i) {
                    if a_item.get("id") != b_item.get("id")
                        || a_item.get("kind").and_then(|v| v.as_str()) != b_item.get("kind").and_then(|v| v.as_str())
                    {
                        return false;
                    }
                }
            }
        }
    }

    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_state(turn_json: Option<serde_json::Value>) -> serde_json::Value {
        serde_json::json!({
            "lifecycle": "ready",
            "turn": turn_json,
            "lastTurn": null,
            "background": [],
        })
    }

    #[test]
    fn test_equal_states() {
        let a = make_state(Some(serde_json::json!({
            "turnId": 1, "phase": "running", "step": 0,
            "ending": false, "pendingApprovals": [], "activeToolCalls": [],
        })));
        let b = make_state(Some(serde_json::json!({
            "turnId": 1, "phase": "running", "step": 0,
            "ending": false, "pendingApprovals": [], "activeToolCalls": [],
        })));
        assert!(native_activity_equal(a.to_string(), b.to_string()));
    }

    #[test]
    fn test_different_phase() {
        let a = make_state(Some(serde_json::json!({
            "turnId": 1, "phase": "running", "step": 0,
            "ending": false, "pendingApprovals": [], "activeToolCalls": [],
        })));
        let b = make_state(Some(serde_json::json!({
            "turnId": 1, "phase": "streaming", "step": 0,
            "ending": false, "pendingApprovals": [], "activeToolCalls": [],
        })));
        assert!(!native_activity_equal(a.to_string(), b.to_string()));
    }

    #[test]
    fn test_equal_no_turn() {
        let a = make_state(None);
        let b = make_state(None);
        assert!(native_activity_equal(a.to_string(), b.to_string()));
    }

    #[test]
    fn test_different_background_count() {
        let mut a = make_state(None);
        a["background"] = serde_json::json!([{"id": "t1", "kind": "bash"}]);
        let b = make_state(None);
        assert!(!native_activity_equal(a.to_string(), b.to_string()));
    }
}