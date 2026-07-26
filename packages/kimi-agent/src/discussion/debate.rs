/// StructuredDebateCoordinator — multi-phase structured debate orchestration.
///
/// Corresponds to `packages/agent-core/src/agent/discussion/debate-coordinator.ts`.
///
/// Orchestrates a structured, multi-phase debate where participants present
/// positions, engage in free debate, deliver closing arguments, and optionally
/// vote for a consensus. The host provides execution callbacks.
///
/// # Phases
/// 1. Opening Statements — each participant presents initial stance
/// 2. Free Debate — participants respond to and challenge each other
/// 3. Closing Arguments — each participant delivers a final summary
/// 4. Consensus (optional) — extract agreed/disagreed points

use super::context::{
    CrossReference, CrossRefStance, DebatePhase, DiscussionContext, DiscussionEntry,
    PhaseBreakdownEntry, PositionRecord,
};
use super::coordinator::{DiscussionHostDelegate, DiscussionObserver, DiscussionTurnEvent, TokenUsage};

// ── Types ──────────────────────────────────────────────────────────────────

/// Configuration for a single debate participant.
#[derive(Debug, Clone)]
pub struct DebateParticipantConfig {
    pub profile_name: String,
    pub role_description: String,
    pub assigned_stance: Option<String>,
}

impl DebateParticipantConfig {
    pub fn new(profile_name: impl Into<String>, role_description: impl Into<String>) -> Self {
        Self {
            profile_name: profile_name.into(),
            role_description: role_description.into(),
            assigned_stance: None,
        }
    }

    pub fn with_stance(mut self, stance: impl Into<String>) -> Self {
        self.assigned_stance = Some(stance.into());
        self
    }
}

/// Options for starting a structured debate.
#[derive(Debug, Clone)]
pub struct DebateOptions {
    pub topic: String,
    pub participants: Vec<DebateParticipantConfig>,
    pub max_debate_rounds: u32,
    pub consensus_prompt: Option<String>,
    pub enable_voting: bool,
}

impl DebateOptions {
    pub fn new(topic: impl Into<String>, participants: Vec<DebateParticipantConfig>) -> Self {
        Self {
            topic: topic.into(),
            participants,
            max_debate_rounds: 2,
            consensus_prompt: None,
            enable_voting: false,
        }
    }

    pub fn with_max_rounds(mut self, rounds: u32) -> Self {
        self.max_debate_rounds = rounds;
        self
    }

    pub fn with_consensus(mut self, prompt: impl Into<String>) -> Self {
        self.consensus_prompt = Some(prompt.into());
        self
    }

    pub fn with_voting(mut self) -> Self {
        self.enable_voting = true;
        self
    }
}

/// The result of a completed debate.
#[derive(Debug, Clone)]
pub struct DebateResult {
    pub transcript: Vec<DiscussionEntry>,
    pub phases: Vec<PhaseBreakdownEntry>,
    pub consensus: String,
    pub voting_result: String,
    pub ended_by: String, // "completed" | "cancelled" | "failed"
    pub usage: TokenUsage,
    pub cross_references_count: usize,
    pub position_changes: usize,
}

// ── Coordinator ────────────────────────────────────────────────────────────

/// StructuredDebateCoordinator — orchestrates a structured debate.
pub struct StructuredDebateCoordinator {
    agent_ids: Vec<String>,
    observer: Option<DiscussionObserver>,
    host: Box<dyn DiscussionHostDelegate>,
}

impl StructuredDebateCoordinator {
    pub fn new(host: Box<dyn DiscussionHostDelegate>) -> Self {
        Self {
            agent_ids: Vec::new(),
            observer: None,
            host,
        }
    }

    pub fn set_observer(&mut self, observer: DiscussionObserver) {
        self.observer = Some(observer);
    }

