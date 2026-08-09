/// Image processing — format policy, info parsing, size estimation.
///
/// Corresponds to `packages/agent-core-v2/src/agent/media/image-format-policy.ts`
/// and `image-compress.ts`.
///
/// Provides:
/// - Format allowlist/denylist for model providers
/// - Image info extraction from file headers (PNG, JPEG, GIF, WebP, BMP)
/// - Image dimension and token estimation
/// - EXIF orientation handling

use serde::{Deserialize, Serialize};
use image::ImageEncoder;

// ---------------------------------------------------------------------------
// Format policy
// ---------------------------------------------------------------------------

/// MIME types accepted by model providers (allowlist).
pub const MODEL_ACCEPTED_IMAGE_MIMES: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
];

/// Unsupported image formats with their Linux decoder hints.
pub const UNSUPPORTED_IMAGE_FORMATS: &[(&str, Option<&str>)] = &[
    ("image/avif", None),
    ("image/heic", Some("heif-convert (package: libheif-examples)")),
    ("image/heif", Some("heif-convert (package: libheif-examples)")),
    ("image/bmp", None),
    ("image/tiff", None),
    ("image/x-icon", None),
];

// ---------------------------------------------------------------------------
// Compression constants
// ---------------------------------------------------------------------------

/// JPEG quality degradation steps (lowest quality first in attempt order).
pub const JPEG_QUALITY_STEPS: &[u8] = &[80, 60, 40, 20];

/// Dimension fallback steps (largest first).
pub const FALLBACK_EDGES_PX: &[u32] = &[2000, 1000, 768, 512, 384, 256];

/// PNG rescale threshold: do not scale below this edge size.
pub const PNG_RESCALE_FLOOR_PX: u32 = 1000;

/// MIME types that can be recoded (re-encoded to a different format).
pub const RECODABLE_MIME: &[&str] = &["image/png", "image/jpeg", "image/webp"];

// ---------------------------------------------------------------------------
// Image dimensions (parsed from header)
// ---------------------------------------------------------------------------

/// Image dimensions parsed from file headers.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ImageDimensions {
    pub width: u32,
    pub height: u32,
    /// EXIF orientation value (1-8).  1 = normal, 5-8 = rotated.
    pub orientation: u8,
    /// Whether the display dimensions are swapped (orientation >= 5).
    pub transposed: bool,
    /// Whether the image has an alpha channel.
    pub has_alpha: bool,
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

/// Parse image dimensions from PNG header bytes.
///
/// PNG IHDR is at offset 16 (after 8-byte signature + 4-byte length + 4-byte "IHDR").
/// Width at offset 16, height at offset 20 (both big-endian u32).
fn parse_png_dimensions(data: &[u8]) -> Option<ImageDimensions> {
    if data.len() < 24 {
        return None;
    }
    let width = u32::from_be_bytes([data[16], data[17], data[18], data[19]]);
    let height = u32::from_be_bytes([data[20], data[21], data[22], data[23]]);
    let _bit_depth = data.get(24).copied().unwrap_or(8);
    let color_type = data.get(25).copied().unwrap_or(2);
    // color_type: 0=grayscale, 2=RGB, 3=indexed, 4=grayscale+alpha, 6=RGBA
    let has_alpha = color_type == 4 || color_type == 6;
    Some(ImageDimensions {
        width,
        height,
        orientation: 1,
        transposed: false,
        has_alpha,
    })
}

/// Parse image dimensions from JPEG header bytes.
///
/// Walks JPEG segments (0xFF 0xE0-0xEF) until SOF0 (0xFF 0xC0/0xC1/0xC2)
/// is found.  Also reads EXIF orientation tag (0x0112) from APP1 segment.
fn parse_jpeg_dimensions(data: &[u8]) -> Option<ImageDimensions> {
    if data.len() < 4 || data[0..2] != [0xFF, 0xD8] {
        return None;
    }

    let mut offset = 2;
    let mut orientation: u8 = 1;

    while offset + 4 <= data.len() {
        // Each segment starts with FF marker
        if data[offset] != 0xFF {
            break;
        }
        let marker = data[offset + 1];
        if marker == 0xD9 {
            // EOI
            break;
        }

        // SOF0/1/2 — contains dimensions
        if marker == 0xC0 || marker == 0xC1 || marker == 0xC2 {
            if offset + 9 <= data.len() {
                let height =
                    u16::from_be_bytes([data[offset + 5], data[offset + 6]]);
                let width =
                    u16::from_be_bytes([data[offset + 7], data[offset + 8]]);
                let transposed = orientation >= 5;
                let (w, h) = if transposed {
                    (height as u32, width as u32)
                } else {
                    (width as u32, height as u32)
                };
                return Some(ImageDimensions {
                    width: w,
                    height: h,
                    orientation,
                    transposed,
                    has_alpha: false,
                });
            }
            break;
        }

        // SOS — no more metadata after this
        if marker == 0xDA {
            break;
        }

        // APP1 (0xE1) — may contain EXIF
        if marker == 0xE1 && offset + 8 <= data.len() {
            let seg_len =
                u16::from_be_bytes([data[offset + 2], data[offset + 3]]) as usize;
            if seg_len >= 8 {
                // Check for "Exif\0\0"
                if offset + 4 + 6 <= data.len()
                    && &data[offset + 4..offset + 10] == b"Exif\0\0"
                {
                    if let Some(orient) = read_exif_orientation(&data[offset + 10..], seg_len - 6) {
                        orientation = orient;
                    }
                }
            }
            offset += seg_len + 2;
            continue;
        }

        // Other segment: skip
        if marker == 0x01 || marker == 0xD0 || marker == 0xD1
            || marker == 0xD2 || marker == 0xD3 || marker == 0xD4
            || marker == 0xD5 || marker == 0xD6 || marker == 0xD7
        {
            // No-length markers
            offset += 2;
        } else {
            let seg_len =
                u16::from_be_bytes([data[offset + 2], data[offset + 3]]) as usize;
            offset += seg_len + 2;
        }
    }

    None
}

