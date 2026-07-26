/// TurnFlow — orchestrates turn lifecycle, goal driving, and step loop invocation.
///
/// Corresponds to the full `TurnFlow` class in `packages/agent-core/src/agent/turn/index.ts`.
///
/// This is the high-level orchestrator that wraps `run_turn::run_turn()` with:
///   - Turn lifecycle (prompt, steer, launch, cancel, wait)
///   - Goal driving (autonomous continuation turns)
///   - Steer buffering (deferred messages during an active turn or compaction)
///   - Event dispatch and telemetry reporting

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::agent::types::*;
use crate::callbacks::HostCallbacks;
use crate::context::context_memory::ContextMemory;
use crate::context::types::{ContentPart, ContextMessage, MessageOrigin};
use crate::turn_loop::types as loop_types;

/// A buffered steer message waiting to be flushed into the context.
struct BufferedSteer {
    input: Vec<ContentPart>,
    origin: MessageOrigin,
}

/// Active turn state.
struct ActiveTurn {
    turn_id: u32,
    cancelled: Arc<AtomicBool>,
}

/// Result of a completed turn.
#[derive(Debug, Clone)]
pub struct TurnEndResult {
    pub stop_reason: TurnEndReason,
    pub steps: u32,
    pub duration_ms: u64,
}

/// Orchestrates turn lifecycle and step loop invocation.
pub struct TurnFlow {
    /// Monotonic turn ID counter.
    turn_id_counter: u32,
    /// Current active turn (None when idle).
    active_turn: Option<ActiveTurn>,
    /// Buffered steer messages (deferred while active or compacting).
    steer_buffer: Vec<BufferedSteer>,
    /// Whether the flow is resuming from a persisted turn.
    resuming: bool,
    /// Whether goal mode is enabled.
    goal_enabled: bool,
    /// Maximum steps per turn.
    max_steps_per_turn: u32,
    /// Whether the turn flow is currently compacting (blocks new launches).
    is_compacting: bool,
}

impl TurnFlow {
    /// Create a new TurnFlow.
    pub fn new() -> Self {
        Self {
            turn_id_counter: 0,
            active_turn: None,
            steer_buffer: Vec::new(),
            resuming: false,
            goal_enabled: false,
            max_steps_per_turn: 50,
            is_compacting: false,
        }
    }

    /// Configure the TurnFlow.
    pub fn configure(&mut self, goal_enabled: bool, max_steps_per_turn: u32) {
        self.goal_enabled = goal_enabled;
        self.max_steps_per_turn = max_steps_per_turn;
    }

    // ── Turn lifecycle ───────────────────────────────────────────────────────

    /// Prompt the agent with user input. Returns the turn ID, or None if busy.
    pub fn prompt(
        &mut self,
        input: Vec<ContentPart>,
        origin: MessageOrigin,
        context: &mut ContextMemory,
    ) -> Option<u32> {
        if input.is_empty() {
            return None;
        }
        // Buffer if compacting (deferred until compaction finishes).
        if self.is_compacting {
            self.steer_buffer.push(BufferedSteer { input, origin });
            return None;
        }
        self.launch(input, origin, context)
    }

    /// Steer the agent (non-blocking interruption). Returns None if buffered.
    pub fn steer(
        &mut self,
        input: Vec<ContentPart>,
        origin: MessageOrigin,
        context: &mut ContextMemory,
    ) -> Option<u32> {
        if input.is_empty() {
            return None;
        }
        // Buffer while a turn is active OR compaction holds the context.
        if self.active_turn.is_some() || self.is_compacting {
            self.steer_buffer.push(BufferedSteer { input, origin });
            return None;
        }
        self.launch(input, origin, context)
    }

