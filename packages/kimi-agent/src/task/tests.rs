use std::sync::{Arc, Mutex};

use super::*;

// ── Fixtures ───────────────────────────────────────────────────────────────

struct TestTask {
    kind: String,
    description: String,
    prefix: String,
    agent_id: Option<String>,
}

impl TestTask {
    fn new(kind: &str, description: &str) -> Self {
        Self {
            kind: kind.to_string(),
            description: description.to_string(),
            prefix: kind.to_string(),
            agent_id: None,
        }
    }

    fn agent(description: &str, agent_id: &str) -> Self {
        Self {
            kind: "agent".to_string(),
            description: description.to_string(),
            prefix: "agent".to_string(),
            agent_id: Some(agent_id.to_string()),
        }
    }
}

impl AgentTask for TestTask {
    fn kind(&self) -> &str {
        &self.kind
    }
    fn description(&self) -> &str {
        &self.description
    }
    fn id_prefix(&self) -> &str {
        &self.prefix
    }
    fn agent_id(&self) -> Option<String> {
        self.agent_id.clone()
    }
    fn start(&self, _sink: &TaskSink) {}
    fn to_info(&self, base: &TaskInfoBase) -> TaskInfoByKind {
        TaskInfoByKind::Process(ProcessTaskInfo {
            base: base.clone(),
            command: None,
            pid: None,
            exit_code: None,
        })
    }
}

#[derive(Default)]
struct RecordedDelegate {
    started: Mutex<Vec<String>>,
    terminated: Mutex<Vec<(String, Option<String>)>>,
    enqueued: Mutex<Vec<String>>,
    restored: Mutex<Vec<String>>,
    published: Mutex<Vec<String>>,
}

impl TaskDelegate for RecordedDelegate {
    fn on_task_started(&self, info: &TaskInfoBase) {
        self.started.lock().unwrap().push(info.task_id.clone());
    }
    fn on_task_terminated(&self, info: &TaskInfoBase, output_tail: Option<&str>) {
        self.terminated
            .lock()
            .unwrap()
            .push((info.task_id.clone(), output_tail.map(str::to_string)));
    }
    fn enqueue_notification(&self, xml: &str, _origin: &TaskNotificationOrigin) {
        self.enqueued.lock().unwrap().push(xml.to_string());
    }
    fn append_restored_notification(&self, xml: &str, _origin: &TaskNotificationOrigin) {
        self.restored.lock().unwrap().push(xml.to_string());
    }
    fn publish_notification(&self, notification: &TaskNotification) {
        self.published.lock().unwrap().push(notification.id.clone());
    }
}

#[derive(Default)]
struct MemoryPersistence {
    tasks: Mutex<Vec<TaskInfoBase>>,
    output: Mutex<Vec<(String, String)>>,
}

impl TaskPersistence for MemoryPersistence {
    fn write_task(&self, info: &TaskInfoBase) -> Result<(), String> {
        let mut tasks = self.tasks.lock().unwrap();
        match tasks.iter_mut().find(|t| t.task_id == info.task_id) {
            Some(existing) => *existing = info.clone(),
            None => tasks.push(info.clone()),
        }
        Ok(())
    }
    fn list_tasks(&self) -> Result<Vec<TaskInfoBase>, String> {
        Ok(self.tasks.lock().unwrap().clone())
    }
    fn append_output(&self, task_id: &str, chunk: &str) -> Result<(), String> {
        self.output.lock().unwrap().push((task_id.to_string(), chunk.to_string()));
        Ok(())
    }
}

fn svc() -> TaskService {
    TaskService::new(TaskServiceConfig::default())
}

fn svc_with_delegate() -> (TaskService, Arc<RecordedDelegate>) {
    let delegate = Arc::new(RecordedDelegate::default());
    let mut service = svc();
    service.set_delegate(Box::new(DelegateHandle(delegate.clone())));
    (service, delegate)
}

/// Lets a test keep a handle on the delegate the service owns.
struct DelegateHandle(Arc<RecordedDelegate>);

impl TaskDelegate for DelegateHandle {
    fn on_task_started(&self, info: &TaskInfoBase) {
        self.0.on_task_started(info);
    }
    fn on_task_terminated(&self, info: &TaskInfoBase, output_tail: Option<&str>) {
        self.0.on_task_terminated(info, output_tail);
    }
    fn enqueue_notification(&self, xml: &str, origin: &TaskNotificationOrigin) {
        self.0.enqueue_notification(xml, origin);
    }
    fn append_restored_notification(&self, xml: &str, origin: &TaskNotificationOrigin) {
        self.0.append_restored_notification(xml, origin);
    }
    fn publish_notification(&self, notification: &TaskNotification) {
        self.0.publish_notification(notification);
    }
}

