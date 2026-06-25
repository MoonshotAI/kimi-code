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
    (ascii + 3) / 4 + non_ascii
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
}
