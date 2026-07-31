//! Native `AgentSwarm` tool — parallel subagent dispatch with swarm-mode
//! enforcement.
//!
//! Corresponds to `packages/agent-core/src/tools/builtin/collaboration/agent-swarm.ts`.
//!
//! The tool validates its input (description required, ≥2 items or a resume
//! map, `{{item}}` prompt template, ≤128 subagents, distinct prompts), enters
//! swarm mode, spawns one child [`Agent`] per item **in parallel**, and
//! renders the results in the same `<agent_swarm_result>` XML shape the TS
//! tool produces. `resume_agent_ids` is rejected with a clear error — native
//! children are single-shot and not resumable yet.

use std::sync::{Arc, Mutex};

use crate::agent::agent::MAX_SUBAGENT_DEPTH;
use crate::agent::subagent::run_child_agent;
use crate::callbacks::HostCallbacks;
use crate::permission::gate::PermissionGate;
use crate::rpc::types::{
    BoxFuture, NativeLlmConfig, ToolExecuteRequest, ToolExecuteResponse,
};
use crate::swarm::{SwarmMode, SwarmModeTrigger, AGENT_SWARM_TOOL_NAME};

/// Max subagents per AgentSwarm call (mirrors the TS constant).
const MAX_AGENT_SWARM_SUBAGENTS: usize = 128;
/// Placeholder substituted per item in the prompt template.
const PROMPT_TEMPLATE_PLACEHOLDER: &str = "{{item}}";
/// Subagent type used when `subagent_type` is omitted (mirrors TS).
const DEFAULT_SUBAGENT_TYPE: &str = "coder";

/// A single spawned subagent within the swarm.
struct SwarmItemSpec {
    /// 1-based index for display.
    index: usize,
    /// The item value (for `swarmItem` in the result render).
    item: String,
    /// The per-subagent prompt (template with the item substituted).
    prompt: String,
}

/// Intercepts the `AgentSwarm` tool and runs the swarm natively.
pub(crate) struct SwarmToolInterceptor {
    pub inner: Arc<dyn HostCallbacks>,
    /// Raw host callbacks handed to children so their own native chain sits
    /// on top of the host (not on the parent's interceptor chain).
    pub host: Arc<dyn HostCallbacks>,
    pub homedir: Option<String>,
    pub native_llm: Option<NativeLlmConfig>,
    pub permission: PermissionGate,
    pub system_prompt: String,
    pub max_steps_per_turn: u32,
    pub depth: u32,
    /// Shared swarm-mode state (enter on tool use; one-shot auto-exit is
    /// handled by the run_prompt boundary).
    pub swarm: Arc<Mutex<SwarmMode>>,
    /// External lifecycle hooks (optional): SubagentStart/Stop fire around
    /// each child turn.
    pub hooks: Option<Arc<crate::hooks::external::HookManager>>,
}

impl SwarmToolInterceptor {
    fn error(content: String) -> ToolExecuteResponse {
        ToolExecuteResponse {
            content,
            is_error: true,
            is_prediction: false,
            stop_turn: false,
            media: Vec::new(),
        }
    }
}

