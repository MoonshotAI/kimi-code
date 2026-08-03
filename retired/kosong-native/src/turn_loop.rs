// Phase 9.3 -- Rust `run_turn_loop` skeleton.
//
// Multi-step agent loop: LLM call -> tool execution (via callback) ->
// feed tool results back into the conversation -> LLM call again -> ...
// until the LLM stops requesting tool calls or `max_iterations` is hit.
//
// The tool executor is provided by the caller as an `async` closure.
// In production, the closure dispatches to TS via napi ThreadsafeFunction;
// in tests, it's a plain `async` block that just returns canned data.
//
// This module DOES NOT:
//   - Implement retry/backoff (TS `executeLoopStep` still owns this)
//   - Handle media projection (TS `buildMessages`)
//   - Implement permission/approval (the executor decides whether
//     the call is allowed; we just pass through)
//   - Persist anything (TS owns the record store)

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::message::TokenUsage;
use crate::tool_registry::{ToolRegistry, ValidationError};
use crate::turn_step::{
    ContentPart, Provider, ToolCall, TurnMessage, TurnRequest, TurnTool, run_turn,
};

/// What the executor receives: a single parsed tool call. The
/// executor decides whether to actually run the tool (or reject it
/// for permissions, etc.) and returns a result message to feed back
/// into the conversation.
#[derive(Debug, Clone)]
pub struct ToolInvocation<'a> {
    pub call: &'a ToolCall,
    /// Whether the registry considers this call well-formed. The
    /// executor may choose to run the call anyway (e.g. a soft
    /// warning) or fail-fast.
    pub validation: Result<(), ValidationError>,
}

/// What the executor returns: a string that will be placed in the
/// `content` of a `tool` role message in the next LLM turn. The TS
/// side typically `JSON.stringify`s the tool result here.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolOutcome {
    pub content: String,
    /// `is_error = true` causes the loop to inject the content as a
    /// tool message with a leading `[tool error]` prefix, so the
    /// model can see the failure and recover. `is_error = false`
    /// is the happy path.
    pub is_error: bool,
}

impl ToolOutcome {
    /// Convenience constructor for the happy path.
    pub fn ok(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            is_error: false,
        }
    }
    /// Convenience constructor for a failed tool execution.
    pub fn err(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            is_error: true,
        }
    }
}

/// A boxed async executor. The signature is intentionally minimal —
/// we don't pass per-call context (signal, deadlines) yet; those
/// come when the TS callback is wired in.
pub type ToolExecutor =
    Arc<dyn for<'a> Fn(&'a ToolInvocation<'a>) -> ToolOutcomeFut + Send + Sync>;

/// Future returned by an executor. Boxed so the trait object can be
/// `Send + Sync`.
pub type ToolOutcomeFut = std::pin::Pin<
    Box<dyn std::future::Future<Output = ToolOutcome> + Send + 'static>,
>;

/// Inputs to the loop. The model, system prompt, and tool list
/// apply to every LLM call; the messages list grows as the loop
/// progresses (assistant turns + tool results accumulate).
#[derive(Debug, Clone)]
pub struct TurnLoopRequest {
    pub model: String,
    pub system: Option<String>,
    pub tools: Vec<TurnTool>,
    pub max_tokens: Option<u32>,
    pub thinking_effort: Option<String>,
    pub base_url: Option<String>,
    pub provider: Provider,
    pub trace_id: Option<String>,
    pub timeout_ms: Option<u64>,
    /// Initial user/tool messages. The loop appends to this list as
    /// it runs.
    pub initial_messages: Vec<TurnMessage>,
    /// Hard cap on LLM iterations. The loop exits early if the LLM
    /// produces no tool calls. Default: 8.
    pub max_iterations: Option<u32>,
}

