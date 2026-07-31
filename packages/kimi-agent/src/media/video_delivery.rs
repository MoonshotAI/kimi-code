//! Video delivery — upload a local video via the provider's upload channel,
//! falling back to an inline base64 data: part when the channel is unavailable
//! or the upload fails for a non-auth reason.
//!
//! Mirrors `packages/agent-core/src/tools/support/video-delivery.ts`.


// ── Auth error detection ───────────────────────────────────────────────

/// Check if an error is an auth-related upload error (401/403 or
/// provider.auth_error code). These must surface rather than being
/// silently degraded to inline base64.
pub fn is_auth_upload_error(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("401") || lower.contains("403")
        || lower.contains("auth_error")
        || lower.contains("unauthorized")
        || lower.contains("forbidden")
        || lower.contains("auth error")
}

// ── Provider support ───────────────────────────────────────────────────

/// Whether the provider's wire format can carry an inline base64 video part.
/// The OpenAI family cannot: chat completions rejects the part outright.
pub fn inline_video_supported(provider_name: &str) -> bool {
    provider_name != "openai"
        && provider_name != "openai-responses"
        && provider_name != "openai_chat"
        && provider_name != "openai_responses"
}

// ── Video delivery ─────────────────────────────────────────────────────

/// Input for video upload.
#[derive(Debug, Clone)]
pub struct VideoUploadInput {
    pub data: Vec<u8>,
    pub mime_type: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration_secs: Option<f64>,
}

/// Result of a video delivery attempt.
#[derive(Debug, Clone)]
pub enum VideoDeliveryResult {
    /// Successfully uploaded via provider channel — returns a reference URL.
    Uploaded { url: String, mime_type: String },
    /// Fallback to inline base64 data URL.
    InlineBase64 { url: String, mime_type: String },
    /// Auth error — must surface to trigger credential refresh.
    AuthError { message: String },
    /// Cancelled — delivery was aborted.
    Cancelled,
}

/// A video uploader function type.
pub type VideoUploader = Box<
    dyn Fn(VideoUploadInput) -> Result<String, String> + Send + Sync
>;

/// Deliver a video through the provider's upload channel when available,
/// falling back to an inline base64 part.
///
/// - If `uploader` is provided, tries the upload channel first.
/// - Auth errors (401/403) are returned as `AuthError` so the caller
///   can surface them.
/// - Non-auth upload failures fall through to inline base64.
/// - When `uploader` is None, goes straight to the inline fallback.
pub fn deliver_video_content(
    input: VideoUploadInput,
    uploader: Option<&VideoUploader>,
) -> VideoDeliveryResult {
    if let Some(uploader) = uploader {
        match uploader(input.clone()) {
            Ok(url) => {
                return VideoDeliveryResult::Uploaded {
                    url,
                    mime_type: input.mime_type.clone(),
                };
            }
            Err(error) => {
                if is_auth_upload_error(&error) {
                    return VideoDeliveryResult::AuthError { message: error };
                }
                // Fall through to inline base64
            }
        }
    }

    // Inline base64 fallback
    let base64 = base64_encode(&input.data);
    let data_url = format!("data:{};base64,{}", input.mime_type, base64);
    VideoDeliveryResult::InlineBase64 {
        url: data_url,
        mime_type: input.mime_type,
    }
}

/// Build a base64-encoded video part from raw bytes.
pub fn build_inline_video_part(data: &[u8], mime_type: &str) -> String {
    let base64 = base64_encode(data);
    format!("data:{};base64,{}", mime_type, base64)
}

/// Simple base64 encoding.
fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_auth_upload_error_401() {
        assert!(is_auth_upload_error("HTTP 401 Unauthorized"));
    }

    #[test]
    fn test_is_auth_upload_error_403() {
        assert!(is_auth_upload_error("HTTP 403 Forbidden"));
    }

    #[test]
    fn test_is_auth_upload_error_auth_error() {
        assert!(is_auth_upload_error("provider.auth_error"));
    }

    #[test]
    fn test_is_auth_upload_error_non_auth() {
        assert!(!is_auth_upload_error("connection refused"));
        assert!(!is_auth_upload_error("timeout"));
    }

    #[test]
    fn test_inline_video_supported_openai() {
        assert!(!inline_video_supported("openai"));
        assert!(!inline_video_supported("openai-responses"));
        assert!(!inline_video_supported("openai_chat"));
    }

    #[test]
    fn test_inline_video_supported_others() {
        assert!(inline_video_supported("anthropic"));
        assert!(inline_video_supported("kimi"));
        assert!(inline_video_supported("google-genai"));
        assert!(inline_video_supported("vertexai"));
    }

    #[test]
    fn test_deliver_video_with_uploader() {
        let input = VideoUploadInput {
            data: vec![0, 1, 2],
            mime_type: "video/mp4".into(),
            width: Some(1920),
            height: Some(1080),
            duration_secs: Some(30.0),
        };

        let uploader: VideoUploader = Box::new(|_input: VideoUploadInput| {
            Ok("https://upload.example.com/video/abc123".to_string())
        });

        let result = deliver_video_content(input, Some(&uploader));
        match result {
            VideoDeliveryResult::Uploaded { url, mime_type } => {
                assert!(url.contains("upload.example.com"));
                assert_eq!(mime_type, "video/mp4");
            }
            _ => panic!("Expected Uploaded result"),
        }
    }

    #[test]
    fn test_deliver_video_without_uploader_falls_back_to_inline() {
        let input = VideoUploadInput {
            data: vec![0, 1, 2],
            mime_type: "video/mp4".into(),
            width: None,
            height: None,
            duration_secs: None,
        };

        let result = deliver_video_content(input, None);
        match result {
            VideoDeliveryResult::InlineBase64 { url, mime_type } => {
                assert!(url.starts_with("data:video/mp4;base64,"));
                assert_eq!(mime_type, "video/mp4");
            }
            _ => panic!("Expected InlineBase64 result"),
        }
    }

    #[test]
    fn test_deliver_video_uploader_fails_falls_back() {
        let input = VideoUploadInput {
            data: b"test video data".to_vec(),
            mime_type: "video/webm".into(),
            width: None,
            height: None,
            duration_secs: None,
        };

        let uploader: VideoUploader = Box::new(|_input: VideoUploadInput| {
            Err("connection timeout".to_string())
        });

        let result = deliver_video_content(input, Some(&uploader));
        match result {
            VideoDeliveryResult::InlineBase64 { .. } => {} // Expected
            _ => panic!("Expected InlineBase64 fallback"),
        }
    }

    #[test]
    fn test_deliver_video_auth_error_surfaces() {
        let input = VideoUploadInput {
            data: b"test".to_vec(),
            mime_type: "video/mp4".into(),
            width: None,
            height: None,
            duration_secs: None,
        };

        let uploader: VideoUploader = Box::new(|_input: VideoUploadInput| {
            Err("HTTP 401 Unauthorized".to_string())
        });

        let result = deliver_video_content(input, Some(&uploader));
        match result {
            VideoDeliveryResult::AuthError { .. } => {} // Expected
            _ => panic!("Expected AuthError"),
        }
    }

    #[test]
    fn test_build_inline_video_part() {
        let part = build_inline_video_part(b"hello", "video/mp4");
        assert!(part.starts_with("data:video/mp4;base64,"));
        assert!(part.len() > 20);
    }
}