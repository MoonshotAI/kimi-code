/// WebP animated detection — parse VP8X chunk to detect animation frames.
///
/// Corresponds to `packages/agent-core-v2/src/agent/media/webp-animated.ts`.
///
/// WebP animation is indicated by the ANIM flag (bit 1) in the VP8X feature byte.
/// Animated WebP files contain an ANIM chunk followed by one or more ANMF chunks.
///
/// # Format reference
///
/// - RIFF header: 12 bytes (RIFF + size + WEBP)
/// - VP8X chunk: 12 + 8 bytes header + 10 bytes data
///   - Feature flags at byte 20 (relative to file start): bit 1 = ANIM
///   - Canvas width at bytes 24-26 (24-bit LE, +1)
///   - Canvas height at bytes 27-29 (24-bit LE, +1)
/// - ANIM chunk (if animated): background color (4 bytes) + loop count (2 bytes LE)
/// - ANMF chunks (one per frame): 12-byte header + frame data

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// RIFF chunk type for WEBP (little-endian).
const RIFF_CHUNK_WEBP: u32 = u32::from_le_bytes(*b"WEBP");

/// VP8X chunk tag (little-endian).
const CHUNK_VP8X: u32 = u32::from_le_bytes(*b"VP8X");

/// ANMF chunk tag (little-endian) — each frame.
const CHUNK_ANMF: u32 = u32::from_le_bytes(*b"ANMF");

/// Bit 1 (0x02) in the VP8X feature byte = ANIM (animation) flag.
const VP8X_FLAG_ANIM: u8 = 0x02;

/// Maximum bytes to scan for ANMF chunks (256 KB). Beyond this, we stop
/// counting to avoid excessive scanning on large files.
const MAX_ANMF_SCAN: usize = 256 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Result of WebP animation detection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedAnimation {
    /// Whether the WebP has an ANIM flag (is animated).
    pub is_animated: bool,
    /// Number of animation frames (0 if not animated, or if counting was
    /// truncated due to scan limits).
    pub frame_count: u32,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Read a u32 at `offset` from `data` (little-endian).
fn read_u32_le(data: &[u8], offset: usize) -> Option<u32> {
    if offset + 4 <= data.len() {
        Some(u32::from_le_bytes([
            data[offset],
            data[offset + 1],
            data[offset + 2],
            data[offset + 3],
        ]))
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Chunk iteration
// ---------------------------------------------------------------------------

/// A chunk within a RIFF container: tag (4 bytes) + data size + data.
struct RiffChunk<'a> {
    tag: u32,
    data: &'a [u8],
}

/// Iterate over RIFF chunks starting at `offset` (which should point past the
/// RIFF header, e.g. offset 12 for a top-level RIFF). Returns `None` when
/// the chunk extends past the data or when the offset is exhausted.
fn next_chunk<'a>(data: &'a [u8], offset: &mut usize) -> Option<RiffChunk<'a>> {
    if *offset + 8 > data.len() {
        return None;
    }
    let chunk_size = read_u32_le(data, *offset)? as usize;
    // chunk_size includes padding to even boundary; the tag is 4 bytes
    let padded_size = if chunk_size % 2 == 0 {
        chunk_size
    } else {
        chunk_size + 1
    };
    let tag = read_u32_le(data, *offset + 4)?;
    let chunk_data_start = *offset + 8;
    let chunk_data = if chunk_size > 0 {
        let end = chunk_data_start + chunk_size.min(data.len() - chunk_data_start);
        &data[chunk_data_start..end]
    } else {
        &[]
    };
    *offset += 8 + padded_size;
    Some(RiffChunk {
        tag,
        data: chunk_data,
    })
}

// ---------------------------------------------------------------------------
// Main detection
// ---------------------------------------------------------------------------

