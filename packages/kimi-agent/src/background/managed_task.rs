/// ManagedTask — internal state tracking for a single background task.
///
/// Each ManagedTask wraps a `BackgroundTask` implementation with lifecycle
/// state, output ring buffer, timeout handling, and cancellation.

use tokio::sync::{oneshot, watch};

use crate::background::ring_buffer::OutputRingBuffer;
use crate::background::types::*;

/// Hard ceiling on the combined output (16 MiB). When exceeded, the task is
/// force-terminated.
const MAX_TASK_OUTPUT_BYTES: u64 = 16 * 1024 * 1024;

/// Internal state of a managed task.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedTaskState {
    /// Task is running.
    Running,
    /// Task is in the process of being stopped.
    Stopping,
    /// Task has reached a terminal state.
    Terminal,
}

/// A managed background task.
pub struct ManagedTask {
    /// Unique task ID.
    pub task_id: String,
    /// The background task implementation.
    pub task_kind: BackgroundTaskKind,
    /// Human-readable description.
    pub description: String,
    /// Current lifecycle state.
    pub state: ManagedTaskState,
    /// Current status (for terminal states).
    pub status: BackgroundTaskStatus,
    /// Output ring buffer.
    pub output: OutputRingBuffer,
    /// Total output bytes seen (including dropped from ring buffer).
    pub output_size_bytes: u64,
    /// Whether the output limit has been tripped.
    pub output_limit_tripped: bool,
    /// Registration options.
    pub options: RegisterOptions,
    /// Start timestamp (epoch ms).
    pub started_at: u64,
    /// End timestamp (epoch ms).
    pub ended_at: Option<u64>,
    /// Stop reason, if any.
    pub stop_reason: Option<String>,
    /// Cancellation signal sender.
    pub cancel_tx: Option<watch::Sender<bool>>,
    /// Cancellation signal receiver.
    pub cancel_rx: watch::Receiver<bool>,
    /// Foreground release signal (for non-detached tasks).
    pub foreground_release_tx: Option<oneshot::Sender<ForegroundTaskReleaseReason>>,
    /// Timeout timer handle.
    pub timeout_handle: Option<tokio::task::JoinHandle<()>>,
}

/// Reason a foreground task was released.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForegroundTaskReleaseReason {
    Detached,
    TimeoutDetached,
    Terminal,
}

impl ManagedTask {
    /// Create a new managed task.
    pub fn new(
        task_id: String,
        kind: BackgroundTaskKind,
        description: String,
        started_at: u64,
        options: RegisterOptions,
    ) -> Self {
        let (cancel_tx, cancel_rx) = watch::channel(false);
        Self {
            task_id,
            task_kind: kind,
            description,
            state: ManagedTaskState::Running,
            status: BackgroundTaskStatus::Running,
            output: OutputRingBuffer::new(),
            output_size_bytes: 0,
            output_limit_tripped: false,
            options,
            started_at,
            ended_at: None,
            stop_reason: None,
            cancel_tx: Some(cancel_tx),
            cancel_rx,
            foreground_release_tx: None,
            timeout_handle: None,
        }
    }

    /// Append output to the ring buffer and check output limits.
    /// Returns true if the output limit has been exceeded (caller should stop the task).
    pub fn append_output(&mut self, chunk: &str) -> bool {
        self.output.append(chunk);
        self.output_size_bytes = self.output_size_bytes.wrapping_add(chunk.len() as u64);

        if !self.output_limit_tripped && self.output_size_bytes > MAX_TASK_OUTPUT_BYTES {
            self.output_limit_tripped = true;
            return true; // caller should stop the task
        }
        false
    }

    /// Settle the task with a terminal status.
    pub fn settle(&mut self, settlement: BackgroundTaskSettlement, ended_at: u64) {
        self.state = ManagedTaskState::Terminal;
        self.status = settlement.status.into();
        self.ended_at = Some(ended_at);
        self.stop_reason = settlement.stop_reason;
    }

    /// Request stop for this task.
    pub fn request_stop(&mut self) {
        if self.state != ManagedTaskState::Terminal {
            self.state = ManagedTaskState::Stopping;
            if let Some(tx) = self.cancel_tx.as_ref() {
                let _ = tx.send(true);
            }
        }
    }

    /// Force stop (SIGKILL equivalent).
    pub fn force_stop(&mut self) {
        self.request_stop();
    }

    /// Build the base info for this task.
    pub fn to_info_base(&self) -> BackgroundTaskInfoBase {
        BackgroundTaskInfoBase {
            task_id: self.task_id.clone(),
            description: self.description.clone(),
            status: self.status,
            detached: if self.options.detached { Some(true) } else { None },
            started_at: self.started_at,
            ended_at: self.ended_at,
            stop_reason: self.stop_reason.clone(),
            terminal_notification_suppressed: None,
            timeout_ms: self.options.timeout_ms,
        }
    }

    /// Build the full info for this task.
    pub fn to_info(&self) -> BackgroundTaskInfo {
        let base = self.to_info_base();
        match self.task_kind {
            BackgroundTaskKind::Process => BackgroundTaskInfo::Process(ProcessBackgroundTaskInfo {
                base,
                kind: BackgroundTaskKind::Process,
                command: self.description.clone(),
                pid: 0,
                exit_code: None,
            }),
            BackgroundTaskKind::Agent => BackgroundTaskInfo::Agent(AgentBackgroundTaskInfo {
                base,
                kind: BackgroundTaskKind::Agent,
                agent_id: None,
                subagent_type: None,
            }),
            BackgroundTaskKind::Question => BackgroundTaskInfo::Question(QuestionBackgroundTaskInfo {
                base,
                kind: BackgroundTaskKind::Question,
                question_count: 0,
                tool_call_id: None,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_task_is_running() {
        let task = ManagedTask::new(
            "bash-abc123".into(),
            BackgroundTaskKind::Process,
            "test command".into(),
            1000,
            RegisterOptions::default(),
        );
        assert_eq!(task.state, ManagedTaskState::Running);
        assert_eq!(task.status, BackgroundTaskStatus::Running);
        assert!(task.output.is_empty());
    }

    #[test]
    fn test_append_output() {
        let mut task = ManagedTask::new(
            "bash-abc123".into(),
            BackgroundTaskKind::Process,
            "test".into(),
            1000,
            RegisterOptions::default(),
        );
        let limit_exceeded = task.append_output("hello world");
        assert!(!limit_exceeded);
        assert_eq!(task.output_size_bytes, 11);
    }

    #[test]
    fn test_settle() {
        let mut task = ManagedTask::new(
            "bash-abc123".into(),
            BackgroundTaskKind::Process,
            "test".into(),
            1000,
            RegisterOptions::default(),
        );
        task.settle(
            BackgroundTaskSettlement {
                status: BackgroundTaskSettlementStatus::Completed,
                stop_reason: None,
            },
            2000,
        );
        assert_eq!(task.state, ManagedTaskState::Terminal);
        assert_eq!(task.status, BackgroundTaskStatus::Completed);
        assert_eq!(task.ended_at, Some(2000));
    }

    #[test]
    fn test_request_stop() {
        let mut task = ManagedTask::new(
            "bash-abc123".into(),
            BackgroundTaskKind::Process,
            "test".into(),
            1000,
            RegisterOptions::default(),
        );
        task.request_stop();
        assert_eq!(task.state, ManagedTaskState::Stopping);
    }
}