/// PromptService — agent-scoped prompt queue and lifecycle manager.
///
/// Corresponds to `packages/agent-core-v2/src/agent/prompt/`.
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use crate::context::types::{ContextMessage, MessageOrigin};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PromptState {
    #[serde(rename = "pending")] Pending,
    #[serde(rename = "running")] Running,
    #[serde(rename = "steered")] Steered,
    #[serde(rename = "completed")] Completed,
    #[serde(rename = "failed")] Failed,
    #[serde(rename = "cancelled")] Cancelled,
    #[serde(rename = "blocked")] Blocked,
}

impl PromptState {
    pub fn is_terminal(self) -> bool {
        matches!(self, PromptState::Completed | PromptState::Failed | PromptState::Cancelled | PromptState::Blocked)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptSnapshot {
    pub id: String,
    pub user_message_id: String,
    pub created_at: u64,
    pub state: PromptState,
    pub message: ContextMessage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptCompletion {
    pub prompt_id: String,
    pub turn_id: Option<String>,
    pub result: Option<TurnResult>,
    pub state: PromptState,
}

#[derive(Debug, Clone)]
pub struct PromptHandle {
    pub id: String,
    pub user_message_id: String,
    pub created_at: u64,
    pub state: PromptState,
    pub message: ContextMessage,
    pub launched: watch::Receiver<Option<String>>,
    pub completion: watch::Receiver<PromptCompletion>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptQueueSnapshot {
    pub active: Option<PromptSnapshot>,
    pub pending: Vec<PromptSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnResult {
    pub turn_id: String,
    pub result_type: TurnResultType,
    pub steps: u32,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TurnResultType {
    #[serde(rename = "completed")] Completed,
    #[serde(rename = "failed")] Failed,
    #[serde(rename = "cancelled")] Cancelled,
    #[serde(rename = "blocked")] Blocked,
}

#[derive(Debug, Clone)]
pub struct PromptInput {
    pub id: Option<String>,
    pub message: ContextMessage,
}

// ── StepRequest types ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepRequestKind { Prompt, Steer, Retry }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionMode { NewTurn, ActiveTurnOnly, ActiveOrNewTurn }

#[derive(Debug, Clone)]
pub struct StepRequestOptions {
    pub admission: AdmissionMode,
    pub mergeable: bool,
    pub turn_scoped: bool,
}
impl Default for StepRequestOptions {
    fn default() -> Self { Self { admission: AdmissionMode::NewTurn, mergeable: false, turn_scoped: true } }
}

#[derive(Debug, Clone)]
pub struct PromptStepRequest {
    pub message: ContextMessage,
    pub options: StepRequestOptions,
}
impl PromptStepRequest {
    pub fn new(message: ContextMessage) -> Self {
        Self { message, options: StepRequestOptions { admission: AdmissionMode::NewTurn, mergeable: false, turn_scoped: true } }
    }
}

#[derive(Debug, Clone)]
pub struct SteerStepRequest {
    pub message: ContextMessage,
    pub options: StepRequestOptions,
}
impl SteerStepRequest {
    pub fn new(message: ContextMessage, admission: AdmissionMode) -> Self {
        Self { message, options: StepRequestOptions { admission, mergeable: true, turn_scoped: false } }
    }
}

#[derive(Debug, Clone)]
pub struct RetryStepRequest {
    pub options: StepRequestOptions,
}
impl Default for RetryStepRequest {
    fn default() -> Self { Self { options: StepRequestOptions { admission: AdmissionMode::NewTurn, mergeable: false, turn_scoped: true } } }
}

// ── Delegation ──────────────────────────────────────────────────────────────────

pub trait PromptLoopDelegate: Send + Sync {
    fn enqueue_step(&self, kind: StepRequestKind, message: Option<ContextMessage>) -> Turn;
    fn cancel_turn(&self, turn_id: &str, reason: &str);
}

#[derive(Debug)]
pub struct Turn {
    pub id: String,
    pub result_rx: tokio::sync::oneshot::Receiver<TurnResult>,
}

#[derive(Debug, Clone)]
pub enum PromptError {
    NotFound(String),
    InvalidRequest(String),
    NoActivePrompt,
}
impl std::fmt::Display for PromptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self { PromptError::NotFound(id) => write!(f, "prompt not found: {id}"), PromptError::InvalidRequest(msg) => write!(f, "invalid request: {msg}"), PromptError::NoActivePrompt => write!(f, "no active prompt to steer into") }
    }
}
impl std::error::Error for PromptError {}

// ── Internal ────────────────────────────────────────────────────────────────────

struct Record {
    snapshot: PromptSnapshot,
    launched_tx: watch::Sender<Option<String>>,
    completion_tx: watch::Sender<PromptCompletion>,
    launched_rx: watch::Receiver<Option<String>>,
    completion_rx: watch::Receiver<PromptCompletion>,
}
impl Record {
    fn new(id: String, message: ContextMessage) -> Self {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
        let snapshot = PromptSnapshot { id: id.clone(), user_message_id: id.clone(), created_at: now, state: PromptState::Pending, message };
        let (launched_tx, launched_rx) = watch::channel(None);
        let (completion_tx, completion_rx) = watch::channel(PromptCompletion { prompt_id: id, turn_id: None, result: None, state: PromptState::Pending });
        Self { snapshot, launched_tx, completion_tx, launched_rx, completion_rx }
    }
    fn handle(&self) -> PromptHandle {
        PromptHandle { id: self.snapshot.id.clone(), user_message_id: self.snapshot.user_message_id.clone(), created_at: self.snapshot.created_at, state: self.snapshot.state, message: self.snapshot.message.clone(), launched: self.launched_rx.clone(), completion: self.completion_rx.clone() }
    }
}
struct ActiveRecord { record: Record, turn_id: String }
struct Inner { active: Option<ActiveRecord>, pending: Vec<Record>, steered: HashMap<String, Vec<Record>>, launching: bool, next_id: u64 }

// ── PromptService ───────────────────────────────────────────────────────────────

pub struct PromptService {
    inner: Arc<std::sync::Mutex<Inner>>,
    delegate: Arc<dyn PromptLoopDelegate>,
}
impl PromptService {
    pub fn new(delegate: Arc<dyn PromptLoopDelegate>) -> Self {
        Self { inner: Arc::new(std::sync::Mutex::new(Inner { active: None, pending: Vec::new(), steered: HashMap::new(), launching: false, next_id: 1 })), delegate }
    }

    pub async fn enqueue(&self, input: PromptInput) -> PromptHandle {
        let id = input.id.unwrap_or_else(|| { let mut inner = self.inner.lock().unwrap(); let n = inner.next_id; inner.next_id += 1; format!("prompt_{n}") });
        let record = Record::new(id, input.message);
        let handle = record.handle();
        let should_start = { let mut inner = self.inner.lock().unwrap(); inner.pending.push(record); inner.active.is_none() && !inner.launching };
        if should_start {
            if let Some(st) = Self::try_start_next(&self.inner, &*self.delegate) {
                Self::spawn_settle(Arc::clone(&self.inner), Arc::clone(&self.delegate), st);
            }
        }
        handle
    }

    pub fn steer(&self, prompt_ids: &[String]) -> Result<Vec<PromptHandle>, PromptError> {
        if prompt_ids.is_empty() { return Err(PromptError::InvalidRequest("prompt_ids must not be empty".into())); }
        let mut inner = self.inner.lock().unwrap();
        let active = inner.active.as_ref().ok_or(PromptError::NoActivePrompt)?;
        let active_id = active.record.snapshot.id.clone();
        let active_turn_id = active.turn_id.clone();
        let ids: std::collections::HashSet<&str> = prompt_ids.iter().map(|s| s.as_str()).collect();
        if ids.len() != prompt_ids.len() { return Err(PromptError::InvalidRequest("duplicate prompt_ids".into())); }
        let mut selected = Vec::new();
        let mut remaining = Vec::new();
        for record in inner.pending.drain(..) { if ids.contains(record.snapshot.id.as_str()) { selected.push(record); } else { remaining.push(record); } }
        inner.pending = remaining;
        if selected.len() != ids.len() { return Err(PromptError::InvalidRequest("one or more prompts are not pending".into())); }
        let msg = ContextMessage {
            role: "user".into(),
            content: selected.iter().flat_map(|r| r.snapshot.message.content.clone()).collect(),
            tool_calls: vec![], tool_call_id: None,
            origin: Some(MessageOrigin::User),
            is_error: None, partial: None, name: None, note: None, tools: None,
        };
        let _turn = self.delegate.enqueue_step(StepRequestKind::Steer, Some(msg));

        // Update state in-place via index to avoid borrow conflicts.
        for i in 0..selected.len() {
            selected[i].snapshot.state = PromptState::Steered;
            selected[i].launched_tx.send_replace(Some(active_turn_id.clone()));
        }

        // Collect handles after state is updated.
        let handles: Vec<PromptHandle> = selected.iter().map(|r| r.handle()).collect();

        // Move records into steered children (consumes selected).
        for r in selected {
            inner.steered.entry(active_id.clone()).or_default().push(r);
        }
        Ok(handles)
    }

    pub fn abort(&self, prompt_id: &str) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if let Some(active) = &inner.active { if active.record.snapshot.id == prompt_id { self.delegate.cancel_turn(&active.turn_id, "user cancelled"); return true; } }
        if let Some(idx) = inner.pending.iter().position(|r| r.snapshot.id == prompt_id) {
            let mut record = inner.pending.remove(idx);
            record.snapshot.state = PromptState::Cancelled;
            record.launched_tx.send_replace(None);
            record.completion_tx.send_replace(PromptCompletion { prompt_id: prompt_id.to_string(), turn_id: None, result: None, state: PromptState::Cancelled });
            true
        } else { false }
    }

    pub fn inject(&self, message: ContextMessage) -> Option<Turn> {
        let inner = self.inner.lock().unwrap(); let _active = inner.active.as_ref()?;
        Some(self.delegate.enqueue_step(StepRequestKind::Steer, Some(message)))
    }

    pub fn retry(&self) -> Turn { self.delegate.enqueue_step(StepRequestKind::Retry, None) }

    pub fn undo(&self, count: usize) -> usize {
        if count == 0 { return 0; }
        let mut inner = self.inner.lock().unwrap();
        let to_remove = count.min(inner.pending.len());
        for _ in 0..to_remove {
            if let Some(mut record) = inner.pending.pop() {
                record.snapshot.state = PromptState::Cancelled;
                record.launched_tx.send_replace(None);
                record.completion_tx.send_replace(PromptCompletion { prompt_id: record.snapshot.id.clone(), turn_id: None, result: None, state: PromptState::Cancelled });
            }
        }
        to_remove
    }

    pub fn clear(&self) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(active) = &inner.active { self.delegate.cancel_turn(&active.turn_id, "service cleared"); }
        inner.active = None;
        for mut record in inner.pending.drain(..) {
            record.snapshot.state = PromptState::Cancelled;
            record.launched_tx.send_replace(None);
            record.completion_tx.send_replace(PromptCompletion { prompt_id: record.snapshot.id.clone(), turn_id: None, result: None, state: PromptState::Cancelled });
        }
        inner.steered.clear();
    }

    pub fn list(&self) -> PromptQueueSnapshot {
        let inner = self.inner.lock().unwrap();
        PromptQueueSnapshot { active: inner.active.as_ref().map(|a| a.record.snapshot.clone()), pending: inner.pending.iter().map(|r| r.snapshot.clone()).collect() }
    }

    fn try_start_next(inner: &Arc<std::sync::Mutex<Inner>>, delegate: &dyn PromptLoopDelegate) -> Option<StartedTurn> {
        let mut inner_lock = inner.lock().unwrap();
        if inner_lock.active.is_some() || inner_lock.launching || inner_lock.pending.is_empty() { return None; }
        inner_lock.launching = true;
        let mut record = inner_lock.pending.remove(0);
        let msg = record.snapshot.message.clone();
        let turn = delegate.enqueue_step(StepRequestKind::Prompt, Some(msg));
        let turn_id = turn.id.clone();
        if inner_lock.active.is_some() { inner_lock.pending.insert(0, record); inner_lock.launching = false; return None; }
        record.snapshot.state = PromptState::Running;
        record.launched_tx.send_replace(Some(turn_id.clone()));
        inner_lock.active = Some(ActiveRecord { turn_id: turn_id.clone(), record });
        inner_lock.launching = false;
        Some(StartedTurn { turn_id, result_rx: turn.result_rx })
    }

    fn spawn_settle(inner: Arc<std::sync::Mutex<Inner>>, delegate: Arc<dyn PromptLoopDelegate>, st: StartedTurn) {
        tokio::spawn(async move {
            let result = match st.result_rx.await { Ok(r) => r, Err(_) => TurnResult { turn_id: st.turn_id.clone(), result_type: TurnResultType::Cancelled, steps: 0, duration_ms: 0 } };
            Self::settle_turn(&inner, &st.turn_id, result);
            if let Some(st) = Self::try_start_next(&inner, &*delegate) { Self::spawn_settle(inner, delegate, st); }
        });
    }

    fn settle_turn(inner: &Arc<std::sync::Mutex<Inner>>, turn_id: &str, result: TurnResult) {
        let mut inner_lock = inner.lock().unwrap();
        let matches = inner_lock.active.as_ref().map_or(false, |a| a.turn_id == turn_id);
        if !matches { return; }
        let state = match result.result_type { TurnResultType::Completed => PromptState::Completed, TurnResultType::Failed => PromptState::Failed, TurnResultType::Cancelled => PromptState::Cancelled, TurnResultType::Blocked => PromptState::Blocked };
        if let Some(mut active) = inner_lock.active.take() {
            active.record.snapshot.state = state;
            active.record.completion_tx.send_replace(PromptCompletion { prompt_id: active.record.snapshot.id.clone(), turn_id: Some(active.turn_id.clone()), result: Some(result.clone()), state });
            if let Some(children) = inner_lock.steered.remove(&active.record.snapshot.id) {
                for mut child in children { child.snapshot.state = state; child.completion_tx.send_replace(PromptCompletion { prompt_id: child.snapshot.id.clone(), turn_id: Some(active.turn_id.clone()), result: Some(result.clone()), state }); }
            }
        }
    }
}

struct StartedTurn { turn_id: String, result_rx: tokio::sync::oneshot::Receiver<TurnResult> }

// ── Tests ───────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::types::ContentPart;
    use std::sync::atomic::{AtomicU32, Ordering};

    struct MockDelegate {
        turn_senders: std::sync::Mutex<Vec<tokio::sync::oneshot::Sender<TurnResult>>>,
        cancel_count: AtomicU32, turn_counter: AtomicU32,
    }
    impl MockDelegate {
        fn new() -> Self { Self { turn_senders: std::sync::Mutex::new(Vec::new()), cancel_count: AtomicU32::new(0), turn_counter: AtomicU32::new(1) } }
        fn resolve_last(&self, rt: TurnResultType) { if let Some(tx) = self.turn_senders.lock().unwrap().pop() { let _ = tx.send(TurnResult { turn_id: "resolved".into(), result_type: rt, steps: 5, duration_ms: 100 }); } }
        fn cancel_count(&self) -> u32 { self.cancel_count.load(Ordering::Relaxed) }
    }
    impl PromptLoopDelegate for MockDelegate {
        fn enqueue_step(&self, _kind: StepRequestKind, _message: Option<ContextMessage>) -> Turn {
            let n = self.turn_counter.fetch_add(1, Ordering::SeqCst);
            let id = format!("turn_{n}");
            let (tx, rx) = tokio::sync::oneshot::channel();
            self.turn_senders.lock().unwrap().push(tx);
            Turn { id, result_rx: rx }
        }
        fn cancel_turn(&self, _turn_id: &str, _reason: &str) { self.cancel_count.fetch_add(1, Ordering::SeqCst); }
    }

    fn msg(text: &str) -> ContextMessage { ContextMessage { role: "user".into(), content: vec![ContentPart::Text { text: text.into() }], tool_calls: vec![], tool_call_id: None, origin: Some(MessageOrigin::User), is_error: None, partial: None, name: None, note: None, tools: None } }
    fn inp(id: &str, text: &str) -> PromptInput { PromptInput { id: Some(id.into()), message: msg(text) } }
    fn mk_delegate() -> (Arc<MockDelegate>, Arc<dyn PromptLoopDelegate>) {
        let d: Arc<MockDelegate> = Arc::new(MockDelegate::new());
        let coerced: Arc<dyn PromptLoopDelegate> = d.clone();
        (d, coerced)
    }

    #[tokio::test] async fn test_new_service_empty() { let d: Arc<dyn PromptLoopDelegate> = Arc::new(MockDelegate::new()); let snap = PromptService::new(d).list(); assert!(snap.active.is_none() && snap.pending.is_empty()); }

    #[tokio::test] async fn test_enqueue_creates_active() {
        let (_d, svc_d) = mk_delegate(); let svc = PromptService::new(svc_d);
        let h = svc.enqueue(inp("p1", "hello")).await;
        assert_eq!(h.id, "p1"); assert_eq!(svc.list().active.unwrap().id, "p1");
    }

