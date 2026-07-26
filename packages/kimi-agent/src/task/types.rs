/// `task` domain — status, settlement, and info types.
///
/// Faithful port of `packages/agent-core-v2/src/agent/task/types.ts`.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Running,
    Completed,
    Failed,
    TimedOut,
    Killed,
    Lost,
}

pub const TERMINAL_STATUSES: &[TaskStatus] = &[
    TaskStatus::Completed,
    TaskStatus::Failed,
    TaskStatus::TimedOut,
    TaskStatus::Killed,
    TaskStatus::Lost,
];

impl TaskStatus {
    pub fn is_terminal(self) -> bool {
        TERMINAL_STATUSES.contains(&self)
    }

    /// The wire spelling, matching the TS string union.
    pub fn as_str(self) -> &'static str {
        match self {
            TaskStatus::Running => "running",
            TaskStatus::Completed => "completed",
            TaskStatus::Failed => "failed",
            TaskStatus::TimedOut => "timed_out",
            TaskStatus::Killed => "killed",
            TaskStatus::Lost => "lost",
        }
    }

    /// Human-facing spelling used in notification bodies (TS interpolates the
    /// raw status except for `timed_out`, which reads "timed out").
    pub fn human_label(self) -> &'static str {
        match self {
            TaskStatus::TimedOut => "timed out",
            other => other.as_str(),
        }
    }
}

/// The subset of statuses a task may settle into of its own accord — `lost` is
/// only ever assigned by reconcile, never by a settlement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskSettlementStatus {
    Completed,
    Failed,
    TimedOut,
    Killed,
}

impl From<TaskSettlementStatus> for TaskStatus {
    fn from(value: TaskSettlementStatus) -> Self {
        match value {
            TaskSettlementStatus::Completed => TaskStatus::Completed,
            TaskSettlementStatus::Failed => TaskStatus::Failed,
            TaskSettlementStatus::TimedOut => TaskStatus::TimedOut,
            TaskSettlementStatus::Killed => TaskStatus::Killed,
        }
    }
}

#[derive(Debug, Clone)]
pub struct TaskSettlement {
    pub status: TaskSettlementStatus,
    pub stop_reason: Option<String>,
}

/// Why a foreground task released its caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForegroundTaskReleaseReason {
    Detached,
    TimeoutDetached,
    Terminal,
}

/// The durable record for one task.
///
/// TS splits this into `AgentTaskInfoBase` plus a per-kind variant; the kind
/// discriminant and the subagent id are folded in here so the service can hold
/// one record type for both live tasks and restored ghosts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskInfoBase {
    pub task_id: String,
    pub description: String,
    pub status: TaskStatus,
    pub kind: String,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    /// Whether the task currently runs detached. Derived from whether a
    /// foreground release is still outstanding, never stored on the live entry.
    pub detached: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub terminal_notification_suppressed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    /// Present only for `agent` tasks — the resumable subagent id, which lives
    /// in a different namespace from `task_id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
}