/// Read EXIF orientation tag (0x0112) from TIFF IFD0.
///
/// `data` begins at the TIFF header (after the "Exif\0\0" preamble).
fn read_exif_orientation(data: &[u8], _max_len: usize) -> Option<u8> {
    if data.len() < 8 {
        return None;
    }
    // TIFF header: byte order marker
    let (is_little_endian, offset_to_ifd) = if data[0..2] == *b"II" {
        // Little-endian
        if data.len() < 8 {
            return None;
        }
        let off = u32::from_le_bytes([data[4], data[5], data[6], data[7]]);
        (true, off as usize)
    } else if data[0..2] == *b"MM" {
        // Big-endian
        if data.len() < 8 {
            return None;
        }
        let off = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);
        (false, off as usize)
    } else {
        return None;
    };

    if offset_to_ifd + 2 > data.len() {
        return None;
    }

    let num_entries = if is_little_endian {
        u16::from_le_bytes([data[offset_to_ifd], data[offset_to_ifd + 1]])
    } else {
        u16::from_be_bytes([data[offset_to_ifd], data[offset_to_ifd + 1]])
    } as usize;

    for i in 0..num_entries {
        let entry_offset = offset_to_ifd + 2 + i * 12;
        if entry_offset + 12 > data.len() {
            break;
        }
        let tag = if is_little_endian {
            u16::from_le_bytes([data[entry_offset], data[entry_offset + 1]])
        } else {
            u16::from_be_bytes([data[entry_offset], data[entry_offset + 1]])
        };
        if tag == 0x0112 {
            // Orientation tag, type SHORT (3), single value in the offset field
            let value = if is_little_endian {
                u16::from_le_bytes([data[entry_offset + 8], data[entry_offset + 9]])
            } else {
                u16::from_be_bytes([data[entry_offset + 8], data[entry_offset + 9]])
            };
            if (1..=8).contains(&value) {
                return Some(value as u8);
            }
            return None;
        }
    }

    None
}

/// Apply an EXIF orientation value (1-8) to a decoded image via the
/// `image` crate's standard mapping (native codec `apply_orientation`
/// parity); invalid values are left untouched.
fn apply_exif_orientation(mut img: image::DynamicImage, orientation: u8) -> image::DynamicImage {
    if let Some(o) = image::metadata::Orientation::from_exif(orientation) {
        img.apply_orientation(o);
    }
    img
}

/// Parse image dimensions from GIF header bytes.
///
/// GIF header: 6 bytes signature + 7 bytes Logical Screen Descriptor.
/// Width at offset 6, height at offset 8 (both little-endian u16).
fn parse_gif_dimensions(data: &[u8]) -> Option<ImageDimensions> {
    if data.len() < 10 {
        return None;
    }
    let width = u16::from_le_bytes([data[6], data[7]]) as u32;
    let height = u16::from_le_bytes([data[8], data[9]]) as u32;
    Some(ImageDimensions {
        width,
        height,
        orientation: 1,
        transposed: false,
        has_alpha: true,
    })
}

/// Parse image dimensions from BMP header bytes.
///
/// BMP: offset 18 = width (i32 LE), offset 22 = height (i32 LE, absolute).
fn parse_bmp_dimensions(data: &[u8]) -> Option<ImageDimensions> {
    if data.len() < 26 {
        return None;
    }
    let width = i32::from_le_bytes([data[18], data[19], data[20], data[21]]);
    let height_raw =
        i32::from_le_bytes([data[22], data[23], data[24], data[25]]);
    let height = height_raw.unsigned_abs();
    if width <= 0 || height == 0 {
        return None;
    }
    Some(ImageDimensions {
        width: width as u32,
        height,
        orientation: 1,
        transposed: false,
        has_alpha: false,
    })
}

/// Parse image dimensions from WebP header bytes (RIFF + VP8/VP8L/VP8X).
fn parse_webp_dimensions(data: &[u8]) -> Option<ImageDimensions> {
    if data.len() < 30 {
        return None;
    }
    let chunk_type = u32::from_le_bytes([data[8], data[9], data[10], data[11]]);
    let webp_chunk_type = u32::from_le_bytes(*b"WEBP");
    if chunk_type != webp_chunk_type {
        return None;
    }

    // VP8: simple lossy, 12 bytes after chunk header
    if data.len() >= 12 + 8 && &data[12..16] == b"VP8 " {
        if data.len() >= 12 + 12 {
            let raw =
                u32::from_le_bytes([data[23], data[24], data[25], data[26]]);
            let width = raw & 0x3FFF;
            let height = (raw >> 16) & 0x3FFF;
            return Some(ImageDimensions {
                width,
                height,
                orientation: 1,
                transposed: false,
                has_alpha: false,
            });
        }
    }

    // VP8L: lossless, 5 bytes after chunk header
    if data.len() >= 12 + 8 && &data[12..16] == b"VP8L" {
        if data.len() >= 12 + 9 {
            let raw =
                u32::from_le_bytes([data[21], data[22], data[23], data[24]]);
            let width = (raw & 0x3FFF) + 1;
            let height = ((raw >> 14) & 0x3FFF) + 1;
            return Some(ImageDimensions {
                width,
                height,
                orientation: 1,
                transposed: false,
                has_alpha: true,
            });
        }
    }

    // VP8X: extended, has 10-byte features field
    if data.len() >= 12 + 8 && &data[12..16] == b"VP8X" {
        if data.len() >= 30 {
            let has_alpha = data[20] & 0x10 != 0;
            let w1 = data[24] as u32;
            let w2 = data[25] as u32;
            let w3 = data[26] as u32;
            let h1 = data[27] as u32;
            let h2 = data[28] as u32;
            let h3 = data[29] as u32;
            let width = ((w3 << 16) | (w2 << 8) | w1) + 1;
            let height = ((h3 << 16) | (h2 << 8) | h1) + 1;
            return Some(ImageDimensions {
                width,
                height,
                orientation: 1,
                transposed: false,
                has_alpha,
            });
        }
    }

    None
}

// ---------------------------------------------------------------------------
// Main entry points
// ---------------------------------------------------------------------------

