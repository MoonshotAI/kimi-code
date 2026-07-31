/// Media token estimation — estimate LLM token costs for images, video, and text.
///
/// Corresponds to inline token estimation logic in the TS media module.
///
/// Provides:
/// - Image token estimation (tile-based)
/// - Video token estimation (per-second, resolution-based)
/// - Text token estimation (approximate character→token mapping)

use crate::media::image;

// ---------------------------------------------------------------------------
// Token estimation constants
// ---------------------------------------------------------------------------

/// Approximate text token ratio (chars per token for English text).
pub const CHARS_PER_TOKEN: f64 = 4.0;

/// Base tokens for the first image tile (512x512).
pub const BASE_IMAGE_TILE_TOKENS: u64 = 85;

/// Extra token cost per additional image tile beyond the first.
pub const EXTRA_IMAGE_TILE_TOKENS: u64 = 170;

/// Token cost per second per resolution tier: (min_dim_threshold, tokens_per_sec)
const VIDEO_TOKEN_TABLE: &[(u32, u64)] = &[
    // Resolution threshold (min dimension), tokens/sec
    (0, 258),      // SD (<= 360p)
    (361, 516),    // HD (361-480p)
    (481, 1032),   // Full HD (481-720p)
    (721, 2064),   // 4K/UHD (>720p)
];

// ---------------------------------------------------------------------------
// Image token estimation
// ---------------------------------------------------------------------------

/// Estimate the token cost of an image given its dimensions.
///
/// Tiles the image into 512px squares, with the first tile at a lower cost.
///
/// # Arguments
///
/// * `width` - Image width in pixels
/// * `height` - Image height in pixels
///
/// # Returns
///
/// Estimated token count.
pub fn estimate_image_tokens(width: u32, height: u32) -> u64 {
    image::estimate_image_tokens(width, height)
}

/// Estimate image tokens from raw image data (bytes).
///
/// Attempts to parse dimensions from the header, falling back to byte-based
/// estimation if the format cannot be parsed.
///
/// # Arguments
///
/// * `data` - Raw image file bytes
/// * `known_mime` - Optional MIME type hint
///
/// # Returns
///
/// Estimated token count.
pub fn estimate_image_tokens_from_bytes(data: &[u8], _known_mime: Option<&str>) -> u64 {
    // Try to parse dimensions from header
    if let Some(dims) = crate::media::image::sniff_image_dimensions(data) {
        return estimate_image_tokens(dims.width, dims.height);
    }

    // Fallback: estimate based on file size
    let megapixels = (data.len() as f64) / 1_000_000.0;
    let edge = (megapixels.sqrt() * 1000.0) as u32;
    estimate_image_tokens(edge, edge)
}

// ---------------------------------------------------------------------------
// Video token estimation
// ---------------------------------------------------------------------------

/// Estimate the token cost of a video.
///
/// Based on resolution tier and duration (defaults to 60s if duration is unknown).
///
/// # Arguments
///
/// * `width` - Video width in pixels
/// * `height` - Video height in pixels
/// * `duration_secs` - Duration in seconds (None = assume 60s)
///
/// # Returns
///
/// Estimated token count.
pub fn estimate_video_tokens(width: u32, height: u32, duration_secs: Option<f64>) -> u64 {
    crate::media::video::estimate_video_tokens(width, height, duration_secs)
}

/// Look up tokens-per-second for a given resolution tier.
pub fn tokens_per_second_for_resolution(width: u32, height: u32) -> u64 {
    let min_dim = width.min(height);
    let mut prev_tokens = 258u64;
    for &(threshold, tokens) in VIDEO_TOKEN_TABLE {
        if min_dim < threshold {
            break;
        }
        prev_tokens = tokens;
    }
    prev_tokens
}

// ---------------------------------------------------------------------------
// Text token estimation
// ---------------------------------------------------------------------------

/// Estimate token count from text string length.
///
/// Uses an approximate ratio of 4 characters per token (suitable for English text).
///
/// # Arguments
///
/// * `text` - The text to estimate
///
/// # Returns
///
/// Estimated token count.
pub fn estimate_text_tokens(text: &str) -> u64 {
    if text.is_empty() {
        return 0;
    }
    let chars = text.chars().count() as f64;
    let tokens = (chars / CHARS_PER_TOKEN).ceil() as u64;
    tokens.max(1)
}