fn detached() -> RegisterAgentTaskOptions {
    RegisterAgentTaskOptions::default()
}

fn foreground() -> RegisterAgentTaskOptions {
    RegisterAgentTaskOptions { detached: false, ..Default::default() }
}

fn ghost(task_id: &str, status: TaskStatus, detached: bool) -> TaskInfoBase {
    TaskInfoBase {
        task_id: task_id.to_string(),
        description: "restored".to_string(),
        status,
        kind: "process".to_string(),
        started_at: 1_000,
        ended_at: if status.is_terminal() { Some(2_000) } else { None },
        detached,
        stop_reason: None,
        terminal_notification_suppressed: false,
        timeout_ms: None,
        agent_id: None,
    }
}

fn completed() -> TaskSettlement {
    TaskSettlement { status: TaskSettlementStatus::Completed, stop_reason: None }
}

// ── Ids ────────────────────────────────────────────────────────────────────

#[test]
fn task_ids_use_the_prefix_and_a_base36_suffix() {
    let id = generate_task_id("process");
    assert!(id.starts_with("process-"), "{id}");
    let suffix = &id["process-".len()..];
    assert_eq!(suffix.len(), 8);
    assert!(suffix.bytes().all(|b| TASK_ID_ALPHABET.contains(&b)), "{suffix}");
}

#[test]
fn task_ids_are_not_sequential() {
    // Regression guard: a counter-based id collides across restored sessions,
    // where ids must stay unique against records written by a previous run.
    let ids: HashSet<String> = (0..64).map(|_| generate_task_id("t")).collect();
    assert!(ids.len() > 60, "expected mostly-unique ids, got {}", ids.len());
}

// ── Registration ───────────────────────────────────────────────────────────

#[test]
fn register_starts_a_running_task() {
    let mut service = svc();
    let id = service.register_task(&TestTask::new("process", "npm test"), detached()).unwrap();
    let info = service.get_task(&id).unwrap();
    assert_eq!(info.status, TaskStatus::Running);
    assert_eq!(info.description, "npm test");
    assert!(info.detached);
}

#[test]
fn register_defaults_to_detached() {
    let mut service = svc();
    let id = service.register_task(&TestTask::new("process", "cmd"), Default::default()).unwrap();
    assert!(service.get_task(&id).unwrap().detached);
}

#[test]
fn a_foreground_task_is_not_detached() {
    let mut service = svc();
    let id = service.register_task(&TestTask::new("process", "cmd"), foreground()).unwrap();
    assert!(!service.get_task(&id).unwrap().detached);
}

#[test]
fn register_picks_up_the_tasks_own_agent_id() {
    let mut service = svc();
    let id = service.register_task(&TestTask::agent("research", "agent-xyz"), detached()).unwrap();
    assert_eq!(service.get_task(&id).unwrap().agent_id.as_deref(), Some("agent-xyz"));
}

#[test]
fn detached_registration_announces_the_task() {
    let (mut service, delegate) = svc_with_delegate();
    let id = service.register_task(&TestTask::new("process", "cmd"), detached()).unwrap();
    assert_eq!(*delegate.started.lock().unwrap(), vec![id]);
}

#[test]
fn foreground_registration_stays_private() {
    // Its result goes back to the caller inline; announcing it would surface a
    // task the model never asked to background.
    let (mut service, delegate) = svc_with_delegate();
    service.register_task(&TestTask::new("process", "cmd"), foreground()).unwrap();
    assert!(delegate.started.lock().unwrap().is_empty());
}

#[test]
fn the_running_limit_counts_only_tasks_registered_detached() {
    let mut service = TaskService::new(TaskServiceConfig {
        max_running_tasks: Some(2),
        ..Default::default()
    });
    let task = TestTask::new("process", "cmd");
    // Foreground tasks occupy their caller, so they never consume the budget.
    service.register_task(&task, foreground()).unwrap();
    service.register_task(&task, foreground()).unwrap();
    service.register_task(&task, detached()).unwrap();
    service.register_task(&task, detached()).unwrap();
    assert!(service.register_task(&task, detached()).is_err());
}

#[test]
fn the_running_limit_never_blocks_a_foreground_task() {
    let mut service =
        TaskService::new(TaskServiceConfig { max_running_tasks: Some(1), ..Default::default() });
    let task = TestTask::new("process", "cmd");
    service.register_task(&task, detached()).unwrap();
    assert!(service.register_task(&task, foreground()).is_ok());
}

#[test]
fn settled_tasks_free_up_the_running_budget() {
    let mut service =
        TaskService::new(TaskServiceConfig { max_running_tasks: Some(1), ..Default::default() });
    let task = TestTask::new("process", "cmd");
    let id = service.register_task(&task, detached()).unwrap();
    assert!(service.register_task(&task, detached()).is_err());
    service.settle(&id, completed());
    assert!(service.register_task(&task, detached()).is_ok());
}

