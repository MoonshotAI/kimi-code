/// Video processing — container format detection, metadata extraction, token estimation.
///
/// Corresponds to `packages/agent-core-v2/src/agent/media/videoResolver.ts`
/// and `videoUpload.ts`.
///
/// Parses basic video information from container headers (MP4, WebM, AVI, MOV, MKV)
/// and provides token cost estimation for video payloads.

use crate::media::VideoInfo;

// ---------------------------------------------------------------------------
// Video info
// ---------------------------------------------------------------------------

/// Video resolution tier for token estimation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolutionTier {
    /// 0-360p (SD)
    Low,
    /// 360-720p (HD)
    Medium,
    /// 720-1080p (Full HD)
    High,
    /// 1080+ (4K / UHD)
    Ultra,
}

impl ResolutionTier {
    pub fn from_dimensions(width: u32, height: u32) -> Self {
        // Use the smaller dimension (height for landscape, width for portrait)
        // to determine the resolution tier, as this matches standard resolution naming.
        let min_dim = width.min(height);
        if min_dim <= 360 {
            ResolutionTier::Low
        } else if min_dim <= 480 {
            ResolutionTier::Medium
        } else if min_dim <= 720 {
            ResolutionTier::High
        } else {
            ResolutionTier::Ultra
        }
    }
}

// ---------------------------------------------------------------------------
// Container format constants
// ---------------------------------------------------------------------------

/// Known video container formats.
pub const VIDEO_CONTAINERS: &[(&str, &str)] = &[
    ("mp4", "video/mp4"),
    ("webm", "video/webm"),
    ("avi", "video/x-msvideo"),
    ("mov", "video/quicktime"),
    ("mkv", "video/x-matroska"),
    ("wmv", "video/x-ms-wmv"),
    ("flv", "video/x-flv"),
    ("m4v", "video/mp4"),
    ("3gp", "video/3gpp"),
    ("mpeg", "video/mpeg"),
    ("ogv", "video/ogg"),
];

/// Look up container name by MIME type.
pub fn container_from_mime(mime: &str) -> &'static str {
    let mime = mime.trim().to_lowercase();
    for (name, m) in VIDEO_CONTAINERS {
        if *m == mime {
            return name;
        }
    }
    "unknown"
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

/// Parse video dimensions from MP4/ISOBMFF `ftyp` + `moov` box headers.
///
/// MP4 uses a tree of boxes (atoms).  The `moov` box contains `trak` → `mdia` → `stsd`
/// which holds the video dimensions in `avc1` or `hvc1` sample entries.
/// For a lightweight approach, we scan the first portion of the file for the track header
/// (`tkhd`) box which contains width/height in fixed-point at known offsets.
fn parse_mp4_dimensions(data: &[u8]) -> Option<VideoInfo> {
    // Scan for tkhd box (track header)
    // tkhd has: size (4) + type "tkhd" (4) + version (1) + flags (3) + ...
    // For version 0: creation_time (4) + modification_time (4) + track_ID (4) + reserved (4) + duration (4)
    // + reserved (8) + layer (2) + alternate_group (2) + volume (2) + reserved (2) +
    // matrix (36) + width (4) + height (4)
    // For version 1: similar but with 8-byte timestamps
    //
    // We do a simple scan for the "tkhd" box in the first 64KB of data.

    if data.len() < 8 {
        return None;
    }

    let mut offset = 0;
    while offset + 8 <= data.len() {
        if offset > 65536 {
            break;
        }

        // Check for "tkhd" at offset + 4
        if &data[offset + 4..offset + 8] == b"tkhd" {
            let box_size = u32::from_be_bytes([
                data[offset],
                data[offset + 1],
                data[offset + 2],
                data[offset + 3],
            ]) as usize;

            if box_size < 20 {
                return None;
            }

            let version = data[offset + 8];
            let tkhd_body = if version == 1 {
                // Version 1: 8-byte timestamps, width at offset + 96
                let w_off = offset + 96;
                if w_off + 8 > data.len() {
                    return None;
                }
                &data[w_off..]
            } else {
                // Version 0: 4-byte timestamps, width at offset + 84
                let w_off = offset + 84;
                if w_off + 8 > data.len() {
                    return None;
                }
                &data[w_off..]
            };

            if tkhd_body.len() < 8 {
                return None;
            }

            // Width and height are 16.16 fixed-point (u32), but we only need integer part
            let width_raw =
                u32::from_be_bytes([tkhd_body[0], tkhd_body[1], tkhd_body[2], tkhd_body[3]]);
            let height_raw =
                u32::from_be_bytes([tkhd_body[4], tkhd_body[5], tkhd_body[6], tkhd_body[7]]);

            // Extract integer part (upper 16 bits of 16.16 fixed point)
            let width = (width_raw >> 16) as u32;
            let height = (height_raw >> 16) as u32;

            if width > 0 && height > 0 {
                // Try to also find duration from mvhd box
                let duration_secs = find_mp4_duration(data);

                // Determine container subtype
                let container = determine_isobmff_container(data);

                return Some(VideoInfo {
                    width,
                    height,
                    mime: container_mime(container),
                    container: container.to_string(),
                    duration_secs,
                    estimated_tokens: estimate_video_tokens(width, height, duration_secs),
                });
            }
            return None;
        }

        // Scan for "mvhd" for duration
        if &data[offset + 4..offset + 8] == b"moov" {
            // moov is a container box — we need to skip to the next sibling
            // but if we've already scanned, continue
        }

        offset += 1;
    }

    None
}

