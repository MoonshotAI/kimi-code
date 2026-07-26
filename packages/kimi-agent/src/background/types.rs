/// Core type definitions for background tasks.
///
/// Mirrors the TS types in `packages/agent-core/src/agent/background/task.ts`
/// and related files.

use serde::{Deserialize, Serialize};

/// Status of a background task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BackgroundTaskStatus {
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "timed_out")]
    TimedOut,
    #[serde(rename = "killed")]
    Killed,
    #[serde(rename = "lost")]
    Lost,
}

impl BackgroundTaskStatus {
    /// Returns true if the status is terminal (no further state changes).
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            BackgroundTaskStatus::Completed
                | BackgroundTaskStatus::Failed
                | BackgroundTaskStatus::TimedOut
                | BackgroundTaskStatus::Killed
                | BackgroundTaskStatus::Lost
        )
    }
}

/// The kind of a background task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BackgroundTaskKind {
    #[serde(rename = "process")]
    Process,
    #[serde(rename = "agent")]
    Agent,
    #[serde(rename = "question")]
    Question,
}

/// A settlement describes how a task ended.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackgroundTaskSettlement {
    pub status: BackgroundTaskSettlementStatus,
    /// Human-readable reason for the terminal status, when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
}

/// Subset of statuses that can be used as a settlement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BackgroundTaskSettlementStatus {
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "timed_out")]
    TimedOut,
    #[serde(rename = "killed")]
    Killed,
}

impl From<BackgroundTaskSettlementStatus> for BackgroundTaskStatus {
    fn from(s: BackgroundTaskSettlementStatus) -> Self {
        match s {
            BackgroundTaskSettlementStatus::Completed => BackgroundTaskStatus::Completed,
            BackgroundTaskSettlementStatus::Failed => BackgroundTaskStatus::Failed,
            BackgroundTaskSettlementStatus::TimedOut => BackgroundTaskStatus::TimedOut,
            BackgroundTaskSettlementStatus::Killed => BackgroundTaskStatus::Killed,
        }
    }
}

/// Base information about a background task.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackgroundTaskInfoBase {
    pub task_id: String,
    pub description: String,
    pub status: BackgroundTaskStatus,
    /// Whether the task has been detached from the foreground tool call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detached: Option<bool>,
    pub started_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<u64>,
    /// Human-readable reason for the terminal status.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    /// Suppress automatic terminal notifications.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_notification_suppressed: Option<bool>,
    /// Deadline supplied at registration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

/// Extended info for process tasks.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessBackgroundTaskInfo {
    pub base: BackgroundTaskInfoBase,
    pub kind: BackgroundTaskKind,
    pub command: String,
    pub pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

/// Extended info for agent (subagent) tasks.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentBackgroundTaskInfo {
    pub base: BackgroundTaskInfoBase,
    pub kind: BackgroundTaskKind,
    /// Subagent identifier accepted by Agent(resume=...).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// Subagent profile name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_type: Option<String>,
}

/// Extended info for question tasks.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionBackgroundTaskInfo {
    pub base: BackgroundTaskInfoBase,
    pub kind: BackgroundTaskKind,
    pub question_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

/// Union of all background task info types.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum BackgroundTaskInfo {
    Process(ProcessBackgroundTaskInfo),
    Agent(AgentBackgroundTaskInfo),
    Question(QuestionBackgroundTaskInfo),
}

impl BackgroundTaskInfo {
    pub fn task_id(&self) -> &str {
        match self {
            BackgroundTaskInfo::Process(p) => &p.base.task_id,
            BackgroundTaskInfo::Agent(a) => &a.base.task_id,
            BackgroundTaskInfo::Question(q) => &q.base.task_id,
        }
    }

    pub fn status(&self) -> BackgroundTaskStatus {
        match self {
            BackgroundTaskInfo::Process(p) => p.base.status,
            BackgroundTaskInfo::Agent(a) => a.base.status,
            BackgroundTaskInfo::Question(q) => q.base.status,
        }
    }
}