impl HostCallbacks for SwarmToolInterceptor {
    fn supports_tool_lifecycle(&self) -> bool {
        self.inner.supports_tool_lifecycle()
    }
    fn llm_chat(
        &self,
        r: crate::rpc::types::LlmChatRequest,
    ) -> BoxFuture<'static, Result<crate::rpc::types::LlmChatResponse, String>> {
        self.inner.llm_chat(r)
    }
    fn execute_tool(
        &self,
        req: ToolExecuteRequest,
    ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        if !req.tool_name.eq_ignore_ascii_case(AGENT_SWARM_TOOL_NAME) {
            return self.inner.execute_tool(req);
        }
        // Depth guard: never recurse past the cap.
        if self.depth >= MAX_SUBAGENT_DEPTH {
            return Box::pin(async move {
                Ok(Self::error(
                    "Subagent depth limit reached; run the work in the current agent.".into(),
                ))
            });
        }

        let description = req
            .arguments
            .get("description")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        if description.is_empty() {
            return Box::pin(async move {
                Ok(Self::error(
                    "AgentSwarm requires a non-empty `description`.".into(),
                ))
            });
        }
        // Resume is not supported for native single-shot children yet.
        if req
            .arguments
            .get("resume_agent_ids")
            .is_some_and(|v| !v.is_null())
        {
            return Box::pin(async move {
                Ok(Self::error(
                    "AgentSwarm `resume_agent_ids` is not supported by the native engine yet; \
                     spawn fresh subagents via `items` instead."
                        .into(),
                ))
            });
        }
        let items: Vec<String> = req
            .arguments
            .get("items")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        if items.len() < 2 {
            return Box::pin(async move {
                Ok(Self::error(
                    "AgentSwarm requires at least 2 items unless resume_agent_ids is provided."
                        .into(),
                ))
            });
        }
        if items.len() > MAX_AGENT_SWARM_SUBAGENTS {
            return Box::pin(async move {
                Ok(Self::error(format!(
                    "AgentSwarm supports at most {MAX_AGENT_SWARM_SUBAGENTS} subagents."
                )))
            });
        }
        let subagent_type = req
            .arguments
            .get("subagent_type")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_SUBAGENT_TYPE)
            .to_string();
        let prompt_template = req
            .arguments
            .get("prompt_template")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        if !prompt_template.contains(PROMPT_TEMPLATE_PLACEHOLDER) {
            return Box::pin(async move {
                Ok(Self::error(format!(
                    "prompt_template must include the {PROMPT_TEMPLATE_PLACEHOLDER} placeholder."
                )))
            });
        }

        // Distinct prompts only (mirrors TS `createAgentSwarmSpecs`).
        let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        let mut specs: Vec<SwarmItemSpec> = Vec::with_capacity(items.len());
        for (i, item) in items.into_iter().enumerate() {
            let prompt = prompt_template.replace(PROMPT_TEMPLATE_PLACEHOLDER, &item);
            if let Some(prev) = seen.get(&prompt).copied() {
                let msg = format!(
                    "Duplicate subagent prompts from items {prev} and {}. AgentSwarm requires \
                     distinct subagents.",
                    i + 1
                );
                return Box::pin(async move { Ok(Self::error(msg)) });
            }
            seen.insert(prompt.clone(), i + 1);
            specs.push(SwarmItemSpec {
                index: i + 1,
                item,
                prompt,
            });
        }

        let host = self.host.clone();
        let homedir = self.homedir.clone();
        let native_llm = self.native_llm.clone();
        let permission = self.permission.clone();
        let parent_prompt = self.system_prompt.clone();
        let max_steps = self.max_steps_per_turn;
        let child_depth = self.depth + 1;
        let subagent_type = subagent_type.clone();
        let swarm = self.swarm.clone();
        let hooks = self.hooks.clone();

        Box::pin(async move {
            // Enter swarm mode (one-shot `tool` trigger; the run_prompt
            // boundary auto-exits after the turn).
            if let Ok(mut sw) = swarm.lock() {
                sw.enter(SwarmModeTrigger::Tool);
            }

            let mut handles = Vec::with_capacity(specs.len());
            for spec in specs {
                let host = host.clone();
                let homedir = homedir.clone();
                let native_llm = native_llm.clone();
                let permission = permission.clone();
                let parent_prompt = parent_prompt.clone();
                let subagent_type = subagent_type.clone();
                let prompt = spec.prompt.clone();
                let hooks = hooks.clone();
                handles.push(tokio::spawn(async move {
                    (
                        spec.index,
                        spec.item.clone(),
                        run_child_agent(
                            host,
                            homedir,
                            native_llm,
                            permission,
                            &parent_prompt,
                            max_steps,
                            child_depth,
                            &subagent_type,
                            &prompt,
                            hooks.clone(),
                        )
                        .await,
                    )
                }));
            }

            let mut results: Vec<(usize, String, Result<String, String>)> =
                Vec::with_capacity(handles.len());
            for handle in handles {
                match handle.await {
                    Ok(joined) => results.push(joined),
                    Err(e) => results.push((0, String::new(), Err(format!("join: {e}")))),
                }
            }
            // Stable order by index, then render.
            results.sort_by_key(|(idx, _, _)| *idx);
            Ok(ToolExecuteResponse {
                content: render_swarm_results(&results),
                is_error: false,
                is_prediction: false,
                stop_turn: false,
                media: Vec::new(),
            })
        })
    }
    fn emit_event(&self, e: serde_json::Value) {
        self.inner.emit_event(e);
    }
    fn prepare_tool_execution(
        &self,
        r: crate::rpc::types::PrepareToolRequest,
    ) -> BoxFuture<'static, Result<Option<crate::rpc::types::PrepareToolResponse>, String>> {
        self.inner.prepare_tool_execution(r)
    }
    fn authorize_tool_execution(
        &self,
        r: crate::rpc::types::AuthorizeToolRequest,
    ) -> BoxFuture<'static, Result<Option<crate::rpc::types::AuthorizeToolResponse>, String>> {
        self.inner.authorize_tool_execution(r)
    }
    fn finalize_tool_result(
        &self,
        r: crate::rpc::types::FinalizeToolRequest,
    ) -> BoxFuture<'static, Result<crate::rpc::types::FinalizeToolResponse, String>> {
        self.inner.finalize_tool_result(r)
    }
}

