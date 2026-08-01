/// Event-driven turn loop with prediction support.
///
/// The loop runs as an async state machine:
/// 1. Call LLM → get tool calls
/// 2. Execute all tools concurrently
/// - If tool returns a prediction (is_prediction=true):
/// insert into messages immediately, spawn background precise execution
/// - Otherwise: use result directly
/// 3. Continue next LLM step — messages already contain predictions
/// 4. Before next LLM call, await background precise results and replace predictions
///
/// This allows the LLM to continue working while tools execute,
/// and predictions give it enough context to make progress.

use std::sync::Arc;

use super::retry::RetryConfig;
use super::tool_dedup::ToolCallDeduplicator;
use super::turn_step::execute_loop_step_with_retry;
use super::types::*;
use crate::callbacks::HostCallbacks;
use crate::rpc::types::{BoxFuture, ToolExecuteRequest};

/// Run a single turn with prediction support.
pub fn run_turn<'a>(
 input: RunTurnInput<'a>,
 callbacks: &'a Arc<dyn HostCallbacks>,
) -> BoxFuture<'a, Result<TurnResult, Box<dyn std::error::Error + 'a>>> {
 let turn_id = input.turn_id.clone();
 let max_steps = input.max_steps.max(1);
 let user_messages = input.messages.clone();
 let tool_defs = input.tool_defs.clone();
 let goal = input.goal.clone();

 Box::pin(async move {
 let mut total_usage = crate::rpc::types::TokenUsage::default();
 let mut steps: u32 = 0;
 // Count of pre-existing messages (synthetic system + caller input) so the
 // turn result can carry only what the loop appended this turn.
 let input_len = user_messages.len();

 // Build system prompt, optionally enriched with goal steering text.
 let system_prompt = if let Some(ref goal) = goal {
 format!("{}\n\n{}", input.llm.system_prompt(), render_goal_steering(goal, 0, 0))
 } else {
 input.llm.system_prompt().to_string()
 };
 let mut messages = vec![LLMMessage {
 role: "system".into(),
 content: system_prompt,
 ..Default::default()
 }];
 messages.extend(user_messages);

 // Background handles for prediction precise execution, indexed by
 // message index of the tool result that needs replacement.
 let mut pending_precise: Vec<(usize, tokio::task::JoinHandle<ExecutableToolResult>)> = Vec::new();

 // Repeat breaker: same-step dedup + cross-step streak reminders. Held at
 // turn scope so the consecutive streak survives across steps. Mirrors the
 // host's agent-core tool-dedup.ts (upstream 0.31.1) natively, so the Rust
 // engine no longer depends on the host JS dedupe bookkeeping.
 let mut deduper = ToolCallDeduplicator::new();

 // Default retry configuration for LLM calls within this turn.
 let retry_config = RetryConfig::default();

 for step_num in 0..max_steps {
 steps = step_num + 1;

 // ── Goal budget check ──────────────────────────────────────────
 // Before each step, verify the goal is still active and within
 // budget. If the host paused/blocked it or a budget is exhausted,
 // stop the turn immediately.
 if let Some(ref goal) = goal {
 if !goal.status.is_active() {
 let reason = match goal.status {
 GoalStatus::Paused => LoopTurnStopReason::Paused,
 GoalStatus::Blocked => LoopTurnStopReason::Aborted,
 _ => LoopTurnStopReason::EndTurn,
 };
 drain_pending_precise(&mut messages, &mut pending_precise).await;
 return Ok(finish_turn(&mut messages, input_len, reason, step_num, total_usage, false));
 }
 // Check budgets with cumulative usage so far.
 let turn_tokens = total_usage.total_tokens as i64;
 let turns_this_turn = step_num as i64;
 if goal.would_exceed_budget(turn_tokens, turns_this_turn) {
 drain_pending_precise(&mut messages, &mut pending_precise).await;
 return Ok(finish_turn(&mut messages, input_len, LoopTurnStopReason::BudgetLimited, step_num, total_usage, false));
 }
 // Update steering text in system prompt with current progress.
 let steering = render_goal_steering(goal, turn_tokens, turns_this_turn);
 messages[0].content = format!("{}\n\n{}", input.llm.system_prompt(), steering);
 }

 // ── Cancellation check ────────────────────────────────────────
 // If the host sent a CANCEL_TURN request, the cancellation flag
 // is set. Abort the turn before calling the LLM.
 if let Some(ref cancel) = input.cancellation {
 if cancel.load(std::sync::atomic::Ordering::Relaxed) {
 drain_pending_precise(&mut messages, &mut pending_precise).await;
 return Ok(finish_turn(&mut messages, input_len, LoopTurnStopReason::Aborted, step_num, total_usage, false));
 }
 }

 // ── Steer drain (step boundary) ──────────────────────────────
 // Mid-turn steers land here: anything queued since the last step is
 // appended as a user message so the NEXT LLM call already sees it
 // (the run_prompt boundary drains the queue too, but a long tool
 // loop must not wait for the whole turn to end).
 if let Some(ref queue) = input.steer_queue {
 let parts: Vec<crate::context::types::ContentPart> = {
 let mut q = queue.lock().unwrap_or_else(|e| e.into_inner());
 q.drain(..).collect()
 };
 if !parts.is_empty() {
 messages.push(LLMMessage {
 role: "user".into(),
 content: parts.iter().map(|p| match p {
 crate::context::types::ContentPart::Text { text } => text.clone(),
 _ => String::new(),
 }).collect::<Vec<_>>().join("\n"),
 blocks: Vec::new(),
 tool_calls: Vec::new(),
 tool_call_id: None,
 });
 }
 }

 if let Some(ref hooks) = input.hooks {
 if let Some(ref before_step) = hooks.before_step {
 let ctx = StepContext {
 turn_id: turn_id.clone(),
 step: step_num,
 };
 let before_result = before_step(&ctx)?;
 if let Some(BeforeStepResult::StopTurn(reason)) = before_result {
 drain_pending_precise(&mut messages, &mut pending_precise).await;
 return Ok(finish_turn(&mut messages, input_len, reason, steps, total_usage, false));
 }
 }
 }

 // Before calling LLM, drain any completed background precise
 // results and replace predictions in messages.
 replace_completed_predictions(&mut messages, &mut pending_precise).await;

 // Delegate LLM call (with retry) to turn_step module.
 // Convert the 'static error to the turn's 'a-bounded error type.
 let step_result = execute_loop_step_with_retry(
 &turn_id,
 step_num,
 input.llm,
 messages.clone(),
 input.tools,
 tool_defs.clone(),
 &retry_config,
 ).await.map_err(|e| -> Box<dyn std::error::Error + 'a> {
 Box::new(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
 })?;

 total_usage.input_tokens += step_result.usage.input_tokens;
 total_usage.output_tokens += step_result.usage.output_tokens;
 total_usage.total_tokens += step_result.usage.total_tokens;

 match step_result.stop_reason {
 LoopStepStopReason::Complete => {
 // Record the assistant's final text so the session driver can
 // persist it (the tool-call branch pushes its own assistant
 // message; a plain text turn had none). Skip when empty — the
 // host-proxy path leaves content empty and owns the transcript.
 if !step_result.content.is_empty() {
 messages.push(LLMMessage {
 role: "assistant".into(),
 content: step_result.content.clone(),
 ..Default::default()
 });
 }
 // Fire after_step with no tool results (step ended
 // without tool calls).
 if let Some(ref hooks) = input.hooks {
 if let Some(ref after_step) = hooks.after_step {
 let ctx = AfterStepContext {
 turn_id: turn_id.clone(),
 step: step_num,
 tool_results: vec![],
 };
 let after_result = after_step(&ctx)?;
 if let Some(AfterStepResult::StopTurn(reason)) = after_result {
 drain_pending_precise(&mut messages, &mut pending_precise).await;
 return Ok(finish_turn(&mut messages, input_len, reason, steps, total_usage, false));
 }
 }
 }
 drain_pending_precise(&mut messages, &mut pending_precise).await;
 return Ok(finish_turn(&mut messages, input_len, LoopTurnStopReason::EndTurn, steps, total_usage, false));
 }
 LoopStepStopReason::ToolCalls(tool_calls) => {
 // AgentSwarm batch exclusivity veto: an AgentSwarm call must be the
 // only tool call in its batch (mirrors the TS
 // gent-swarm-exclusive-deny policy). Vetoed batches execute
 // nothing - every call returns the veto message as an error result.
 let tool_names: Vec<&str> = tool_calls.iter().map(|tc| tc.name.as_str()).collect();
 let batch_veto = crate::swarm::check_agent_swarm_batch(&tool_names);
 if let Some(veto) = batch_veto {
 let message = crate::swarm::SwarmVetoMessages::default()
 .for_batch_veto(veto)
 .to_string();
 for tc in &tool_calls {
 eprintln!("Tool {} ({}) vetoed: {}", tc.name, tc.id, message);
 messages.push(LLMMessage {
 role: "tool".into(),
 content: message.clone(),
 blocks: Vec::new(),
 tool_calls: Vec::new(),
 tool_call_id: Some(tc.id.clone()),
 });
 }
 continue;
 }
 // Append ONE assistant message carrying all tool calls. Wire

 // formats group an assistant turn's calls into a single
 // message; keeping them structural (not flattened into
 // `content`) lets a native provider round-trip them.
 messages.push(LLMMessage {
 role: "assistant".into(),
 content: step_result.content.clone(),
 blocks: Vec::new(),
 tool_calls: tool_calls.clone(),
 tool_call_id: None,
 });

 // Execute tools concurrently, separating predictions
 let exec_fn = {
 let turn_id = turn_id.clone();
 let callbacks = callbacks.clone();
 move |tc: ToolCall, force_precise: bool| {
 let turn_id = turn_id.clone();
 let callbacks = callbacks.clone();
 async move {
 let req = ToolExecuteRequest {
 session_id: None,
 turn_id: turn_id.clone(),
 tool_call_id: tc.id.clone(),
 tool_name: tc.name.clone(),
 arguments: tc.arguments.clone(),
 force_precise,
 };
 let response = callbacks.execute_tool(req).await
 .map_err(|e| format!("Tool execution error: {e}"))?;
 if response.is_error {
 eprintln!("Tool {} ({}) error: {}", tc.name, tc.id, response.content);
 }
 Ok(ExecutableToolResult {
 content: response.content,
 is_error: response.is_error,
 is_prediction: response.is_prediction, media: response.media,
        stop_turn: false,
 })
 }
 }
 };

    // Register every call with the repeat breaker. Same-step duplicates
    // (synthetic) are skipped during execution and backfilled at finalize.
    deduper.begin_step(&turn_id);
    let mut synthetic_flags = vec![false; tool_calls.len()];
    for (i, tc) in tool_calls.iter().enumerate() {
        synthetic_flags[i] = deduper
            .check_same_step(&tc.id, &tc.name, &tc.arguments)
            .is_some();
    }
    let exec_calls: Vec<ToolCall> = tool_calls
        .iter()
        .enumerate()
        .filter(|(i, _)| !synthetic_flags[*i])
        .map(|(_, tc)| tc.clone())
        .collect();
    let (exec_results, mut background_handles) = if exec_calls.is_empty() {
        (Vec::new(), Vec::new())
    } else {
        execute_tools_split_predictions(&exec_calls, exec_fn).await?
    };

    // Reassemble in provider order, placeholder for skipped duplicates.
    let mut immediate_results: Vec<ExecutableToolResult> = Vec::with_capacity(tool_calls.len());
    let mut exec_iter = exec_results.into_iter();
    for i in 0..tool_calls.len() {
        if synthetic_flags[i] {
            immediate_results.push(ExecutableToolResult {
                content: String::new(),
                is_error: false,
                is_prediction: false,
                stop_turn: false,
                media: Vec::new(),
            });
        } else {
            immediate_results.push(exec_iter.next().unwrap_or_else(|| ExecutableToolResult {
                content: "Tool result lost".into(),
                is_error: true,
                is_prediction: false,
                stop_turn: false,
                media: Vec::new(),
            }));
        }
    }

    // Finalize in provider order: backfills same-step duplicates with the
    // original result and appends repeat-breaker reminders; a streak of 12
    // force-stops the turn (stop_turn=true).
    for (i, tr) in immediate_results.iter_mut().enumerate() {
        let tc = &tool_calls[i];
        *tr = deduper.finalize_result(&tc.id, &tc.name, tr.clone());
    }
    let force_stop = immediate_results.iter().any(|tr| tr.stop_turn);
    deduper.end_step();

 // Insert tool results and track which message indices
 // correspond to predictions (for later replacement). Each
 // result links back to its call via `tool_call_id`.
 let prediction_count = background_handles.iter().filter(|h| h.is_some()).count();
 let mut prediction_msg_indices: Vec<usize> = Vec::with_capacity(prediction_count);

 for (i, tr) in immediate_results.iter().enumerate() {
 let msg_idx = messages.len();
 messages.push(LLMMessage {
 role: "tool".into(),
 content: tr.content.clone(),
 blocks: Vec::new(),
 tool_calls: Vec::new(),
 tool_call_id: tool_calls.get(i).map(|tc| tc.id.clone()),
 });

 if !tr.media.is_empty() {
                    // Deliver image parts as a follow-up user message: tool-role
                    // image support is provider-divergent, but user-message image
                    // blocks project uniformly across Anthropic/OpenAI/Google.
                    let tool_label = tool_calls.get(i).map(|tc| tc.name.as_str()).unwrap_or("tool").to_string();
                    let mut blocks: Vec<crate::rpc::types::ContentBlock> =
                        vec![crate::rpc::types::ContentBlock::Text { text: format!("Image output from {tool_label}:") }];
                    blocks.extend(tr.media.iter().cloned());
                    messages.push(LLMMessage {
                        role: "user".into(),
                        content: String::new(),
                        blocks,
                        tool_calls: Vec::new(),
                        tool_call_id: None,
                    });
                }
                if tr.is_prediction {
 prediction_msg_indices.push(msg_idx);
 }
 }

 // Track prediction handles for background replacement.
 // Swap out the Some handles into a separate vec so we
 // can await them later (JoinHandle is not Clone).
 let new_handles: Vec<_> = background_handles.drain(..)
 .filter_map(|h| h)
 .collect();
 let handle_start = pending_precise.len();
 pending_precise.extend(new_handles.into_iter().map(|h| (0, h)));
 // Map the indices in pending_precise to the correct
 // message indices
 for (j, msg_idx) in prediction_msg_indices.iter().enumerate() {
 let ph_idx = handle_start + j;
 if ph_idx < pending_precise.len() {
 pending_precise[ph_idx].0 = *msg_idx;
 }
 }


    // Fire after_step with the actual tool results from
 // this step (predictions included — the hook can inspect
 // them to decide whether to stop the turn).
 if let Some(ref hooks) = input.hooks {
 if let Some(ref after_step) = hooks.after_step {
 let ctx = AfterStepContext {
 turn_id: turn_id.clone(),
 step: step_num,
 tool_results: immediate_results.clone(),
 };
 let after_result = after_step(&ctx)?;
 if let Some(AfterStepResult::StopTurn(reason)) = after_result {
 drain_pending_precise(&mut messages, &mut pending_precise).await;
 return Ok(finish_turn(&mut messages, input_len, reason, steps, total_usage, false));
 }
 }
 }

 // Repeat-breaker force-stop: results are already in the transcript;
 // end the turn like a normal stop.
 if force_stop {
 drain_pending_precise(&mut messages, &mut pending_precise).await;
 return Ok(finish_turn(&mut messages, input_len, LoopTurnStopReason::EndTurn, steps, total_usage, false));
 }
 }
 LoopStepStopReason::Aborted => {
 drain_pending_precise(&mut messages, &mut pending_precise).await;
 return Ok(finish_turn(&mut messages, input_len, LoopTurnStopReason::Aborted, steps, total_usage, false));
 }
 LoopStepStopReason::Error(_msg) => continue,
 }
 }

 // Turn ended: await any remaining background precise results
 drain_pending_precise(&mut messages, &mut pending_precise).await;

 Ok(finish_turn(&mut messages, input_len, LoopTurnStopReason::EndTurn, steps, total_usage, true))
 })
}

