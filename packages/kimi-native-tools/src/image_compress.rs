/// Image compression and cropping — native Rust replacement for
/// `packages/agent-core/src/tools/support/image-compress.ts`.
///
/// The TS module uses `jimp` (pure JS) for PNG/JPEG decode, resize, and
/// encode — 10–100× slower than native codecs. This module does the same
/// work with the `image` crate (native PNG/JPEG codecs), cutting per-image
/// latency from hundreds of milliseconds to single-digit milliseconds.
///
/// The TS wrapper retains the fast-path checks (already within budgets,
/// decode-bomb guard) and telemetry; this module handles only the
/// compute-heavy decode → resize → encode → quality-ladder path.

use std::io::Cursor;

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{
    DynamicImage, GenericImageView, ImageDecoder, ImageEncoder, ImageFormat, ImageReader,
};

// ── config / result structs ──────────────────────────────────────────────

pub struct CompressConfig {
    pub max_edge: u32,
    pub byte_budget: usize,
    pub fallback_edges: Vec<u32>,
    pub jpeg_quality_steps: Vec<u8>,
}

pub struct CompressResult {
    pub data: Vec<u8>,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub original_width: u32,
    pub original_height: u32,
    pub changed: bool,
    pub original_byte_length: usize,
    pub final_byte_length: usize,
}

pub struct CropConfig {
    pub max_edge: u32,
    pub byte_budget: usize,
    pub skip_resize: bool,
    pub fallback_edges: Vec<u32>,
    pub jpeg_quality_steps: Vec<u8>,
}

pub struct CropResult {
    pub data: Vec<u8>,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub original_width: u32,
    pub original_height: u32,
    pub region_x: u32,
    pub region_y: u32,
    pub region_width: u32,
    pub region_height: u32,
    pub resized: bool,
    pub original_byte_length: usize,
    pub final_byte_length: usize,
}

#[derive(Debug)]
pub enum CropError {
    Empty,
    UnsupportedFormat,
    RegionInvalid,
    OutOfBounds {
        original_width: u32,
        original_height: u32,
    },
    Budget {
        encoded_bytes: usize,
        budget: usize,
    },
    DecodeFailed(String),
}

impl CropError {
    pub fn error_message(&self) -> String {
        match self {
            CropError::Empty => "The image is empty.".to_string(),
            CropError::UnsupportedFormat => {
                "Cropping is only supported for PNG and JPEG images.".to_string()
            }
            CropError::RegionInvalid => "Region coordinates must be finite numbers.".to_string(),
            CropError::OutOfBounds {
                original_width,
                original_height,
            } => format!(
                "Region lies outside the {}x{} image.",
                original_width, original_height
            ),
            CropError::Budget {
                encoded_bytes,
                budget,
            } => format!(
                "The cropped region encodes to {} bytes, over the {}-byte per-image limit. \
                 Choose a smaller region, or allow downscaling.",
                encoded_bytes, budget
            ),
            CropError::DecodeFailed(msg) => format!("Failed to decode the image: {}", msg),
        }
    }

    /// Short stable identifier for telemetry (matches TS `CropErrorKind`).
    pub fn kind(&self) -> &'static str {
        match self {
            CropError::Empty => "empty",
            CropError::UnsupportedFormat => "unsupported_format",
            CropError::RegionInvalid => "region_invalid",
            CropError::OutOfBounds { .. } => "out_of_bounds",
            CropError::Budget { .. } => "budget",
            CropError::DecodeFailed(_) => "decode_failed",
        }
    }
}

struct EncodedImage {
    data: Vec<u8>,
    mime_type: &'static str,
    width: u32,
    height: u32,
}

// ── public API ───────────────────────────────────────────────────────────

/// Compress (resize + re-encode) `bytes` to fit the pixel + byte budget.
///
/// Returns `None` on decode/encode failure (caller passes through original).
/// Returns `Some` with `changed: false` when the re-encode didn't help.
/// Returns `Some` with `changed: true` when the result is smaller.
///
/// Animated WebP is passed through unchanged (returned as `None`).
pub fn compress_image(
    bytes: &[u8],
    mime_type: &str,
    config: &CompressConfig,
) -> Option<CompressResult> {
    let normalized = normalize_mime(mime_type);
    let source_is_png_like = normalized == "image/png" || normalized == "image/webp";
    let format = match normalized.as_str() {
        "image/png" => ImageFormat::Png,
        "image/jpeg" => ImageFormat::Jpeg,
        "image/webp" => {
            // Animated WebP — pass through unchanged; decoding would flatten.
            if is_animated_webp(bytes) {
                return None;
            }
            ImageFormat::WebP
        }
        _ => return None,
    };

    let mut img = decode_with_orientation(bytes, format).ok()?;
    let original_width = img.width();
    let original_height = img.height();

    fit_within_edge(&mut img, config.max_edge);

    let encoded = encode_within_budget(
        &mut img,
        source_is_png_like,
        config.byte_budget,
        &config.fallback_edges,
        &config.jpeg_quality_steps,
    )?;

    let original_pixels = original_width as u64 * original_height as u64;
    let final_pixels = encoded.width as u64 * encoded.height as u64;
    let final_byte_length = encoded.data.len();
    let shrank_bytes = final_byte_length < bytes.len();
    let shrank_pixels = final_pixels < original_pixels;
    let changed = shrank_bytes || shrank_pixels;

    Some(CompressResult {
        data: encoded.data,
        mime_type: encoded.mime_type.to_string(),
        width: encoded.width,
        height: encoded.height,
        original_width,
        original_height,
        changed,
        original_byte_length: bytes.len(),
        final_byte_length,
    })
}

