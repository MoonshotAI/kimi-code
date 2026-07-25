//! WebSearch — DuckDuckGo HTML scraping without API keys.
//!
//! Posts a search query to `html.duckduckgo.com/html/`, parses the result
//! page with `scraper`, and extracts titles, URLs, and snippets.
//! Runs on a blocking thread via `tokio::task::spawn_blocking`.

use scraper::{Html, Selector};
use std::time::Duration;

// ── Configuration ────────────────────────────────────────────────────────────

const DDG_HTML_URL: &str = "https://html.duckduckgo.com/html/";
const DDG_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36";
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_RESULTS: usize = 10;

// ── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct WebSearchConfig {
    pub query: String,
    pub timeout_ms: u64,
    pub max_results: usize,
}

impl Default for WebSearchConfig {
    fn default() -> Self {
        Self {
            query: String::new(),
            timeout_ms: DEFAULT_TIMEOUT_MS,
            max_results: MAX_RESULTS,
        }
    }
}

#[derive(Debug, Clone)]
pub struct WebSearchResultEntry {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub site_name: Option<String>,
}

#[derive(Debug)]
pub struct WebSearchResult {
    pub results: Vec<WebSearchResultEntry>,
    pub error: Option<String>,
}

// ── Public entry point ───────────────────────────────────────────────────────

pub fn web_search(config: &WebSearchConfig) -> WebSearchResult {
    match web_search_inner(config) {
        Ok(results) => WebSearchResult {
            results,
            error: None,
        },
        Err(err) => WebSearchResult {
            results: Vec::new(),
            error: Some(err),
        },
    }
}

fn web_search_inner(config: &WebSearchConfig) -> Result<Vec<WebSearchResultEntry>, String> {
    let timeout = Duration::from_millis(config.timeout_ms);

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(timeout)
        .timeout_read(timeout)
        .timeout_write(timeout)
        .user_agent(DDG_USER_AGENT)
        .build();

    // POST form-encoded query to DuckDuckGo HTML endpoint
    let response = agent
        .post(DDG_HTML_URL)
        .set("Content-Type", "application/x-www-form-urlencoded")
        .set("Accept", "*/*")
        .set("Host", "html.duckduckgo.com")
        .set("Connection", "keep-alive")
        .send_string(&format!("q={}", urlencoded(&config.query)))
        .map_err(|e| match e {
            ureq::Error::Status(code, _) => {
                format!("DuckDuckGo search returned HTTP {code}")
            }
            ureq::Error::Transport(t) => format!("Network error: {t}"),
        })?;

    // Read response body
    let body = response
        .into_string()
        .map_err(|e| format!("Failed to read response: {e}"))?;

    // Parse HTML and extract results
    parse_ddg_results(&body, config.max_results)
}

// ── HTML Parsing ─────────────────────────────────────────────────────────────

fn parse_ddg_results(
    html: &str,
    max_results: usize,
) -> Result<Vec<WebSearchResultEntry>, String> {
    let document = Html::parse_document(html);

    let result_sel =
        Selector::parse("div.result").map_err(|_| "Failed to parse selector".to_string())?;
    let title_sel =
        Selector::parse("a.result__a").map_err(|_| "Failed to parse selector".to_string())?;
    let snippet_sel = Selector::parse(".result__snippet")
        .map_err(|_| "Failed to parse selector".to_string())?;
    let url_sel =
        Selector::parse(".result__url").map_err(|_| "Failed to parse selector".to_string())?;

    let mut results = Vec::new();

    for element in document.select(&result_sel) {
        if results.len() >= max_results {
            break;
        }

        // Skip ads
        let classes = element.value().attr("class").unwrap_or("");
        if classes.contains("result--ad") {
            continue;
        }

        // Extract title and URL from the link
        let title_el = match element.select(&title_sel).next() {
            Some(el) => el,
            None => continue,
        };
        let title: String = title_el.text().collect::<String>().trim().to_string();
        let url = title_el.value().attr("href").unwrap_or("").to_string();

        if title.is_empty() || url.is_empty() {
            continue;
        }

        // Extract snippet
        let snippet = element
            .select(&snippet_sel)
            .next()
            .map(|el| el.text().collect::<String>().trim().to_string())
            .unwrap_or_default();

        // Extract site name
        let site_name = element
            .select(&url_sel)
            .next()
            .map(|el| el.text().collect::<String>().trim().to_string())
            .filter(|s| !s.is_empty());

        results.push(WebSearchResultEntry {
            title,
            url,
            snippet,
            site_name,
        });
    }

    Ok(results)
}

// ── URL encoding ─────────────────────────────────────────────────────────────

fn urlencoded(s: &str) -> String {
    let mut result = String::with_capacity(s.len() * 3);
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                result.push(byte as char);
            }
            b' ' => result.push('+'),
            _ => {
                result.push('%');
                result.push(HEX_CHARS[(byte >> 4) as usize] as char);
                result.push(HEX_CHARS[(byte & 0x0F) as usize] as char);
            }
        }
    }
    result
}

const HEX_CHARS: &[u8; 16] = b"0123456789ABCDEF";

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_urlencoded() {
        assert_eq!(urlencoded("hello world"), "hello+world");
        assert_eq!(urlencoded("rust lang"), "rust+lang");
        assert_eq!(urlencoded("a&b=c"), "a%26b%3Dc");
    }

    #[test]
    fn test_parse_ddg_results_empty() {
        let html = "<html><body><div>No results</div></body></html>";
        let results = parse_ddg_results(html, 10).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn test_parse_ddg_results_basic() {
        let html = r#"
        <html><body>
            <div class="result">
                <a class="result__a" href="https://example.com">Example Title</a>
                <span class="result__snippet">This is a snippet</span>
                <span class="result__url">example.com</span>
            </div>
            <div class="result result--ad">
                <a class="result__a" href="https://ad.com">Ad Title</a>
                <span class="result__snippet">Ad snippet</span>
            </div>
            <div class="result">
                <a class="result__a" href="https://other.com">Other Title</a>
                <span class="result__snippet">Other snippet</span>
            </div>
        </body></html>
        "#;
        let results = parse_ddg_results(html, 10).unwrap();
        assert_eq!(results.len(), 2); // ad skipped
        assert_eq!(results[0].title, "Example Title");
        assert_eq!(results[0].url, "https://example.com");
        assert_eq!(results[0].snippet, "This is a snippet");
        assert_eq!(results[0].site_name.as_deref(), Some("example.com"));
        assert_eq!(results[1].title, "Other Title");
    }

    #[test]
    fn test_parse_ddg_max_results() {
        let html = r#"
        <html><body>
            <div class="result"><a class="result__a" href="https://1.com">R1</a><span class="result__snippet">S1</span></div>
            <div class="result"><a class="result__a" href="https://2.com">R2</a><span class="result__snippet">S2</span></div>
            <div class="result"><a class="result__a" href="https://3.com">R3</a><span class="result__snippet">S3</span></div>
        </body></html>
        "#;
        let results = parse_ddg_results(html, 2).unwrap();
        assert_eq!(results.len(), 2);
    }
}