/// Parse image dimensions from raw file bytes by sniffing the format.
///
/// Supports: PNG, JPEG, GIF, BMP, WebP.
pub fn sniff_image_dimensions(data: &[u8]) -> Option<ImageDimensions> {
    if data.is_empty() {
        return None;
    }

    // Check magic bytes to determine format
    if data.len() >= 8 && data[0..4] == [0x89, 0x50, 0x4E, 0x47] {
        return parse_png_dimensions(data);
    }
    if data.len() >= 3 && data[0..3] == [0xFF, 0xD8, 0xFF] {
        return parse_jpeg_dimensions(data);
    }
    if data.len() >= 6
        && (data[0..6] == *b"GIF87a" || data[0..6] == *b"GIF89a")
    {
        return parse_gif_dimensions(data);
    }
    if data.len() >= 2 && data[0..2] == *b"BM" {
        return parse_bmp_dimensions(data);
    }
    if data.len() >= 12 && data[0..4] == *b"RIFF" {
        return parse_webp_dimensions(data);
    }

    None
}

/// Normalize a MIME type: trim, lowercase, strip parameters, map `image/jpg` → `image/jpeg`.
pub fn normalize_image_mime(mime: &str) -> String {
    let mime = mime.trim().to_lowercase();
    let mime = if let Some(semi) = mime.find(';') {
        mime[..semi].trim().to_string()
    } else {
        mime
    };
    if mime == "image/jpg" {
        "image/jpeg".to_string()
    } else {
        mime
    }
}

/// Check if a MIME type is accepted by model providers.
pub fn is_model_accepted_image_mime(mime: &str) -> bool {
    let normalized = normalize_image_mime(mime);
    MODEL_ACCEPTED_IMAGE_MIMES.contains(&normalized.as_str())
}

/// Check if a MIME type can be recoded (re-encoded).
pub fn is_recodable_mime(mime: &str) -> bool {
    let normalized = normalize_image_mime(mime);
    RECODABLE_MIME.contains(&normalized.as_str())
}

/// Get conversion guidance text for an unsupported image format.
pub fn build_unsupported_image_notice(mime: &str) -> String {
    let _ext = mime.rsplit('/').next().unwrap_or("unknown");
    format!(
        "[Image omitted: unsupported format `{mime}`. \
         Convert to JPEG or PNG using an image editing tool.]"
    )
}