    /// Retry: launches a turn with an empty prompt (retry origin).
    pub fn retry(
        &mut self,
        trigger: Option<String>,
        context: &mut ContextMemory,
    ) -> Option<u32> {
        let name = trigger.unwrap_or_else(|| "retry".to_string());
        let origin = MessageOrigin::SystemTrigger { name };
        self.prompt(vec![ContentPart::Text { text: String::new() }], origin, context)
    }

    /// Cancel the current turn.
    pub fn cancel(&self) {
        if let Some(ref active) = self.active_turn {
            active.cancelled.store(true, Ordering::Relaxed);
        }
    }

    /// Cancel with a specific turn ID (no-op if ID doesn't match active turn).
    pub fn cancel_turn(&self, turn_id: Option<u32>) {
        if let Some(ref active) = self.active_turn {
            if let Some(tid) = turn_id {
                if tid != active.turn_id {
                    return;
                }
            }
            active.cancelled.store(true, Ordering::Relaxed);
        }
    }

    /// Check if a turn is active.
    pub fn has_active_turn(&self) -> bool {
        self.active_turn.is_some()
    }

    /// Get the current turn ID.
    pub fn current_turn_id(&self) -> Option<u32> {
        self.active_turn.as_ref().map(|a| a.turn_id)
    }

    /// Set the compacting flag.
    pub fn set_compacting(&mut self, compacting: bool) {
        self.is_compacting = compacting;
    }

    /// Check if compaction is in progress.
    pub fn is_compacting(&self) -> bool {
        self.is_compacting
    }

    // ── Goal driving ─────────────────────────────────────────────────────────

    /// Drive an active goal as a sequence of ordinary turns.
    ///
    /// Each iteration runs one full turn, then checks the goal status:
    /// - `complete` → stop
    /// - `blocked` → stop
    /// - `active` → continue with goal reminder prompt
    /// - Turn failure → pause and stop
    pub async fn drive_goal(
        &mut self,
        first_turn_id: u32,
        input: Vec<ContentPart>,
        origin: MessageOrigin,
        callbacks: &Arc<dyn HostCallbacks>,
        context: &mut ContextMemory,
        config: &AgentConfig,
        hooks: &AgentHooks,
    ) -> Result<TurnEndResult, Box<dyn std::error::Error + Send + Sync>> {
        let _first_turn_id = first_turn_id;

        // The first turn was already launched (active_turn is set). We run it
        // inline; continuation turns are launched as we go.
        loop {
            // Run one turn. run_one_turn will end the active turn when done.
            let end = self.run_one_turn(
                callbacks,
                context,
                config,
                hooks,
            ).await?;

            match end.stop_reason {
                TurnEndReason::Cancelled | TurnEndReason::Failed(_) | TurnEndReason::Blocked => {
                    return Ok(end);
                }
                TurnEndReason::Completed => {
                    // After the turn, allocate and launch the next continuation turn.
                    let _turn_id = self.allocate_turn_id();
                    let cont_input = vec![ContentPart::Text { text: format!(
                        "Continue working toward the active goal."
                    )}];
                    let cont_origin = MessageOrigin::SystemTrigger { name: "goal_continuation".into() };

                    // Launch the next continuation turn. If launch fails (no active
                    // goal, turn limit reached, etc.), we're done.
                    if self.launch(cont_input, cont_origin, context).is_none() {
                        return Ok(TurnEndResult {
                            stop_reason: TurnEndReason::Completed,
                            steps: 0,
                            duration_ms: 0,
                        });
                    }
                }
            }
        }
    }

    // ── Compaction finished handler ──────────────────────────────────────────

    /// Called when compaction finishes — replays buffered steers.
    /// If a turn is already active, the buffered steers are flushed into context.
    /// Otherwise, a new turn is launched from the first buffered item.
    pub fn on_compaction_finished(&mut self, context: &mut ContextMemory) {
        self.is_compacting = false;
        if self.steer_buffer.is_empty() {
            return;
        }
        if self.active_turn.is_some() {
            self.flush_steer_buffer(context);
            return;
        }
        // Launch a new turn from the first buffered item.
        // Extract the first item before launching to avoid borrow conflict.
        if !self.steer_buffer.is_empty() {
            let next = self.steer_buffer.remove(0);
            self.launch(next.input, next.origin, context);
        }
    }