    #[tokio::test] async fn test_enqueue_second_stays_pending() {
        let (_d, svc_d) = mk_delegate(); let svc = PromptService::new(svc_d);
        svc.enqueue(inp("p1", "a")).await; svc.enqueue(inp("p2", "b")).await;
        let snap = svc.list(); assert_eq!(snap.active.unwrap().id, "p1"); assert_eq!(snap.pending.len(), 1); assert_eq!(snap.pending[0].id, "p2");
    }

    #[tokio::test] async fn test_auto_id() {
        let d: Arc<dyn PromptLoopDelegate> = Arc::new(MockDelegate::new());
        let h = PromptService::new(d).enqueue(PromptInput { id: None, message: msg("x") }).await;
        assert!(h.id.starts_with("prompt_"));
    }

    #[tokio::test] async fn test_auto_ids_unique() {
        let (_d, svc_d) = mk_delegate(); let svc = PromptService::new(svc_d);
        let h1 = svc.enqueue(PromptInput { id: None, message: msg("a") }).await;
        let h2 = svc.enqueue(PromptInput { id: None, message: msg("b") }).await;
        assert_ne!(h1.id, h2.id);
    }

    #[tokio::test] async fn test_steer_merges() {
        let (_d, svc_d) = mk_delegate(); let svc = PromptService::new(svc_d);
        svc.enqueue(inp("p1", "main")).await; svc.enqueue(inp("s1", "steer1")).await; svc.enqueue(inp("s2", "steer2")).await;
        let handles = svc.steer(&["s1".into(), "s2".into()]).unwrap();
        assert_eq!(handles.len(), 2); assert_eq!(handles[0].state, PromptState::Steered);
        let snap = svc.list(); assert!(snap.pending.is_empty());
    }

    #[tokio::test] async fn test_steer_errors() {
        let (d, svc_d) = mk_delegate(); let svc = PromptService::new(svc_d);
        assert!(matches!(svc.steer(&[]).unwrap_err(), PromptError::InvalidRequest(_)));
        let svc2 = PromptService::new(d);
        assert!(matches!(svc2.steer(&["x".into()]).unwrap_err(), PromptError::NoActivePrompt));
        drop(svc2);
        let (_d2, svc_d2) = mk_delegate(); let svc3 = PromptService::new(svc_d2);
        svc3.enqueue(inp("p1", "x")).await;
        assert!(matches!(svc3.steer(&["p1".into()]).unwrap_err(), PromptError::InvalidRequest(_)));
    }

    #[tokio::test] async fn test_steer_duplicate_ids() {
        let (_d, svc_d) = mk_delegate(); let svc = PromptService::new(svc_d);
        svc.enqueue(inp("p1", "x")).await;
        assert!(matches!(svc.steer(&["x".into(), "x".into()]).unwrap_err(), PromptError::InvalidRequest(_)));
    }

    #[tokio::test] async fn test_abort() {
        let (d, svc_d) = mk_delegate(); let svc = PromptService::new(svc_d);
        svc.enqueue(inp("p1", "a")).await; svc.enqueue(inp("p2", "b")).await;
        assert!(svc.abort("p2")); assert!(svc.list().pending.is_empty());
        assert!(svc.abort("p1")); assert_eq!(d.cancel_count(), 1);
    }

    #[tokio::test] async fn test_abort_unknown() {
        let d: Arc<dyn PromptLoopDelegate> = Arc::new(MockDelegate::new());
        assert!(!PromptService::new(d).abort("nonexistent"));
    }

    #[tokio::test] async fn test_clear() {
        let (_d, svc_d) = mk_delegate(); let svc = PromptService::new(svc_d);
        svc.enqueue(inp("p1", "a")).await; svc.enqueue(inp("p2", "b")).await; svc.clear();
        let snap = svc.list(); assert!(snap.active.is_none() && snap.pending.is_empty());
    }

    #[tokio::test] async fn test_clear_calls_cancel() {
        let (d, svc_d) = mk_delegate(); let svc = PromptService::new(svc_d);
        svc.enqueue(inp("p1", "a")).await; svc.clear(); assert_eq!(d.cancel_count(), 1);
    }

    #[tokio::test] async fn test_undo() {
        let (_d, svc_d) = mk_delegate(); let svc = PromptService::new(svc_d);
        svc.enqueue(inp("p1", "a")).await; svc.enqueue(inp("p2", "b")).await; svc.enqueue(inp("p3", "c")).await;
        assert_eq!(svc.undo(1), 1); assert_eq!(svc.list().pending.len(), 1); assert_eq!(svc.list().pending[0].id, "p2");
        assert_eq!(svc.undo(0), 0); assert_eq!(svc.undo(5), 1);
    }

    #[tokio::test] async fn test_undo_while_active_returns_one() {
        let (_d, svc_d) = mk_delegate(); let svc = PromptService::new(svc_d);
        svc.enqueue(inp("p1", "a")).await; svc.enqueue(inp("p2", "b")).await;
        assert_eq!(svc.undo(1), 1); // removes p2 from pending even though p1 is active
    }

    #[tokio::test] async fn test_retry() { let d: Arc<dyn PromptLoopDelegate> = Arc::new(MockDelegate::new());
        assert!(PromptService::new(d).retry().id.starts_with("turn_")); }

    #[tokio::test] async fn test_inject() {
        let (_d, svc_d) = mk_delegate(); let svc = PromptService::new(svc_d);
        assert!(svc.inject(msg("x")).is_none());
        svc.enqueue(inp("p1", "a")).await;
        assert!(svc.inject(msg("x")).is_some());
    }

    #[tokio::test] async fn test_state_transition_completed() {
        let (d, svc_d) = mk_delegate(); let svc = PromptService::new(svc_d);
        let h = svc.enqueue(inp("p1", "hi")).await;
        assert!(h.launched.borrow().clone().is_some());
        d.resolve_last(TurnResultType::Completed);
        let mut c = h.completion.clone();
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
        if c.borrow().state == PromptState::Pending { c.changed().await.unwrap(); }
        assert_eq!(c.borrow().state, PromptState::Completed);
    }

    #[tokio::test] async fn test_state_transition_failed() {
        let (d, svc_d) = mk_delegate(); let svc = PromptService::new(svc_d);
        let h = svc.enqueue(inp("p1", "boom")).await;
        let _ = h.launched.borrow().clone();
        d.resolve_last(TurnResultType::Failed);
        let mut c = h.completion.clone();
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
        if c.borrow().state == PromptState::Pending { c.changed().await.unwrap(); }
        assert_eq!(c.borrow().state, PromptState::Failed);
    }

    #[tokio::test] async fn test_queue_fifo() {
        let (d, svc_d) = mk_delegate(); let svc = PromptService::new(svc_d);
        svc.enqueue(inp("a", "alpha")).await; svc.enqueue(inp("b", "beta")).await; svc.enqueue(inp("c", "gamma")).await;
        let snap = svc.list(); assert_eq!(snap.active.as_ref().unwrap().id, "a"); assert_eq!(snap.pending[0].id, "b"); assert_eq!(snap.pending[1].id, "c");
        d.resolve_last(TurnResultType::Completed);
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        let snap = svc.list(); assert_eq!(snap.active.as_ref().unwrap().id, "b"); assert_eq!(snap.pending[0].id, "c");
    }

    #[tokio::test] async fn test_steered_settle_with_active() {
        let (d, svc_d) = mk_delegate(); let svc = PromptService::new(svc_d);
        let h1 = svc.enqueue(inp("p1", "main")).await; svc.enqueue(inp("s1", "steer")).await;
        let steered = svc.steer(&["s1".into()]).unwrap();
        // steer() creates a turn via the delegate; resolve that first, then the active turn.
        d.resolve_last(TurnResultType::Completed);
        d.resolve_last(TurnResultType::Completed);
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        let mut c1 = h1.completion.clone();
        if c1.borrow().state == PromptState::Pending { c1.changed().await.unwrap(); }
        assert_eq!(c1.borrow().state, PromptState::Completed);
        let mut c2 = steered[0].completion.clone();
        if c2.borrow().state == PromptState::Pending { c2.changed().await.unwrap(); }
        assert_eq!(c2.borrow().state, PromptState::Completed);
    }

    #[tokio::test] async fn test_terminal() {
        for s in [PromptState::Completed, PromptState::Failed, PromptState::Cancelled, PromptState::Blocked] { assert!(s.is_terminal()); }
        for s in [PromptState::Pending, PromptState::Running, PromptState::Steered] { assert!(!s.is_terminal()); }
    }

    #[tokio::test] async fn test_abort_fires_launched_none() {
        let (_d, svc_d) = mk_delegate(); let svc = PromptService::new(svc_d);
        svc.enqueue(inp("p1", "a")).await;
        let h2 = svc.enqueue(inp("p2", "b")).await;
        let mut launched_rx = h2.launched.clone();
        assert!(launched_rx.borrow().is_none());
        svc.abort("p2");
        launched_rx.changed().await.unwrap();
        assert!(launched_rx.borrow().is_none());
    }

    #[tokio::test] async fn test_delegate_called() {
        let calls = Arc::new(AtomicU32::new(0));
        struct CD(Arc<AtomicU32>);
        impl PromptLoopDelegate for CD {
            fn enqueue_step(&self, _kind: StepRequestKind, _message: Option<ContextMessage>) -> Turn { self.0.fetch_add(1, Ordering::SeqCst); let (_tx, rx) = tokio::sync::oneshot::channel(); Turn { id: "t".into(), result_rx: rx } }
            fn cancel_turn(&self, _id: &str, _r: &str) {}
        }
        let svc = PromptService::new(Arc::new(CD(Arc::clone(&calls))) as Arc<dyn PromptLoopDelegate>);
        svc.enqueue(inp("p1", "x")).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test] async fn test_completion_result() {
        let (d, svc_d) = mk_delegate(); let svc = PromptService::new(svc_d);
        let h = svc.enqueue(inp("p1", "test")).await;
        let _ = h.launched.borrow().clone().expect("launched");
        d.resolve_last(TurnResultType::Completed);
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        let c = h.completion.borrow().clone();
        assert_eq!(c.state, PromptState::Completed);
        let r = c.result.expect("has result");
        assert_eq!(r.result_type, TurnResultType::Completed);
        assert_eq!(r.steps, 5);
    }

    #[tokio::test] async fn test_cancelled_turn() {
        let (d, svc_d) = mk_delegate(); let svc = PromptService::new(svc_d);
        let h = svc.enqueue(inp("p1", "x")).await; let _ = h.launched.borrow().clone();
        d.resolve_last(TurnResultType::Cancelled);
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
        let mut c = h.completion.clone();
        if c.borrow().state == PromptState::Pending { c.changed().await.unwrap(); }
        assert_eq!(c.borrow().state, PromptState::Cancelled);
    }

    #[tokio::test] async fn test_fifo_full_cycle() {
        let (d, svc_d) = mk_delegate(); let svc = PromptService::new(svc_d);
        let h1 = svc.enqueue(inp("p1", "a")).await;
        let h2 = svc.enqueue(inp("p2", "b")).await;
        let h3 = svc.enqueue(inp("p3", "c")).await;
        assert_eq!(svc.list().active.unwrap().id, "p1");
        d.resolve_last(TurnResultType::Completed);
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        assert_eq!(svc.list().active.unwrap().id, "p2");
        d.resolve_last(TurnResultType::Completed);
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        assert_eq!(svc.list().active.unwrap().id, "p3");
        d.resolve_last(TurnResultType::Completed);
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        assert!(svc.list().active.is_none());
        for h in [h1, h2, h3] {
            let mut c = h.completion.clone();
            tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;
            if c.borrow().state == PromptState::Pending { c.changed().await.unwrap(); }
            assert_eq!(c.borrow().state, PromptState::Completed);
        }
    }
}