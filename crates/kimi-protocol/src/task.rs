//! Task wire types — moved from
//! `packages/kimi-agent/src/task/types.rs` (Rust-first migration, stage A3).
//! Pure serde types + data accessors; settlement/reconcile logic stays in kimi-core.

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


