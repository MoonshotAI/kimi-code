//! WebSearch — DuckDuckGo HTML search without API keys.
//!
//! Posts a search query to `html.duckduckgo.com/html/`, parses the result
//! page with lightweight HTML parsing, and extracts titles, URLs, and snippets.
//! Uses `reqwest` (already a dependency of kimi-agent).
//!
//! Mirrors `packages/kimi-native-tools/src/web_search.rs` (ureq + scraper)
//! and `packages/agent-core-v2/src/app/auth/webSearch/tools/web-search.ts`.

use std::time::Duration;

const DDG_HTML_URL: &str = "https://html.duckduckgo.com/html/";
const DDG_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36";
const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_RESULTS: usize = 10;

/// A single web search result entry.
#[derive(Debug, Clone)]
pub struct WebSearchResultEntry {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub site_name: Option<String>,
}

pub type WebSearchResult = Vec<WebSearchResultEntry>;

/// Search the web using DuckDuckGo's HTML endpoint.
pub async fn web_search(query: &str) -> Result<WebSearchResult, String> {
    let timeout = Duration::from_secs(DEFAULT_TIMEOUT_SECS);

    let client = reqwest::Client::builder()
        .timeout(timeout)
        .user_agent(DDG_USER_AGENT)
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    // POST form-encoded query to DuckDuckGo HTML endpoint
    let response = client
        .post(DDG_HTML_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "*/*")
        .header("Host", "html.duckduckgo.com")
        .body(format!("q={}", urlencode(query)))
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {e}"))?;

    let status = response.status().as_u16();
    if status != 200 {
        return Err(format!("DuckDuckGo search returned HTTP {status}"));
    }

    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {e}"))?;

    parse_ddg_results(&body, MAX_RESULTS)
}

/// Parse DuckDuckGo HTML result page and extract search results.
fn parse_ddg_results(html: &str, max_results: usize) -> Result<WebSearchResult, String> {
    let mut results = Vec::new();
    let bytes = html.as_bytes();
    let len = bytes.len();
    let mut pos = 0;

    while results.len() < max_results {
        // Find the next result container: <div class="result
        let result_start = match find_tag_attr(bytes, pos, len, "div", "class", "result") {
            Some(p) => p,
            None => break,
        };

        // Find the closing </div> for this result
        let result_end = match find_closing_div(bytes, result_start, len) {
            Some(p) => p,
            None => break,
        };

        let block = &bytes[result_start..result_end];
        let block_str = std::str::from_utf8(block).unwrap_or("");

        // Check if this is an ad (class contains "result--ad")
        if block_str.contains("result--ad") {
            pos = result_end;
            continue;
        }

        // Extract title and URL from <a class="result__a" ...>
        let (title, url) = extract_link(block_str);

        if title.is_empty() || url.is_empty() {
            pos = result_end;
            continue;
        }

        // Extract snippet from <span class="result__snippet">...</span>
        let snippet = extract_between(block_str, "result__snippet")
            .map(|s| strip_html_tags(&s))
            .unwrap_or_default();

        // Extract site name from <span class="result__url">...</span>
        let site_name = extract_between(block_str, "result__url")
            .map(|s| strip_html_tags(&s))
            .filter(|s| !s.is_empty());

        results.push(WebSearchResultEntry {
            title: strip_html_tags(&title).trim().to_string(),
            url: decode_ddg_url(&url),
            snippet: trim_text(&snippet),
            site_name: site_name.map(|s| trim_text(&s)),
        });

        pos = result_end;
    }

    Ok(results)
}

/// Simple HTML tag stripping: remove everything between `<` and `>`.
fn strip_html_tags(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut in_tag = false;
    for ch in text.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => result.push(ch),
            _ => {}
        }
    }
    result
}