/// A more precise text token estimate that accounts for whitespace normalization
/// and non-ASCII characters (which tend to consume more tokens).
///
/// # Arguments
///
/// * `text` - The text to estimate
///
/// # Returns
///
/// Estimated token count.
pub fn estimate_text_tokens_precise(text: &str) -> u64 {
    if text.is_empty() {
        return 0;
    }

    let chars = text.chars().count() as f64;

    // Estimate non-ASCII ratio (CJK characters are ~1.5-2 tokens each)
    let non_ascii_count = text.chars().filter(|c| !c.is_ascii()).count() as f64;
    let ascii_count = chars - non_ascii_count;

    // ASCII: ~4 chars/token, CJK/non-ASCII: ~1.5 chars/token
    let tokens =
        (ascii_count / CHARS_PER_TOKEN) + (non_ascii_count / 1.5);

    (tokens.ceil() as u64).max(1)
}

// ---------------------------------------------------------------------------
// Budget validation
// ---------------------------------------------------------------------------

/// Check if a file size is within the media budget.
pub fn is_within_media_budget(byte_size: u64) -> bool {
    byte_size <= crate::media::MAX_MEDIA_BYTES
}

/// Check if image data is within the per-image byte budget.
pub fn is_within_image_budget(byte_size: usize) -> bool {
    byte_size <= crate::media::IMAGE_BYTE_BUDGET
}

/// Check if image data is within the decode safety limit.
pub fn is_within_decode_budget(byte_size: usize) -> bool {
    byte_size <= crate::media::MAX_IMAGE_DECODE_BYTES
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimate_text_simple() {
        let tokens = estimate_text_tokens("hello world");
        assert_eq!(tokens, 3); // 11 chars / 4 = 2.75 → 3
    }

    #[test]
    fn estimate_text_empty() {
        assert_eq!(estimate_text_tokens(""), 0);
    }

    #[test]
    fn estimate_text_precise_ascii() {
        let tokens = estimate_text_tokens_precise("hello world");
        assert_eq!(tokens, 3);
    }

    #[test]
    fn estimate_text_precise_mixed() {
        // ASCII + CJK characters
        let tokens = estimate_text_tokens_precise("hello \u{4e2d}\u{56fd}");
        // 6 ASCII chars / 4 = 1.5, 2 CJK chars / 1.5 = 1.33, total = 2.83 → 3
        assert_eq!(tokens, 3);
    }

    #[test]
    fn tokens_per_second_sd() {
        assert_eq!(tokens_per_second_for_resolution(320, 240), 258);
    }

    #[test]
    fn tokens_per_second_hd() {
        assert_eq!(tokens_per_second_for_resolution(640, 480), 516);
    }

    #[test]
    fn tokens_per_second_full_hd() {
        assert_eq!(tokens_per_second_for_resolution(1280, 720), 1032);
    }

    #[test]
    fn tokens_per_second_ultra() {
        assert_eq!(tokens_per_second_for_resolution(1920, 1080), 2064);
    }

    #[test]
    fn budget_check_media() {
        assert!(is_within_media_budget(50 * 1024 * 1024));
        assert!(!is_within_media_budget(200 * 1024 * 1024));
    }

    #[test]
    fn budget_check_image() {
        assert!(is_within_image_budget(1_000_000));
        assert!(!is_within_image_budget(10_000_000));
    }

    #[test]
    fn budget_check_decode() {
        assert!(is_within_decode_budget(10_000_000));
        assert!(!is_within_decode_budget(100_000_000));
    }

    #[test]
    fn estimate_image_from_bytes() {
        // PNG header with 256x128 dimensions
        let mut data = vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
            0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
            0x00, 0x00, 0x01, 0x00, // width = 256
            0x00, 0x00, 0x00, 0x80, // height = 128
            0x08, 0x06, 0x00, 0x00, 0x00,
        ];
        data.resize(40, 0);
        let tokens = estimate_image_tokens_from_bytes(&data, Some("image/png"));
        assert!(tokens > 0);
        // 256x128 → 1 tile → 85 tokens
        assert_eq!(tokens, 85);
    }

    #[test]
    fn estimate_image_from_bytes_fallback() {
        // Random data that can't be parsed — use byte-size fallback
        let data = vec![0u8; 500_000]; // ~0.5MB → ~707x707 estimate
        let tokens = estimate_image_tokens_from_bytes(&data, None);
        assert!(tokens > 85); // More than 1 tile
    }
}