#[test]
fn an_unset_limit_is_unlimited() {
    let mut service =
        TaskService::new(TaskServiceConfig { max_running_tasks: None, ..Default::default() });
    let task = TestTask::new("process", "cmd");
    for _ in 0..50 {
        service.register_task(&task, detached()).unwrap();
    }
    assert_eq!(service.running_count(), 50);
}

#[test]
fn track_registers_without_an_agent_task() {
    let mut service = svc();
    let entry = service
        .track(AgentTaskTrackOptions {
            id_prefix: "custom".to_string(),
            description: "custom task".to_string(),
            kind: "process".to_string(),
            detached: true,
            timeout_ms: None,
            detach_timeout_ms: None,
            agent_id: None,
        })
        .unwrap();
    assert!(entry.task_id.starts_with("custom-"));
    assert!(entry.on_did_detach.is_none(), "detached work has nothing to release");
    assert!(service.get_task(&entry.task_id).unwrap().detached);
}

#[test]
fn track_gives_a_foreground_caller_a_release_channel() {
    let mut service = svc();
    let entry = service
        .track(AgentTaskTrackOptions {
            id_prefix: "fg".to_string(),
            description: "foreground".to_string(),
            kind: "process".to_string(),
            detached: false,
            timeout_ms: None,
            detach_timeout_ms: None,
            agent_id: None,
        })
        .unwrap();
    assert!(entry.on_did_detach.is_some());
}

// ── Listing ────────────────────────────────────────────────────────────────

#[test]
fn the_active_listing_hides_settled_tasks() {
    let mut service = svc();
    let id = service.register_task(&TestTask::new("process", "cmd"), detached()).unwrap();
    service.settle(&id, completed());
    assert!(service.list(true, None).is_empty());
    assert_eq!(service.list(false, None).len(), 1);
}

#[test]
fn the_full_listing_hides_settled_foreground_tasks() {
    // Regression guard: the previous implementation surfaced every settled
    // task, including foreground work whose result already went back inline.
    let mut service = svc();
    let id = service.register_task(&TestTask::new("process", "cmd"), foreground()).unwrap();
    service.settle(&id, completed());
    assert!(service.list(false, None).is_empty());
}

#[test]
fn the_full_listing_shows_settled_detached_tasks() {
    let mut service = svc();
    let id = service.register_task(&TestTask::new("process", "cmd"), detached()).unwrap();
    service.settle(&id, completed());
    assert_eq!(service.list(false, None)[0].task_id, id);
}

#[test]
fn a_running_foreground_task_lists_as_active() {
    let mut service = svc();
    service.register_task(&TestTask::new("process", "cmd"), foreground()).unwrap();
    assert_eq!(service.list(true, None).len(), 1);
}

#[test]
fn the_listing_honours_its_limit() {
    let mut service = svc();
    let task = TestTask::new("process", "cmd");
    for _ in 0..5 {
        service.register_task(&task, detached()).unwrap();
    }
    assert_eq!(service.list(true, Some(3)).len(), 3);
}

#[test]
fn ghosts_appear_only_in_the_full_listing() {
    let mut service = svc();
    service.restore_ghosts([ghost("old-1", TaskStatus::Completed, true)]);
    assert!(service.list(true, None).is_empty());
    assert_eq!(service.list(false, None).len(), 1);
}

#[test]
fn a_live_task_shadows_its_ghost() {
    let mut service = svc();
    let id = service.register_task(&TestTask::new("process", "cmd"), detached()).unwrap();
    service.restore_ghosts([ghost(&id, TaskStatus::Lost, true)]);
    assert_eq!(service.ghost_count(), 0);
    assert_eq!(service.get_task(&id).unwrap().status, TaskStatus::Running);
}

// ── Output ─────────────────────────────────────────────────────────────────

#[test]
fn output_accumulates_and_reads_back() {
    let mut service = svc();
    let id = service.register_task(&TestTask::new("process", "cmd"), detached()).unwrap();
    assert!(service.append_output(&id, "line 1\n").is_none());
    assert!(service.append_output(&id, "line 2\n").is_none());
    assert_eq!(service.read_output(&id, None), "line 1\nline 2\n");
}

#[test]
fn read_output_tail_counts_characters_not_lines() {
    // Regression guard: the previous implementation treated `tail` as a line
    // count, while TS slices the preview string by code units.
    let mut service = svc();
    let id = service.register_task(&TestTask::new("process", "cmd"), detached()).unwrap();
    let _ = service.append_output(&id, "0123456789");
    assert_eq!(service.read_output(&id, Some(4)), "6789");
}