/// Final outcome of the loop. Includes the full transcript so the
/// TS side can persist it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnLoopResult {
    /// The complete final conversation. Each iteration contributes
    /// an `assistant` message (from the LLM) and, when the LLM
    /// requested tools, one or more `tool` messages (from the
    /// executor).
    pub final_messages: Vec<TurnMessage>,
    /// All content parts from the LAST LLM turn (after all tool
    /// rounds have resolved). The TS side extracts the final
    /// assistant text from here.
    pub final_content_parts: Vec<ContentPart>,
    /// All tool calls executed across the loop, with their outcomes
    /// (for observability / record-keeping).
    pub executed_calls: Vec<ExecutedToolCall>,
    /// Aggregated token usage across all LLM calls.
    pub total_usage: TokenUsage,
    /// The reason the loop terminated: `end_turn` (model finished),
    /// `tool_calls_exhausted` (model kept requesting tools but
    /// max_iterations hit), `no_tool_calls` (model produced no tools
    /// in the final turn), or `error`.
    pub stop_reason: LoopStopReason,
    /// When `stop_reason == "error"`, this carries the message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum LoopStopReason {
    /// Model produced no tool calls in the final turn — natural end.
    EndTurn,
    /// Model kept requesting tools; we hit `max_iterations`.
    ToolCallsExhausted,
    /// Model produced no tool calls and `end_turn` is not explicit.
    /// (Distinct from `EndTurn` to surface ambiguity in the TS side.)
    NoToolCalls,
    /// The loop failed (HTTP error, JSON parse, executor panic).
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutedToolCall {
    /// The call as the LLM emitted it.
    pub call: ToolCall,
    /// The executor's verdict.
    pub outcome: ToolOutcome,
    /// The index of the LLM turn that produced this call (0-based).
    pub turn_index: u32,
    /// Cumulative index across the whole loop (0-based).
    pub call_index: u32,
}

/// Append a `tool` role message to the conversation, with the
/// executor's content (or an error annotation).
fn append_tool_result(
    messages: &mut Vec<TurnMessage>,
    call: &ToolCall,
    outcome: &ToolOutcome,
) {
    let content = if outcome.is_error {
        format!("[tool error] {}", outcome.content)
    } else {
        outcome.content.clone()
    };
    messages.push(TurnMessage {
        role: "tool".into(),
        content,
        tool_call_id: Some(call.id.clone()),
    });
}

/// Append an `assistant` role message that mirrors the LLM turn's
/// content (text + tool_use). We do this so the next LLM call has a
/// faithful transcript.
fn append_assistant_turn(
    messages: &mut Vec<TurnMessage>,
    parts: &[ContentPart],
    tool_calls: &[ToolCall],
) {
    // Build content blocks + parallel tool-call list as a single
    // JSON object so the next LLM call has the same shape as the
    // live SDK adapters.
    let blocks: Vec<Value> = parts
        .iter()
        .map(|p| match p {
            ContentPart::Text { text } => json!({"type": "text", "text": text}),
            ContentPart::Think { think, encrypted } => json!({
                "type": "thinking",
                "thinking": think,
                "encrypted": encrypted,
            }),
        })
        .collect();
    let tool_calls_json: Vec<Value> = tool_calls
        .iter()
        .map(|c| {
            json!({
                "id": c.id,
                "name": c.name,
                "arguments": c.arguments,
            })
        })
        .collect();
    let content_with_calls = json!({
        "blocks": blocks,
        "tool_calls": tool_calls_json,
    });
    let content = serde_json::to_string(&content_with_calls)
        .unwrap_or_else(|_| "[]".to_string());
    messages.push(TurnMessage {
        role: "assistant".into(),
        content,
        tool_call_id: None,
    });
}

