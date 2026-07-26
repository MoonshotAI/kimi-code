/// MCP tool-call result → executable-tool output pipeline.
///
/// Faithful port of `packages/agent-core-v2/src/agent/mcp/output.ts`.
///
/// Owns the full path from "MCP protocol content blocks" to "what the agent
/// loop feeds back to the model":
///  1. Convert each raw block to a `ContentPart` (dropping unsupported shapes).
///  2. Wrap media-only outputs in `<mcp_tool_result name="…">` tags so the
///     model can attribute binary output when several tools return media.
///  3. Apply the 100K text/think character budget to the tool's own text.
///     This runs BEFORE captions exist, so a chatty tool can never evict or
///     slice a compression caption.
///  4. (Host hook) Compress oversized inline images; captions ride the `note`
///     side channel, never `output`.
///  5. Apply the per-part 10 MB binary cap: an oversized binary part collapses
///     to a notice, so a single screenshot cannot evict every text part.
///  6. Collapse a single-text-part result to a plain string output.
///
/// [`mcp_result_to_executable_output`] is the single entry point; the per-step
/// helpers stay private so callers cannot bypass the limits.
use serde::{Deserialize, Serialize};

use crate::context::types::{ContentPart, MediaContainer};

/// The loose wire-level content block (TS `MCPContentBlock`): a string `type`
/// plus optional fields, tolerating unknown extras.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct McpRawContentBlock {
    #[serde(rename = "type")]
    pub block_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(default, rename = "mimeType", skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource: Option<McpEmbeddedResourceContents>,
}

/// Inline resource contents nested under an embedded-resource block.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct McpEmbeddedResourceContents {
    #[serde(default)]
    pub uri: String,
    #[serde(default, rename = "mimeType", skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob: Option<String>,
}

/// The `tools/call` result shape the pipeline consumes.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct McpRawToolResult {
    #[serde(default)]
    pub content: Vec<McpRawContentBlock>,
    #[serde(default, rename = "isError")]
    pub is_error: bool,
}

pub const MCP_MAX_OUTPUT_CHARS: usize = 100_000;

pub const MCP_MAX_BINARY_PART_BYTES: usize = 10 * 1024 * 1024;
/// Base64 inflation: `ceil(bytes * 4 / 3)` chars, matching TS's
/// `Math.ceil((MCP_MAX_BINARY_PART_BYTES * 4) / 3)`.
pub const MCP_MAX_BINARY_PART_CHARS: usize = (MCP_MAX_BINARY_PART_BYTES * 4).div_ceil(3);

fn max_binary_part_chars() -> usize {
    MCP_MAX_BINARY_PART_CHARS
}

fn truncation_notice() -> String {
    format!(
        "\n\n[Output truncated: exceeded {MCP_MAX_OUTPUT_CHARS} character limit. Use pagination or more specific queries to get remaining content.]"
    )
}

fn binary_part_too_large_notice(kind: &str, url_length: usize) -> String {
    let approx_mb = (url_length as f64 * 3.0 / 4.0) / (1024.0 * 1024.0);
    let cap_mb = MCP_MAX_BINARY_PART_BYTES / (1024 * 1024);
    format!(
        "[{kind}_url dropped: ~{approx_mb:.1} MB exceeds {cap_mb} MB per-part limit. Try a smaller resource.]"
    )
}