/// Decode a DuckDuckGo redirect URL to get the actual target URL.
fn decode_ddg_url(url: &str) -> String {
    // DuckDuckGo wraps URLs in their own redirect: //duckduckgo.com/l/?uddg=REAL_URL&...
    // We extract the `uddg` parameter if present, otherwise return the URL as-is.
    if let Some(uddg_start) = url.find("uddg=") {
        let encoded = &url[uddg_start + 5..];
        let end = encoded.find('&').unwrap_or(encoded.len());
        let encoded = &encoded[..end];
        // URL-decode the encoded URL
        percent_decode(encoded).unwrap_or_else(|| url.to_string())
    } else {
        url.to_string()
    }
}

/// Simple percent-decoding for URLs.
fn percent_decode(s: &str) -> Option<String> {
    let mut result = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let high = hex_val(bytes[i + 1])?;
            let low = hex_val(bytes[i + 2])?;
            result.push((high << 4 | low) as char);
            i += 3;
        } else {
            result.push(bytes[i] as char);
            i += 1;
        }
    }
    Some(result)
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Find the first occurrence of a tag with a specific attribute.
fn find_tag_attr(
    bytes: &[u8],
    start: usize,
    end: usize,
    tag: &str,
    attr: &str,
    value: &str,
) -> Option<usize> {
    let tag_pattern = format!("<{} ", tag);
    let attr_pattern = format!("{}=\"", attr);
    let mut pos = start;
    while pos < end {
        // Find opening tag
        let tag_start = match bytes[pos..]
            .windows(tag_pattern.len())
            .position(|w| w == tag_pattern.as_bytes())
        {
            Some(p) => pos + p,
            None => return None,
        };
        // Look for the attribute in this tag
        let tag_end = match bytes[tag_start..]
            .iter()
            .position(|&b| b == b'>')
        {
            Some(p) => tag_start + p,
            None => return None,
        };
        let tag_content = &bytes[tag_start..tag_end];
        let tag_str = std::str::from_utf8(tag_content).ok()?;

        if tag_str.contains(&attr_pattern) {
            // Verify the attribute value contains our target
            if tag_str.contains(&format!("{}=\"{}\"", attr, value))
                || tag_str.contains(&format!("{}='{}'", attr, value))
                || tag_str.contains(&format!("{} {}", attr, value))
            {
                return Some(tag_start);
            }
            // Check for "class" containing the value (for "result--ad" etc.)
            if attr == "class" && tag_str.contains(value) {
                return Some(tag_start);
            }
        }
        pos = tag_start + 1;
    }
    None
}

/// Find the closing `</div>` tag matching an opening `<div`.
fn find_closing_div(bytes: &[u8], open_pos: usize, end: usize) -> Option<usize> {
    let mut depth = 1u32;
    let mut pos = open_pos + 1;
    while pos < end && depth > 0 {
        let remaining = &bytes[pos..];
        // Check for opening <div (but not </div)
        if remaining.starts_with(b"<div") && pos + 4 <= end {
            let after = if pos + 5 < end { bytes[pos + 4] } else { 0 };
            if after == b' ' || after == b'>' || after == b'\t' || after == b'\n' {
                depth += 1;
                pos += 4;
                continue;
            }
        }
        // Check for closing </div>
        if remaining.starts_with(b"</div") && pos + 5 <= end {
            let after = if pos + 5 < end { bytes[pos + 5] } else { 0 };
            if after == b'>' || after == b' ' || after == b'\t' || after == b'\n' {
                depth -= 1;
                pos += 6; // skip past </div>
                continue;
            }
        }
        // Check for self-closing <div .../>
        if remaining.starts_with(b"/>") && depth > 1 {
            // self-closing reduces depth for the parent div
            pos += 2;
            continue;
        }
        pos += 1;
    }
    if depth == 0 { Some(pos) } else { None }
}

