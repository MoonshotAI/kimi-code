/// XML/HTML escaping — fast byte-level replacements for safe XML embedding.
///
/// Mirrors `packages/agent-core/src/utils/xml-escape.ts`. Three variants:
///   - `escape_xml`: escapes all XML-significant characters (& < > ")
///   - `escape_xml_attr`: escapes only attribute boundary chars (& ")
///   - `escape_xml_tags`: escapes only tag delimiters (< >), preserving &
///     for Markdown compatibility
///
/// These are called on every agent turn (skill prompt injection, bash I/O
/// XML wrapping, plugin session start, background task notifications) across
/// 28 call sites in `agent-core/src/`. Moving them to Rust eliminates the
/// per-call JS string-replacement overhead and runs with SIMD-friendly
/// byte scanning.

/// Escape all XML-significant characters: & < > "
pub fn escape_xml(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

/// Escape XML attribute boundary characters only: & "
pub fn escape_xml_attr(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

/// Escape tag delimiters only: < >
/// Preserves & and " for Markdown compatibility.
pub fn escape_xml_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_escape_xml_all() {
        assert_eq!(escape_xml("hello"), "hello");
        assert_eq!(escape_xml("<tag>"), "&lt;tag&gt;");
        assert_eq!(escape_xml("a & b"), "a &amp; b");
        assert_eq!(escape_xml(r#"attr="val""#), "attr=&quot;val&quot;");
    }

    #[test]
    fn test_escape_xml_attr() {
        assert_eq!(escape_xml_attr("hello"), "hello");
        assert_eq!(escape_xml_attr("a & b"), "a &amp; b");
        assert_eq!(escape_xml_attr(r#""quoted""#), "&quot;quoted&quot;");
        // Tags NOT escaped in attr mode
        assert_eq!(escape_xml_attr("<tag>"), "<tag>");
    }

    #[test]
    fn test_escape_xml_tags() {
        assert_eq!(escape_xml_tags("hello"), "hello");
        assert_eq!(escape_xml_tags("<tag>"), "&lt;tag&gt;");
        // & and " NOT escaped in tag-only mode (Markdown safe)
        assert_eq!(escape_xml_tags("a & b"), "a & b");
        assert_eq!(escape_xml_tags(r#""quoted""#), r#""quoted""#);
    }

    #[test]
    fn test_empty_input() {
        assert_eq!(escape_xml(""), "");
        assert_eq!(escape_xml_attr(""), "");
        assert_eq!(escape_xml_tags(""), "");
    }

    #[test]
    fn test_no_special_chars() {
        let input = "Hello, World! 123 abc.";
        assert_eq!(escape_xml(input), input);
        assert_eq!(escape_xml_attr(input), input);
        assert_eq!(escape_xml_tags(input), input);
    }

    #[test]
    fn test_cjk_characters() {
        assert_eq!(escape_xml("你好世界"), "你好世界");
        assert_eq!(escape_xml_attr("中文"), "中文");
        assert_eq!(escape_xml_tags("日本語"), "日本語");
    }

    #[test]
    fn test_matches_js_output() {
        // These must produce identical output to the TS escapeXml/escapeXmlAttr/escapeXmlTags
        let cases = vec![
            ("<skill name=\"test\">content & more</skill>",
             "&lt;skill name=&quot;test&quot;&gt;content &amp; more&lt;/skill&gt;"),
            ("plugin \"test\" & arg",
             "plugin &quot;test&quot; &amp; arg"),
            ("<bash-input>ls -la</bash-input>",
             "&lt;bash-input&gt;ls -la&lt;/bash-input&gt;"),
        ];
        for (input, expected) in cases {
            assert_eq!(escape_xml(input), expected, "escape_xml({:?})", input);
        }
    }
}
