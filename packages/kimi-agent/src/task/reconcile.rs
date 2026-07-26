/// `task` domain — listing and restore reconciliation rules.
///
/// Ports `shouldListTask`, `newerRestoredTask`, and `markLoadedTasksLost` from
/// `packages/agent-core-v2/src/agent/task/taskService.ts`.
///
/// On resume the service holds two overlapping views of the past: the wire
/// replay's `TaskModel` and the on-disk persistence registry. Neither is
/// authoritative on its own — replay knows what the journal recorded, disk
/// knows what the last writer flushed — so they are merged, and whatever is
/// still marked running after the merge is declared lost, because nothing is
/// actually executing it any more.
use crate::task::types::{TaskInfoBase, TaskStatus};

/// Whether a task belongs in a `list()` result.
///
/// A live task always lists. A settled one lists only in the full listing, and
/// only if it ran detached — a foreground task's result already went back to
/// its caller inline, so re-surfacing it would be noise.
pub fn should_list_task(info: &TaskInfoBase, active_only: bool) -> bool {
    if !info.status.is_terminal() {
        return true;
    }
    if active_only {
        return false;
    }
    info.detached
}

/// Pick the more advanced of two records for the same task id.
///
/// Terminal beats non-terminal; between two terminal records the later
/// `ended_at` wins; ties and missing timestamps fall back to the freshly
/// loaded record.
pub fn newer_restored_task(existing: TaskInfoBase, loaded: TaskInfoBase) -> TaskInfoBase {
    let existing_terminal = existing.status.is_terminal();
    let loaded_terminal = loaded.status.is_terminal();
    if existing_terminal && !loaded_terminal {
        return existing;
    }
    if !existing_terminal && loaded_terminal {
        return loaded;
    }
    match (existing.ended_at, loaded.ended_at) {
        (Some(existing_ended), Some(loaded_ended)) => {
            if loaded_ended >= existing_ended {
                loaded
            } else {
                existing
            }
        }
        (Some(_), None) => existing,
        _ => loaded,
    }
}

/// Mark a restored record lost if it is still claiming to run.
///
/// Returns the updated record, or `None` when the record was already terminal
/// and needs no rewrite.
pub fn mark_lost(info: &TaskInfoBase, now_ms: u64) -> Option<TaskInfoBase> {
    if info.status.is_terminal() {
        return None;
    }
    let mut updated = info.clone();
    updated.status = TaskStatus::Lost;
    updated.ended_at = Some(info.ended_at.unwrap_or(now_ms));
    Some(updated)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(status: TaskStatus, detached: bool, ended_at: Option<u64>) -> TaskInfoBase {
        TaskInfoBase {
            task_id: "t1".to_string(),
            description: "d".to_string(),
            status,
            kind: "process".to_string(),
            started_at: 1_000,
            ended_at,
            detached,
            stop_reason: None,
            terminal_notification_suppressed: false,
            timeout_ms: None,
            agent_id: None,
        }
    }

    // ── should_list_task ──────────────────────────────────────────────────

    #[test]
    fn a_running_task_always_lists() {
        let running = info(TaskStatus::Running, false, None);
        assert!(should_list_task(&running, true));
        assert!(should_list_task(&running, false));
    }

    #[test]
    fn a_settled_task_never_lists_in_the_active_listing() {
        let done = info(TaskStatus::Completed, true, Some(2_000));
        assert!(!should_list_task(&done, true));
    }

    #[test]
    fn a_settled_detached_task_lists_in_the_full_listing() {
        let done = info(TaskStatus::Completed, true, Some(2_000));
        assert!(should_list_task(&done, false));
    }

    #[test]
    fn a_settled_foreground_task_is_hidden_even_from_the_full_listing() {
        // Its result already went back to the caller inline.
        let done = info(TaskStatus::Completed, false, Some(2_000));
        assert!(!should_list_task(&done, false));
    }

    // ── newer_restored_task ───────────────────────────────────────────────

    #[test]
    fn terminal_beats_running() {
        let running = info(TaskStatus::Running, true, None);
        let done = info(TaskStatus::Completed, true, Some(2_000));
        assert_eq!(newer_restored_task(running.clone(), done.clone()).status, TaskStatus::Completed);
        assert_eq!(newer_restored_task(done, running).status, TaskStatus::Completed);
    }

    #[test]
    fn between_two_terminal_records_the_later_end_wins() {
        let early = info(TaskStatus::Completed, true, Some(2_000));
        let late = info(TaskStatus::Failed, true, Some(3_000));
        assert_eq!(newer_restored_task(early.clone(), late.clone()).status, TaskStatus::Failed);
        assert_eq!(newer_restored_task(late, early).status, TaskStatus::Failed);
    }

    #[test]
    fn an_equal_end_prefers_the_freshly_loaded_record() {
        let existing = info(TaskStatus::Completed, true, Some(2_000));
        let loaded = info(TaskStatus::Failed, true, Some(2_000));
        assert_eq!(newer_restored_task(existing, loaded).status, TaskStatus::Failed);
    }

    #[test]
    fn a_record_with_a_timestamp_beats_one_without() {
        let stamped = info(TaskStatus::Completed, true, Some(2_000));
        let unstamped = info(TaskStatus::Failed, true, None);
        assert_eq!(
            newer_restored_task(stamped.clone(), unstamped.clone()).status,
            TaskStatus::Completed
        );
        assert_eq!(newer_restored_task(unstamped, stamped).status, TaskStatus::Completed);
    }

    #[test]
    fn two_unstamped_records_fall_back_to_the_loaded_one() {
        let existing = info(TaskStatus::Running, true, None);
        let loaded = info(TaskStatus::Running, false, None);
        assert!(!newer_restored_task(existing, loaded).detached);
    }

    // ── mark_lost ─────────────────────────────────────────────────────────

    #[test]
    fn a_running_record_becomes_lost() {
        let running = info(TaskStatus::Running, true, None);
        let lost = mark_lost(&running, 5_000).expect("rewritten");
        assert_eq!(lost.status, TaskStatus::Lost);
        assert_eq!(lost.ended_at, Some(5_000));
    }

    #[test]
    fn mark_lost_keeps_an_existing_end_timestamp() {
        let mut running = info(TaskStatus::Running, true, Some(2_500));
        running.status = TaskStatus::Running;
        let lost = mark_lost(&running, 9_999).expect("rewritten");
        assert_eq!(lost.ended_at, Some(2_500));
    }

    #[test]
    fn a_terminal_record_is_left_alone() {
        let done = info(TaskStatus::Completed, true, Some(2_000));
        assert!(mark_lost(&done, 5_000).is_none());
    }
}