/// Build a notice for malformed data URLs.
pub fn build_malformed_image_notice(url: &str) -> String {
    let truncated = if url.len() > 80 {
        format!("{}...", &url[..80])
    } else {
        url.to_string()
    };
    format!(
        "[Image omitted: malformed data URL `{truncated}`. \
         Re-encode as PNG or JPEG.]"
    )
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/// Estimate the token cost of an image given its dimensions.
///
/// Based on the standard approach used by model providers:
/// - Tile the image into 512px squares
/// - Each tile costs a fixed number of tokens
/// - The first tile is the cheapest, subsequent tiles cost more
pub fn estimate_image_tokens(width: u32, height: u32) -> u64 {
    // Scale down to 2048 max edge (standard model preprocessing)
    let (w, h) = scale_down_to_max_edge(width, height, 2048);

    // Calculate tiles: each tile is up to 512x512
    let tiles_x = (w + 511) / 512;
    let tiles_y = (h + 511) / 512;
    let total_tiles = tiles_x * tiles_y;

    // Token cost: base tile + extra tiles
    // Approximate: 85 tokens for the first "base" tile, 170 for each additional
    if total_tiles == 0 {
        return 0;
    }
    let base_tokens: u64 = 85;
    let extra_tokens: u64 = 170;
    base_tokens + (extra_tokens * (total_tiles as u64 - 1))
}

/// Scale down dimensions so the longest edge does not exceed `max_edge`.
pub fn scale_down_to_max_edge(
    width: u32,
    height: u32,
    max_edge: u32,
) -> (u32, u32) {
    let max = width.max(height);
    if max > max_edge {
        let ratio = max_edge as f64 / max as f64;
        (
            (width as f64 * ratio).round() as u32,
            (height as f64 * ratio).round() as u32,
        )
    } else {
        (width, height)
    }
}

// ---------------------------------------------------------------------------
// Image compression pipeline
// ---------------------------------------------------------------------------

use crate::media::{
    CompressionResult, CropResult, DeliveryMode,
    IMAGE_BYTE_BUDGET, MAX_DECODE_PIXELS, MAX_IMAGE_DECODE_BYTES,
    MAX_IMAGE_EDGE_PX,
};

/// Compress an image to fit within the model's byte budget.
///
/// Uses a ladder strategy:
/// 1. First tries to reduce dimensions (preserves quality better)
/// 2. Then reduces JPEG quality
/// 3. Falls back to the original data if neither helps
///
/// # Arguments
///
/// * `data` - Raw image file bytes
/// * `mime` - MIME type of the image
/// * `fallback_edges` - Dimension fallback steps (largest first), e.g. `[2000, 1000, 768, 512, 384, 256]`
/// * `jpeg_quality_steps` - JPEG quality degradation steps, e.g. `[80, 60, 40, 20]`
///
/// # Returns
///
/// `CompressionResult` describing whether the image was changed and the result.
pub fn compress_image_for_model(
    data: &[u8],
    mime: &str,
    fallback_edges: &[u32],
    jpeg_quality_steps: &[u8],
) -> CompressionResult {
    let original_bytes = data.len();
    let mime = normalize_image_mime(mime);

    // Parse original dimensions
    let dims = sniff_image_dimensions(data);
    let (original_width, original_height) = dims
        .map(|d| (d.width, d.height))
        .unwrap_or((0, 0));

    // Quick check: if the image is already within budget, pass through
    if original_bytes <= IMAGE_BYTE_BUDGET {
        let exif_transposed = dims.map(|d| d.transposed).unwrap_or(false);
        return CompressionResult {
            changed: false,
            data: None,
            mime: mime.clone(),
            original_width,
            original_height,
            original_bytes,
            final_width: original_width,
            final_height: original_height,
            final_bytes: original_bytes,
            delivery_mode: DeliveryMode::PassthroughWithinBudget,
            exif_transposed,
        };
    }

    // Try to compress using the `image` crate
    try_compress_with_image_crate(
        data, &mime, dims, original_width, original_height,
        original_bytes, fallback_edges, jpeg_quality_steps,
    )
}

/// Attempt to compress image data using the `image` crate.
fn try_compress_with_image_crate(
    data: &[u8],
    mime: &str,
    dims: Option<ImageDimensions>,
    original_width: u32,
    original_height: u32,
    original_bytes: usize,
    fallback_edges: &[u32],
    jpeg_quality_steps: &[u8],
) -> CompressionResult {
    let exif_transposed = dims.map(|d| d.transposed).unwrap_or(false);

    // Load the image using the `image` crate
    let mut img = match image::load_from_memory(data) {
        Ok(img) => img,
        Err(_) => {
            // Cannot decode; pass through unchanged
            return CompressionResult {
                changed: false,
                data: None,
                mime: mime.to_string(),
                original_width,
                original_height,
                original_bytes,
                final_width: original_width,
                final_height: original_height,
                final_bytes: original_bytes,
                delivery_mode: DeliveryMode::PassthroughSkipped,
                exif_transposed,
            };
        }
    };

    // Apply the EXIF orientation parsed from the JPEG header — the `image`
    // crate decoder does not auto-apply it, so portrait photos taken on
    // phones/cameras would be compressed in their physical orientation
    // (native codec parity). Dimensions bookkeeping above already swaps
    // w/h via `exif_transposed` for orientations 5-8.
    if let Some(dims) = dims {
        img = apply_exif_orientation(img, dims.orientation);
    }

    let (orig_w, orig_h) = (img.width(), img.height());

    // Determine output format
    let is_lossy = mime == "image/jpeg";
    let png_floor = PNG_RESCALE_FLOOR_PX;

    // Try dimension reduction first (preserves quality better)
    for &edge in fallback_edges {
        let (w, h) = scale_down_to_max_edge(orig_w, orig_h, edge);

        // For PNG, don't scale below the floor
        if !is_lossy && (w.max(h) < png_floor) {
            continue;
        }

        if w == orig_w && h == orig_h {
            // Same size; skip to next step
            continue;
        }

        let resized = img.resize_exact(
            w, h,
            image::imageops::FilterType::Lanczos3,
        );

        // Try encoding at different quality levels
        if is_lossy {
            let rgb = resized.to_rgb8();
            let raw = rgb.as_raw();
            for &quality in jpeg_quality_steps {
                let mut buf = Vec::new();
                let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(
                    &mut buf,
                    quality,
                );
                if encoder.encode(raw, w, h, image::ExtendedColorType::Rgb8).is_ok()
                    && buf.len() <= IMAGE_BYTE_BUDGET
                {
                    let b64 = base64::Engine::encode(
                        &base64::engine::general_purpose::STANDARD,
                        &buf,
                    );
                    let data_url = format!("data:image/jpeg;base64,{b64}");
                    return CompressionResult {
                        changed: true,
                        data: Some(data_url),
                        mime: "image/jpeg".to_string(),
                        original_width,
                        original_height,
                        original_bytes,
                        final_width: w,
                        final_height: h,
                        final_bytes: buf.len(),
                        delivery_mode: DeliveryMode::Compressed,
                        exif_transposed,
                    };
                }
            }
        }

        // Try PNG/WebP encoding (lossless or minimal quality loss)
        {
            let rgba = resized.to_rgba8();
            let raw = rgba.as_raw();
            let mut buf = Vec::new();
            if mime == "image/webp" {
                let encoder = image::codecs::webp::WebPEncoder::new_lossless(&mut buf);
                if encoder.encode(raw, w, h, image::ExtendedColorType::Rgba8).is_ok()
                    && buf.len() <= IMAGE_BYTE_BUDGET
                {
                    let b64 = base64::Engine::encode(
                        &base64::engine::general_purpose::STANDARD,
                        &buf,
                    );
                    let data_url = format!("data:image/webp;base64,{b64}");
                    return CompressionResult {
                        changed: true,
                        data: Some(data_url),
                        mime: "image/webp".to_string(),
                        original_width,
                        original_height,
                        original_bytes,
                        final_width: w,
                        final_height: h,
                        final_bytes: buf.len(),
                        delivery_mode: DeliveryMode::Compressed,
                        exif_transposed,
                    };
                }
            } else {
                let encoder = image::codecs::png::PngEncoder::new(&mut buf);
                if encoder.write_image(raw, w, h, image::ExtendedColorType::Rgba8).is_ok()
                    && buf.len() <= IMAGE_BYTE_BUDGET
                {
                    let b64 = base64::Engine::encode(
                        &base64::engine::general_purpose::STANDARD,
                        &buf,
                    );
                    let data_url = format!("data:image/png;base64,{b64}");
                    return CompressionResult {
                        changed: true,
                        data: Some(data_url),
                        mime: "image/png".to_string(),
                        original_width,
                        original_height,
                        original_bytes,
                        final_width: w,
                        final_height: h,
                        final_bytes: buf.len(),
                        delivery_mode: DeliveryMode::Compressed,
                        exif_transposed,
                    };
                }
            }
        }

        // Check if this dimension reduction alone satisfies the budget
        // (re-encode at max quality)
        if is_lossy {
            let rgb = resized.to_rgb8();
            let raw = rgb.as_raw();
            let mut buf = Vec::new();
            let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(
                &mut buf,
                90,
            );
            if encoder.encode(raw, w, h, image::ExtendedColorType::Rgb8).is_ok()
                && buf.len() <= IMAGE_BYTE_BUDGET
            {
                let b64 = base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    &buf,
                );
                let data_url = format!("data:image/jpeg;base64,{b64}");
                return CompressionResult {
                    changed: true,
                    data: Some(data_url),
                    mime: "image/jpeg".to_string(),
                    original_width,
                    original_height,
                    original_bytes,
                    final_width: w,
                    final_height: h,
                    final_bytes: buf.len(),
                    delivery_mode: DeliveryMode::Compressed,
                    exif_transposed,
                };
            }
        }
    }

    // If dimension reduction didn't work, try quality-only reduction for JPEG
    if is_lossy {
        // No dimension change — just re-encode with lower quality
        let (w, h) = (orig_w, orig_h);
        let rgb = img.to_rgb8();
        let raw = rgb.as_raw();
        for &quality in jpeg_quality_steps {
            let mut buf = Vec::new();
            let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(
                &mut buf,
                quality,
            );
            if encoder.encode(raw, w, h, image::ExtendedColorType::Rgb8).is_ok()
                && buf.len() <= IMAGE_BYTE_BUDGET
            {
                let b64 = base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    &buf,
                );
                let data_url = format!("data:image/jpeg;base64,{b64}");
                return CompressionResult {
                    changed: true,
                    data: Some(data_url),
                    mime: "image/jpeg".to_string(),
                    original_width,
                    original_height,
                    original_bytes,
                    final_width: w,
                    final_height: h,
                    final_bytes: buf.len(),
                    delivery_mode: DeliveryMode::Compressed,
                    exif_transposed,
                };
            }
        }
    }

    // Nothing helped — pass through unchanged
    CompressionResult {
        changed: false,
        data: None,
        mime: mime.to_string(),
        original_width,
        original_height,
        original_bytes,
        final_width: original_width,
        final_height: original_height,
        final_bytes: original_bytes,
        delivery_mode: DeliveryMode::Passthrough,
        exif_transposed,
    }
}

