/// ActivityView — the agent's one-way activity projection.
///
/// A pure fold of the agent's own event stream: turn boundaries drive the turn
/// slice (active → detail updates → ended → `last_turn`), step/delta/tool/retry
/// events drive the live phase/stream/retry detail, permission approval events
/// drive the pending-approval list, while task and full-compaction events drive
/// the background-work slice.
///
/// The view OWNS NO authoritative state — every fact is folded from events and
/// seeded once from the owning services, so it can be discarded and rebuilt at
/// any time. Turn mechanics live in `turn_loop`, background work in `task` /
/// `compaction`; none of that is duplicated here.
///
/// Corresponds to `packages/agent-core-v2/src/agent/activityView/`.
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::context::types::MessageOrigin;

/// Background-work id used for the agent's full-compaction slot.
///
/// Mirrors `FULL_COMPACTION_BACKGROUND_ID` in `activityViewService.ts`.
pub const FULL_COMPACTION_BACKGROUND_ID: &str = "full-compaction";

/// What the turn is doing right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnPhase {
    Running,
    Streaming,
    ToolCall,
    Retrying,
}

/// Which stream is currently producing deltas.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamKind {
    Assistant,
    Thinking,
    ToolCall,
}

/// Why the turn is winding down, once a step has been interrupted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EndingReason {
    Aborted,
    MaxSteps,
    Error,
}

impl EndingReason {
    /// Parse the interrupt reason carried by `turn.step.interrupted`.
    ///
    /// The TS fold ignores any reason outside this set, so unknown values
    /// map to `None` rather than erroring.
    pub fn from_interrupt_reason(reason: &str) -> Option<Self> {
        match reason {
            "aborted" => Some(Self::Aborted),
            "max_steps" => Some(Self::MaxSteps),
            "error" => Some(Self::Error),
            _ => None,
        }
    }
}

/// Terminal outcome of a turn, in the flat form the activity view publishes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnEndReason {
    Completed,
    Cancelled,
    Failed,
    Blocked,
}

impl From<&crate::agent::types::TurnEndReason> for TurnEndReason {
    fn from(reason: &crate::agent::types::TurnEndReason) -> Self {
        use crate::agent::types::TurnEndReason as Agent;
        match reason {
            Agent::Completed => Self::Completed,
            Agent::Cancelled => Self::Cancelled,
            Agent::Failed(_) => Self::Failed,
            Agent::Blocked => Self::Blocked,
        }
    }
}

/// A tool call awaiting user approval.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalRef {
    pub approval_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    pub since: u64,
}

/// A tool call currently executing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallRef {
    pub tool_call_id: String,
    pub name: String,
    pub since: u64,
}

/// Live retry detail, present only while `phase == Retrying`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityRetryState {
    pub failed_attempt: u32,
    pub next_attempt: u32,
    pub max_attempts: u32,
    pub delay_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_code: Option<u16>,
}

/// The currently running turn.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityTurnState {
    pub turn_id: u32,
    pub origin: MessageOrigin,
    pub phase: TurnPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<StreamKind>,
    pub step: u32,
    pub ending: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ending_reason: Option<EndingReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<ActivityRetryState>,
    pub pending_approvals: Vec<ApprovalRef>,
    pub active_tool_calls: Vec<ToolCallRef>,
    pub since: u64,
}

/// Outcome of the most recently finished turn.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityLastTurnState {
    pub turn_id: u32,
    pub reason: TurnEndReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    pub at: u64,
}

/// Coarse existence reference to one piece of live background work.
///
/// Owner-specific details live in their own modules; this carries only
/// "there is live background work of this kind".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackgroundRef {
    pub kind: String,
    pub id: String,
    pub since: u64,
}

/// `ready` once materialized, `disposed` when the agent is being torn down.
///
/// There is deliberately no `initializing` state — the view is created lazily
/// and a restoring agent exposes no handles yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityViewLifecycle {
    Ready,
    Disposed,
}