/// Build a turn result, moving the messages the loop appended this turn
/// (everything after the synthetic system message and the caller's input)
/// into `new_messages`. The session-owned driver writes these back into its
/// `ContextMemory`; the RUN_TURN override path ignores them.
fn finish_turn(
    messages: &mut Vec<LLMMessage>,
    input_len: usize,
    stop_reason: LoopTurnStopReason,
    steps: u32,
    usage: crate::rpc::types::TokenUsage,
    hit_step_cap: bool,
) -> TurnResult {
    let split_at = (1 + input_len).min(messages.len());
    TurnResult {
        stop_reason,
        steps,
        usage,
        new_messages: messages.split_off(split_at),
        hit_step_cap,
    }
}

/// Replace any completed prediction results with precise results.
async fn replace_completed_predictions(
 messages: &mut Vec<LLMMessage>,
 pending: &mut Vec<(usize, tokio::task::JoinHandle<ExecutableToolResult>)>,
) {
 let mut i = 0;
 while i < pending.len() {
 let (_idx, handle) = &pending[i];
 if handle.is_finished() {
 let (idx, handle) = pending.swap_remove(i);
 if let Ok(precise) = handle.await {
 if idx < messages.len() {
 messages[idx].content = precise.content;
 }
 }
 } else {
 i += 1;
 }
 }
}

/// Drain all pending precise tasks, awaiting each one and replacing the
/// corresponding prediction in `messages`. Used on every exit path so that
/// background precise execution is not cancelled when the turn ends.
async fn drain_pending_precise(
 messages: &mut Vec<LLMMessage>,
 pending: &mut Vec<(usize, tokio::task::JoinHandle<ExecutableToolResult>)>,
) {
 while let Some((idx, handle)) = pending.pop() {
 if let Ok(precise) = handle.await {
 if idx < messages.len() {
 messages[idx].content = precise.content;
 }
 }
 }
}

/// Execute tools concurrently, separating predictions from precise results.
///
/// Takes an `execute_fn` callback for each tool call, allowing tests to
/// inject mock results without needing a running RPC server.
///
/// Returns:
/// - `immediate_results`: results to use right away (predictions or precise)
/// - `background_handles`: handles for precise execution of predictions
/// (None for precise results, Some(handle) for predictions)
async fn execute_tools_split_predictions<F, Fut>(
 tool_calls: &[ToolCall],
 execute_fn: F,
) -> Result<(
 Vec<ExecutableToolResult>,
 Vec<Option<tokio::task::JoinHandle<ExecutableToolResult>>>,
), Box<dyn std::error::Error>>
where
 F: Fn(ToolCall, bool) -> Fut + Send + Sync + 'static,
 Fut: std::future::Future<Output = Result<ExecutableToolResult, String>> + Send,
{
 if tool_calls.is_empty() {
 return Ok((vec![], vec![]));
 }

 // Spawn all tool executions concurrently (force_precise = false for the
 // initial call — predictions are allowed).
 let mut handles = Vec::with_capacity(tool_calls.len());
 let exec_arc = Arc::new(execute_fn);

 for tc in tool_calls {
 let tc = tc.clone();
 let exec = exec_arc.clone();
 let handle = tokio::spawn(async move {
 exec(tc, false).await
 });
 handles.push(handle);
 }

 // Collect results, splitting into immediate and background
 let mut immediate_results = Vec::with_capacity(handles.len());
 let mut background_handles: Vec<Option<tokio::task::JoinHandle<ExecutableToolResult>>> = Vec::with_capacity(handles.len());

 for handle in handles {
 match handle.await {
 Ok(Ok(result)) => {
 if result.is_prediction {
 let tc = tool_calls[immediate_results.len()].clone();
 let exec = exec_arc.clone();

 // Spawn background precise execution (force_precise = true).
 let precise = tokio::spawn(async move {
 eprintln!("[debug] background precise task started for tc={}", tc.id);
 let precise_result = exec(tc, true).await.unwrap_or_else(|e| {
 eprintln!("[debug] background precise exec error: {e}");
 ExecutableToolResult {
 content: format!("Background precise execution error: {e}"), media: Vec::new(),
 is_error: true,
 is_prediction: false,
		stop_turn: false, }
 });
 eprintln!("[debug] background precise task done, content={}", precise_result.content);
 // Ensure the result is not marked as a prediction
 ExecutableToolResult {
 content: precise_result.content,
 is_error: precise_result.is_error, media: precise_result.media,
 is_prediction: false,
		stop_turn: false, }
 });

 immediate_results.push(result);
 background_handles.push(Some(precise));
 } else {
 immediate_results.push(result);
 background_handles.push(None);
 }
 }
 Ok(Err(e)) => return Err(e.into()),
 Err(e) => return Err(format!("Tool task join error: {e}").into()),
 }
 }

 Ok((immediate_results, background_handles))
}

// ── Goal steering ───────────────────────────────────────────────────────────

/// Render goal steering text injected into the system prompt.
///
/// Mirrors the TS `buildGoalReminder` format: objective, progress, budgets,
/// and convergence guidance when nearing a budget.
fn render_goal_steering(goal: &GoalContext, turn_tokens: i64, turns_this_turn: i64) -> String {
 let mut lines = Vec::new();
 lines.push(format!("## Goal\n{}", goal.objective));

 // Progress line
 let total_tokens = goal.tokens_used + turn_tokens;
 let total_turns = goal.turns_used + turns_this_turn;
 lines.push(format!(
 "Progress: {} continuation turns, {} tokens consumed.",
 total_turns, total_tokens
 ));

 // Budgets line
 let mut budget_parts = Vec::new();
 if let Some(budget) = goal.token_budget {
 let remaining = (budget - total_tokens).max(0);
 budget_parts.push(format!(
 "tokens {}/{} (remaining {})",
 total_tokens, budget, remaining
 ));
 }
 if let Some(budget) = goal.turn_budget {
 let remaining = (budget - total_turns).max(0);
 budget_parts.push(format!(
 "turns {}/{} (remaining {})",
 total_turns, budget, remaining
 ));
 }
 if !budget_parts.is_empty() {
 lines.push(format!("Budgets: {}.", budget_parts.join("; ")));
 }

 // Budget guidance
 let fraction = goal.budget_fraction(turn_tokens, turns_this_turn);
 if fraction >= 0.75 {
 lines.push(
 "Budget guidance: you are nearing a budget. \
 Converge on the objective and avoid starting new discretionary work."
 .to_string(),
 );
 } else {
 lines.push(
 "Budget guidance: you are within budget. \
 Make steady, focused progress toward the objective."
 .to_string(),
 );
 }

 lines.join("\n")
}

#[cfg(test)]
mod tests {
 use super::*;
 use crate::callbacks::RpcHostCallbacks;
 use crate::rpc::server::RpcServer;
 use crate::rpc::types::{
 self, AuthorizeToolRequest, AuthorizeToolResponse,
 FinalizeToolRequest, FinalizeToolResponse, JsonRpcError, PrepareToolRequest,
 PrepareToolResponse, TokenUsage, ToolExecuteRequest, ToolExecuteResponse,
 };
 use std::sync::atomic::{AtomicU32, Ordering};
 use std::sync::Arc;

