/// Loop event fold — reduce loop events into ContextMessages.
///
/// Pure state machine: fold_ctx tracks open step, pending tool calls,
/// and deferred messages. TS side retains wire integration.
///
/// Corresponds to `packages/agent-core-v2/src/agent/contextMemory/loopEventFold.ts`.
use napi_derive::napi;
use serde::{Deserialize, Serialize};

const TOOL_INTERRUPTED_ON_RESUME_OUTPUT: &str =
    "Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.";

/// Fold context — stateful across calls within one replay.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct FoldCtx {
    open_step_uuid: Option<String>,
    pending: Vec<String>,
    deferred: Vec<serde_json::Value>,
}

impl FoldCtx {
    fn new() -> Self {
        Self {
            open_step_uuid: None,
            pending: Vec::new(),
            deferred: Vec::new(),
        }
    }
}

/// Fold a loop event into the state.
/// state_json: JSON array of ContextMessage
/// fold_ctx_json: JSON { open_step_uuid, pending, deferred }
/// event_json: JSON LoopRecordedEvent
/// Returns JSON: { state: ContextMessage[], fold_ctx: FoldCtx }
#[napi]
pub fn native_fold_loop_event(
    state_json: String,
    fold_ctx_json: String,
    event_json: String,
) -> String {
    let mut state: Vec<serde_json::Value> =
        serde_json::from_str(&state_json).unwrap_or_default();
    let mut ctx: FoldCtx = serde_json::from_str(&fold_ctx_json).unwrap_or_else(|_| FoldCtx::new());
    let event: serde_json::Value =
        serde_json::from_str(&event_json).unwrap_or(serde_json::Value::Null);

    let event_type = event["type"].as_str().unwrap_or("");

    match event_type {
        "step.begin" => {
            state = settle_open_step(state, &mut ctx);
            let assistant = serde_json::json!({
                "role": "assistant",
                "content": [],
                "toolCalls": [],
                "partial": true,
            });
            ctx.open_step_uuid = event["uuid"].as_str().map(|s| s.to_string());
            state.push(assistant);
        }
        "step.end" => {
            ctx.open_step_uuid = None;
            state = settle_open_step(state, &mut ctx);
            state = flush_deferred(state, &mut ctx);
        }
        "content.part" => {
            let part = event["part"].clone();
            state = append_to_open_assistant(state, &part);
        }
        "tool.call" => {
            let tool_call_id = event["toolCallId"].as_str().unwrap_or("").to_string();
            let name = event["name"].as_str().unwrap_or("").to_string();
            let args = event.get("args");
            let extras = event.get("extras");

            let mut call = serde_json::json!({
                "type": "function",
                "id": tool_call_id,
                "name": name,
                "arguments": if args.is_none() || args.unwrap().is_null() {
                    serde_json::Value::Null
                } else {
                    serde_json::Value::String(serde_json::to_string(args.unwrap()).unwrap_or_default())
                },
            });
            if let Some(extras) = extras {
                if !extras.is_null() {
                    call["extras"] = extras.clone();
                }
            }

            ctx.pending.push(tool_call_id);
            state = append_to_open_assistant_with_call(state, |msg| {
                let mut calls = msg["toolCalls"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                calls.push(call.clone());
                msg["toolCalls"] = serde_json::json!(calls);
                msg.clone()
            });
        }
        "tool.result" => {
            let tool_call_id = event["toolCallId"].as_str().unwrap_or("").to_string();
            if !ctx.pending.contains(&tool_call_id) {
                // Unknown tool call id — skip
                // Keep state unchanged
            } else {
                let result = &event["result"];
                let output = result.get("output");
                let is_error = result.get("isError").and_then(|v| v.as_bool()).unwrap_or(false);
                let note = result.get("note");

                let tool_message = if let Some(output_str) = output.and_then(|o| o.as_str()) {
                    serde_json::json!({
                        "role": "tool",
                        "toolCallId": tool_call_id,
                        "content": [{"type": "text", "text": output_str}],
                        "toolCalls": [],
                        "isError": is_error,
                        "note": note,
                    })
                } else if let Some(output_arr) = output.and_then(|o| o.as_array()) {
                    serde_json::json!({
                        "role": "tool",
                        "toolCallId": tool_call_id,
                        "content": output_arr,
                        "toolCalls": [],
                        "isError": is_error,
                        "note": note,
                    })
                } else {
                    serde_json::json!({
                        "role": "tool",
                        "toolCallId": tool_call_id,
                        "content": [],
                        "toolCalls": [],
                        "isError": is_error,
                        "note": note,
                    })
                };

                ctx.pending.retain(|id| id != &tool_call_id);
                state.push(tool_message);
                state = flush_deferred(state, &mut ctx);
            }
        }
        "tools.dispatched" => {
            let tool_names = event["toolNames"]
                .as_array()
                .map(|arr| {
                    let mut names: Vec<&str> = arr.iter()
                        .filter_map(|v| v.as_str())
                        .collect();
                    names.sort();
                    names.dedup();
                    names
                })
                .unwrap_or_default();
            let count = event["count"].as_i64().unwrap_or(0);
            let list = tool_names.join(", ");
            let tool_word = if count == 1 { "tool is" } else { "tools are" };
            let message = format!(
                "[Speculative] {} {} running: {}. Based on what you expect to find, start preparing your analysis while results arrive.",
                count, tool_word, list
            );
            let system_msg = serde_json::json!({
                "role": "system",
                "content": [{"type": "text", "text": message}],
                "toolCalls": [],
            });
            state.push(system_msg);
        }
        _ => {}
    }

    let result = serde_json::json!({
        "state": state,
        "fold_ctx": {
            "open_step_uuid": ctx.open_step_uuid,
            "pending": ctx.pending,
            "deferred": ctx.deferred,
        },
    });
    serde_json::to_string(&result).unwrap_or_default()
}

/// Fold an append_message event.
/// Returns JSON: { state: ContextMessage[], fold_ctx: FoldCtx }
#[napi]
pub fn native_fold_append_message(
    state_json: String,
    fold_ctx_json: String,
    message_json: String,
) -> String {
    let mut state: Vec<serde_json::Value> =
        serde_json::from_str(&state_json).unwrap_or_default();
    let ctx: FoldCtx = serde_json::from_str(&fold_ctx_json).unwrap_or_else(|_| FoldCtx::new());
    let message: serde_json::Value =
        serde_json::from_str(&message_json).unwrap_or(serde_json::Value::Null);

    let mut new_ctx = ctx;
    if !new_ctx.pending.is_empty() {
        new_ctx.deferred.push(message);
    } else {
        state.push(message);
    }

    let result = serde_json::json!({
        "state": state,
        "fold_ctx": {
            "open_step_uuid": new_ctx.open_step_uuid,
            "pending": new_ctx.pending,
            "deferred": new_ctx.deferred,
        },
    });
    serde_json::to_string(&result).unwrap_or_default()
}

/// Reset fold state.
/// Returns JSON: { state: ContextMessage[], fold_ctx: FoldCtx }
#[napi]
pub fn native_reset_fold(state_json: String) -> String {
    let state: Vec<serde_json::Value> =
        serde_json::from_str(&state_json).unwrap_or_default();
    let ctx = FoldCtx::new();

    let result = serde_json::json!({
        "state": state,
        "fold_ctx": {
            "open_step_uuid": ctx.open_step_uuid,
            "pending": ctx.pending,
            "deferred": ctx.deferred,
        },
    });
    serde_json::to_string(&result).unwrap_or_default()
}

fn settle_open_step(
    mut state: Vec<serde_json::Value>,
    ctx: &mut FoldCtx,
) -> Vec<serde_json::Value> {
    state = close_pending(state, ctx);
    let index = find_open_assistant_index(&state);
    if index < 0 {
        return state;
    }
    let open = &state[index as usize];
    let has_tool_calls = open["toolCalls"].as_array().map_or(false, |c| !c.is_empty());
    if !has_tool_calls && open["content"]
        .as_array()
        .map_or(true, |c| c.iter().all(|p| is_vacuous_content_part(p)))
    {
        state.remove(index as usize);
        return state;
    }
    let mut next = open.clone();
    next["partial"] = serde_json::Value::Null;
    state[index as usize] = next;
    state
}

fn close_pending(
    mut state: Vec<serde_json::Value>,
    ctx: &mut FoldCtx,
) -> Vec<serde_json::Value> {
    if ctx.pending.is_empty() {
        return state;
    }
    for tool_call_id in ctx.pending.clone() {
        let msg = serde_json::json!({
            "role": "tool",
            "toolCallId": tool_call_id,
            "content": [{"type": "text", "text": TOOL_INTERRUPTED_ON_RESUME_OUTPUT}],
            "toolCalls": [],
            "isError": true,
        });
        state.push(msg);
    }
    ctx.pending.clear();
    flush_deferred(state, ctx)
}

fn flush_deferred(
    mut state: Vec<serde_json::Value>,
    ctx: &mut FoldCtx,
) -> Vec<serde_json::Value> {
    if !ctx.pending.is_empty() || ctx.deferred.is_empty() {
        return state;
    }
    state.append(&mut ctx.deferred);
    state
}

fn find_open_assistant_index(state: &[serde_json::Value]) -> isize {
    for i in (0..state.len()).rev() {
        if state[i].get("partial").and_then(|p| p.as_bool()) == Some(true) {
            return i as isize;
        }
    }
    -1
}

fn is_vacuous_content_part(part: &serde_json::Value) -> bool {
    part.get("type")
        .and_then(|t| t.as_str())
        .map(|t| t == "thinking")
        .unwrap_or(false)
}

fn append_to_open_assistant(
    mut state: Vec<serde_json::Value>,
    part: &serde_json::Value,
) -> Vec<serde_json::Value> {
    let index = find_open_assistant_index(&state);
    if index < 0 {
        return state;
    }
    let mut msg = state[index as usize].clone();
    let mut content = msg["content"].as_array().cloned().unwrap_or_default();
    content.push(part.clone());
    msg["content"] = serde_json::json!(content);
    state[index as usize] = msg;
    state
}

fn append_to_open_assistant_with_call<F>(
    mut state: Vec<serde_json::Value>,
    update: F,
) -> Vec<serde_json::Value>
where
    F: FnOnce(&mut serde_json::Value) -> serde_json::Value,
{
    let index = find_open_assistant_index(&state);
    if index < 0 {
        return state;
    }
    let mut msg = state[index as usize].clone();
    msg = update(&mut msg);
    state[index as usize] = msg;
    state
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_event(type_str: &str, fields: &[(&str, serde_json::Value)]) -> serde_json::Value {
        let mut event = serde_json::json!({"type": type_str});
        for (key, val) in fields {
            event[key] = val.clone();
        }
        event
    }

    fn call_fold(state: &str, ctx: &str, event: &serde_json::Value) -> (Vec<serde_json::Value>, FoldCtx) {
        let result = native_fold_loop_event(
            state.to_string(),
            ctx.to_string(),
            serde_json::to_string(event).unwrap(),
        );
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        let new_state: Vec<serde_json::Value> =
            serde_json::from_value(parsed["state"].clone()).unwrap();
        let new_ctx: FoldCtx =
            serde_json::from_value(parsed["fold_ctx"].clone()).unwrap();
        (new_state, new_ctx)
    }

    fn empty_ctx() -> String {
        r#"{"open_step_uuid": null, "pending": [], "deferred": []}"#.to_string()
    }

    #[test]
    fn test_step_begin_creates_assistant() {
        let (state, ctx) = call_fold("[]", &empty_ctx(), &make_event("step.begin", &[
            ("uuid", serde_json::json!("step-1")),
        ]));
        assert_eq!(state.len(), 1);
        assert_eq!(state[0]["role"], "assistant");
        assert_eq!(state[0]["partial"], true);
        assert_eq!(ctx.open_step_uuid, Some("step-1".to_string()));
    }

    #[test]
    fn test_content_part_appends_to_assistant() {
        let (state, _) = call_fold("[]", &empty_ctx(), &make_event("step.begin", &[
            ("uuid", serde_json::json!("step-1")),
        ]));
        let (state, _) = call_fold(
            &serde_json::to_string(&state).unwrap(),
            &serde_json::to_string(&FoldCtx { open_step_uuid: Some("step-1".to_string()), pending: vec![], deferred: vec![] }).unwrap(),
            &make_event("content.part", &[
                ("stepUuid", serde_json::json!("step-1")),
                ("part", serde_json::json!({"type": "text", "text": "hello"})),
            ]),
        );
        assert_eq!(state.len(), 1);
        assert_eq!(state[0]["content"][0]["text"], "hello");
    }

    #[test]
    fn test_tool_call_and_result() {
        let (state, _) = call_fold("[]", &empty_ctx(), &make_event("step.begin", &[
            ("uuid", serde_json::json!("step-1")),
        ]));
        let ctx = serde_json::to_string(&FoldCtx { open_step_uuid: Some("step-1".to_string()), pending: vec![], deferred: vec![] }).unwrap();
        let (state, ctx) = call_fold(
            &serde_json::to_string(&state).unwrap(), &ctx,
            &make_event("tool.call", &[
                ("stepUuid", serde_json::json!("step-1")),
                ("toolCallId", serde_json::json!("call-1")),
                ("name", serde_json::json!("read")),
                ("args", serde_json::json!({"path": "/a.txt"})),
            ]),
        );
        assert_eq!(state[0]["toolCalls"][0]["id"], "call-1");
        assert_eq!(ctx.pending.len(), 1);

        let (state, final_ctx) = call_fold(
            &serde_json::to_string(&state).unwrap(),
            &serde_json::to_string(&ctx).unwrap(),
            &make_event("tool.result", &[
                ("toolCallId", serde_json::json!("call-1")),
                ("result", serde_json::json!({"output": "file content"})),
            ]),
        );
        assert_eq!(state.len(), 2); // assistant + tool result
        assert_eq!(state[1]["role"], "tool");
        assert_eq!(state[1]["content"][0]["text"], "file content");
        assert!(final_ctx.pending.is_empty());
    }

    #[test]
    fn test_empty_assistant_dropped_on_end() {
        let (state, _) = call_fold("[]", &empty_ctx(), &make_event("step.begin", &[
            ("uuid", serde_json::json!("step-1")),
        ]));
        let ctx = serde_json::to_string(&FoldCtx { open_step_uuid: Some("step-1".to_string()), pending: vec![], deferred: vec![] }).unwrap();
        // step.end with no content — assistant should be dropped
        let (state, _) = call_fold(
            &serde_json::to_string(&state).unwrap(), &ctx,
            &make_event("step.end", &[
                ("uuid", serde_json::json!("step-1")),
            ]),
        );
        // No tool calls and no content → empty assistant dropped
        assert_eq!(state.len(), 0);
    }

    #[test]
    fn test_tools_dispatched() {
        let (state, _) = call_fold("[]", &empty_ctx(), &make_event("tools.dispatched", &[
            ("stepUuid", serde_json::json!("step-1")),
            ("toolNames", serde_json::json!(["read", "write"])),
            ("count", serde_json::json!(2)),
        ]));
        assert_eq!(state.len(), 1);
        assert_eq!(state[0]["role"], "system");
        assert!(state[0]["content"][0]["text"].as_str().unwrap().contains("2 tools are running"));
    }
}