/// The agent's folded activity snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentActivityState {
    pub lifecycle: ActivityViewLifecycle,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<ActivityTurnState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_turn: Option<ActivityLastTurnState>,
    pub background: Vec<BackgroundRef>,
}

impl AgentActivityState {
    fn empty() -> Self {
        Self {
            lifecycle: ActivityViewLifecycle::Ready,
            turn: None,
            last_turn: None,
            background: Vec::new(),
        }
    }
}

/// Receives every distinct snapshot the view produces.
///
/// Stands in for the `agent.activity.updated` event-bus publication in TS.
pub trait ActivityViewListener: Send + Sync {
    fn on_activity_updated(&self, state: &AgentActivityState);
}

/// The mutable in-flight turn. Rebuilt on every `turn.started`.
#[derive(Debug)]
struct MutableTurn {
    turn_id: u32,
    origin: MessageOrigin,
    phase: TurnPhase,
    stream: Option<StreamKind>,
    step: u32,
    ending: bool,
    ending_reason: Option<EndingReason>,
    retry: Option<ActivityRetryState>,
    /// Insertion-ordered, keyed by `tool_call_id` — mirrors the TS `Map`.
    pending_approvals: Vec<ApprovalRef>,
    /// Insertion-ordered, keyed by `tool_call_id` — mirrors the TS `Map`.
    active_tool_calls: Vec<ToolCallRef>,
    since: u64,
}

impl MutableTurn {
    fn new(turn_id: u32, origin: MessageOrigin, since: u64) -> Self {
        Self {
            turn_id,
            origin,
            phase: TurnPhase::Running,
            stream: None,
            step: 0,
            ending: false,
            ending_reason: None,
            retry: None,
            pending_approvals: Vec::new(),
            active_tool_calls: Vec::new(),
            since,
        }
    }

    fn snapshot(&self) -> ActivityTurnState {
        ActivityTurnState {
            turn_id: self.turn_id,
            origin: self.origin.clone(),
            phase: self.phase,
            stream: self.stream,
            step: self.step,
            ending: self.ending,
            ending_reason: self.ending_reason,
            retry: self.retry.clone(),
            pending_approvals: self.pending_approvals.clone(),
            active_tool_calls: self.active_tool_calls.clone(),
            since: self.since,
        }
    }

    /// `Map.set` semantics: replace in place when present, else append.
    fn put_approval(&mut self, entry: ApprovalRef) {
        let key = entry.tool_call_id.clone();
        match self
            .pending_approvals
            .iter_mut()
            .find(|a| a.tool_call_id == key)
        {
            Some(slot) => *slot = entry,
            None => self.pending_approvals.push(entry),
        }
    }

    fn remove_approval(&mut self, tool_call_id: &str) -> bool {
        let before = self.pending_approvals.len();
        self.pending_approvals
            .retain(|a| a.tool_call_id.as_deref() != Some(tool_call_id));
        self.pending_approvals.len() != before
    }

    fn put_tool_call(&mut self, entry: ToolCallRef) {
        match self
            .active_tool_calls
            .iter_mut()
            .find(|t| t.tool_call_id == entry.tool_call_id)
        {
            Some(slot) => *slot = entry,
            None => self.active_tool_calls.push(entry),
        }
    }

    fn remove_tool_call(&mut self, tool_call_id: &str) -> bool {
        let before = self.active_tool_calls.len();
        self.active_tool_calls
            .retain(|t| t.tool_call_id != tool_call_id);
        self.active_tool_calls.len() != before
    }
}

/// The agent activity view — fold events in, read snapshots out.
pub struct ActivityView {
    lifecycle: ActivityViewLifecycle,
    turn: Option<MutableTurn>,
    last_turn: Option<ActivityLastTurnState>,
    /// Insertion-ordered, keyed by `id` — mirrors the TS `Map`.
    background: Vec<BackgroundRef>,
    current: AgentActivityState,
    listener: Option<Arc<dyn ActivityViewListener>>,
}

impl ActivityView {
    pub fn new() -> Self {
        Self {
            lifecycle: ActivityViewLifecycle::Ready,
            turn: None,
            last_turn: None,
            background: Vec::new(),
            current: AgentActivityState::empty(),
            listener: None,
        }
    }