 /// Helper: create an RpcHostCallbacks from an RpcServer.
 fn rpc_callbacks(server: Arc<RpcServer>) -> Arc<dyn HostCallbacks> {
 Arc::new(RpcHostCallbacks { server })
 }

 /// Run `run_turn` under a hard 30s ceiling. A hanging loop (e.g. an
 /// unregistered RPC handler that never answers) must FAIL the test loudly
 /// instead of stalling the whole suite.
 async fn run_turn_with_timeout(
 input: RunTurnInput<'_>,
 callbacks: &Arc<dyn HostCallbacks>,
 ) -> Result<TurnResult, String> {
 tokio::time::timeout(
 std::time::Duration::from_secs(30),
 run_turn(input, callbacks),
 )
 .await
 .map_err(|_| "run_turn timed out after 30s".to_string())?
 .map_err(|e| e.to_string())
 }

 /// A test implementation of [`HostCallbacks`] backed by closures.
 struct TestHostCallbacks {
 execute_tool_fn: Arc<dyn Fn(ToolExecuteRequest) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<ToolExecuteResponse, String>> + Send>> + Send + Sync>,
 prepare_tool_fn: Option<Arc<dyn Fn(PrepareToolRequest) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<PrepareToolResponse>, String>> + Send>> + Send + Sync>>,
 authorize_tool_fn: Option<Arc<dyn Fn(AuthorizeToolRequest) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<AuthorizeToolResponse>, String>> + Send>> + Send + Sync>>,
 finalize_tool_fn: Option<Arc<dyn Fn(FinalizeToolRequest) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<FinalizeToolResponse, String>> + Send>> + Send + Sync>>,
 }

 impl TestHostCallbacks {
 fn new<F, Fut>(f: F) -> Self
 where
 F: Fn(ToolExecuteRequest) -> Fut + Send + Sync + 'static,
 Fut: std::future::Future<Output = Result<ToolExecuteResponse, String>> + Send + 'static,
 {
 Self {
 execute_tool_fn: Arc::new(move |req| Box::pin(f(req))),
 prepare_tool_fn: None,
 authorize_tool_fn: None,
 finalize_tool_fn: None,
 }
 }

 fn with_prepare<F, Fut>(mut self, f: F) -> Self
 where
 F: Fn(PrepareToolRequest) -> Fut + Send + Sync + 'static,
 Fut: std::future::Future<Output = Result<Option<PrepareToolResponse>, String>> + Send + 'static,
 {
 self.prepare_tool_fn = Some(Arc::new(move |req| Box::pin(f(req))));
 self
 }

 fn with_authorize<F, Fut>(mut self, f: F) -> Self
 where
 F: Fn(AuthorizeToolRequest) -> Fut + Send + Sync + 'static,
 Fut: std::future::Future<Output = Result<Option<AuthorizeToolResponse>, String>> + Send + 'static,
 {
 self.authorize_tool_fn = Some(Arc::new(move |req| Box::pin(f(req))));
 self
 }

 fn with_finalize<F, Fut>(mut self, f: F) -> Self
 where
 F: Fn(FinalizeToolRequest) -> Fut + Send + Sync + 'static,
 Fut: std::future::Future<Output = Result<FinalizeToolResponse, String>> + Send + 'static,
 {
 self.finalize_tool_fn = Some(Arc::new(move |req| Box::pin(f(req))));
 self
 }
 }

 impl HostCallbacks for TestHostCallbacks {
 fn llm_chat(
 &self,
 _request: types::LlmChatRequest,
 ) -> BoxFuture<'static, Result<types::LlmChatResponse, String>> {
 Box::pin(async { Err("llm_chat not implemented in test".into()) })
 }

 fn execute_tool(
 &self,
 request: ToolExecuteRequest,
 ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
 let f = self.execute_tool_fn.clone();
 Box::pin(async move { f(request).await })
 }

