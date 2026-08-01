//! Token estimation — shared heuristic for both the napi toolset and the
//! engine.
//!
//! The heuristic is ASCII ≈ 4 chars/token, non-ASCII ≈ 1 token/char
//! (`ceil(ascii_count / 4) + non_ascii_count`), matching the TS
//! `tsEstimateTokens`. Counting is over Unicode scalar values (JS iterates
//! `for (const char of text)`, which walks code points). The byte-walking
//! implementation used by the napi toolset is equivalent: UTF-8 continuation
//! bytes (0x80..0xC0) never satisfy the `>= 0xC0` non-ASCII test, so each
//! multi-byte character contributes exactly one count, exactly like `chars()`.
//!
//! Estimates size context windows and compaction budgets, never billing.

/// Estimate the number of tokens in a text string.
///
/// `ceil(ascii_count / 4) + non_ascii_count`, matching `tsEstimateTokens`.
pub fn estimate_tokens(text: &str) -> u64 {
    let mut ascii_count: u64 = 0;
    let mut non_ascii_count: u64 = 0;
    for ch in text.chars() {
        if (ch as u32) <= 127 {
            ascii_count += 1;
        } else {
            non_ascii_count += 1;
        }
    }
    ascii_count.div_ceil(4) + non_ascii_count
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_rounds_up_per_four() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("hello"), 2);
        assert_eq!(estimate_tokens("hello world"), 3);
        assert_eq!(estimate_tokens("a"), 1);
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcde"), 2);
    }

    #[test]
    fn non_ascii_counts_one_per_scalar() {
        assert_eq!(estimate_tokens("你好"), 2);
        assert_eq!(estimate_tokens("你好世界"), 4);
        assert_eq!(estimate_tokens("Hello你好"), 4);
        assert_eq!(estimate_tokens("Hello你好World"), 5);
    }

    #[test]
    fn surrogate_pairs_count_once() {
        // Emoji are 4-byte UTF-8 but a single scalar value.
        assert_eq!(estimate_tokens("👋"), 1);
        assert_eq!(estimate_tokens("a👋b"), 2);
        assert_eq!(estimate_tokens("🎉🎊"), 2);
    }
}