    pub fn with_listener(listener: Arc<dyn ActivityViewListener>) -> Self {
        let mut view = Self::new();
        view.listener = Some(listener);
        view
    }

    pub fn set_listener(&mut self, listener: Arc<dyn ActivityViewListener>) {
        self.listener = Some(listener);
    }

    /// The current folded snapshot. Cheap to clone; do not cache long-term.
    pub fn state(&self) -> &AgentActivityState {
        &self.current
    }

    // ── Seeding ──────────────────────────────────────────────────────────
    //
    // The view is created lazily and may attach to an agent that is already
    // mid-turn or already running background work. These seed the slices once
    // from the owning services (reads, never writes).

    /// Seed the turn slice when the loop is already running a turn.
    pub fn seed_turn(&mut self, active_turn_id: Option<u32>) {
        let Some(turn_id) = active_turn_id else {
            return;
        };
        self.turn = Some(MutableTurn::new(turn_id, MessageOrigin::User, now_ms()));
        self.publish();
    }

    /// Seed the background slice from the task registry — restart-persistent
    /// tasks may already be running when the view is created.
    pub fn seed_tasks(&mut self, tasks: impl IntoIterator<Item = BackgroundRef>) {
        let mut seeded = false;
        for info in tasks {
            self.put_background(info);
            seeded = true;
        }
        if seeded {
            self.publish();
        }
    }

    /// Seed the background slice when a full compaction is already in flight.
    pub fn seed_full_compaction(&mut self, compacting: bool) {
        if !compacting {
            return;
        }
        self.put_background(BackgroundRef {
            kind: "compaction".to_string(),
            id: FULL_COMPACTION_BACKGROUND_ID.to_string(),
            since: now_ms(),
        });
        self.publish();
    }

    // ── Turn lifecycle ───────────────────────────────────────────────────

    pub fn on_turn_started(&mut self, turn_id: u32, origin: Option<MessageOrigin>) {
        self.turn = Some(MutableTurn::new(
            turn_id,
            origin.unwrap_or(MessageOrigin::User),
            now_ms(),
        ));
        // A fresh turn means there is no current outcome: drop the previous
        // turn's terminal reason so consumers stop reporting it while this
        // turn runs. `on_turn_ended` publishes the new outcome when it
        // finishes.
        self.last_turn = None;
        self.publish();
    }

    pub fn on_turn_ended(&mut self, turn_id: u32, reason: TurnEndReason) {
        let at = now_ms();
        match &self.turn {
            // A turn the view never saw (e.g. seeded late) — still record the
            // outcome, but without a duration we cannot compute.
            Some(turn) if turn.turn_id == turn_id => {
                let duration_ms = at.saturating_sub(turn.since);
                self.last_turn = Some(ActivityLastTurnState {
                    turn_id,
                    reason,
                    duration_ms: Some(duration_ms),
                    at,
                });
                self.turn = None;
            }
            _ => {
                self.last_turn = Some(ActivityLastTurnState {
                    turn_id,
                    reason,
                    duration_ms: None,
                    at,
                });
            }
        }
        self.publish();
    }

    // ── Step / stream detail ─────────────────────────────────────────────

    pub fn on_step_started(&mut self, step: u32) {
        self.mutate_turn(|t| {
            t.step = step;
            t.phase = TurnPhase::Running;
            t.stream = None;
            t.retry = None;
        });
    }

    pub fn on_step_completed(&mut self) {
        self.mutate_turn(|t| {
            t.phase = TurnPhase::Running;
            t.stream = None;
            t.retry = None;
        });
    }

    pub fn on_step_retrying(&mut self, retry: ActivityRetryState) {
        self.mutate_turn(move |t| {
            t.phase = TurnPhase::Retrying;
            t.stream = None;
            t.retry = Some(retry);
        });
    }

