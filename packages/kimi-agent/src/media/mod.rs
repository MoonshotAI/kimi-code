/// Media — media processing (format validation, upload delegation).
///
/// Corresponds to `packages/agent-core-v2/src/agent/media/`.
///
/// Submodules:
/// - `file_type` — magic-byte + extension file-type detection
/// - `image` — header parsing, compression/crop pipeline
/// - `image_config` — image budget configuration
/// - `kimi_file_url` — `kimi-file://` URL parsing/resolution
/// - `http_downloader` — native reqwest-backed `FileDownloader`
/// - `read_media` — the ReadMedia tool's validation core
/// - `tokenizer` — image/video token estimation
/// - `video` — container detection and metadata extraction
/// - `webp_animated` — animated-WebP detection

pub mod file_type;
pub mod image;
pub mod image_config;
pub mod kimi_file_url;
pub mod http_downloader;
pub mod originals;
pub mod read_media;
pub mod tokenizer;
pub mod video;
pub mod video_delivery;
pub mod webp_animated;

use serde::{Deserialize, Serialize};

// Re-exported so `image.rs` can crop against the tool's region type.
pub use read_media::CropRegion;

// ---------------------------------------------------------------------------
// Shared budgets (values mirror `agent-core-v2/src/agent/media/*.ts`)
// ---------------------------------------------------------------------------

/// Byte budget for images sent to the model (3.75 MiB).
pub const IMAGE_BYTE_BUDGET: usize = 3 * 1024 * 1024 + 768 * 1024;
/// Longest edge for model-bound images.
pub const MAX_IMAGE_EDGE_PX: u32 = 2000;
/// Hard cap on the encoded bytes fed to the image decoder (64 MiB).
pub const MAX_IMAGE_DECODE_BYTES: usize = 64 * 1024 * 1024;
/// Hard cap on decoded pixels (100 MP) — decompression-bomb guard.
pub const MAX_DECODE_PIXELS: u64 = 100_000_000;
/// Maximum media file size accepted by the ReadMedia tool (100 MB).
pub const MAX_MEDIA_BYTES: u64 = 100 * 1024 * 1024;

/// Supported media types.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MediaType { Image, Audio, Video, Text }

/// Detected file type (magic bytes first, extension fallback).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileType {
    pub media_type: MediaType,
    pub mime: String,
    pub extension: String,
}

/// Parsed image metadata (from header sniffing).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageInfo {
    pub width: u32,
    pub height: u32,
    pub mime: String,
    pub has_alpha: bool,
    /// EXIF orientation value (1-8).
    pub orientation: u8,
    /// Whether display dimensions are swapped (orientation >= 5).
    pub transposed: bool,
    pub estimated_tokens: u64,
}

/// Parsed video metadata (from container headers).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoInfo {
    pub width: u32,
    pub height: u32,
    pub mime: String,
    pub container: String,
    pub duration_secs: Option<f64>,
    pub estimated_tokens: u64,
}

/// How compressed image data is delivered to the model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DeliveryMode {
    /// Unchanged passthrough (no compression attempted or needed).
    Passthrough,
    /// Already within budget — original bytes pass through.
    PassthroughWithinBudget,
    /// Could not decode/compress — original bytes pass through.
    PassthroughSkipped,
    /// Re-encoded to fit the byte budget.
    Compressed,
    /// Cropped to a caller-supplied region.
    Cropped,
    /// Full resolution explicitly requested (budget checks relaxed).
    FullResolution,
}

/// Result of the image compression pipeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompressionResult {
    pub changed: bool,
    /// Base64 data URL when re-encoded (`None` on passthrough).
    pub data: Option<String>,
    pub mime: String,
    pub original_width: u32,
    pub original_height: u32,
    pub original_bytes: usize,
    pub final_width: u32,
    pub final_height: u32,
    pub final_bytes: usize,
    pub delivery_mode: DeliveryMode,
    pub exif_transposed: bool,
}

/// Result of the image crop pipeline.
#[derive(Debug, Clone)]
pub struct CropResult {
    /// Outcome tag (`"cropped"`, `"decode_failed"`, `"too_large"`, …).
    pub outcome: String,
    /// Base64 data URL of the cropped image on success.
    pub data: Option<String>,
    pub mime: String,
    pub width: u32,
    pub height: u32,
    pub resized: bool,
}

/// Media processing result.
#[derive(Debug, Clone)]
pub struct ProcessedMedia {
    pub mime_type: String,
    pub data: Vec<u8>,
    pub media_type: MediaType,
}

/// Decode a base64 data URL (`data:<mime>;base64,<payload>`).
///
/// Returns `(mime, bytes)`, or `None` when the string is not a base64 data
/// URL or the payload fails to decode.
pub fn decode_data_url(data_url: &str) -> Option<(String, Vec<u8>)> {
    let rest = data_url.strip_prefix("data:")?;
    let (mime, payload) = rest.split_once(";base64,")?;
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, payload).ok()?;
    Some((mime.trim().to_ascii_lowercase(), bytes))
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