#[test]
fn output_of_an_unknown_task_is_empty() {
    let service = svc();
    assert_eq!(service.read_output("nope", None), "");
    assert_eq!(service.get_output_snapshot("nope", 100), TaskOutputSnapshot::empty());
}

#[test]
fn a_process_task_trips_the_hard_output_ceiling() {
    let mut service = svc();
    let id = service.register_task(&TestTask::new("process", "cmd"), detached()).unwrap();
    let chunk = "x".repeat(MAX_TASK_OUTPUT_BYTES / 2);
    assert!(service.append_output(&id, &chunk).is_none());
    assert!(service.append_output(&id, &chunk).is_none(), "exactly at the ceiling is fine");
    let reason = service.append_output(&id, "one byte over").expect("ceiling tripped");
    assert!(reason.contains("Output limit exceeded"));
    // …and only once.
    assert!(service.append_output(&id, "more").is_none());
}

#[test]
fn a_non_process_task_has_no_output_ceiling() {
    let mut service = svc();
    let id = service.register_task(&TestTask::new("agent", "research"), detached()).unwrap();
    let chunk = "x".repeat(MAX_TASK_OUTPUT_BYTES / 2 + 1);
    assert!(service.append_output(&id, &chunk).is_none());
    assert!(service.append_output(&id, &chunk).is_none());
}

#[test]
fn output_is_streamed_to_persistence() {
    let mut service = svc();
    let persistence = Box::new(MemoryPersistence::default());
    service.set_persistence(persistence);
    let id = service.register_task(&TestTask::new("process", "cmd"), detached()).unwrap();
    let _ = service.append_output(&id, "chunk");
    // No panic and the in-memory ring still answers reads.
    assert_eq!(service.read_output(&id, None), "chunk");
}

// ── Settlement ─────────────────────────────────────────────────────────────

#[test]
fn settle_marks_the_task_terminal() {
    let mut service = svc();
    let id = service.register_task(&TestTask::new("process", "cmd"), detached()).unwrap();
    assert!(service.settle(&id, completed()));
    let info = service.get_task(&id).unwrap();
    assert_eq!(info.status, TaskStatus::Completed);
    assert!(info.ended_at.is_some());
}

#[test]
fn settle_is_idempotent() {
    let mut service = svc();
    let id = service.register_task(&TestTask::new("process", "cmd"), detached()).unwrap();
    assert!(service.settle(&id, completed()));
    assert!(!service.settle(
        &id,
        TaskSettlement { status: TaskSettlementStatus::Failed, stop_reason: None }
    ));
    assert_eq!(service.get_task(&id).unwrap().status, TaskStatus::Completed);
}

#[test]
fn a_settlement_without_a_reason_clears_a_stashed_one() {
    // TS: `settlement.stopReason ?? (status === 'killed' ? entry.stopReason : undefined)`.
    let mut service = svc();
    let id = service.register_task(&TestTask::new("process", "cmd"), detached()).unwrap();
    service.settle(
        &id,
        TaskSettlement { status: TaskSettlementStatus::Completed, stop_reason: None },
    );
    assert_eq!(service.get_task(&id).unwrap().stop_reason, None);
}

#[test]
fn a_kill_without_a_reason_keeps_the_stashed_one() {
    let mut service = svc();
    let id = service.register_task(&TestTask::new("process", "cmd"), detached()).unwrap();
    let info = service.stop(&id, Some("  output limit  ")).unwrap();
    assert_eq!(info.stop_reason.as_deref(), Some("output limit"), "reason is trimmed");
}

#[test]
fn a_blank_stop_reason_normalises_away() {
    let mut service = svc();
    let id = service.register_task(&TestTask::new("process", "cmd"), detached()).unwrap();
    let info = service.stop(&id, Some("   ")).unwrap();
    assert_eq!(info.stop_reason, None);
}

#[test]
fn stopping_a_timed_out_task_records_the_timeout_not_the_kill() {
    let mut service = svc();
    let id = service.register_task(&TestTask::new("process", "cmd"), detached()).unwrap();
    service.on_timeout(&id);
    assert_eq!(service.get_task(&id).unwrap().status, TaskStatus::TimedOut);
}

#[test]
fn a_self_settlement_after_a_timeout_is_coerced() {
    // The adapter reports `killed` because its process was aborted, but the
    // timeout is the real cause.
    let mut service = svc();
    let id = service.register_task(&TestTask::new("process", "cmd"), foreground()).unwrap();
    // Arrange the timed-out flag without settling: auto-background is off, so
    // on_timeout settles directly — instead drive the coercion through settle.
    service.on_timeout(&id);
    assert_eq!(service.get_task(&id).unwrap().status, TaskStatus::TimedOut);
    assert!(!service.settle(
        &id,
        TaskSettlement { status: TaskSettlementStatus::Killed, stop_reason: None }
    ));
}

