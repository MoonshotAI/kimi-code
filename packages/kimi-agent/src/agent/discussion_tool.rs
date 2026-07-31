//! Native `SwarmDiscussion` tool — roundtable discussion / structured debate
//! orchestrated by the discussion coordinators with native child agents.
//!
//! Corresponds to `packages/agent-core/src/tools/builtin/collaboration/swarm-discussion.ts`.
//!
//! The tool validates its input (mode/topic/participants/maxRounds/summary/
//! voting), enters swarm mode, and drives the discussion through
//! [`SwarmDiscussionCoordinator`] / [`StructuredDebateCoordinator`. The
//! coordinator's host delegate is implemented natively: each participant turn
//! spawns a fresh depth-limited child [`Agent`] via `run_child_agent` (native
//! children are single-shot, so "persistent" here means re-spawned per turn).
//! Results are rendered in the same `<discussion_result>` / `<debate_result>`
//! XML shapes the TS tool produces.

use std::sync::{Arc, Mutex};

use crate::agent::agent::MAX_SUBAGENT_DEPTH;
use crate::agent::subagent::run_child_agent;
use crate::callbacks::HostCallbacks;
use crate::discussion::coordinator::{
    DiscussionHostDelegate, DiscussionOptions, DiscussionParticipantConfig, DiscussionResult,
    SwarmDiscussionCoordinator, TokenUsage,
};
use crate::discussion::debate::{
    DebateOptions, DebateParticipantConfig, DebateResult, StructuredDebateCoordinator,
};
use crate::permission::gate::PermissionGate;
use crate::rpc::types::{
    BoxFuture, NativeLlmConfig, ToolExecuteRequest, ToolExecuteResponse,
};
use crate::swarm::{SwarmMode, SwarmModeTrigger};

/// Max participants per SwarmDiscussion call (mirrors the TS schema).
const MAX_PARTICIPANTS: usize = 10;
/// Min participants (mirrors the TS schema).
const MIN_PARTICIPANTS: usize = 2;
/// Default subagent type (mirrors the TS default).
const DEFAULT_SUBAGENT_TYPE: &str = "coder";

/// A participant spec parsed from the tool input.
struct ParticipantSpec {
    profile: String,
    role: String,
    stance: Option<String>,
}

/// Native implementation of the discussion host delegate: every participant
/// turn spawns a fresh child agent on the same host base callbacks.
struct NativeDiscussionHost {
    host: Arc<dyn HostCallbacks>,
    homedir: Option<String>,
    native_llm: Option<NativeLlmConfig>,
    permission: PermissionGate,
    system_prompt: String,
    max_steps: u32,
    depth: u32,
    counter: std::sync::atomic::AtomicU32,
    profiles: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, String>>>,
    hooks: Option<Arc<crate::hooks::external::HookManager>>,
}

impl DiscussionHostDelegate for NativeDiscussionHost {
    fn spawn_persistent(
        &self,
        profile_name: &str,
        _description: &str,
    ) -> BoxFuture<'static, Result<String, String>> {
        let id = self.counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let agent_id = format!("participant-{id}");
        let profile = profile_name.to_string();
        let profiles = self.profiles.clone();
        Box::pin(async move {
            profiles.lock().unwrap().insert(agent_id.clone(), profile);
            Ok(agent_id)
        })
    }

    fn run_discussion_turn(
        &self,
        agent_id: &str,
        prompt: &str,
    ) -> BoxFuture<'static, Result<String, String>> {
        let host = self.host.clone();
        let homedir = self.homedir.clone();
        let native_llm = self.native_llm.clone();
        let permission = self.permission.clone();
        let system_prompt = self.system_prompt.clone();
        let max_steps = self.max_steps;
        let depth = self.depth + 1;
        let profile = self
            .profiles
            .lock()
            .unwrap()
            .get(agent_id)
            .cloned()
            .unwrap_or_else(|| DEFAULT_SUBAGENT_TYPE.to_string());
        let prompt = prompt.to_string();
        let hooks = self.hooks.clone();
        Box::pin(async move {
            run_child_agent(
                host,
                homedir,
                native_llm,
                permission,
                &system_prompt,
                max_steps,
                depth,
                &profile,
                &prompt,
                hooks,
            )
            .await
        })
    }

    fn get_persistent_usage(
        &self,
        _agent_id: &str,
    ) -> BoxFuture<'static, Option<TokenUsage>> {
        Box::pin(async { None })
    }

    fn destroy_persistent(&self, agent_id: &str) {
        self.profiles.lock().unwrap().remove(agent_id);
    }
}

