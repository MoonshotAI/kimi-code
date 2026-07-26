/// Media — media processing (format validation, upload delegation).
///
/// Corresponds to `packages/agent-core-v2/src/agent/media/`.

/// Supported media types.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaType { Image, Audio, Video, Text }

/// Media processing result.
#[derive(Debug, Clone)]
pub struct ProcessedMedia {
    pub mime_type: String,
    pub data: Vec<u8>,
    pub media_type: MediaType,
}

/// Media validation and processing.
pub struct Media;

impl Media {
    /// Detect media type from MIME.
    pub fn detect_media_type(mime: &str) -> Option<MediaType> {
        match mime {
            m if m.starts_with("image/") => Some(MediaType::Image),
            m if m.starts_with("audio/") => Some(MediaType::Audio),
            m if m.starts_with("video/") => Some(MediaType::Video),
            m if m.starts_with("text/") || m == "application/json" => Some(MediaType::Text),
            _ => None,
        }
    }

    /// Check if a format is supported (not AVIF/HEIC for images).
    pub fn is_supported_format(mime: &str) -> bool {
        match mime {
            "image/avif" | "image/heic" | "image/heif" => false,
            _ => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_image() { assert_eq!(Media::detect_media_type("image/png"), Some(MediaType::Image)); }
    #[test]
    fn test_detect_audio() { assert_eq!(Media::detect_media_type("audio/wav"), Some(MediaType::Audio)); }
    #[test]
    fn test_detect_video() { assert_eq!(Media::detect_media_type("video/mp4"), Some(MediaType::Video)); }
    #[test]
    fn test_detect_text() { assert_eq!(Media::detect_media_type("text/plain"), Some(MediaType::Text)); }
    #[test]
    fn test_unsupported_format() { assert!(!Media::is_supported_format("image/avif")); }
    #[test]
    fn test_supported_format() { assert!(Media::is_supported_format("image/png")); }
    #[test]
    fn test_unknown_mime() { assert!(Media::detect_media_type("application/octet-stream").is_none()); }
}