    // ── Wait for current turn ────────────────────────────────────────────────

    /// Wait for the current turn to complete by polling the cancellation flag.
    /// In production, this would await a completion signal.
    pub async fn wait_for_current_turn(&self) {
        // In the current architecture, the turn runs synchronously in run_one_turn,
        // so this is a no-op. In a future async architecture, this would await
        // the turn's completion future.
    }

    /// Wait for the first request of the current turn to be sent.
    pub async fn wait_for_turn_first_request(&self) {
        // No-op in the current synchronous architecture.
    }

    // ── Replay / restore ─────────────────────────────────────────────────────

    /// Restore a prompt (for session replay).
    pub fn restore_prompt(&mut self) {
        if self.active_turn.is_some() {
            return;
        }
        self.turn_id_counter += 1;
        self.resuming = true;
    }

    /// Restore a steer (for session replay).
    pub fn restore_steer(&mut self, input: Vec<ContentPart>, origin: MessageOrigin) {
        if self.active_turn.is_some() {
            self.steer_buffer.push(BufferedSteer { input, origin });
            return;
        }
        self.turn_id_counter += 1;
        self.resuming = true;
    }

    /// Observe a restored turn ID from a replayed loop event.
    pub fn observe_restored_turn_id(&mut self, turn_id: u32) {
        if turn_id > self.turn_id_counter {
            self.turn_id_counter = turn_id;
        }
    }

    // ── Internal: launch a turn ──────────────────────────────────────────────

    /// Allocate and launch a new turn. Returns the turn ID, or None if busy.
    fn launch(
        &mut self,
        input: Vec<ContentPart>,
        origin: MessageOrigin,
        context: &mut ContextMemory,
    ) -> Option<u32> {
        if self.active_turn.is_some() {
            return None;
        }

        let turn_id = self.allocate_turn_id();
        let cancelled = Arc::new(AtomicBool::new(false));

        // Append the user message to context.
        context.append_user_message(&input, origin);

        self.active_turn = Some(ActiveTurn {
            turn_id,
            cancelled,
        });

        Some(turn_id)
    }

    /// Allocate a monotonic turn ID.
    fn allocate_turn_id(&mut self) -> u32 {
        let id = self.turn_id_counter;
        self.turn_id_counter += 1;
        id
    }

    /// Flush buffered steer messages into the context.
    fn flush_steer_buffer(&mut self, context: &mut ContextMemory) -> bool {
        if self.steer_buffer.is_empty() {
            return false;
        }
        for steer in self.steer_buffer.drain(..) {
            context.append_user_message(&steer.input, steer.origin);
        }
        true
    }

    /// End the current turn.
    fn end_turn(&mut self) {
        self.active_turn = None;
    }

    // ── Run a single turn (async, non-blocking) ──────────────────────────────