/// Determine the ISOBMFF container subtype from the `ftyp` box.
fn determine_isobmff_container(data: &[u8]) -> &'static str {
    if data.len() < 12 {
        return "mp4";
    }
    // Scan for ftyp box
    let mut offset = 0;
    while offset + 8 <= data.len() && offset < 4096 {
        if &data[offset + 4..offset + 8] == b"ftyp" {
            if offset + 12 <= data.len() {
                let brand = u32::from_le_bytes([
                    data[offset + 8],
                    data[offset + 9],
                    data[offset + 10],
                    data[offset + 11],
                ]);
                return match brand {
                    b if b == u32::from_le_bytes(*b"qt  ") => "mov",
                    b if b == u32::from_le_bytes(*b"3gp4") => "3gp",
                    b if b == u32::from_le_bytes(*b"M4V ") => "m4v",
                    _ => "mp4",
                };
            }
            break;
        }
        offset += 1;
    }
    "mp4"
}

fn container_mime(container: &str) -> String {
    match container {
        "mov" => "video/quicktime",
        "3gp" => "video/3gpp",
        "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        _ => "video/mp4",
    }
    .to_string()
}

/// Find duration from the `mvhd` (movie header) box.
fn find_mp4_duration(data: &[u8]) -> Option<f64> {
    let mut offset = 0;
    while offset + 8 <= data.len() && offset < 65536 {
        if &data[offset + 4..offset + 8] == b"mvhd" {
            let box_size = u32::from_be_bytes([
                data[offset],
                data[offset + 1],
                data[offset + 2],
                data[offset + 3],
            ]) as usize;
            if box_size < 20 {
                return None;
            }
            let version = data[offset + 8];
            if version == 1 {
                // Version 1: timescale at +20, duration at +28 (both u64)
                if offset + 36 > data.len() {
                    return None;
                }
                let timescale = u32::from_be_bytes([
                    data[offset + 20],
                    data[offset + 21],
                    data[offset + 22],
                    data[offset + 23],
                ]);
                let duration = u64::from_be_bytes([
                    data[offset + 28], data[offset + 29],
                    data[offset + 30], data[offset + 31],
                    data[offset + 32], data[offset + 33],
                    data[offset + 34], data[offset + 35],
                ]);
                if timescale > 0 {
                    return Some(duration as f64 / timescale as f64);
                }
            } else {
                // Version 0: timescale at +12, duration at +20 (both u32)
                if offset + 24 > data.len() {
                    return None;
                }
                let timescale = u32::from_be_bytes([
                    data[offset + 12],
                    data[offset + 13],
                    data[offset + 14],
                    data[offset + 15],
                ]);
                let duration = u32::from_be_bytes([
                    data[offset + 20],
                    data[offset + 21],
                    data[offset + 22],
                    data[offset + 23],
                ]);
                if timescale > 0 {
                    return Some(duration as f64 / timescale as f64);
                }
            }
            return None;
        }
        offset += 1;
    }
    None
}

