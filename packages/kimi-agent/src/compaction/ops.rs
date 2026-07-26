/// `fullCompaction` wire Ops — the replayable compaction phase.
///
/// Faithful port of
/// `packages/agent-core-v2/src/agent/fullCompaction/compactionOps.ts`.
///
/// The persisted state is deliberately phase-only. Everything richer —
/// the instruction, the abort handle, the in-flight worker — is live-only:
/// none of it can be resumed, and a session never restores mid-compaction. A
/// `Running` phase stranded by a crash is normalised back to `Idle` on restore.
use crate::compaction::strategy::CompactionSource;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CompactionPhase {
    #[default]
    Idle,
    Running,
    /// Declared by the TS union for completeness. No Op produces it — both
    /// `cancel` and `complete` collapse straight to [`CompactionPhase::Idle`].
    Cancelled,
    /// Declared by the TS union for completeness; see [`CompactionPhase::Cancelled`].
    Completed,
}

impl CompactionPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            CompactionPhase::Idle => "idle",
            CompactionPhase::Running => "running",
            CompactionPhase::Cancelled => "cancelled",
            CompactionPhase::Completed => "completed",
        }
    }
}

/// Payload of a `full_compaction.begin` record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactionBeginData {
    pub source: CompactionSource,
    pub instruction: Option<String>,
}

/// Edge events published alongside the Ops.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompactionEvent {
    Started { trigger: CompactionSource, instruction: Option<String> },
    Blocked { turn_id: Option<u64> },
    Cancelled,
    Completed,
}

/// Apply `full_compaction.begin`. Returns `None` when the phase is unchanged,
/// mirroring the TS reducers' same-reference-on-no-op contract.
pub fn apply_begin(phase: CompactionPhase) -> Option<CompactionPhase> {
    (phase != CompactionPhase::Running).then_some(CompactionPhase::Running)
}

/// The edge event derived from a `begin` record.
pub fn begin_event(data: &CompactionBeginData) -> CompactionEvent {
    CompactionEvent::Started {
        trigger: data.source,
        instruction: data.instruction.clone(),
    }
}

/// Apply `full_compaction.cancel`.
pub fn apply_cancel(phase: CompactionPhase) -> Option<CompactionPhase> {
    (phase != CompactionPhase::Idle).then_some(CompactionPhase::Idle)
}

/// Apply `full_compaction.complete`.
///
/// The live payload is empty to match the v1 wire shape; legacy records may
/// still carry result numbers, which are accepted and ignored.
pub fn apply_complete(phase: CompactionPhase) -> Option<CompactionPhase> {
    (phase != CompactionPhase::Idle).then_some(CompactionPhase::Idle)
}

/// Normalise a phase restored from the journal.
///
/// A crash mid-compaction leaves `Running` persisted with no worker behind it;
/// leaving it would block every future compaction.
pub fn normalise_restored_phase(phase: CompactionPhase) -> CompactionPhase {
    match phase {
        CompactionPhase::Running => CompactionPhase::Idle,
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_initial_phase_is_idle() {
        assert_eq!(CompactionPhase::default(), CompactionPhase::Idle);
    }

    #[test]
    fn begin_moves_idle_to_running() {
        assert_eq!(apply_begin(CompactionPhase::Idle), Some(CompactionPhase::Running));
    }

    #[test]
    fn begin_on_a_running_compaction_is_a_no_op() {
        assert_eq!(apply_begin(CompactionPhase::Running), None);
    }

    #[test]
    fn cancel_and_complete_both_collapse_to_idle() {
        assert_eq!(apply_cancel(CompactionPhase::Running), Some(CompactionPhase::Idle));
        assert_eq!(apply_complete(CompactionPhase::Running), Some(CompactionPhase::Idle));
    }

    #[test]
    fn cancel_and_complete_on_idle_are_no_ops() {
        assert_eq!(apply_cancel(CompactionPhase::Idle), None);
        assert_eq!(apply_complete(CompactionPhase::Idle), None);
    }

    #[test]
    fn a_stranded_running_phase_is_reset_on_restore() {
        assert_eq!(normalise_restored_phase(CompactionPhase::Running), CompactionPhase::Idle);
        assert_eq!(normalise_restored_phase(CompactionPhase::Idle), CompactionPhase::Idle);
    }

    #[test]
    fn begin_derives_a_started_event_carrying_the_trigger() {
        let data = CompactionBeginData {
            source: CompactionSource::Manual,
            instruction: Some("focus on the bug".to_string()),
        };
        assert_eq!(
            begin_event(&data),
            CompactionEvent::Started {
                trigger: CompactionSource::Manual,
                instruction: Some("focus on the bug".to_string()),
            }
        );
    }

    #[test]
    fn phase_labels_match_the_wire_spelling() {
        assert_eq!(CompactionPhase::Idle.as_str(), "idle");
        assert_eq!(CompactionPhase::Running.as_str(), "running");
        assert_eq!(CompactionPhase::Cancelled.as_str(), "cancelled");
        assert_eq!(CompactionPhase::Completed.as_str(), "completed");
    }
}