/// Extract text between an element with the given class.
fn extract_between<'a>(html: &'a str, class: &str) -> Option<String> {
    let bytes = html.as_bytes();
    let len = bytes.len();

    // Find opening: `<.*class="...class..."`
    let class_attr = format!("class=\"",);
    let mut search_pos = 0;

    loop {
        let tag_start = match bytes[search_pos..]
            .windows(class_attr.len())
            .position(|w| w == class_attr.as_bytes())
        {
            Some(p) => search_pos + p,
            None => return None,
        };

        // Check that this class attribute contains our target class. The
        // value runs from just after the opening quote (tag_start +
        // class_attr.len()) to the closing quote — do NOT start the search at
        // tag_start, or the opening quote itself is found and class_value
        // comes back empty (every match then fails).
        let value_start = tag_start + class_attr.len();
        let quote_end = bytes[value_start..]
            .iter()
            .position(|&b| b == b'"')
            .map(|p| value_start + p)
            .unwrap_or(len);

        let class_value = std::str::from_utf8(&bytes[value_start..quote_end]).ok()?;
        if !class_value.split_whitespace().any(|c| c == class) {
            search_pos = quote_end + 1;
            continue;
        }

        // Find the `>` of this tag
        let gt = bytes[tag_start..]
            .iter()
            .position(|&b| b == b'>')
            .map(|p| tag_start + p + 1)?;

        // Find the closing tag pattern: `</...>`
        let close = bytes[gt..]
            .windows(3)
            .position(|w| w == b"</a" || w == b"</s" || w == b"</d" || w == b"</p" || w == b"</h")
            .map(|p| gt + p)?;

        let content = std::str::from_utf8(&bytes[gt..close]).ok()?;
        return Some(content.to_string());
    }
}

/// Extract title and href from <a class="result__a" href="...">title</a>.
fn extract_link(block: &str) -> (String, String) {
    let bytes = block.as_bytes();

    // Find <a with href=
    let anchor_start = match bytes.windows(2).position(|w| w == b"<a") {
        Some(p) => p,
        None => return (String::new(), String::new()),
    };

    // Extract href value
    let href_pattern = b"href=\"";
    let href_start = match bytes[anchor_start..]
        .windows(href_pattern.len())
        .position(|w| w == href_pattern)
    {
        Some(p) => anchor_start + p + href_pattern.len(),
        None => return (String::new(), String::new()),
    };

    let href_end = match bytes[href_start..].iter().position(|&b| b == b'"') {
        Some(p) => href_start + p,
        None => return (String::new(), String::new()),
    };

    let url = std::str::from_utf8(&bytes[href_start..href_end])
        .unwrap_or("")
        .to_string();

    // Find the `>` of the <a> tag
    let gt = match bytes[anchor_start..].iter().position(|&b| b == b'>') {
        Some(p) => anchor_start + p + 1,
        None => return (String::new(), String::new()),
    };

    // Find closing </a>
    let close_a = match bytes[gt..].windows(4).position(|w| w == b"</a>") {
        Some(p) => gt + p,
        None => return (String::new(), String::new()),
    };

    let title = std::str::from_utf8(&bytes[gt..close_a])
        .unwrap_or("")
        .to_string();

    (title, url)
}

/// Trim whitespace and collapse internal whitespace.
fn trim_text(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut prev_ws = true;
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
    if result.ends_with(' ') {
        result.pop();
    }
    result
}

/// URL-encode a string for form POST body.
fn urlencode(s: &str) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_urlencode() {
        assert_eq!(urlencode("hello world"), "hello+world");
        assert_eq!(urlencode("a&b=c"), "a%26b%3Dc");
    }

    #[test]
    fn test_strip_html_tags() {
        assert_eq!(strip_html_tags("<b>bold</b>"), "bold");
        assert_eq!(strip_html_tags("plain text"), "plain text");
        assert_eq!(strip_html_tags("<a href=\"x\">link</a>"), "link");
    }

    #[test]
    fn test_percent_decode() {
        assert_eq!(percent_decode("hello%20world").unwrap(), "hello world");
        assert_eq!(percent_decode("a%26b").unwrap(), "a&b");
    }

    #[test]
    fn test_trim_text() {
        assert_eq!(trim_text("  hello   world  "), "hello world");
        assert_eq!(trim_text("single"), "single");
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
        assert!(results[0].snippet.contains("snippet"));
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