    /// Run a structured debate and return the result.
    pub fn debate(
        &mut self,
        options: &DebateOptions,
    ) -> Result<DebateResult, String> {
        let context = DiscussionContext::new();
        let mut initial_stances: Vec<(String, String)> = Vec::new();
        let mut position_changes = 0usize;

        // 1. Spawn subagents
        for participant in &options.participants {
            let agent_id = self.host.spawn_persistent(
                &participant.profile_name,
                &participant.role_description,
            )?;
            self.agent_ids.push(agent_id);
        }

        let result = (|| -> Result<DebateResult, String> {
            let mut context = DiscussionContext::new();

            // 2. Phase 1: Opening Statements
            context.set_phase(DebatePhase::Opening);
            for (idx, participant) in options.participants.iter().enumerate() {
                let content = self.run_opening_statement(idx, participant, &options.topic)?;
                let agent_id = &self.agent_ids[idx];
                let name = &participant.profile_name;
                context.add_entry(name, agent_id, &content, 1);

                let stance = extract_first_sentence(&content);
                initial_stances.push((name.clone(), stance.clone()));
                let key_points = extract_key_points(&content);
                context.record_position(name, &stance, &key_points, 1);

                self.emit_turn(name, agent_id, 1, &content);
            }

            // 3. Phase 2: Free Debate
            context.set_phase(DebatePhase::FreeDebate);
            let round_offset = 1u32;
            for round in 1..=options.max_debate_rounds {
                let current_round = round_offset + round;
                for (idx, participant) in options.participants.iter().enumerate() {
                    let agent_id = &self.agent_ids[idx];
                    let name = &participant.profile_name;

                    let prompt = self.build_debate_round_prompt(
                        &participant.role_description,
                        &options.topic,
                        name,
                        &context,
                        current_round,
                    );
                    let content = self.host.run_discussion_turn(agent_id, &prompt)?;
                    context.add_entry(name, agent_id, &content, current_round);

                    let new_stance = extract_first_sentence(&content);
                    if let Some(pos) = context.get_position(name) {
                        if new_stance != pos.stance {
                            position_changes += 1;
                        }
                    }
                    context.record_position(
                        name,
                        &new_stance,
                        &extract_key_points(&content),
                        current_round,
                    );
                    self.emit_turn(name, agent_id, current_round, &content);
                }
            }

            // 4. Phase 3: Closing Arguments
            context.set_phase(DebatePhase::Closing);
            let closing_round = round_offset + options.max_debate_rounds + 1;
            for (idx, participant) in options.participants.iter().enumerate() {
                let agent_id = &self.agent_ids[idx];
                let name = &participant.profile_name;

                let prompt = self.build_closing_prompt(
                    &participant.role_description,
                    &options.topic,
                    name,
                    &context,
                    closing_round,
                );
                let content = self.host.run_discussion_turn(agent_id, &prompt)?;
                context.add_entry(name, agent_id, &content, closing_round);

                let final_stance = extract_first_sentence(&content);
                context.record_position(
                    name,
                    &final_stance,
                    &extract_key_points(&content),
                    closing_round,
                );
                self.emit_turn(name, agent_id, closing_round, &content);
            }

            // Count position changes from initial
            let position_changes = initial_stances.iter().filter(|(name, initial)| {
                context.get_position(name).map_or(false, |p| p.stance != *initial)
            }).count();

            // 5. Phase 4: Consensus (optional)
            context.set_phase(DebatePhase::Consensus);
            let consensus = if let Some(ref prompt) = options.consensus_prompt {
                if !context.is_empty() {
                    self.generate_consensus(prompt, &context).unwrap_or_default()
                } else {
                    String::new()
                }
            } else {
                String::new()
            };

            // 6. Voting (optional)
            let voting_result = if options.enable_voting && !context.is_empty() {
                self.run_voting(&options.topic, &context).unwrap_or_default()
            } else {
                String::new()
            };

            let usage = self.collect_usage();
            let phases = context.phase_breakdown();

            Ok(DebateResult {
                transcript: context.all_entries(),
                phases,
                consensus,
                voting_result,
                ended_by: "completed".into(),
                usage,
                cross_references_count: context.all_cross_references().len(),
                position_changes,
            })
        })();

        // Cleanup
        for agent_id in &self.agent_ids {
            self.host.destroy_persistent(agent_id);
        }
        self.agent_ids.clear();

        result
    }

    /// Destroy all subagents (for cleanup in error paths).
    pub fn destroy_all(&mut self) {
        for agent_id in &self.agent_ids {
            self.host.destroy_persistent(agent_id);
        }
        self.agent_ids.clear();
    }