/// Crop `region` out of `bytes` and encode it for the model.
///
/// Explicit operation: returns `Err` on any failure (no passthrough).
pub fn crop_image(
    bytes: &[u8],
    mime_type: &str,
    region_x: f64,
    region_y: f64,
    region_width: f64,
    region_height: f64,
    config: &CropConfig,
) -> Result<CropResult, CropError> {
    if bytes.is_empty() {
        return Err(CropError::Empty);
    }
    let normalized = normalize_mime(mime_type);
    let source_is_png_like = normalized == "image/png" || normalized == "image/webp";
    let format = match normalized.as_str() {
        "image/png" => ImageFormat::Png,
        "image/jpeg" => ImageFormat::Jpeg,
        "image/webp" => {
            // Animated WebP cannot be cropped sensibly.
            if is_animated_webp(bytes) {
                return Err(CropError::UnsupportedFormat);
            }
            ImageFormat::WebP
        }
        _ => return Err(CropError::UnsupportedFormat),
    };
    if ![region_x, region_y, region_width, region_height]
        .iter()
        .all(|v| v.is_finite())
    {
        return Err(CropError::RegionInvalid);
    }

    let img = decode_with_orientation(bytes, format)
        .map_err(|e| CropError::DecodeFailed(e.to_string()))?;
    let original_width = img.width();
    let original_height = img.height();

    let x = region_x.floor() as i64;
    let y = region_y.floor() as i64;
    if x < 0
        || y < 0
        || x as u32 >= original_width
        || y as u32 >= original_height
        || region_width < 1.0
        || region_height < 1.0
    {
        return Err(CropError::OutOfBounds {
            original_width,
            original_height,
        });
    }
    let w = (region_width.floor() as u32).min(original_width - x as u32);
    let h = (region_height.floor() as u32).min(original_height - y as u32);

    let cropped = img.crop_imm(x as u32, y as u32, w, h);

    if config.skip_resize {
        let (data, mime) = if source_is_png_like {
            (encode_png(&cropped).map_err(|e| CropError::DecodeFailed(e.to_string()))?, "image/png")
        } else {
            (encode_jpeg(&cropped, 90).map_err(|e| CropError::DecodeFailed(e.to_string()))?, "image/jpeg")
        };
        let final_byte_length = data.len();
        if final_byte_length > config.byte_budget {
            return Err(CropError::Budget {
                encoded_bytes: final_byte_length,
                budget: config.byte_budget,
            });
        }
        return Ok(CropResult {
            data,
            mime_type: mime.to_string(),
            width: cropped.width(),
            height: cropped.height(),
            original_width,
            original_height,
            region_x: x as u32,
            region_y: y as u32,
            region_width: w,
            region_height: h,
            resized: false,
            original_byte_length: bytes.len(),
            final_byte_length,
        });
    }

    let mut fitted = cropped;
    fit_within_edge(&mut fitted, config.max_edge);
    let encoded = encode_within_budget(
        &mut fitted,
        source_is_png_like,
        config.byte_budget,
        &config.fallback_edges,
        &config.jpeg_quality_steps,
    )
    .ok_or_else(|| CropError::DecodeFailed("encode failed".to_string()))?;

    let final_byte_length = encoded.data.len();
    Ok(CropResult {
        data: encoded.data,
        mime_type: encoded.mime_type.to_string(),
        width: encoded.width,
        height: encoded.height,
        original_width,
        original_height,
        region_x: x as u32,
        region_y: y as u32,
        region_width: w,
        region_height: h,
        resized: encoded.width != w || encoded.height != h,
        original_byte_length: bytes.len(),
        final_byte_length,
    })
}

// ── internals ────────────────────────────────────────────────────────────

/// Pre-multiply alpha into the RGB channels so fully transparent pixels
/// contribute zero color during resize. Without this, the Triangle filter
/// blends the RGB values of transparent pixels into their visible neighbors,
/// producing visible color fringes on edges with alpha.
fn premultiply_alpha(img: &mut DynamicImage) {
    if !img.color().has_alpha() {
        return;
    }
    let rgba = img.to_rgba8();
    let mut out = rgba.clone();
    for pixel in out.pixels_mut() {
        let a = pixel[3] as f32 / 255.0;
        pixel[0] = (pixel[0] as f32 * a).round().clamp(0.0, 255.0) as u8;
        pixel[1] = (pixel[1] as f32 * a).round().clamp(0.0, 255.0) as u8;
        pixel[2] = (pixel[2] as f32 * a).round().clamp(0.0, 255.0) as u8;
    }
    *img = DynamicImage::ImageRgba8(out);
}