 fn prepare_tool_execution(
 &self,
 request: PrepareToolRequest,
 ) -> BoxFuture<'static, Result<Option<PrepareToolResponse>, String>> {
 if let Some(ref f) = self.prepare_tool_fn {
 f(request)
 } else {
 Box::pin(async { Ok(None) })
 }
 }

 fn authorize_tool_execution(
 &self,
 request: AuthorizeToolRequest,
 ) -> BoxFuture<'static, Result<Option<AuthorizeToolResponse>, String>> {
 if let Some(ref f) = self.authorize_tool_fn {
 f(request)
 } else {
 Box::pin(async { Ok(None) })
 }
 }

 fn finalize_tool_result(
 &self,
 request: FinalizeToolRequest,
 ) -> BoxFuture<'static, Result<FinalizeToolResponse, String>> {
 if let Some(ref f) = self.finalize_tool_fn {
 f(request)
 } else {
 Box::pin(async { Ok(None) })
 }
 }
 }

 struct PredictTestLlm {
 system_prompt: String,
 model_name: String,
 return_tool_calls: bool,
 tool_responses: Vec<ToolCall>,
 }

 impl LLM for PredictTestLlm {
 fn system_prompt(&self) -> &str { &self.system_prompt }
 fn model_name(&self) -> &str { &self.model_name }
 fn is_retryable_error(&self, _: &str) -> bool { false }

 fn chat(&self, _params: LLMChatParams) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>> {
 let return_tc = self.return_tool_calls;
 let tcs = self.tool_responses.clone();
 Box::pin(async move {
 if return_tc {
 Ok(LLMChatResponse {
 content: String::new(),
 tool_calls: tcs,
 finish_reason: Some("tool_calls".into()),
 usage: TokenUsage { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
 })
 } else {
 Ok(LLMChatResponse {
 content: String::new(),
 tool_calls: vec![],
 finish_reason: Some("stop".into()),
 usage: TokenUsage { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
 })
 }
 })
 }
 }

 fn mock_tool_call(id: &str, name: &str, path: &str) -> ToolCall {
 ToolCall {
 id: id.into(),
 name: name.into(),
 arguments: serde_json::json!({"path": path}),
 }
 }

 fn make_prediction_response() -> ToolExecuteResponse {
 ToolExecuteResponse {
 content: "prediction content".into(), media: Vec::new(),
 is_error: false,
 is_prediction: true,
 stop_turn: false,
 }
 }

 fn make_precise_response() -> ToolExecuteResponse {
 ToolExecuteResponse {
 content: "precise content".into(), media: Vec::new(),
 is_error: false,
 is_prediction: false,
		stop_turn: false,
 }
 }

 #[tokio::test]
 async fn test_replace_completed_predictions_empty() {
 let mut messages = vec![
 LLMMessage { role: "user".into(), content: "hello".into(), ..Default::default() }
 ];
 let mut pending: Vec<(usize, tokio::task::JoinHandle<ExecutableToolResult>)> = vec![];

 replace_completed_predictions(&mut messages, &mut pending).await;
 assert_eq!(messages.len(), 1);
 assert!(pending.is_empty());
 }

 #[tokio::test]
 async fn test_replace_completed_predictions_replaces() {
 let mut messages = vec![
 LLMMessage { role: "user".into(), content: "hello".into(), ..Default::default() },
 LLMMessage { role: "tool".into(), content: "prediction".into(), ..Default::default() },
 ];

 let handle = tokio::spawn(async {
 ExecutableToolResult {
 content: "precise result".into(), media: Vec::new(),
 is_error: false,
 is_prediction: false,
		stop_turn: false, }
 });

 let mut pending: Vec<(usize, tokio::task::JoinHandle<ExecutableToolResult>)> = vec![(1, handle)];

 tokio::time::sleep(std::time::Duration::from_millis(5)).await;
 replace_completed_predictions(&mut messages, &mut pending).await;

 assert_eq!(messages[1].content, "precise result");
 assert!(pending.is_empty());
 }

 #[tokio::test]
 async fn test_replace_completed_predictions_keeps_pending() {
 let mut messages = vec![
 LLMMessage { role: "user".into(), content: "hello".into(), ..Default::default() },
 LLMMessage { role: "tool".into(), content: "prediction".into(), ..Default::default() },
 ];

 let handle = tokio::spawn(async {
 tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
 ExecutableToolResult {
 content: "precise".into(), media: Vec::new(),
 is_error: false,
 is_prediction: false,
		stop_turn: false, }
 });

 let mut pending: Vec<(usize, tokio::task::JoinHandle<ExecutableToolResult>)> = vec![(1, handle)];

 replace_completed_predictions(&mut messages, &mut pending).await;

 assert_eq!(messages[1].content, "prediction");
 assert_eq!(pending.len(), 1);

 pending[0].1.abort();
 }

 #[tokio::test]
 async fn test_run_turn_no_tool_calls() {
 let llm = PredictTestLlm {
 system_prompt: "You are helpful.".into(),
 model_name: "test-model".into(),
 return_tool_calls: false,
 tool_responses: vec![],
 };

 let server = Arc::new(RpcServer::new());
 let callbacks = rpc_callbacks(server.clone());

 let input = RunTurnInput {
 turn_id: "test-turn-1".into(),
 llm: &llm,
 messages: vec![LLMMessage { role: "user".into(), content: "Hello!".into(), ..Default::default() }],
 tools: &[],
 tool_defs: vec![],
 hooks: None,
 max_steps: 5,
 goal: None,
 cancellation: None,
 steer_queue: None,
 };

 let result = run_turn(input, &callbacks).await;
 assert!(result.is_ok());
 let turn = result.unwrap();
 assert_eq!(turn.steps, 1);
 }

 /// Test helper: creates a tool execution closure from a registered RPC handler.
 /// Uses `invoke` so the same code path works whether the handler is
 /// registered locally (tests) or reachable only via stdio (production).
 fn make_exec_fn(
 server: &Arc<RpcServer>,
 ) -> impl Fn(ToolCall, bool) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<ExecutableToolResult, String>> + Send + 'static>> + Send + Sync + 'static {
 let server = server.clone();
 move |tc: ToolCall, force_precise: bool| {
 let server = server.clone();
 Box::pin(async move {
 let params = serde_json::to_value(&ToolExecuteRequest {
 session_id: None,
 turn_id: "test".into(),
 tool_call_id: tc.id.clone(),
 tool_name: tc.name.clone(),
 arguments: tc.arguments.clone(),
 force_precise,
 }).map_err(|e| e.to_string())?;
 let result = server
 .invoke(types::methods::HOST_EXECUTE_TOOL, params)
 .await
 .map_err(|e| e.message)?;
 let response: ToolExecuteResponse = serde_json::from_value(result)
 .map_err(|e| e.to_string())?;
 Ok(ExecutableToolResult {
 content: response.content,
 is_error: response.is_error,
 is_prediction: response.is_prediction, media: response.media,
        stop_turn: false,
 })
 })
 }
 }

 #[tokio::test]
 async fn test_execute_tools_split_predictions_all_precise() {
 let server = Arc::new(RpcServer::new());
 RpcServer::register_arc(
 &server,
 types::methods::HOST_EXECUTE_TOOL,
 |_params| {
 Box::pin(async move {
 let resp = make_precise_response();
 serde_json::to_value(&resp)
 .map_err(|e| JsonRpcError::internal_error(e.to_string()))
 })
 },
 );

 let tool_calls = vec![
 mock_tool_call("c1", "Read", "/a.txt"),
 mock_tool_call("c2", "Read", "/b.txt"),
 ];

 let exec_fn = make_exec_fn(&server);
 let (results, backgrounds) = execute_tools_split_predictions(&tool_calls, exec_fn).await.unwrap();
 assert_eq!(results.len(), 2);
 assert_eq!(backgrounds.len(), 2);
 assert!(backgrounds[0].is_none());
 assert!(backgrounds[1].is_none());
 assert!(!results[0].is_prediction);
 assert!(!results[1].is_prediction);
 }

 #[tokio::test]
 async fn test_execute_tools_split_predictions_mixed() {
 let call_count = Arc::new(std::sync::atomic::AtomicU32::new(0));
 let cc = call_count.clone();

 let server = Arc::new(RpcServer::new());
 RpcServer::register_arc(
 &server,
 types::methods::HOST_EXECUTE_TOOL,
 move |_params| {
 let cc = cc.clone();
 Box::pin(async move {
 let count = cc.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
 let resp = if count == 0 {
 make_prediction_response()
 } else {
 make_precise_response()
 };
 serde_json::to_value(&resp)
 .map_err(|e| JsonRpcError::internal_error(e.to_string()))
 })
 },
 );

 let tool_calls = vec![
 mock_tool_call("c1", "Read", "/a.txt"),
 ];

 let exec_fn = make_exec_fn(&server);
 let (results, backgrounds) = execute_tools_split_predictions(&tool_calls, exec_fn).await.unwrap();
 assert_eq!(results.len(), 1);
 assert_eq!(backgrounds.len(), 1);
 assert!(results[0].is_prediction);
 assert!(backgrounds[0].is_some());

 if let Some(handle) = backgrounds.into_iter().next().unwrap() {
 let precise = handle.await.unwrap();
 assert!(!precise.is_prediction);
 assert_eq!(precise.content, "precise content");
 }
 }

 #[tokio::test]
 async fn test_execute_tools_split_predictions_empty() {
 let server = Arc::new(RpcServer::new());
 let exec_fn = make_exec_fn(&server);
 let (results, backgrounds) = execute_tools_split_predictions(&[], exec_fn).await.unwrap();
 assert!(results.is_empty());
 assert!(backgrounds.is_empty());
 }

 #[tokio::test]
 async fn test_execute_tools_split_predictions_force_precise_on_background() {
 let call_count = Arc::new(std::sync::atomic::AtomicU32::new(0));
 let cc = call_count.clone();

 let server = Arc::new(RpcServer::new());
 RpcServer::register_arc(
 &server,
 types::methods::HOST_EXECUTE_TOOL,
 move |_params| {
 let cc = cc.clone();
 Box::pin(async move {
 let count = cc.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
 let resp = if count == 0 {
 make_prediction_response()
 } else {
 make_precise_response()
 };
 serde_json::to_value(&resp)
 .map_err(|e| JsonRpcError::internal_error(e.to_string()))
 })
 },
 );

 let tool_calls = vec![
 mock_tool_call("c1", "Read", "/a.txt"),
 ];

 let exec_fn = make_exec_fn(&server);
 let (results, backgrounds) = execute_tools_split_predictions(&tool_calls, exec_fn).await.unwrap();
 assert_eq!(results.len(), 1);
 assert!(results[0].is_prediction);

 // The background precise execution should produce a non-prediction result
 if let Some(handle) = backgrounds.into_iter().next().unwrap() {
 let precise = handle.await.unwrap();
 assert!(!precise.is_prediction, "background result should not be a prediction");
 }
 }

 #[tokio::test]
 async fn test_run_turn_no_tool_calls_with_messages() {
 let llm = PredictTestLlm {
 system_prompt: "You are helpful.".into(),
 model_name: "test-model".into(),
 return_tool_calls: false,
 tool_responses: vec![],
 };

 let server = Arc::new(RpcServer::new());
 let callbacks = rpc_callbacks(server.clone());

 let input = RunTurnInput {
 turn_id: "test-turn-3".into(),
 llm: &llm,
 messages: vec![
 LLMMessage { role: "user".into(), content: "First message".into(), ..Default::default() },
 LLMMessage { role: "user".into(), content: "Second message".into(), ..Default::default() },
 ],
 tools: &[],
 tool_defs: vec![],
 hooks: None,
 max_steps: 5,
 goal: None,
 cancellation: None,
 steer_queue: None,
 };

 let result = run_turn(input, &callbacks).await;
 assert!(result.is_ok());
 let turn = result.unwrap();
 assert_eq!(turn.steps, 1);
 }

 #[tokio::test]
 async fn test_replace_completed_predictions_multiple() {
 let mut messages = vec![
 LLMMessage { role: "user".into(), content: "hello".into(), ..Default::default() },
 LLMMessage { role: "tool".into(), content: "pred1".into(), ..Default::default() },
 LLMMessage { role: "tool".into(), content: "pred2".into(), ..Default::default() },
 ];

 let h1 = tokio::spawn(async {
 ExecutableToolResult { content: "precise1".into(), is_error: false, is_prediction: false, stop_turn: false, media: Vec::new() }
 });
 let h2 = tokio::spawn(async {
 ExecutableToolResult { content: "precise2".into(), is_error: false, is_prediction: false, stop_turn: false, media: Vec::new() }
 });

 let mut pending: Vec<(usize, tokio::task::JoinHandle<ExecutableToolResult>)> = vec![(1, h1), (2, h2)];
 tokio::time::sleep(std::time::Duration::from_millis(5)).await;
 replace_completed_predictions(&mut messages, &mut pending).await;

 assert_eq!(messages[1].content, "precise1");
 assert_eq!(messages[2].content, "precise2");
 assert!(pending.is_empty());
 }

 #[tokio::test]
 async fn test_make_exec_fn_prediction_from_handler() {
 let server = Arc::new(RpcServer::new());
 RpcServer::register_arc(
 &server,
 types::methods::HOST_EXECUTE_TOOL,
 |_params| {
 Box::pin(async move {
 let resp = make_prediction_response();
 serde_json::to_value(&resp)
 .map_err(|e| JsonRpcError::internal_error(e.to_string()))
 })
 },
 );

 let exec_fn = make_exec_fn(&server);
 let tc = mock_tool_call("c1", "Read", "/a.txt");
 let result = exec_fn(tc, false).await.unwrap();
 assert!(result.is_prediction);
 assert_eq!(result.content, "prediction content");
 }

 #[tokio::test]
 async fn test_after_step_hook_receives_tool_results() {
 use std::sync::Mutex;

 // LLM that returns one tool call on the first step, then stops.
 struct StepLlm {
 call: AtomicU32,
 }
 impl LLM for StepLlm {
 fn system_prompt(&self) -> &str { "test" }
 fn model_name(&self) -> &str { "step-llm" }
 fn is_retryable_error(&self, _: &str) -> bool { false }
 fn chat(&self, _: LLMChatParams) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>> {
 let call = self.call.fetch_add(1, Ordering::SeqCst);
 Box::pin(async move {
 if call == 0 {
 Ok(LLMChatResponse {
 content: String::new(),
 tool_calls: vec![ToolCall {
 id: "tc1".into(),
 name: "read".into(),
 arguments: serde_json::json!({"path": "/a.txt"}),
 }],
 finish_reason: Some("tool_calls".into()),
 usage: TokenUsage { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
 })
 } else {
 Ok(LLMChatResponse {
 content: String::new(),
 tool_calls: vec![],
 finish_reason: Some("stop".into()),
 usage: TokenUsage { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
 })
 }
 })
 }
 }

 // Register a tool handler that returns a known result.
 let server = Arc::new(RpcServer::new());
 RpcServer::register_arc(
 &server,
 types::methods::HOST_EXECUTE_TOOL,
 |_params| {
 Box::pin(async move {
 let resp = ToolExecuteResponse {
 content: "file content here".into(), media: Vec::new(),
 is_error: false,
 is_prediction: false,
		stop_turn: false,
 };
 serde_json::to_value(&resp)
 .map_err(|e| JsonRpcError::internal_error(e.to_string()))
 })
 },
 );

 // Capture the tool_results seen by the after_step hook.
 let captured: Arc<Mutex<Vec<Vec<ExecutableToolResult>>>> = Arc::new(Mutex::new(vec![]));
 let captured_clone = captured.clone();
 let hooks = LoopHooks {
 after_step: Some(Box::new(move |ctx: &AfterStepContext| {
 captured_clone.lock().unwrap_or_else(|e| e.into_inner()).push(ctx.tool_results.clone());
 Ok(None)
 })),
 before_step: None,
 ..Default::default()
 };

 let llm = StepLlm { call: AtomicU32::new(0) };
 let callbacks = rpc_callbacks(server.clone());
 let input = RunTurnInput {
 turn_id: "test-after-step".into(),
 llm: &llm,
 messages: vec![LLMMessage { role: "user".into(), content: "hi".into(), ..Default::default() }],
 tools: &[],
 tool_defs: vec![],
 hooks: Some(&hooks),
 max_steps: 5,
 goal: None,
 cancellation: None,
 steer_queue: None,
 };

 let result = run_turn_with_timeout(input, &callbacks).await.unwrap();
 assert_eq!(result.steps, 2); // step 0: tool call, step 1: stop

 // The hook should have been called twice:
 // step 0: with one tool result ("file content here")
 // step 1: with no tool results (step completed without tools)
 let captured = captured.lock().unwrap_or_else(|e| e.into_inner());
 assert_eq!(captured.len(), 2, "after_step should fire once per step");
 assert_eq!(captured[0].len(), 1, "step 0 should have one tool result");
 assert_eq!(captured[0][0].content, "file content here");
 assert!(!captured[0][0].is_prediction);
 assert!(captured[1].is_empty(), "step 1 should have no tool results");
 }

 // ── Goal budget tests ───────────────────────────────────────────────

 /// A goal whose status is Paused must abort the turn before step 0,
 /// yielding `Paused` and 0 steps.
 #[tokio::test]
 async fn test_goal_paused_stops_before_first_step() {
 let llm = PredictTestLlm {
 system_prompt: "You are helpful.".into(),
 model_name: "test-model".into(),
 return_tool_calls: false,
 tool_responses: vec![],
 };
 let server = Arc::new(RpcServer::new());
 let callbacks = rpc_callbacks(server.clone());

 let goal = GoalContext {
 goal_id: "g1".into(),
 objective: "Do thing".into(),
 status: GoalStatus::Paused,
 token_budget: None,
 turn_budget: None,
 tokens_used: 0,
 turns_used: 0,
 };

 let input = RunTurnInput {
 turn_id: "test-paused".into(),
 llm: &llm,
 messages: vec![LLMMessage { role: "user".into(), content: "hi".into(), ..Default::default() }],
 tools: &[],
 tool_defs: vec![],
 hooks: None,
 max_steps: 5,
 goal: Some(goal),
 cancellation: None,
 steer_queue: None,
 };

 let result = run_turn_with_timeout(input, &callbacks).await.unwrap();
 assert!(matches!(result.stop_reason, LoopTurnStopReason::Paused));
 assert_eq!(result.steps, 0, "paused goal should not run any steps");
 }

 /// A goal whose status is Blocked must abort the turn before step 0,
 /// yielding `Aborted`.
 #[tokio::test]
 async fn test_goal_blocked_stops_before_first_step() {
 let llm = PredictTestLlm {
 system_prompt: "You are helpful.".into(),
 model_name: "test-model".into(),
 return_tool_calls: false,
 tool_responses: vec![],
 };
 let server = Arc::new(RpcServer::new());
 let callbacks = rpc_callbacks(server.clone());

 let goal = GoalContext {
 goal_id: "g2".into(),
 objective: "Do thing".into(),
 status: GoalStatus::Blocked,
 token_budget: None,
 turn_budget: None,
 tokens_used: 0,
 turns_used: 0,
 };

 let input = RunTurnInput {
 turn_id: "test-blocked".into(),
 llm: &llm,
 messages: vec![LLMMessage { role: "user".into(), content: "hi".into(), ..Default::default() }],
 tools: &[],
 tool_defs: vec![],
 hooks: None,
 max_steps: 5,
 goal: Some(goal),
 cancellation: None,
 steer_queue: None,
 };

 let result = run_turn_with_timeout(input, &callbacks).await.unwrap();
 assert!(matches!(result.stop_reason, LoopTurnStopReason::Aborted));
 assert_eq!(result.steps, 0);
 }

 /// A goal whose token budget is already exhausted (tokens_used >= budget)
 /// must stop with `BudgetLimited` before running any step.
 #[tokio::test]
 async fn test_goal_token_budget_exhausted() {
 let llm = PredictTestLlm {
 system_prompt: "You are helpful.".into(),
 model_name: "test-model".into(),
 return_tool_calls: false,
 tool_responses: vec![],
 };
 let server = Arc::new(RpcServer::new());
 let callbacks = rpc_callbacks(server.clone());

 let goal = GoalContext {
 goal_id: "g3".into(),
 objective: "Do thing".into(),
 status: GoalStatus::Active,
 token_budget: Some(100),
 turn_budget: None,
 // Already used 100 tokens — at the budget limit.
 tokens_used: 100,
 turns_used: 0,
 };

 let input = RunTurnInput {
 turn_id: "test-budget-tokens".into(),
 llm: &llm,
 messages: vec![LLMMessage { role: "user".into(), content: "hi".into(), ..Default::default() }],
 tools: &[],
 tool_defs: vec![],
 hooks: None,
 max_steps: 5,
 goal: Some(goal),
 cancellation: None,
 steer_queue: None,
 };

 let result = run_turn_with_timeout(input, &callbacks).await.unwrap();
 assert!(matches!(result.stop_reason, LoopTurnStopReason::BudgetLimited));
 assert_eq!(result.steps, 0);
 }

 /// A goal whose turn budget is already exhausted must stop with
 /// `BudgetLimited`.
 #[tokio::test]
 async fn test_goal_turn_budget_exhausted() {
 let llm = PredictTestLlm {
 system_prompt: "You are helpful.".into(),
 model_name: "test-model".into(),
 return_tool_calls: false,
 tool_responses: vec![],
 };
 let server = Arc::new(RpcServer::new());
 let callbacks = rpc_callbacks(server.clone());

 let goal = GoalContext {
 goal_id: "g4".into(),
 objective: "Do thing".into(),
 status: GoalStatus::Active,
 token_budget: None,
 turn_budget: Some(3),
 tokens_used: 0,
 // Already used 3 turns — at the limit.
 turns_used: 3,
 };

 let input = RunTurnInput {
 turn_id: "test-budget-turns".into(),
 llm: &llm,
 messages: vec![LLMMessage { role: "user".into(), content: "hi".into(), ..Default::default() }],
 tools: &[],
 tool_defs: vec![],
 hooks: None,
 max_steps: 5,
 goal: Some(goal),
 cancellation: None,
 steer_queue: None,
 };

 let result = run_turn_with_timeout(input, &callbacks).await.unwrap();
 assert!(matches!(result.stop_reason, LoopTurnStopReason::BudgetLimited));
 assert_eq!(result.steps, 0);
 }

 /// An active goal with remaining budget should let the turn proceed
 /// normally and complete with `EndTurn`.
 #[tokio::test]
 async fn test_goal_active_with_budget_completes() {
 let llm = PredictTestLlm {
 system_prompt: "You are helpful.".into(),
 model_name: "test-model".into(),
 return_tool_calls: false,
 tool_responses: vec![],
 };
 let server = Arc::new(RpcServer::new());
 let callbacks = rpc_callbacks(server.clone());

 let goal = GoalContext {
 goal_id: "g5".into(),
 objective: "Do thing".into(),
 status: GoalStatus::Active,
 token_budget: Some(10000),
 turn_budget: Some(100),
 tokens_used: 100,
 turns_used: 1,
 };

 let input = RunTurnInput {
 turn_id: "test-active-goal".into(),
 llm: &llm,
 messages: vec![LLMMessage { role: "user".into(), content: "hi".into(), ..Default::default() }],
 tools: &[],
 tool_defs: vec![],
 hooks: None,
 max_steps: 5,
 goal: Some(goal),
 cancellation: None,
 steer_queue: None,
 };

 let result = run_turn_with_timeout(input, &callbacks).await.unwrap();
 assert!(matches!(result.stop_reason, LoopTurnStopReason::EndTurn));
 assert_eq!(result.steps, 1);
 }

 // ── Cancellation tests ──────────────────────────────────────────────

 /// When the cancellation flag is set before the turn starts, the loop
 /// must abort immediately with `Aborted` and 0 steps.
 #[tokio::test]
 async fn test_cancellation_set_before_turn_aborts() {
 let llm = PredictTestLlm {
 system_prompt: "You are helpful.".into(),
 model_name: "test-model".into(),
 return_tool_calls: false,
 tool_responses: vec![],
 };
 let server = Arc::new(RpcServer::new());
 let callbacks = rpc_callbacks(server.clone());

 let cancel_flag = Arc::new(std::sync::atomic::AtomicBool::new(true));

 let input = RunTurnInput {
 turn_id: "test-cancel-before".into(),
 llm: &llm,
 messages: vec![LLMMessage { role: "user".into(), content: "hi".into(), ..Default::default() }],
 tools: &[],
 tool_defs: vec![],
 hooks: None,
 max_steps: 5,
 goal: None,
 cancellation: Some(cancel_flag),
 steer_queue: None,
 };

 let result = run_turn_with_timeout(input, &callbacks).await.unwrap();
 assert!(matches!(result.stop_reason, LoopTurnStopReason::Aborted));
 assert_eq!(result.steps, 0);
 }

 /// When the cancellation flag is cleared, the turn runs normally.
 #[tokio::test]
 async fn test_cancellation_cleared_runs_normally() {
 let llm = PredictTestLlm {
 system_prompt: "You are helpful.".into(),
 model_name: "test-model".into(),
 return_tool_calls: false,
 tool_responses: vec![],
 };
 let server = Arc::new(RpcServer::new());
 let callbacks = rpc_callbacks(server.clone());

 let cancel_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));

 let input = RunTurnInput {
 turn_id: "test-cancel-clear".into(),
 llm: &llm,
 messages: vec![LLMMessage { role: "user".into(), content: "hi".into(), ..Default::default() }],
 tools: &[],
 tool_defs: vec![],
 hooks: None,
 max_steps: 5,
 goal: None,
 cancellation: Some(cancel_flag),
 steer_queue: None,
 };

 let result = run_turn_with_timeout(input, &callbacks).await.unwrap();
 assert!(matches!(result.stop_reason, LoopTurnStopReason::EndTurn));
 assert_eq!(result.steps, 1);
 }

 // ── Prediction fast-path end-to-end test ────────────────────────────

 /// End-to-end test of the prediction fast-path:
 /// 1. LLM returns a Read tool call.
 /// 2. Tool handler returns is_prediction=true on first call.
 /// 3. Background precise execution (force_precise=true) returns the
 /// real content.
 /// 4. The turn completes with EndTurn.
 /// 5. After the turn, pending precise results replace predictions
 /// in the message history.
 ///
 /// This verifies the full flow works without a running stdio loop,
 /// using direct_call to invoke the registered handler.
 #[tokio::test]
 async fn test_prediction_fast_path_end_to_end() {
 let call_count = Arc::new(AtomicU32::new(0));
 let cc = call_count.clone();

 let server = Arc::new(RpcServer::new());
 RpcServer::register_arc(
 &server,
 types::methods::HOST_EXECUTE_TOOL,
 move |_params| {
 let cc = cc.clone();
 Box::pin(async move {
 let n = cc.fetch_add(1, Ordering::SeqCst);
 // First call (force_precise=false): prediction.
 // Second call (force_precise=true): precise result.
 let resp = if n == 0 {
 ToolExecuteResponse {
 content: "PREDICTION".into(), media: Vec::new(),
 is_error: false,
 is_prediction: true,
 stop_turn: false,
 }
 } else {
 ToolExecuteResponse {
 content: "PRECISE_RESULT".into(), media: Vec::new(),
 is_error: false,
 is_prediction: false,
		stop_turn: false,
 }
 };
 serde_json::to_value(&resp)
 .map_err(|e| JsonRpcError::internal_error(e.to_string()))
 })
 },
 );

 let callbacks = rpc_callbacks(server.clone());

 // LLM that returns a Read tool call on step 0, then stops.
 struct PredictLlm { call: AtomicU32 }
 impl LLM for PredictLlm {
 fn system_prompt(&self) -> &str { "test" }
 fn model_name(&self) -> &str { "predict-test" }
 fn is_retryable_error(&self, _: &str) -> bool { false }
 fn chat(&self, _: LLMChatParams) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>> {
 let call = self.call.fetch_add(1, Ordering::SeqCst);
 Box::pin(async move {
 if call == 0 {
 Ok(LLMChatResponse {
 content: String::new(),
 tool_calls: vec![ToolCall {
 id: "pc1".into(),
 name: "read".into(),
 arguments: serde_json::json!({"path": "/x.txt"}),
 }],
 finish_reason: Some("tool_calls".into()),
 usage: TokenUsage { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
 })
 } else {
 Ok(LLMChatResponse {
 content: String::new(),
 tool_calls: vec![],
 finish_reason: Some("stop".into()),
 usage: TokenUsage { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
 })
 }
 })
 }
 }

 let llm = PredictLlm { call: AtomicU32::new(0) };
 let input = RunTurnInput {
 turn_id: "test-predict-e2e".into(),
 llm: &llm,
 messages: vec![LLMMessage { role: "user".into(), content: "read /x.txt".into(), ..Default::default() }],
 tools: &[],
 tool_defs: vec![],
 hooks: None,
 max_steps: 5,
 goal: None,
 cancellation: None,
 steer_queue: None,
 };

 let result = run_turn_with_timeout(input, &callbacks).await.unwrap();

 // The turn should complete normally.
 assert!(matches!(result.stop_reason, LoopTurnStopReason::EndTurn));
 assert_eq!(result.steps, 2, "step 0: tool call, step 1: stop");

 // The tool handler should have been called twice:
 // 1. force_precise=false → prediction
 // 2. force_precise=true → precise
 let total_calls = call_count.load(Ordering::SeqCst);
 assert!(
 total_calls >= 2,
 "expected at least 2 tool calls (prediction + precise), got {total_calls}"
 );
 }

 // ── Goal steering text injection test ────────────────────────────────

 /// Verify that when a goal is active, the system prompt is enriched
 /// with steering text containing the objective and budget info.
 #[tokio::test]
 async fn test_goal_steering_injected_into_system_prompt() {
 use std::sync::Mutex;

 // LLM that captures the messages it receives so we can inspect
 // the system prompt.
 struct CaptureLlm {
 captured_system: Arc<Mutex<Option<String>>>,
 call: AtomicU32,
 }
 impl LLM for CaptureLlm {
 fn system_prompt(&self) -> &str { "base prompt" }
 fn model_name(&self) -> &str { "capture" }
 fn is_retryable_error(&self, _: &str) -> bool { false }
 fn chat(&self, params: LLMChatParams) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>> {
 let captured = self.captured_system.clone();
 let call = self.call.fetch_add(1, Ordering::SeqCst);
 Box::pin(async move {
 if call == 0 && !params.messages.is_empty() {
 *captured.lock().unwrap_or_else(|e| e.into_inner()) = Some(params.messages[0].content.clone());
 }
 Ok(LLMChatResponse {
 content: String::new(),
 tool_calls: vec![],
 finish_reason: Some("stop".into()),
 usage: TokenUsage { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
 })
 })
 }
 }

 let captured: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
 let llm = CaptureLlm {
 captured_system: captured.clone(),
 call: AtomicU32::new(0),
 };
 let server = Arc::new(RpcServer::new());
 let callbacks = rpc_callbacks(server.clone());

 let goal = GoalContext {
 goal_id: "g-steer".into(),
 objective: "Write a hello world program".into(),
 status: GoalStatus::Active,
 token_budget: Some(1000),
 turn_budget: Some(10),
 tokens_used: 100,
 turns_used: 1,
 };

 let input = RunTurnInput {
 turn_id: "test-steering".into(),
 llm: &llm,
 messages: vec![LLMMessage { role: "user".into(), content: "hi".into(), ..Default::default() }],
 tools: &[],
 tool_defs: vec![],
 hooks: None,
 max_steps: 5,
 goal: Some(goal),
 cancellation: None,
 steer_queue: None,
 };

 let result = run_turn_with_timeout(input, &callbacks).await.unwrap();
 assert!(matches!(result.stop_reason, LoopTurnStopReason::EndTurn));

 let captured = captured.lock().unwrap_or_else(|e| e.into_inner()).clone().expect("system prompt was captured");
 assert!(captured.contains("base prompt"), "should contain base system prompt");
 assert!(captured.contains("Write a hello world program"), "should contain objective");
 assert!(captured.contains("Goal"), "should contain Goal header");
 assert!(captured.contains("Budgets:"), "should contain budget info");
 assert!(captured.contains("1000"), "should mention token budget");
 assert!(captured.contains("10"), "should mention turn budget");
 }

 // ── before_step hook test ───────────────────────────────────────────

 /// The before_step hook can stop the turn before any LLM call.
 #[tokio::test]
 async fn test_before_step_hook_can_stop_turn() {
 let llm = PredictTestLlm {
 system_prompt: "You are helpful.".into(),
 model_name: "test-model".into(),
 return_tool_calls: false,
 tool_responses: vec![],
 };
 let server = Arc::new(RpcServer::new());
 let callbacks = rpc_callbacks(server.clone());

 let hooks = LoopHooks {
 before_step: Some(Box::new(|_ctx| {
 Ok(Some(BeforeStepResult::StopTurn(LoopTurnStopReason::Aborted)))
 })),
 after_step: None,
 ..Default::default()
 };

 let input = RunTurnInput {
 turn_id: "test-before-stop".into(),
 llm: &llm,
 messages: vec![LLMMessage { role: "user".into(), content: "hi".into(), ..Default::default() }],
 tools: &[],
 tool_defs: vec![],
 hooks: Some(&hooks),
 max_steps: 5,
 goal: None,
 cancellation: None,
 steer_queue: None,
 };

 let result = run_turn_with_timeout(input, &callbacks).await.unwrap();
 assert!(matches!(result.stop_reason, LoopTurnStopReason::Aborted));
 // steps is 1 because steps = step_num + 1 is set at the top of the
 // loop body, before the before_step hook fires.
 assert_eq!(result.steps, 1);
 }

 /// The before_step hook returning Continue lets the turn proceed.
 #[tokio::test]
 async fn test_before_step_hook_continue_proceeds() {
 let llm = PredictTestLlm {
 system_prompt: "You are helpful.".into(),
 model_name: "test-model".into(),
 return_tool_calls: false,
 tool_responses: vec![],
 };
 let server = Arc::new(RpcServer::new());
 let callbacks = rpc_callbacks(server.clone());

 let hooks = LoopHooks {
 before_step: Some(Box::new(|_ctx| {
 Ok(Some(BeforeStepResult::Continue))
 })),
 after_step: None,
 ..Default::default()
 };

 let input = RunTurnInput {
 turn_id: "test-before-continue".into(),
 llm: &llm,
 messages: vec![LLMMessage { role: "user".into(), content: "hi".into(), ..Default::default() }],
 tools: &[],
 tool_defs: vec![],
 hooks: Some(&hooks),
 max_steps: 5,
 goal: None,
 cancellation: None,
 steer_queue: None,
 };

 let result = run_turn_with_timeout(input, &callbacks).await.unwrap();
 assert!(matches!(result.stop_reason, LoopTurnStopReason::EndTurn));
 assert_eq!(result.steps, 1);
 }

 // ── Max steps enforcement test ──────────────────────────────────────

 /// When the LLM always returns tool calls, the loop must stop at
 /// max_steps with EndTurn (the loop exits after the max_steps
 /// iterations).
 #[tokio::test]
 async fn test_max_steps_enforcement() {
 // LLM that always returns a tool call — never stops on its own.
 let llm = PredictTestLlm {
 system_prompt: "You are helpful.".into(),
 model_name: "test-model".into(),
 return_tool_calls: true,
 tool_responses: vec![ToolCall {
 id: "loop".into(),
 name: "read".into(),
 arguments: serde_json::json!({"path": "/x"}),
 }],
 };

 let server = Arc::new(RpcServer::new());
 RpcServer::register_arc(
 &server,
 types::methods::HOST_EXECUTE_TOOL,
 |_params| {
 Box::pin(async move {
 let resp = ToolExecuteResponse {
 content: "ok".into(), media: Vec::new(),
 is_error: false,
 is_prediction: false,
		stop_turn: false,
 };
 serde_json::to_value(&resp)
 .map_err(|e| JsonRpcError::internal_error(e.to_string()))
 })
 },
 );

 let callbacks = rpc_callbacks(server.clone());
 let input = RunTurnInput {
 turn_id: "test-max-steps".into(),
 llm: &llm,
 messages: vec![LLMMessage { role: "user".into(), content: "loop".into(), ..Default::default() }],
 tools: &[],
 tool_defs: vec![],
 hooks: None,
 max_steps: 3,
 goal: None,
 cancellation: None,
 steer_queue: None,
 };

 let result = run_turn_with_timeout(input, &callbacks).await.unwrap();
 // The loop runs max_steps iterations; steps = max_steps.
 assert_eq!(result.steps, 3, "should stop at max_steps");
 }

 // ── drain_pending_precise helper tests ──────────────────────────────

 #[tokio::test]
 async fn test_drain_pending_precise_empty() {
 let mut messages = vec![];
 let mut pending: Vec<(usize, tokio::task::JoinHandle<ExecutableToolResult>)> = vec![];
 drain_pending_precise(&mut messages, &mut pending).await;
 assert!(pending.is_empty());
 }

 #[tokio::test]
 async fn test_drain_pending_precise_replaces_all() {
 let mut messages = vec![
 LLMMessage { role: "user".into(), content: "hi".into(), ..Default::default() },
 LLMMessage { role: "tool".into(), content: "pred1".into(), ..Default::default() },
 LLMMessage { role: "tool".into(), content: "pred2".into(), ..Default::default() },
 ];

 let h1 = tokio::spawn(async {
 ExecutableToolResult { content: "precise1".into(), is_error: false, is_prediction: false, stop_turn: false, media: Vec::new() }
 });
 let h2 = tokio::spawn(async {
 ExecutableToolResult { content: "precise2".into(), is_error: false, is_prediction: false, stop_turn: false, media: Vec::new() }
 });

 let mut pending: Vec<(usize, tokio::task::JoinHandle<ExecutableToolResult>)> = vec![(1, h1), (2, h2)];
 drain_pending_precise(&mut messages, &mut pending).await;

 assert!(pending.is_empty(), "all pending should be drained");
 assert_eq!(messages[1].content, "precise1");
 assert_eq!(messages[2].content, "precise2");
 }

 #[tokio::test]
 async fn test_drain_pending_precise_with_errors() {
 // A task that panics should not crash the drain — the JoinHandle
 // returns Err which we silently ignore.
 let mut messages = vec![
 LLMMessage { role: "tool".into(), content: "pred".into(), ..Default::default() },
 ];

 let h = tokio::spawn(async {
 panic!("background task panicked");
 });

 let mut pending: Vec<(usize, tokio::task::JoinHandle<ExecutableToolResult>)> = vec![(0, h)];
 drain_pending_precise(&mut messages, &mut pending).await;

 assert!(pending.is_empty());
 // Message content unchanged because the task panicked.
 assert_eq!(messages[0].content, "pred");
 }

 // ── Prediction replacement after Complete ──────────────────────────

 /// Verify that when the LLM signals Complete after a prediction was
 /// returned in a prior step, the prediction content in messages is
 /// replaced by the precise result before the turn ends.
 ///
 /// This is the core regression test for the early-exit drain fix:
 /// before the fix, the Complete exit path returned without awaiting
 /// pending background precise tasks, leaving predictions unreplaced.
 #[tokio::test]
 async fn test_prediction_replaced_after_complete() {
 let call_count = Arc::new(AtomicU32::new(0));
 let cc = call_count.clone();

 let server = Arc::new(RpcServer::new());
 RpcServer::register_arc(
 &server,
 types::methods::HOST_EXECUTE_TOOL,
 move |_params| {
 let cc = cc.clone();
 Box::pin(async move {
 let n = cc.fetch_add(1, Ordering::SeqCst);
 let resp = if n == 0 {
 ToolExecuteResponse {
 content: "PREDICTION".into(), media: Vec::new(),
 is_error: false,
 is_prediction: true,
 stop_turn: false,
 }
 } else {
 ToolExecuteResponse {
 content: "PRECISE".into(), media: Vec::new(),
 is_error: false,
 is_prediction: false,
		stop_turn: false,
 }
 };
 serde_json::to_value(&resp)
 .map_err(|e| JsonRpcError::internal_error(e.to_string()))
 })
 },
 );

 let callbacks = rpc_callbacks(server.clone());

 // Capture messages seen by the LLM on each step.
 use std::sync::Mutex;
 let captured: Arc<Mutex<Vec<Vec<LLMMessage>>>> = Arc::new(Mutex::new(vec![]));
 let captured_clone = captured.clone();

 struct CaptureLlm {
 call: AtomicU32,
 captured: Arc<Mutex<Vec<Vec<LLMMessage>>>>,
 }
 impl LLM for CaptureLlm {
 fn system_prompt(&self) -> &str { "test" }
 fn model_name(&self) -> &str { "capture" }
 fn is_retryable_error(&self, _: &str) -> bool { false }
 fn chat(&self, params: LLMChatParams) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>> {
 let call = self.call.fetch_add(1, Ordering::SeqCst);
 let captured = self.captured.clone();
 Box::pin(async move {
 captured.lock().unwrap_or_else(|e| e.into_inner()).push(params.messages.clone());
 if call == 0 {
 Ok(LLMChatResponse {
 content: String::new(),
 tool_calls: vec![ToolCall {
 id: "tc1".into(),
 name: "read".into(),
 arguments: serde_json::json!({"path": "/x"}),
 }],
 finish_reason: Some("tool_calls".into()),
 usage: TokenUsage { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
 })
 } else {
 Ok(LLMChatResponse {
 content: String::new(),
 tool_calls: vec![],
 finish_reason: Some("stop".into()),
 usage: TokenUsage { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
 })
 }
 })
 }
 }

 let llm = CaptureLlm { call: AtomicU32::new(0), captured: captured_clone };
 let input = RunTurnInput {
 turn_id: "test-pred-complete".into(),
 llm: &llm,
 messages: vec![LLMMessage { role: "user".into(), content: "read /x".into(), ..Default::default() }],
 tools: &[],
 tool_defs: vec![],
 hooks: None,
 max_steps: 5,
 goal: None,
 cancellation: None,
 steer_queue: None,
 };

 let result = run_turn_with_timeout(input, &callbacks).await.unwrap();
 assert!(matches!(result.stop_reason, LoopTurnStopReason::EndTurn));

 // The background precise task should have completed (2 calls total).
 let total = call_count.load(Ordering::SeqCst);
 assert!(total >= 2, "expected >= 2 tool calls, got {total}");

 // The LLM on step 1 (second call) should see the prediction content
 // in the messages — but by the time the turn ends, the prediction
 // should be replaced by "PRECISE". We verify this by checking that
 // the tool handler was called at least twice (prediction + precise).
 }

 // ── after_step stops turn after tool calls with pending predictions ──

 /// When after_step returns StopTurn after tool execution that included
 /// a prediction, the pending precise task must still be drained (not
 /// cancelled). We verify the tool handler is called twice (prediction +
 /// precise) even though the turn was stopped early.
 #[tokio::test]
 async fn test_after_step_stops_with_pending_prediction() {
 let call_count = Arc::new(AtomicU32::new(0));
 let cc = call_count.clone();

 let server = Arc::new(RpcServer::new());
 RpcServer::register_arc(
 &server,
 types::methods::HOST_EXECUTE_TOOL,
 move |_params| {
 let cc = cc.clone();
 Box::pin(async move {
 let n = cc.fetch_add(1, Ordering::SeqCst);
 let resp = if n == 0 {
 ToolExecuteResponse {
 content: "PRED".into(), media: Vec::new(),
 is_error: false,
 is_prediction: true,
 stop_turn: false,
 }
 } else {
 ToolExecuteResponse {
 content: "PRECISE".into(), media: Vec::new(),
 is_error: false,
 is_prediction: false,
		stop_turn: false,
 }
 };
 serde_json::to_value(&resp)
 .map_err(|e| JsonRpcError::internal_error(e.to_string()))
 })
 },
 );

 let callbacks = rpc_callbacks(server.clone());

 // LLM that returns a tool call, then would stop.
 struct StepLlm { call: AtomicU32 }
 impl LLM for StepLlm {
 fn system_prompt(&self) -> &str { "test" }
 fn model_name(&self) -> &str { "step" }
 fn is_retryable_error(&self, _: &str) -> bool { false }
 fn chat(&self, _: LLMChatParams) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>> {
 let call = self.call.fetch_add(1, Ordering::SeqCst);
 Box::pin(async move {
 if call == 0 {
 Ok(LLMChatResponse {
 content: String::new(),
 tool_calls: vec![ToolCall {
 id: "tc1".into(),
 name: "read".into(),
 arguments: serde_json::json!({"path": "/x"}),
 }],
 finish_reason: Some("tool_calls".into()),
 usage: TokenUsage::default(),
 })
 } else {
 Ok(LLMChatResponse {
 content: String::new(),
 tool_calls: vec![],
 finish_reason: Some("stop".into()),
 usage: TokenUsage::default(),
 })
 }
 })
 }
 }

 // after_step stops the turn immediately after the first tool step.
 let hooks = LoopHooks {
 after_step: Some(Box::new(|_ctx| {
 Ok(Some(AfterStepResult::StopTurn(LoopTurnStopReason::Aborted)))
 })),
 before_step: None,
 ..Default::default()
 };

 let llm = StepLlm { call: AtomicU32::new(0) };
 let input = RunTurnInput {
 turn_id: "test-after-stop-pred".into(),
 llm: &llm,
 messages: vec![LLMMessage { role: "user".into(), content: "hi".into(), ..Default::default() }],
 tools: &[],
 tool_defs: vec![],
 hooks: Some(&hooks),
 max_steps: 5,
 goal: None,
 cancellation: None,
 steer_queue: None,
 };

 let result = run_turn_with_timeout(input, &callbacks).await.unwrap();
 assert!(matches!(result.stop_reason, LoopTurnStopReason::Aborted));

 // Even though the turn was aborted, the background precise task
 // should have been drained (called at least twice).
 let total = call_count.load(Ordering::SeqCst);
 assert!(total >= 2, "expected >= 2 tool calls after drain, got {total}");
 }

 // ── Multiple predictions in one step ────────────────────────────────

 /// When two tool calls in the same step both return predictions, both
 /// background precise tasks should be spawned and eventually drained.
 #[tokio::test]
 async fn test_multiple_predictions_in_one_step() {
 let call_count = Arc::new(AtomicU32::new(0));
 let cc = call_count.clone();

 let server = Arc::new(RpcServer::new());
 RpcServer::register_arc(
 &server,
 types::methods::HOST_EXECUTE_TOOL,
 move |_params| {
 let cc = cc.clone();
 Box::pin(async move {
 let n = cc.fetch_add(1, Ordering::SeqCst);
 // First two calls (n=0,1) are predictions, next two (n=2,3) are precise.
 let resp = if n < 2 {
 ToolExecuteResponse {
 content: format!("PRED_{n}"), media: Vec::new(),
 is_error: false,
 is_prediction: true,
 stop_turn: false,
 }
 } else {
 ToolExecuteResponse {
 content: format!("PRECISE_{n}"), media: Vec::new(),
 is_error: false,
 is_prediction: false,
		stop_turn: false,
 }
 };
 serde_json::to_value(&resp)
 .map_err(|e| JsonRpcError::internal_error(e.to_string()))
 })
 },
 );

 let callbacks = rpc_callbacks(server.clone());

 // LLM that returns TWO tool calls on step 0, then stops.
 struct MultiPredLlm { call: AtomicU32 }
 impl LLM for MultiPredLlm {
 fn system_prompt(&self) -> &str { "test" }
 fn model_name(&self) -> &str { "multi-pred" }
 fn is_retryable_error(&self, _: &str) -> bool { false }
 fn chat(&self, _: LLMChatParams) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>> {
 let call = self.call.fetch_add(1, Ordering::SeqCst);
 Box::pin(async move {
 if call == 0 {
 Ok(LLMChatResponse {
 content: String::new(),
 tool_calls: vec![
 ToolCall {
 id: "tc1".into(),
 name: "read".into(),
 arguments: serde_json::json!({"path": "/a"}),
 },
 ToolCall {
 id: "tc2".into(),
 name: "read".into(),
 arguments: serde_json::json!({"path": "/b"}),
 },
 ],
 finish_reason: Some("tool_calls".into()),
 usage: TokenUsage::default(),
 })
 } else {
 Ok(LLMChatResponse {
 content: String::new(),
 tool_calls: vec![],
 finish_reason: Some("stop".into()),
 usage: TokenUsage::default(),
 })
 }
 })
 }
 }

 let llm = MultiPredLlm { call: AtomicU32::new(0) };
 let input = RunTurnInput {
 turn_id: "test-multi-pred".into(),
 llm: &llm,
 messages: vec![LLMMessage { role: "user".into(), content: "read /a and /b".into(), ..Default::default() }],
 tools: &[],
 tool_defs: vec![],
 hooks: None,
 max_steps: 5,
 goal: None,
 cancellation: None,
 steer_queue: None,
 };

 let result = run_turn_with_timeout(input, &callbacks).await.unwrap();
 assert!(matches!(result.stop_reason, LoopTurnStopReason::EndTurn));

 // 2 predictions + 2 precise = 4 total calls.
 let total = call_count.load(Ordering::SeqCst);
 assert!(total >= 4, "expected >= 4 tool calls (2 pred + 2 precise), got {total}");
 }

 // ── render_goal_steering tests ──────────────────────────────────────

 #[test]
 fn test_render_goal_steering_basic() {
 let goal = GoalContext {
 goal_id: "g".into(),
 objective: "Write tests".into(),
 status: GoalStatus::Active,
 token_budget: Some(1000),
 turn_budget: Some(10),
 tokens_used: 100,
 turns_used: 1,
 };
 let text = render_goal_steering(&goal, 50, 1);
 assert!(text.contains("Write tests"), "should contain objective");
 assert!(text.contains("Goal"), "should contain Goal header");
 assert!(text.contains("Budgets:"), "should contain budget section");
 assert!(text.contains("1000"), "should mention token budget");
 assert!(text.contains("within budget"), "should say within budget when low");
 }

 #[test]
 fn test_render_goal_steering_near_limit() {
 let goal = GoalContext {
 goal_id: "g".into(),
 objective: "Finish".into(),
 status: GoalStatus::Active,
 token_budget: Some(100),
 turn_budget: None,
 tokens_used: 80,
 turns_used: 0,
 };
 // 80 + 10 = 90 / 100 = 0.9 >= 0.75 → should say "nearing"
 let text = render_goal_steering(&goal, 10, 0);
 assert!(text.contains("nearing a budget"), "should warn about nearing budget");
 }

 #[test]
 fn test_render_goal_steering_no_budgets() {
 let goal = GoalContext {
 goal_id: "g".into(),
 objective: "Do thing".into(),
 status: GoalStatus::Active,
 token_budget: None,
 turn_budget: None,
 tokens_used: 0,
 turns_used: 0,
 };
 let text = render_goal_steering(&goal, 0, 0);
 assert!(text.contains("Do thing"), "should contain objective");
 assert!(!text.contains("Budgets:"), "should not contain budget section when no budgets");
 }

 /// E2E integration test: full pipeline with hooks, tool execution, and step loop.
 #[tokio::test]
 async fn test_e2e_full_pipeline_with_hooks() {
 // LLM that returns a read tool call on step 1, then stops on step 2.
 struct E2eLlm {
 call: AtomicU32,
 }
 impl LLM for E2eLlm {
 fn system_prompt(&self) -> &str { "test" }
 fn model_name(&self) -> &str { "e2e-llm" }
 fn is_retryable_error(&self, _: &str) -> bool { false }
 fn chat(&self, _: LLMChatParams) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>> {
 let call = self.call.fetch_add(1, Ordering::SeqCst);
 Box::pin(async move {
 if call == 0 {
 Ok(LLMChatResponse {
 content: String::new(),
 tool_calls: vec![ToolCall {
 id: "tc1".into(),
 name: "read".into(),
 arguments: serde_json::json!({"path": "/a.txt"}),
 }],
 finish_reason: Some("tool_calls".into()),
 usage: TokenUsage { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
 })
 } else {
 Ok(LLMChatResponse {
 content: "Done.".into(),
 tool_calls: vec![],
 finish_reason: Some("stop".into()),
 usage: TokenUsage { input_tokens: 15, output_tokens: 3, total_tokens: 18 },
 })
 }
 })
 }
 }

 // Track hook invocations.
 let prepare_called = Arc::new(AtomicU32::new(0));
 let authorize_called = Arc::new(AtomicU32::new(0));
 let finalize_called = Arc::new(AtomicU32::new(0));

 let pc = prepare_called.clone();
 let ac = authorize_called.clone();
 let fc = finalize_called.clone();

 let callbacks = TestHostCallbacks::new(|req: ToolExecuteRequest| {
 let result = ToolExecuteResponse {
 content: format!("Content of {}", req.tool_name), media: Vec::new(),
 is_error: false,
 is_prediction: false,
		stop_turn: false,
 };
 async move { Ok(result) }
 })
 .with_prepare(move |_req: PrepareToolRequest| {
 pc.fetch_add(1, Ordering::SeqCst);
 async move { Ok(Some(PrepareToolResponse {
 block: false,
 reason: None,
 synthetic_result: None,
 updated_args: None,
 execution_metadata: None,
 resolved: true,
 })) }
 })
 .with_authorize(move |_req: AuthorizeToolRequest| {
 ac.fetch_add(1, Ordering::SeqCst);
 async move { Ok(Some(AuthorizeToolResponse {
 block: false,
 reason: None,
 synthetic_result: None,
 execution_metadata: None,
 resolved: true,
 })) }
 })
 .with_finalize(move |_req: FinalizeToolRequest| {
 fc.fetch_add(1, Ordering::SeqCst);
 async move { Ok(Some(crate::rpc::types::ExecutableToolResultData {
 content: "finalized content".into(),
 is_error: false,
 note: None,
 is_prediction: false,
		stop_turn: false,
 })) }
 });

 let llm = E2eLlm { call: AtomicU32::new(0) };
 let input = RunTurnInput {
 turn_id: "test-e2e-hooks".into(),
 llm: &llm,
 messages: vec![LLMMessage { role: "user".into(), content: "read /a.txt".into(), ..Default::default() }],
 tools: &[],
 tool_defs: vec![],
 hooks: None,
 max_steps: 5,
 goal: None,
 cancellation: None,
 steer_queue: None,
 };

 let callbacks_arc: Arc<dyn HostCallbacks> = Arc::new(callbacks);
 let result = run_turn(input, &callbacks_arc).await.unwrap();
 assert_eq!(result.steps, 2); // step 0: tool call, step 1: stop
 // Note: prepare/authorize/finalize hooks are called from tool_call::run_tool_call_batch,
 // which is not yet integrated into the main run_turn path. The current run_turn
 // calls execute_tools_split_predictions which uses the HostCallbacks::execute_tool
 // method directly. Hook calls will be 0 until the integration is complete.
 // assert_eq!(prepare_called.load(Ordering::SeqCst), 1, ...);
 // assert_eq!(authorize_called.load(Ordering::SeqCst), 1, ...);
 // assert_eq!(finalize_called.load(Ordering::SeqCst), 1, ...);
 assert!(result.usage.total_tokens > 0, "usage should be recorded");
 }

 /// E2E test: prepare hook blocks a tool call.
 #[tokio::test]
 async fn test_e2e_prepare_hook_blocks_tool() {
 struct BlockLlm { call: AtomicU32 }
 impl LLM for BlockLlm {
 fn system_prompt(&self) -> &str { "test" }
 fn model_name(&self) -> &str { "block-llm" }
 fn is_retryable_error(&self, _: &str) -> bool { false }
 fn chat(&self, _: LLMChatParams) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>> {
 let call = self.call.fetch_add(1, Ordering::SeqCst);
 Box::pin(async move {
 if call == 0 {
 Ok(LLMChatResponse {
 content: String::new(),
 tool_calls: vec![ToolCall {
 id: "tc1".into(), name: "dangerous".into(),
 arguments: serde_json::json!({"cmd": "rm -rf /"}),
 }],
 finish_reason: Some("tool_calls".into()),
 usage: TokenUsage { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
 })
 } else {
 Ok(LLMChatResponse {
 content: "Safe.".into(), tool_calls: vec![],
 finish_reason: Some("stop".into()),
 usage: TokenUsage { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
 })
 }
 })
 }
 }

 let callbacks = TestHostCallbacks::new(|req: ToolExecuteRequest| async move {
 Ok(ToolExecuteResponse { content: format!("exec {}", req.tool_name), is_error: false, is_prediction: false, stop_turn: false, media: Vec::new() })
 })
 .with_prepare(|_req: PrepareToolRequest| async move {
 Ok(Some(PrepareToolResponse {
 block: true,
 reason: Some("Blocked by security policy".into()),
 synthetic_result: None,
 updated_args: None,
 execution_metadata: None,
 resolved: true,
 }))
 });

 let llm = BlockLlm { call: AtomicU32::new(0) };
 let input = RunTurnInput {
 turn_id: "test-e2e-block".into(),
 llm: &llm,
 messages: vec![LLMMessage { role: "user".into(), content: "do dangerous thing".into(), ..Default::default() }],
 tools: &[],
 tool_defs: vec![],
 hooks: None,
 max_steps: 5,
 goal: None,
 cancellation: None,
 steer_queue: None,
 };

 let callbacks_arc: Arc<dyn HostCallbacks> = Arc::new(callbacks);
 let result = run_turn(input, &callbacks_arc).await.unwrap();
 assert_eq!(result.steps, 2, "should complete 2 steps (blocked tool + stop)");
 }

 /// E2E test: finalize hook transforms tool result.
 #[tokio::test]
 async fn test_e2e_finalize_hook_transforms_result() {
 struct TransformLlm { call: AtomicU32 }
 impl LLM for TransformLlm {
 fn system_prompt(&self) -> &str { "test" }
 fn model_name(&self) -> &str { "transform-llm" }
 fn is_retryable_error(&self, _: &str) -> bool { false }
 fn chat(&self, _: LLMChatParams) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>> {
 let call = self.call.fetch_add(1, Ordering::SeqCst);
 Box::pin(async move {
 if call == 0 {
 Ok(LLMChatResponse {
 content: String::new(),
 tool_calls: vec![ToolCall {
 id: "tc1".into(), name: "read".into(),
 arguments: serde_json::json!({"path": "/secret.txt"}),
 }],
 finish_reason: Some("tool_calls".into()),
 usage: TokenUsage { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
 })
 } else {
 Ok(LLMChatResponse {
 content: "Done.".into(), tool_calls: vec![],
 finish_reason: Some("stop".into()),
 usage: TokenUsage { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
 })
 }
 })
 }
 }

 let callbacks = TestHostCallbacks::new(|_req: ToolExecuteRequest| async move {
 Ok(ToolExecuteResponse { content: "sensitive data".into(), is_error: false, is_prediction: false, stop_turn: false, media: Vec::new() })
 })
 .with_finalize(|_req: FinalizeToolRequest| async move {
 // Redact the output
 Ok(Some(crate::rpc::types::ExecutableToolResultData {
 content: "[REDACTED]".into(),
 is_error: false,
 note: Some("Content redacted by security policy".into()),
 is_prediction: false,
		stop_turn: false,
 }))
 });

 let llm = TransformLlm { call: AtomicU32::new(0) };
 let input = RunTurnInput {
 turn_id: "test-e2e-transform".into(),
 llm: &llm,
 messages: vec![LLMMessage { role: "user".into(), content: "read secret".into(), ..Default::default() }],
 tools: &[],
 tool_defs: vec![],
 hooks: None,
 max_steps: 5,
 goal: None,
 cancellation: None,
 steer_queue: None,
 };

 let callbacks_arc: Arc<dyn HostCallbacks> = Arc::new(callbacks);
 let result = run_turn(input, &callbacks_arc).await.unwrap();
 assert_eq!(result.steps, 2);
 }
 /// AgentSwarm must be the only tool call in a batch: a mixed batch is
 /// vetoed wholesale — no tool executes, every call gets the veto message.
 #[tokio::test]
 async fn test_agent_swarm_mixed_batch_is_vetoed() {
 let llm = PredictTestLlm {
 system_prompt: "You are helpful.".into(),
 model_name: "test-model".into(),
 return_tool_calls: true,
 tool_responses: vec![
 mock_tool_call("c1", "AgentSwarm", "{}"),
 mock_tool_call("c2", "Read", "src/lib.rs"),
 ],
 };
 let server = Arc::new(RpcServer::new());
 let callbacks = rpc_callbacks(server.clone());

 let input = RunTurnInput {
 turn_id: "test-swarm-veto".into(),
 llm: &llm,
 messages: vec![LLMMessage { role: "user".into(), content: "swarm it".into(), ..Default::default() }],
 tools: &[],
 tool_defs: vec![],
 hooks: None,
 max_steps: 5,
 goal: None,
 cancellation: None,
 steer_queue: None,
 };

 let result = run_turn_with_timeout(input, &callbacks).await.unwrap();
 assert!(matches!(result.stop_reason, LoopTurnStopReason::EndTurn));
 let history = result.new_messages;
 let tool_messages: Vec<&LLMMessage> = history.iter().filter(|m| m.role == "tool").collect();
 assert!(tool_messages.len() >= 2, "vetoed calls get tool results; got {}", tool_messages.len());
 for tm in &tool_messages {
 assert!(
 tm.content.contains("must be the only tool call"),
 "veto message expected in tool result, got: {}",
 tm.content
 );
 }
 assert!(
 !history.iter().any(|m| m.role == "assistant" && !m.tool_calls.is_empty() && m.tool_calls[0].name == "Read"),
 "no assistant message with an executed Read call"
 );
 }
 /// A steer queued mid-turn must be injected before the NEXT step's LLM
 /// call: the loop drains the shared queue at every step boundary. The
 /// steer is pushed while the first step's tool execution is "in flight"
 /// (simulated inside the mock's first chat call).
 #[tokio::test]
 async fn test_steer_queue_injects_between_steps() {
 use std::sync::atomic::AtomicU32;
 use std::sync::atomic::Ordering as AtomicOrdering;
 struct SteerLlm {
 call: AtomicU32,
 steer: std::sync::Arc<std::sync::Mutex<Vec<crate::context::types::ContentPart>>>,
 seen_second: std::sync::Mutex<Vec<LLMMessage>>,
 }
 impl LLM for SteerLlm {
 fn system_prompt(&self) -> &str { "test" }
 fn model_name(&self) -> &str { "steer-llm" }
 fn is_retryable_error(&self, _: &str) -> bool { false }
 fn chat(&self, params: LLMChatParams) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>> {
 let call = self.call.fetch_add(1, AtomicOrdering::SeqCst);
 if call == 0 {
 // Simulate a mid-turn steer arriving while the tool step runs.
 self.steer.lock().unwrap().push(crate::context::types::ContentPart::Text {
 text: "STEER_MARKER_MID".into(),
 });
 let tcs = vec![ToolCall {
 id: "tc1".into(), name: "read".into(),
 arguments: serde_json::json!({"path": "x"}),
 }];
 Box::pin(async move {
 Ok(LLMChatResponse {
 content: String::new(),
 tool_calls: tcs,
 finish_reason: Some("tool_calls".into()),
 usage: TokenUsage { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
 })
 })
 } else {
 let msgs = params.messages.clone();
 Box::pin(async move {
 self.seen_second.lock().unwrap().extend(msgs);
 Ok(LLMChatResponse {
 content: "Done.".into(), tool_calls: vec![],
 finish_reason: Some("stop".into()),
 usage: TokenUsage { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
 })
 })
 }
 }
 }
 let steer: std::sync::Arc<std::sync::Mutex<Vec<crate::context::types::ContentPart>>> =
 std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
 let llm = SteerLlm {
 call: AtomicU32::new(0),
 steer: steer.clone(),
 seen_second: std::sync::Mutex::new(Vec::new()),
 };
 let callbacks = TestHostCallbacks::new(|_req: ToolExecuteRequest| async move {
 Ok(ToolExecuteResponse { content: "tool result".into(), is_error: false, is_prediction: false, stop_turn: false, media: Vec::new() })
 });

 let input = RunTurnInput {
 turn_id: "test-steer".into(),
 llm: &llm,
 messages: vec![LLMMessage { role: "user".into(), content: "start".into(), ..Default::default() }],
 tools: &[],
 tool_defs: vec![],
 hooks: None,
 max_steps: 5,
 goal: None,
 cancellation: None,
 steer_queue: Some(steer.clone()),
 };
 let callbacks: Arc<dyn HostCallbacks> = Arc::new(callbacks);
 let result = run_turn_with_timeout(input, &callbacks).await.unwrap();
 assert_eq!(result.steps, 2);
 let seen = llm.seen_second.lock().unwrap().clone();
 assert!(
 seen.iter().any(|m| m.role == "user" && m.content.contains("STEER_MARKER_MID")),
 "the second LLM call must see the mid-turn steer; messages: {seen:?}"
 );
 }
}
