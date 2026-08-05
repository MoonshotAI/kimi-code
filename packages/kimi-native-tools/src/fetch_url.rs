//! FetchUrl — HTTP fetcher with SSRF protection and HTML content extraction.
//!
//! Designed to run on a blocking thread (via `tokio::task::spawn_blocking`) so
//! the Node event loop stays responsive. The entire fetch + extract pipeline
//! happens in Rust without touching libuv.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};
use std::time::Duration;

use scraper::{Html, Selector};
use url::Url;

// ── Configuration ────────────────────────────────────────────────────────────

const DEFAULT_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";
const DEFAULT_MAX_BYTES: usize = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_REDIRECTS: u32 = 10;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;

pub struct FetchUrlConfig {
    pub url: String,
    pub user_agent: String,
    pub max_bytes: usize,
    pub allow_private: bool,
    pub max_redirects: u32,
    pub timeout_ms: u64,
}

impl Default for FetchUrlConfig {
    fn default() -> Self {
        Self {
            url: String::new(),
            user_agent: DEFAULT_USER_AGENT.to_string(),
            max_bytes: DEFAULT_MAX_BYTES,
            allow_private: false,
            max_redirects: DEFAULT_MAX_REDIRECTS,
            timeout_ms: DEFAULT_TIMEOUT_MS,
        }
    }
}

pub struct FetchUrlResult {
    pub content: String,
    pub kind: String, // "passthrough" | "extracted"
    pub status: u16,
    pub error: Option<String>,
}

// ── Public entry point ───────────────────────────────────────────────────────

pub fn fetch_url(config: &FetchUrlConfig) -> FetchUrlResult {
    match fetch_url_inner(config) {
        Ok(result) => result,
        Err(err) => FetchUrlResult {
            content: String::new(),
            kind: String::new(),
            status: 0,
            error: Some(err),
        },
    }
}

fn fetch_url_inner(config: &FetchUrlConfig) -> Result<FetchUrlResult, String> {
    let mut current_url = config.url.clone();
    let timeout = Duration::from_millis(config.timeout_ms);

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(timeout)
        .timeout_read(timeout)
        .timeout_write(timeout)
        .redirects(0) // We handle redirects manually for per-hop SSRF checks
        .user_agent(&config.user_agent)
        .build();

    let mut redirects: u32 = 0;

    loop {
        // SSRF check on every hop
        validate_url(&current_url, config.allow_private)?;

        let response = agent
            .get(&current_url)
            .call()
            .map_err(|e| match e {
                ureq::Error::Status(code, resp) => {
                    // For redirects, we handle them below
                    if is_redirect(code) {
                        return format!("__redirect__:{}", resp.header("location").unwrap_or(""));
                    }
                    format!("HTTP {code}")
                }
                ureq::Error::Transport(t) => format!("Network error: {t}"),
            });

        match response {
            Ok(resp) => {
                let status = resp.status();

                // Check content-length before reading body
                if let Some(cl) = resp.header("content-length") {
                    if let Ok(len) = cl.parse::<usize>() {
                        if len > config.max_bytes {
                            return Err(format!(
                                "Response body too large: {len} bytes exceeds limit ({} bytes).",
                                config.max_bytes
                            ));
                        }
                    }
                }

                // Extract content type before consuming the response
                let content_type = resp
                    .header("content-type")
                    .unwrap_or("")
                    .to_lowercase();

                // Read body with size limit (consumes resp)
                let body = read_body_limited(resp, config.max_bytes)?;

                let (content, kind) = if content_type.starts_with("text/plain")
                    || content_type.starts_with("text/markdown")
                {
                    (body, "passthrough".to_string())
                } else {
                    // Assume HTML — extract main content
                    let extracted = extract_html_content(&body);
                    (extracted, "extracted".to_string())
                };

                return Ok(FetchUrlResult {
                    content,
                    kind,
                    status,
                    error: None,
                });
            }
            Err(e) => {
                let msg = e.to_string();
                if let Some(location) = msg.strip_prefix("__redirect__:") {
                    if location.is_empty() {
                        return Err("Redirect without Location header".to_string());
                    }
                    redirects += 1;
                    if redirects > config.max_redirects {
                        return Err(format!(
                            "Too many redirects (limit {}).",
                            config.max_redirects
                        ));
                    }
                    // Resolve relative redirect
                    current_url = resolve_redirect(&current_url, location)?;
                    continue;
                }
                return Err(msg);
            }
        }
    }
}

// ── SSRF Protection ──────────────────────────────────────────────────────────

