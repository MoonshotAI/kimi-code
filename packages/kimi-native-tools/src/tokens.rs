/// Token estimation via character-based heuristic.
///
/// Mirrors `packages/agent-core/src/utils/tokens.ts`:
///   - ASCII: ~4 chars per token
///   - Non-ASCII (CJK, emoji, etc.): ~1 char per token
///
/// The estimate is transient — the next LLM call returns the real count
/// and supersedes this value. Used to keep `tokenCountWithPending`
/// monotonic between LLM round-trips without paying for a tokenizer.
///
/// ## Byte-level scanning
///
/// Instead of decoding UTF-8 into code points (which `str::chars()` does),
/// we scan raw bytes. In UTF-8:
///   - Bytes `0x00..0x80` are ASCII code points (1 byte = 1 code point)
///   - Bytes `0xC0..0xFF` are start bytes of multi-byte sequences
///     (each code point has exactly one start byte)
///   - Bytes `0x80..0xC0` are continuation bytes (skip)
///
/// This gives identical counts to iterating `char` values but is
/// SIMD-friendly — the compiler auto-vectorizes the byte comparisons.
/// It also matches the JS `for (const char of text)` semantics, which
/// iterates Unicode code points.
///
/// Estimate token count from a single text string.
pub fn estimate_tokens(text: &str) -> usize {
    let mut ascii = 0usize;
    let mut non_ascii = 0usize;
    for &b in text.as_bytes() {
        if b < 0x80 {
            ascii += 1;
        } else if b >= 0xC0 {
            non_ascii += 1;
        }
    }
    (ascii.div_ceil(4)) + non_ascii
}

/// Estimate token count across multiple text strings (batch mode).
///
/// Equivalent to `texts.iter().map(estimate_tokens).sum()` but with a
/// single napi boundary crossing — collects all text fragments in TS
/// and makes one Rust call instead of N calls.
pub fn estimate_tokens_batch(texts: &[&str]) -> usize {
    let mut total = 0usize;
    for &text in texts {
        total += estimate_tokens(text);
    }
    total
}

/// Truncate text to fit within a token budget, keeping the BEGINNING.
///
/// Walks bytes forward using the same ASCII/non-ASCII heuristic as
/// `estimate_tokens`, and stops at the first code point that would
/// push the running total over the budget. Mirrors
/// `truncateTextToTokens` in `handoff.ts`.
pub fn truncate_text_to_tokens(text: &str, max_tokens: usize) -> String {
    if max_tokens == 0 {
        return String::new();
    }
    let mut ascii = 0usize;
    let mut non_ascii = 0usize;
    let mut end = 0usize;
    for (i, &b) in text.as_bytes().iter().enumerate() {
        if b < 0x80 {
            ascii += 1;
        } else if b >= 0xC0 {
            non_ascii += 1;
        }
        // Continuation bytes (0x80..0xC0) don't count as separate code points.
        if ascii.div_ceil(4) + non_ascii > max_tokens {
            break;
        }
        end = i + 1;
    }
    text[..end].to_string()
}