    /// Unknown reasons are ignored, matching the TS guard.
    pub fn on_step_interrupted(&mut self, turn_id: u32, reason: &str) {
        let Some(ending_reason) = EndingReason::from_interrupt_reason(reason) else {
            return;
        };
        self.mutate_turn(|t| {
            if t.turn_id != turn_id {
                return;
            }
            t.ending = true;
            t.ending_reason = Some(ending_reason);
        });
    }

    pub fn on_delta(&mut self, stream: StreamKind) {
        self.mutate_turn(|t| {
            t.phase = TurnPhase::Streaming;
            t.stream = Some(stream);
            t.retry = None;
        });
    }

    // ── Tool calls ───────────────────────────────────────────────────────

    pub fn on_tool_call_started(&mut self, tool_call_id: &str, name: &str) {
        let entry = ToolCallRef {
            tool_call_id: tool_call_id.to_string(),
            name: name.to_string(),
            since: now_ms(),
        };
        self.mutate_turn(move |t| {
            t.phase = TurnPhase::ToolCall;
            t.stream = None;
            t.retry = None;
            t.put_tool_call(entry);
        });
    }

    pub fn on_tool_result(&mut self, tool_call_id: &str) {
        let id = tool_call_id.to_string();
        self.mutate_turn(|t| {
            t.remove_tool_call(&id);
            t.phase = if t.active_tool_calls.is_empty() {
                TurnPhase::Running
            } else {
                TurnPhase::ToolCall
            };
            t.stream = None;
            t.retry = None;
        });
    }

    // ── Permission approvals ─────────────────────────────────────────────

    pub fn on_approval_requested(&mut self, tool_call_id: &str) {
        let entry = ApprovalRef {
            approval_id: tool_call_id.to_string(),
            tool_call_id: Some(tool_call_id.to_string()),
            since: now_ms(),
        };
        self.mutate_turn(move |t| t.put_approval(entry));
    }

    pub fn on_approval_resolved(&mut self, tool_call_id: &str) {
        let id = tool_call_id.to_string();
        self.mutate_turn(|t| {
            t.remove_approval(&id);
        });
    }

    // ── Background work ──────────────────────────────────────────────────

    pub fn on_task_started(&mut self, task_id: &str, kind: &str, started_at: u64) {
        self.put_background(BackgroundRef {
            kind: kind.to_string(),
            id: task_id.to_string(),
            since: started_at,
        });
        self.publish();
    }

    pub fn on_task_terminated(&mut self, task_id: &str) {
        if self.remove_background(task_id) {
            self.publish();
        }
    }

    pub fn on_compaction_started(&mut self) {
        self.put_background(BackgroundRef {
            kind: "compaction".to_string(),
            id: FULL_COMPACTION_BACKGROUND_ID.to_string(),
            since: now_ms(),
        });
        self.publish();
    }

    pub fn on_compaction_completed(&mut self) {
        self.on_full_compaction_ended();
    }

    pub fn on_compaction_cancelled(&mut self) {
        self.on_full_compaction_ended();
    }

    fn on_full_compaction_ended(&mut self) {
        if self.remove_background(FULL_COMPACTION_BACKGROUND_ID) {
            self.publish();
        }
    }

    // ── Teardown ─────────────────────────────────────────────────────────

    pub fn dispose(&mut self) {
        self.lifecycle = ActivityViewLifecycle::Disposed;
        self.publish();
    }

    // ── Internals ────────────────────────────────────────────────────────

    /// `Map.set` semantics on the insertion-ordered background list.
    fn put_background(&mut self, entry: BackgroundRef) {
        match self.background.iter_mut().find(|b| b.id == entry.id) {
            Some(slot) => *slot = entry,
            None => self.background.push(entry),
        }
    }

    fn remove_background(&mut self, id: &str) -> bool {
        let before = self.background.len();
        self.background.retain(|b| b.id != id);
        self.background.len() != before
    }

    /// Apply a mutation to the in-flight turn, then republish.
    ///
    /// A no-op mutation is harmless: `publish` suppresses snapshots that are
    /// equal to the current one.
    fn mutate_turn(&mut self, mutate: impl FnOnce(&mut MutableTurn)) {
        let Some(turn) = self.turn.as_mut() else {
            return;
        };
        mutate(turn);
        self.publish();
    }

