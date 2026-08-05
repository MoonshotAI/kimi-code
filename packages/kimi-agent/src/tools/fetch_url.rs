//! FetchURL — HTTP fetcher with SSRF protection and HTML content extraction.
//!
//! Mirrors `packages/agent-core/src/tools/builtin/web/fetch-url.ts`.
//! Uses reqwest (already a dependency) for HTTP fetching.

use std::net::ToSocketAddrs;
use std::time::Duration;

/// Configuration for FetchURL.
const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_BYTES: usize = 10 * 1024 * 1024; // 10 MB
const USER_AGENT: &str = "Mozilla/5.0 (compatible; KimiCode/1.0)";

/// Shared HTTP client for the web tools (`fetch_url` / `web_search`).
///
/// A `reqwest::Client` owns a connection pool; building a fresh one per call
/// (as this tool used to) threw the pool away on every fetch, so repeated web
/// calls inside one turn each paid a fresh TCP + TLS + DNS round. Sharing a
/// single 30s-timeout client keeps connections warm across calls. The default
/// redirect policy (at most 10 redirects) matches the old explicit
/// `limited(10)`; the user agent rides per request.
static SHARED_WEB_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();

pub(crate) fn shared_web_client() -> &'static reqwest::Client {
    SHARED_WEB_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECS))
            .build()
            .unwrap_or_default()
    })
}

/// Result of a fetch operation.
#[derive(Debug, Clone)]
pub struct FetchResult {
    pub content: String,
    pub content_type: Option<String>,
    pub status_code: u16,
    pub url: String,
    pub truncated: bool,
}

/// Fetch a URL and return the content.
///
/// Performs SSRF protection by rejecting private/reserved IP ranges.
/// Extracts text content from HTML pages.
pub async fn fetch_url(url: &str) -> Result<FetchResult, String> {
    // Validate URL
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("Invalid URL: {e}"))?;

    // SSRF check: reject private/reserved IPs
    let host = parsed.host_str().ok_or("URL has no host")?;
    if is_private_host(host) {
        return Err(format!("SSRF blocked: {host} is a private/reserved address"));
    }

    // Fetch via the shared web client (connection reuse across calls).
    let response = shared_web_client()
        .get(url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {e}"))?;

    let status_code = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    // Read body with size limit
    let body = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response body: {e}"))?;

    let (content, truncated) = if body.len() > MAX_BYTES {
        (String::from_utf8_lossy(&body[..MAX_BYTES]).to_string(), true)
    } else {
        (String::from_utf8_lossy(&body).to_string(), false)
    };

    // Extract text from HTML if applicable
    let is_html = content_type.as_deref().map(|ct| ct.contains("text/html")).unwrap_or(false);
    let final_content = if is_html {
        extract_text_from_html(&content)
    } else {
        content
    };

    Ok(FetchResult {
        content: final_content,
        content_type,
        status_code,
        url: url.to_string(),
        truncated,
    })
}

/// Check if a hostname resolves to a private/reserved IP address.
fn is_private_host(host: &str) -> bool {
    // Try to parse as IP directly first
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return match ip {
            std::net::IpAddr::V4(v4) => {
                v4.is_loopback() || v4.is_private() || v4.is_link_local()
                    || v4.is_multicast() || v4.is_broadcast()
                    || v4.octets()[0] == 0
            }
            std::net::IpAddr::V6(v6) => {
                v6.is_loopback() || v6.is_multicast() || v6.is_unspecified()
            }
        };
    }

    // Resolve DNS
    let addrs: Vec<std::net::IpAddr> = match (host, 0).to_socket_addrs() {
        Ok(addrs) => addrs.map(|a| a.ip()).collect(),
        Err(_) => return false,
    };

    for addr in &addrs {
        match addr {
            std::net::IpAddr::V4(v4) => {
                if v4.is_loopback() || v4.is_private() || v4.is_link_local()
                    || v4.is_multicast() || v4.is_broadcast()
                    || v4.octets()[0] == 0
                {
                    return true;
                }
            }
            std::net::IpAddr::V6(v6) => {
                if v6.is_loopback() || v6.is_multicast() || v6.is_unspecified()
                {
                    return true;
                }
            }
        }
    }
    false
}

/// Extract text content from an HTML document using simple tag stripping.
fn extract_text_from_html(html: &str) -> String {
    // Simple HTML tag stripping
    let mut result = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut in_script = false;
    let mut in_style = false;

    let chars: Vec<char> = html.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '<' if !in_tag => {
                in_tag = true;
                // Check for script/style tags
                let lower: String = chars.iter().skip(i + 1).take(20).collect::<String>().to_lowercase();
                in_script = lower.starts_with("script") || lower.starts_with("/script");
                in_style = lower.starts_with("style") || lower.starts_with("/style");
            }
            '>' if in_tag => {
                in_tag = false;
                if !in_script && !in_style && !result.is_empty() && !result.ends_with(' ') {
                    result.push(' ');
                }
            }
            _ if !in_tag && !in_script && !in_style => {
                result.push(chars[i]);
            }
            _ => {}
        }
        i += 1;
    }

    // Clean up whitespace
    let cleaned: Vec<&str> = result.split_whitespace().collect();
    cleaned.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_private_host_loopback() {
        assert!(is_private_host("127.0.0.1"));
        assert!(is_private_host("::1"));
        assert!(is_private_host("localhost"));
    }

    #[test]
    fn test_is_private_host_private() {
        assert!(is_private_host("10.0.0.1"));
        assert!(is_private_host("192.168.1.1"));
        assert!(is_private_host("172.16.0.1"));
    }

    #[test]
    fn test_is_private_host_public() {
        // IP literals only — DNS resolution would make this test depend on the
        // ambient network state (example.com here used to resolve through the
        // live DNS and fail intermittently when it hiccupped).
        assert!(!is_private_host("203.0.113.1"));
        assert!(!is_private_host("8.8.8.8"));
    }

    #[test]
    fn test_extract_text_from_html() {
        let html = "<html><body><h1>Hello</h1><p>World</p></body></html>";
        let text = extract_text_from_html(html);
        assert!(text.contains("Hello"));
        assert!(text.contains("World"));
    }

    #[test]
    fn test_extract_text_from_html_with_article() {
        let html = "<html><body><article><h1>Title</h1><p>Content here</p></article></body></html>";
        let text = extract_text_from_html(html);
        assert!(text.contains("Title"));
        assert!(text.contains("Content here"));
    }
}