    // ── Private helpers ──

    fn run_opening_statement(
        &self,
        index: usize,
        participant: &DebateParticipantConfig,
        topic: &str,
    ) -> Result<String, String> {
        let agent_id = &self.agent_ids[index];
        let stance_hint = participant.assigned_stance.as_ref()
            .map(|s| format!("\nYour assigned stance: {}", s))
            .unwrap_or_default();

        let prompt = [
            format!("[System] Your role:\n{}", participant.role_description),
            String::new(),
            format!("Debate topic:\n{}", topic),
            String::new(),
            "=== OPENING STATEMENTS ===".into(),
            String::new(),
            "You are delivering your opening statement. Present your initial stance".into(),
            "on the topic clearly. State your position, your key arguments, and what".into(),
            "you believe is the most important consideration.".into(),
            stance_hint,
            String::new(),
            "Be thorough and persuasive — this is your chance to frame the debate.".into(),
        ].join("\n");

        self.host.run_discussion_turn(agent_id, &prompt)
    }

    fn build_debate_round_prompt(
        &self,
        role_description: &str,
        topic: &str,
        _speaker_name: &str,
        context: &DiscussionContext,
        round: u32,
    ) -> String {
        let mut parts: Vec<String> = Vec::new();

        parts.push(format!("[System] Your role:\n{}", role_description));
        parts.push(String::new());
        parts.push(format!("Debate topic:\n{}", topic));
        parts.push(String::new());

        let positions_text = context.positions_text();
        if !positions_text.is_empty() {
            parts.push("=== CURRENT POSITIONS ===".into());
            parts.push(positions_text);
            parts.push(String::new());
        }

        parts.push(format!("=== FREE DEBATE — Round {} ===", round));
        parts.push(String::new());

        let transcript = context.transcript();
        if !transcript.is_empty() {
            parts.push("Full debate transcript so far:".into());
            parts.push(transcript);
            parts.push(String::new());
            parts.push(
                "Respond to what others have said. You may:\n\
                 - Challenge or support specific points made by other participants\n\
                 - Provide counter-arguments or additional evidence\n\
                 - Clarify or refine your position\n\
                 - Point out flaws in opposing arguments\n\
                 \n\
                 Be specific when referring to others — mention their name and which\n\
                 point you are addressing. This is a fast-paced debate round."
                    .into(),
            );
        } else {
            parts.push("Present your arguments on the topic.".into());
        }

        parts.join("\n")
    }

    fn build_closing_prompt(
        &self,
        role_description: &str,
        topic: &str,
        _speaker_name: &str,
        context: &DiscussionContext,
        round: u32,
    ) -> String {
        let positions_text = context.positions_text();
        let cross_ref_text = context.cross_references_text();
        let cross_ref_block = if !cross_ref_text.is_empty() {
            format!("\nCross-references detected:\n{}", cross_ref_text)
        } else {
            String::new()
        };

        [
            format!("[System] Your role:\n{}", role_description),
            String::new(),
            format!("Debate topic:\n{}", topic),
            String::new(),
            "=== CLOSING ARGUMENTS ===".into(),
            String::new(),
            "The debate is concluding. Deliver your closing argument:".into(),
            String::new(),
            "- Summarize your position and key evidence".into(),
            "- Address the strongest counter-arguments raised against your view".into(),
            "- Explain why your position should prevail".into(),
            "- Be concise and impactful".into(),
            String::new(),
            "Current positions:".into(),
            positions_text,
            cross_ref_block,
            String::new(),
            "Full debate transcript:".into(),
            context.transcript(),
        ].join("\n")
    }

