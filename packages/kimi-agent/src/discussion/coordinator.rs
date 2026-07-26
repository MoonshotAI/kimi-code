/// SwarmDiscussionCoordinator — roundtable discussion orchestration.
///
/// Corresponds to `packages/agent-core/src/agent/discussion/coordinator.ts`.
///
/// Orchestrates a roundtable discussion among multiple persistent subagents.
/// Each participant is a subagent that receives the full discussion transcript
/// before their turn. The actual subagent spawning and turn execution is
/// delegated to the host.
///
/// # Delegation model
/// The coordinator defines the orchestration protocol; the host provides
/// execution callbacks via `DiscussionHostDelegate`. This avoids circular
/// dependencies on `SessionSubagentHost` (a TypeScript-only concept).

use super::context::{DiscussionContext, DiscussionEntry};

// ── Types ──────────────────────────────────────────────────────────────────

/// Configuration for a single discussion participant.
#[derive(Debug, Clone)]
pub struct DiscussionParticipantConfig {
    /// Agent profile name (e.g., "researcher", "coder", "explore").
    pub profile_name: String,
    /// Role description injected into the agent's prompt each turn.
    pub role_description: String,
    /// How many times this participant speaks per round (default: 1).
    pub turns_per_round: u32,
}

impl DiscussionParticipantConfig {
    pub fn new(profile_name: impl Into<String>, role_description: impl Into<String>) -> Self {
        Self {
            profile_name: profile_name.into(),
            role_description: role_description.into(),
            turns_per_round: 1,
        }
    }

    pub fn with_turns(mut self, turns: u32) -> Self {
        self.turns_per_round = turns;
        self
    }
}

/// Options for starting a roundtable discussion.
#[derive(Debug, Clone)]
pub struct DiscussionOptions {
    /// The topic or question to discuss.
    pub topic: String,
    /// The participants in the discussion.
    pub participants: Vec<DiscussionParticipantConfig>,
    /// Maximum number of full rounds before the discussion ends (default: 3).
    pub max_rounds: u32,
    /// Optional: prompt used to generate a final summary.
    pub summary_prompt: Option<String>,
}

impl DiscussionOptions {
    pub fn new(topic: impl Into<String>, participants: Vec<DiscussionParticipantConfig>) -> Self {
        Self {
            topic: topic.into(),
            participants,
            max_rounds: 3,
            summary_prompt: None,
        }
    }

    pub fn with_max_rounds(mut self, rounds: u32) -> Self {
        self.max_rounds = rounds;
        self
    }

    pub fn with_summary(mut self, prompt: impl Into<String>) -> Self {
        self.summary_prompt = Some(prompt.into());
        self
    }
}

/// The result of a completed discussion.
#[derive(Debug, Clone)]
pub struct DiscussionResult {
    /// Ordered list of every speech in the discussion.
    pub transcript: Vec<DiscussionEntry>,
    /// A final summary (empty if no summary was generated).
    pub summary: String,
    /// How many full rounds were completed.
    pub rounds_completed: u32,
    /// How the discussion ended.
    pub ended_by: DiscussionEndReason,
    /// Failure message (when ended_by is Failed).
    pub failure_reason: Option<String>,
    /// Summary generation error (best-effort, does not fail the discussion).
    pub summary_error: Option<String>,
    /// Aggregate token usage across all participants.
    pub usage: TokenUsage,
}

/// Why the discussion ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscussionEndReason {
    MaxRounds,
    Cancelled,
    Failed,
}

/// Simple token usage aggregate.
#[derive(Debug, Default, Clone)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub output_tokens: u64,
}

impl TokenUsage {
    pub fn add(&mut self, other: &TokenUsage) {
        self.input_tokens += other.input_tokens;
        self.cache_read_tokens += other.cache_read_tokens;
        self.cache_creation_tokens += other.cache_creation_tokens;
        self.output_tokens += other.output_tokens;
    }
}

/// DiscussionTurnEvent — emitted by the coordinator for external observers (e.g., TUI).
#[derive(Debug, Clone)]
pub struct DiscussionTurnEvent {
    pub agent_id: String,
    pub role_name: String,
    pub round: u32,
    pub content: String,
}

/// Observer callback for discussion turn events.
pub type DiscussionObserver = Box<dyn Fn(&DiscussionTurnEvent) + Send + Sync>;

/// Delegate trait for host-side subagent operations.
///
/// The Rust coordinator calls these methods; the host (TypeScript process)
/// implements them to spawn/destroy subagents and execute turns.
pub trait DiscussionHostDelegate {
    /// Spawn a persistent subagent for a discussion participant.
    /// Returns an agent ID that will be used for subsequent turn calls.
    fn spawn_persistent(
        &self,
        profile_name: &str,
        description: &str,
    ) -> Result<String, String>;

    /// Run a single discussion turn for a persistent subagent.
    /// The full prompt (role + topic + transcript) is provided.
    fn run_discussion_turn(
        &self,
        agent_id: &str,
        prompt: &str,
    ) -> Result<String, String>;

