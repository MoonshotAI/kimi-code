/// `task` domain — the agent-scoped task registry.
///
/// Port of `AgentTaskService`
/// (`packages/agent-core-v2/src/agent/task/taskService.ts`).
///
/// Owns the agent's registry of running and restored tasks: registration,
/// bounded output retention, detach / stop / wait, terminal notifications with
/// at-most-once delivery, and resume reconciliation.
///
/// **Host boundary.** Everything timing- or I/O-shaped stays with the host:
/// arming timers, racing a SIGTERM grace window before escalating to SIGKILL,
/// writing persistence, and turning a rendered notification into a context
/// message. This service owns the *state machine* — which transitions are
/// legal, what a task's info reads as afterwards, and whether a notification
/// is owed. `stop` therefore performs abort → force-stop → settle in one step
/// and leaves the grace race to the caller, which is the only party that can
/// observe whether the underlying process actually exited.
pub mod notification;
pub mod output;
pub mod reconcile;
pub mod types;

use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::oneshot;

pub use notification::{
    build_agent_task_notification_body, build_task_notification, escape_xml, escape_xml_attr,
    notification_children, notification_id, render_notification_xml, NotificationSeverity,
    TaskNotification, TaskNotificationOrigin, DEFAULT_USER_CANCELLATION_MESSAGE,
    NOTIFICATION_FALLBACK_PREVIEW_BYTES,
};
pub use output::{
    output_limit_reason, tail_chars, OutputRetention, MAX_OUTPUT_BYTES, MAX_TASK_OUTPUT_BYTES,
    TERMINAL_OUTPUT_TAIL_BYTES,
};
pub use reconcile::{mark_lost, newer_restored_task, should_list_task};
pub use types::{
    AgentSubTaskInfo, ForegroundTaskReleaseReason, ProcessTaskInfo, QuestionTaskInfo,
    TaskInfoBase, TaskInfoByKind, TaskOutputSnapshot, TaskSettlement, TaskSettlementStatus,
    TaskStatus, TERMINAL_STATUSES,
};

pub const SIGTERM_GRACE_MS: u64 = 5_000;
pub const SESSION_CLOSED_REASON: &str = "Session closed";
const TASK_ID_ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";

pub const ACTIVE_BACKGROUND_TASK_INJECTION_VARIANT: &str = "background_task_status";
pub const ACTIVE_BACKGROUND_TASK_GUIDANCE: &str = "The conversation was compacted, so the earlier messages that started these background tasks are gone — but the tasks are still running from before. Do not start duplicates. Use TaskOutput to fetch a task's result, TaskList to list them, and TaskStop to cancel one.";