/// Parse video dimensions from Matroska/WebM EBML headers.
///
/// EBML elements are TLV (tag-length-value).  We scan for:
/// - `TrackEntry` (0xAE) → `Video` (0xE0) → `PixelWidth` (0xB0) / `PixelHeight` (0xBA)
fn parse_webm_dimensions(data: &[u8]) -> Option<VideoInfo> {
    if data.len() < 12 || data[0..4] != [0x1A, 0x45, 0xDF, 0xA3] {
        return None;
    }

    let container = if String::from_utf8_lossy(data).contains("webm") {
        "webm"
    } else {
        "mkv"
    };

    // Scan for PixelWidth (0xB0) and PixelHeight (0xBA) EBML elements
    let mut width: Option<u32> = None;
    let mut height: Option<u32> = None;

    // Simple scan: look for the 0xB0 / 0xBA tags and read the following VarInt-sized value
    let mut offset = 0;
    while offset + 3 <= data.len() && offset < 65536 {
        // Check for PixelWidth (EBML tag 0xB0)
        if data[offset] == 0xB0 {
            let (val, consumed) = read_ebml_int(data, offset + 1)?;
            width = Some(val);
            offset += 1 + consumed;
            continue;
        }
        // Check for PixelHeight (EBML tag 0xBA)
        if data[offset] == 0xBA {
            let (val, consumed) = read_ebml_int(data, offset + 1)?;
            height = Some(val);
            offset += 1 + consumed;
            continue;
        }
        // Check for Duration (EBML tag 0x4489, 2-byte)
        if data[offset..].len() >= 3
            && data[offset] == 0x44
            && data[offset + 1] == 0x89
        {
            // Duration is a float (8 bytes) after the VarInt size
            // Skip the size field (assume 1 byte)
            let dur_offset = offset + 2 + 1; // tag + size
            if dur_offset + 8 <= data.len() {
                let _duration = f64::from_be_bytes([
                    data[dur_offset], data[dur_offset + 1],
                    data[dur_offset + 2], data[dur_offset + 3],
                    data[dur_offset + 4], data[dur_offset + 5],
                    data[dur_offset + 6], data[dur_offset + 7],
                ]);
                // TimecodeScale default is 1_000_000 (nanoseconds), but
                // we set it here for the top-level duration
                // We'll handle duration later
            }
        }
        offset += 1;
    }

    if let (Some(w), Some(h)) = (width, height) {
        let mime = if container == "webm" {
            "video/webm"
        } else {
            "video/x-matroska"
        };
        let duration_secs = find_webm_duration(data);
        Some(VideoInfo {
            width: w,
            height: h,
            mime: mime.to_string(),
            container: container.to_string(),
            duration_secs,
            estimated_tokens: estimate_video_tokens(w, h, duration_secs),
        })
    } else {
        None
    }
}

/// Read an EBML VarInt-encoded integer starting at `offset`.
/// Returns (value, bytes_consumed).
fn read_ebml_int(data: &[u8], offset: usize) -> Option<(u32, usize)> {
    if offset >= data.len() {
        return None;
    }
    let first = data[offset];
    // Find the first 1 bit to determine length
    let mut len = 1;
    let mut mask = 0x80;
    while len <= 8 && (first & mask) == 0 {
        mask >>= 1;
        len += 1;
    }
    if len > 8 || offset + len > data.len() {
        return None;
    }
    // The first byte has the size marker bits removed
    let mut value = (first & (mask - 1)) as u32;
    for i in 1..len {
        value = (value << 8) | (data[offset + i] as u32);
    }
    Some((value, len))
}

/// Find duration from WebM/Matroska Segment Info (tag 0x1549A966).
fn find_webm_duration(data: &[u8]) -> Option<f64> {
    let mut offset = 0;
    while offset + 6 <= data.len() && offset < 65536 {
        // Segment Info: 0x15 0x49 0xA9 0x66
        if offset + 4 <= data.len()
            && data[offset] == 0x15
            && data[offset + 1] == 0x49
            && data[offset + 2] == 0xA9
            && data[offset + 3] == 0x66
        {
            // Skip the size field (assume compact)
            let mut size_offset = offset + 4;
            while size_offset < data.len() && data[size_offset] == 0 {
                size_offset += 1;
            }
            if size_offset >= data.len() {
                return None;
            }
            // Read the size VarInt
            let (_size, consumed) = read_ebml_int(data, size_offset)?;
            // The body starts after the size field
            let body_start = size_offset + consumed;
            // Now scan for Duration (0x4489) within the segment info
            return find_ebml_duration(data, body_start, 4096);
        }
        offset += 1;
    }
    None
}