    /// Get accumulated token usage for a persistent subagent.
    fn get_persistent_usage(&self, agent_id: &str) -> Option<TokenUsage>;

    /// Destroy a persistent subagent (best-effort).
    fn destroy_persistent(&self, agent_id: &str);
}

// ── Coordinator ────────────────────────────────────────────────────────────

/// SwarmDiscussionCoordinator — orchestrates a roundtable discussion.
///
/// Each participant is a persistent subagent that receives the full
/// discussion transcript before their turn.
pub struct SwarmDiscussionCoordinator {
    agent_ids: Vec<String>,
    observer: Option<DiscussionObserver>,
    host: Box<dyn DiscussionHostDelegate>,
    usage_per_agent: Vec<Option<TokenUsage>>,
}

impl SwarmDiscussionCoordinator {
    /// Create a new coordinator with the given host delegate.
    pub fn new(host: Box<dyn DiscussionHostDelegate>) -> Self {
        Self {
            agent_ids: Vec::new(),
            observer: None,
            host,
            usage_per_agent: Vec::new(),
        }
    }

    /// Set an observer for turn events (e.g., TUI display).
    pub fn set_observer(&mut self, observer: DiscussionObserver) {
        self.observer = Some(observer);
    }

    /// Run a roundtable discussion. Returns the result.
    pub fn discuss(
        &mut self,
        options: &DiscussionOptions,
    ) -> Result<DiscussionResult, String> {
        let mut context = DiscussionContext::new();
        let mut ended_by = DiscussionEndReason::MaxRounds;

        // 1. Spawn persistent subagents for each participant
        for participant in &options.participants {
            let agent_id = self.host.spawn_persistent(
                &participant.profile_name,
                &participant.role_description,
            )?;
            self.agent_ids.push(agent_id);
            self.usage_per_agent.push(None);
        }

        // 2. Round-robin discussion loop
        let mut rounds_completed = 0u32;

        let result = (|| -> Result<DiscussionResult, String> {
            for round in 1..=options.max_rounds {
                for (index, participant) in options.participants.iter().enumerate() {
                    let agent_id = &self.agent_ids[index];
                    let turns = participant.turns_per_round.max(1);

                    for _ in 0..turns {
                        let prompt = self.build_turn_prompt(
                            &participant.role_description,
                            &options.topic,
                            &context,
                        );

                        match self.host.run_discussion_turn(agent_id, &prompt) {
                            Ok(content) => {
                                context.add_entry(
                                    &participant.profile_name,
                                    agent_id,
                                    &content,
                                    round,
                                );
                                if let Some(ref observer) = self.observer {
                                    observer(&DiscussionTurnEvent {
                                        agent_id: agent_id.clone(),
                                        role_name: participant.profile_name.clone(),
                                        round,
                                        content,
                                    });
                                }
                            }
                            Err(e) => {
                                ended_by = DiscussionEndReason::Failed;
                                let result = self.collect_usage();
                                return Ok(DiscussionResult {
                                    transcript: context.all_entries(),
                                    summary: String::new(),
                                    rounds_completed,
                                    ended_by,
                                    failure_reason: Some(e),
                                    summary_error: None,
                                    usage: result,
                                });
                            }
                        }
                    }
                }
                rounds_completed = round;
            }

            // 3. Generate summary if requested
            let mut summary = String::new();
            let mut summary_error = None;

            if let Some(ref summary_prompt) = options.summary_prompt {
                if !context.is_empty() && !self.agent_ids.is_empty() {
                    match self.generate_summary(summary_prompt, &context) {
                        Ok(text) => summary = text,
                        Err(e) => summary_error = Some(e),
                    }
                }
            }

            // 4. Collect aggregate usage
            let usage = self.collect_usage();

            Ok(DiscussionResult {
                transcript: context.all_entries(),
                summary,
                rounds_completed,
                ended_by,
                failure_reason: None,
                summary_error,
                usage,
            })
        })();

        // Deterministic cleanup (no catch for errors)
        for (idx, agent_id) in self.agent_ids.iter().enumerate() {
            self.usage_per_agent[idx] = self.host.get_persistent_usage(agent_id);
            self.host.destroy_persistent(agent_id);
        }
        self.agent_ids.clear();

        result
    }

    /// Discard all agents (for cleanup after error/before abortion).
    pub fn destroy_all(&mut self) {
        for agent_id in &self.agent_ids {
            self.host.destroy_persistent(agent_id);
        }
        self.agent_ids.clear();
    }

    // ── Private ──

    fn build_turn_prompt(
        &self,
        role_description: &str,
        topic: &str,
        context: &DiscussionContext,
    ) -> String {
        let mut parts: Vec<String> = Vec::new();

        parts.push(format!("[System] Your role:\n{}", role_description));
        parts.push(String::new());
        parts.push(format!("Discussion topic:\n{}", topic));
        parts.push(String::new());

        let transcript = context.transcript();
        if !transcript.is_empty() {
            parts.push("Current discussion transcript:".to_string());
            parts.push(transcript);
            parts.push(String::new());
            parts.push(
                "Continue the discussion based on what has been said so far. \
                 Respond naturally, as if you are in a roundtable conversation."
                    .to_string(),
            );
        } else {
            parts.push(
                "You are the first to speak. Present your initial thoughts \
                 on the topic."
                    .to_string(),
            );
        }

        parts.join("\n")
    }