/// Truncate text to fit within a token budget, keeping the END.
///
/// Walks bytes backward, skipping UTF-8 continuation bytes to consume
/// multi-byte sequences whole (equivalent to the JS surrogate-pair
/// handling). Mirrors `truncateTextToTokensFromEnd` in `handoff.ts`.
pub fn truncate_text_to_tokens_from_end(text: &str, max_tokens: usize) -> String {
    if max_tokens == 0 {
        return String::new();
    }
    let bytes = text.as_bytes();
    let mut ascii = 0usize;
    let mut non_ascii = 0usize;
    let mut start = bytes.len();
    let mut i = bytes.len();
    while i > 0 {
        i -= 1;
        let b = bytes[i];
        if b < 0x80 {
            ascii += 1;
        } else if b >= 0xC0 {
            non_ascii += 1;
        } else {
            // Continuation byte: part of a multi-byte sequence already counted
            // (or about to be counted when we reach its start byte).
            continue;
        }
        if ascii.div_ceil(4) + non_ascii > max_tokens {
            break;
        }
        start = i;
    }
    text[start..].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ascii_only() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("hello"), 2);
        assert_eq!(estimate_tokens("hello world"), 3);
        assert_eq!(estimate_tokens("a"), 1);
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcde"), 2);
    }

    #[test]
    fn test_cjk() {
        assert_eq!(estimate_tokens("你好"), 2);
        assert_eq!(estimate_tokens("你好世界"), 4);
    }

    #[test]
    fn test_mixed_ascii_cjk() {
        assert_eq!(estimate_tokens("Hello你好"), 4);
        assert_eq!(estimate_tokens("Hello你好World"), 5);
    }

    #[test]
    fn test_emoji() {
        assert_eq!(estimate_tokens("👋"), 1);
        assert_eq!(estimate_tokens("a👋b"), 2);
        assert_eq!(estimate_tokens("🎉🎊"), 2);
    }

    #[test]
    fn test_matches_js_heuristic() {
        let cases = [
            ("", 0),
            ("hello world", 3),
            ("Hello, World!", 4),
            ("你好，世界！", 6),
            ("def estimate_tokens(text):", 7),
            ("const result = await fetch(url);", 8),
        ];
        for (text, expected) in cases {
            let got = estimate_tokens(text);
            assert_eq!(
                got, expected,
                "estimate_tokens({:?}): got {}, expected {}",
                text, got, expected
            );
        }
    }

    #[test]
    fn test_batch() {
        let texts: Vec<&str> = vec!["hello", "world", "你好"];
        assert_eq!(estimate_tokens_batch(&texts), 6);
    }

    #[test]
    fn test_batch_empty() {
        let texts: Vec<&str> = vec![];
        assert_eq!(estimate_tokens_batch(&texts), 0);
    }

    #[test]
    fn test_batch_single() {
        let texts: Vec<&str> = vec!["hello world"];
        assert_eq!(estimate_tokens_batch(&texts), 3);
    }

    // ── truncate_text_to_tokens (forward) ──────────────────────────────

    #[test]
    fn test_truncate_forward_empty() {
        assert_eq!(truncate_text_to_tokens("", 10), "");
    }

    #[test]
    fn test_truncate_forward_zero_budget() {
        assert_eq!(truncate_text_to_tokens("hello", 0), "");
    }

    #[test]
    fn test_truncate_forward_budget_exceeds_text() {
        assert_eq!(truncate_text_to_tokens("hello", 100), "hello");
    }

    #[test]
    fn test_truncate_forward_ascii() {
        // "hello world" = 3 tokens (11 ASCII chars / 4 = 2.75 → 3)
        // budget=1: ceil(4/4)=1 token = 4 chars "hell"; 5th char → ceil(5/4)=2 > 1
        assert_eq!(truncate_text_to_tokens("hello world", 1), "hell");
        // budget=2: ceil(8/4)=2 tokens = 8 chars "hello wo"; 9th char → ceil(9/4)=3 > 2
        assert_eq!(truncate_text_to_tokens("hello world", 2), "hello wo");
        assert_eq!(truncate_text_to_tokens("hello world", 3), "hello world");
    }

    #[test]
    fn test_truncate_forward_cjk() {
        // "你好世界" = 4 tokens (each CJK char = 1 token)
        assert_eq!(truncate_text_to_tokens("你好世界", 1), "你");
        assert_eq!(truncate_text_to_tokens("你好世界", 2), "你好");
        assert_eq!(truncate_text_to_tokens("你好世界", 4), "你好世界");
    }

    #[test]
    fn test_truncate_forward_mixed() {
        // "abc你" = ceil(3/4) + 1 = 2 tokens
        assert_eq!(truncate_text_to_tokens("abc你", 1), "abc");
        assert_eq!(truncate_text_to_tokens("abc你", 2), "abc你");
    }

    #[test]
    fn test_truncate_forward_emoji() {
        // "👋" = 1 token (4-byte UTF-8, 1 non-ASCII code point)
        assert_eq!(truncate_text_to_tokens("👋", 0), "");
        assert_eq!(truncate_text_to_tokens("👋", 1), "👋");
        // "a👋b" = ceil(2/4) + 1 = 2 tokens
        assert_eq!(truncate_text_to_tokens("a👋b", 1), "a");
        assert_eq!(truncate_text_to_tokens("a👋b", 2), "a👋b");
    }

    #[test]
    fn test_truncate_forward_no_split_multibyte() {
        // Truncation must never split a multi-byte sequence.
        let result = truncate_text_to_tokens("你好", 1);
        assert_eq!(result, "你");
        assert!(result.chars().count() == 1);
    }

    // ── truncate_text_to_tokens_from_end (backward) ────────────────────

    #[test]
    fn test_truncate_backward_empty() {
        assert_eq!(truncate_text_to_tokens_from_end("", 10), "");
    }

    #[test]
    fn test_truncate_backward_zero_budget() {
        assert_eq!(truncate_text_to_tokens_from_end("hello", 0), "");
    }

    #[test]
    fn test_truncate_backward_budget_exceeds_text() {
        assert_eq!(truncate_text_to_tokens_from_end("hello", 100), "hello");
    }

    #[test]
    fn test_truncate_backward_ascii() {
        // "hello world" = 3 tokens
        assert_eq!(truncate_text_to_tokens_from_end("hello world", 1), "orld");
        assert_eq!(truncate_text_to_tokens_from_end("hello world", 2), "lo world");
        assert_eq!(truncate_text_to_tokens_from_end("hello world", 3), "hello world");
    }

    #[test]
    fn test_truncate_backward_cjk() {
        // "你好世界" = 4 tokens
        assert_eq!(truncate_text_to_tokens_from_end("你好世界", 1), "界");
        assert_eq!(truncate_text_to_tokens_from_end("你好世界", 2), "世界");
        assert_eq!(truncate_text_to_tokens_from_end("你好世界", 4), "你好世界");
    }

    #[test]
    fn test_truncate_backward_mixed() {
        // "abc你" = ceil(3/4) + 1 = 2 tokens
        assert_eq!(truncate_text_to_tokens_from_end("abc你", 1), "你");
        assert_eq!(truncate_text_to_tokens_from_end("abc你", 2), "abc你");
    }

    #[test]
    fn test_truncate_backward_emoji() {
        // "👋" = 1 token
        assert_eq!(truncate_text_to_tokens_from_end("👋", 0), "");
        assert_eq!(truncate_text_to_tokens_from_end("👋", 1), "👋");
        // "a👋b" = ceil(2/4) + 1 = 2 tokens
        assert_eq!(truncate_text_to_tokens_from_end("a👋b", 1), "b");
        assert_eq!(truncate_text_to_tokens_from_end("a👋b", 2), "a👋b");
    }

    #[test]
    fn test_truncate_backward_no_split_multibyte() {
        let result = truncate_text_to_tokens_from_end("你好", 1);
        assert_eq!(result, "好");
        assert!(result.chars().count() == 1);
    }

    #[test]
    fn test_truncate_budget_respected() {
        // Both forward and backward truncation must produce text whose
        // estimated token count never exceeds the budget.
        let cases = [
            ("hello world", 1),
            ("hello world", 2),
            ("hello world", 3),
            ("你好世界", 1),
            ("你好世界", 2),
            ("abc你好def", 2),
            ("a👋b🎉c", 2),
        ];
        for (text, budget) in cases {
            let front = truncate_text_to_tokens(text, budget);
            let front_tokens = estimate_tokens(&front);
            assert!(front_tokens <= budget,
                "forward({:?}, {}): got {} tokens in {:?}",
                text, budget, front_tokens, front);
            let back = truncate_text_to_tokens_from_end(text, budget);
            let back_tokens = estimate_tokens(&back);
            assert!(back_tokens <= budget,
                "backward({:?}, {}): got {} tokens in {:?}",
                text, budget, back_tokens, back);
        }
    }
}