/// Convert one raw block. `None` drops unsupported shapes, mirroring TS.
pub fn convert_mcp_content_block(block: &McpRawContentBlock) -> Option<ContentPart> {
    match block.block_type.as_str() {
        "text" => block.text.as_ref().map(|text| ContentPart::Text { text: text.clone() }),
        "image" => block.data.as_ref().map(|data| {
            let mime_type = block.mime_type.as_deref().unwrap_or("image/png");
            ContentPart::ImageUrl {
                image_url: MediaContainer {
                    url: format!("data:{mime_type};base64,{data}"),
                    id: None,
                },
            }
        }),
        "audio" => block.data.as_ref().map(|data| {
            let mime_type = block.mime_type.as_deref().unwrap_or("audio/mpeg");
            ContentPart::AudioUrl {
                audio_url: MediaContainer {
                    url: format!("data:{mime_type};base64,{data}"),
                    id: None,
                },
            }
        }),
        "resource" => {
            let resource = block.resource.as_ref()?;
            if let Some(text) = &resource.text {
                return Some(ContentPart::Text { text: text.clone() });
            }
            let blob = resource.blob.as_ref()?;
            let mime_type = resource.mime_type.as_deref().unwrap_or("application/octet-stream");
            let url = format!("data:{mime_type};base64,{blob}");
            if mime_type.starts_with("image/") {
                Some(ContentPart::ImageUrl { image_url: MediaContainer { url, id: None } })
            } else if mime_type.starts_with("audio/") {
                Some(ContentPart::AudioUrl { audio_url: MediaContainer { url, id: None } })
            } else if mime_type.starts_with("video/") {
                Some(ContentPart::VideoUrl { video_url: MediaContainer { url, id: None } })
            } else {
                None
            }
        }
        "resource_link" => {
            let uri = block.uri.as_ref().filter(|uri| !uri.is_empty())?;
            let mime_type = block.mime_type.as_deref().unwrap_or("application/octet-stream");
            if mime_type.starts_with("image/") {
                Some(ContentPart::ImageUrl {
                    image_url: MediaContainer { url: uri.clone(), id: None },
                })
            } else if mime_type.starts_with("audio/") {
                Some(ContentPart::AudioUrl {
                    audio_url: MediaContainer { url: uri.clone(), id: None },
                })
            } else if mime_type.starts_with("video/") {
                Some(ContentPart::VideoUrl {
                    video_url: MediaContainer { url: uri.clone(), id: None },
                })
            } else {
                None
            }
        }
        _ => None,
    }
}