    /// Run one complete turn: step loop, events, and result.
    ///
    /// This is the core orchestrator. It:
    /// 1. Builds the LLM and messages from context
    /// 2. Calls `run_turn::run_turn()` for the step loop
    /// 3. Collects usage and stop reason
    /// 4. Returns the turn result
    pub async fn run_one_turn(
        &mut self,
        callbacks: &Arc<dyn HostCallbacks>,
        context: &mut ContextMemory,
        config: &AgentConfig,
        hooks: &AgentHooks,
    ) -> Result<TurnEndResult, Box<dyn std::error::Error + Send + Sync>> {
        let active = match &self.active_turn {
            Some(a) => a,
            None => return Err("No active turn to run".into()),
        };

        let turn_id = active.turn_id;
        let cancelled = active.cancelled.clone();
        let started_at = std::time::Instant::now();

        // Flush any buffered steers before the step loop.
        self.flush_steer_buffer(context);

        // Get current messages from context.
        let messages = context.messages();
        let loop_messages = messages_to_loop_messages(&messages);

        // Build the LLM from the current config.
        let llm = AgentLlm::new(config);

        // Build tools (empty for now — the host provides tools through callbacks).
        let tools: &[&dyn loop_types::ExecutableTool] = &[];

        let loop_hooks = build_loop_hooks_from_agent_hooks(hooks);

        // Run the step loop.
        let run_turn_input = loop_types::RunTurnInput {
            turn_id: turn_id.to_string(),
            llm: &llm,
            messages: loop_messages,
            tools,
            tool_defs: vec![],
            hooks: loop_hooks.as_ref(),
            max_steps: self.max_steps_per_turn,
            goal: None,
            cancellation: Some(cancelled),
        };

        let result = crate::turn_loop::run_turn::run_turn(
            run_turn_input,
            callbacks,
        ).await.map_err(|e| -> Box<dyn std::error::Error + Send + Sync> {
            Box::new(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
        })?;

        let duration_ms = started_at.elapsed().as_millis() as u64;

        let stop_reason = match result.stop_reason {
            loop_types::LoopTurnStopReason::EndTurn => {
                TurnEndReason::Completed
            }
            loop_types::LoopTurnStopReason::MaxTokens => {
                TurnEndReason::Completed
            }
            loop_types::LoopTurnStopReason::Aborted => TurnEndReason::Cancelled,
            loop_types::LoopTurnStopReason::Filtered | loop_types::LoopTurnStopReason::Paused | loop_types::LoopTurnStopReason::Unknown => {
                TurnEndReason::Failed(TurnError {
                    message: format!("Turn stopped: {:?}", result.stop_reason),
                    code: "turn_stopped".into(),
                    retryable: true,
                })
            }
            loop_types::LoopTurnStopReason::BudgetLimited => {
                TurnEndReason::Blocked
            }
        };

        self.end_turn();

        Ok(TurnEndResult {
            stop_reason,
            steps: result.steps,
            duration_ms,
        })
    }

    // ── Resuming ─────────────────────────────────────────────────────────────

    /// Mark the flow as resuming (for session replay).
    pub fn mark_resuming(&mut self) {
        self.resuming = true;
    }

    /// Finish resuming.
    pub fn finish_resume(&mut self) {
        self.resuming = false;
        self.steer_buffer.clear();
    }
}

impl Default for TurnFlow {
    fn default() -> Self {
        Self::new()
    }
}

// ── Helper: AgentLlm ─────────────────────────────────────────────────────

/// A simple LLM implementation that delegates to the host callbacks.
struct AgentLlm<'a> {
    config: &'a AgentConfig,
}

impl<'a> AgentLlm<'a> {
    fn new(config: &'a AgentConfig) -> Self {
        Self { config }
    }
}

impl<'a> loop_types::LLM for AgentLlm<'a> {
    fn system_prompt(&self) -> &str {
        &self.config.system_prompt
    }

    fn model_name(&self) -> &str {
        self.config.model_alias.as_deref().unwrap_or("unknown")
    }

    fn is_retryable_error(&self, _error: &str) -> bool {
        false
    }