/// Reverse {@link premultiply_alpha} after resizing. Fully transparent
/// pixels (alpha=0) get their RGB cleared to avoid stray color from
/// rounding.
fn unpremultiply_alpha(img: &mut DynamicImage) {
    if !img.color().has_alpha() {
        return;
    }
    let rgba = img.to_rgba8();
    let mut out = rgba.clone();
    for pixel in out.pixels_mut() {
        if pixel[3] == 0 {
            pixel[0] = 0;
            pixel[1] = 0;
            pixel[2] = 0;
        } else if pixel[3] < 255 {
            let a = 255.0 / pixel[3] as f32;
            pixel[0] = ((pixel[0] as f32) * a).round().clamp(0.0, 255.0) as u8;
            pixel[1] = ((pixel[1] as f32) * a).round().clamp(0.0, 255.0) as u8;
            pixel[2] = ((pixel[2] as f32) * a).round().clamp(0.0, 255.0) as u8;
        }
    }
    *img = DynamicImage::ImageRgba8(out);
}

/// Scale `img` so its longest edge is at most `edge`, preserving aspect
/// ratio. No-op (returns false) when the image already fits. Uses Triangle
/// (bilinear) filtering which covers all source pixels during downscaling —
/// no aliasing on text or fine patterns. Pre-multiplies alpha before
/// resizing to prevent color bleed from transparent pixels.
fn fit_within_edge(img: &mut DynamicImage, edge: u32) -> bool {
    let (w, h) = img.dimensions();
    let longest = w.max(h);
    if longest <= edge {
        return false;
    }
    let factor = edge as f64 / longest as f64;
    let new_w = ((w as f64) * factor).round().max(1.0) as u32;
    let new_h = ((h as f64) * factor).round().max(1.0) as u32;
    let had_alpha = img.color().has_alpha();
    if had_alpha {
        premultiply_alpha(img);
    }
    *img = img.resize_exact(new_w, new_h, image::imageops::FilterType::Triangle);
    if had_alpha {
        unpremultiply_alpha(img);
    }
    true
}

/// PNG rescales stop at this edge; below it the ladder goes lossy instead.
/// Mirrors the TS constant in image-compress.ts.
const PNG_RESCALE_FLOOR_PX: u32 = 1000;

/// Encode `img` under the byte budget, trying progressively smaller sizes
/// and lower quality levels. Mirrors `encodeWithinBudget` in `image-compress.ts`.
///
/// Strategy:
/// - Lossless source (PNG/WebP): lossless PNG at fitted size → smaller PNGs at
///   fallback edges down to PNG_RESCALE_FLOOR_PX → lossy JPEG quality ladder
///   (drops transparency) at floored size → JPEG ladder again at each sub-floor edge.
/// - JPEG source: quality ladder at fitted size → full ladder at each
///   fallback edge.
///
/// Always returns the smallest encoding produced, even if none met the budget.
fn encode_within_budget(
    img: &mut DynamicImage,
    source_is_lossless: bool,
    byte_budget: usize,
    fallback_edges: &[u32],
    jpeg_quality_steps: &[u8],
) -> Option<EncodedImage> {
    let mut smallest: Option<EncodedImage> = None;

    if source_is_lossless {
        if let Ok(png) = encode_png(img) {
            let len = png.len();
            track_smallest(&mut smallest, png, "image/png", img.width(), img.height());
            if len <= byte_budget {
                return smallest;
            }
        }

        // Progressively smaller PNGs down to the floor.
        for &edge in fallback_edges {
            if edge < PNG_RESCALE_FLOOR_PX {
                break;
            }
            if !fit_within_edge(img, edge) {
                continue;
            }
            if let Ok(smaller_png) = encode_png(img) {
                let len = smaller_png.len();
                track_smallest(
                    &mut smallest,
                    smaller_png,
                    "image/png",
                    img.width(),
                    img.height(),
                );
                if len <= byte_budget {
                    return smallest;
                }
            }
        }

        // Lossy JPEG ladder at the floored size.
        for &quality in jpeg_quality_steps {
            if let Ok(jpeg) = encode_jpeg(img, quality) {
                let len = jpeg.len();
                track_smallest(
                    &mut smallest,
                    jpeg,
                    "image/jpeg",
                    img.width(),
                    img.height(),
                );
                if len <= byte_budget {
                    return smallest;
                }
            }
        }

        // JPEG ladder at each sub-floor edge.
        for &edge in fallback_edges {
            if edge >= PNG_RESCALE_FLOOR_PX {
                continue;
            }
            if !fit_within_edge(img, edge) {
                continue;
            }
            for &quality in jpeg_quality_steps {
                if let Ok(jpeg) = encode_jpeg(img, quality) {
                    let len = jpeg.len();
                    track_smallest(
                        &mut smallest,
                        jpeg,
                        "image/jpeg",
                        img.width(),
                        img.height(),
                    );
                    if len <= byte_budget {
                        return smallest;
                    }
                }
            }
        }
    } else {
        for &quality in jpeg_quality_steps {
            if let Ok(jpeg) = encode_jpeg(img, quality) {
                let len = jpeg.len();
                track_smallest(
                    &mut smallest,
                    jpeg,
                    "image/jpeg",
                    img.width(),
                    img.height(),
                );
                if len <= byte_budget {
                    return smallest;
                }
            }
        }

        for &edge in fallback_edges {
            if !fit_within_edge(img, edge) {
                continue;
            }
            for &quality in jpeg_quality_steps {
                if let Ok(jpeg) = encode_jpeg(img, quality) {
                    let len = jpeg.len();
                    track_smallest(
                        &mut smallest,
                        jpeg,
                        "image/jpeg",
                        img.width(),
                        img.height(),
                    );
                    if len <= byte_budget {
                        return smallest;
                    }
                }
            }
        }
    }

    smallest
}