/// The executable output the agent loop feeds back to the model.
#[derive(Debug, Clone, PartialEq)]
pub struct McpExecutableOutput {
    pub output: McpOutputBody,
    pub is_error: bool,
    /// Compression captions from the host's image hook, if any.
    pub note: Option<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum McpOutputBody {
    Text(String),
    Parts(Vec<ContentPart>),
}

/// The host's image-compression hook (step 4). Receives the budgeted parts and
/// returns the (possibly compressed) parts plus any captions to ride `note`.
pub type ImageCompressHook<'a> =
    dyn Fn(Vec<ContentPart>) -> (Vec<ContentPart>, Vec<String>) + 'a;

/// The single entry point (TS `mcpResultToExecutableOutput`).
pub fn mcp_result_to_executable_output(
    result: &McpRawToolResult,
    qualified_tool_name: &str,
    compress_images: Option<&ImageCompressHook<'_>>,
) -> McpExecutableOutput {
    let converted: Vec<ContentPart> =
        result.content.iter().filter_map(convert_mcp_content_block).collect();

    let wrapped = wrap_media_only(converted, qualified_tool_name);
    let (budgeted, text_truncated) = apply_text_budget(wrapped);
    let (compressed, captions) = match compress_images {
        Some(hook) => hook(budgeted),
        None => (budgeted, Vec::new()),
    };
    let (capped, binary_truncated) = apply_binary_part_cap(compressed);
    let truncated = text_truncated || binary_truncated;
    let output = collapse_single_text(capped);
    McpExecutableOutput {
        output,
        is_error: result.is_error,
        note: if captions.is_empty() { None } else { Some(captions.join("\n")) },
        truncated,
    }
}

/// Wrap media-only outputs in attribution tags (step 2).
fn wrap_media_only(parts: Vec<ContentPart>, qualified_tool_name: &str) -> Vec<ContentPart> {
    let has_media = parts.iter().any(|part| {
        matches!(
            part,
            ContentPart::ImageUrl { .. } | ContentPart::AudioUrl { .. } | ContentPart::VideoUrl { .. }
        )
    });
    let has_non_empty_text =
        parts.iter().any(|part| matches!(part, ContentPart::Text { text } if !text.is_empty()));
    if !has_media || has_non_empty_text {
        return parts;
    }
    let mut wrapped = Vec::with_capacity(parts.len() + 2);
    wrapped.push(ContentPart::Text {
        text: format!("<mcp_tool_result name=\"{qualified_tool_name}\">"),
    });
    wrapped.extend(parts);
    wrapped.push(ContentPart::Text { text: "</mcp_tool_result>".to_string() });
    wrapped
}

/// Take a prefix of `text` of at most `limit` UTF-16 code units, on a char
/// boundary. TS slices by UTF-16 units; snapping to a scalar boundary is the
/// closest total equivalent.
fn slice_utf16_units(text: &str, limit: usize) -> (String, usize) {
    let mut used = 0usize;
    let mut out = String::new();
    for c in text.chars() {
        let units = c.len_utf16();
        if used + units > limit {
            break;
        }
        used += units;
        out.push(c);
    }
    (out, used)
}

fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// The 100K character budget over text/think parts (step 3).
fn apply_text_budget(parts: Vec<ContentPart>) -> (Vec<ContentPart>, bool) {
    let mut remaining = MCP_MAX_OUTPUT_CHARS;
    let mut truncated = false;
    let mut out: Vec<ContentPart> = Vec::with_capacity(parts.len());

    for part in parts {
        match part {
            ContentPart::Text { text } => {
                if remaining == 0 {
                    truncated = true;
                    continue;
                }
                let length = utf16_len(&text);
                if length > remaining {
                    let (sliced, _) = slice_utf16_units(&text, remaining);
                    out.push(ContentPart::Text { text: sliced });
                    remaining = 0;
                    truncated = true;
                } else {
                    remaining -= length;
                    out.push(ContentPart::Text { text });
                }
            }
            ContentPart::Think { think, encrypted, signature } => {
                if remaining == 0 {
                    truncated = true;
                    continue;
                }
                let think_text = think.clone().unwrap_or_default();
                let size = utf16_len(&think_text)
                    + encrypted.as_deref().map(utf16_len).unwrap_or(0);
                if size > remaining {
                    let (sliced, _) = slice_utf16_units(&think_text, remaining);
                    // TS drops the encrypted payload on a truncating slice.
                    out.push(ContentPart::Think {
                        think: Some(sliced),
                        encrypted: None,
                        signature: None,
                    });
                    remaining = 0;
                    truncated = true;
                } else {
                    remaining -= size;
                    out.push(ContentPart::Think { think, encrypted, signature });
                }
            }
            other => out.push(other),
        }
    }

    if truncated {
        append_truncation_notice(&mut out);
    }
    (out, truncated)
}

/// The per-part 10 MB binary cap (step 5).
fn apply_binary_part_cap(parts: Vec<ContentPart>) -> (Vec<ContentPart>, bool) {
    let cap = max_binary_part_chars();
    let mut truncated = false;
    let mut out: Vec<ContentPart> = Vec::with_capacity(parts.len());
    for part in parts {
        let (kind, url_length) = match &part {
            ContentPart::ImageUrl { image_url } => ("image", utf16_len(&image_url.url)),
            ContentPart::AudioUrl { audio_url } => ("audio", utf16_len(&audio_url.url)),
            ContentPart::VideoUrl { video_url } => ("video", utf16_len(&video_url.url)),
            _ => {
                out.push(part);
                continue;
            }
        };
        if url_length > cap {
            out.push(ContentPart::Text {
                text: binary_part_too_large_notice(kind, url_length),
            });
            truncated = true;
        } else {
            out.push(part);
        }
    }
    (out, truncated)
}

/// Attach the truncation notice to the last text part, or append one.
fn append_truncation_notice(out: &mut Vec<ContentPart>) {
    for part in out.iter_mut().rev() {
        if let ContentPart::Text { text } = part {
            text.push_str(&truncation_notice());
            return;
        }
    }
    out.push(ContentPart::Text { text: truncation_notice() });
}

/// A lone text part collapses to a plain string (step 6).
fn collapse_single_text(parts: Vec<ContentPart>) -> McpOutputBody {
    if parts.len() == 1 {
        if let ContentPart::Text { text } = &parts[0] {
            return McpOutputBody::Text(text.clone());
        }
    }
    McpOutputBody::Parts(parts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_block(text: &str) -> McpRawContentBlock {
        McpRawContentBlock {
            block_type: "text".to_string(),
            text: Some(text.to_string()),
            ..Default::default()
        }
    }

    fn image_block(data: &str, mime: Option<&str>) -> McpRawContentBlock {
        McpRawContentBlock {
            block_type: "image".to_string(),
            data: Some(data.to_string()),
            mime_type: mime.map(str::to_string),
            ..Default::default()
        }
    }

    fn result(blocks: Vec<McpRawContentBlock>) -> McpRawToolResult {
        McpRawToolResult { content: blocks, is_error: false }
    }

    fn run(result_: &McpRawToolResult) -> McpExecutableOutput {
        mcp_result_to_executable_output(result_, "mcp__srv__tool", None)
    }

    // ── block conversion ──────────────────────────────────────────────────

    #[test]
    fn text_blocks_convert() {
        let part = convert_mcp_content_block(&text_block("hello")).unwrap();
        assert_eq!(part, ContentPart::Text { text: "hello".to_string() });
    }

    #[test]
    fn image_blocks_default_to_png() {
        let part = convert_mcp_content_block(&image_block("AAAA", None)).unwrap();
        match part {
            ContentPart::ImageUrl { image_url } => {
                assert_eq!(image_url.url, "data:image/png;base64,AAAA");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn audio_blocks_default_to_mpeg() {
        let block = McpRawContentBlock {
            block_type: "audio".to_string(),
            data: Some("BBBB".to_string()),
            ..Default::default()
        };
        match convert_mcp_content_block(&block).unwrap() {
            ContentPart::AudioUrl { audio_url } => {
                assert_eq!(audio_url.url, "data:audio/mpeg;base64,BBBB");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn embedded_resources_prefer_text_over_blob() {
        let block = McpRawContentBlock {
            block_type: "resource".to_string(),
            resource: Some(McpEmbeddedResourceContents {
                uri: "res://x".to_string(),
                text: Some("resource text".to_string()),
                blob: Some("AAAA".to_string()),
                mime_type: Some("image/png".to_string()),
            }),
            ..Default::default()
        };
        assert_eq!(
            convert_mcp_content_block(&block).unwrap(),
            ContentPart::Text { text: "resource text".to_string() }
        );
    }

    #[test]
    fn resource_blobs_map_by_mime_family() {
        for (mime, want_image, want_audio, want_video) in [
            ("image/webp", true, false, false),
            ("audio/wav", false, true, false),
            ("video/mp4", false, false, true),
        ] {
            let block = McpRawContentBlock {
                block_type: "resource".to_string(),
                resource: Some(McpEmbeddedResourceContents {
                    uri: "res://x".to_string(),
                    blob: Some("AA".to_string()),
                    mime_type: Some(mime.to_string()),
                    text: None,
                }),
                ..Default::default()
            };
            let part = convert_mcp_content_block(&block).unwrap();
            assert_eq!(matches!(part, ContentPart::ImageUrl { .. }), want_image, "{mime}");
            assert_eq!(matches!(part, ContentPart::AudioUrl { .. }), want_audio, "{mime}");
            assert_eq!(matches!(part, ContentPart::VideoUrl { .. }), want_video, "{mime}");
        }
    }

    #[test]
    fn an_octet_stream_blob_is_dropped() {
        let block = McpRawContentBlock {
            block_type: "resource".to_string(),
            resource: Some(McpEmbeddedResourceContents {
                uri: "res://x".to_string(),
                blob: Some("AA".to_string()),
                mime_type: None,
                text: None,
            }),
            ..Default::default()
        };
        assert_eq!(convert_mcp_content_block(&block), None);
    }

    #[test]
    fn resource_links_pass_the_uri_through() {
        let block = McpRawContentBlock {
            block_type: "resource_link".to_string(),
            uri: Some("https://cdn/x.png".to_string()),
            mime_type: Some("image/png".to_string()),
            ..Default::default()
        };
        match convert_mcp_content_block(&block).unwrap() {
            ContentPart::ImageUrl { image_url } => assert_eq!(image_url.url, "https://cdn/x.png"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn unknown_and_malformed_blocks_are_dropped() {
        assert_eq!(
            convert_mcp_content_block(&McpRawContentBlock {
                block_type: "widget".to_string(),
                ..Default::default()
            }),
            None
        );
        // text block with no text field
        assert_eq!(
            convert_mcp_content_block(&McpRawContentBlock {
                block_type: "text".to_string(),
                ..Default::default()
            }),
            None
        );
        // resource_link with an empty uri
        assert_eq!(
            convert_mcp_content_block(&McpRawContentBlock {
                block_type: "resource_link".to_string(),
                uri: Some(String::new()),
                ..Default::default()
            }),
            None
        );
    }

    // ── pipeline ──────────────────────────────────────────────────────────

    #[test]
    fn a_single_text_result_collapses_to_a_string() {
        let output = run(&result(vec![text_block("just text")]));
        assert_eq!(output.output, McpOutputBody::Text("just text".to_string()));
        assert!(!output.truncated);
        assert!(!output.is_error);
        assert_eq!(output.note, None);
    }

    #[test]
    fn is_error_propagates() {
        let mut failing = result(vec![text_block("boom")]);
        failing.is_error = true;
        assert!(run(&failing).is_error);
    }

    #[test]
    fn media_only_results_are_wrapped_for_attribution() {
        let output = run(&result(vec![image_block("AAAA", Some("image/png"))]));
        match output.output {
            McpOutputBody::Parts(parts) => {
                assert_eq!(parts.len(), 3);
                assert_eq!(
                    parts[0],
                    ContentPart::Text {
                        text: "<mcp_tool_result name=\"mcp__srv__tool\">".to_string()
                    }
                );
                assert!(matches!(parts[1], ContentPart::ImageUrl { .. }));
                assert_eq!(parts[2], ContentPart::Text { text: "</mcp_tool_result>".to_string() });
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn mixed_results_are_not_wrapped() {
        let output =
            run(&result(vec![text_block("page text"), image_block("AAAA", Some("image/png"))]));
        match output.output {
            McpOutputBody::Parts(parts) => {
                assert_eq!(parts.len(), 2, "no attribution wrapper");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn empty_text_does_not_prevent_wrapping() {
        // TS checks for *non-empty* text before skipping the wrapper.
        let output =
            run(&result(vec![text_block(""), image_block("AAAA", Some("image/png"))]));
        match output.output {
            McpOutputBody::Parts(parts) => assert_eq!(parts.len(), 4, "wrapper added"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn the_text_budget_truncates_and_annotates() {
        let output = run(&result(vec![text_block(&"x".repeat(MCP_MAX_OUTPUT_CHARS + 5))]));
        assert!(output.truncated);
        match output.output {
            McpOutputBody::Text(text) => {
                assert!(text.contains("[Output truncated: exceeded 100000 character limit."));
                assert!(text.len() < MCP_MAX_OUTPUT_CHARS + 300);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn later_text_parts_past_the_budget_are_dropped() {
        let output = run(&result(vec![
            text_block(&"a".repeat(MCP_MAX_OUTPUT_CHARS)),
            text_block("this one is dropped"),
        ]));
        assert!(output.truncated);
        match output.output {
            McpOutputBody::Text(text) => assert!(!text.contains("dropped")),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn media_parts_do_not_consume_the_text_budget() {
        let output = run(&result(vec![
            image_block("AAAA", Some("image/png")),
            text_block(&"x".repeat(MCP_MAX_OUTPUT_CHARS)),
        ]));
        assert!(!output.truncated, "exactly at the budget with media alongside");
    }

    #[test]
    fn an_oversized_binary_part_collapses_to_a_notice() {
        let huge = "A".repeat(max_binary_part_chars() + 10);
        let output = run(&result(vec![text_block("before"), image_block(&huge, Some("image/png"))]));
        assert!(output.truncated);
        match output.output {
            McpOutputBody::Parts(parts) => {
                assert_eq!(parts.len(), 2);
                match &parts[1] {
                    ContentPart::Text { text } => {
                        assert!(text.starts_with("[image_url dropped: ~"));
                        assert!(text.contains("exceeds 10 MB per-part limit"));
                    }
                    other => panic!("unexpected {other:?}"),
                }
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn the_compression_hook_contributes_captions_to_the_note() {
        let hook: Box<ImageCompressHook<'_>> = Box::new(|parts| {
            (parts, vec!["compressed 4.2 MB -> 900 KB".to_string(), "saved to x".to_string()])
        });
        let output = mcp_result_to_executable_output(
            &result(vec![text_block("ok")]),
            "mcp__srv__tool",
            Some(hook.as_ref()),
        );
        assert_eq!(output.note.as_deref(), Some("compressed 4.2 MB -> 900 KB\nsaved to x"));
        match output.output {
            McpOutputBody::Text(text) => assert_eq!(text, "ok", "captions never enter output"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn an_empty_result_yields_empty_parts() {
        let output = run(&result(vec![]));
        assert_eq!(output.output, McpOutputBody::Parts(vec![]));
        assert!(!output.truncated);
    }

    #[test]
    fn truncation_notice_lands_on_the_last_text_part() {
        // Budget-exceeding text followed by an image: the notice must attach
        // to the text, not float after the image.
        let output = run(&result(vec![
            text_block(&"x".repeat(MCP_MAX_OUTPUT_CHARS + 1)),
            image_block("AAAA", Some("image/png")),
        ]));
        match output.output {
            McpOutputBody::Parts(parts) => {
                match &parts[0] {
                    ContentPart::Text { text } => assert!(text.ends_with("remaining content.]")),
                    other => panic!("unexpected {other:?}"),
                }
                assert!(matches!(parts[1], ContentPart::ImageUrl { .. }));
            }
            other => panic!("unexpected {other:?}"),
        }
    }
}
