/// `knowledge` learner — detecting user corrections worth remembering.
///
/// Faithful port of
/// `packages/agent-core-v2/src/agent/knowledge/knowledgeLearner.ts`.
///
/// At each turn end the learner scans recent user messages for correction
/// signals ("不对，应该…", "should use X", "记住：…"), and turns the first
/// match into a *pending* knowledge entry: `source = ai-learned`,
/// `confidence = 0.7`, never auto-confirmed — it stays out of search results
/// and injection until a human (or the model via the Knowledge tool) confirms
/// it. A fingerprint set keeps the same correction from re-inserting while it
/// is still inside the lookback window.
use std::collections::HashSet;

use regex::Regex;
use std::sync::OnceLock;

use crate::context::types::{ContentPart, ContextMessage};
use crate::knowledge::KnowledgeAddInput;

/// Minimum title length for a correction to be meaningful.
pub const MIN_CORRECTION_LEN: usize = 5;
/// How many trailing messages to scan at turn end.
pub const LOOKBACK_MESSAGES: usize = 5;
/// Confidence assigned to AI-learned entries.
pub const AI_LEARNED_CONFIDENCE: f64 = 0.7;

fn correction_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            r"不对[，,]?\s*应该",
            r"错了[，,]?\s*是",
            r"应该用\s+\S+\s*(?:而不是|不是)",
            r"用\s*\S+\s*不要用",
            r"别用\s*\S+\s*[,，]?\s*用",
            r"(?i)must use\s+\S+",
            r"(?i)should use\s+\S+",
            r"(?i)don't use\s+\S+",
            r"(?i)do not use\s+\S+",
            r"记住[：:]\s*\S",
            r"规范是[：:]?\s*\S",
            r"标准是[：:]?\s*\S",
            r"约定是[：:]?\s*\S",
        ]
        .iter()
        .map(|pattern| Regex::new(pattern).expect("static pattern compiles"))
        .collect()
    })
}

/// Whether a user message reads as a correction.
pub fn is_correction(text: &str) -> bool {
    correction_patterns().iter().any(|pattern| pattern.is_match(text))
}

/// Scan the lookback window for the correction to learn this turn.
///
/// Newest-first, user messages only, first matching text part wins — the TS
/// loop returns after the first hit, so at most one entry per turn.
pub fn detect_correction(history: &[ContextMessage]) -> Option<&str> {
    let start = history.len().saturating_sub(LOOKBACK_MESSAGES);
    for message in history[start..].iter().rev() {
        if message.role != "user" {
            continue;
        }
        for part in &message.content {
            let ContentPart::Text { text } = part else { continue };
            if text.is_empty() {
                continue;
            }
            if is_correction(text) {
                return Some(text);
            }
        }
    }
    None
}

/// The category the correction most plausibly belongs to.
///
/// Else-if chain — first match wins: workflow, then architecture, then
/// coding-style, defaulting to pitfall.
pub fn categorize_correction(text: &str) -> &'static str {
    static WORKFLOW: OnceLock<Regex> = OnceLock::new();
    static ARCHITECTURE: OnceLock<Regex> = OnceLock::new();
    static STYLE: OnceLock<Regex> = OnceLock::new();
    let workflow =
        WORKFLOW.get_or_init(|| Regex::new(r"(?i)流程|提交|commit|push|workflow").unwrap());
    let architecture =
        ARCHITECTURE.get_or_init(|| Regex::new(r"(?i)架构|设计|依赖|architecture").unwrap());
    let style = STYLE.get_or_init(|| Regex::new(r"(?i)import|命名|格式|style|naming").unwrap());

    if workflow.is_match(text) {
        "workflow"
    } else if architecture.is_match(text) {
        "architecture"
    } else if style.is_match(text) {
        "coding-style"
    } else {
        "pitfall"
    }
}

/// Tags mined from the correction text.
pub fn correction_tags(text: &str) -> Vec<String> {
    static TS: OnceLock<Regex> = OnceLock::new();
    static RUST: OnceLock<Regex> = OnceLock::new();
    static IMPORT: OnceLock<Regex> = OnceLock::new();
    static GIT: OnceLock<Regex> = OnceLock::new();
    let mut tags = Vec::new();
    if TS.get_or_init(|| Regex::new(r"(?i)typescript|\.ts").unwrap()).is_match(text) {
        tags.push("typescript".to_string());
    }
    if RUST.get_or_init(|| Regex::new(r"(?i)rust|\.rs").unwrap()).is_match(text) {
        tags.push("rust".to_string());
    }
    if IMPORT.get_or_init(|| Regex::new(r"(?i)import").unwrap()).is_match(text) {
        tags.push("import".to_string());
    }
    if GIT.get_or_init(|| Regex::new(r"(?i)git|commit|push").unwrap()).is_match(text) {
        tags.push("git".to_string());
    }
    tags
}