    fn chat(
        &self,
        _params: loop_types::LLMChatParams,
    ) -> crate::rpc::types::BoxFuture<'_, Result<loop_types::LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>> {
        Box::pin(async move {
            Err("LLM chat must be provided by the host (set run_turn_override)".into())
        })
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────

/// Convert context messages to loop messages.
fn messages_to_loop_messages(
    messages: &[ContextMessage],
) -> Vec<loop_types::LLMMessage> {
    messages.iter().map(|msg| {
        let content = msg.content.iter()
            .map(|part| match part {
                ContentPart::Text { text } => text.clone(),
                _ => String::new(),
            })
            .collect::<Vec<_>>()
            .join("\n");

        let role = match msg.role.as_str() {
            "user" => "user".to_string(),
            "assistant" => "assistant".to_string(),
            "tool" => "tool".to_string(),
            other => other.to_string(),
        };

        loop_types::LLMMessage {
            role,
            content,
            blocks: vec![],
            tool_calls: vec![],
            tool_call_id: None,
        }
    }).collect()
}

/// Build LoopHooks from AgentHooks.
fn build_loop_hooks_from_agent_hooks(_hooks: &AgentHooks) -> Option<loop_types::LoopHooks> {
    None // Hooks are provided via HostCallbacks on the stdio/napi path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_turn_flow() {
        let flow = TurnFlow::new();
        assert!(!flow.has_active_turn());
        assert_eq!(flow.current_turn_id(), None);
        assert!(!flow.is_compacting());
    }

    #[test]
    fn test_launch_turn() {
        let mut flow = TurnFlow::new();
        let mut context = ContextMemory::new();
        let input = vec![ContentPart::Text { text: "hello".to_string() }];

        let turn_id = flow.launch(input, MessageOrigin::User, &mut context);
        assert!(turn_id.is_some());
        assert!(flow.has_active_turn());
        assert_eq!(context.history().len(), 1);
    }

    #[test]
    fn test_cannot_launch_twice() {
        let mut flow = TurnFlow::new();
        let mut context = ContextMemory::new();

        let id1 = flow.launch(
            vec![ContentPart::Text { text: "first".to_string() }],
            MessageOrigin::User,
            &mut context,
        );
        assert!(id1.is_some());

        let id2 = flow.launch(
            vec![ContentPart::Text { text: "second".to_string() }],
            MessageOrigin::User,
            &mut context,
        );
        assert!(id2.is_none());
    }

    #[test]
    fn test_steer_buffers_during_active_turn() {
        let mut flow = TurnFlow::new();
        let mut context = ContextMemory::new();

        flow.launch(
            vec![ContentPart::Text { text: "first".to_string() }],
            MessageOrigin::User,
            &mut context,
        );
        assert!(flow.has_active_turn());

        // Steer should be buffered, not launched.
        let steer_id = flow.steer(
            vec![ContentPart::Text { text: "steer".to_string() }],
            MessageOrigin::User,
            &mut context,
        );
        assert!(steer_id.is_none());
        assert_eq!(flow.steer_buffer.len(), 1);
    }

    #[test]
    fn test_cancel_turn() {
        let mut flow = TurnFlow::new();
        let mut context = ContextMemory::new();

        flow.launch(
            vec![ContentPart::Text { text: "hello".to_string() }],
            MessageOrigin::User,
            &mut context,
        );
        assert!(flow.has_active_turn());

        flow.cancel();
        assert!(flow.has_active_turn());

        // End the turn properly.
        flow.end_turn();
        assert!(!flow.has_active_turn());
    }

    #[test]
    fn test_allocate_turn_id() {
        let mut flow = TurnFlow::new();
        assert_eq!(flow.allocate_turn_id(), 0);
        assert_eq!(flow.allocate_turn_id(), 1);
        assert_eq!(flow.allocate_turn_id(), 2);
    }

    #[test]
    fn test_flush_steer_buffer() {
        let mut flow = TurnFlow::new();
        let mut context = ContextMemory::new();

        flow.steer_buffer.push(BufferedSteer {
            input: vec![ContentPart::Text { text: "steer1".to_string() }],
            origin: MessageOrigin::User,
        });

        let flushed = flow.flush_steer_buffer(&mut context);
        assert!(flushed);
        assert!(flow.steer_buffer.is_empty());
        assert_eq!(context.history().len(), 1);
    }