/// Run the multi-step loop. Drives `run_turn` for each LLM call,
/// dispatches tool calls through the supplied executor, and feeds
/// results back into the conversation.
pub async fn run_turn_loop(
    registry: &ToolRegistry,
    executor: ToolExecutor,
    req: TurnLoopRequest,
) -> TurnLoopResult {
    let max_iterations = req.max_iterations.unwrap_or(8);
    let mut messages = req.initial_messages.clone();
    let mut executed_calls: Vec<ExecutedToolCall> = Vec::new();
    let mut total_usage = TokenUsage::new();
    let mut final_content_parts: Vec<ContentPart> = Vec::new();
    let mut call_index: u32 = 0;

    for turn_index in 0..max_iterations {
        // Build the LLM request with the current message list.
        let turn_req = TurnRequest {
            model: req.model.clone(),
            system: req.system.clone(),
            messages: messages.clone(),
            tools: req.tools.clone(),
            max_tokens: req.max_tokens,
            thinking_effort: req.thinking_effort.clone(),
            base_url: req.base_url.clone(),
            provider: req.provider.clone(),
            trace_id: req.trace_id.clone(),
            timeout_ms: req.timeout_ms,
        };

        let result = match run_turn(turn_req).await {
            Ok(r) => r,
            Err(e) => {
                return TurnLoopResult {
                    final_messages: messages,
                    final_content_parts,
                    executed_calls,
                    total_usage,
                    stop_reason: LoopStopReason::Error,
                    error: Some(e),
                };
            }
        };

        // Accumulate usage.
        total_usage.input_other += result.usage.input_other;
        total_usage.output += result.usage.output;
        total_usage.input_cache_read += result.usage.input_cache_read;
        total_usage.input_cache_creation += result.usage.input_cache_creation;

        let tool_calls = result.tool_calls.clone();
        final_content_parts = result.content_parts.clone();
        append_assistant_turn(&mut messages, &result.content_parts, &tool_calls);

        if tool_calls.is_empty() {
            // Model is done. If it explicitly said `end_turn` or
            // `stop`, surface that; otherwise default to `NoToolCalls`.
            let stop = match result.finish_reason.as_deref() {
                Some("end_turn") | Some("stop") => LoopStopReason::EndTurn,
                _ => LoopStopReason::NoToolCalls,
            };
            return TurnLoopResult {
                final_messages: messages,
                final_content_parts,
                executed_calls,
                total_usage,
                stop_reason: stop,
                error: None,
            };
        }

        // Execute each tool call through the supplied closure. We
        // execute sequentially — parallel execution is a TS-side
        // concern (`ToolScheduler`), and serializing them keeps the
        // loop semantics simple and testable.
        for call in &tool_calls {
            let validation = registry.validate(call);
            let invocation = ToolInvocation {
                call,
                validation: validation.clone(),
            };
            let outcome = (executor)(&invocation).await;
            append_tool_result(&mut messages, call, &outcome);
            executed_calls.push(ExecutedToolCall {
                call: call.clone(),
                outcome,
                turn_index,
                call_index,
            });
            call_index += 1;
        }
    }

    // Hit `max_iterations` without the LLM producing an end_turn.
    TurnLoopResult {
        final_messages: messages,
        final_content_parts,
        executed_calls,
        total_usage,
        stop_reason: LoopStopReason::ToolCallsExhausted,
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    // ── Mock SSE server helper ───────────────────────────────────────────

    async fn spawn_sse_server(events: Vec<String>) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut tmp = [0u8; 1024];
            loop {
                let n = stream.read(&mut tmp).await.unwrap();
                buf.extend_from_slice(&tmp[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let mut body = String::new();
            for e in &events {
                body.push_str(e);
            }
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(header.as_bytes()).await.unwrap();
            stream.write_all(body.as_bytes()).await.unwrap();
            stream.shutdown().await.unwrap();
        });
        port
    }

    // ── Mock LLM server that serves a fixed script of turns ─────────────
    //
    // Each request triggers the next "turn" in the script. The
    // first request gets `script[0]`, the second gets `script[1]`, etc.
    // After exhausting the script, subsequent requests get an empty
    // `end_turn` response so the loop terminates.

    async fn spawn_scripted_llm(script: Vec<Vec<String>>) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            // Per-connection state: which turn are we on?
            use std::sync::Mutex;
            let turn_idx: Arc<Mutex<usize>> = Arc::new(Mutex::new(0));
            loop {
                let (mut stream, _) = match listener.accept().await {
                    Ok(p) => p,
                    Err(_) => break,
                };
                let mut buf = Vec::new();
                let mut tmp = [0u8; 1024];
                loop {
                    let n = match stream.read(&mut tmp).await {
                        Ok(0) => break,
                        Ok(n) => n,
                        Err(_) => break,
                    };
                    buf.extend_from_slice(&tmp[..n]);
                    if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                // Pick the script for this turn.
                let idx = {
                    let mut g = turn_idx.lock().unwrap();
                    let i = *g;
                    *g += 1;
                    i
                };
                let events: Vec<String> = if idx < script.len() {
                    script[idx].clone()
                } else {
                    // Default: empty end_turn so the loop exits.
                    vec![
                        "event: message\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_default\",\"model\":\"claude-3-7\",\"usage\":{\"input_tokens\":0,\"output_tokens\":0}}}\n\n".to_string(),
                        "event: message\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n".to_string(),
                        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n".to_string(),
                    ]
                };
                let mut body = String::new();
                for e in &events {
                    body.push_str(e);
                }
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\
                     Content-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(header.as_bytes()).await;
                let _ = stream.write_all(body.as_bytes()).await;
                let _ = stream.shutdown().await;
            }
        });
        port
    }

    fn anthropic_text_delta(index: u32, text: &str) -> String {
        format!(
            "event: message\ndata: {{\"type\":\"content_block_delta\",\"index\":{index},\"delta\":{{\"type\":\"text_delta\",\"text\":\"{text}\"}}}}\n\n"
        )
    }

    fn anthropic_message_stop() -> String {
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n".to_string()
    }

    fn anthropic_tool_use(index: u32, id: &str, name: &str, args: &str) -> Vec<String> {
        let head_payload = serde_json::json!({
            "type": "content_block_start",
            "index": index,
            "content_block": {"type": "tool_use", "id": id, "name": name, "input": {}}
        });
        let mut chunks = vec![format!(
            "event: message\ndata: {}\n\n",
            serde_json::to_string(&head_payload).unwrap()
        )];
        for (i, _) in args.as_bytes().chunks(3).enumerate() {
            let chunk = &args[i * 3..std::cmp::min((i + 1) * 3, args.len())];
            let delta_payload = serde_json::json!({
                "type": "content_block_delta",
                "index": index,
                "delta": {
                    "type": "input_json_delta",
                    "partial_json": chunk,
                }
            });
            chunks.push(format!(
                "event: message\ndata: {}\n\n",
                serde_json::to_string(&delta_payload).unwrap()
            ));
        }
        let stop_payload = serde_json::json!({
            "type": "content_block_stop",
            "index": index,
        });
        chunks.push(format!(
            "event: message\ndata: {}\n\n",
            serde_json::to_string(&stop_payload).unwrap()
        ));
        chunks
    }

    fn anthropic_message_delta(stop: &str) -> String {
        format!(
            "event: message\ndata: {{\"type\":\"message_delta\",\"delta\":{{\"stop_reason\":\"{stop}\"}},\"usage\":{{\"output_tokens\":5}}}}\n\n"
        )
    }

    fn anthropic_message_start(id: &str, model: &str) -> String {
        format!(
            "event: message\ndata: {{\"type\":\"message_start\",\"message\":{{\"id\":\"{id}\",\"model\":\"{model}\",\"usage\":{{\"input_tokens\":10,\"output_tokens\":0}}}}}}\n\n"
        )
    }

    /// Always-return-OK executor that just echoes the tool call
    /// back to the model. `call_count` tracks how many times the
    /// executor was invoked across the loop.
    fn echo_executor(call_count: Arc<AtomicU32>) -> ToolExecutor {
        Arc::new(move |invocation: &ToolInvocation<'_>| -> ToolOutcomeFut {
            let count = call_count.clone();
            let call = invocation.call.clone();
            Box::pin(async move {
                count.fetch_add(1, Ordering::Relaxed);
                ToolOutcome::ok(format!(
                    "{{\"echo\":\"{}\",\"args\":{}}}",
                    call.name,
                    call.arguments_raw
                ))
            })
        })
    }

    /// Always-return-error executor — used to verify error injection
    /// into the conversation.
    fn error_executor() -> ToolExecutor {
        Arc::new(|_invocation: &ToolInvocation<'_>| -> ToolOutcomeFut {
            Box::pin(async move {
                ToolOutcome::err("permission denied")
            })
        })
    }

    fn build_registry() -> ToolRegistry {
        let mut r = ToolRegistry::new();
        r.register(&TurnTool {
            name: "get_weather".into(),
            description: "Get weather".into(),
            parameters: Some(json!({"type": "object"})),
        })
        .unwrap();
        r
    }

    fn turn_loop_request(base_url: String, messages: Vec<TurnMessage>) -> TurnLoopRequest {
        TurnLoopRequest {
            model: "claude-3-7-sonnet".into(),
            system: None,
            tools: vec![TurnTool {
                name: "get_weather".into(),
                description: "Get weather".into(),
                parameters: Some(json!({"type": "object"})),
            }],
            max_tokens: None,
            thinking_effort: None,
            base_url: Some(base_url),
            provider: Provider::Anthropic {
                api_key: "test".into(),
            },
            trace_id: None,
            timeout_ms: Some(5000),
            initial_messages: messages,
            max_iterations: Some(3),
        }
    }

    #[tokio::test]
    async fn loop_terminates_on_end_turn_without_tool_calls() {
        let mut turn1 = vec![anthropic_message_start("msg_a", "claude-3-7-sonnet")];
        turn1.push(anthropic_text_delta(0, "Hello!"));
        turn1.push(anthropic_message_delta("end_turn"));
        turn1.push(anthropic_message_stop());
        let port = spawn_sse_server(turn1).await;

        let registry = build_registry();
        let counter = Arc::new(AtomicU32::new(0));
        let executor = echo_executor(counter.clone());
        let req = turn_loop_request(
            format!("http://127.0.0.1:{port}"),
            vec![TurnMessage {
                role: "user".into(),
                content: "hi".into(),
                tool_call_id: None,
            }],
        );
        let result = run_turn_loop(&registry, executor, req).await;
        assert_eq!(result.stop_reason, LoopStopReason::EndTurn);
        assert_eq!(counter.load(Ordering::Relaxed), 0);
        assert_eq!(result.executed_calls.len(), 0);
        // Final messages: [user, assistant].
        assert_eq!(result.final_messages.len(), 2);
        assert_eq!(result.final_messages[1].role, "assistant");
    }

    #[tokio::test]
    async fn loop_executes_tool_and_feeds_result_back() {
        // Turn 1: model calls get_weather.
        // Turn 2: model returns end_turn after seeing the tool result.
        let mut turn1 = vec![anthropic_message_start("msg_1", "claude-3-7-sonnet")];
        turn1.extend(anthropic_tool_use(0, "tu_1", "get_weather", "{\"location\":\"SF\"}"));
        turn1.push(anthropic_message_delta("tool_use"));
        turn1.push(anthropic_message_stop());
        let mut turn2 = vec![anthropic_message_start("msg_2", "claude-3-7-sonnet")];
        turn2.push(anthropic_text_delta(0, "Sunny in SF."));
        turn2.push(anthropic_message_delta("end_turn"));
        turn2.push(anthropic_message_stop());
        let port = spawn_scripted_llm(vec![turn1, turn2]).await;

        let registry = build_registry();
        let counter = Arc::new(AtomicU32::new(0));
        let executor = echo_executor(counter.clone());
        let req = turn_loop_request(
            format!("http://127.0.0.1:{port}"),
            vec![TurnMessage {
                role: "user".into(),
                content: "weather?".into(),
                tool_call_id: None,
            }],
        );
        let result = run_turn_loop(&registry, executor, req).await;
        assert_eq!(result.stop_reason, LoopStopReason::EndTurn);
        assert_eq!(counter.load(Ordering::Relaxed), 1);
        assert_eq!(result.executed_calls.len(), 1);
        assert_eq!(result.executed_calls[0].call.name, "get_weather");
        assert_eq!(result.executed_calls[0].turn_index, 0);
        // Final messages: [user, assistant_turn_1, tool, assistant_turn_2].
        assert_eq!(result.final_messages.len(), 4);
        assert_eq!(result.final_messages[0].role, "user");
        assert_eq!(result.final_messages[1].role, "assistant");
        assert_eq!(result.final_messages[2].role, "tool");
        assert!(result.final_messages[2]
            .content
            .contains("\"echo\":\"get_weather\""));
        assert_eq!(result.final_messages[3].role, "assistant");
    }

    #[tokio::test]
    async fn loop_stops_at_max_iterations() {
        // Each "turn" keeps requesting tools until we hit the cap.
        let make_tool_turn = || {
            let mut e = vec![anthropic_message_start("msg_x", "claude-3-7-sonnet")];
            e.extend(anthropic_tool_use(
                0,
                "tu_x",
                "get_weather",
                "{\"location\":\"X\"}",
            ));
            e.push(anthropic_message_delta("tool_use"));
            e.push(anthropic_message_stop());
            e
        };
        let port = spawn_scripted_llm(vec![
            make_tool_turn(),
            make_tool_turn(),
            make_tool_turn(),
            make_tool_turn(),
            make_tool_turn(),
        ])
        .await;

        let registry = build_registry();
        let counter = Arc::new(AtomicU32::new(0));
        let executor = echo_executor(counter.clone());
        let mut req = turn_loop_request(
            format!("http://127.0.0.1:{port}"),
            vec![TurnMessage {
                role: "user".into(),
                content: "x".into(),
                tool_call_id: None,
            }],
        );
        req.max_iterations = Some(3);
        let result = run_turn_loop(&registry, executor, req).await;
        assert_eq!(result.stop_reason, LoopStopReason::ToolCallsExhausted);
        // 3 iterations, each with 1 tool call = 3 invocations.
        assert_eq!(counter.load(Ordering::Relaxed), 3);
    }

    #[tokio::test]
    async fn loop_injects_tool_errors_as_user_messages() {
        // Turn 1: model calls the tool; the executor returns an
        // error. The loop should still complete (eventually) — the
        // error is fed back to the model as a tool message.
        let script = vec![
            {
                let mut e = vec![anthropic_message_start("msg_1", "claude-3-7-sonnet")];
                e.extend(anthropic_tool_use(0, "tu_1", "get_weather", "{}"));
                e.push(anthropic_message_delta("tool_use"));
                e.push(anthropic_message_stop());
                e
            },
            {
                let mut e = vec![anthropic_message_start("msg_2", "claude-3-7-sonnet")];
                e.push(anthropic_text_delta(0, "OK, no weather for you."));
                e.push(anthropic_message_delta("end_turn"));
                e.push(anthropic_message_stop());
                e
            },
        ];
        let port = spawn_scripted_llm(script).await;

        let registry = build_registry();
        let executor = error_executor();
        let req = turn_loop_request(
            format!("http://127.0.0.1:{port}"),
            vec![TurnMessage {
                role: "user".into(),
                content: "x".into(),
                tool_call_id: None,
            }],
        );
        let result = run_turn_loop(&registry, executor, req).await;
        assert_eq!(result.stop_reason, LoopStopReason::EndTurn);
        // The tool result message should carry the error annotation.
        let tool_msg = result
            .final_messages
            .iter()
            .find(|m| m.role == "tool")
            .expect("no tool message in transcript");
        assert!(tool_msg.content.contains("[tool error]"));
        assert!(tool_msg.content.contains("permission denied"));
    }

    #[tokio::test]
    async fn loop_handles_validation_failure_via_executor() {
        // The model emits a tool call referencing an unregistered
        // tool. The executor still runs (it sees the validation
        // error and can decide), but the loop completes.

        // Turn 1: model calls an unknown tool. Turn 2: model returns
        // end_turn after seeing the executor's result.
        let mut turn1 = vec![anthropic_message_start("msg_1", "claude-3-7-sonnet")];
        turn1.extend(anthropic_tool_use(0, "tu_unknown", "ghost_tool", "{}"));
        turn1.push(anthropic_message_delta("tool_use"));
        turn1.push(anthropic_message_stop());
        let mut turn2 = vec![anthropic_message_start("msg_2", "claude-3-7-sonnet")];
        turn2.push(anthropic_text_delta(0, "OK"));
        turn2.push(anthropic_message_delta("end_turn"));
        turn2.push(anthropic_message_stop());
        let port = spawn_scripted_llm(vec![turn1, turn2]).await;

        // Registry with NO tools registered -- the call won't
        // validate.
        let registry = ToolRegistry::new();
        let counter = Arc::new(AtomicU32::new(0));
        let executor: ToolExecutor = {
            let counter = counter.clone();
            Arc::new(move |invocation: &ToolInvocation<'_>| -> ToolOutcomeFut {
                let count = counter.clone();
                let valid = invocation.validation.is_ok();
                Box::pin(async move {
                    count.fetch_add(1, Ordering::Relaxed);
                    ToolOutcome::ok(format!("{{\"invocation_was_valid\":{valid}}}"))
                })
            })
        };
        let req = turn_loop_request(
            format!("http://127.0.0.1:{port}"),
            vec![TurnMessage {
                role: "user".into(),
                content: "x".into(),
                tool_call_id: None,
            }],
        );
        let result = run_turn_loop(&registry, executor, req).await;
        // Loop terminated after two turns: first turn made a tool
        // call (executor ran with invalid validation), second turn
        // returned end_turn.
        assert_eq!(result.stop_reason, LoopStopReason::EndTurn);
        assert_eq!(counter.load(Ordering::Relaxed), 1);
        // The executor was given the validation error and chose to
        // run anyway (returning a `false` flag in the result).
        let tool_msg = result
            .final_messages
            .iter()
            .find(|m| m.role == "tool")
            .expect("no tool message");
        assert!(tool_msg.content.contains("\"invocation_was_valid\":false"));
    }
}