    fn generate_summary(
        &self,
        summary_prompt: &str,
        context: &DiscussionContext,
    ) -> Result<String, String> {
        let first_id = self.agent_ids.first().ok_or("No agents for summary")?;
        let prompt = [
            summary_prompt,
            "",
            "Full discussion transcript:",
            &context.transcript(),
            "",
            "Please provide a concise summary of the discussion.",
        ].join("\n");

        self.host.run_discussion_turn(first_id, &prompt)
    }

    fn collect_usage(&self) -> TokenUsage {
        let mut total = TokenUsage::default();
        for agent_id in &self.agent_ids {
            if let Some(u) = self.host.get_persistent_usage(agent_id) {
                total.add(&u);
            }
        }
        total
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Mock host for testing — stores subagent state in memory.
    struct MockHost {
        counter: std::sync::atomic::AtomicU32,
        agents: std::sync::Mutex<HashMap<String, String>>, // agent_id → profile name
        usage: std::sync::Mutex<HashMap<String, TokenUsage>>,
    }

    impl MockHost {
        fn new() -> Self {
            Self {
                counter: std::sync::atomic::AtomicU32::new(0),
                agents: std::sync::Mutex::new(HashMap::new()),
                usage: std::sync::Mutex::new(HashMap::new()),
            }
        }
    }

    impl DiscussionHostDelegate for MockHost {
        fn spawn_persistent(&self, profile_name: &str, _desc: &str) -> Result<String, String> {
            let id = self.counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let agent_id = format!("agent-{}", id);
            self.agents.lock().unwrap().insert(agent_id.clone(), profile_name.to_string());
            self.usage.lock().unwrap().insert(agent_id.clone(), TokenUsage {
                input_tokens: 100, output_tokens: 50, ..Default::default()
            });
            Ok(agent_id)
        }

        fn run_discussion_turn(&self, agent_id: &str, prompt: &str) -> Result<String, String> {
            let agents = self.agents.lock().unwrap();
            let name = agents.get(agent_id).unwrap_or(&"unknown".to_string()).clone();
            Ok(format!("[{} response] topic in prompt: {}", name,
                if prompt.len() > 50 { &prompt[..50] } else { prompt }))
        }

        fn get_persistent_usage(&self, agent_id: &str) -> Option<TokenUsage> {
            self.usage.lock().unwrap().get(agent_id).cloned()
        }

        fn destroy_persistent(&self, agent_id: &str) {
            self.agents.lock().unwrap().remove(agent_id);
        }
    }

    #[test]
    fn test_discussion_creates_agents_and_runs_rounds() {
        let host = Box::new(MockHost::new());
        let mut coord = SwarmDiscussionCoordinator::new(host);

        let options = DiscussionOptions::new(
            "Should we use Rust?",
            vec![
                DiscussionParticipantConfig::new("researcher", "You research technical approaches."),
                DiscussionParticipantConfig::new("coder", "You implement solutions."),
            ],
        ).with_max_rounds(2);

        let result = coord.discuss(&options).unwrap();
        assert!(!result.transcript.is_empty());
        assert!(result.rounds_completed == 2);
        assert_eq!(result.transcript.len(), 4); // 2 rounds × 2 participants
    }

    #[test]
    fn test_discussion_with_summary() {
        let host = Box::new(MockHost::new());
        let mut coord = SwarmDiscussionCoordinator::new(host);

        let options = DiscussionOptions::new(
            "Architecture decisions",
            vec![DiscussionParticipantConfig::new("architect", "You design systems.")],
        ).with_max_rounds(1).with_summary("Summarize the architecture discussion.");

        let result = coord.discuss(&options).unwrap();
        // Summary should be generated (provided by mock)
        assert!(!result.summary.is_empty());
    }

    #[test]
    fn test_build_turn_prompt_with_transcript() {
        let host = Box::new(MockHost::new());
        let coord = SwarmDiscussionCoordinator::new(host);
        let mut ctx = DiscussionContext::new();
        ctx.add_entry("Alice", "a1", "I vote Rust.", 1);

        let prompt = coord.build_turn_prompt("coder", "What language?", &ctx);
        assert!(prompt.contains("What language?"));
        assert!(prompt.contains("Alice"));
        assert!(prompt.contains("I vote Rust"));
    }

    #[test]
    fn test_build_turn_prompt_empty_transcript() {
        let host = Box::new(MockHost::new());
        let coord = SwarmDiscussionCoordinator::new(host);
        let ctx = DiscussionContext::new();

        let prompt = coord.build_turn_prompt("coder", "What language?", &ctx);
        assert!(prompt.contains("first to speak"));
    }
}