impl TaskInfoBase {
    pub fn duration_ms(&self) -> Option<u64> {
        self.ended_at.map(|ended| ended.saturating_sub(self.started_at))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessTaskInfo {
    pub base: TaskInfoBase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSubTaskInfo {
    pub base: TaskInfoBase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionTaskInfo {
    pub base: TaskInfoBase,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum TaskInfoByKind {
    #[serde(rename = "process")]
    Process(ProcessTaskInfo),
    #[serde(rename = "agent")]
    Agent(AgentSubTaskInfo),
    #[serde(rename = "question")]
    Question(QuestionTaskInfo),
}

impl TaskInfoByKind {
    pub fn base(&self) -> &TaskInfoBase {
        match self {
            Self::Process(p) => &p.base,
            Self::Agent(a) => &a.base,
            Self::Question(q) => &q.base,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::Process(_) => "process",
            Self::Agent(_) => "agent",
            Self::Question(_) => "question",
        }
    }

    pub fn task_id(&self) -> &str {
        &self.base().task_id
    }

    pub fn status(&self) -> TaskStatus {
        self.base().status
    }

    pub fn description(&self) -> &str {
        &self.base().description
    }

    pub fn detached(&self) -> bool {
        self.base().detached
    }
}

/// A view of a task's output at a point in time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskOutputSnapshot {
    /// Path to the persisted output log, when one exists.
    pub output_path: Option<String>,
    /// Total bytes the task has ever produced.
    pub output_size_bytes: usize,
    /// Bytes carried in `preview`.
    pub preview_bytes: usize,
    /// Whether `preview` is shorter than the full output.
    pub truncated: bool,
    /// Whether the full output can be re-read from persistence.
    pub full_output_available: bool,
    pub preview: String,
}

impl TaskOutputSnapshot {
    pub fn empty() -> Self {
        Self {
            output_path: None,
            output_size_bytes: 0,
            preview_bytes: 0,
            truncated: false,
            full_output_available: false,
            preview: String::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_statuses_are_exactly_the_five() {
        for status in [
            TaskStatus::Completed,
            TaskStatus::Failed,
            TaskStatus::TimedOut,
            TaskStatus::Killed,
            TaskStatus::Lost,
        ] {
            assert!(status.is_terminal(), "{status:?} should be terminal");
        }
        assert!(!TaskStatus::Running.is_terminal());
    }

    #[test]
    fn status_serialises_to_the_ts_spelling() {
        // The wire record is shared with the TS writer, so the spelling is
        // load-bearing — `TimedOut` must round-trip as `timed_out`.
        assert_eq!(serde_json::to_string(&TaskStatus::TimedOut).unwrap(), "\"timed_out\"");
        assert_eq!(serde_json::to_string(&TaskStatus::Running).unwrap(), "\"running\"");
        let parsed: TaskStatus = serde_json::from_str("\"timed_out\"").unwrap();
        assert_eq!(parsed, TaskStatus::TimedOut);
    }

    #[test]
    fn status_labels() {
        assert_eq!(TaskStatus::TimedOut.as_str(), "timed_out");
        assert_eq!(TaskStatus::TimedOut.human_label(), "timed out");
        assert_eq!(TaskStatus::Completed.human_label(), "completed");
    }

    #[test]
    fn settlement_status_widens_to_task_status() {
        assert_eq!(TaskStatus::from(TaskSettlementStatus::Killed), TaskStatus::Killed);
        assert_eq!(TaskStatus::from(TaskSettlementStatus::TimedOut), TaskStatus::TimedOut);
    }

    #[test]
    fn duration_is_none_while_running() {
        let mut info = info_fixture();
        assert_eq!(info.duration_ms(), None);
        info.ended_at = Some(1_500);
        assert_eq!(info.duration_ms(), Some(500));
    }

    #[test]
    fn by_kind_accessors_read_through_to_the_base() {
        let base = info_fixture();
        let process = TaskInfoByKind::Process(ProcessTaskInfo {
            base: base.clone(),
            command: None,
            pid: None,
            exit_code: None,
        });
        assert_eq!(process.kind(), "process");
        assert_eq!(process.task_id(), "task-abc");
        assert_eq!(process.status(), TaskStatus::Running);
        assert_eq!(process.description(), "a test");
        assert!(!process.detached());

        let agent = TaskInfoByKind::Agent(AgentSubTaskInfo {
            base: base.clone(),
            agent_id: Some("agent-xyz".to_string()),
            subagent_type: None,
        });
        assert_eq!(agent.kind(), "agent");

        let question = TaskInfoByKind::Question(QuestionTaskInfo { base });
        assert_eq!(question.kind(), "question");
    }

    #[test]
    fn empty_snapshot_has_no_output() {
        let snapshot = TaskOutputSnapshot::empty();
        assert_eq!(snapshot.preview, "");
        assert_eq!(snapshot.output_size_bytes, 0);
        assert!(!snapshot.truncated);
        assert!(!snapshot.full_output_available);
        assert_eq!(snapshot.output_path, None);
    }

    fn info_fixture() -> TaskInfoBase {
        TaskInfoBase {
            task_id: "task-abc".to_string(),
            description: "a test".to_string(),
            status: TaskStatus::Running,
            kind: "process".to_string(),
            started_at: 1_000,
            ended_at: None,
            detached: false,
            stop_reason: None,
            terminal_notification_suppressed: false,
            timeout_ms: None,
            agent_id: None,
        }
    }
}