/// The title: first 60 code points, newlines flattened, trimmed.
pub fn correction_title(text: &str) -> String {
    text.chars()
        .take(60)
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect::<String>()
        .trim()
        .to_string()
}

/// JS's `simpleHash`: `h = (Math.imul(31, h) + charCodeAt(i)) | 0`, rendered
/// base-36 with a sign — reproduced over UTF-16 code units so fingerprints
/// agree with entries the TS learner already recorded.
pub fn simple_hash(text: &str) -> String {
    let mut hash: i32 = 0;
    for unit in text.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(unit as i32);
    }
    to_base36(hash)
}

fn to_base36(value: i32) -> String {
    if value == 0 {
        return "0".to_string();
    }
    let negative = value < 0;
    let mut magnitude = (value as i64).unsigned_abs();
    let mut digits = Vec::new();
    while magnitude > 0 {
        let digit = (magnitude % 36) as u32;
        digits.push(char::from_digit(digit, 36).expect("digit < 36"));
        magnitude /= 36;
    }
    if negative {
        digits.push('-');
    }
    digits.iter().rev().collect()
}

/// The learner's per-agent state: fingerprints already learned.
#[derive(Debug, Default)]
pub struct KnowledgeLearner {
    learned_hashes: HashSet<String>,
}

impl KnowledgeLearner {
    pub fn new() -> Self {
        Self::default()
    }

    /// Turn-end hook: the entry to insert, if this turn taught us anything.
    ///
    /// Returns `None` when no correction was found, the correction was already
    /// learned, or its title is too short to mean anything.
    pub fn on_turn_ended(&mut self, history: &[ContextMessage]) -> Option<KnowledgeAddInput> {
        let text = detect_correction(history)?;
        self.learn_from_correction(text)
    }