/// Crop a region from an image and optionally compress the result.
///
/// # Arguments
///
/// * `data` - Raw image file bytes
/// * `mime` - MIME type of the image
/// * `region` - Crop region in pixel coordinates
/// * `resize` - Whether to resize the cropped region to fit within the budget
///
/// # Returns
///
/// `CropResult` describing the outcome.
pub fn crop_image_for_model(
    data: &[u8],
    mime: &str,
    region: &crate::media::CropRegion,
    resize: bool,
) -> CropResult {
    if data.is_empty() {
        return CropResult {
            outcome: "empty".to_string(),
            data: None,
            mime: mime.to_string(),
            width: 0,
            height: 0,
            resized: false,
        };
    }

    let mime = normalize_image_mime(mime);

    // Check if format is supported (not animated WebP, etc.)
    if !is_recodable_mime(&mime) && mime != "image/gif" {
        return CropResult {
            outcome: "unsupported_format".to_string(),
            data: None,
            mime,
            width: 0,
            height: 0,
            resized: false,
        };
    }

    // Validate region coordinates (non-zero area)
    if region.width == 0 || region.height == 0 {
        return CropResult {
            outcome: "region_invalid".to_string(),
            data: None,
            mime,
            width: 0,
            height: 0,
            resized: false,
        };
    }

    // Load the image
    let mut img = match image::load_from_memory(data) {
        Ok(img) => img,
        Err(_) => {
            return CropResult {
                outcome: "decode_failed".to_string(),
                data: None,
                mime,
                width: 0,
                height: 0,
                resized: false,
            };
        }
    };

    let (img_w, img_h) = (img.width(), img.height());

    // Check pixel budget
    let total_pixels = img_w as u64 * img_h as u64;
    if total_pixels > MAX_DECODE_PIXELS || data.len() > MAX_IMAGE_DECODE_BYTES {
        return CropResult {
            outcome: "too_large".to_string(),
            data: None,
            mime,
            width: 0,
            height: 0,
            resized: false,
        };
    }

    // Clamp region to image bounds
    let x = region.x.min(img_w);
    let y = region.y.min(img_h);
    let w = region.width.min(img_w - x);
    let h = region.height.min(img_h - y);

    if w == 0 || h == 0 {
        return CropResult {
            outcome: "region_empty".to_string(),
            data: None,
            mime,
            width: 0,
            height: 0,
            resized: false,
        };
    }

    // Crop the image
    let cropped_img = img.crop(x, y, w, h);

    let (final_w, final_h, final_img) = if resize {
        // Scale down if needed to fit within budget
        let (scaled_w, scaled_h) = scale_down_to_max_edge(w, h, MAX_IMAGE_EDGE_PX);
        if scaled_w != w || scaled_h != h {
            let resized_img = cropped_img.resize_exact(
                scaled_w, scaled_h,
                image::imageops::FilterType::Lanczos3,
            );
            (scaled_w, scaled_h, resized_img)
        } else {
            (w, h, cropped_img)
        }
    } else {
        (w, h, cropped_img)
    };

    // Encode as JPEG (lossy, reasonable quality)
    let rgb = final_img.to_rgb8();
    let raw = rgb.as_raw();
    let mut buf = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(
        &mut buf,
        85,
    );
    match encoder.encode(raw, final_w, final_h, image::ExtendedColorType::Rgb8) {
        Ok(_) => {
            let b64 = base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                &buf,
            );
            let data_url = format!("data:image/jpeg;base64,{b64}");
            CropResult {
                outcome: "cropped".to_string(),
                data: Some(data_url),
                mime: "image/jpeg".to_string(),
                width: final_w,
                height: final_h,
                resized: resize && (final_w != w || final_h != h),
            }
        }
        Err(_) => CropResult {
            outcome: "encode_failed".to_string(),
            data: None,
            mime: "image/jpeg".to_string(),
            width: 0,
            height: 0,
            resized: false,
        },
    }
}