    fn generate_consensus(
        &self,
        consensus_prompt: &str,
        context: &DiscussionContext,
    ) -> Result<String, String> {
        let first_id = self.agent_ids.first().ok_or("No agents for consensus")?;

        let positions_block = if !context.all_positions().is_empty() {
            format!(
                "\nFinal positions:\n{}",
                context.all_positions().iter()
                    .map(|p| format!(
                        "[{}] {}\n  Key points: {}",
                        p.speaker, p.stance, p.key_points.join(", ")
                    ))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        } else {
            String::new()
        };

        let refs = context.all_cross_references();
        let agreements = refs.iter().filter(|r| r.stance == CrossRefStance::Agree).count();
        let disagreements = refs.iter().filter(|r| r.stance == CrossRefStance::Disagree).count();

        let prompt = [
            consensus_prompt,
            "",
            "Full debate transcript:",
            &context.transcript(),
            &positions_block,
            "",
            &format!("Agreements detected: {}, Disagreements detected: {}", agreements, disagreements),
            "",
            "Please provide:",
            "1. Points of consensus (what everyone agrees on)",
            "2. Remaining disagreements (where opinions still differ)",
            "3. Key insights and takeaways from the debate",
            "4. Recommended next steps or action items",
        ].join("\n");

        self.host.run_discussion_turn(first_id, &prompt)
    }

    fn run_voting(
        &self,
        topic: &str,
        context: &DiscussionContext,
    ) -> Result<String, String> {
        let positions = context.all_positions();
        let refs = context.all_cross_references();
        let agreements = refs.iter().filter(|r| r.stance == CrossRefStance::Agree).count();
        let disagreements = refs.iter().filter(|r| r.stance == CrossRefStance::Disagree).count();

        let positions_block = if !positions.is_empty() {
            format!(
                "\nPositions:\n{}",
                positions.iter()
                    .map(|p| format!("[{}] {}", p.speaker, p.stance))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        } else {
            String::new()
        };

        let mut votes: Vec<String> = Vec::new();
        for (idx, _agent_id) in self.agent_ids.iter().enumerate() {
            let speaker = positions.get(idx).map(|p| p.speaker.as_str()).unwrap_or("Unknown");
            let prompt = [
                &format!("[System] Your role:\n{}", speaker),
                "",
                &format!("Debate topic:\n{}", topic),
                "",
                "=== VOTING PHASE ===",
                "",
                "Based on the full debate, please vote on the following:",
                "",
                &positions_block,
                "",
                &format!("Agreements detected: {}, Disagreements detected: {}", agreements, disagreements),
                "",
                "Full debate transcript:",
                &context.transcript(),
                "",
                "Please respond with:",
                "1. Your final position on the topic (yes/no/neutral with reasoning)",
                "2. The single most convincing argument from the debate",
                "3. A suggested compromise or path forward",
            ].join("\n");

            match self.host.run_discussion_turn(&self.agent_ids[idx], &prompt) {
                Ok(vote) => votes.push(format!("[{}] {}", speaker, vote)),
                Err(_) => votes.push(format!("[{}] <vote not cast>", speaker)),
            }
        }

        let first_id = self.agent_ids.first().ok_or("No agents for tally")?;
        let tally_prompt = [
            "Tally the votes from this debate and produce a final verdict.",
            "",
            "Topic:",
            topic,
            "",
            "Votes:",
            &votes.join("\n"),
            "",
            "Please provide:",
            "1. Vote count (how many for each position)",
            "2. The majority position",
            "3. Key arguments that swayed the outcome",
            "4. Final recommended decision",
        ].join("\n");

        self.host.run_discussion_turn(first_id, &tally_prompt)
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

    fn emit_turn(&self, role_name: &str, agent_id: &str, round: u32, content: &str) {
        if let Some(ref observer) = self.observer {
            observer(&DiscussionTurnEvent {
                agent_id: agent_id.to_string(),
                role_name: role_name.to_string(),
                round,
                content: content.to_string(),
            });
        }
    }
}

// ── Free functions (shared with TS implementation) ─────────────────────────

/// Extract the first sentence as a stance summary.
fn extract_first_sentence(content: &str) -> String {
    content
        .split(|c: char| c == '.' || c == '!' || c == '?' || c == '\n')
        .filter(|s| !s.trim().is_empty())
        .next()
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// Extract key points from content (bullet points, numbered items, or first sentences).
fn extract_key_points(content: &str) -> Vec<String> {
    let mut points: Vec<String> = Vec::new();

    for line in content.lines() {
        let trimmed = line.trim();
        // Bullet points: - * • or numbered 1. 2) 3.
        if trimmed.starts_with('-')
            || trimmed.starts_with('*')
            || trimmed.starts_with('•')
            || (&trimmed[..2]).chars().all(|c| c.is_ascii_digit())
                && (trimmed[1..].starts_with('.') || trimmed[1..].starts_with(')'))
        {
            let cleaned = trimmed
                .trim_start_matches(|c: char| c == '-' || c == '*' || c == '•' || c.is_ascii_digit())
                .trim_start_matches(|c: char| c == '.' || c == ')' || c.is_whitespace())
                .to_string();
            if !cleaned.is_empty() {
                points.push(cleaned);
            }
        }
    }

    // Fallback: first 3 sentences
    if points.is_empty() {
        let sentences: Vec<&str> = content
            .split(|c: char| c == '.' || c == '!' || c == '?')
            .map(|s| s.trim())
            .filter(|s| s.len() > 10)
            .collect();
        points = sentences.into_iter().take(3).map(|s| s.to_string()).collect();
    }

    points.truncate(5);
    points
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct MockHost {
        counter: std::sync::atomic::AtomicU32,
        agents: std::sync::Mutex<HashMap<String, String>>,
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
        fn spawn_persistent(&self, name: &str, _desc: &str) -> Result<String, String> {
            let id = self.counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let aid = format!("agent-{}", id);
            self.agents.lock().unwrap().insert(aid.clone(), name.to_string());
            self.usage.lock().unwrap().insert(aid.clone(), TokenUsage { input_tokens: 200, output_tokens: 100, ..Default::default() });
            Ok(aid)
        }
        fn run_discussion_turn(&self, aid: &str, _prompt: &str) -> Result<String, String> {
            let agents = self.agents.lock().unwrap();
            let name = agents.get(aid).cloned().unwrap_or_default();
            Ok(format!("{}'s argument: We should proceed with caution.", name))
        }
        fn get_persistent_usage(&self, aid: &str) -> Option<TokenUsage> {
            self.usage.lock().unwrap().get(aid).cloned()
        }
        fn destroy_persistent(&self, aid: &str) {
            self.agents.lock().unwrap().remove(aid);
        }
    }

    #[test]
    fn test_debate_phases() {
        let host = Box::new(MockHost::new());
        let mut coord = StructuredDebateCoordinator::new(host);

        let options = DebateOptions::new(
            "Should we use microservices?",
            vec![
                DebateParticipantConfig::new("pro", "Argue for microservices.").with_stance("Pro microservices"),
                DebateParticipantConfig::new("con", "Argue for monolith.").with_stance("Pro monolith"),
            ],
        ).with_max_rounds(1);

        let result = coord.debate(&options).unwrap();

        assert_eq!(result.ended_by, "completed");
        // 2 opening + 2 debate + 2 closing = 6 entries (with 2 participants, 1 debate round)
        assert!(!result.transcript.is_empty());
        assert!(!result.phases.is_empty());
    }

    #[test]
    fn test_debate_with_voting() {
        let host = Box::new(MockHost::new());
        let mut coord = StructuredDebateCoordinator::new(host);

        let options = DebateOptions::new(
            "Tabs vs spaces",
            vec![
                DebateParticipantConfig::new("tabs", "Argue for tabs."),
                DebateParticipantConfig::new("spaces", "Argue for spaces."),
            ],
        ).with_max_rounds(1).with_voting().with_consensus("Find consensus.");

        let result = coord.debate(&options).unwrap();
        assert_eq!(result.ended_by, "completed");
        assert!(!result.voting_result.is_empty());
        assert!(!result.consensus.is_empty());
    }

    #[test]
    fn test_extract_first_sentence() {
        let s = extract_first_sentence("Rust is the best language. It is fast and safe.");
        assert_eq!(s, "Rust is the best language");
    }

    #[test]
    fn test_extract_key_points_bullets() {
        let content = "Main argument.\n- Point one: speed\n- Point two: safety\n- Point three: ergonomics";
        let points = extract_key_points(content);
        assert!(!points.is_empty());
        assert!(points.iter().any(|p| p.contains("speed")));
    }

    #[test]
    fn test_extract_key_points_fallback() {
        let content = "Rust is memory safe. It is also fast. There is a learning curve.";
        let points = extract_key_points(content);
        assert_eq!(points.len(), 3);
        assert!(points[0].contains("memory safe"));
    }
}