/// Detect whether a WebP file is animated and count its frames.
///
/// Parses the RIFF container, locates the VP8X chunk, checks the ANIM flag,
/// and if animated, counts ANMF chunks to determine the frame count.
///
/// # Arguments
///
/// * `data` - Raw WebP file bytes (must start with "RIFF....WEBP")
///
/// # Returns
///
/// `Some(DetectedAnimation)` if the data is a valid WebP file, `None` if the
/// data is too short or does not start with a valid WebP header.
pub fn detect_webp_animation(data: &[u8]) -> Option<DetectedAnimation> {
    // Validate RIFF + WEBP header
    if data.len() < 12 {
        return None;
    }
    if &data[0..4] != b"RIFF" {
        return None;
    }
    let riff_type = read_u32_le(data, 8)?;
    if riff_type != RIFF_CHUNK_WEBP {
        return None;
    }

    // Scan for VP8X chunk starting at offset 12
    let mut offset = 12;
    let mut is_animated = false;
    let mut frame_count: u32 = 0;

    while offset + 8 <= data.len() {
        let chunk = next_chunk(data, &mut offset)?;

        if chunk.tag == CHUNK_VP8X {
            // VP8X data is at least 10 bytes
            if chunk.data.len() < 10 {
                return None;
            }
            // Feature byte is the first byte of VP8X data
            let features = chunk.data[0];
            is_animated = (features & VP8X_FLAG_ANIM) != 0;

            if !is_animated {
                // Not animated; no need to scan further
                return Some(DetectedAnimation {
                    is_animated: false,
                    frame_count: 0,
                });
            }

            // Continue scanning for ANIM and ANMF chunks
            continue;
        }

        if is_animated && chunk.tag == CHUNK_ANMF {
            frame_count += 1;
            // Stop counting if we've scanned enough
            if offset > MAX_ANMF_SCAN {
                break;
            }
        }

        // Safety: stop if we've gone too far
        if offset > MAX_ANMF_SCAN && frame_count > 0 {
            break;
        }
    }

    Some(DetectedAnimation {
        is_animated,
        frame_count,
    })
}