/// Compress a base64-encoded data URL image for model consumption.
///
/// # Arguments
///
/// * `data_url` - Base64 data URL (e.g. `data:image/png;base64,...`)
/// * `fallback_edges` - Dimension fallback steps
/// * `jpeg_quality_steps` - JPEG quality degradation steps
///
/// # Returns
///
/// `CompressionResult` describing whether the image was changed.
pub fn compress_base64_for_model(
    data_url: &str,
    fallback_edges: &[u32],
    jpeg_quality_steps: &[u8],
) -> CompressionResult {
    // Decode the data URL
    let (mime, data) = match crate::media::decode_data_url(data_url) {
        Some(result) => result,
        None => {
            return CompressionResult {
                changed: false,
                data: None,
                mime: "unknown".to_string(),
                original_width: 0,
                original_height: 0,
                original_bytes: 0,
                final_width: 0,
                final_height: 0,
                final_bytes: 0,
                delivery_mode: DeliveryMode::Passthrough,
                exif_transposed: false,
            };
        }
    };

    let original_bytes = data.len();

    // Estimate base64-decoded size to guard against oversized data
    // Rough estimate: base64 overhead is ~33%, so a 3.75MB budget for
    // base64-encoded data means ~2.8MB decoded
    let estimated_encoded_budget = IMAGE_BYTE_BUDGET + IMAGE_BYTE_BUDGET / 3;
    if original_bytes > estimated_encoded_budget {
        return CompressionResult {
            changed: false,
            data: None,
            mime: mime.clone(),
            original_width: 0,
            original_height: 0,
            original_bytes,
            final_width: 0,
            final_height: 0,
            final_bytes: original_bytes,
            delivery_mode: DeliveryMode::PassthroughSkipped,
            exif_transposed: false,
        };
    }

    compress_image_for_model(&data, &mime, fallback_edges, jpeg_quality_steps)
}

/// Filter image content parts: reject unsupported formats, normalize MIME types.
///
/// Returns a list of (is_valid, part) tuples where `is_valid` is `true` if the
/// part passed format gating, and `false` if the image was replaced with a
/// textual notice.
pub fn gate_image_format_parts(
    parts: &[ImageContentPart],
) -> Vec<GatedImagePart> {
    parts.iter().map(|part| {
        let mime = normalize_image_mime(&part.mime);
        if is_model_accepted_image_mime(&mime) {
            GatedImagePart {
                accepted: true,
                mime: Some(mime),
                part: part.clone(),
                notice: None,
            }
        } else {
            let notice = if mime == "unknown" || mime.is_empty() {
                build_malformed_image_notice(&part.url)
            } else {
                build_unsupported_image_notice(&mime)
            };
            GatedImagePart {
                accepted: false,
                mime: None,
                part: part.clone(),
                notice: Some(notice),
            }
        }
    }).collect()
}

/// A content part representing an image (simplified version).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageContentPart {
    /// The MIME type from the data URL or file header.
    pub mime: String,
    /// The data URL or file path.
    pub url: String,
}

/// Result of gating a single image content part.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatedImagePart {
    /// Whether the format was accepted by the model.
    pub accepted: bool,
    /// The normalized MIME type (only present if accepted).
    pub mime: Option<String>,
    /// The original part reference.
    pub part: ImageContentPart,
    /// A textual notice replacing the image (only present if rejected).
    pub notice: Option<String>,
}

/// Run the full compression pipeline on a list of image content parts.
///
/// 1. Gate formats (reject unsupported)
/// 2. Compress each accepted image
/// 3. Build compression annotations
///
/// # Arguments
///
/// * `parts` - Image content parts to process
/// * `fallback_edges` - Dimension fallback steps
/// * `jpeg_quality_steps` - JPEG quality degradation steps
/// * `annotate` - Whether to build compression annotations
///
/// # Returns
///
/// A list of `CompressedContentPart` with the processed results.
pub fn compress_image_content_parts(
    parts: &[ImageContentPart],
    fallback_edges: &[u32],
    jpeg_quality_steps: &[u8],
    annotate: bool,
) -> Vec<CompressedContentPart> {
    let gated = gate_image_format_parts(parts);

    gated.into_iter().map(|g| {
        if !g.accepted {
            return CompressedContentPart {
                accepted: false,
                data: g.notice.unwrap_or_default(),
                compression_result: None,
                annotation: None,
                mime: None,
            };
        }

        let mime = g.mime.unwrap_or_default();
        let data_url = &g.part.url;

        let compression = compress_base64_for_model(data_url, fallback_edges, jpeg_quality_steps);

        let annotation = if annotate && compression.changed {
            let caption = build_image_compression_caption(&compression, None);
            Some(caption)
        } else {
            None
        };

        CompressedContentPart {
            accepted: true,
            data: compression.data.clone().unwrap_or_else(|| data_url.clone()),
            compression_result: Some(compression),
            annotation,
            mime: Some(mime),
        }
    }).collect()
}

/// A single compressed content part in the pipeline output.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompressedContentPart {
    /// Whether the format was accepted and compressed.
    pub accepted: bool,
    /// The resulting data URL or textual notice.
    pub data: String,
    /// Compression result details (only if accepted and compressed).
    pub compression_result: Option<CompressionResult>,
    /// Compression annotation text (only if annotate was enabled).
    pub annotation: Option<String>,
    /// The normalized MIME type.
    pub mime: Option<String>,
}

/// Build a compression annotation caption describing how the image was modified.
///
/// The caption is wrapped in `<system>...</system>` tags for extraction.
///
/// # Arguments
///
/// * `result` - The compression result
/// * `original_path` - Optional original file path for the saved unmodified image
///
/// # Returns
///
/// A `<system>`-wrapped caption string.
pub fn build_image_compression_caption(
    result: &CompressionResult,
    original_path: Option<&str>,
) -> String {
    let mode = match result.delivery_mode {
        DeliveryMode::Compressed => "compressed",
        DeliveryMode::Cropped => "cropped",
        DeliveryMode::Passthrough => "unchanged",
        DeliveryMode::PassthroughWithinBudget => "within budget",
        DeliveryMode::PassthroughSkipped => "skipped",
        DeliveryMode::FullResolution => "full resolution",
    };

    let mut caption = format!(
        "Image compressed to fit model limits: {mode} | \
         original: {}x{} px, {} bytes | \
         final: {}x{} px, {} bytes",
        result.original_width, result.original_height, result.original_bytes,
        result.final_width, result.final_height, result.final_bytes,
    );

    if let Some(path) = original_path {
        caption.push_str(&format!(
            " | original unmodified file saved at: {path}"
        ));
    }

    format!("<system>{caption}</system>")
}

