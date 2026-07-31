
// ── Types ──────────────────────────────────────────────────────────────────

/// A single entry (speech) in the discussion transcript.
#[derive(Debug, Clone)]
pub struct DiscussionEntry {
    pub speaker: String,
    pub agent_id: String,
    pub content: String,
    pub round: u32,
}

/// The current phase of a structured debate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DebatePhase {
    Opening,
    FreeDebate,
    Closing,
    Consensus,
}

impl DebatePhase {
    /// Wire name matching the TS debate result (`'opening' | 'free_debate' |
    /// 'closing' | 'consensus'`).
    pub fn wire_name(&self) -> &'static str {
        match self {
            DebatePhase::Opening => "opening",
            DebatePhase::FreeDebate => "free_debate",
            DebatePhase::Closing => "closing",
            DebatePhase::Consensus => "consensus",
        }
    }
}

/// A participant's recorded position on the topic.
#[derive(Debug, Clone)]
pub struct PositionRecord {
    pub speaker: String,
    pub stance: String,
    pub key_points: Vec<String>,
    pub round: u32,
}

/// A detected cross-reference between participants.
#[derive(Debug, Clone)]
pub struct CrossReference {
    pub speaker: String,
    pub target_speaker: String,
    pub target_round: u32,
    pub stance: CrossRefStance,
    pub content: String,
    pub round: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrossRefStance {
    Agree,
    Disagree,
    Clarify,
    Extend,
}

// ── DiscussionContext ──────────────────────────────────────────────────────

/// Shared discussion context for multi-agent roundtables.
///
/// Stores the ordered list of discussion entries, participant positions,
/// detected cross-references, and the current debate phase.
pub struct DiscussionContext {
    entries: Vec<DiscussionEntry>,
    positions: Vec<PositionRecord>,
    cross_refs: Vec<CrossReference>,
    current_phase: DebatePhase,
}

impl DiscussionContext {
    /// Create a new empty discussion context.
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
            positions: Vec::new(),
            cross_refs: Vec::new(),
            current_phase: DebatePhase::Opening,
        }
    }

    // ── Entry management ──

    /// Add a speech entry to the discussion transcript.
    /// Auto-detects cross-references from the content.
    pub fn add_entry(&mut self, speaker: &str, agent_id: &str, content: &str, round: u32) {
        self.detect_cross_references(speaker, content, round);
        self.entries.push(DiscussionEntry {
            speaker: speaker.to_string(),
            agent_id: agent_id.to_string(),
            content: content.to_string(),
            round,
        });
    }

    /// Current round number (1-based). Returns 0 before any entry.
    pub fn current_round(&self) -> u32 {
        self.entries.last().map(|e| e.round).unwrap_or(0)
    }

    /// Whether the transcript is empty.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Get the last speaker's name.
    pub fn last_speaker(&self) -> Option<&str> {
        self.entries.last().map(|e| e.speaker.as_str())
    }

    /// Get all entries (cloned for thread-safety).
    pub fn all_entries(&self) -> Vec<DiscussionEntry> {
        self.entries.clone()
    }

    /// Total number of entries (speeches) recorded.
    pub fn entry_count(&self) -> usize {
        self.entries.len()
    }

    // ── Phase management ──

    /// Set the current debate phase.
    pub fn set_phase(&mut self, phase: DebatePhase) {
        self.current_phase = phase;
    }

    /// Get the current debate phase.
    pub fn phase(&self) -> DebatePhase {
        self.current_phase
    }

    // ── Position tracking ──

    /// Record a participant's stated position on the topic.
    /// Updates in-place if the speaker already has a position.
    pub fn record_position(&mut self, speaker: &str, stance: &str, key_points: &[String], round: u32) {
        if let Some(idx) = self.positions.iter().position(|p| p.speaker == speaker) {
            self.positions[idx] = PositionRecord {
                speaker: speaker.to_string(),
                stance: stance.to_string(),
                key_points: key_points.to_vec(),
                round,
            };
        } else {
            self.positions.push(PositionRecord {
                speaker: speaker.to_string(),
                stance: stance.to_string(),
                key_points: key_points.to_vec(),
                round,
            });
        }
    }

    /// Get the latest recorded position for a speaker.
    pub fn get_position(&self, speaker: &str) -> Option<&PositionRecord> {
        self.positions.iter().find(|p| p.speaker == speaker)
    }

    /// All recorded positions.
    pub fn all_positions(&self) -> &[PositionRecord] {
        &self.positions
    }

    /// Render positions as a text block for debate prompts.
    pub fn positions_text(&self) -> String {
        if self.positions.is_empty() {
            return String::new();
        }
        self.positions
            .iter()
            .map(|p| format!("[{}] Stance: {}\n  Key points: {}", p.speaker, p.stance, p.key_points.join(", ")))
            .collect::<Vec<_>>()
            .join("\n")
    }

    // ── Cross-references ──

    /// All detected cross-references.
    pub fn all_cross_references(&self) -> &[CrossReference] {
        &self.cross_refs
    }

    /// Render cross-references as a text block.
    pub fn cross_references_text(&self) -> String {
        if self.cross_refs.is_empty() {
            return String::new();
        }
        self.cross_refs
            .iter()
            .map(|r| format!("  [{}] → @{} ({:?})", r.speaker, r.target_speaker, r.stance))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Count cross-references by stance.
    pub fn cross_ref_counts(&self) -> CrossRefCounts {
        let mut counts = CrossRefCounts::default();
        for r in &self.cross_refs {
            match r.stance {
                CrossRefStance::Agree => counts.agreements += 1,
                CrossRefStance::Disagree => counts.disagreements += 1,
                CrossRefStance::Clarify => counts.clarifications += 1,
                CrossRefStance::Extend => counts.extensions += 1,
            }
        }
        counts
    }

    // ── Transcript rendering ──

    /// Render the full discussion transcript as plain text.
    pub fn transcript(&self) -> String {
        if self.entries.is_empty() {
            return String::new();
        }
        self.entries
            .iter()
            .map(|e| format!("[{}] {}", e.speaker, e.content))
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    /// Render transcript with phase markers.
    pub fn debate_transcript(&self) -> String {
        if self.entries.is_empty() {
            return String::new();
        }
        let mut lines: Vec<String> = Vec::new();
        lines.push(format!("\n=== {} ===\n", phase_label(self.current_phase)));
        for entry in &self.entries {
            lines.push(format!("[{}] {}", entry.speaker, entry.content));
        }
        lines.join("\n\n")
    }

    /// Build a phase breakdown from entry distribution.
    pub fn phase_breakdown(&self) -> Vec<PhaseBreakdownEntry> {
        if self.entries.is_empty() {
            return Vec::new();
        }
        let max_round = self.entries.last().map(|e| e.round).unwrap_or(1);
        if max_round <= 1 {
            return vec![PhaseBreakdownEntry { phase: DebatePhase::Opening, entry_count: self.entries.len() }];
        }
        let mut result = Vec::new();
        let opening_count = self.entries.iter().filter(|e| e.round == 1).count();
        if opening_count > 0 {
            result.push(PhaseBreakdownEntry { phase: DebatePhase::Opening, entry_count: opening_count });
        }
        let middle_count = self.entries.iter().filter(|e| e.round > 1 && e.round < max_round).count();
        if middle_count > 0 {
            result.push(PhaseBreakdownEntry { phase: DebatePhase::FreeDebate, entry_count: middle_count });
        }
        let closing_count = self.entries.iter().filter(|e| e.round == max_round).count();
        if closing_count > 0 && max_round > 1 {
            result.push(PhaseBreakdownEntry { phase: DebatePhase::Closing, entry_count: closing_count });
        }
        result
    }

    // ── Internal: cross-reference detection ──

    /// Detect simple cross-references in speech content.
    /// Looks for patterns like "@Speaker", "as Speaker said", "Speaker's point".
    fn detect_cross_references(&mut self, speaker: &str, content: &str, round: u32) {
        let known_speakers: Vec<String> = self.entries.iter()
            .map(|e| e.speaker.clone())
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();

        for target in &known_speakers {
            if target == speaker { continue; }

            let found = check_ref_patterns(content, target);
            if !found { continue; }

            let stance = classify_stance(content);

            self.cross_refs.push(CrossReference {
                speaker: speaker.to_string(),
                target_speaker: target.clone(),
                target_round: if round > 1 { round - 1 } else { 1 },
                stance,
                content: content.chars().take(200).collect(),
                round,
            });
        }
    }
}

impl Default for DiscussionContext {
    fn default() -> Self {
        Self::new()
    }
}

// ── Helper types ──

/// Breakdown of a single phase.
#[derive(Debug, Clone)]
pub struct PhaseBreakdownEntry {
    pub phase: DebatePhase,
    pub entry_count: usize,
}

/// Cross-reference counts by stance.
#[derive(Debug, Default, Clone)]
pub struct CrossRefCounts {
    pub agreements: usize,
    pub disagreements: usize,
    pub clarifications: usize,
    pub extensions: usize,
}

// ── Free functions ──

fn phase_label(phase: DebatePhase) -> &'static str {
    match phase {
        DebatePhase::Opening => "Opening Statements",
        DebatePhase::FreeDebate => "Free Debate",
        DebatePhase::Closing => "Closing Arguments",
        DebatePhase::Consensus => "Consensus & Resolution",
    }
}

