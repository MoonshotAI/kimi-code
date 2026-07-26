/// `knowledge` injection — signal extraction and reminder formatting.
///
/// Faithful port of
/// `packages/agent-core-v2/src/agent/knowledge/knowledgeInjection.ts`.
///
/// On each new turn the injector derives a search query from the last user
/// message and, when anything relevant is found, injects a bounded reminder.
/// Tokenisation handles both English (whitespace identifiers) and CJK
/// (2-grams): FTS5's tokenizer never matches a whole Chinese sentence as one
/// term, so without the bigram split Chinese queries would never hit the
/// index.
use std::collections::HashSet;

use crate::context::types::{ContentPart, ContextMessage};

pub const MAX_INJECTION_TOKENS: u64 = 800;
pub const MAX_INJECTION_ENTRIES: usize = 5;

/// The signals mined from the last user message.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct KnowledgeSignals {
    pub query: String,
    pub scope_path: Option<String>,
    pub tags: Vec<String>,
}

impl KnowledgeSignals {
    /// TS gates injection on `!signals.query && !signals.scopePath`.
    pub fn is_empty(&self) -> bool {
        self.query.is_empty() && self.scope_path.is_none()
    }
}

fn is_cjk(c: char) -> bool {
    ('\u{4e00}'..='\u{9fa5}').contains(&c)
}