/// Scan for Duration tag (0x4489) within a bounded region.
fn find_ebml_duration(data: &[u8], start: usize, max_len: usize) -> Option<f64> {
    let end = data.len().min(start + max_len);
    let mut offset = start;
    while offset + 2 <= end {
        // Duration tag: 0x44 0x89
        if data[offset] == 0x44 && data[offset + 1] == 0x89 {
            // Skip the size VarInt
            let size_off = offset + 2;
            if size_off >= end {
                return None;
            }
            let (_size, consumed) = read_ebml_int(data, size_off)?;
            let val_start = size_off + consumed;
            // Duration is a float (8 bytes) or optionally smaller
            if val_start + 8 <= end {
                return Some(f64::from_be_bytes([
                    data[val_start], data[val_start + 1],
                    data[val_start + 2], data[val_start + 3],
                    data[val_start + 4], data[val_start + 5],
                    data[val_start + 6], data[val_start + 7],
                ]));
            }
            return None;
        }
        offset += 1;
    }
    None
}

// ---------------------------------------------------------------------------
// Main entry points
// ---------------------------------------------------------------------------

/// Parse video information from raw file header bytes.
///
/// Supports: MP4/MOV (ISOBMFF), WebM, MKV (Matroska/EBML).
pub fn sniff_video_info(data: &[u8]) -> Option<VideoInfo> {
    if data.is_empty() {
        return None;
    }

    // Try ISOBMFF (MP4 / MOV / M4V / 3GP)
    if data.len() >= 12 && data[4..8] == *b"ftyp" {
        let info = parse_mp4_dimensions(data);
        if info.is_some() {
            return info;
        }
    }

    // Try Matroska / WebM (EBML header)
    if data.len() >= 4 && data[0..4] == [0x1A, 0x45, 0xDF, 0xA3] {
        return parse_webm_dimensions(data);
    }

    // Try MOV (may not have ftyp at offset 4, but has moov/mdat)
    if data.len() >= 36 {
        let header_str = String::from_utf8_lossy(&data[..36]);
        if header_str.contains("moov") || header_str.contains("mdat") {
            return parse_mp4_dimensions(data);
        }
    }

    None
}