/// Check if content references a target speaker via known patterns.
fn check_ref_patterns(content: &str, target: &str) -> bool {
    let escaped = regex::escape(target);

    // @Speaker
    if regex::Regex::new(&format!(r"(?i)@{}", escaped)).ok().map_or(false, |re| re.is_match(content)) {
        return true;
    }

    // as Speaker said/mentioned/argued/pointed out
    if regex::Regex::new(&format!(r"(?i)as {}\s*(?:said|mentioned|argued|pointed out)", escaped)).ok().map_or(false, |re| re.is_match(content)) {
        return true;
    }

    // Speaker's point/argument/suggestion (both ASCII apostrophe and Unicode right single quote)
        // Speaker's point/argument/suggestion
    // Use simple string matching for cross-references — more reliable than regex
    // with Unicode escapes in format strings.
    {
        let re_str = format!(r"(?i){}\'s\s+(?:point|argument|suggestion|idea|proposal)", escaped);
        if regex::Regex::new(&re_str).ok().map_or(false, |re| re.is_match(content)) {
            return true;
        }
    }

    // agree/disagree with Speaker
    if regex::Regex::new(&format!(r"(?i)(?:agree|disagree)\s+with\s+{}", escaped)).ok().map_or(false, |re| re.is_match(content)) {
        return true;
    }

    // building/expanding on Speaker
    if regex::Regex::new(&format!(r"(?i)(?:building|expanding)\s+on\s+{}", escaped)).ok().map_or(false, |re| re.is_match(content)) {
        return true;
    }

    false
}