    /// Recompute the snapshot, then notify only if it differs coarsely.
    ///
    /// DIVERGENCE FROM TS: `activityViewService.ts` returns early *before*
    /// assigning `this.current`, so its `state()` keeps serving a stale
    /// snapshot whenever a change touches only a field `activityEqual`
    /// ignores (tool-call names, timestamps, retry detail). Here `current` is
    /// always refreshed and only the notification is gated.
    ///
    /// This cannot change which updates get published. `activity_equal` tests
    /// equality of a fixed projection, so it is an equivalence relation: if
    /// the unpublished snapshot `x` is equivalent to the last published `p`,
    /// then any later `y` satisfies `y ≡ x` exactly when `y ≡ p`. Comparing
    /// against the refreshed `current` therefore yields the same decisions as
    /// comparing against the last published state.
    fn publish(&mut self) {
        let next = AgentActivityState {
            lifecycle: self.lifecycle,
            turn: self.turn.as_ref().map(MutableTurn::snapshot),
            last_turn: self.last_turn.clone(),
            background: self.background.clone(),
        };
        let changed = !activity_equal(&self.current, &next);
        self.current = next;
        if changed {
            if let Some(listener) = &self.listener {
                listener.on_activity_updated(&self.current);
            }
        }
    }
}

impl Default for ActivityView {
    fn default() -> Self {
        Self::new()
    }
}