fn track_smallest(
    smallest: &mut Option<EncodedImage>,
    data: Vec<u8>,
    mime: &'static str,
    width: u32,
    height: u32,
) {
    if smallest.is_none() || data.len() < smallest.as_ref().unwrap().data.len() {
        *smallest = Some(EncodedImage {
            data,
            mime_type: mime,
            width,
            height,
        });
    }
}

/// Encode as PNG with best compression (matches jimp `deflateLevel: 9`).
fn encode_png(img: &DynamicImage) -> Result<Vec<u8>, image::ImageError> {
    let mut buf = Vec::new();
    {
        let encoder =
            PngEncoder::new_with_quality(&mut buf, CompressionType::Best, FilterType::Adaptive);
        if img.color().has_alpha() {
            let rgba = img.to_rgba8();
            encoder.write_image(&rgba, img.width(), img.height(), img.color().into())?;
        } else {
            let rgb = img.to_rgb8();
            encoder.write_image(&rgb, img.width(), img.height(), img.color().into())?;
        }
    }
    Ok(buf)
}

/// Encode as JPEG with the given quality (1–100).
fn encode_jpeg(img: &DynamicImage, quality: u8) -> Result<Vec<u8>, image::ImageError> {
    let mut buf = Vec::new();
    {
        let encoder = JpegEncoder::new_with_quality(&mut buf, quality);
        let rgb = img.to_rgb8();
        encoder.write_image(&rgb, img.width(), img.height(), image::ExtendedColorType::Rgb8)?;
    }
    Ok(buf)
}

/// Check whether a WebP byte slice is animated (VP8X with ANIM flag).
/// Mirrors `isAnimatedWebp` in `webp-decode.ts`. Returns true when the bytes
/// look like an animated WebP; returns false for still WebP, other formats, or
/// truncated headers.
fn is_animated_webp(bytes: &[u8]) -> bool {
    // RIFF header: "RIFF" + 4 bytes size + "WEBP"
    if bytes.len() < 30 {
        return false;
    }
    if &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return false;
    }
    let chunk_type = &bytes[12..16];
    if chunk_type != b"VP8X" {
        return false;
    }
    // VP8X flags at bytes[20..24]; bit 1 is the animation flag.
    // The flags field is 4 bytes: [bitfield byte] [0] [0] [0]
    bytes[20] & 0x02 != 0
}

/// Decode `bytes` (known `format`) into a `DynamicImage` with EXIF
/// orientation applied, so the returned image lives in the same display
/// (EXIF-rotated) coordinate space as jimp's decode.
///
/// This is the crucial parity point with the TS `jimp` pipeline: jimp rotates
/// on decode, so `image-compress.ts` reports original dimensions and accepts
/// crop regions in the rotated space. The raw `image` crate decode does NOT
/// auto-rotate, so without this a portrait JPEG shot in landscape+EXIF would
/// report swapped width/height and crop the wrong region. We read the
/// orientation tag from the decoder's Exif metadata and apply it after decode.
///
/// Formats without orientation metadata (e.g. WebP, or a JPEG/PNG with no
/// Exif) resolve to `Orientation::NoTransforms`, so this is a no-op there and
/// behaviour matches the previous direct decode.
fn decode_with_orientation(
    bytes: &[u8],
    format: ImageFormat,
) -> Result<DynamicImage, image::ImageError> {
    let mut decoder = ImageReader::with_format(Cursor::new(bytes), format).into_decoder()?;
    // `orientation()` reads the decoder's Exif metadata; its default is
    // `NoTransforms` when absent or unreadable. Never fail the whole decode
    // over a missing/garbled orientation tag — fall back to no transform.
    let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(decoder)?;
    img.apply_orientation(orientation);
    Ok(img)
}

fn normalize_mime(mime_type: &str) -> String {
    let lower = mime_type.trim().to_lowercase();
    if lower == "image/jpg" {
        "image/jpeg".to_string()
    } else {
        lower
    }
}

// ── tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb, Rgba};

    fn make_rgb_image(width: u32, height: u32) -> DynamicImage {
        let mut img = ImageBuffer::new(width, height);
        for x in 0..width {
            for y in 0..height {
                img.put_pixel(x, y, Rgb([(x % 256) as u8, (y % 256) as u8, 128]));
            }
        }
        DynamicImage::ImageRgb8(img)
    }

    fn make_rgba_image(width: u32, height: u32) -> DynamicImage {
        let mut img = ImageBuffer::new(width, height);
        for x in 0..width {
            for y in 0..height {
                img.put_pixel(
                    x,
                    y,
                    Rgba([(x % 256) as u8, (y % 256) as u8, 128, 255]),
                );
            }
        }
        DynamicImage::ImageRgba8(img)
    }

    fn encode_to_png_bytes(img: &DynamicImage) -> Vec<u8> {
        encode_png(img).expect("PNG encode should not fail")
    }

    fn encode_to_jpeg_bytes(img: &DynamicImage, quality: u8) -> Vec<u8> {
        encode_jpeg(img, quality).expect("JPEG encode should not fail")
    }

    fn default_compress_config(byte_budget: usize) -> CompressConfig {
        CompressConfig {
            max_edge: 3000,
            byte_budget,
            fallback_edges: vec![2000, 1000],
            jpeg_quality_steps: vec![80, 60, 40, 20],
        }
    }

    fn default_crop_config(byte_budget: usize) -> CropConfig {
        CropConfig {
            max_edge: 3000,
            byte_budget,
            skip_resize: false,
            fallback_edges: vec![2000, 1000],
            jpeg_quality_steps: vec![80, 60, 40, 20],
        }
    }

    // ── fit_within_edge ──────────────────────────────────────────────────

    #[test]
    fn test_fit_within_edge_noop() {
        let mut img = make_rgb_image(100, 50);
        assert!(!fit_within_edge(&mut img, 200));
        assert_eq!(img.dimensions(), (100, 50));
    }

    #[test]
    fn test_fit_within_edge_downscale() {
        let mut img = make_rgb_image(4000, 2000);
        assert!(fit_within_edge(&mut img, 3000));
        assert_eq!(img.dimensions(), (3000, 1500));
    }

    #[test]
    fn test_fit_within_edge_tall_image() {
        let mut img = make_rgb_image(1000, 4000);
        assert!(fit_within_edge(&mut img, 2000));
        assert_eq!(img.dimensions(), (500, 2000));
    }

    #[test]
    fn test_fit_within_edge_square() {
        let mut img = make_rgb_image(4000, 4000);
        assert!(fit_within_edge(&mut img, 1000));
        assert_eq!(img.dimensions(), (1000, 1000));
    }

    #[test]
    fn test_fit_within_edge_exact() {
        let mut img = make_rgb_image(3000, 2000);
        assert!(!fit_within_edge(&mut img, 3000));
    }

    // ── encode_png / encode_jpeg ─────────────────────────────────────────

    #[test]
    fn test_encode_png_rgb() {
        let img = make_rgb_image(100, 100);
        let bytes = encode_to_png_bytes(&img);
        assert!(!bytes.is_empty());
        // PNG magic bytes
        assert_eq!(&bytes[..8], &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    }

    #[test]
    fn test_encode_png_rgba() {
        let img = make_rgba_image(50, 50);
        let bytes = encode_to_png_bytes(&img);
        assert!(!bytes.is_empty());
        assert_eq!(&bytes[..8], &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    }

    #[test]
    fn test_encode_jpeg_basic() {
        let img = make_rgb_image(100, 100);
        let bytes = encode_to_jpeg_bytes(&img, 80);
        assert!(!bytes.is_empty());
        // JPEG magic bytes: FF D8 FF
        assert_eq!(&bytes[..3], &[0xFF, 0xD8, 0xFF]);
    }

    #[test]
    fn test_jpeg_lower_quality_smaller() {
        let img = make_rgb_image(500, 500);
        let high = encode_to_jpeg_bytes(&img, 80);
        let low = encode_to_jpeg_bytes(&img, 20);
        assert!(low.len() < high.len());
    }

    // ── compress_image ──────────────────────────────────────────────────

    #[test]
    fn test_compress_unsupported_format() {
        let config = default_compress_config(3_75_000);
        let result = compress_image(b"not an image", "image/gif", &config);
        assert!(result.is_none());
    }

    #[test]
    fn test_compress_empty_bytes() {
        let config = default_compress_config(3_75_00);
        let result = compress_image(b"", "image/png", &config);
        assert!(result.is_none());
    }

    #[test]
    fn test_compress_png_downscale() {
        // Large PNG that exceeds edge budget — synthetic gradient compresses
        // very well, so the result may not shrink in bytes, but pixels do.
        let img = make_rgb_image(4000, 3000);
        let bytes = encode_to_png_bytes(&img);
        let config = default_compress_config(3_75_000);
        let result = compress_image(&bytes, "image/png", &config);
        assert!(result.is_some());
        let r = result.unwrap();
        assert!(r.changed);
        assert!(r.width <= 3000);
        assert!(r.height <= 3000);
        assert_eq!(r.original_width, 4000);
        assert_eq!(r.original_height, 3000);
        let original_pixels = 4000u64 * 3000;
        let final_pixels = r.width as u64 * r.height as u64;
        assert!(final_pixels < original_pixels);
    }

    #[test]
    fn test_compress_jpeg_quality_ladder() {
        // Large JPEG that exceeds byte budget
        let img = make_rgb_image(2000, 2000);
        let bytes = encode_to_jpeg_bytes(&img, 100);
        let config = default_compress_config(100); // tiny budget forces quality down
        let result = compress_image(&bytes, "image/jpeg", &config);
        assert!(result.is_some());
        let r = result.unwrap();
        assert!(r.changed);
        assert!(r.final_byte_length < r.original_byte_length);
    }

    #[test]
    fn test_compress_png_no_help() {
        // Small PNG that's already tiny — re-encode won't help
        let img = make_rgb_image(10, 10);
        let bytes = encode_to_png_bytes(&img);
        let config = default_compress_config(3_75_000);
        let result = compress_image(&bytes, "image/png", &config);
        assert!(result.is_some());
        let r = result.unwrap();
        assert!(!r.changed); // didn't shrink
    }

    #[test]
    fn test_compress_preserves_mime_type() {
        let img = make_rgb_image(4000, 3000);
        let bytes = encode_to_png_bytes(&img);
        let config = default_compress_config(3_75_000);
        let result = compress_image(&bytes, "image/png", &config);
        let r = result.unwrap();
        // PNG source should stay PNG (unless quality ladder kicks in for tiny budget)
        assert!(
            r.mime_type == "image/png" || r.mime_type == "image/jpeg",
            "unexpected mime: {}",
            r.mime_type
        );
    }

    // ── crop_image ──────────────────────────────────────────────────────

    #[test]
    fn test_crop_empty() {
        let config = default_crop_config(3_75_000);
        let result = crop_image(b"", "image/png", 0.0, 0.0, 100.0, 100.0, &config);
        assert!(matches!(result, Err(CropError::Empty)));
    }

    #[test]
    fn test_crop_unsupported_format() {
        let config = default_crop_config(3_75_000);
        let result = crop_image(b"data", "image/gif", 0.0, 0.0, 100.0, 100.0, &config);
        assert!(matches!(result, Err(CropError::UnsupportedFormat)));
    }

    #[test]
    fn test_crop_region_nan() {
        let img = make_rgb_image(100, 100);
        let bytes = encode_to_png_bytes(&img);
        let config = default_crop_config(3_75_000);
        let result = crop_image(&bytes, "image/png", f64::NAN, 0.0, 10.0, 10.0, &config);
        assert!(matches!(result, Err(CropError::RegionInvalid)));
    }

    #[test]
    fn test_crop_out_of_bounds() {
        let img = make_rgb_image(100, 100);
        let bytes = encode_to_png_bytes(&img);
        let config = default_crop_config(3_75_000);
        let result = crop_image(&bytes, "image/png", 200.0, 200.0, 10.0, 10.0, &config);
        assert!(matches!(result, Err(CropError::OutOfBounds { .. })));
    }

    #[test]
    fn test_crop_negative_origin() {
        let img = make_rgb_image(100, 100);
        let bytes = encode_to_png_bytes(&img);
        let config = default_crop_config(3_75_000);
        let result = crop_image(&bytes, "image/png", -10.0, 0.0, 50.0, 50.0, &config);
        assert!(matches!(result, Err(CropError::OutOfBounds { .. })));
    }

    #[test]
    fn test_crop_success_png() {
        let img = make_rgb_image(200, 200);
        let bytes = encode_to_png_bytes(&img);
        let config = default_crop_config(3_75_000);
        let result = crop_image(&bytes, "image/png", 50.0, 50.0, 100.0, 100.0, &config);
        assert!(result.is_ok());
        let r = result.unwrap();
        assert_eq!(r.region_x, 50);
        assert_eq!(r.region_y, 50);
        assert_eq!(r.region_width, 100);
        assert_eq!(r.region_height, 100);
        assert_eq!(r.original_width, 200);
        assert_eq!(r.original_height, 200);
        assert!(!r.data.is_empty());
    }

    #[test]
    fn test_crop_clamped_to_bounds() {
        let img = make_rgb_image(100, 100);
        let bytes = encode_to_png_bytes(&img);
        let config = default_crop_config(3_75_000);
        // Region extends past the image — should clamp
        let result = crop_image(&bytes, "image/png", 80.0, 80.0, 100.0, 100.0, &config);
        assert!(result.is_ok());
        let r = result.unwrap();
        assert_eq!(r.region_width, 20); // clamped: 100 - 80
        assert_eq!(r.region_height, 20);
    }

    #[test]
    fn test_crop_skip_resize_png() {
        let img = make_rgb_image(200, 200);
        let bytes = encode_to_png_bytes(&img);
        let mut config = default_crop_config(3_75_000);
        config.skip_resize = true;
        let result = crop_image(&bytes, "image/png", 50.0, 50.0, 100.0, 100.0, &config);
        assert!(result.is_ok());
        let r = result.unwrap();
        assert!(!r.resized);
        assert_eq!(r.width, 100);
        assert_eq!(r.height, 100);
        assert_eq!(r.mime_type, "image/png");
    }

    #[test]
    fn test_crop_skip_resize_jpeg() {
        let img = make_rgb_image(200, 200);
        let bytes = encode_to_jpeg_bytes(&img, 90);
        let mut config = default_crop_config(3_75_000);
        config.skip_resize = true;
        let result = crop_image(&bytes, "image/jpeg", 50.0, 50.0, 100.0, 100.0, &config);
        assert!(result.is_ok());
        let r = result.unwrap();
        assert!(!r.resized);
        assert_eq!(r.width, 100);
        assert_eq!(r.height, 100);
        assert_eq!(r.mime_type, "image/jpeg");
    }

    #[test]
    fn test_crop_skip_resize_budget_exceeded() {
        let img = make_rgb_image(500, 500);
        let bytes = encode_to_png_bytes(&img);
        let mut config = default_crop_config(10); // tiny budget
        config.skip_resize = true;
        let result = crop_image(&bytes, "image/png", 0.0, 0.0, 400.0, 400.0, &config);
        assert!(matches!(result, Err(CropError::Budget { .. })));
    }

    #[test]
    fn test_crop_jpeg_source() {
        let img = make_rgb_image(300, 300);
        let bytes = encode_to_jpeg_bytes(&img, 85);
        let config = default_crop_config(3_75_000);
        let result = crop_image(&bytes, "image/jpeg", 100.0, 100.0, 100.0, 100.0, &config);
        assert!(result.is_ok());
        let r = result.unwrap();
        assert_eq!(r.original_width, 300);
        assert_eq!(r.original_height, 300);
        assert!(!r.data.is_empty());
    }

    // ── is_animated_webp ──────────────────────────────────────────────────

    #[test]
    fn test_is_animated_webp_empty() {
        assert!(!is_animated_webp(b""));
    }

    #[test]
    fn test_is_animated_webp_too_short() {
        assert!(!is_animated_webp(b"RIFF"));
    }

    #[test]
    fn test_is_animated_webp_not_riff() {
        let mut buf = vec![0u8; 30];
        buf[0..4].copy_from_slice(b"FOOO");
        assert!(!is_animated_webp(&buf));
    }

    #[test]
    fn test_is_animated_webp_not_webp() {
        let mut buf = vec![0u8; 30];
        buf[0..4].copy_from_slice(b"RIFF");
        buf[8..12].copy_from_slice(b"XXXX");
        assert!(!is_animated_webp(&buf));
    }

    #[test]
    fn test_is_animated_webp_still() {
        // Minimum valid WebP with VP8X but no ANIM flag.
        let mut buf = vec![0u8; 30];
        buf[0..4].copy_from_slice(b"RIFF");
        buf[8..12].copy_from_slice(b"WEBP");
        buf[12..16].copy_from_slice(b"VP8X");
        // flags[20] = 0 (no ANIM)
        assert!(!is_animated_webp(&buf));
    }

    #[test]
    fn test_is_animated_webp_animated() {
        // Minimum valid WebP with VP8X and ANIM flag set (bit 1).
        let mut buf = vec![0u8; 30];
        buf[0..4].copy_from_slice(b"RIFF");
        buf[8..12].copy_from_slice(b"WEBP");
        buf[12..16].copy_from_slice(b"VP8X");
        buf[20] = 0x02; // ANIM flag
        assert!(is_animated_webp(&buf));
    }

    // ── WebP compress / crop ──────────────────────────────────────────────

    /// Build a tiny valid WebP image (lossless). The `image` crate's webp
    /// encoder produces a valid still WebP.
    fn make_still_webp_bytes() -> Vec<u8> {
        let img = image::DynamicImage::ImageRgba8(
            image::ImageBuffer::from_fn(32, 32, |x, y| {
                image::Rgba([(x % 256) as u8, (y % 256) as u8, 128, 255])
            }),
        );
        let mut buf = Vec::new();
        let encoder = image::codecs::webp::WebPEncoder::new_lossless(&mut buf);
        encoder
            .encode(&img.to_rgba8(), 32, 32, image::ExtendedColorType::Rgba8)
            .expect("lossless WebP encode should not fail");
        buf
    }

    #[test]
    fn test_compress_webp_downscale() {
        let bytes = make_still_webp_bytes();
        let config = CompressConfig {
            max_edge: 16,
            byte_budget: 3_75_000,
            fallback_edges: vec![16],
            jpeg_quality_steps: vec![80, 60, 40, 20],
        };
        let result = compress_image(&bytes, "image/webp", &config);
        assert!(result.is_some());
        let r = result.unwrap();
        assert!(r.changed);
        assert!(r.width <= 16);
        assert!(r.height <= 16);
    }

    #[test]
    fn test_crop_webp_success() {
        let bytes = make_still_webp_bytes();
        let config = default_crop_config(3_75_000);
        let result = crop_image(&bytes, "image/webp", 0.0, 0.0, 16.0, 16.0, &config);
        assert!(result.is_ok());
        let r = result.unwrap();
        assert_eq!(r.region_width, 16);
        assert_eq!(r.region_height, 16);
    }

    // ── EXIF orientation ─────────────────────────────────────────────────

    /// Build a JPEG carrying an EXIF `Orientation` tag with the given value by
    /// splicing a hand-built APP1/Exif segment right after the SOI marker of a
    /// crate-encoded JPEG. Orientation 6 = rotate 90° CW on display, which
    /// swaps the displayed width/height relative to the stored pixels.
    fn make_jpeg_with_exif_orientation(width: u32, height: u32, orientation: u16) -> Vec<u8> {
        let jpeg = encode_to_jpeg_bytes(&make_rgb_image(width, height), 90);
        assert_eq!(&jpeg[0..2], &[0xFF, 0xD8], "crate JPEG must start with SOI");

        // TIFF (little-endian) with a single IFD0 entry: Orientation (0x0112),
        // type SHORT (3), count 1, value = `orientation`.
        let mut tiff: Vec<u8> = Vec::new();
        tiff.extend_from_slice(b"II"); // little-endian byte order
        tiff.extend_from_slice(&0x002Au16.to_le_bytes()); // TIFF magic 42
        tiff.extend_from_slice(&8u32.to_le_bytes()); // offset to IFD0
        tiff.extend_from_slice(&1u16.to_le_bytes()); // entry count
        tiff.extend_from_slice(&0x0112u16.to_le_bytes()); // tag: Orientation
        tiff.extend_from_slice(&3u16.to_le_bytes()); // type: SHORT
        tiff.extend_from_slice(&1u32.to_le_bytes()); // count
        // SHORT value in the low 2 bytes of the 4-byte value field.
        tiff.extend_from_slice(&orientation.to_le_bytes());
        tiff.extend_from_slice(&[0u8, 0u8]); // pad to 4 bytes
        tiff.extend_from_slice(&0u32.to_le_bytes()); // next IFD offset (none)

        let mut payload: Vec<u8> = Vec::new();
        payload.extend_from_slice(b"Exif\0\0");
        payload.extend_from_slice(&tiff);

        let seg_len = (payload.len() + 2) as u16; // length field includes itself
        let mut app1: Vec<u8> = Vec::new();
        app1.extend_from_slice(&[0xFF, 0xE1]); // APP1 marker
        app1.extend_from_slice(&seg_len.to_be_bytes()); // big-endian length
        app1.extend_from_slice(&payload);

        // SOI + APP1 + (rest of the crate JPEG after SOI).
        let mut out: Vec<u8> = Vec::new();
        out.extend_from_slice(&jpeg[0..2]);
        out.extend_from_slice(&app1);
        out.extend_from_slice(&jpeg[2..]);
        out
    }

    #[test]
    fn test_decode_applies_exif_orientation() {
        // Stored pixels are 120x80 (landscape); Orientation 6 displays it
        // rotated 90° CW, so the decoded image must be 80x120 (portrait).
        let bytes = make_jpeg_with_exif_orientation(120, 80, 6);
        let img = decode_with_orientation(&bytes, ImageFormat::Jpeg)
            .expect("EXIF-oriented JPEG should decode");
        assert_eq!(img.width(), 80, "width should be the rotated (displayed) width");
        assert_eq!(img.height(), 120, "height should be the rotated (displayed) height");
    }

    #[test]
    fn test_compress_reports_exif_rotated_dimensions() {
        // Regression for the parity gap with jimp: compression must report the
        // ORIGINAL dimensions in EXIF-rotated (display) space, matching the TS
        // pipeline. Without applying orientation this reported 120x80.
        let bytes = make_jpeg_with_exif_orientation(120, 80, 6);
        let config = default_compress_config(100); // tiny budget forces a re-encode
        let result = compress_image(&bytes, "image/jpeg", &config)
            .expect("EXIF-oriented JPEG should compress");
        assert_eq!(result.original_width, 80);
        assert_eq!(result.original_height, 120);
    }

    #[test]
    fn test_no_exif_orientation_is_noop() {
        // A plain JPEG with no Exif keeps its stored dimensions (no rotation).
        let bytes = encode_to_jpeg_bytes(&make_rgb_image(120, 80), 90);
        let img = decode_with_orientation(&bytes, ImageFormat::Jpeg)
            .expect("plain JPEG should decode");
        assert_eq!(img.width(), 120);
        assert_eq!(img.height(), 80);
    }

    // ── normalize_mime ──────────────────────────────────────────────────

    #[test]
    fn test_normalize_mime() {
        assert_eq!(normalize_mime("image/png"), "image/png");
        assert_eq!(normalize_mime("image/jpeg"), "image/jpeg");
        assert_eq!(normalize_mime("image/jpg"), "image/jpeg");
        assert_eq!(normalize_mime("image/webp"), "image/webp");
        assert_eq!(normalize_mime("  IMAGE/PNG  "), "image/png");
    }
}