    /// Build the pending entry for a correction, deduplicating by fingerprint.
    pub fn learn_from_correction(&mut self, text: &str) -> Option<KnowledgeAddInput> {
        let hash = simple_hash(text);
        if self.learned_hashes.contains(&hash) {
            return None;
        }
        let title = correction_title(text);
        if title.chars().count() < MIN_CORRECTION_LEN {
            return None;
        }
        let input = KnowledgeAddInput {
            content: text.to_string(),
            category: Some(categorize_correction(text).to_string()),
            title: Some(title),
            tags: correction_tags(text),
            scope: None,
            confidence: Some(AI_LEARNED_CONFIDENCE),
            source: Some("ai-learned".to_string()),
        };
        self.learned_hashes.insert(hash);
        Some(input)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::types::MessageOrigin;

    fn user(text: &str) -> ContextMessage {
        ContextMessage {
            role: "user".to_string(),
            content: vec![ContentPart::Text { text: text.to_string() }],
            origin: Some(MessageOrigin::User),
            ..Default::default()
        }
    }

    fn assistant(text: &str) -> ContextMessage {
        ContextMessage {
            role: "assistant".to_string(),
            content: vec![ContentPart::Text { text: text.to_string() }],
            ..Default::default()
        }
    }

    // ── correction detection ──────────────────────────────────────────────

    #[test]
    fn chinese_correction_patterns_match() {
        assert!(is_correction("不对，应该用 pnpm"));
        assert!(is_correction("错了，是 tokio 不是 async-std"));
        assert!(is_correction("应该用 const 而不是 let"));
        assert!(is_correction("用 oxlint 不要用 eslint"));
        assert!(is_correction("别用 npm，用 pnpm"));
        assert!(is_correction("记住：提交前先跑测试"));
        assert!(is_correction("规范是：文件不超过800行"));
    }

    #[test]
    fn english_correction_patterns_match_case_insensitively() {
        assert!(is_correction("you MUST USE pnpm here"));
        assert!(is_correction("should use tabs"));
        assert!(is_correction("don't use any"));
        assert!(is_correction("Do Not Use var"));
    }

    #[test]
    fn ordinary_messages_are_not_corrections() {
        assert!(!is_correction("please refactor this module"));
        assert!(!is_correction("应该没问题"), "应该 alone is not 应该用…不是");
        assert!(!is_correction("what should I use?"));
    }

    #[test]
    fn detection_scans_only_the_lookback_window() {
        let mut history = vec![user("记住：老的纠正")];
        for i in 0..LOOKBACK_MESSAGES {
            history.push(assistant(&format!("filler {i}")));
        }
        assert_eq!(detect_correction(&history), None, "the correction scrolled out");

        history.push(user("记住：新的纠正"));
        assert_eq!(detect_correction(&history), Some("记住：新的纠正"));
    }

    #[test]
    fn detection_prefers_the_newest_correction() {
        let history = vec![user("记住：第一条规则"), user("记住：第二条规则")];
        assert_eq!(detect_correction(&history), Some("记住：第二条规则"));
    }

    #[test]
    fn assistant_messages_never_match() {
        let history = vec![assistant("记住：我自己说的")];
        assert_eq!(detect_correction(&history), None);
    }

    // ── categorisation ────────────────────────────────────────────────────

    #[test]
    fn categories_resolve_first_match_wins() {
        assert_eq!(categorize_correction("记住：提交前跑测试"), "workflow");
        assert_eq!(categorize_correction("记住：架构上不要循环依赖"), "architecture");
        assert_eq!(categorize_correction("记住：import 顺序按字母"), "coding-style");
        assert_eq!(categorize_correction("记住：这个 API 有坑"), "pitfall");
    }

    #[test]
    fn workflow_outranks_style_when_both_match() {
        // "commit" (workflow) and "格式" (style) both present → workflow wins.
        assert_eq!(categorize_correction("记住：commit 信息格式要规范"), "workflow");
    }

    // ── tags ──────────────────────────────────────────────────────────────

    #[test]
    fn tags_mine_the_correction_text() {
        assert_eq!(
            correction_tags("记住：typescript 里 import 顺序,git 提交前检查 .rs 文件"),
            vec!["typescript", "rust", "import", "git"]
        );
        assert!(correction_tags("记住：别的").is_empty());
    }

    // ── title ─────────────────────────────────────────────────────────────

    #[test]
    fn the_title_is_sixty_code_points_flattened() {
        let long = "记".repeat(80);
        let title = correction_title(&long);
        assert_eq!(title.chars().count(), 60);

        assert_eq!(correction_title("line one\nline two"), "line one line two");
        assert_eq!(correction_title("  padded  "), "padded");
    }

    // ── hash ──────────────────────────────────────────────────────────────

    #[test]
    fn the_hash_reproduces_js_semantics() {
        // Manually verified against the TS implementation:
        // "abc" → h = ((0*31+97)*31+98)*31+99 = 96354 → base36 "22ci".
        assert_eq!(simple_hash("abc"), "22ci");
        assert_eq!(simple_hash(""), "0");
    }

    #[test]
    fn the_hash_uses_utf16_units_and_can_go_negative() {
        // A long CJK string overflows i32 and JS renders the sign.
        let hash = simple_hash(&"记住测试".repeat(10));
        assert!(!hash.is_empty());
        // Distinct strings, distinct hashes (not a strong guarantee, but the
        // learner only needs practical dedup).
        assert_ne!(simple_hash("aaa"), simple_hash("aab"));
    }

    // ── learner ───────────────────────────────────────────────────────────

    #[test]
    fn a_correction_becomes_a_pending_entry() {
        let mut learner = KnowledgeLearner::new();
        let history = vec![user("记住：typescript 里不要用 any")];
        let entry = learner.on_turn_ended(&history).expect("learned");
        assert_eq!(entry.source.as_deref(), Some("ai-learned"));
        assert_eq!(entry.confidence, Some(AI_LEARNED_CONFIDENCE));
        assert_eq!(entry.category.as_deref(), Some("pitfall"));
        assert!(entry.tags.contains(&"typescript".to_string()));
        assert_eq!(entry.content, "记住：typescript 里不要用 any");
        assert!(entry.title.is_some());
    }

    #[test]
    fn the_same_correction_is_learned_once() {
        let mut learner = KnowledgeLearner::new();
        let history = vec![user("记住：不要用 any")];
        assert!(learner.on_turn_ended(&history).is_some());
        assert!(learner.on_turn_ended(&history).is_none(), "fingerprinted");
    }

    #[test]
    fn a_turn_without_corrections_learns_nothing() {
        let mut learner = KnowledgeLearner::new();
        assert!(learner.on_turn_ended(&[user("just chatting")]).is_none());
        assert!(learner.on_turn_ended(&[]).is_none());
    }

    #[test]
    fn a_too_short_correction_is_dropped() {
        let mut learner = KnowledgeLearner::new();
        // Matches the pattern but the trimmed title is under five code points.
        assert!(learner.learn_from_correction("记住：a").is_none());
    }
}
