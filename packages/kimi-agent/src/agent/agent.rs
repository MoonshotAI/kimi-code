/// Agent — the core orchestration struct.
///
/// Corresponds to the `Agent` class in `packages/agent-core/src/agent/index.ts`.
///
/// The Agent owns all subsystems (turn flow, context, config, hooks) and
/// provides the main interface for running turns.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::agent::turn_flow::TurnFlow;
use crate::agent::types::*;
use crate::callbacks::HostCallbacks;
use crate::context::context_memory::ContextMemory;
use crate::rpc::types::TokenUsage;
use crate::turn_loop::types as loop_types;

/// The core Agent struct.
pub struct Agent {
    /// Agent type: "main", "sub", or "independent".
    pub agent_type: String,
    /// Agent home directory for persistence.
    pub homedir: Option<String>,
    /// Agent configuration.
    pub config: AgentConfig,
    /// Turn flow (step loop manager).
    pub turn_flow: TurnFlow,
    /// Context memory (message history).
    pub context: ContextMemory,
    /// Host callbacks (JS bridge).
    pub callbacks: Arc<dyn HostCallbacks>,
    /// Agent hooks (permission, injection, etc.).
    pub hooks: AgentHooks,
    /// Optional turn runner override.
    pub run_turn_override: Option<Arc<dyn AgentTurnOverride + Send + Sync>>,
    /// Cancellation flag for the current turn.
    pub cancellation: Arc<AtomicBool>,
    /// Maximum steps per turn.
    pub max_steps_per_turn: u32,
    /// Maximum retries per step.
    pub max_retries_per_step: u32,
    /// Whether goal mode is enabled.
    pub goal_enabled: bool,
    /// Monotonic turn ID counter.
    turn_id_counter: u32,
    /// Whether the agent has an active turn.
    has_active_turn: bool,
}

impl Agent {
    /// Create a new Agent.
    pub fn new(
        callbacks: Arc<dyn HostCallbacks>,
        options: AgentOptions,
    ) -> Self {
        Self {
            agent_type: "main".to_string(),
            homedir: options.homedir,
            config: options.config.unwrap_or_else(|| AgentConfig {
                cwd: String::new(),
                model_alias: None,
                system_prompt: String::new(),
                has_provider: false,
                has_model: false,
            }),
            turn_flow: TurnFlow::new(),
            context: ContextMemory::new(),
            callbacks,
            hooks: AgentHooks::default(),
            run_turn_override: options.run_turn_override,
            cancellation: Arc::new(AtomicBool::new(false)),
            max_steps_per_turn: options.max_steps_per_turn,
            max_retries_per_step: options.max_retries_per_step,
            goal_enabled: options.goal_enabled,
            turn_id_counter: 0,
            has_active_turn: false,
        }
    }

    /// Run a single turn with the given user input.
    ///
    /// Returns the turn result on success, or an error if the turn could not start.
    pub async fn run_turn(
        &mut self,
        input: Vec<crate::context::types::ContentPart>,
    ) -> Result<TurnResult, Box<dyn std::error::Error + Send + Sync>> {
        let turn_id = self.next_turn_id();
        self.has_active_turn = true;
        self.cancellation.store(false, Ordering::Relaxed);

        // Append user input to context.
        self.context.append_user_message(
            &input,
            crate::context::types::MessageOrigin::User,
        );

        // Build RunTurnInput for the loop.
        let llm = AgentLlm::new(&self.config);
        let messages = self.context.messages();

        let loop_hooks = self.build_loop_hooks();

        let run_turn_input = loop_types::RunTurnInput {
            turn_id: turn_id.to_string(),
            llm: &llm,
            messages: messages_to_loop_messages(&messages),
            tools: &[],
            tool_defs: vec![],
            hooks: loop_hooks.as_ref(),
            max_steps: self.max_steps_per_turn,
            goal: None,
            cancellation: Some(self.cancellation.clone()),
        };

        // Run the turn (use override if present, otherwise use built-in).
        let result = if let Some(ref override_fn) = self.run_turn_override {
            override_fn.run_turn(run_turn_input, self.callbacks.as_ref()).await
        } else {
            crate::turn_loop::run_turn::run_turn(
                run_turn_input,
                &self.callbacks,
            ).await.map_err(|e| Box::new(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())) as Box<dyn std::error::Error + Send + Sync>)
        }?;

        self.has_active_turn = false;

        Ok(TurnResult {
            stop_reason: result.stop_reason,
            steps: result.steps,
            usage: result.usage,
        })
    }

    /// Cancel the current turn.
    pub fn cancel(&self) {
        self.cancellation.store(true, Ordering::Relaxed);
    }

    /// Check if the agent has an active turn.
    pub fn has_active_turn(&self) -> bool {
        self.has_active_turn
    }

    /// Set the system prompt.
    pub fn set_system_prompt(&mut self, prompt: String) {
        self.config.system_prompt = prompt;
    }

    /// Get the next turn ID.
    fn next_turn_id(&mut self) -> u32 {
        let id = self.turn_id_counter;
        self.turn_id_counter += 1;
        id
    }

    /// Build LoopHooks from the agent's hook system.
    fn build_loop_hooks(&self) -> Option<loop_types::LoopHooks> {
        let before_step = self.hooks.before_step.as_ref().map(|_| {
            let hooks = loop_types::LoopHooks::default();
            hooks
        });
        // For now, return None hooks if there are no custom hooks.
        // The JS side provides the real hook closures through the run_turn_override.
        if self.hooks.before_step.is_some() || self.hooks.after_step.is_some() {
            // Simplified: when we need to integrate with Rust hooks,
            // we wrap the closures here.
            None
        } else {
            None
        }
    }
}

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

/// Convert context messages to loop messages.
fn messages_to_loop_messages(
    _messages: &[crate::context::types::ContextMessage],
) -> Vec<loop_types::LLMMessage> {
    // Simplified: convert ContextMessages to LLMMessages
    // In production, this would be a proper projection
    vec![]
}