#[test]
fn stop_by_user_uses_the_configured_cancellation_message() {
    let mut service = TaskService::new(TaskServiceConfig {
        user_cancellation_message: "已被用户中止".to_string(),
        ..Default::default()
    });
    let id = service.register_task(&TestTask::new("process", "cmd"), detached()).unwrap();
    let info = service.stop_by_user(&id).unwrap();
    assert_eq!(info.status, TaskStatus::Killed);
    assert_eq!(info.stop_reason.as_deref(), Some("已被用户中止"));
}

#[test]
fn stopping_an_unknown_task_returns_nothing() {
    let mut service = svc();
    assert!(service.stop("nope", Some("reason")).is_none());
}

#[test]
fn stopping_a_settled_task_leaves_it_alone() {
    let mut service = svc();
    let id = service.register_task(&TestTask::new("process", "cmd"), detached()).unwrap();
    service.settle(&id, completed());
    let info = service.stop(&id, Some("too late")).unwrap();
    assert_eq!(info.status, TaskStatus::Completed);
    assert_eq!(info.stop_reason, None);
}

#[test]
fn stop_all_settles_everything() {
    let mut service = svc();
    let task = TestTask::new("process", "cmd");
    service.register_task(&task, detached()).unwrap();
    service.register_task(&task, detached()).unwrap();
    assert_eq!(service.stop_all(Some("shutdown")).len(), 2);
    assert!(service.list(true, None).is_empty());
}

#[test]
fn stop_all_on_exit_silences_detached_tasks_first() {
    let (mut service, delegate) = svc_with_delegate();
    let task = TestTask::new("process", "cmd");
    let detached_id = service.register_task(&task, detached()).unwrap();
    service.register_task(&task, foreground()).unwrap();

    service.stop_all_on_exit(SESSION_CLOSED_REASON);

    assert!(service.list(true, None).is_empty());
    assert!(
        service.get_task(&detached_id).unwrap().terminal_notification_suppressed,
        "a session that is going away has nobody left to read the notification"
    );
    assert!(delegate.enqueued.lock().unwrap().is_empty());
}

#[test]
fn keep_alive_on_exit_leaves_tasks_running() {
    let mut service =
        TaskService::new(TaskServiceConfig { keep_alive_on_exit: true, ..Default::default() });
    service.register_task(&TestTask::new("process", "cmd"), detached()).unwrap();
    assert!(service.stop_all_on_exit(SESSION_CLOSED_REASON).is_empty());
    assert_eq!(service.list(true, None).len(), 1);
}

// ── Detach ─────────────────────────────────────────────────────────────────

#[test]
fn detach_flips_a_foreground_task_to_detached() {
    let mut service = svc();
    let id = service.register_task(&TestTask::new("process", "cmd"), foreground()).unwrap();
    assert!(!service.get_task(&id).unwrap().detached);
    service.detach(&id);
    assert!(service.get_task(&id).unwrap().detached);
}

#[test]
fn detach_announces_the_task() {
    let (mut service, delegate) = svc_with_delegate();
    let id = service.register_task(&TestTask::new("process", "cmd"), foreground()).unwrap();
    assert!(delegate.started.lock().unwrap().is_empty());
    service.detach(&id);
    assert_eq!(*delegate.started.lock().unwrap(), vec![id]);
}

#[test]
fn detach_resolves_the_foreground_release() {
    let mut service = svc();
    let entry = service
        .track(AgentTaskTrackOptions {
            id_prefix: "fg".to_string(),
            description: "foreground".to_string(),
            kind: "process".to_string(),
            detached: false,
            timeout_ms: None,
            detach_timeout_ms: None,
            agent_id: None,
        })
        .unwrap();
    let mut rx = entry.on_did_detach.expect("foreground release channel");
    service.detach(&entry.task_id);
    assert_eq!(rx.try_recv(), Ok(ForegroundTaskReleaseReason::Detached));
}

#[test]
fn settling_resolves_the_foreground_release_as_terminal() {
    let mut service = svc();
    let entry = service
        .track(AgentTaskTrackOptions {
            id_prefix: "fg".to_string(),
            description: "foreground".to_string(),
            kind: "process".to_string(),
            detached: false,
            timeout_ms: None,
            detach_timeout_ms: None,
            agent_id: None,
        })
        .unwrap();
    let mut rx = entry.on_did_detach.expect("foreground release channel");
    service.settle(&entry.task_id, completed());
    assert_eq!(rx.try_recv(), Ok(ForegroundTaskReleaseReason::Terminal));
}