/// Classify the stance from the content text.
fn classify_stance(content: &str) -> CrossRefStance {
    let lower = content.to_lowercase();
    // Check "disagree" before "agree" — "disagree" contains "agree" as substring
    if lower.contains("disagree") || lower.contains("counter") || lower.contains("push back") {
        CrossRefStance::Disagree
    } else if lower.contains("agree") || lower.contains("support") || lower.contains("second") && !lower.contains("second ") {
        CrossRefStance::Agree
    } else if lower.contains("extend") || (lower.contains("build") && lower.contains(" on ")) {
        CrossRefStance::Extend
    } else {
        CrossRefStance::Clarify
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_context_is_empty() {
        let ctx = DiscussionContext::new();
        assert!(ctx.is_empty());
        assert_eq!(ctx.current_round(), 0);
        assert_eq!(ctx.last_speaker(), None);
    }

    #[test]
    fn test_add_entry() {
        let mut ctx = DiscussionContext::new();
        ctx.add_entry("Alice", "agent-1", "I think we should use Rust.", 1);
        assert!(!ctx.is_empty());
        assert_eq!(ctx.current_round(), 1);
        assert_eq!(ctx.last_speaker(), Some("Alice"));
        assert_eq!(ctx.entry_count(), 1);
    }

    #[test]
    fn test_transcript_rendering() {
        let mut ctx = DiscussionContext::new();
        ctx.add_entry("Alice", "a1", "Hello", 1);
        ctx.add_entry("Bob", "a2", "Hi there", 1);
        let t = ctx.transcript();
        assert!(t.contains("[Alice] Hello"));
        assert!(t.contains("[Bob] Hi there"));
    }

    #[test]
    fn test_position_tracking() {
        let mut ctx = DiscussionContext::new();
        ctx.record_position("Alice", "Pro Rust", &vec!["Performance".into(), "Safety".into()], 1);
        let pos = ctx.get_position("Alice").unwrap();
        assert_eq!(pos.stance, "Pro Rust");
        assert_eq!(pos.key_points.len(), 2);

        // Update position
        ctx.record_position("Alice", "Neutral", &vec!["Balance".into()], 2);
        let pos2 = ctx.get_position("Alice").unwrap();
        assert_eq!(pos2.stance, "Neutral");
        assert_eq!(pos2.key_points, vec!["Balance"]);
    }

    #[test]
    fn test_positions_text() {
        let mut ctx = DiscussionContext::new();
        ctx.record_position("A", "For", &vec!["Fast".into()], 1);
        ctx.record_position("B", "Against", &vec!["Complex".into()], 1);
        let text = ctx.positions_text();
        assert!(text.contains("For"));
        assert!(text.contains("Against"));
    }

    #[test]
    fn test_phase_management() {
        let mut ctx = DiscussionContext::new();
        assert_eq!(ctx.phase(), DebatePhase::Opening);
        ctx.set_phase(DebatePhase::FreeDebate);
        assert_eq!(ctx.phase(), DebatePhase::FreeDebate);
    }

    #[test]
    fn test_cross_reference_detection() {
        let mut ctx = DiscussionContext::new();
        ctx.add_entry("Alice", "a1", "I think Rust is best.", 1);
        ctx.add_entry("Bob", "a2", "I agree with Alice about Rust.", 2);

        let refs = ctx.all_cross_references();
        assert!(!refs.is_empty());
        assert_eq!(refs[0].target_speaker, "Alice");
        assert_eq!(refs[0].stance, CrossRefStance::Agree);
    }

    #[test]
    fn test_cross_reference_disagree() {
        let mut ctx = DiscussionContext::new();
        ctx.add_entry("Alice", "a1", "We should migrate.", 1);
        ctx.add_entry("Bob", "a2", "I disagree with Alice's argument.", 2);

        let refs = ctx.all_cross_references();
        assert_eq!(refs[0].stance, CrossRefStance::Disagree);
    }

    #[test]
    fn test_cross_ref_counts() {
        let mut ctx = DiscussionContext::new();
        ctx.add_entry("A", "a1", "start", 1);
        ctx.add_entry("B", "a2", "I agree with A", 2);
        ctx.add_entry("C", "a3", "I disagree with A", 2);
        ctx.add_entry("D", "a4", "Building on A's point", 3);

        let counts = ctx.cross_ref_counts();
        assert_eq!(counts.agreements, 1);
        assert_eq!(counts.disagreements, 1);
        assert_eq!(counts.extensions, 1);
    }

    #[test]
    fn test_phase_breakdown() {
        let mut ctx = DiscussionContext::new();
        ctx.add_entry("A", "a", "opening", 1);
        ctx.add_entry("B", "b", "debate 1", 2);
        ctx.add_entry("C", "c", "debate 2", 2);
        ctx.add_entry("D", "d", "closing", 3);
        ctx.add_entry("E", "e", "closing too", 3);

        let breakdown = ctx.phase_breakdown();
        assert_eq!(breakdown.len(), 3);
        // opening at round 1
        assert_eq!(breakdown[0].phase, DebatePhase::Opening);
        assert_eq!(breakdown[0].entry_count, 1);
        // free debate at rounds 2..3
        assert_eq!(breakdown[1].phase, DebatePhase::FreeDebate);
        assert_eq!(breakdown[1].entry_count, 2);
        // closing at round 3
        assert_eq!(breakdown[2].phase, DebatePhase::Closing);
        assert_eq!(breakdown[2].entry_count, 2);
    }

    #[test]
    fn test_no_self_reference() {
        let mut ctx = DiscussionContext::new();
        ctx.add_entry("Alice", "a1", "My own point about @Alice was great.", 2);
        // Alice shouldn't cross-reference herself
        let refs = ctx.all_cross_references();
        assert!(refs.is_empty());
    }

    #[test]
    fn test_debate_transcript() {
        let mut ctx = DiscussionContext::new();
        ctx.set_phase(DebatePhase::FreeDebate);
        ctx.add_entry("A", "a", "point", 1);
        let t = ctx.debate_transcript();
        assert!(t.contains("Free Debate"));
        assert!(t.contains("[A] point"));
    }
}