/// Coarse structural equality used to suppress redundant publications.
///
/// Deliberately ignores timestamps, origin, tool-call names and all retry
/// detail except `next_attempt` — those never change without one of the
/// compared fields changing too. Ported field-for-field from `activityEqual`
/// in `activityViewService.ts`.
pub fn activity_equal(a: &AgentActivityState, b: &AgentActivityState) -> bool {
    if a.lifecycle != b.lifecycle {
        return false;
    }
    if a.turn.is_some() != b.turn.is_some() {
        return false;
    }
    if let (Some(ta), Some(tb)) = (&a.turn, &b.turn) {
        if ta.turn_id != tb.turn_id
            || ta.phase != tb.phase
            || ta.stream != tb.stream
            || ta.step != tb.step
            || ta.ending != tb.ending
            || ta.ending_reason != tb.ending_reason
            || ta.pending_approvals.len() != tb.pending_approvals.len()
            || ta.active_tool_calls.len() != tb.active_tool_calls.len()
        {
            return false;
        }
        let next_a = ta.retry.as_ref().map(|r| r.next_attempt);
        let next_b = tb.retry.as_ref().map(|r| r.next_attempt);
        if next_a != next_b {
            return false;
        }
    }
    if a.last_turn.is_some() != b.last_turn.is_some() {
        return false;
    }
    if let (Some(la), Some(lb)) = (&a.last_turn, &b.last_turn) {
        if la.turn_id != lb.turn_id || la.reason != lb.reason {
            return false;
        }
    }
    if a.background.len() != b.background.len() {
        return false;
    }
    a.background
        .iter()
        .zip(b.background.iter())
        .all(|(x, y)| x.id == y.id && x.kind == y.kind)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Recorder {
        states: Mutex<Vec<AgentActivityState>>,
    }

    impl ActivityViewListener for Recorder {
        fn on_activity_updated(&self, state: &AgentActivityState) {
            self.states
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(state.clone());
        }
    }

    impl Recorder {
        fn count(&self) -> usize {
            self.states.lock().unwrap_or_else(|e| e.into_inner()).len()
        }
    }

    fn view() -> (ActivityView, Arc<Recorder>) {
        let rec = Arc::new(Recorder::default());
        (ActivityView::with_listener(rec.clone()), rec)
    }

    fn retry(next_attempt: u32) -> ActivityRetryState {
        ActivityRetryState {
            failed_attempt: next_attempt - 1,
            next_attempt,
            max_attempts: 3,
            delay_ms: 500,
            error_name: Some("RateLimit".to_string()),
            status_code: Some(429),
        }
    }

    #[test]
    fn starts_empty_and_ready() {
        let (v, _) = view();
        assert_eq!(v.state().lifecycle, ActivityViewLifecycle::Ready);
        assert!(v.state().turn.is_none());
        assert!(v.state().last_turn.is_none());
        assert!(v.state().background.is_empty());
    }

    #[test]
    fn turn_started_creates_running_turn() {
        let (mut v, rec) = view();
        v.on_turn_started(1, None);
        let turn = v.state().turn.as_ref().expect("turn");
        assert_eq!(turn.turn_id, 1);
        assert_eq!(turn.phase, TurnPhase::Running);
        assert_eq!(turn.step, 0);
        assert!(!turn.ending);
        assert_eq!(rec.count(), 1);
    }

    #[test]
    fn turn_started_clears_previous_outcome() {
        let (mut v, _) = view();
        v.on_turn_started(1, None);
        v.on_turn_ended(1, TurnEndReason::Completed);
        assert!(v.state().last_turn.is_some());
        v.on_turn_started(2, None);
        assert!(v.state().last_turn.is_none());
    }

    #[test]
    fn turn_ended_records_outcome_and_duration() {
        let (mut v, _) = view();
        v.on_turn_started(7, None);
        v.on_turn_ended(7, TurnEndReason::Completed);
        let last = v.state().last_turn.as_ref().expect("last_turn");
        assert_eq!(last.turn_id, 7);
        assert_eq!(last.reason, TurnEndReason::Completed);
        assert!(last.duration_ms.is_some());
        assert!(v.state().turn.is_none());
    }

    #[test]
    fn turn_ended_for_unseen_turn_records_without_duration() {
        let (mut v, _) = view();
        v.on_turn_ended(99, TurnEndReason::Failed);
        let last = v.state().last_turn.as_ref().expect("last_turn");
        assert_eq!(last.turn_id, 99);
        assert_eq!(last.reason, TurnEndReason::Failed);
        assert!(last.duration_ms.is_none());
    }

    #[test]
    fn turn_ended_with_mismatched_id_keeps_active_turn() {
        let (mut v, _) = view();
        v.on_turn_started(1, None);
        v.on_turn_ended(2, TurnEndReason::Cancelled);
        assert!(v.state().turn.is_some(), "unrelated turn must survive");
        assert_eq!(v.state().last_turn.as_ref().unwrap().turn_id, 2);
    }

    #[test]
    fn deltas_move_turn_into_streaming() {
        let (mut v, _) = view();
        v.on_turn_started(1, None);
        v.on_delta(StreamKind::Thinking);
        let turn = v.state().turn.as_ref().unwrap();
        assert_eq!(turn.phase, TurnPhase::Streaming);
        assert_eq!(turn.stream, Some(StreamKind::Thinking));
    }

    #[test]
    fn events_without_a_turn_are_ignored() {
        let (mut v, rec) = view();
        v.on_delta(StreamKind::Assistant);
        v.on_step_started(3);
        v.on_tool_call_started("t1", "Read");
        assert!(v.state().turn.is_none());
        assert_eq!(rec.count(), 0);
    }

    #[test]
    fn tool_calls_track_active_set_and_phase() {
        let (mut v, _) = view();
        v.on_turn_started(1, None);
        v.on_tool_call_started("t1", "Read");
        v.on_tool_call_started("t2", "Grep");
        assert_eq!(v.state().turn.as_ref().unwrap().active_tool_calls.len(), 2);
        assert_eq!(v.state().turn.as_ref().unwrap().phase, TurnPhase::ToolCall);

        v.on_tool_result("t1");
        let turn = v.state().turn.as_ref().unwrap();
        assert_eq!(turn.active_tool_calls.len(), 1);
        assert_eq!(turn.phase, TurnPhase::ToolCall, "one call still running");

        v.on_tool_result("t2");
        let turn = v.state().turn.as_ref().unwrap();
        assert!(turn.active_tool_calls.is_empty());
        assert_eq!(turn.phase, TurnPhase::Running);
    }

    #[test]
    fn tool_call_started_twice_replaces_in_place() {
        let (mut v, _) = view();
        v.on_turn_started(1, None);
        v.on_tool_call_started("t1", "Read");
        v.on_tool_call_started("t2", "Grep");
        v.on_tool_call_started("t1", "Read2");
        let calls = &v.state().turn.as_ref().unwrap().active_tool_calls;
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].tool_call_id, "t1", "insertion order preserved");
        // Name-only changes are invisible to `activity_equal`, so no
        // notification fires — but `state()` must still be current.
        assert_eq!(calls[0].name, "Read2");
    }

    #[test]
    fn state_stays_current_even_when_no_notification_fires() {
        let (mut v, rec) = view();
        v.on_turn_started(1, None);
        v.on_tool_call_started("t1", "Read");
        let published = rec.count();
        v.on_tool_call_started("t1", "Write");
        assert_eq!(rec.count(), published, "coarse-equal update must not notify");
        assert_eq!(
            v.state().turn.as_ref().unwrap().active_tool_calls[0].name,
            "Write",
            "state() must not serve a stale snapshot"
        );
    }

    #[test]
    fn approvals_are_tracked_and_resolved() {
        let (mut v, _) = view();
        v.on_turn_started(1, None);
        v.on_approval_requested("t1");
        let approvals = &v.state().turn.as_ref().unwrap().pending_approvals;
        assert_eq!(approvals.len(), 1);
        assert_eq!(approvals[0].approval_id, "t1");
        assert_eq!(approvals[0].tool_call_id.as_deref(), Some("t1"));

        v.on_approval_resolved("t1");
        assert!(
            v.state()
                .turn
                .as_ref()
                .unwrap()
                .pending_approvals
                .is_empty()
        );
    }

    #[test]
    fn retry_sets_phase_and_detail_then_clears() {
        let (mut v, _) = view();
        v.on_turn_started(1, None);
        v.on_step_retrying(retry(2));
        let turn = v.state().turn.as_ref().unwrap();
        assert_eq!(turn.phase, TurnPhase::Retrying);
        assert_eq!(turn.retry.as_ref().unwrap().next_attempt, 2);
        assert_eq!(turn.retry.as_ref().unwrap().status_code, Some(429));

        v.on_step_completed();
        let turn = v.state().turn.as_ref().unwrap();
        assert_eq!(turn.phase, TurnPhase::Running);
        assert!(turn.retry.is_none());
    }

    #[test]
    fn step_interrupted_marks_ending_only_for_known_reasons() {
        let (mut v, _) = view();
        v.on_turn_started(1, None);

        v.on_step_interrupted(1, "something_else");
        assert!(!v.state().turn.as_ref().unwrap().ending);

        v.on_step_interrupted(1, "max_steps");
        let turn = v.state().turn.as_ref().unwrap();
        assert!(turn.ending);
        assert_eq!(turn.ending_reason, Some(EndingReason::MaxSteps));
    }

    #[test]
    fn step_interrupted_for_other_turn_is_ignored() {
        let (mut v, _) = view();
        v.on_turn_started(1, None);
        v.on_step_interrupted(2, "aborted");
        assert!(!v.state().turn.as_ref().unwrap().ending);
    }

    #[test]
    fn background_tracks_tasks_and_compaction() {
        let (mut v, _) = view();
        v.on_task_started("task-1", "subagent", 1000);
        v.on_compaction_started();
        assert_eq!(v.state().background.len(), 2);
        assert_eq!(v.state().background[0].id, "task-1");
        assert_eq!(v.state().background[1].id, FULL_COMPACTION_BACKGROUND_ID);

        v.on_compaction_completed();
        assert_eq!(v.state().background.len(), 1);
        v.on_task_terminated("task-1");
        assert!(v.state().background.is_empty());
    }

    #[test]
    fn terminating_unknown_task_publishes_nothing() {
        let (mut v, rec) = view();
        v.on_task_terminated("nope");
        v.on_compaction_completed();
        assert_eq!(rec.count(), 0);
    }

    #[test]
    fn seeding_restores_turn_and_background() {
        let (mut v, _) = view();
        v.seed_turn(Some(42));
        v.seed_tasks([BackgroundRef {
            kind: "subagent".into(),
            id: "task-9".into(),
            since: 5,
        }]);
        v.seed_full_compaction(true);
        assert_eq!(v.state().turn.as_ref().unwrap().turn_id, 42);
        assert_eq!(v.state().background.len(), 2);
    }

    #[test]
    fn seeding_with_nothing_running_is_a_no_op() {
        let (mut v, rec) = view();
        v.seed_turn(None);
        v.seed_tasks(Vec::new());
        v.seed_full_compaction(false);
        assert_eq!(rec.count(), 0);
    }

    #[test]
    fn redundant_updates_are_not_republished() {
        let (mut v, rec) = view();
        v.on_turn_started(1, None);
        assert_eq!(rec.count(), 1);
        // Same step, same phase — structurally identical snapshot.
        v.on_step_started(0);
        assert_eq!(rec.count(), 1, "no-op fold must not republish");
        v.on_step_started(1);
        assert_eq!(rec.count(), 2);
    }

    #[test]
    fn dispose_marks_lifecycle_and_publishes() {
        let (mut v, rec) = view();
        let before = rec.count();
        v.dispose();
        assert_eq!(v.state().lifecycle, ActivityViewLifecycle::Disposed);
        assert_eq!(rec.count(), before + 1);
    }

    #[test]
    fn activity_equal_ignores_timestamps_and_names() {
        let base = AgentActivityState {
            lifecycle: ActivityViewLifecycle::Ready,
            turn: Some(ActivityTurnState {
                turn_id: 1,
                origin: MessageOrigin::User,
                phase: TurnPhase::ToolCall,
                stream: None,
                step: 2,
                ending: false,
                ending_reason: None,
                retry: None,
                pending_approvals: vec![],
                active_tool_calls: vec![ToolCallRef {
                    tool_call_id: "t1".into(),
                    name: "Read".into(),
                    since: 1,
                }],
                since: 1,
            }),
            last_turn: None,
            background: vec![],
        };
        let mut other = base.clone();
        {
            let turn = other.turn.as_mut().unwrap();
            turn.since = 999;
            turn.active_tool_calls[0].since = 999;
            turn.active_tool_calls[0].name = "Grep".into();
        }
        assert!(activity_equal(&base, &other));

        let mut changed = base.clone();
        changed.turn.as_mut().unwrap().step = 3;
        assert!(!activity_equal(&base, &changed));
    }

    #[test]
    fn activity_equal_detects_retry_progress() {
        let mk = |next: Option<u32>| AgentActivityState {
            lifecycle: ActivityViewLifecycle::Ready,
            turn: Some(ActivityTurnState {
                turn_id: 1,
                origin: MessageOrigin::User,
                phase: TurnPhase::Retrying,
                stream: None,
                step: 1,
                ending: false,
                ending_reason: None,
                retry: next.map(retry),
                pending_approvals: vec![],
                active_tool_calls: vec![],
                since: 1,
            }),
            last_turn: None,
            background: vec![],
        };
        assert!(activity_equal(&mk(Some(2)), &mk(Some(2))));
        assert!(!activity_equal(&mk(Some(2)), &mk(Some(3))));
        assert!(!activity_equal(&mk(Some(2)), &mk(None)));
    }

    #[test]
    fn turn_end_reason_converts_from_agent_reason() {
        use crate::agent::types::{TurnEndReason as Agent, TurnError};
        assert_eq!(TurnEndReason::from(&Agent::Completed), TurnEndReason::Completed);
        assert_eq!(TurnEndReason::from(&Agent::Cancelled), TurnEndReason::Cancelled);
        assert_eq!(TurnEndReason::from(&Agent::Blocked), TurnEndReason::Blocked);
        let failed = Agent::Failed(TurnError {
            message: "boom".into(),
            code: "E".into(),
            retryable: false,
        });
        assert_eq!(TurnEndReason::from(&failed), TurnEndReason::Failed);
    }
}