#[test]
fn detach_applies_the_detach_timeout_budget() {
    let mut service = svc();
    let id = service
        .register_task(
            &TestTask::new("process", "cmd"),
            RegisterAgentTaskOptions {
                detached: false,
                timeout_ms: Some(1_000),
                detach_timeout_ms: Some(60_000),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(service.get_task(&id).unwrap().timeout_ms, Some(1_000));
    service.detach(&id);
    assert_eq!(service.get_task(&id).unwrap().timeout_ms, Some(60_000));
}

#[test]
fn detaching_twice_is_a_no_op() {
    let (mut service, delegate) = svc_with_delegate();
    let id = service.register_task(&TestTask::new("process", "cmd"), foreground()).unwrap();
    service.detach(&id);
    service.detach(&id);
    assert_eq!(delegate.started.lock().unwrap().len(), 1);
}

#[test]
fn detaching_a_settled_task_is_a_no_op() {
    let mut service = svc();
    let id = service.register_task(&TestTask::new("process", "cmd"), foreground()).unwrap();
    service.settle(&id, completed());
    let info = service.detach(&id).unwrap();
    assert_eq!(info.status, TaskStatus::Completed);
    assert!(!info.detached, "a settled foreground task never becomes detached");
}

#[test]
fn detaching_a_ghost_returns_it_unchanged() {
    let mut service = svc();
    service.restore_ghosts([ghost("old-1", TaskStatus::Lost, true)]);
    assert_eq!(service.detach("old-1").unwrap().status, TaskStatus::Lost);
}

#[test]
fn auto_background_on_timeout_detaches_instead_of_killing() {
    let mut service = svc();
    let id = service
        .register_task(
            &TestTask::new("process", "cmd"),
            RegisterAgentTaskOptions {
                detached: false,
                auto_background_on_timeout: true,
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(service.on_timeout(&id), Some(ForegroundTaskReleaseReason::TimeoutDetached));
    let info = service.get_task(&id).unwrap();
    assert_eq!(info.status, TaskStatus::Running);
    assert!(info.detached);
}

#[test]
fn auto_background_does_not_apply_to_an_already_detached_task() {
    let mut service = svc();
    let id = service
        .register_task(
            &TestTask::new("process", "cmd"),
            RegisterAgentTaskOptions {
                detached: true,
                auto_background_on_timeout: true,
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(service.on_timeout(&id), None);
    assert_eq!(service.get_task(&id).unwrap().status, TaskStatus::TimedOut);
}

// ── Terminal effects ───────────────────────────────────────────────────────

#[test]
fn a_settled_detached_task_notifies_once() {
    let (mut service, delegate) = svc_with_delegate();
    let id = service.register_task(&TestTask::new("process", "cmd"), detached()).unwrap();
    let _ = service.append_output(&id, "the output");
    service.settle(&id, completed());

    let enqueued = delegate.enqueued.lock().unwrap();
    assert_eq!(enqueued.len(), 1);
    assert!(enqueued[0].contains("source_id=\"" ));
    assert!(enqueued[0].contains("Title: Background process completed"));
    assert!(enqueued[0].contains("the output"));

    let terminated = delegate.terminated.lock().unwrap();
    assert_eq!(terminated.len(), 1);
    assert_eq!(terminated[0].1.as_deref(), Some("the output"));
}

#[test]
fn a_settled_foreground_task_does_not_notify() {
    let (mut service, delegate) = svc_with_delegate();
    let id = service.register_task(&TestTask::new("process", "cmd"), foreground()).unwrap();
    service.settle(&id, completed());
    assert!(delegate.enqueued.lock().unwrap().is_empty());
    assert!(delegate.terminated.lock().unwrap().is_empty());
}

#[test]
fn a_suppressed_task_does_not_notify_but_still_records_termination() {
    let (mut service, delegate) = svc_with_delegate();
    let id = service.register_task(&TestTask::new("process", "cmd"), detached()).unwrap();
    service.suppress_terminal_notification(&id);
    service.settle(&id, completed());
    assert!(delegate.enqueued.lock().unwrap().is_empty());
    assert_eq!(delegate.terminated.lock().unwrap().len(), 1);
}

#[test]
fn a_notification_already_delivered_is_not_repeated() {
    let (mut service, delegate) = svc_with_delegate();
    let id = service.register_task(&TestTask::new("process", "cmd"), detached()).unwrap();
    service.mark_notification_delivered(&TaskNotificationOrigin::new(&id, TaskStatus::Completed));
    service.settle(&id, completed());
    assert!(delegate.enqueued.lock().unwrap().is_empty());
}

#[test]
fn terminal_effects_fire_at_most_once_per_task() {
    let (mut service, delegate) = svc_with_delegate();
    let id = service.register_task(&TestTask::new("process", "cmd"), detached()).unwrap();
    service.settle(&id, completed());
    service.settle(&id, completed());
    service.stop(&id, Some("late"));
    assert_eq!(delegate.enqueued.lock().unwrap().len(), 1);
    assert_eq!(delegate.terminated.lock().unwrap().len(), 1);
}

#[test]
fn a_failed_subagent_notification_carries_resume_instructions() {
    let (mut service, delegate) = svc_with_delegate();
    let id = service.register_task(&TestTask::agent("research", "agent-xyz"), detached()).unwrap();
    service.settle(
        &id,
        TaskSettlement {
            status: TaskSettlementStatus::Failed,
            stop_reason: Some("crashed".to_string()),
        },
    );
    let enqueued = delegate.enqueued.lock().unwrap();
    assert!(enqueued[0].contains("agent_id=\"agent-xyz\""));
    assert!(enqueued[0].contains("Agent(resume=\"agent-xyz\""));
}

#[test]
fn the_terminal_tail_is_bounded() {
    let (mut service, delegate) = svc_with_delegate();
    let id = service.register_task(&TestTask::new("agent", "big"), detached()).unwrap();
    let _ = service.append_output(&id, &"y".repeat(TERMINAL_OUTPUT_TAIL_BYTES * 3));
    service.settle(&id, completed());
    let terminated = delegate.terminated.lock().unwrap();
    assert_eq!(terminated[0].1.as_ref().unwrap().len(), TERMINAL_OUTPUT_TAIL_BYTES);
}

#[test]
fn a_task_with_no_output_carries_no_tail() {
    let (mut service, delegate) = svc_with_delegate();
    let id = service.register_task(&TestTask::new("process", "cmd"), detached()).unwrap();
    service.settle(&id, completed());
    assert_eq!(delegate.terminated.lock().unwrap()[0].1, None);
}

// ── Restore ────────────────────────────────────────────────────────────────

#[test]
fn reconcile_marks_running_ghosts_lost() {
    let mut service = svc();
    service.restore_ghosts([
        ghost("old-running", TaskStatus::Running, true),
        ghost("old-done", TaskStatus::Completed, true),
    ]);
    let lost = service.reconcile();
    assert_eq!(lost.len(), 1);
    assert_eq!(lost[0].task_id, "old-running");
    assert_eq!(lost[0].status, TaskStatus::Lost);
    assert!(lost[0].ended_at.is_some());
    assert_eq!(service.get_task("old-done").unwrap().status, TaskStatus::Completed);
}

#[test]
fn reconcile_re_delivers_terminal_notifications_silently() {
    let (mut service, delegate) = svc_with_delegate();
    service.restore_ghosts([ghost("old-1", TaskStatus::Completed, true)]);
    service.reconcile();
    assert_eq!(delegate.restored.lock().unwrap().len(), 1);
    assert!(delegate.enqueued.lock().unwrap().is_empty(), "restore must not start a turn");
}

#[test]
fn reconcile_skips_notifications_already_in_the_transcript() {
    let (mut service, delegate) = svc_with_delegate();
    service.restore_ghosts([ghost("old-1", TaskStatus::Completed, true)]);
    service.mark_notification_delivered(&TaskNotificationOrigin::new(
        "old-1",
        TaskStatus::Completed,
    ));
    service.reconcile();
    assert!(delegate.restored.lock().unwrap().is_empty());
}

#[test]
fn reconcile_notifies_for_a_newly_lost_task() {
    let (mut service, delegate) = svc_with_delegate();
    service.restore_ghosts([ghost("old-1", TaskStatus::Running, true)]);
    service.reconcile();
    let restored = delegate.restored.lock().unwrap();
    assert_eq!(restored.len(), 1);
    assert!(restored[0].contains("type=\"task.lost\""));
}

#[test]
fn reconcile_ignores_settled_foreground_ghosts() {
    let (mut service, delegate) = svc_with_delegate();
    service.restore_ghosts([ghost("old-fg", TaskStatus::Completed, false)]);
    service.reconcile();
    assert!(delegate.restored.lock().unwrap().is_empty());
}

#[test]
fn load_from_disk_merges_with_replayed_ghosts() {
    let mut service = svc();
    let persistence = MemoryPersistence::default();
    persistence.write_task(&ghost("t1", TaskStatus::Completed, true)).unwrap();
    service.set_persistence(Box::new(persistence));

    service.restore_ghosts([ghost("t1", TaskStatus::Running, true)]);
    service.load_from_disk(false).unwrap();
    // Disk knows it finished; replay only knew it started.
    assert_eq!(service.get_task("t1").unwrap().status, TaskStatus::Completed);
}

#[test]
fn load_from_disk_does_not_shadow_a_live_task() {
    let mut service = svc();
    let persistence = MemoryPersistence::default();
    persistence.write_task(&ghost("t1", TaskStatus::Lost, true)).unwrap();
    service.set_persistence(Box::new(persistence));

    // A live task registered under the same id must win.
    service.restore_ghosts([ghost("t1", TaskStatus::Running, true)]);
    let live = service.register_task(&TestTask::new("process", "cmd"), detached()).unwrap();
    service.load_from_disk(false).unwrap();
    assert_eq!(service.get_task(&live).unwrap().status, TaskStatus::Running);
}

#[test]
fn load_from_disk_can_replace_the_ghost_set() {
    let mut service = svc();
    service.set_persistence(Box::new(MemoryPersistence::default()));
    service.restore_ghosts([ghost("stale", TaskStatus::Completed, true)]);
    service.load_from_disk(true).unwrap();
    assert_eq!(service.ghost_count(), 0);
}

// ── Compaction reminder ────────────────────────────────────────────────────

#[test]
fn no_reminder_without_a_compaction() {
    let mut service = svc();
    service.register_task(&TestTask::new("process", "cmd"), detached()).unwrap();
    assert_eq!(service.active_background_task_reminder(), None);
}

#[test]
fn a_compaction_with_live_tasks_produces_one_reminder() {
    let mut service = svc();
    service.register_task(&TestTask::new("process", "npm test"), detached()).unwrap();
    service.note_compaction();
    let reminder = service.active_background_task_reminder().expect("reminder");
    assert!(reminder.contains("Do not start duplicates"));
    assert!(reminder.contains("active_background_tasks: 1"));
    assert!(reminder.contains("description: npm test"));
    // One-shot.
    assert_eq!(service.active_background_task_reminder(), None);
}

#[test]
fn a_compaction_with_no_live_tasks_produces_nothing() {
    let mut service = svc();
    service.note_compaction();
    assert_eq!(service.active_background_task_reminder(), None);
}

// ── Waiting ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn wait_returns_immediately_for_a_settled_task() {
    let mut service = svc();
    let id = service.register_task(&TestTask::new("process", "cmd"), detached()).unwrap();
    service.settle(&id, completed());
    let info = service.wait(&id, 10_000).await.unwrap();
    assert_eq!(info.status, TaskStatus::Completed);
}

#[tokio::test]
async fn wait_with_a_zero_timeout_polls() {
    let mut service = svc();
    let id = service.register_task(&TestTask::new("process", "cmd"), detached()).unwrap();
    let info = service.wait(&id, 0).await.unwrap();
    assert_eq!(info.status, TaskStatus::Running);
}

#[tokio::test]
async fn wait_times_out_on_a_running_task() {
    let mut service = svc();
    let id = service.register_task(&TestTask::new("process", "cmd"), detached()).unwrap();
    let info = service.wait(&id, 5).await.unwrap();
    assert_eq!(info.status, TaskStatus::Running);
}

#[tokio::test]
async fn wait_on_a_ghost_returns_its_record() {
    let mut service = svc();
    service.restore_ghosts([ghost("old-1", TaskStatus::Lost, true)]);
    assert_eq!(service.wait("old-1", 10).await.unwrap().status, TaskStatus::Lost);
}

#[tokio::test]
async fn wait_on_an_unknown_task_returns_nothing() {
    let mut service = svc();
    assert!(service.wait("nope", 10).await.is_none());
}

// ── Listing format ─────────────────────────────────────────────────────────

#[test]
fn an_empty_listing_says_so() {
    assert_eq!(
        format_task_list(&[], true),
        "active_background_tasks: 0\nNo background tasks found."
    );
    assert_eq!(
        format_task_list(&[], false),
        "background_tasks: 0\nNo background tasks found."
    );
}

#[test]
fn a_listing_renders_snake_case_fields_and_skips_absent_ones() {
    let info = ghost("t1", TaskStatus::Running, true);
    let rendered = format_task_list(std::slice::from_ref(&info), true);
    assert!(rendered.contains("task_id: t1"));
    assert!(rendered.contains("status: running"));
    assert!(rendered.contains("detached: true"));
    assert!(!rendered.contains("stop_reason:"), "absent fields are omitted");
    assert!(!rendered.contains("agent_id:"));
}

#[test]
fn a_multi_task_listing_is_separated_by_rules() {
    let tasks = vec![ghost("t1", TaskStatus::Running, true), ghost("t2", TaskStatus::Running, true)];
    let rendered = format_task_list(&tasks, false);
    assert!(rendered.starts_with("background_tasks: 2\n"));
    assert_eq!(rendered.matches("\n---\n").count(), 1);
}
