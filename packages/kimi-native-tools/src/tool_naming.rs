/// MCP tool name sanitization and qualification.
///
/// Mirrors `packages/agent-core/src/mcp/tool-naming.ts`:
///   - `sanitize_mcp_name_part`: replace non-safe chars with `_`, collapse runs
///   - `qualify_mcp_tool_name`: build `mcp__<server>__<tool>` with length cap + hash
///   - `is_mcp_tool_name`: check if a name starts with the MCP prefix
///
/// Called once per MCP tool registration (10-50 tools per session).
/// The FNV-1a hash is a single tight loop — trivially fast in Rust.

const MCP_NAME_PREFIX: &str = "mcp__";
const MCP_NAME_SEPARATOR: &str = "__";
const MAX_QUALIFIED_LENGTH: usize = 64;

/// Replace any character outside the safe ASCII set with `_`, then collapse
/// any run of `_` into a single underscore.
pub fn sanitize_mcp_name_part(part: &str) -> String {
    let mut out = String::with_capacity(part.len());
    let mut prev_underscore = false;
    for &b in part.as_bytes() {
        let safe = b.is_ascii_alphanumeric() || b == b'_' || b == b'-';
        if safe {
            if b == b'_' && prev_underscore {
                // Skip consecutive underscores.
                continue;
            }
            out.push(b as char);
            prev_underscore = b == b'_';
        } else {
            if !prev_underscore {
                out.push('_');
                prev_underscore = true;
            }
        }
    }
    out
}

/// Check if a tool name starts with the MCP prefix.
pub fn is_mcp_tool_name(name: &str) -> bool {
    name.starts_with(MCP_NAME_PREFIX)
}

/// Produce the qualified MCP tool name: `mcp__<server>__<tool>`.
/// If the result exceeds 64 chars, a deterministic 8-char FNV-1a hash
/// suffix replaces the tail so the prefix structure stays intact.
pub fn qualify_mcp_tool_name(server_name: &str, tool_name: &str) -> String {
    let sanitized_server = sanitize_mcp_name_part(server_name);
    let sanitized_tool = sanitize_mcp_name_part(tool_name);
    let full = format!(
        "{}{}{}{}",
        MCP_NAME_PREFIX, sanitized_server, MCP_NAME_SEPARATOR, sanitized_tool
    );

    if full.len() <= MAX_QUALIFIED_LENGTH {
        return full;
    }

    let hash = stable_hash8(&full);
    let keep = MAX_QUALIFIED_LENGTH - hash.len() - 1;
    format!("{}_{}", &full[..keep], hash)
}

/// 32-bit FNV-1a hash, returning an 8-char hex string.
/// Not cryptographic — only used for collision resistance among a handful
/// of tool names within a single server's tool list.
fn stable_hash8(input: &str) -> String {
    let mut hash: u32 = 0x811c9dc5;
    for &b in input.as_bytes() {
        hash ^= b as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    format!("{:08x}", hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_basic() {
        assert_eq!(sanitize_mcp_name_part("hello"), "hello");
        assert_eq!(sanitize_mcp_name_part("my-tool"), "my-tool");
        assert_eq!(sanitize_mcp_name_part("tool_123"), "tool_123");
    }

    #[test]
    fn test_sanitize_special_chars() {
        assert_eq!(sanitize_mcp_name_part("my.tool"), "my_tool");
        assert_eq!(sanitize_mcp_name_part("my tool"), "my_tool");
        assert_eq!(sanitize_mcp_name_part("a@b#c"), "a_b_c");
    }

    #[test]
    fn test_sanitize_collapse_underscores() {
        assert_eq!(sanitize_mcp_name_part("a..b"), "a_b");
        assert_eq!(sanitize_mcp_name_part("a@#b"), "a_b");
        assert_eq!(sanitize_mcp_name_part("a b c"), "a_b_c");
    }

    #[test]
    fn test_sanitize_cjk() {
        assert_eq!(sanitize_mcp_name_part("工具"), "_");
        assert_eq!(sanitize_mcp_name_part("my工具"), "my_");
    }

    #[test]
    fn test_is_mcp_tool_name() {
        assert!(is_mcp_tool_name("mcp__server__tool"));
        assert!(!is_mcp_tool_name("read"));
        assert!(!is_mcp_tool_name("mcp_tool"));
        assert!(is_mcp_tool_name("mcp__s__t"));
    }

    #[test]
    fn test_qualify_short() {
        let result = qualify_mcp_tool_name("myserver", "mytool");
        assert_eq!(result, "mcp__myserver__mytool");
        assert!(result.len() <= MAX_QUALIFIED_LENGTH);
    }

    #[test]
    fn test_qualify_long() {
        let long_server = "a".repeat(40);
        let long_tool = "b".repeat(40);
        let result = qualify_mcp_tool_name(&long_server, &long_tool);
        assert!(result.len() <= MAX_QUALIFIED_LENGTH);
        assert!(result.starts_with(MCP_NAME_PREFIX));
        // The hash suffix is 8 hex chars preceded by _
        let suffix = &result[result.len() - 9..];
        assert_eq!(&suffix[..1], "_");
        assert_eq!(suffix[1..].len(), 8);
    }

    #[test]
    fn test_qualify_deterministic() {
        let server = "very_long_server_name_that_exceeds_limit";
        let tool = "very_long_tool_name_that_also_exceeds";
        let r1 = qualify_mcp_tool_name(server, tool);
        let r2 = qualify_mcp_tool_name(server, tool);
        assert_eq!(r1, r2, "hash must be deterministic");
    }

    #[test]
    fn test_qualify_sanitizes() {
        let result = qualify_mcp_tool_name("my.server", "my.tool");
        assert_eq!(result, "mcp__my_server__my_tool");
    }

    #[test]
    fn test_hash_format() {
        // FNV-1a of empty string with offset basis 0x811c9dc5
        let h = stable_hash8("");
        assert_eq!(h.len(), 8);
        // FNV-1a("") = 0x811c9dc5
        assert_eq!(h, "811c9dc5");
    }
}