/// A task id: `{prefix}-{8 chars of base36}`.
///
/// TS draws from `randomBytes(8)` and folds each byte into a 36-char alphabet.
/// The modulo bias is inherited deliberately — the id only needs to be
/// collision-resistant within one agent's registry, and matching the TS shape
/// keeps ids recognisable across the two implementations.
pub fn generate_task_id(prefix: &str) -> String {
    let suffix: String = (0..8)
        .map(|_| TASK_ID_ALPHABET[fastrand::usize(..TASK_ID_ALPHABET.len())] as char)
        .collect();
    format!("{prefix}-{suffix}")
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn normalize_reason(reason: Option<&str>) -> Option<String> {
    let trimmed = reason?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

// ── Traits ─────────────────────────────────────────────────────────────────

/// Handle a running task hands back to the service.
pub struct TaskSink {
    pub append_output: Box<dyn Fn(&str) + Send + Sync>,
    pub settle: Box<dyn Fn(TaskSettlement) -> bool + Send + Sync>,
}

pub trait AgentTask: Send + Sync {
    fn kind(&self) -> &str;
    fn description(&self) -> &str;
    fn id_prefix(&self) -> &str;
    fn timeout_ms(&self) -> Option<u64> {
        None
    }
    /// The resumable subagent id, for `agent` tasks.
    fn agent_id(&self) -> Option<String> {
        None
    }
    fn start(&self, sink: &TaskSink);
    fn on_detach(&self) {}
    fn force_stop(&self) {}
    fn to_info(&self, base: &TaskInfoBase) -> TaskInfoByKind;
}

/// Side effects the host performs on the service's behalf.
pub trait TaskDelegate: Send + Sync {
    /// A task became visible as detached work (`task.started`).
    fn on_task_started(&self, _info: &TaskInfoBase) {}
    /// A detached task settled (`task.terminated`), with a bounded output tail.
    fn on_task_terminated(&self, _info: &TaskInfoBase, _output_tail: Option<&str>) {}
    /// Deliver a terminal notification into the live conversation.
    fn enqueue_notification(&self, _xml: &str, _origin: &TaskNotificationOrigin) {}
    /// Append a restored terminal notification silently (no new turn).
    fn append_restored_notification(&self, xml: &str, origin: &TaskNotificationOrigin) {
        self.enqueue_notification(xml, origin);
    }
    /// Broadcast the notification to non-model subscribers (desktop toasts…).
    fn publish_notification(&self, _notification: &TaskNotification) {}
}

pub trait TaskPersistence: Send + Sync {
    fn write_task(&self, info: &TaskInfoBase) -> Result<(), String>;
    fn list_tasks(&self) -> Result<Vec<TaskInfoBase>, String>;
    fn append_output(&self, task_id: &str, chunk: &str) -> Result<(), String>;
    /// A persisted snapshot, when an output log exists for this task.
    fn read_output_snapshot(
        &self,
        _task_id: &str,
        _max_preview_bytes: usize,
    ) -> Result<Option<TaskOutputSnapshot>, String> {
        Ok(None)
    }
    fn remove_task(&self, _task_id: &str) -> Result<(), String> {
        Ok(())
    }
}

// ── Options and config ─────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct RegisterAgentTaskOptions {
    pub detached: bool,
    pub timeout_ms: Option<u64>,
    pub detach_timeout_ms: Option<u64>,
    pub auto_background_on_timeout: bool,
}

impl Default for RegisterAgentTaskOptions {
    fn default() -> Self {
        Self {
            // TS: `options.detached ?? true`.
            detached: true,
            timeout_ms: None,
            detach_timeout_ms: None,
            auto_background_on_timeout: false,
        }
    }
}

pub struct AgentTaskTrackOptions {
    pub id_prefix: String,
    pub description: String,
    pub kind: String,
    pub detached: bool,
    pub timeout_ms: Option<u64>,
    pub detach_timeout_ms: Option<u64>,
    pub agent_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TaskServiceConfig {
    /// `None` means unlimited, matching an unset `[task] maxRunningTasks`.
    pub max_running_tasks: Option<usize>,
    pub kill_grace_period_ms: u64,
    pub keep_alive_on_exit: bool,
    /// The locale-resolved `toolsV2.abort.abortedByUser` string.
    pub user_cancellation_message: String,
}

impl Default for TaskServiceConfig {
    fn default() -> Self {
        Self {
            max_running_tasks: Some(10),
            kill_grace_period_ms: SIGTERM_GRACE_MS,
            keep_alive_on_exit: false,
            user_cancellation_message: DEFAULT_USER_CANCELLATION_MESSAGE.to_string(),
        }
    }
}

pub struct TaskEntry {
    pub task_id: String,
    pub on_did_detach: Option<oneshot::Receiver<ForegroundTaskReleaseReason>>,
}

// ── Internal record ────────────────────────────────────────────────────────

struct TaskRecord {
    info: TaskInfoBase,
    output: OutputRetention,
    /// Outstanding foreground release channel; taken when it resolves.
    foreground_release: Option<oneshot::Sender<ForegroundTaskReleaseReason>>,
    /// Whether the task ran detached at registration — the admission-control
    /// notion, distinct from `info.detached`, which flips when `detach` runs.
    starts_detached: bool,
    detach_timeout_ms: Option<u64>,
    auto_background_on_timeout: bool,
    timed_out: bool,
    terminal_fired: bool,
    output_limit_tripped: bool,
    waiters: Vec<oneshot::Sender<()>>,
}

impl TaskRecord {
    /// TS's `isDetached`: a task is detached once no foreground release is owed.
    fn is_detached(&self) -> bool {
        self.info.detached
    }
}

// ── Service ────────────────────────────────────────────────────────────────

pub struct TaskService {
    tasks: HashMap<String, TaskRecord>,
    /// Restored records with no live counterpart.
    ghosts: HashMap<String, TaskInfoBase>,
    scheduled_notification_keys: HashSet<String>,
    delivered_notification_keys: HashSet<String>,
    delegate: Option<Box<dyn TaskDelegate>>,
    persistence: Option<Box<dyn TaskPersistence>>,
    config: TaskServiceConfig,
    active_task_reminder_pending: bool,
}

impl TaskService {
    pub fn new(config: TaskServiceConfig) -> Self {
        Self {
            tasks: HashMap::new(),
            ghosts: HashMap::new(),
            scheduled_notification_keys: HashSet::new(),
            delivered_notification_keys: HashSet::new(),
            delegate: None,
            persistence: None,
            config,
            active_task_reminder_pending: false,
        }
    }

    pub fn set_delegate(&mut self, delegate: Box<dyn TaskDelegate>) {
        self.delegate = Some(delegate);
    }

    pub fn set_persistence(&mut self, persistence: Box<dyn TaskPersistence>) {
        self.persistence = Some(persistence);
    }

    pub fn config(&self) -> &TaskServiceConfig {
        &self.config
    }

    // ── Registration ──────────────────────────────────────────────────────

    pub fn register_task(
        &mut self,
        task: &dyn AgentTask,
        options: RegisterAgentTaskOptions,
    ) -> Result<String, String> {
        self.assert_can_register(options.detached)?;
        let task_id = generate_task_id(task.id_prefix());
        let (release_tx, _release_rx) = self.make_release(options.detached);
        self.insert_record(
            TaskInfoBase {
                task_id: task_id.clone(),
                description: task.description().to_string(),
                status: TaskStatus::Running,
                kind: task.kind().to_string(),
                started_at: now_ms(),
                ended_at: None,
                detached: options.detached,
                stop_reason: None,
                terminal_notification_suppressed: false,
                timeout_ms: options.timeout_ms.or_else(|| task.timeout_ms()),
                agent_id: task.agent_id(),
            },
            release_tx,
            options.detached,
            options.detach_timeout_ms,
            options.auto_background_on_timeout,
        );
        self.after_register(&task_id);
        Ok(task_id)
    }

    pub fn track(&mut self, options: AgentTaskTrackOptions) -> Result<TaskEntry, String> {
        self.assert_can_register(options.detached)?;
        let task_id = generate_task_id(&options.id_prefix);
        let (release_tx, release_rx) = self.make_release(options.detached);
        self.insert_record(
            TaskInfoBase {
                task_id: task_id.clone(),
                description: options.description,
                status: TaskStatus::Running,
                kind: options.kind,
                started_at: now_ms(),
                ended_at: None,
                detached: options.detached,
                stop_reason: None,
                terminal_notification_suppressed: false,
                timeout_ms: options.timeout_ms,
                agent_id: options.agent_id,
            },
            release_tx,
            options.detached,
            options.detach_timeout_ms,
            false,
        );
        self.after_register(&task_id);
        Ok(TaskEntry { task_id, on_did_detach: release_rx })
    }

    #[allow(clippy::type_complexity)]
    fn make_release(
        &self,
        detached: bool,
    ) -> (
        Option<oneshot::Sender<ForegroundTaskReleaseReason>>,
        Option<oneshot::Receiver<ForegroundTaskReleaseReason>>,
    ) {
        if detached {
            (None, None)
        } else {
            let (tx, rx) = oneshot::channel();
            (Some(tx), Some(rx))
        }
    }

    fn insert_record(
        &mut self,
        info: TaskInfoBase,
        foreground_release: Option<oneshot::Sender<ForegroundTaskReleaseReason>>,
        starts_detached: bool,
        detach_timeout_ms: Option<u64>,
        auto_background_on_timeout: bool,
    ) {
        let task_id = info.task_id.clone();
        self.ghosts.remove(&task_id);
        self.tasks.insert(
            task_id,
            TaskRecord {
                info,
                output: OutputRetention::new(),
                foreground_release,
                starts_detached,
                detach_timeout_ms,
                auto_background_on_timeout,
                timed_out: false,
                terminal_fired: false,
                output_limit_tripped: false,
                waiters: Vec::new(),
            },
        );
    }

    /// Detached work is visible from the moment it starts; foreground work
    /// stays private until it detaches or settles.
    fn after_register(&mut self, task_id: &str) {
        let Some(record) = self.tasks.get(task_id) else { return };
        if !record.is_detached() {
            return;
        }
        let info = record.info.clone();
        self.persist(&info);
        if let Some(delegate) = &self.delegate {
            delegate.on_task_started(&info);
        }
    }

    fn assert_can_register(&self, detached: bool) -> Result<(), String> {
        let Some(max_running_tasks) = self.config.max_running_tasks else {
            return Ok(());
        };
        // TS only gates detached registrations — a foreground task occupies the
        // caller, so it cannot pile up the way background work can.
        if !detached {
            return Ok(());
        }
        if self.active_task_count() < max_running_tasks {
            return Ok(());
        }
        Err(format!("Too many background tasks (max {max_running_tasks})"))
    }

    /// Non-terminal tasks that were *registered* detached.
    fn active_task_count(&self) -> usize {
        self.tasks
            .values()
            .filter(|r| !r.info.status.is_terminal() && r.starts_detached)
            .count()
    }

    // ── Query ─────────────────────────────────────────────────────────────

    pub fn get_task(&self, task_id: &str) -> Option<TaskInfoBase> {
        match self.tasks.get(task_id) {
            Some(record) => Some(record.info.clone()),
            None => self.ghosts.get(task_id).cloned(),
        }
    }

    /// List live tasks, then ghosts. Ghosts only appear in the full listing —
    /// by definition they are all terminal.
    pub fn list(&self, active_only: bool, limit: Option<usize>) -> Vec<TaskInfoBase> {
        let mut result: Vec<TaskInfoBase> = Vec::new();
        let mut live: Vec<&TaskRecord> = self.tasks.values().collect();
        live.sort_by_key(|r| (r.info.started_at, r.info.task_id.clone()));
        for record in live {
            if !should_list_task(&record.info, active_only) {
                continue;
            }
            result.push(record.info.clone());
            if limit.is_some_and(|n| result.len() >= n) {
                return result;
            }
        }
        if active_only {
            return result;
        }
        let mut ghosts: Vec<&TaskInfoBase> = self.ghosts.values().collect();
        ghosts.sort_by_key(|info| (info.started_at, info.task_id.clone()));
        for ghost in ghosts {
            if !should_list_task(ghost, active_only) {
                continue;
            }
            result.push(ghost.clone());
            if limit.is_some_and(|n| result.len() >= n) {
                return result;
            }
        }
        result
    }

    pub fn running_count(&self) -> usize {
        self.tasks.values().filter(|r| !r.info.status.is_terminal()).count()
    }

    pub fn ghost_count(&self) -> usize {
        self.ghosts.len()
    }

    // ── Output ────────────────────────────────────────────────────────────

    /// Record a chunk of task output.
    ///
    /// Returns the stop reason when this chunk pushed a process task past the
    /// hard output ceiling — the caller should then [`stop`](Self::stop) it.
    /// TS fires that stop internally; here it is surfaced so the host keeps
    /// control of process teardown ordering.
    #[must_use = "a returned reason means the task must be stopped"]
    pub fn append_output(&mut self, task_id: &str, chunk: &str) -> Option<String> {
        let Some(record) = self.tasks.get_mut(task_id) else { return None };
        record.output.append(chunk);

        let trips = !record.output_limit_tripped
            && record.info.kind == "process"
            && record.output.output_size_bytes() > MAX_TASK_OUTPUT_BYTES;
        if trips {
            record.output_limit_tripped = true;
        }

        if record.output_limit_tripped {
            // Past the ceiling nothing more is persisted; the ring keeps the
            // tail so the notification can still show where it went wrong.
            return trips.then(output_limit_reason);
        }

        if let Some(persistence) = &self.persistence {
            let _ = persistence.append_output(task_id, chunk);
        }
        None
    }

    /// A snapshot of the task's output, preferring the persisted log.
    pub fn get_output_snapshot(&self, task_id: &str, max_preview_bytes: usize) -> TaskOutputSnapshot {
        if self.get_task(task_id).is_none() {
            return TaskOutputSnapshot::empty();
        }
        if let Some(persistence) = &self.persistence {
            if let Ok(Some(mut persisted)) =
                persistence.read_output_snapshot(task_id, max_preview_bytes)
            {
                persisted.full_output_available = true;
                return persisted;
            }
        }
        match self.tasks.get(task_id) {
            Some(record) => record.output.snapshot(max_preview_bytes),
            None => TaskOutputSnapshot::empty(),
        }
    }

    /// Read the task's output, optionally keeping only the last `tail`
    /// characters (TS: `output.slice(-tail)`).
    pub fn read_output(&self, task_id: &str, tail: Option<usize>) -> String {
        let output = self.get_output_snapshot(task_id, usize::MAX).preview;
        match tail {
            Some(tail) => tail_chars(&output, tail).to_string(),
            None => output,
        }
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────

    /// Settle a task. Returns `false` when it had already settled.
    pub fn settle(&mut self, task_id: &str, settlement: TaskSettlement) -> bool {
        let Some(record) = self.tasks.get_mut(task_id) else { return false };
        if record.info.status.is_terminal() {
            return false;
        }
        // A task killed after its own timeout fired reads as `timed_out`, not
        // `killed` — the timeout is the real cause.
        let status: TaskStatus =
            if record.timed_out && settlement.status == TaskSettlementStatus::Killed {
                TaskStatus::TimedOut
            } else {
                settlement.status.into()
            };

        record.info.status = status;
        record.info.ended_at = Some(now_ms());
        // TS: `settlement.stopReason ?? (status === 'killed' ? entry.stopReason : undefined)`
        // — a settlement without a reason *clears* any stashed reason unless
        // the task was killed, where the stashed reason is the kill reason.
        record.info.stop_reason = match settlement.stop_reason {
            Some(reason) => Some(reason),
            None if status == TaskStatus::Killed => record.info.stop_reason.take(),
            None => None,
        };

        for waiter in std::mem::take(&mut record.waiters) {
            let _ = waiter.send(());
        }
        if let Some(tx) = record.foreground_release.take() {
            let _ = tx.send(ForegroundTaskReleaseReason::Terminal);
        }

        let info = record.info.clone();
        self.persist(&info);
        self.fire_terminal_effects(task_id);
        true
    }

    /// Stop a task: mark the reason, force-stop it, and settle it.
    pub fn stop(&mut self, task_id: &str, reason: Option<&str>) -> Option<TaskInfoBase> {
        self.terminate(task_id, normalize_reason(reason), TaskStatus::Killed)
    }

    pub fn stop_by_user(&mut self, task_id: &str) -> Option<TaskInfoBase> {
        let reason = self.config.user_cancellation_message.clone();
        self.terminate(task_id, Some(reason), TaskStatus::Killed)
    }

    /// Time a task out, or auto-background it when configured to.
    ///
    /// Returns the release reason when the task detached instead of dying.
    pub fn on_timeout(&mut self, task_id: &str) -> Option<ForegroundTaskReleaseReason> {
        let auto_background = self
            .tasks
            .get(task_id)
            .is_some_and(|r| r.auto_background_on_timeout && !r.is_detached());
        if auto_background {
            self.detach_entry(task_id, true);
            return Some(ForegroundTaskReleaseReason::TimeoutDetached);
        }
        self.terminate(task_id, Some("Timed out".to_string()), TaskStatus::TimedOut);
        None
    }

    fn terminate(
        &mut self,
        task_id: &str,
        stop_reason: Option<String>,
        final_status: TaskStatus,
    ) -> Option<TaskInfoBase> {
        let record = self.tasks.get_mut(task_id)?;
        if record.info.status.is_terminal() {
            return Some(record.info.clone());
        }
        if final_status == TaskStatus::TimedOut {
            record.timed_out = true;
        }
        // Stash the reason so a self-settlement racing this stop still reports
        // why it was killed.
        record.info.stop_reason = stop_reason.clone();

        let settlement_status = if final_status == TaskStatus::TimedOut {
            TaskSettlementStatus::TimedOut
        } else {
            TaskSettlementStatus::Killed
        };
        self.settle(task_id, TaskSettlement { status: settlement_status, stop_reason });
        self.tasks.get(task_id).map(|r| r.info.clone())
    }

    pub fn stop_all(&mut self, reason: Option<&str>) -> Vec<TaskInfoBase> {
        let mut ids: Vec<String> = self.tasks.keys().cloned().collect();
        ids.sort();
        ids.iter().filter_map(|id| self.stop(id, reason)).collect()
    }

    /// Session close. Detached tasks are silenced first — the session is going
    /// away, so nobody is left to read their notifications.
    pub fn stop_all_on_exit(&mut self, reason: &str) -> Vec<TaskInfoBase> {
        if self.config.keep_alive_on_exit {
            return Vec::new();
        }
        let detached: Vec<String> = self
            .list(true, None)
            .into_iter()
            .filter(|info| info.detached)
            .map(|info| info.task_id)
            .collect();
        for task_id in &detached {
            self.suppress_terminal_notification(task_id);
        }
        self.stop_all(Some(reason))
    }

    pub fn detach(&mut self, task_id: &str) -> Option<TaskInfoBase> {
        if !self.tasks.contains_key(task_id) {
            return self.ghosts.get(task_id).cloned();
        }
        self.detach_entry(task_id, false)
    }

    fn detach_entry(&mut self, task_id: &str, via_timeout: bool) -> Option<TaskInfoBase> {
        let record = self.tasks.get_mut(task_id)?;
        if record.info.status.is_terminal() {
            return Some(record.info.clone());
        }
        // Already detached — nothing to release.
        if record.foreground_release.is_none() && record.info.detached {
            return Some(record.info.clone());
        }
        let release = record.foreground_release.take();
        record.info.detached = true;
        // A detach timeout replaces whatever budget the foreground run had.
        if let Some(detach_timeout_ms) = record.detach_timeout_ms {
            record.info.timeout_ms = Some(detach_timeout_ms);
        }
        let info = record.info.clone();

        self.persist(&info);
        if let Some(delegate) = &self.delegate {
            delegate.on_task_started(&info);
        }
        if let Some(tx) = release {
            let _ = tx.send(if via_timeout {
                ForegroundTaskReleaseReason::TimeoutDetached
            } else {
                ForegroundTaskReleaseReason::Detached
            });
        }
        Some(info)
    }

    /// Wait for a task to settle, up to `timeout_ms`.
    pub async fn wait(&mut self, task_id: &str, timeout_ms: u64) -> Option<TaskInfoBase> {
        if !self.tasks.contains_key(task_id) {
            return self.ghosts.get(task_id).cloned();
        }
        let settled =
            self.tasks.get(task_id).is_some_and(|r| r.info.status.is_terminal());
        if settled || timeout_ms == 0 {
            return self.tasks.get(task_id).map(|r| r.info.clone());
        }
        let (tx, rx) = oneshot::channel::<()>();
        self.tasks.get_mut(task_id)?.waiters.push(tx);
        let _ = tokio::time::timeout(tokio::time::Duration::from_millis(timeout_ms), rx).await;
        self.tasks.get(task_id).map(|r| r.info.clone())
    }

    // ── Notifications ─────────────────────────────────────────────────────

    pub fn suppress_terminal_notification(&mut self, task_id: &str) {
        if let Some(record) = self.tasks.get_mut(task_id) {
            if record.info.terminal_notification_suppressed {
                return;
            }
            record.info.terminal_notification_suppressed = true;
            let info = record.info.clone();
            self.persist(&info);
        }
    }

    /// Record that a notification already reached the conversation, so restore
    /// does not deliver it twice.
    pub fn mark_notification_delivered(&mut self, origin: &TaskNotificationOrigin) {
        self.delivered_notification_keys.insert(origin.key());
    }

    fn fire_terminal_effects(&mut self, task_id: &str) {
        let Some(record) = self.tasks.get(task_id) else { return };
        if record.terminal_fired || !record.is_detached() {
            return;
        }
        let info = record.info.clone();
        let tail = record.output.terminal_tail();
        if let Some(record) = self.tasks.get_mut(task_id) {
            record.terminal_fired = true;
        }

        if let Some(context) = self.build_notification(&info) {
            if let Some(delegate) = &self.delegate {
                delegate.enqueue_notification(&render_notification_xml(&context.0), &context.1);
                delegate.publish_notification(&context.0);
            }
        }
        if let Some(delegate) = &self.delegate {
            delegate.on_task_terminated(&info, tail.as_deref());
        }
    }

    /// Build the notification owed for a settled task, or `None` when none is.
    ///
    /// Suppression is checked twice in TS — before and after the output read,
    /// because reading output awaits and a stop can land in between. The read
    /// is synchronous here, so one check suffices.
    fn build_notification(
        &mut self,
        info: &TaskInfoBase,
    ) -> Option<(TaskNotification, TaskNotificationOrigin)> {
        if !info.detached || info.terminal_notification_suppressed {
            return None;
        }
        let origin = TaskNotificationOrigin::new(&info.task_id, info.status);
        let key = origin.key();
        if self.scheduled_notification_keys.contains(&key)
            || self.delivered_notification_keys.contains(&key)
        {
            return None;
        }
        self.scheduled_notification_keys.insert(key);

        // Prefer pointing at the persisted log; fall back to an inline preview.
        let mut output = self.get_output_snapshot(&info.task_id, 0);
        if !output.full_output_available {
            output =
                self.get_output_snapshot(&info.task_id, NOTIFICATION_FALLBACK_PREVIEW_BYTES);
        }
        let notification =
            build_task_notification(info, &output, &self.config.user_cancellation_message);
        Some((notification, origin))
    }

    // ── Restore ───────────────────────────────────────────────────────────

    /// Seed ghosts from the replayed wire model.
    pub fn restore_ghosts(&mut self, records: impl IntoIterator<Item = TaskInfoBase>) {
        for info in records {
            if self.tasks.contains_key(&info.task_id) {
                continue;
            }
            self.ghosts.insert(info.task_id.clone(), info);
        }
    }

    /// Merge the on-disk registry into the ghost set.
    pub fn load_from_disk(&mut self, replace: bool) -> Result<(), String> {
        if replace {
            self.ghosts.clear();
        }
        let Some(persistence) = &self.persistence else { return Ok(()) };
        let tasks = persistence.list_tasks()?;
        for info in tasks {
            if self.tasks.contains_key(&info.task_id) {
                continue;
            }
            let merged = match self.ghosts.remove(&info.task_id) {
                Some(existing) => newer_restored_task(existing, info),
                None => info,
            };
            self.ghosts.insert(merged.task_id.clone(), merged);
        }
        Ok(())
    }

    /// Declare still-running restored tasks lost and re-deliver any terminal
    /// notifications the previous session never got to show.
    pub fn reconcile(&mut self) -> Vec<TaskInfoBase> {
        let now = now_ms();
        let mut lost = Vec::new();
        let mut ids: Vec<String> = self.ghosts.keys().cloned().collect();
        ids.sort();
        for task_id in ids {
            let Some(info) = self.ghosts.get(&task_id) else { continue };
            let Some(updated) = mark_lost(info, now) else { continue };
            self.ghosts.insert(task_id, updated.clone());
            self.persist(&updated);
            if let Some(delegate) = &self.delegate {
                delegate.on_task_terminated(&updated, None);
            }
            lost.push(updated);
        }
        self.restore_notifications();
        lost
    }

    fn restore_notifications(&mut self) {
        for info in self.list(false, None) {
            if !info.status.is_terminal() {
                continue;
            }
            if let Some((notification, origin)) = self.build_notification(&info) {
                if let Some(delegate) = &self.delegate {
                    delegate.append_restored_notification(
                        &render_notification_xml(&notification),
                        &origin,
                    );
                    delegate.publish_notification(&notification);
                }
            }
        }
    }

    // ── Compaction re-surface ─────────────────────────────────────────────

    /// Note that a compaction removed the messages that started the live tasks.
    pub fn note_compaction(&mut self) {
        self.active_task_reminder_pending = true;
    }

    /// One-shot reminder listing the tasks that outlived a compaction.
    pub fn active_background_task_reminder(&mut self) -> Option<String> {
        if !self.active_task_reminder_pending {
            return None;
        }
        self.active_task_reminder_pending = false;
        let tasks = self.list(true, None);
        if tasks.is_empty() {
            return None;
        }
        Some(format!("{ACTIVE_BACKGROUND_TASK_GUIDANCE}\n\n{}", format_task_list(&tasks, true)))
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    fn persist(&self, info: &TaskInfoBase) {
        if let Some(persistence) = &self.persistence {
            let _ = persistence.write_task(info);
        }
    }
}

/// Render a task listing, matching `formatTaskList` + `formatPlainObject`.
///
/// TS enumerates the info object's own keys; this port fixes the field order
/// so the rendering is deterministic across runs. Absent optional fields are
/// omitted, as TS skips `undefined` / `null`.
pub fn format_task_list(tasks: &[TaskInfoBase], active_only: bool) -> String {
    let label = if active_only { "active_background_tasks" } else { "background_tasks" };
    let header = format!("{label}: {}", tasks.len());
    if tasks.is_empty() {
        return format!("{header}\nNo background tasks found.");
    }
    let body =
        tasks.iter().map(format_task_fields).collect::<Vec<_>>().join("\n---\n");
    format!("{header}\n{body}")
}

fn format_task_fields(info: &TaskInfoBase) -> String {
    let mut lines = vec![
        format!("task_id: {}", info.task_id),
        format!("description: {}", info.description),
        format!("status: {}", info.status.as_str()),
        format!("kind: {}", info.kind),
        format!("detached: {}", info.detached),
        format!("started_at: {}", info.started_at),
    ];
    if let Some(ended_at) = info.ended_at {
        lines.push(format!("ended_at: {ended_at}"));
    }
    if let Some(stop_reason) = &info.stop_reason {
        lines.push(format!("stop_reason: {stop_reason}"));
    }
    if info.terminal_notification_suppressed {
        lines.push("terminal_notification_suppressed: true".to_string());
    }
    if let Some(timeout_ms) = info.timeout_ms {
        lines.push(format!("timeout_ms: {timeout_ms}"));
    }
    if let Some(agent_id) = &info.agent_id {
        lines.push(format!("agent_id: {agent_id}"));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests;