/// Quick check: is the given data a WebP file?
pub fn is_webp(data: &[u8]) -> bool {
    if data.len() < 12 {
        return false;
    }
    &data[0..4] == b"RIFF" && read_u32_le(data, 8) == Some(RIFF_CHUNK_WEBP)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal WebP header with VP8X (extended) chunk.
    /// `anim_flag`: set the ANIM bit in the VP8X feature byte.
    /// `anmf_count`: number of ANMF chunks to embed after the VP8X chunk.
    fn build_webp_with_vp8x(anim_flag: bool, anmf_count: u32) -> Vec<u8> {
        let mut data = Vec::new();

        // RIFF header
        data.extend_from_slice(b"RIFF");
        // size placeholder (will be filled at the end)
        let size_pos = 4;
        data.extend_from_slice(&[0u8; 4]);
        data.extend_from_slice(b"WEBP");

        // VP8X chunk: 8-byte header + 10-byte data
        let vp8x_data_size: u32 = 10;
        data.extend_from_slice(&vp8x_data_size.to_le_bytes());
        data.extend_from_slice(b"VP8X");
        // Feature flags: bit 1 = ANIM
        if anim_flag {
            data.push(VP8X_FLAG_ANIM);
        } else {
            data.push(0x00);
        }
        // 7 bytes reserved (RFC: 3 bytes reserved + width/height)
        data.extend_from_slice(&[0u8; 9]); // 9 bytes = 7 reserved + 3 reserved + 6 w/h

        // If animated, add ANIM chunk (optional but adds realism)
        if anim_flag {
            // ANIM chunk: 8-byte header + 6-byte data
            let anim_data_size: u32 = 6;
            data.extend_from_slice(&anim_data_size.to_le_bytes());
            data.extend_from_slice(b"ANIM");
            // Background color (4 bytes) + loop count (2 bytes LE)
            data.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]); // bg color
            data.extend_from_slice(&0u16.to_le_bytes()); // loop count = 0 (infinite)

            // Add ANMF chunks
            for _ in 0..anmf_count {
                // Each ANMF chunk: 8-byte header + 12-byte frame header + minimal data
                let anmf_size: u32 = 16; // 12-byte header + 4 bytes of dummy data
                data.extend_from_slice(&anmf_size.to_le_bytes());
                data.extend_from_slice(b"ANMF");
                // Frame header: x (3 LE), y (3 LE), w (3 LE), h (3 LE)
                data.extend_from_slice(&[0x00, 0x00, 0x00]); // x = 0
                data.extend_from_slice(&[0x00, 0x00, 0x00]); // y = 0
                data.extend_from_slice(&[0x64, 0x00, 0x00]); // w = 100
                data.extend_from_slice(&[0x64, 0x00, 0x00]); // h = 100
                // Dummy frame data (VP8/VP8L compressed)
                data.extend_from_slice(&[0u8; 4]);
            }
        }

        // Update RIFF size
        let riff_size = (data.len() - 8) as u32;
        data[size_pos..size_pos + 4].copy_from_slice(&riff_size.to_le_bytes());

        data
    }

    #[test]
    fn test_not_webp_empty() {
        assert!(detect_webp_animation(b"").is_none());
    }

    #[test]
    fn test_not_webp_short() {
        assert!(detect_webp_animation(b"RIFF").is_none());
    }

    #[test]
    fn test_not_webp_wrong_magic() {
        assert!(detect_webp_animation(b"RIFF....AVI ").is_none());
    }

    #[test]
    fn test_static_webp_no_anim() {
        let data = build_webp_with_vp8x(false, 0);
        let result = detect_webp_animation(&data).unwrap();
        assert!(!result.is_animated);
        assert_eq!(result.frame_count, 0);
    }

    #[test]
    fn test_animated_webp_zero_frames() {
        // Technically odd for an animated WebP to have 0 frames, but
        // the parser should handle it gracefully.
        let data = build_webp_with_vp8x(true, 0);
        let result = detect_webp_animation(&data).unwrap();
        assert!(result.is_animated);
        assert_eq!(result.frame_count, 0);
    }

    #[test]
    fn test_animated_webp_single_frame() {
        let data = build_webp_with_vp8x(true, 1);
        let result = detect_webp_animation(&data).unwrap();
        assert!(result.is_animated);
        assert_eq!(result.frame_count, 1);
    }

    #[test]
    fn test_animated_webp_multiple_frames() {
        let data = build_webp_with_vp8x(true, 5);
        let result = detect_webp_animation(&data).unwrap();
        assert!(result.is_animated);
        assert_eq!(result.frame_count, 5);
    }

    #[test]
    fn test_animated_webp_many_frames() {
        let data = build_webp_with_vp8x(true, 42);
        let result = detect_webp_animation(&data).unwrap();
        assert!(result.is_animated);
        assert_eq!(result.frame_count, 42);
    }

    #[test]
    fn test_is_webp_check() {
        let data = build_webp_with_vp8x(false, 0);
        assert!(is_webp(&data));
        assert!(!is_webp(b""));
        assert!(!is_webp(b"GIF89a..."));
    }

    #[test]
    fn test_detect_anim_on_invalid_data_returns_none() {
        // Random data that looks like RIFF but not WEBP
        let data = b"RIFF\x00\x00\x00\x00ABCD";
        assert!(detect_webp_animation(data).is_none());
    }

    #[test]
    fn test_smallest_valid_webp() {
        // Minimal: RIFF header + WEBP tag + VP8X chunk (30 bytes)
        let mut data = vec![
            b'R', b'I', b'F', b'F', 0x16, 0x00, 0x00, 0x00, // RIFF, size = 22
            b'W', b'E', b'B', b'P', // WEBP
            0x0A, 0x00, 0x00, 0x00, // VP8X chunk size = 10
            b'V', b'P', b'8', b'X', // VP8X
            0x00, // feature flags (no anim)
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // reserved
        ];
        data.resize(30, 0);

        let result = detect_webp_animation(&data).unwrap();
        assert!(!result.is_animated);
        assert_eq!(result.frame_count, 0);
    }

    #[test]
    fn test_anim_flag_detection() {
        // Only the ANIM flag bit set, no ANMF chunks
        let mut data = vec![
            b'R', b'I', b'F', b'F', 0x16, 0x00, 0x00, 0x00,
            b'W', b'E', b'B', b'P',
            0x0A, 0x00, 0x00, 0x00,
            b'V', b'P', b'8', b'X',
            0x02, // ANIM flag set
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ];
        data.resize(30, 0);

        let result = detect_webp_animation(&data).unwrap();
        assert!(result.is_animated);
        assert_eq!(result.frame_count, 0);
    }
}