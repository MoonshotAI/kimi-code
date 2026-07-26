/// `mcp` config — server-config normalisation and the remote-URL safety gate.
///
/// Faithful port of the pure parts of
/// `packages/agent-core-v2/src/agent/mcp/config-schema.ts`:
///
/// - transport inference for legacy entries (`command` present → stdio,
///   `url` present → http),
/// - the timeout bounds,
/// - [`is_safe_mcp_remote_url`], which rejects URLs that would let a
///   configured MCP server exfiltrate bearer tokens to internal networks or
///   cloud metadata services (private IPv4/IPv6 ranges, obfuscated loopback
///   spellings, non-HTTP schemes).
pub const MAX_MCP_TIMEOUT_MS: u64 = 2_147_483_647;

/// Whether a configured timeout is within the accepted bounds.
pub fn is_valid_mcp_timeout_ms(value: u64) -> bool {
    (1..=MAX_MCP_TIMEOUT_MS).contains(&value)
}

/// Infer the transport of a raw config entry that predates the `transport`
/// field (TS's `z.preprocess` step). Returns `None` when nothing can be
/// inferred, which the schema then rejects.
pub fn infer_transport(
    explicit: Option<&str>,
    has_command: bool,
    has_url: bool,
) -> Option<&'static str> {
    match explicit {
        Some("stdio") => return Some("stdio"),
        Some("http") => return Some("http"),
        Some("sse") => return Some("sse"),
        Some(_) => return None,
        None => {}
    }
    if has_command {
        return Some("stdio");
    }
    if has_url {
        return Some("http");
    }
    None
}

/// Reject URLs that would let a configured MCP server exfiltrate bearer
/// tokens to internal networks or cloud metadata services.
pub fn is_safe_mcp_remote_url(value: &str) -> bool {
    let Some((scheme, rest)) = value.split_once("://") else {
        return false;
    };
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return false;
    }
    let Some(host) = extract_host(rest) else {
        return false;
    };
    let mut host = host.to_ascii_lowercase();
    if host.starts_with('[') && host.ends_with(']') {
        host = host[1..host.len() - 1].to_string();
    }
    if host.is_empty() {
        return false;
    }
    if host == "localhost" {
        return true;
    }
    if is_private_or_loopback_ipv4(&host) {
        return false;
    }
    if is_private_or_loopback_ipv6(&host) {
        return false;
    }
    if looks_like_obfuscated_loopback(&host) {
        return false;
    }
    true
}

/// The host portion of `authority[/path...]`, keeping IPv6 brackets and
/// dropping userinfo and port — the checks the WHATWG `URL` parser performs
/// that this gate depends on.
fn extract_host(rest: &str) -> Option<&str> {
    let authority = rest.split(['/', '?', '#']).next()?;
    // Strip userinfo.
    let after_userinfo = match authority.rfind('@') {
        Some(index) => &authority[index + 1..],
        None => authority,
    };
    if after_userinfo.is_empty() {
        return None;
    }
    // Bracketed IPv6 keeps its brackets; otherwise strip a trailing port.
    if after_userinfo.starts_with('[') {
        let close = after_userinfo.find(']')?;
        return Some(&after_userinfo[..=close]);
    }
    Some(after_userinfo.split(':').next().unwrap_or(after_userinfo))
}

fn is_private_or_loopback_ipv4(host: &str) -> bool {
    let octets: Vec<&str> = host.split('.').collect();
    if octets.len() != 4 {
        return false;
    }
    let mut parsed = [0u32; 4];
    for (index, octet) in octets.iter().enumerate() {
        if octet.is_empty() || octet.len() > 3 || !octet.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        let Ok(value) = octet.parse::<u32>() else { return false };
        // TS bails out (treating the host as not-an-IP) on any octet > 255.
        if value > 255 {
            return false;
        }
        parsed[index] = value;
    }
    let [a, b, _, _] = parsed;
    a == 127
        || a == 10
        || a == 0
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 100 && (64..=127).contains(&b))
}

fn is_private_or_loopback_ipv6(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    if h == "::1" || h == "::" {
        return true;
    }
    if h.starts_with("fe80:") || h.starts_with("fc") || h.starts_with("fd") {
        return true;
    }
    if let Some(v4) = h.strip_prefix("::ffff:") {
        if is_private_or_loopback_ipv4(v4) {
            return true;
        }
    }
    false
}