/// Check if a MIME type is a recognized video format.
pub fn is_video_mime(mime: &str) -> bool {
    VIDEO_CONTAINERS.iter().any(|(_, m)| *m == mime.trim().to_lowercase())
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/// Token cost tiers per second of video.
///
/// Based on the model provider's per-second video pricing:
/// - Low resolution (SD): ~258 tokens/sec
/// - Medium resolution (HD): ~516 tokens/sec
/// - High resolution (Full HD): ~1032 tokens/sec
/// - Ultra resolution (4K): ~2064 tokens/sec
const TOKENS_PER_SECOND: &[(ResolutionTier, u64, u64)] = &[
    (ResolutionTier::Low, 0, 258),
    (ResolutionTier::Medium, 259, 516),
    (ResolutionTier::High, 517, 1032),
    (ResolutionTier::Ultra, 1033, 2064),
];

/// Estimate the token cost of a video given its dimensions and optional duration.
///
/// Uses a per-second pricing model based on resolution tier.
pub fn estimate_video_tokens(
    width: u32,
    height: u32,
    duration_secs: Option<f64>,
) -> u64 {
    let tier = ResolutionTier::from_dimensions(width, height);

    // Find tokens/sec for this tier
    let tokens_per_sec = TOKENS_PER_SECOND
        .iter()
        .find(|(t, _, _)| *t == tier)
        .map(|(_, _, t)| *t)
        .unwrap_or(258);

    let duration = duration_secs.unwrap_or(60.0); // default to 60s if unknown
    let duration = duration.max(1.0); // minimum 1s

    (tokens_per_sec as f64 * duration) as u64
}

/// Estimate the byte cost of a video frame at given dimensions.
pub fn estimate_frame_bytes(width: u32, height: u32) -> u64 {
    // Approximate bytes per frame at 24fps with modest compression
    (width as u64 * height as u64 * 3) / 100 // rough estimate: 3% of raw RGB
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolution_tier_low() {
        assert_eq!(ResolutionTier::from_dimensions(320, 240), ResolutionTier::Low);
    }

    #[test]
    fn resolution_tier_medium() {
        assert_eq!(ResolutionTier::from_dimensions(640, 480), ResolutionTier::Medium);
    }

    #[test]
    fn resolution_tier_high() {
        assert_eq!(ResolutionTier::from_dimensions(1280, 720), ResolutionTier::High);
    }

    #[test]
    fn resolution_tier_ultra() {
        assert_eq!(ResolutionTier::from_dimensions(1920, 1080), ResolutionTier::Ultra);
    }

    #[test]
    fn estimate_tokens_no_duration() {
        // Default 60s at HD (720p)
        let tokens = estimate_video_tokens(1280, 720, None);
        assert!(tokens > 0);
    }

    #[test]
    fn estimate_tokens_with_duration() {
        // 10s at HD (720p) = ~1032 * 10 = 10320
        let tokens = estimate_video_tokens(1280, 720, Some(10.0));
        assert!(tokens >= 10320);
    }

    #[test]
    fn estimate_tokens_low_res() {
        // 10s at SD = ~258 * 10 = 2580
        let tokens = estimate_video_tokens(320, 240, Some(10.0));
        assert!(tokens >= 2580);
    }

    #[test]
    fn container_lookup() {
        assert_eq!(container_from_mime("video/mp4"), "mp4");
        assert_eq!(container_from_mime("video/webm"), "webm");
        assert_eq!(container_from_mime("video/x-matroska"), "mkv");
    }

    #[test]
    fn is_video_mime_check() {
        assert!(is_video_mime("video/mp4"));
        assert!(is_video_mime("video/webm"));
        assert!(!is_video_mime("image/png"));
    }

    #[test]
    fn sniff_empty() {
        assert!(sniff_video_info(b"").is_none());
    }

    #[test]
    fn sniff_mp4_from_ftyp() {
        // Minimal ISOBMFF with ftyp + moov with tkhd
        let mut data = Vec::new();

        // ftyp box
        data.extend_from_slice(&[0x00, 0x00, 0x00, 0x14]); // size = 20
        data.extend_from_slice(b"ftyp");
        data.extend_from_slice(b"isom");
        data.extend_from_slice(&[0x00, 0x00, 0x02, 0x00]); // minor version
        data.extend_from_slice(b"isom");
        data.extend_from_slice(b"mp42");

        // moov box
        data.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]); // size placeholder
        data.extend_from_slice(b"moov");

        // tkhd box (version 0) inside moov
        let tkhd_size: u32 = 92;
        data.extend_from_slice(&tkhd_size.to_be_bytes()); // size
        data.extend_from_slice(b"tkhd");
        data.push(0x00); // version 0
        data.extend_from_slice(&[0x00, 0x00, 0x00]); // flags
        data.extend_from_slice(&0u32.to_be_bytes()); // creation_time
        data.extend_from_slice(&0u32.to_be_bytes()); // modification_time
        data.extend_from_slice(&1u32.to_be_bytes()); // track_ID
        data.extend_from_slice(&0u32.to_be_bytes()); // reserved
        data.extend_from_slice(&0u32.to_be_bytes()); // duration
        data.extend_from_slice(&[0u8; 8]); // reserved
        data.extend_from_slice(&0u16.to_be_bytes()); // layer
        data.extend_from_slice(&0u16.to_be_bytes()); // alternate_group
        data.extend_from_slice(&0u16.to_be_bytes()); // volume
        data.extend_from_slice(&0u16.to_be_bytes()); // reserved
        data.extend_from_slice(&[0u8; 36]); // matrix
        // Width (16.16 fixed point): 1920
        data.extend_from_slice(&(1920u32 << 16).to_be_bytes());
        // Height (16.16 fixed point): 1080
        data.extend_from_slice(&(1080u32 << 16).to_be_bytes());

        let info = sniff_video_info(&data);
        assert!(info.is_some());
        let info = info.unwrap();
        assert_eq!(info.width, 1920);
        assert_eq!(info.height, 1080);
        assert_eq!(info.container, "mp4");
    }

    #[test]
    fn estimate_frame_bytes_calc() {
        let bytes = estimate_frame_bytes(1920, 1080);
        assert!(bytes > 0);
    }
}