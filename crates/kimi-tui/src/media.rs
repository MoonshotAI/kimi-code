//! ReadMediaFile result rendering (TS `tool-renderers/media.ts` parity).
//!
//! The ReadMediaFile tool's `content` is the JSON-serialized array of
//! content parts — which includes the full base64 of the image/video.
//! Dumping that into the transcript blasts a multi-screen blob of base64.
//! This module parses the envelope and surfaces just the human-readable
//! bits (kind, path, mime, size) as a one-line summary. It never emits
//! the base64.

/// The human-readable summary of a ReadMediaFile output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadMediaSummary {
    pub kind: &'static str,
    pub path: Option<String>,
    pub mime_type: Option<String>,
    pub bytes: Option<u64>,
    pub url: Option<String>,
}

/// Parse a ReadMediaFile `content` envelope; `None` when it isn't the
/// expected media output (callers fall back to the raw text).
pub fn parse_read_media_output(output: &str) -> Option<ReadMediaSummary> {
    let parsed: serde_json::Value = serde_json::from_str(output).ok()?;
    let parts = parsed.as_array()?;

    let mut kind: Option<&'static str> = None;
    let mut path: Option<String> = None;
    let mut mime_type: Option<String> = None;
    let mut bytes: Option<u64> = None;
    let mut url: Option<String> = None;
    let mut found_media = false;

    for part in parts {
        let Some(obj) = part.as_object() else {
            continue;
        };
        let r#type = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if r#type == "text" {
            // `<image path="...">` / `<video path="...">` tag in a text part.
            if let Some(text) = obj.get("text").and_then(|v| v.as_str()) {
                if let Some((k, p)) = parse_path_tag(text) {
                    kind = Some(k);
                    path = Some(p);
                }
            }
            continue;
        }
        if r#type == "image_url" || r#type == "video_url" {
            found_media = true;
            kind = Some(if r#type == "image_url" { "image" } else { "video" });
            let holder_key = if r#type == "image_url" { "imageUrl" } else { "videoUrl" };
            let Some(holder) = obj.get(holder_key).and_then(|v| v.as_object()) else {
                continue;
            };
            let Some(u) = holder.get("url").and_then(|v| v.as_str()) else {
                continue;
            };
            if let Some((mime, b64)) = parse_data_url(u) {
                mime_type = Some(mime.to_string());
                bytes = Some(bytes_from_base64(b64));
            } else {
                url = Some(u.to_string());
            }
        }
    }

    if !found_media || kind.is_none() {
        return None;
    }
    Some(ReadMediaSummary {
        kind: kind.unwrap(),
        path,
        mime_type,
        bytes,
        url,
    })
}

/// Match `<image path="...">` / `<video path="...">`.
fn parse_path_tag(text: &str) -> Option<(&'static str, String)> {
    let rest = text.strip_prefix('<')?.strip_suffix('>')?;
    let (kind, rest) = rest.split_once(char::is_whitespace)?;
    if kind != "image" && kind != "video" {
        return None;
    }
    let path = rest.strip_prefix("path=\"")?.strip_suffix('"')?;
    Some((if kind == "image" { "image" } else { "video" }, path.to_string()))
}

/// Split `data:mime;base64,payload`.
fn parse_data_url(url: &str) -> Option<(&str, &str)> {
    let rest = url.strip_prefix("data:")?;
    let (mime, payload) = rest.split_once(";base64,")?;
    Some((mime, payload))
}

/// Size of a base64 payload in bytes.
fn bytes_from_base64(b64: &str) -> u64 {
    let len = b64.len() as u64;
    if len == 0 {
        return 0;
    }
    let padding = if b64.ends_with("==") {
        2
    } else if b64.ends_with('=') {
        1
    } else {
        0
    };
    (len * 3) / 4 - padding
}

/// `123 B` / `1.2 KB` / `1.2 MB` (1024-based, TS `formatBytes` parity).
pub fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

/// One-line transcript summary for a ReadMediaFile result, or `None` when
/// the output isn't a media envelope (keep the raw text).
pub fn media_summary_text(output: &str) -> Option<String> {
    let summary = parse_read_media_output(output)?;
    let mut meta: Vec<String> = Vec::new();
    if let Some(mime) = &summary.mime_type {
        meta.push(mime.clone());
    }
    if let Some(bytes) = summary.bytes {
        meta.push(format_bytes(bytes));
    }
    let mut segs: Vec<String> = vec![summary.kind.to_string()];
    if !meta.is_empty() {
        segs.push(format!("({})", meta.join(", ")));
    }
    if let Some(path) = &summary.path {
        segs.push(path.clone());
    } else if let Some(url) = &summary.url {
        segs.push(url.clone());
    }
    Some(segs.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_image_envelope_with_path_tag() {
        let output = r#"[{"type":"text","text":"<image path=\"/tmp/a.png\">"},{"type":"image_url","imageUrl":{"url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="}}]"#;
        let s = parse_read_media_output(output).expect("parses");
        assert_eq!(s.kind, "image");
        assert_eq!(s.path.as_deref(), Some("/tmp/a.png"));
        assert_eq!(s.mime_type.as_deref(), Some("image/png"));
        assert!(s.bytes.unwrap() > 0);
        assert!(s.url.is_none());
    }

    #[test]
    fn non_media_output_is_none() {
        assert!(parse_read_media_output("just text").is_none());
        assert!(parse_read_media_output(r#"{"type":"text","text":"hi"}"#).is_none());
        assert!(parse_read_media_output("[]").is_none());
    }

    #[test]
    fn base64_bytes_counts_padding() {
        // "aGVsbG8=" = "hello" = 5 bytes.
        assert_eq!(bytes_from_base64("aGVsbG8="), 5);
        assert_eq!(bytes_from_base64(""), 0);
    }

    #[test]
    fn formats_bytes() {
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(2048), "2.0 KB");
        assert_eq!(format_bytes(3 * 1024 * 1024), "3.0 MB");
    }

    #[test]
    fn summary_line_never_contains_base64() {
        let output = r#"[{"type":"image_url","imageUrl":{"url":"data:image/png;base64,aGVsbG8="}}]"#;
        let text = media_summary_text(output).expect("summary");
        assert!(text.starts_with("image ("), "text: {text}");
        assert!(!text.contains("aGVsbG8"), "base64 must not leak: {text}");
    }
}