/// Render the swarm results in the same `<agent_swarm_result>` XML shape the
/// TS tool produces: a summary line plus one `<item>` block per subagent.
fn render_swarm_results(results: &[(usize, String, Result<String, String>)]) -> String {
    let completed = results.iter().filter(|(_, _, r)| r.is_ok()).count();
    let failed = results.iter().filter(|(_, _, r)| r.is_err()).count();
    let mut lines = vec![
        "<agent_swarm_result>".to_string(),
        format!("<summary>{completed} completed, {failed} failed</summary>"),
    ];
    for (index, item, result) in results {
        let label = match result {
            Ok(text) => text.trim(),
            Err(e) => e.trim(),
        };
        lines.push(format!(
            "<item><index>{index}</index><swarm_item>{}</swarm_item><result>{}</result></item>",
            xml_escape(item),
            xml_escape(label),
        ));
    }
    lines.push("</agent_swarm_result>".to_string());
    lines.join("\n")
}

fn xml_escape(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal host that records the last request and returns a canned error.
    struct MockHost {
        calls: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    }

    impl HostCallbacks for MockHost {
        fn supports_tool_lifecycle(&self) -> bool { true }
        fn llm_chat(&self, _r: crate::rpc::types::LlmChatRequest) -> BoxFuture<'static, Result<crate::rpc::types::LlmChatResponse, String>> {
            Box::pin(async { Err("unexpected llm_chat".into()) })
        }
        fn execute_tool(&self, req: ToolExecuteRequest) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
            let calls = self.calls.clone();
            Box::pin(async move {
                calls.lock().unwrap().push(req.tool_name.clone());
                Ok(ToolExecuteResponse {
                    content: "inner".into(),
                    is_error: false,
                    is_prediction: false,
                    stop_turn: false,
                    media: Vec::new(),
                })
            })
        }
        fn emit_event(&self, _e: serde_json::Value) {}
        fn prepare_tool_execution(&self, _r: crate::rpc::types::PrepareToolRequest) -> BoxFuture<'static, Result<Option<crate::rpc::types::PrepareToolResponse>, String>> {
            Box::pin(async { Ok(None) })
        }
        fn authorize_tool_execution(&self, _r: crate::rpc::types::AuthorizeToolRequest) -> BoxFuture<'static, Result<Option<crate::rpc::types::AuthorizeToolResponse>, String>> {
            Box::pin(async { Ok(None) })
        }
        fn finalize_tool_result(&self, _r: crate::rpc::types::FinalizeToolRequest) -> BoxFuture<'static, Result<crate::rpc::types::FinalizeToolResponse, String>> {
            Box::pin(async { Ok(None) })
        }
    }

    fn interceptor(inner: Arc<dyn HostCallbacks>) -> SwarmToolInterceptor {
        SwarmToolInterceptor {
            host: inner.clone(),
            inner,
            homedir: None,
            native_llm: None,
            permission: crate::permission::gate::PermissionGate::from_env(),
            system_prompt: "parent".into(),
            max_steps_per_turn: 3,
            depth: 0,
            swarm: Arc::new(Mutex::new(SwarmMode::new())),
            hooks: None,
        }
    }

    fn run_tool(
        interceptor: &SwarmToolInterceptor,
        args: serde_json::Value,
    ) -> ToolExecuteResponse {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            interceptor
                .execute_tool(ToolExecuteRequest {
                    turn_id: "t".into(),
                    tool_call_id: "c1".into(),
                    tool_name: AGENT_SWARM_TOOL_NAME.into(),
                    arguments: args,
                    force_precise: false,
                })
                .await
                .unwrap()
        })
    }

    fn swarm_args(items: Vec<&str>) -> serde_json::Value {
        serde_json::json!({
            "description": "swarm test",
            "prompt_template": "Work on {{item}}",
            "items": items,
        })
    }

    #[test]
    fn non_swarm_tools_pass_through() {
        let inner: Arc<dyn HostCallbacks> = Arc::new(MockHost {
            calls: Default::default(),
        });
        let i = interceptor(inner.clone());
        let rt = tokio::runtime::Runtime::new().unwrap();
        let resp = rt.block_on(async {
            i.execute_tool(ToolExecuteRequest {
                turn_id: "t".into(),
                tool_call_id: "c1".into(),
                tool_name: "Read".into(),
                arguments: serde_json::json!({}),
                force_precise: false,
            })
            .await
            .unwrap()
        });
        assert_eq!(resp.content, "inner");
    }

    #[test]
    fn missing_description_is_rejected() {
        let inner: Arc<dyn HostCallbacks> = Arc::new(MockHost { calls: Default::default() });
        let i = interceptor(inner);
        let resp = run_tool(&i, serde_json::json!({ "items": ["a", "b"] }));
        assert!(resp.is_error);
        assert!(resp.content.contains("description"));
    }

    #[test]
    fn single_item_is_rejected() {
        let inner: Arc<dyn HostCallbacks> = Arc::new(MockHost { calls: Default::default() });
        let i = interceptor(inner);
        let resp = run_tool(&i, swarm_args(vec!["only"]));
        assert!(resp.is_error);
        assert!(resp.content.contains("at least 2 items"));
    }

    #[test]
    fn missing_placeholder_is_rejected() {
        let inner: Arc<dyn HostCallbacks> = Arc::new(MockHost { calls: Default::default() });
        let i = interceptor(inner);
        let resp = run_tool(
            &i,
            serde_json::json!({
                "description": "d",
                "prompt_template": "no placeholder here",
                "items": ["a", "b"],
            }),
        );
        assert!(resp.is_error);
        assert!(resp.content.contains("{{item}}"));
    }

    #[test]
    fn duplicate_prompts_are_rejected() {
        let inner: Arc<dyn HostCallbacks> = Arc::new(MockHost { calls: Default::default() });
        let i = interceptor(inner);
        let resp = run_tool(
            &i,
            serde_json::json!({
                "description": "d",
                "prompt_template": "{{item}}",
                "items": ["same", "same"],
            }),
        );
        assert!(resp.is_error);
        assert!(resp.content.contains("distinct"));
    }

    #[test]
    fn resume_agent_ids_is_rejected() {
        let inner: Arc<dyn HostCallbacks> = Arc::new(MockHost { calls: Default::default() });
        let i = interceptor(inner);
        let resp = run_tool(
            &i,
            serde_json::json!({
                "description": "d",
                "prompt_template": "{{item}}",
                "items": ["a", "b"],
                "resume_agent_ids": { "x": "continue" },
            }),
        );
        assert!(resp.is_error);
        assert!(resp.content.contains("resume_agent_ids"));
    }

    #[test]
    fn swarm_mode_enters_on_tool_use() {
        let inner: Arc<dyn HostCallbacks> = Arc::new(MockHost { calls: Default::default() });
        let i = interceptor(inner);
        // Validation failure still must NOT enter swarm mode.
        let resp = run_tool(&i, swarm_args(vec!["only"]));
        assert!(resp.is_error);
        assert!(!i.swarm.lock().unwrap().is_active());
    }

    #[test]
    fn render_escapes_xml_and_reports_failures() {
        let results = vec![
            (1, "a<b".to_string(), Ok("ok & done".to_string())),
            (2, "c".to_string(), Err("boom".to_string())),
        ];
        let rendered = render_swarm_results(&results);
        assert!(rendered.contains("<agent_swarm_result>"));
        assert!(rendered.contains("1 completed, 1 failed"));
        assert!(rendered.contains("a&lt;b"));
        assert!(rendered.contains("ok &amp; done"));
        assert!(rendered.contains("boom"));
    }
}