fn looks_like_obfuscated_loopback(host: &str) -> bool {
    // A bare decimal integer: 2130706433 == 127.0.0.1, 0 == this-host.
    if !host.is_empty() && host.bytes().all(|b| b.is_ascii_digit()) {
        if let Ok(n) = host.parse::<u64>() {
            if n == 2_130_706_433 || n == 0 {
                return true;
            }
        }
    }
    // Hex spelling (0x7f000001).
    if host.len() > 2
        && host[..2].eq_ignore_ascii_case("0x")
        && host[2..].bytes().all(|b| b.is_ascii_hexdigit())
        && !host[2..].is_empty()
    {
        return true;
    }
    // Octal spelling (0177.0.0.1 style: leading zero, octal digits only).
    if host.starts_with('0') && host.len() > 1 {
        let all_octal_groups = host.split('.').all(|group| {
            !group.is_empty() && group.bytes().all(|b| (b'0'..=b'7').contains(&b))
        });
        if all_octal_groups && host.split('.').next().is_some_and(|g| g.starts_with('0')) {
            // TS: /^0[0-7]+(\.[0-7]+)*$/ — first group must be 0-prefixed with
            // at least two digits.
            let first = host.split('.').next().unwrap_or("");
            if first.len() >= 2 {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── transport inference ───────────────────────────────────────────────

    #[test]
    fn explicit_transports_pass_through() {
        assert_eq!(infer_transport(Some("stdio"), false, false), Some("stdio"));
        assert_eq!(infer_transport(Some("http"), false, false), Some("http"));
        assert_eq!(infer_transport(Some("sse"), false, false), Some("sse"));
        assert_eq!(infer_transport(Some("carrier-pigeon"), true, true), None);
    }

    #[test]
    fn legacy_entries_infer_from_their_fields() {
        assert_eq!(infer_transport(None, true, false), Some("stdio"));
        assert_eq!(infer_transport(None, false, true), Some("http"));
        // command wins over url, matching the TS preprocess order.
        assert_eq!(infer_transport(None, true, true), Some("stdio"));
        assert_eq!(infer_transport(None, false, false), None);
    }

    #[test]
    fn timeout_bounds_match_the_schema() {
        assert!(!is_valid_mcp_timeout_ms(0));
        assert!(is_valid_mcp_timeout_ms(1));
        assert!(is_valid_mcp_timeout_ms(MAX_MCP_TIMEOUT_MS));
        assert!(!is_valid_mcp_timeout_ms(MAX_MCP_TIMEOUT_MS + 1));
    }

    // ── URL safety ────────────────────────────────────────────────────────

    #[test]
    fn public_https_urls_are_safe() {
        assert!(is_safe_mcp_remote_url("https://api.example.com/mcp"));
        assert!(is_safe_mcp_remote_url("http://mcp.example.com:8443/path?x=1"));
    }

    #[test]
    fn localhost_is_explicitly_allowed() {
        assert!(is_safe_mcp_remote_url("http://localhost:3000/mcp"));
        assert!(is_safe_mcp_remote_url("https://LOCALHOST/mcp"));
    }

    #[test]
    fn non_http_schemes_are_rejected() {
        assert!(!is_safe_mcp_remote_url("ftp://example.com"));
        assert!(!is_safe_mcp_remote_url("file:///etc/passwd"));
        assert!(!is_safe_mcp_remote_url("not a url"));
        assert!(!is_safe_mcp_remote_url(""));
    }

    #[test]
    fn loopback_and_private_ipv4_ranges_are_rejected() {
        for url in [
            "http://127.0.0.1/",
            "http://127.1.2.3:8080/",
            "http://10.0.0.5/",
            "http://0.0.0.0/",
            "http://169.254.169.254/latest/meta-data", // cloud metadata
            "http://172.16.0.1/",
            "http://172.31.255.255/",
            "http://192.168.1.1/",
            "http://100.64.0.1/", // CGNAT
        ] {
            assert!(!is_safe_mcp_remote_url(url), "{url} must be rejected");
        }
    }

    #[test]
    fn adjacent_public_ranges_stay_allowed() {
        for url in [
            "http://172.15.0.1/",
            "http://172.32.0.1/",
            "http://100.63.0.1/",
            "http://100.128.0.1/",
            "http://11.0.0.1/",
            "http://8.8.8.8/",
        ] {
            assert!(is_safe_mcp_remote_url(url), "{url} must be allowed");
        }
    }

    #[test]
    fn private_ipv6_ranges_are_rejected() {
        for url in [
            "http://[::1]/",
            "http://[::]/",
            "http://[fe80::1]/",
            "http://[fc00::1]/",
            "http://[fd12:3456::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[::ffff:192.168.0.1]/",
        ] {
            assert!(!is_safe_mcp_remote_url(url), "{url} must be rejected");
        }
        assert!(is_safe_mcp_remote_url("http://[2607:f8b0::1]/"), "public IPv6 allowed");
    }

    #[test]
    fn obfuscated_loopback_spellings_are_rejected() {
        for url in [
            "http://2130706433/",  // decimal 127.0.0.1
            "http://0/",           // decimal this-host
            "http://0x7f000001/",  // hex
            "http://0177.0.0.1/",  // octal
        ] {
            assert!(!is_safe_mcp_remote_url(url), "{url} must be rejected");
        }
    }

    #[test]
    fn ports_userinfo_and_paths_do_not_confuse_the_host_check() {
        assert!(!is_safe_mcp_remote_url("http://user:pass@127.0.0.1:8080/x"));
        assert!(!is_safe_mcp_remote_url("https://192.168.0.1:443/api?q=1#frag"));
        assert!(is_safe_mcp_remote_url("https://user@api.example.com:8443/mcp"));
    }

    #[test]
    fn out_of_range_octets_are_not_treated_as_ipv4() {
        // 999.1.1.1 is not an IP, so the IPv4 privacy check does not apply —
        // it falls through as a (weird) hostname, exactly as TS's regex-based
        // check behaves.
        assert!(is_safe_mcp_remote_url("http://999.1.1.1/"));
    }
}