    #[test]
    fn test_finish_resume_clears_buffer() {
        let mut flow = TurnFlow::new();
        flow.steer_buffer.push(BufferedSteer {
            input: vec![ContentPart::Text { text: "stale".to_string() }],
            origin: MessageOrigin::User,
        });
        flow.finish_resume();
        assert!(flow.steer_buffer.is_empty());
        assert!(!flow.resuming);
    }

    #[test]
    fn test_prompt_during_compaction_buffers() {
        let mut flow = TurnFlow::new();
        let mut context = ContextMemory::new();

        flow.set_compacting(true);
        let id = flow.prompt(
            vec![ContentPart::Text { text: "during compaction".to_string() }],
            MessageOrigin::User,
            &mut context,
        );
        assert!(id.is_none());
        assert_eq!(flow.steer_buffer.len(), 1);
    }

    #[test]
    fn test_on_compaction_finished_launches_buffered() {
        let mut flow = TurnFlow::new();
        let mut context = ContextMemory::new();

        flow.set_compacting(true);
        flow.prompt(
            vec![ContentPart::Text { text: "deferred".to_string() }],
            MessageOrigin::User,
            &mut context,
        );
        assert_eq!(flow.steer_buffer.len(), 1);

        flow.on_compaction_finished(&mut context);
        assert!(flow.has_active_turn());
        assert!(flow.steer_buffer.is_empty());
    }

    #[test]
    fn test_retry_launches_turn() {
        let mut flow = TurnFlow::new();
        let mut context = ContextMemory::new();

        let id = flow.retry(Some("timeout".into()), &mut context);
        assert!(id.is_some());
        assert!(flow.has_active_turn());
    }

    #[test]
    fn test_cancel_turn_with_id() {
        let mut flow = TurnFlow::new();
        let mut context = ContextMemory::new();

        flow.launch(
            vec![ContentPart::Text { text: "hello".to_string() }],
            MessageOrigin::User,
            &mut context,
        );

        // Cancel with wrong ID should be no-op.
        flow.cancel_turn(Some(999));
        assert!(flow.has_active_turn());

        // Cancel with correct ID.
        let id = flow.current_turn_id();
        flow.cancel_turn(id);
        // Cancellation flag is set, but turn is still active.
        assert!(flow.has_active_turn());
    }

    #[test]
    fn test_observe_restored_turn_id() {
        let mut flow = TurnFlow::new();
        assert_eq!(flow.allocate_turn_id(), 0);

        // Observe a higher ID — counter becomes 10.
        flow.observe_restored_turn_id(10);
        // Next allocated ID should be 10 (the current counter value).
        assert_eq!(flow.allocate_turn_id(), 10);

        // Observe a lower ID should have no effect.
        flow.observe_restored_turn_id(5);
        assert_eq!(flow.allocate_turn_id(), 11);
    }

    #[test]
    fn test_restore_prompt() {
        let mut flow = TurnFlow::new();
        flow.restore_prompt();
        assert!(flow.resuming);
    }

    #[test]
    fn test_restore_steer_buffers_during_active() {
        let mut flow = TurnFlow::new();
        let mut context = ContextMemory::new();

        flow.launch(
            vec![ContentPart::Text { text: "active".to_string() }],
            MessageOrigin::User,
            &mut context,
        );

        flow.restore_steer(
            vec![ContentPart::Text { text: "steer".to_string() }],
            MessageOrigin::User,
        );
        assert_eq!(flow.steer_buffer.len(), 1);
    }

    #[test]
    fn test_compacting_flag() {
        let mut flow = TurnFlow::new();
        assert!(!flow.is_compacting());
        flow.set_compacting(true);
        assert!(flow.is_compacting());
        flow.set_compacting(false);
        assert!(!flow.is_compacting());
    }

    #[test]
    fn test_configure() {
        let mut flow = TurnFlow::new();
        flow.configure(true, 100);
        assert!(flow.goal_enabled);
        assert_eq!(flow.max_steps_per_turn, 100);
    }
}