fn validate_url(url_str: &str, allow_private: bool) -> Result<(), String> {
    let parsed = Url::parse(url_str).map_err(|e| format!("Invalid URL: {e}"))?;

    match parsed.scheme() {
        "http" | "https" => {}
        scheme => return Err(format!("Unsupported scheme \"{scheme}\" — only http(s) allowed.")),
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| "URL has no host".to_string())?;

    if allow_private {
        return Ok(());
    }

    // Check for localhost aliases
    let host_lower = host.to_lowercase();
    if host_lower == "localhost" || host_lower.ends_with(".localhost") {
        return Err(format!("Refusing to fetch private host: \"{host}\""));
    }

    // Try parsing as IP literal first
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_private_ip(ip) {
            return Err(format!("Refusing to fetch private address: \"{host}\""));
        }
        return Ok(());
    }

    // DNS resolve and check all addresses
    let port = parsed.port_or_known_default().unwrap_or(80);
    let socket_addr = format!("{host}:{port}");
    let addrs = socket_addr
        .to_socket_addrs()
        .map_err(|e| format!("Cannot resolve host \"{host}\": {e}"))?;

    for addr in addrs {
        if is_private_ip(addr.ip()) {
            return Err(format!(
                "Refusing to fetch host \"{host}\": resolves to private address \"{}\".",
                addr.ip()
            ));
        }
    }

    Ok(())
}

fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_private_ipv4(v4),
        IpAddr::V6(v6) => is_private_ipv6(v6),
    }
}

fn is_private_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    // 0.0.0.0/8 — "this network"
    if octets[0] == 0 { return true; }
    // 10.0.0.0/8
    if octets[0] == 10 { return true; }
    // 100.64.0.0/10 — CGNAT
    if octets[0] == 100 && (octets[1] & 0xC0) == 64 { return true; }
    // 127.0.0.0/8 — loopback
    if octets[0] == 127 { return true; }
    // 169.254.0.0/16 — link-local / cloud metadata
    if octets[0] == 169 && octets[1] == 254 { return true; }
    // 172.16.0.0/12
    if octets[0] == 172 && (octets[1] & 0xF0) == 16 { return true; }
    // 192.168.0.0/16
    if octets[0] == 192 && octets[1] == 168 { return true; }
    false
}

fn is_private_ipv6(ip: Ipv6Addr) -> bool {
    // :: (unspecified)
    if ip.is_unspecified() { return true; }
    // ::1 (loopback)
    if ip == Ipv6Addr::LOCALHOST { return true; }
    let segments = ip.segments();
    // fc00::/7 — ULA
    if (segments[0] & 0xFE00) == 0xFC00 { return true; }
    // fe80::/10 — link-local
    if (segments[0] & 0xFFC0) == 0xFE80 { return true; }
    // IPv4-mapped IPv6 (::ffff:x.x.x.x) — check the embedded IPv4
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_private_ipv4(v4);
    }
    false
}