/// Options for registering a background task.
#[derive(Debug, Clone)]
pub struct RegisterOptions {
    /// When false, a foreground tool call is still waiting for this task.
    pub detached: bool,
    /// Deadline in ms. 0 or None means no timer.
    pub timeout_ms: Option<u64>,
    /// When set, detaching resets the deadline to this value.
    pub detach_timeout_ms: Option<u64>,
    /// When true, a foreground timeout detaches to background instead of killing.
    pub auto_background_on_timeout: bool,
    /// Foreground caller signal (abort token).
    pub signal: Option<tokio::sync::watch::Receiver<bool>>,
}

impl Default for RegisterOptions {
    fn default() -> Self {
        Self {
            detached: false,
            timeout_ms: None,
            detach_timeout_ms: None,
            auto_background_on_timeout: false,
            signal: None,
        }
    }
}

/// Output snapshot for a background task.
#[derive(Debug, Clone)]
pub struct BackgroundTaskOutputSnapshot {
    pub output_path: Option<String>,
    pub output_size_bytes: u64,
    pub preview_bytes: u64,
    pub truncated: bool,
    pub full_output_available: bool,
    pub preview: String,
}

/// The BackgroundTask trait — concrete task implementations implement this.
pub trait BackgroundTask: Send + 'static {
    /// The kind of task (process, agent, question).
    fn kind(&self) -> BackgroundTaskKind;

    /// Human-readable description.
    fn description(&self) -> &str;

    /// Start the task. The sink is used to append output and settle the task.
    fn start(
        self: Box<Self>,
        sink: Box<dyn BackgroundTaskSink + Send>,
        signal: tokio::sync::watch::Receiver<bool>,
    ) -> Box<dyn std::future::Future<Output = ()> + Send>;

    /// Called when the task is detached from the foreground.
    fn on_detach(&self) {}

    /// Force-stop the task.
    fn force_stop(
        self: Box<Self>,
    ) -> Box<dyn std::future::Future<Output = ()> + Send>;
}

/// The sink that a BackgroundTask uses to communicate output and settlement.
pub trait BackgroundTaskSink: Send {
    /// Append output text to the task's ring buffer.
    fn append_output(&mut self, chunk: &str);

    /// Mark the task as settled (terminal).
    fn settle(&mut self, settlement: BackgroundTaskSettlement);
}

/// A handle for a process that was spawned by the JS host.
#[derive(Debug, Clone)]
pub struct ProcessHandle {
    pub pid: u32,
    pub native_process_id: String,
}

/// A handle for a subagent that was spawned.
#[derive(Debug, Clone)]
pub struct AgentHandle {
    pub agent_id: String,
}

const TERMINAL_STATUSES: [BackgroundTaskStatus; 5] = [
    BackgroundTaskStatus::Completed,
    BackgroundTaskStatus::Failed,
    BackgroundTaskStatus::TimedOut,
    BackgroundTaskStatus::Killed,
    BackgroundTaskStatus::Lost,
];

/// Returns true if the status is terminal.
pub fn is_terminal(status: BackgroundTaskStatus) -> bool {
    TERMINAL_STATUSES.contains(&status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_terminal_statuses() {
        assert!(BackgroundTaskStatus::Completed.is_terminal());
        assert!(BackgroundTaskStatus::Failed.is_terminal());
        assert!(BackgroundTaskStatus::TimedOut.is_terminal());
        assert!(BackgroundTaskStatus::Killed.is_terminal());
        assert!(BackgroundTaskStatus::Lost.is_terminal());
        assert!(!BackgroundTaskStatus::Running.is_terminal());
    }

    #[test]
    fn test_settlement_to_status() {
        let s: BackgroundTaskStatus = BackgroundTaskSettlementStatus::Completed.into();
        assert_eq!(s, BackgroundTaskStatus::Completed);
    }
}