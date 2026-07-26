/// `plan` wire Ops — the replayable plan-mode state.
///
/// Faithful port of `packages/agent-core-v2/src/agent/plan/planOps.ts`.
///
/// The persisted state is `{ active, id, revision_count }`. The plan file path
/// is NOT persisted — it derives from the id at read time. Plan content is
/// recorded separately: every ExitPlanMode submit snapshots the plan file into
/// blob storage and persists a `plan.revision` record carrying only the
/// reference, never the content. `revision_count` tracks the latest version
/// per plan id so the next revision can be minted replay-consistently; it is
/// kept across enter/exit so a re-entered plan id continues its counter
/// instead of overwriting earlier blobs.
use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// The replayable plan state (TS `PlanState`).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct PlanState {
    pub active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Latest recorded revision version per plan id.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub revision_count: HashMap<String, u64>,
}

/// A `plan.revision` record: the reference-only snapshot of a submitted plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanRevision {
    pub id: String,
    pub version: u64,
    /// Blob path, homeDir-relative.
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
}

/// Apply `plan_mode.enter`. Returns `None` on a no-op (re-entering the same
/// plan), preserving the wire's same-reference-on-no-op contract.
pub fn apply_enter(state: &PlanState, id: &str) -> Option<PlanState> {
    if state.active && state.id.as_deref() == Some(id) {
        return None;
    }
    Some(PlanState {
        active: true,
        id: Some(id.to_string()),
        revision_count: state.revision_count.clone(),
    })
}

/// Apply `plan_mode.cancel`. Returns `None` when already inactive.
///
/// Note the id is dropped entirely — TS rebuilds the state as
/// `{ active: false, revisionCount }`, so a cancelled plan does not remember
/// which plan it was.
pub fn apply_cancel(state: &PlanState) -> Option<PlanState> {
    if !state.active {
        return None;
    }
    Some(PlanState { active: false, id: None, revision_count: state.revision_count.clone() })
}

/// Apply `plan_mode.exit`. Identical reduction to cancel; the two are distinct
/// records because they carry different intent for consumers.
pub fn apply_exit(state: &PlanState) -> Option<PlanState> {
    apply_cancel(state)
}

/// Apply `plan.revision`: adopt the recorded version as the plan's latest.
/// Never a no-op in TS (`apply` always rebuilds), so this always returns a
/// new state.
pub fn apply_revision(state: &PlanState, revision: &PlanRevision) -> PlanState {
    let mut next = state.clone();
    next.revision_count.insert(revision.id.clone(), revision.version);
    next
}

/// The version the next `plan.revision` for `id` should carry.
pub fn next_revision_version(state: &PlanState, id: &str) -> u64 {
    state.revision_count.get(id).copied().unwrap_or(0) + 1
}

#[cfg(test)]
mod tests {
    use super::*;

    fn revision(id: &str, version: u64) -> PlanRevision {
        PlanRevision {
            id: id.to_string(),
            version,
            path: format!(".kimi/blobs/plan-{id}-v{version}.md"),
            sha256: "abc".to_string(),
            bytes: 128,
        }
    }

    #[test]
    fn the_initial_state_is_inactive() {
        let state = PlanState::default();
        assert!(!state.active);
        assert_eq!(state.id, None);
        assert!(state.revision_count.is_empty());
    }

    #[test]
    fn enter_activates_with_the_plan_id() {
        let next = apply_enter(&PlanState::default(), "plan-1").expect("changes");
        assert!(next.active);
        assert_eq!(next.id.as_deref(), Some("plan-1"));
    }

    #[test]
    fn re_entering_the_same_plan_is_a_no_op() {
        let state = apply_enter(&PlanState::default(), "plan-1").unwrap();
        assert_eq!(apply_enter(&state, "plan-1"), None);
    }

    #[test]
    fn entering_a_different_plan_switches_ids() {
        let state = apply_enter(&PlanState::default(), "plan-1").unwrap();
        let next = apply_enter(&state, "plan-2").expect("changes");
        assert_eq!(next.id.as_deref(), Some("plan-2"));
    }

    #[test]
    fn cancel_and_exit_deactivate_and_forget_the_id() {
        let state = apply_enter(&PlanState::default(), "plan-1").unwrap();
        let cancelled = apply_cancel(&state).expect("changes");
        assert!(!cancelled.active);
        assert_eq!(cancelled.id, None, "a cancelled plan does not remember which plan it was");
        let exited = apply_exit(&state).expect("changes");
        assert_eq!(cancelled, exited, "cancel and exit reduce identically");
    }

    #[test]
    fn cancel_when_inactive_is_a_no_op() {
        assert_eq!(apply_cancel(&PlanState::default()), None);
        assert_eq!(apply_exit(&PlanState::default()), None);
    }

    #[test]
    fn revisions_advance_the_per_plan_counter() {
        let state = apply_enter(&PlanState::default(), "plan-1").unwrap();
        assert_eq!(next_revision_version(&state, "plan-1"), 1);
        let state = apply_revision(&state, &revision("plan-1", 1));
        assert_eq!(next_revision_version(&state, "plan-1"), 2);
        let state = apply_revision(&state, &revision("plan-1", 2));
        assert_eq!(state.revision_count.get("plan-1"), Some(&2));
        // Another plan id counts independently.
        assert_eq!(next_revision_version(&state, "plan-2"), 1);
    }

    #[test]
    fn the_revision_counter_survives_exit_and_re_entry() {
        // Re-entering a plan id must continue its counter instead of
        // overwriting earlier blobs.
        let state = apply_enter(&PlanState::default(), "plan-1").unwrap();
        let state = apply_revision(&state, &revision("plan-1", 1));
        let state = apply_exit(&state).unwrap();
        assert_eq!(state.revision_count.get("plan-1"), Some(&1));
        let state = apply_enter(&state, "plan-1").unwrap();
        assert_eq!(next_revision_version(&state, "plan-1"), 2);
    }

    #[test]
    fn a_replayed_revision_adopts_the_recorded_version_verbatim() {
        // Replay may see versions out of order; the record wins.
        let state = apply_revision(&PlanState::default(), &revision("plan-1", 7));
        assert_eq!(state.revision_count.get("plan-1"), Some(&7));
        assert_eq!(next_revision_version(&state, "plan-1"), 8);
    }
}