fn is_redirect(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

fn resolve_redirect(base_url: &str, location: &str) -> Result<String, String> {
    let base = Url::parse(base_url).map_err(|e| format!("Invalid base URL: {e}"))?;
    let resolved = base.join(location).map_err(|e| format!("Invalid redirect location: {e}"))?;
    Ok(resolved.to_string())
}

// ── Body reading ─────────────────────────────────────────────────────────────

fn read_body_limited(resp: ureq::Response, max_bytes: usize) -> Result<String, String> {
    let mut buf = Vec::with_capacity(max_bytes.min(64 * 1024));
    let mut reader = resp.into_reader();
    let mut chunk = [0u8; 8192];
    loop {
        let n = reader.read(&mut chunk).map_err(|e| format!("Read error: {e}"))?;
        if n == 0 { break; }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > max_bytes {
            return Err(format!(
                "Response body too large: exceeds limit ({max_bytes} bytes)."
            ));
        }
    }
    String::from_utf8(buf).map_err(|_| "Response body is not valid UTF-8.".to_string())
}

// ── HTML Content Extraction ──────────────────────────────────────────────────

/// Extract the main textual content from an HTML page.
///
/// Strategy:
/// 1. Parse HTML with `scraper`
/// 2. Extract `<title>` text
/// 3. Try `<article>`, then `<main>`, then `<body>` as the content container
/// 4. Remove noise elements (script, style, nav, header, footer, aside)
/// 5. Collapse whitespace and return clean text
pub fn extract_html_content(html: &str) -> String {
    let document = Html::parse_document(html);

    // Extract title
    let title = selector("title")
        .and_then(|sel| document.select(&sel).next())
        .map(|el| clean_text(&el.text().collect::<String>()))
        .unwrap_or_default();

    // Try content containers in priority order
    let content = try_extract_container(&document, "article")
        .or_else(|| try_extract_container(&document, "main"))
        .or_else(|| try_extract_container(&document, "body"))
        .unwrap_or_default();

    if content.is_empty() {
        return String::new();
    }

    if title.is_empty() {
        content
    } else {
        format!("# {title}\n\n{content}")
    }
}

fn try_extract_container(document: &Html, tag: &str) -> Option<String> {
    let sel = selector(tag)?;
    let element = document.select(&sel).next()?;

    // Collect text, skipping noise elements
    let noise_tags: &[&str] = &["script", "style", "nav", "header", "footer", "aside", "noscript"];
    let mut text_parts: Vec<String> = Vec::new();

    collect_text_excluding(element, noise_tags, &mut text_parts);

    let combined = text_parts.join(" ");
    let cleaned = clean_text(&combined);

    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

fn collect_text_excluding(
    element: scraper::ElementRef,
    exclude_tags: &[&str],
    output: &mut Vec<String>,
) {
    for child in element.children() {
        match child.value() {
            scraper::node::Node::Text(text) => {
                let t = text.trim();
                if !t.is_empty() {
                    output.push(t.to_string());
                }
            }
            scraper::node::Node::Element(el) => {
                let tag_name = el.name();
                if exclude_tags.contains(&tag_name) {
                    continue;
                }
                if let Some(child_ref) = scraper::ElementRef::wrap(child) {
                    collect_text_excluding(child_ref, exclude_tags, output);
                }
            }
            _ => {}
        }
    }
}

fn selector(s: &str) -> Option<Selector> {
    Selector::parse(s).ok()
}

fn clean_text(text: &str) -> String {
    // Collapse runs of whitespace into single spaces, trim
    let mut result = String::with_capacity(text.len());
    let mut prev_ws = true; // start as true to trim leading whitespace
    for ch in text.chars() {
        if ch.is_whitespace() {
            if !prev_ws {
                result.push(' ');
                prev_ws = true;
            }
        } else {
            result.push(ch);
            prev_ws = false;
        }
    }
    // Trim trailing space
    if result.ends_with(' ') {
        result.pop();
    }
    result
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_private_ipv4() {
        assert!(is_private_ipv4(Ipv4Addr::new(127, 0, 0, 1)));
        assert!(is_private_ipv4(Ipv4Addr::new(10, 0, 0, 1)));
        assert!(is_private_ipv4(Ipv4Addr::new(192, 168, 1, 1)));
        assert!(is_private_ipv4(Ipv4Addr::new(172, 16, 0, 1)));
        assert!(is_private_ipv4(Ipv4Addr::new(169, 254, 169, 254)));
        assert!(is_private_ipv4(Ipv4Addr::new(100, 64, 0, 1)));
        assert!(is_private_ipv4(Ipv4Addr::new(0, 0, 0, 0)));
        // Public
        assert!(!is_private_ipv4(Ipv4Addr::new(8, 8, 8, 8)));
        assert!(!is_private_ipv4(Ipv4Addr::new(1, 1, 1, 1)));
        assert!(!is_private_ipv4(Ipv4Addr::new(203, 0, 113, 1)));
    }

    #[test]
    fn test_private_ipv6() {
        assert!(is_private_ipv6(Ipv6Addr::UNSPECIFIED));
        assert!(is_private_ipv6(Ipv6Addr::LOCALHOST));
        // ULA
        assert!(is_private_ipv6("fd00::1".parse().unwrap()));
        // Link-local
        assert!(is_private_ipv6("fe80::1".parse().unwrap()));
        // Public
        assert!(!is_private_ipv6("2001:db8::1".parse().unwrap()));
    }

    #[test]
    fn test_validate_url_rejects_private() {
        assert!(validate_url("http://127.0.0.1/secret", false).is_err());
        assert!(validate_url("http://10.0.0.1/internal", false).is_err());
        assert!(validate_url("http://192.168.1.1/router", false).is_err());
        assert!(validate_url("http://localhost/admin", false).is_err());
        assert!(validate_url("http://evil.localhost/", false).is_err());
        assert!(validate_url("ftp://example.com/file", false).is_err());
    }

    #[test]
    fn test_validate_url_allows_public() {
        // IP-literal public addresses: no DNS resolution, so the test is
        // deterministic regardless of the ambient network/DNS state (resolving
        // a hostname like example.com here used to fail intermittently when
        // DNS hiccupped).
        assert!(validate_url("http://203.0.113.1/page", false).is_ok());
        assert!(validate_url("http://8.8.8.8/dns", false).is_ok());
    }

    #[test]
    fn test_validate_url_allows_private_when_enabled() {
        assert!(validate_url("http://127.0.0.1/secret", true).is_ok());
        assert!(validate_url("http://192.168.1.1/router", true).is_ok());
    }

    #[test]
    fn test_html_extraction() {
        let html = r#"
        <html>
        <head><title>Test Page</title></head>
        <body>
            <nav>Navigation menu</nav>
            <article>
                <h1>Hello World</h1>
                <p>This is the main content.</p>
                <script>console.log('noise');</script>
            </article>
            <footer>Footer text</footer>
        </body>
        </html>
        "#;
        let result = extract_html_content(html);
        assert!(result.starts_with("# Test Page"));
        assert!(result.contains("Hello World"));
        assert!(result.contains("main content"));
        assert!(!result.contains("Navigation menu"));
        assert!(!result.contains("console.log"));
        assert!(!result.contains("Footer text"));
    }

    #[test]
    fn test_html_extraction_no_article() {
        let html = r#"
        <html>
        <head><title>Simple</title></head>
        <body>
            <main><p>Main content here</p></main>
        </body>
        </html>
        "#;
        let result = extract_html_content(html);
        assert!(result.contains("Main content here"));
    }

    #[test]
    fn test_resolve_redirect() {
        let base = "https://example.com/page";
        assert_eq!(
            resolve_redirect(base, "/other").unwrap(),
            "https://example.com/other"
        );
        assert_eq!(
            resolve_redirect(base, "https://other.com/x").unwrap(),
            "https://other.com/x"
        );
    }
}