/// Intercepts the `SwarmDiscussion` tool and runs it natively.
pub(crate) struct DiscussionToolInterceptor {
    pub inner: Arc<dyn HostCallbacks>,
    pub host: Arc<dyn HostCallbacks>,
    pub homedir: Option<String>,
    pub native_llm: Option<NativeLlmConfig>,
    pub permission: PermissionGate,
    pub system_prompt: String,
    pub max_steps_per_turn: u32,
    pub depth: u32,
    pub swarm: Arc<Mutex<SwarmMode>>,
    pub hooks: Option<Arc<crate::hooks::external::HookManager>>,
}

impl DiscussionToolInterceptor {
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

impl HostCallbacks for DiscussionToolInterceptor {
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
        if !req.tool_name.eq_ignore_ascii_case("SwarmDiscussion") {
            return self.inner.execute_tool(req);
        }
        if self.depth >= MAX_SUBAGENT_DEPTH {
            return Box::pin(async move {
                Ok(Self::error(
                    "Subagent depth limit reached; run the work in the current agent.".into(),
                ))
            });
        }

        let mode = req
            .arguments
            .get("mode")
            .and_then(|v| v.as_str())
            .unwrap_or("discussion")
            .to_string();
        let topic = req
            .arguments
            .get("topic")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        if topic.is_empty() {
            return Box::pin(async move {
                Ok(Self::error("SwarmDiscussion requires a non-empty `topic`.".into()))
            });
        }
        let participants: Vec<ParticipantSpec> = req
            .arguments
            .get("participants")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|p| {
                        let role = p
                            .get("roleDescription")
                            .or_else(|| p.get("role_description"))
                            .and_then(|v| v.as_str())
                            .map(str::trim)?;
                        if role.is_empty() {
                            return None;
                        }
                        Some(ParticipantSpec {
                            profile: p
                                .get("profileName")
                                .or_else(|| p.get("profile_name"))
                                .and_then(|v| v.as_str())
                                .map(str::trim)
                                .filter(|s| !s.is_empty())
                                .unwrap_or(DEFAULT_SUBAGENT_TYPE)
                                .to_string(),
                            role: role.to_string(),
                            stance: p
                                .get("assignedStance")
                                .or_else(|| p.get("assigned_stance"))
                                .and_then(|v| v.as_str())
                                .map(str::trim)
                                .filter(|s| !s.is_empty())
                                .map(str::to_string),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        if participants.len() < MIN_PARTICIPANTS || participants.len() > MAX_PARTICIPANTS {
            return Box::pin(async move {
                Ok(Self::error(format!(
                    "SwarmDiscussion requires {MIN_PARTICIPANTS}-{MAX_PARTICIPANTS} participants."
                )))
            });
        }
        let max_rounds = req
            .arguments
            .get("maxRounds")
            .or_else(|| req.arguments.get("max_rounds"))
            .and_then(|v| v.as_u64())
            .unwrap_or(3)
            .max(1) as u32;
        let summary_prompt = req
            .arguments
            .get("summaryPrompt")
            .or_else(|| req.arguments.get("summary_prompt"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let enable_voting = req
            .arguments
            .get("enableVoting")
            .or_else(|| req.arguments.get("enable_voting"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let host = self.host.clone();
        let homedir = self.homedir.clone();
        let native_llm = self.native_llm.clone();
        let permission = self.permission.clone();
        let system_prompt = self.system_prompt.clone();
        let max_steps = self.max_steps_per_turn;
        let depth = self.depth;
        let swarm = self.swarm.clone();
        let hooks = self.hooks.clone();

        Box::pin(async move {
            if let Ok(mut sw) = swarm.lock() {
                sw.enter(SwarmModeTrigger::Tool);
            }
            let debate_host = NativeDiscussionHost {
                host,
                homedir,
                native_llm,
                permission,
                system_prompt,
                max_steps,
                depth,
                counter: std::sync::atomic::AtomicU32::new(0),
                profiles: Default::default(),
                hooks,
            };
            if mode == "debate" {
                let mut options = DebateOptions::new(
                    &topic,
                    participants
                        .iter()
                        .map(|p| {
                            DebateParticipantConfig::new(p.profile.clone(), p.role.clone())
                                .with_stance(p.stance.clone().unwrap_or_default())
                        })
                        .collect(),
                )
                .with_max_rounds(max_rounds);
                if let Some(ref sp) = summary_prompt {
                    options = options.with_consensus(sp.clone());
                }
                if enable_voting {
                    options = options.with_voting();
                }
                let mut coord = StructuredDebateCoordinator::new(Box::new(debate_host));
                match coord.debate(&options).await {
                    Ok(result) => Ok(ToolExecuteResponse {
                        content: render_debate_result(&result),
                        is_error: false,
                        is_prediction: false,
                        stop_turn: false,
                        media: Vec::new(),
                    }),
                    Err(e) => Ok(Self::error(format!("SwarmDiscussion failed: {e}"))),
                }
            } else {
                let mut options = DiscussionOptions::new(
                    &topic,
                    participants
                        .iter()
                        .map(|p| {
                            DiscussionParticipantConfig::new(p.profile.clone(), p.role.clone())
                        })
                        .collect(),
                )
                .with_max_rounds(max_rounds);
                if let Some(ref sp) = summary_prompt {
                    options = options.with_summary(sp.clone());
                }
                let mut coord = SwarmDiscussionCoordinator::new(Box::new(debate_host));
                match coord.discuss(&options).await {
                    Ok(result) => Ok(ToolExecuteResponse {
                        content: render_discussion_result(&result),
                        is_error: false,
                        is_prediction: false,
                        stop_turn: false,
                        media: Vec::new(),
                    }),
                    Err(e) => Ok(Self::error(format!("SwarmDiscussion failed: {e}"))),
                }
            }
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

/// Render a discussion result in the same `<discussion_result>` XML shape the
/// TS tool produces.
fn render_discussion_result(result: &DiscussionResult) -> String {
    let status = if result.ended_by == crate::discussion::coordinator::DiscussionEndReason::MaxRounds
    {
        "completed"
    } else {
        "failed"
    };
    let mut lines = vec![
        "<discussion_result>".to_string(),
        format!(
            "<summary>rounds: {}, speeches: {}, status: {status}</summary>",
            result.rounds_completed,
            result.transcript.len()
        ),
        "<transcript>".to_string(),
    ];
    for entry in &result.transcript {
        lines.push(format!("[{}] {}", entry.speaker, entry.content));
        lines.push(String::new());
    }
    lines.push("</transcript>".to_string());
    if !result.summary.is_empty() {
        lines.push("<final_summary>".to_string());
        lines.push(result.summary.clone());
        lines.push("</final_summary>".to_string());
    }
    lines.push("</discussion_result>".to_string());
    lines.join("\n")
}

/// Render a debate result in the same `<debate_result>` XML shape the TS tool
/// produces.
fn render_debate_result(result: &DebateResult) -> String {
    let mut lines = vec![
        "<debate_result>".to_string(),
        format!(
            "<summary>speeches: {}, phases: {}, cross_refs: {}, position_changes: {}, status: {}</summary>",
            result.transcript.len(),
            result.phases.len(),
            result.cross_references_count,
            result.position_changes,
            result.ended_by
        ),
        "<phases>".to_string(),
    ];
    for phase in &result.phases {
        lines.push(format!(
            "  <phase name=\"{}\" speeches=\"{}\" />",
            phase.phase.wire_name(),
            phase.entry_count
        ));
    }
    lines.push("</phases>".to_string());
    lines.push("<transcript>".to_string());
    for entry in &result.transcript {
        lines.push(format!("[{}] {}", entry.speaker, entry.content));
        lines.push(String::new());
    }
    lines.push("</transcript>".to_string());
    if !result.consensus.is_empty() {
        lines.push("<consensus>".to_string());
        lines.push(result.consensus.clone());
        lines.push("</consensus>".to_string());
    }
    if !result.voting_result.is_empty() {
        lines.push("<voting_result>".to_string());
        lines.push(result.voting_result.clone());
        lines.push("</voting_result>".to_string());
    }
    lines.push("</debate_result>".to_string());
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discussion::coordinator::DiscussionEndReason;

    #[test]
    fn render_discussion_shape() {
        let result = DiscussionResult {
            transcript: vec![
                crate::discussion::DiscussionEntry {
                    speaker: "alice".into(),
                    agent_id: "a1".into(),
                    content: "I propose Rust".into(),
                    round: 1,
                },
            ],
            summary: "Everyone agrees on Rust.".into(),
            rounds_completed: 1,
            ended_by: DiscussionEndReason::MaxRounds,
            failure_reason: None,
            summary_error: None,
            usage: Default::default(),
        };
        let rendered = render_discussion_result(&result);
        assert!(rendered.contains("<discussion_result>"));
        assert!(rendered.contains("rounds: 1, speeches: 1, status: completed"));
        assert!(rendered.contains("[alice] I propose Rust"));
        assert!(rendered.contains("<final_summary>"));
        assert!(rendered.contains("Everyone agrees on Rust."));
    }

    #[test]
    fn render_debate_shape() {
        let result = DebateResult {
            transcript: vec![
                crate::discussion::DiscussionEntry {
                    speaker: "pro".into(),
                    agent_id: "a1".into(),
                    content: "Microservices scale.".into(),
                    round: 1,
                },
            ],
            phases: vec![
                crate::discussion::PhaseBreakdownEntry {
                    phase: crate::discussion::DebatePhase::Opening,
                    entry_count: 1,
                },
            ],
            consensus: "Compromise found.".into(),
            voting_result: "Majority: microservices".into(),
            ended_by: "completed".into(),
            usage: Default::default(),
            cross_references_count: 2,
            position_changes: 1,
        };
        let rendered = render_debate_result(&result);
        assert!(rendered.contains("<debate_result>"));
        assert!(rendered.contains("cross_refs: 2, position_changes: 1"));
        assert!(rendered.contains("<phase name=\"opening\" speeches=\"1\" />"));
        assert!(rendered.contains("[pro] Microservices scale."));
        assert!(rendered.contains("<consensus>"));
        assert!(rendered.contains("<voting_result>"));
    }

    #[test]
    fn parse_rejects_missing_topic() {
        let inner: Arc<dyn HostCallbacks> = Arc::new(MockHost { calls: Default::default() });
        let i = interceptor(inner);
        let rt = tokio::runtime::Runtime::new().unwrap();
        let resp = rt.block_on(async {
            i.execute_tool(ToolExecuteRequest {
                session_id: None,
                turn_id: "t".into(),
                tool_call_id: "c1".into(),
                tool_name: "SwarmDiscussion".into(),
                arguments: serde_json::json!({ "participants": [{ "roleDescription": "r" }] }),
                force_precise: false,
            })
            .await
            .unwrap()
        });
        assert!(resp.is_error);
        assert!(resp.content.contains("topic"));
    }

    #[test]
    fn parse_rejects_too_few_participants() {
        let inner: Arc<dyn HostCallbacks> = Arc::new(MockHost { calls: Default::default() });
        let i = interceptor(inner);
        let rt = tokio::runtime::Runtime::new().unwrap();
        let resp = rt.block_on(async {
            i.execute_tool(ToolExecuteRequest {
                session_id: None,
                turn_id: "t".into(),
                tool_call_id: "c1".into(),
                tool_name: "SwarmDiscussion".into(),
                arguments: serde_json::json!({
                    "topic": "t",
                    "participants": [{ "roleDescription": "r" }]
                }),
                force_precise: false,
            })
            .await
            .unwrap()
        });
        assert!(resp.is_error);
        assert!(resp.content.contains("participants"));
    }

    /// Minimal host that records calls and returns a canned error.
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

    fn interceptor(inner: Arc<dyn HostCallbacks>) -> DiscussionToolInterceptor {
        DiscussionToolInterceptor {
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
}