fn is_ascii_identifier(segment: &str) -> bool {
    let mut chars = segment.chars();
    let Some(first) = chars.next() else { return false };
    if !(first.is_ascii_alphabetic() || first == '_') {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// The last user message's text, scanned backwards (TS takes the first text
/// part of the newest user message).
pub fn last_user_text(history: &[ContextMessage]) -> Option<&str> {
    for message in history.iter().rev() {
        if message.role != "user" {
            continue;
        }
        for part in &message.content {
            if let ContentPart::Text { text } = part {
                if !text.is_empty() {
                    return Some(text);
                }
            }
        }
    }
    None
}

/// Mine query keywords, a scope path, and tags from a user message.
pub fn extract_signals(last_user_text: &str) -> KnowledgeSignals {
    let mut keywords: Vec<String> = Vec::new();

    // First 200 *code points*, quoting/bracket characters neutralised.
    let cleaned: String = last_user_text
        .chars()
        .take(200)
        .map(|c| if matches!(c, '`' | '"' | '\'' | '(' | ')' | '[' | ']' | '{' | '}') { ' ' } else { c })
        .collect();

    for segment in cleaned.split_whitespace() {
        if is_ascii_identifier(segment) && segment.chars().count() > 2 {
            keywords.push(segment.to_string());
            continue;
        }
        if segment.chars().any(is_cjk) {
            let cjk_chars: Vec<char> = segment.chars().filter(|c| is_cjk(*c)).collect();
            if cjk_chars.len() == 1 {
                keywords.push(cjk_chars[0].to_string());
            } else {
                for pair in cjk_chars.windows(2) {
                    keywords.push(pair.iter().collect());
                }
            }
            // ASCII sub-tokens inside the segment (e.g. "const" in "应该用const").
            keywords.extend(ascii_subtokens(segment));
        }
    }
    let query = keywords.into_iter().take(12).collect::<Vec<_>>().join(" ");

    // Scope: the directory portion of the first mentioned source path.
    let scope_path = first_source_path(last_user_text).map(|full_path| {
        match full_path.rfind(['/', '\\']) {
            Some(last_sep) => full_path[..last_sep].to_string(),
            None => full_path,
        }
    });

    // Tags from mentioned extensions / topics.
    let mut tags: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    let mut push_tag = |tag: &str, tags: &mut Vec<String>| {
        if seen.insert(tag.to_string()) {
            tags.push(tag.to_string());
        }
    };
    if last_user_text.contains(".ts") || last_user_text.contains("typescript") {
        push_tag("typescript", &mut tags);
    }
    if last_user_text.contains(".rs") || last_user_text.contains("rust") {
        push_tag("rust", &mut tags);
    }
    if last_user_text.contains("test") {
        push_tag("testing", &mut tags);
    }
    if last_user_text.contains("import") {
        push_tag("import", &mut tags);
    }

    KnowledgeSignals { query, scope_path, tags }
}

/// TS: `/[a-zA-Z_][\w-]{2,}/g` — identifiers of length ≥ 3 inside a segment.
fn ascii_subtokens(segment: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = segment.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_alphabetic() || chars[i] == '_' {
            let start = i;
            i += 1;
            while i < chars.len()
                && (chars[i].is_ascii_alphanumeric() || chars[i] == '_' || chars[i] == '-')
            {
                i += 1;
            }
            if i - start >= 3 {
                tokens.push(chars[start..i].iter().collect());
            }
        } else {
            i += 1;
        }
    }
    tokens
}

/// TS: `/([\w./\\-]+)\.(?:ts|js|rs|vue|tsx|jsx|json|md)/` — the first
/// source-file mention, extension included.
fn first_source_path(text: &str) -> Option<String> {
    const EXTENSIONS: [&str; 8] = ["tsx", "jsx", "json", "vue", "md", "ts", "js", "rs"];
    let chars: Vec<char> = text.chars().collect();
    let is_path_char =
        |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '\\' | '-');

    let mut i = 0;
    while i < chars.len() {
        if !is_path_char(chars[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && is_path_char(chars[i]) {
            i += 1;
        }
        let candidate: String = chars[start..i].iter().collect();
        // The run must end with `.<ext>` and carry a non-empty stem, and the
        // TS regex scans inside the run too (e.g. trailing punctuation), so
        // check every suffix cut at a dot.
        if let Some(found) = path_within(&candidate, &EXTENSIONS) {
            return Some(found);
        }
    }
    None
}

fn path_within(candidate: &str, extensions: &[&str]) -> Option<String> {
    // Find the earliest `.<ext>` boundary with at least one path char before it.
    let bytes = candidate.as_bytes();
    for (index, _) in candidate.char_indices() {
        if bytes[index] != b'.' {
            continue;
        }
        for ext in extensions {
            let end = index + 1 + ext.len();
            if end <= candidate.len()
                && candidate[index + 1..end].eq_ignore_ascii_case(ext)
                && index > 0
                && (end == candidate.len() || !candidate.as_bytes()[end].is_ascii_alphanumeric())
            {
                return Some(candidate[..end].to_string());
            }
        }
    }
    None
}

/// One search hit, projected for formatting.
#[derive(Debug, Clone)]
pub struct InjectionEntry {
    pub category: String,
    pub title: String,
    pub content: String,
}

/// Render the `[Knowledge Base — Relevant Standards]` reminder.
///
/// Entries are numbered and truncated to their first content line; the token
/// budget uses the CJK-aware estimate (~1.5 chars/token CJK, ~4 ASCII) and
/// stops before overflowing [`MAX_INJECTION_TOKENS`].
pub fn format_injection(results: &[InjectionEntry]) -> String {
    let mut lines: Vec<String> =
        vec!["[Knowledge Base — Relevant Standards]".to_string(), String::new()];
    let mut tokens_used: u64 = 10;

    for (index, entry) in results.iter().enumerate() {
        let first_line = entry.content.lines().next().unwrap_or("");
        let line = format!("{}. [{}] {}\n   {}", index + 1, entry.category, entry.title, first_line);
        let cjk_count = line.chars().filter(|c| is_cjk(*c)).count() as f64;
        let other_count = line.chars().count() as f64 - cjk_count;
        let line_tokens = (cjk_count / 1.5 + other_count / 4.0).ceil() as u64;
        if tokens_used + line_tokens > MAX_INJECTION_TOKENS {
            break;
        }
        lines.push(line);
        lines.push(String::new());
        tokens_used += line_tokens;
    }

    lines.join("\n")
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

    // ── last_user_text ────────────────────────────────────────────────────

    #[test]
    fn finds_the_newest_user_message() {
        let history = vec![user("first"), assistant("reply"), user("second")];
        assert_eq!(last_user_text(&history), Some("second"));
    }

    #[test]
    fn skips_empty_and_non_user_messages() {
        let history = vec![user("real"), assistant("reply")];
        assert_eq!(last_user_text(&history), Some("real"));
        assert_eq!(last_user_text(&[assistant("only")]), None);
        assert_eq!(last_user_text(&[]), None);
    }

    // ── extract_signals: English ──────────────────────────────────────────

    #[test]
    fn english_identifiers_become_keywords() {
        let signals = extract_signals("please refactor the userService module");
        assert_eq!(signals.query, "please refactor the userService module");
    }

    #[test]
    fn short_and_non_identifier_segments_are_dropped() {
        let signals = extract_signals("do it 42 ok fix-this");
        // "do"/"it"/"ok" too short, "42" not an identifier; "fix-this" passes.
        assert_eq!(signals.query, "fix-this");
    }

    #[test]
    fn quoting_characters_are_neutralised() {
        let signals = extract_signals("use `const` and \"readonly\" (always)");
        assert_eq!(signals.query, "use const and readonly always");
    }

    #[test]
    fn keywords_are_capped_at_twelve() {
        let text = (0..20).map(|i| format!("keyword{i}")).collect::<Vec<_>>().join(" ");
        let signals = extract_signals(&text);
        assert_eq!(signals.query.split(' ').count(), 12);
    }

    // ── extract_signals: CJK ──────────────────────────────────────────────

    #[test]
    fn cjk_text_becomes_bigrams() {
        // Regression guard for the M4 fix: a whole Chinese sentence must not
        // be one opaque token that the FTS sanitiser then strips to nothing.
        let signals = extract_signals("用驼峰命名");
        assert_eq!(signals.query, "用驼 驼峰 峰命 命名");
    }

    #[test]
    fn a_single_cjk_char_survives_alone() {
        let signals = extract_signals("好");
        assert_eq!(signals.query, "好");
    }

    #[test]
    fn ascii_subtokens_inside_cjk_segments_are_kept() {
        let signals = extract_signals("应该用const命名");
        assert!(signals.query.contains("const"), "{}", signals.query);
        assert!(signals.query.contains("应该"), "{}", signals.query);
    }

    // ── extract_signals: scope ────────────────────────────────────────────

    #[test]
    fn a_file_mention_yields_its_directory_as_scope() {
        let signals = extract_signals("fix the bug in src/agent/loop.ts please");
        assert_eq!(signals.scope_path.as_deref(), Some("src/agent"));
    }

    #[test]
    fn a_bare_file_name_is_its_own_scope() {
        let signals = extract_signals("look at main.rs now");
        assert_eq!(signals.scope_path.as_deref(), Some("main.rs"));
    }

    #[test]
    fn windows_separators_work_too() {
        let signals = extract_signals(r"open src\agent\loop.ts");
        assert_eq!(signals.scope_path.as_deref(), Some(r"src\agent"));
    }

    #[test]
    fn no_file_mention_means_no_scope() {
        assert_eq!(extract_signals("just a question").scope_path, None);
    }

    // ── extract_signals: tags ─────────────────────────────────────────────

    #[test]
    fn tags_derive_from_mentions() {
        let signals = extract_signals("test the typescript import in lib.rs");
        assert_eq!(signals.tags, vec!["typescript", "rust", "testing", "import"]);
    }

    #[test]
    fn tags_are_deduplicated() {
        let signals = extract_signals("rust rust rust");
        assert_eq!(signals.tags, vec!["rust"]);
    }

    #[test]
    fn empty_signals_gate_injection() {
        assert!(extract_signals("!!! ???").is_empty());
        assert!(!extract_signals("refactor something").is_empty());
    }

    // ── format_injection ──────────────────────────────────────────────────

    fn entry(category: &str, title: &str, content: &str) -> InjectionEntry {
        InjectionEntry {
            category: category.to_string(),
            title: title.to_string(),
            content: content.to_string(),
        }
    }

    #[test]
    fn entries_render_numbered_with_their_first_line() {
        let rendered = format_injection(&[
            entry("coding-style", "Use const", "Prefer const over let.\nMore detail."),
            entry("pitfall", "Avoid any", "Never use any."),
        ]);
        assert!(rendered.starts_with("[Knowledge Base — Relevant Standards]"));
        assert!(rendered.contains("1. [coding-style] Use const\n   Prefer const over let."));
        assert!(rendered.contains("2. [pitfall] Avoid any\n   Never use any."));
        assert!(!rendered.contains("More detail"), "only the first content line");
    }

    #[test]
    fn the_token_budget_truncates_the_list() {
        // ~450 tokens per entry: the first fits (10 + 450 ≤ 800), the second
        // would cross the 800-token line and is dropped along with the rest.
        let large = "x".repeat(1_800);
        let entries: Vec<InjectionEntry> =
            (0..5).map(|i| entry("pitfall", &format!("t{i}"), &large)).collect();
        let rendered = format_injection(&entries);
        assert!(rendered.contains("1. [pitfall] t0"));
        assert!(!rendered.contains("2. [pitfall] t1"), "the second entry blows the budget");
    }

    #[test]
    fn an_entry_larger_than_the_whole_budget_is_skipped_outright() {
        // Faithful to TS: the check is `tokensUsed + lineTokens > MAX` before
        // pushing, so even the first entry can be dropped.
        let oversized = entry("pitfall", "big", &"x".repeat(4_000));
        let rendered = format_injection(&[oversized]);
        assert!(!rendered.contains("1. [pitfall]"));
    }

    #[test]
    fn an_empty_result_list_renders_just_the_header() {
        assert_eq!(format_injection(&[]), "[Knowledge Base — Relevant Standards]\n");
    }
}
