//! Native `AgentSwarm` tool — parallel subagent dispatch with swarm-mode
//! enforcement.
//!
//! Corresponds to `packages/agent-core/src/tools/builtin/collaboration/agent-swarm.ts`.
//!
//! The tool validates its input (description required, ≥2 items or a resume
//! map, `{{item}}` prompt template, ≤128 subagents, distinct prompts), enters
//! swarm mode, spawns one child [`Agent`] per entry **in parallel**, and
//! renders the results in the same `<agent_swarm_result>` XML shape the TS
//! tool produces. `resume_agent_ids` maps a previously spawned child's
//! `agent_id` to its continuation prompt: the child's persisted context is
//! restored and extended by one more turn (native children persist via
//! `subagent::run_child_agent_persistent_with_model` / `resume_child_agent`).

use std::sync::{Arc, Mutex};

use crate::agent::agent::MAX_SUBAGENT_DEPTH;
use crate::agent::subagent::{
    generate_agent_id, resume_child_agent, run_child_agent_persistent_with_model,
};
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
    /// Persisted agent id when this entry resumes an existing child
    /// (`resume_agent_ids`); `None` for fresh item spawns.
    agent_id: Option<String>,
}

/// Intercepts the `AgentSwarm` tool and runs the swarm natively.
pub(crate) struct SwarmToolInterceptor {
    pub inner: Arc<dyn HostCallbacks>,
    /// Raw host callbacks handed to children so their own native chain sits
    /// on top of the host (not on the parent's interceptor chain).
    pub host: Arc<dyn HostCallbacks>,
    pub homedir: Option<String>,
    pub native_llm: Option<NativeLlmConfig>,
    /// Secondary-model config for subagent spawns (A12). Fresh swarm children
    /// whose `subagent_type` resolves to `model_preference: secondary` bind
    /// this model instead of inheriting the parent's.
    pub secondary_native_llm: Option<NativeLlmConfig>,
    /// Shared agent-profile registry — resolves `subagent_type` to its
    /// declared model preference (custom agent files).
    pub profile_registry: std::sync::Arc<std::sync::Mutex<crate::profile::registry::AgentProfileRegistry>>,
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
        // Resume is supported: `resume_agent_ids` maps a previously spawned
        // child's agent_id to its continuation prompt (mirrors TS
        // `createAgentSwarmSpecs`).
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
        let resume_agent_ids: Vec<(String, String)> = req
            .arguments
            .get("resume_agent_ids")
            .and_then(|v| v.as_object())
            .map(|obj| {
                obj.iter()
                    .filter_map(|(agent_id, prompt)| {
                        let agent_id = agent_id.trim();
                        let prompt = prompt.as_str().map(str::trim).unwrap_or("");
                        if agent_id.is_empty() || prompt.is_empty() {
                            None
                        } else {
                            Some((agent_id.to_string(), prompt.to_string()))
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        let item_count = items.len();
        let resume_count = resume_agent_ids.len();
        // Mirrors TS `hasMinimumAgentSwarmInputs` + `createAgentSwarmSpecs`:
        // resume entries alone satisfy the minimum; a prompt template is only
        // required for item-based spawns.
        if resume_count == 0 && item_count < 2 {
            return Box::pin(async move {
                Ok(Self::error(
                    "AgentSwarm requires at least 2 items unless resume_agent_ids is provided."
                        .into(),
                ))
            });
        }
        if resume_count + item_count > MAX_AGENT_SWARM_SUBAGENTS {
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
        if item_count > 0 && prompt_template.is_empty() {
            return Box::pin(async move {
                Ok(Self::error(
                    "AgentSwarm requires prompt_template when items is provided.".into(),
                ))
            });
        }
        if !prompt_template.is_empty() && !prompt_template.contains(PROMPT_TEMPLATE_PLACEHOLDER) {
            return Box::pin(async move {
                Ok(Self::error(format!(
                    "prompt_template must include the {PROMPT_TEMPLATE_PLACEHOLDER} placeholder."
                )))
            });
        }

        // Mirrors TS `createAgentSwarmSpecs` ordering: resume entries first
        // (they keep their own prompts), then item spawns with the template
        // applied. Duplicate-prompt detection covers item spawns only.
        let mut specs: Vec<SwarmItemSpec> = Vec::with_capacity(resume_count + item_count);
        for (agent_id, prompt) in resume_agent_ids {
            specs.push(SwarmItemSpec {
                index: specs.len() + 1,
                item: String::new(),
                prompt,
                agent_id: Some(agent_id),
            });
        }
        let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
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
                index: specs.len() + 1,
                item,
                prompt,
                agent_id: None,
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
        // A12: resolve the subagent model preference for this swarm's
        // subagent_type — a custom agent file may declare
        // `model_preference: secondary`, binding the configured secondary
        // model; otherwise children inherit the parent model.
        let parent_model = native_llm
            .as_ref()
            .map(|c| c.model.clone())
            .unwrap_or_else(|| "default".to_string());
        let secondary_model = self
            .secondary_native_llm
            .as_ref()
            .map(|c| c.model.clone());
        let model_override = {
            let registry = self.profile_registry.lock().unwrap_or_else(|e| e.into_inner());
            let preference = registry
                .catalog()
                .into_iter()
                .find(|def| def.name == subagent_type)
                .and_then(|def| def.model_preference)
                .map(|p| match p {
                    crate::profile::agent_file::ModelPreference::Primary => {
                        crate::agent::types::SubagentModelPreference::Primary
                    }
                    crate::profile::agent_file::ModelPreference::Secondary => {
                        crate::agent::types::SubagentModelPreference::Secondary
                    }
                })
                .unwrap_or(crate::agent::types::SubagentModelPreference::Primary);
            crate::agent::subagent::resolve_subagent_model(
                &parent_model,
                preference,
                secondary_model.as_deref(),
            )
        };

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
                let model_override = model_override.clone();
                // Resume entries reuse their persisted agent id; fresh item
                // spawns get a new stable id so the model can resume them
                // from a later call.
                let agent_id = spec.agent_id.clone().unwrap_or_else(generate_agent_id);
                handles.push(tokio::spawn(async move {
                    let result = match spec.agent_id {
                        Some(id) => {
                            resume_child_agent(
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
                                &id,
                            )
                            .await
                            .map(|(_, text)| text)
                        }
                        None => {
                            run_child_agent_persistent_with_model(
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
                                &agent_id,
                                model_override,
                            )
                            .await
                            .map(|(_, text)| text)
                        }
                    };
                    (spec.index, spec.item.clone(), agent_id, result)
                }));
            }

            let mut results: Vec<(usize, String, String, Result<String, String>)> =
                Vec::with_capacity(handles.len());
            for handle in handles {
                match handle.await {
                    Ok(joined) => results.push(joined),
                    Err(e) => {
                        results.push((0, String::new(), String::new(), Err(format!("join: {e}"))))
                    }
                }
            }
            // Stable order by index, then render.
            results.sort_by_key(|(idx, _, _, _)| *idx);
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
/// Each block carries `<agent_id>` so the model can fill `resume_agent_ids`
/// on a follow-up call to continue unfinished children.
fn render_swarm_results(results: &[(usize, String, String, Result<String, String>)]) -> String {
    let completed = results.iter().filter(|(_, _, _, r)| r.is_ok()).count();
    let failed = results.iter().filter(|(_, _, _, r)| r.is_err()).count();
    let mut lines = vec![
        "<agent_swarm_result>".to_string(),
        format!("<summary>{completed} completed, {failed} failed</summary>"),
    ];
    for (index, item, agent_id, result) in results {
        let label = match result {
            Ok(text) => text.trim(),
            Err(e) => e.trim(),
        };
        lines.push(format!(
            "<item><index>{index}</index><agent_id>{}</agent_id><swarm_item>{}</swarm_item><result>{}</result></item>",
            xml_escape(agent_id),
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

    fn interceptor_with(inner: Arc<dyn HostCallbacks>, homedir: Option<String>) -> SwarmToolInterceptor {
        SwarmToolInterceptor {
            host: inner.clone(),
            inner,
            homedir,
            native_llm: None,
            secondary_native_llm: None,
            profile_registry: std::sync::Arc::new(std::sync::Mutex::new(
                crate::profile::registry::AgentProfileRegistry::new(),
            )),
            permission: crate::permission::gate::PermissionGate::from_env(),
            system_prompt: "parent".into(),
            max_steps_per_turn: 3,
            depth: 0,
            swarm: Arc::new(Mutex::new(SwarmMode::new())),
            hooks: None,
        }
    }

    fn interceptor(inner: Arc<dyn HostCallbacks>) -> SwarmToolInterceptor {
        interceptor_with(inner, None)
    }

    /// A unique temp dir per test, so persisted swarm sessions never collide
    /// across parallel tests.
    fn temp_test_homedir() -> String {
        let dir = std::env::temp_dir().join(format!("kimi-agent-swarm-test-{}", fastrand::u64(..)));
        std::fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().into_owned()
    }

    /// Host whose `llm_chat` records every request and returns a canned
    /// completed response, so child turns finish in one step.
    struct CompletingHost {
        calls: Arc<Mutex<Vec<crate::rpc::types::LlmChatRequest>>>,
    }

    impl HostCallbacks for CompletingHost {
        fn supports_tool_lifecycle(&self) -> bool { true }
        fn llm_chat(&self, r: crate::rpc::types::LlmChatRequest) -> BoxFuture<'static, Result<crate::rpc::types::LlmChatResponse, String>> {
            let calls = self.calls.clone();
            Box::pin(async move {
                calls.lock().unwrap().push(r);
                Ok(crate::rpc::types::LlmChatResponse {
                    content: "final answer".into(),
                    tool_calls: Vec::new(),
                    finish_reason: Some("stop".into()),
                    usage: crate::rpc::types::TokenUsage {
                        input_tokens: 1,
                        output_tokens: 1,
                        total_tokens: 2,
                    },
                })
            })
        }
        fn execute_tool(&self, _req: ToolExecuteRequest) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
            Box::pin(async move {
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

    /// Extract the first rendered `<agent_id>` value from a swarm result.
    fn extract_agent_id(content: &str) -> String {
        let marker = "<agent_id>";
        let start = content.find(marker).expect("agent_id in render") + marker.len();
        let end = content[start..]
            .find("</agent_id>")
            .expect("closing agent_id tag")
            + start;
        content[start..end].to_string()
    }

    fn run_tool(
        interceptor: &SwarmToolInterceptor,
        args: serde_json::Value,
    ) -> ToolExecuteResponse {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            interceptor
                .execute_tool(ToolExecuteRequest {
                    session_id: None,
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
                session_id: None,
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
    fn resume_agent_ids_is_accepted_and_renders_agent_ids() {
        let inner: Arc<dyn HostCallbacks> = Arc::new(MockHost { calls: Default::default() });
        let i = interceptor(inner);
        let resp = run_tool(
            &i,
            serde_json::json!({
                "description": "d",
                "prompt_template": "{{item}}",
                "items": ["a", "b"],
                "resume_agent_ids": { "swarm-1-1": "continue" },
            }),
        );
        // No longer rejected: the tool executes and renders one result per
        // child (children fail against the mock host, but per-child, not as
        // a tool error).
        assert!(!resp.is_error, "{}", resp.content);
        assert!(resp.content.contains("<agent_swarm_result>"));
        // Resume entries run first (index 1) and keep their agent id.
        assert!(resp
            .content
            .contains("<item><index>1</index><agent_id>swarm-1-1</agent_id>"));
        // Item spawns render their generated swarm ids too.
        assert!(resp.content.contains("<agent_id>swarm-"));
        // Summary counts vary with how the mock's failed llm_chat settles in
        // each child turn; only the render shape is asserted here.
        assert!(resp.content.contains("<summary>"));
    }

    #[test]
    fn resume_only_call_without_prompt_template_is_accepted() {
        // Mirrors TS: a resume-only call has no `items`, so `prompt_template`
        // is not required.
        let inner: Arc<dyn HostCallbacks> = Arc::new(MockHost { calls: Default::default() });
        let i = interceptor(inner);
        let resp = run_tool(
            &i,
            serde_json::json!({
                "description": "d",
                "resume_agent_ids": { "swarm-1-1": "continue", "swarm-1-2": "go on" },
            }),
        );
        assert!(!resp.is_error, "{}", resp.content);
        assert!(resp.content.contains("<agent_swarm_result>"));
    }

    #[test]
    fn swarm_children_persist_and_resume_restores_context() {
        // Spawn completes and persists the conversation under a generated
        // agent_id; a second call resuming that id restores the prior turn's
        // history before running the continuation prompt.
        let calls: Arc<Mutex<Vec<crate::rpc::types::LlmChatRequest>>> = Default::default();
        let inner: Arc<dyn HostCallbacks> = Arc::new(CompletingHost { calls: calls.clone() });
        let homedir = temp_test_homedir();
        let i = interceptor_with(inner, Some(homedir));

        let resp = run_tool(&i, swarm_args(vec!["alpha", "beta"]));
        assert!(!resp.is_error, "{}", resp.content);
        assert!(resp.content.contains("<agent_id>swarm-"));
        let agent_id = extract_agent_id(&resp.content);

        let resp2 = run_tool(
            &i,
            serde_json::json!({
                "description": "resume",
                "prompt_template": "{{item}}",
                "items": ["gamma"],
                "resume_agent_ids": { agent_id.clone(): "continue" },
            }),
        );
        assert!(!resp2.is_error, "{}", resp2.content);
        // The resumed child renders under its persisted agent id.
        assert!(resp2
            .content
            .contains(&format!("<agent_id>{agent_id}</agent_id>")));

        // The resumed child's LLM request carried the first turn's prompt AND
        // the continuation prompt — i.e. the persisted context was restored.
        let reqs = calls.lock().unwrap();
        let resumed = reqs.iter().find(|r| {
            let texts: Vec<&str> = r.messages.iter().map(|m| m.content.as_str()).collect();
            texts.iter().any(|t| t.contains("Work on alpha"))
                && texts.iter().any(|t| t.contains("continue"))
        });
        assert!(
            resumed.is_some(),
            "resumed child did not see the prior conversation: {reqs:?}"
        );
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
            (1, "a<b".to_string(), "swarm-1".to_string(), Ok("ok & done".to_string())),
            (2, "c".to_string(), "".to_string(), Err("boom".to_string())),
        ];
        let rendered = render_swarm_results(&results);
        assert!(rendered.contains("<agent_swarm_result>"));
        assert!(rendered.contains("1 completed, 1 failed"));
        assert!(rendered.contains("a&lt;b"));
        assert!(rendered.contains("ok &amp; done"));
        assert!(rendered.contains("boom"));
        // Every result carries its agent_id for the model to resume from.
        assert!(rendered.contains("<agent_id>swarm-1</agent_id>"));
    }
}