/// Extract all `<system>Image compressed to fit model limits:...</system>`
/// captions from a text string.
///
/// # Arguments
///
/// * `text` - The text to search (typically a message content string)
///
/// # Returns
///
/// A list of extracted caption strings (without the `<system>` tags).
pub fn extract_image_compression_captions(text: &str) -> Vec<String> {
    let mut captions = Vec::new();
    let mut remaining = text;
    let prefix = "<system>Image compressed to fit model limits:";

    while let Some(start) = remaining.find(prefix) {
        let after_start = &remaining[start + prefix.len()..];
        if let Some(end) = after_start.find("</system>") {
            let caption = format!(
                "Image compressed to fit model limits:{}",
                &after_start[..end]
            );
            captions.push(caption);
            remaining = &after_start[end + 9..];
        } else {
            break;
        }
    }

    captions
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::CropRegion;

    #[test]
    fn normalize_mime_jpg() {
        assert_eq!(normalize_image_mime("image/jpg"), "image/jpeg");
    }

    #[test]
    fn normalize_mime_upper() {
        assert_eq!(
            normalize_image_mime(" image/PNG "),
            "image/png"
        );
    }

    #[test]
    fn normalize_mime_params() {
        assert_eq!(
            normalize_image_mime("image/png;charset=utf-8"),
            "image/png"
        );
    }

    #[test]
    fn is_accepted_png() {
        assert!(is_model_accepted_image_mime("image/png"));
    }

    #[test]
    fn is_not_accepted_avif() {
        assert!(!is_model_accepted_image_mime("image/avif"));
    }

    #[test]
    fn is_not_accepted_bmp() {
        assert!(!is_model_accepted_image_mime("image/bmp"));
    }

    #[test]
    fn is_recodable() {
        assert!(is_recodable_mime("image/png"));
        assert!(is_recodable_mime("image/jpeg"));
        assert!(!is_recodable_mime("image/gif"));
    }

    #[test]
    fn png_dimensions() {
        // Minimal PNG header: signature (8) + IHDR length (4) + "IHDR" (4) + width (4) + height (4)
        let mut data = vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
            0x00, 0x00, 0x00, 0x0D, // IHDR length = 13
            0x49, 0x48, 0x44, 0x52, // "IHDR"
            0x00, 0x00, 0x01, 0x00, // width = 256
            0x00, 0x00, 0x00, 0x80, // height = 128
            0x08, // bit depth = 8
            0x06, // color type = 6 (RGBA)
        ];
        data.resize(30, 0);
        let dims = sniff_image_dimensions(&data).unwrap();
        assert_eq!(dims.width, 256);
        assert_eq!(dims.height, 128);
        assert!(dims.has_alpha);
    }

    #[test]
    fn jpeg_dimensions() {
        // SOI (FF D8) + APP1 with EXIF orientation + SOF0 with dimensions
        let mut data = vec![0xFF, 0xD8];

        // APP1 (FF E1) with EXIF orientation = 6 (transposed)
        let exif_data = build_exif_orientation_data(6);
        let app1_len = (exif_data.len() + 2) as u16;
        data.push(0xFF);
        data.push(0xE1);
        data.extend_from_slice(&app1_len.to_be_bytes());
        data.extend_from_slice(&exif_data);

        // SOF0 (FF C0)
        data.push(0xFF);
        data.push(0xC0);
        data.push(0x00);
        data.push(0x11); // length = 17
        data.push(0x08); // precision = 8
        data.push(0x00);
        data.push(0xC8); // height = 200
        data.push(0x01);
        data.push(0x2C); // width = 300

        let dims = sniff_image_dimensions(&data).unwrap();
        // orientation 6 → transposed → w/h swapped
        assert_eq!(dims.width, 200);
        assert_eq!(dims.height, 300);
        assert!(dims.transposed);
        assert_eq!(dims.orientation, 6);
    }

    fn build_exif_orientation_data(orientation: u16) -> Vec<u8> {
        // TIFF header LE + IFD0 with orientation tag
        let mut buf = Vec::new();
        buf.extend_from_slice(b"Exif\0\0");
        buf.push(0x49);
        buf.push(0x49); // II = little-endian
        buf.push(0x2A);
        buf.push(0x00); // TIFF magic
        // offset to IFD0 (always 8)
        buf.extend_from_slice(&8u32.to_le_bytes());
        // Number of IFD entries = 1
        buf.push(0x01);
        buf.push(0x00);
        // Entry: tag=0x0112, type=SHORT(3), count=1, value=orientation
        buf.extend_from_slice(&0x0112u16.to_le_bytes());
        buf.extend_from_slice(&3u16.to_le_bytes());
        buf.extend_from_slice(&1u32.to_le_bytes());
        buf.extend_from_slice(&orientation.to_le_bytes());
        buf
    }

    #[test]
    fn gif_dimensions() {
        let data = b"GIF89a\xFF\x00\x80\x00...";
        let dims = sniff_image_dimensions(data).unwrap();
        assert_eq!(dims.width, 255);
        assert_eq!(dims.height, 128);
        assert!(dims.has_alpha);
    }

    #[test]
    fn bmp_dimensions() {
        let mut data = vec![0x42, 0x4D]; // BM
        data.resize(26, 0);
        let w: i32 = 640;
        let h: i32 = 480;
        data[18..22].copy_from_slice(&w.to_le_bytes());
        data[22..26].copy_from_slice(&h.to_le_bytes());
        let dims = sniff_image_dimensions(&data).unwrap();
        assert_eq!(dims.width, 640);
        assert_eq!(dims.height, 480);
    }

    #[test]
    fn webp_vp8x_dimensions() {
        let mut data = vec![];
        data.extend_from_slice(b"RIFF");
        data.extend_from_slice(&[0u8; 4]); // file size
        data.extend_from_slice(b"WEBP");
        data.extend_from_slice(b"VP8X");
        data.extend_from_slice(&[0x0A, 0x00, 0x00, 0x00]); // chunk size = 10
        data.push(0x10); // flags: alpha = bit 4
        data.resize(30, 0);
        data[24] = 0xFF; // width - 1 = 255 (little-endian 24-bit)
        data[25] = 0x00;
        data[26] = 0x00;
        data[27] = 0x7F; // height - 1 = 127
        data[28] = 0x00;
        data[29] = 0x00;

        let dims = sniff_image_dimensions(&data).unwrap();
        assert_eq!(dims.width, 256);
        assert_eq!(dims.height, 128);
        assert!(dims.has_alpha);
    }

    #[test]
    fn estimate_tokens_small() {
        // 512x512 = 1 tile
        let tokens = estimate_image_tokens(512, 512);
        assert_eq!(tokens, 85);
    }

    #[test]
    fn estimate_tokens_large() {
        // 1024x1024 = 4 tiles
        let tokens = estimate_image_tokens(1024, 1024);
        assert_eq!(tokens, 85 + 170 * 3);
    }

    #[test]
    fn scale_down() {
        let (w, h) = scale_down_to_max_edge(4000, 2000, 2048);
        assert!(w <= 2048);
        assert!(h <= 2048);
        assert!((w as f64 / h as f64 - 2.0).abs() < 0.01);
    }

    #[test]
    fn sniff_empty() {
        assert!(sniff_image_dimensions(b"").is_none());
    }

    #[test]
    fn sniff_unknown() {
        assert!(sniff_image_dimensions(b"some random bytes").is_none());
    }

    #[test]
    fn compress_empty_data() {
        let result = compress_image_for_model(b"", "image/png", FALLBACK_EDGES_PX, JPEG_QUALITY_STEPS);
        assert!(!result.changed);
        assert_eq!(result.original_bytes, 0);
    }

    #[test]
    fn compress_tiny_data() {
        // Already within budget — should passthrough
        let result = compress_image_for_model(&[0x89, 0x50, 0x4E, 0x47], "image/png", FALLBACK_EDGES_PX, JPEG_QUALITY_STEPS);
        assert!(!result.changed);
        assert_eq!(result.delivery_mode, DeliveryMode::PassthroughWithinBudget);
    }

    #[test]
    fn compress_base64_malformed() {
        let result = compress_base64_for_model("not-a-data-url", FALLBACK_EDGES_PX, JPEG_QUALITY_STEPS);
        assert!(!result.changed);
    }

    #[test]
    fn gate_format_png() {
        let parts = vec![
            ImageContentPart {
                mime: "image/png".to_string(),
                url: "data:image/png;base64,iVBOR".to_string(),
            },
            ImageContentPart {
                mime: "image/avif".to_string(),
                url: "data:image/avif;base64,AAAA".to_string(),
            },
        ];
        let gated = gate_image_format_parts(&parts);
        assert_eq!(gated.len(), 2);
        assert!(gated[0].accepted);
        assert!(!gated[1].accepted);
        assert!(gated[1].notice.is_some());
    }

    #[test]
    fn build_compression_caption() {
        let result = CompressionResult {
            changed: true,
            data: Some("data:image/jpeg;base64,ABC".to_string()),
            mime: "image/jpeg".to_string(),
            original_width: 1920,
            original_height: 1080,
            original_bytes: 500_000,
            final_width: 800,
            final_height: 600,
            final_bytes: 50_000,
            delivery_mode: DeliveryMode::Compressed,
            exif_transposed: false,
        };
        let caption = build_image_compression_caption(&result, None);
        assert!(caption.contains("<system>"));
        assert!(caption.contains("1920"));
        assert!(caption.contains("800"));
        assert!(caption.contains("</system>"));
    }

    #[test]
    fn extract_captions() {
        let text = "Hello <system>Image compressed to fit model limits:compressed | original: 1920x1080 px, 500000 bytes | final: 800x600 px, 50000 bytes</system> World";
        let captions = extract_image_compression_captions(text);
        assert_eq!(captions.len(), 1);
        assert!(captions[0].contains("1920x1080"));
    }

    #[test]
    fn extract_multiple_captions() {
        let text = format!(
            "first: {} second: {}",
            build_image_compression_caption(
                &CompressionResult {
                    changed: true, data: None, mime: "image/jpeg".to_string(),
                    original_width: 100, original_height: 100, original_bytes: 1000,
                    final_width: 50, final_height: 50, final_bytes: 200,
                    delivery_mode: DeliveryMode::Compressed, exif_transposed: false,
                },
                None,
            ),
            build_image_compression_caption(
                &CompressionResult {
                    changed: true, data: None, mime: "image/png".to_string(),
                    original_width: 200, original_height: 200, original_bytes: 4000,
                    final_width: 100, final_height: 100, final_bytes: 800,
                    delivery_mode: DeliveryMode::Compressed, exif_transposed: false,
                },
                None,
            ),
        );
        let captions = extract_image_compression_captions(&text);
        assert_eq!(captions.len(), 2);
    }

    #[test]
    fn crop_empty_data() {
        let region = CropRegion { x: 0, y: 0, width: 10, height: 10 };
        let result = crop_image_for_model(b"", "image/png", &region, true);
        assert_eq!(result.outcome, "empty");
    }

    #[test]
    fn compress_content_parts_empty() {
        let parts = compress_image_content_parts(&[], FALLBACK_EDGES_PX, JPEG_QUALITY_STEPS, false);
        assert!(parts.is_empty());
    }

    #[test]
    fn exif_orientation_transforms_dimensions() {
        use image::{ImageBuffer, Rgb};
        let img = ImageBuffer::from_fn(8, 4, |x, y| Rgb([x as u8, y as u8, 0]));
        let img = image::DynamicImage::ImageRgb8(img);

        // Orientation 1 (normal) leaves the image untouched.
        let out = apply_exif_orientation(img.clone(), 1);
        assert_eq!((out.width(), out.height()), (8, 4));
        // Orientation 6 (90° CW) swaps width and height.
        let out = apply_exif_orientation(img.clone(), 6);
        assert_eq!((out.width(), out.height()), (4, 8));
        // Orientation 3 (180°) keeps dimensions.
        let out = apply_exif_orientation(img.clone(), 3);
        assert_eq!((out.width(), out.height()), (8, 4));
        // Orientation 5 (transpose) swaps dimensions.
        let out = apply_exif_orientation(img.clone(), 5);
        assert_eq!((out.width(), out.height()), (4, 8));
        // Out-of-range values are a no-op.
        let out = apply_exif_orientation(img, 9);
        assert_eq!((out.width(), out.height()), (8, 4));
    }
}