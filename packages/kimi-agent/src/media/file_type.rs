/// File-type detection via magic bytes (header content inspection).
///
/// Corresponds to `packages/agent-core-v2/src/agent/media/file-type.ts`.
///
/// Uses a two-pass strategy:
/// 1. Match known magic-byte signatures from file header bytes
/// 2. Fall back to extension-based hints
///
/// No external dependencies — all detection is hand-written byte comparison.

use crate::media::{FileType, MediaType};

// ---------------------------------------------------------------------------
// Extension → MIME tables
// ---------------------------------------------------------------------------

/// Image extension → MIME mapping (13 entries).
pub const IMAGE_MIME_BY_SUFFIX: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("bmp", "image/bmp"),
    ("svg", "image/svg+xml"),
    ("tiff", "image/tiff"),
    ("tif", "image/tiff"),
    ("ico", "image/x-icon"),
    ("avif", "image/avif"),
    ("heic", "image/heic"),
    ("heif", "image/heif"),
];

/// Video extension → MIME mapping (13 entries).
pub const VIDEO_MIME_BY_SUFFIX: &[(&str, &str)] = &[
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
    ("mpg", "video/mpeg"),
    ("ogv", "video/ogg"),
    ("ts", "video/mp2t"),
];

/// Known binary extensions that are NOT image/video (fast-reject list).
pub const NON_TEXT_SUFFIXES: &[&str] = &[
    // Archives
    "zip", "tar", "gz", "bz2", "xz", "zst", "7z", "rar",
    // Fonts
    "ttf", "otf", "woff", "woff2", "eot",
    // Executables / objects
    "exe", "dll", "so", "dylib", "wasm", "o", "a", "lib",
    // Office
    "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pdf",
    // Audio
    "mp3", "aac", "flac", "ogg", "wav", "wma", "opus",
    // Other binary
    "bin", "dat", "db", "sqlite", "iso", "img",
];

/// Look up a MIME type by file extension (images).
pub fn image_mime_from_extension(ext: &str) -> Option<&'static str> {
    let ext = ext.trim_start_matches('.').to_lowercase();
    IMAGE_MIME_BY_SUFFIX
        .iter()
        .find(|(k, _)| *k == ext)
        .map(|(_, v)| *v)
}

/// Look up a MIME type by file extension (videos).
pub fn video_mime_from_extension(ext: &str) -> Option<&'static str> {
    let ext = ext.trim_start_matches('.').to_lowercase();
    VIDEO_MIME_BY_SUFFIX
        .iter()
        .find(|(k, _)| *k == ext)
        .map(|(_, v)| *v)
}

/// Check if a file extension is a known non-text binary suffix.
pub fn is_non_text_extension(ext: &str) -> bool {
    let ext = ext.trim_start_matches('.').to_lowercase();
    NON_TEXT_SUFFIXES.contains(&ext.as_str())
}

// ---------------------------------------------------------------------------
// Magic-byte detection
// ---------------------------------------------------------------------------

/// Magic-byte detection result: media type + MIME + extension.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MagicMatch {
    pub media_type: MediaType,
    pub mime: &'static str,
    pub extension: &'static str,
}

/// RIFF-derived 4-character chunk type at offset 8.
const RIFF_CHUNK_WEBP: u32 = u32::from_le_bytes(*b"WEBP");
const RIFF_CHUNK_AVI: u32 = u32::from_le_bytes(*b"AVI ");

/// FTYP image brands (ISOBMFF).
const FTYP_IMAGE_BRANDS: &[u32] = &[
    u32::from_le_bytes(*b"avif"),
    u32::from_le_bytes(*b"heic"),
    u32::from_le_bytes(*b"heix"),
    u32::from_le_bytes(*b"hevc"),
    u32::from_le_bytes(*b"hevx"),
    u32::from_le_bytes(*b"mif1"),
    u32::from_le_bytes(*b"msf1"),
];

/// FTYP video brands (ISOBMFF).
const FTYP_VIDEO_BRANDS: &[u32] = &[
    u32::from_le_bytes(*b"isom"),
    u32::from_le_bytes(*b"mp41"),
    u32::from_le_bytes(*b"mp42"),
    u32::from_le_bytes(*b"avc1"),
    u32::from_le_bytes(*b"qt  "),
    u32::from_le_bytes(*b"3gp4"),
    u32::from_le_bytes(*b"mp71"),
];

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

/// Sniff the media type from magic bytes (file header content).
///
/// Returns `None` when no known magic pattern matches.
pub fn sniff_from_magic(data: &[u8]) -> Option<MagicMatch> {
    if data.is_empty() {
        return None;
    }

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if data.len() >= 8 && data[0..4] == [0x89, 0x50, 0x4E, 0x47] {
        return Some(MagicMatch {
            media_type: MediaType::Image,
            mime: "image/png",
            extension: "png",
        });
    }

    // JPEG: FF D8 FF
    if data.len() >= 3 && data[0..3] == [0xFF, 0xD8, 0xFF] {
        return Some(MagicMatch {
            media_type: MediaType::Image,
            mime: "image/jpeg",
            extension: "jpg",
        });
    }

    // GIF: GIF87a / GIF89a
    if data.len() >= 6
        && (data[0..6] == *b"GIF87a" || data[0..6] == *b"GIF89a")
    {
        return Some(MagicMatch {
            media_type: MediaType::Image,
            mime: "image/gif",
            extension: "gif",
        });
    }

    // BMP: BM
    if data.len() >= 2 && data[0..2] == *b"BM" {
        return Some(MagicMatch {
            media_type: MediaType::Image,
            mime: "image/bmp",
            extension: "bmp",
        });
    }

    // TIFF: little-endian (II*0x00) or big-endian (MM0x00*)
    if data.len() >= 4 {
        if data[0..4] == [0x49, 0x49, 0x2A, 0x00] {
            return Some(MagicMatch {
                media_type: MediaType::Image,
                mime: "image/tiff",
                extension: "tiff",
            });
        }
        if data[0..4] == [0x4D, 0x4D, 0x00, 0x2A] {
            return Some(MagicMatch {
                media_type: MediaType::Image,
                mime: "image/tiff",
                extension: "tiff",
            });
        }
    }

    // ICO: 00 00 01 00
    if data.len() >= 4 && data[0..4] == [0x00, 0x00, 0x01, 0x00] {
        return Some(MagicMatch {
            media_type: MediaType::Image,
            mime: "image/x-icon",
            extension: "ico",
        });
    }

    // RIFF container: parses chunk type at offset 8
    if data.len() >= 12 && data[0..4] == *b"RIFF" {
        if let Some(chunk_type) = read_u32_le(data, 8) {
            if chunk_type == RIFF_CHUNK_WEBP {
                return Some(MagicMatch {
                    media_type: MediaType::Image,
                    mime: "image/webp",
                    extension: "webp",
                });
            }
            if chunk_type == RIFF_CHUNK_AVI {
                return Some(MagicMatch {
                    media_type: MediaType::Video,
                    mime: "video/x-msvideo",
                    extension: "avi",
                });
            }
        }
    }

    // FLV: FLV
    if data.len() >= 3 && data[0..3] == *b"FLV" {
        return Some(MagicMatch {
            media_type: MediaType::Video,
            mime: "video/x-flv",
            extension: "flv",
        });
    }

    // ASF / WMV: 30 26 B2 75 8E 66 CF 11 A6 D9 00 AA 00 62 CE 6C
    if data.len() >= 16 {
        let asf_header: [u8; 16] = [
            0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11,
            0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C,
        ];
        if data[0..16] == asf_header {
            return Some(MagicMatch {
                media_type: MediaType::Video,
                mime: "video/x-ms-wmv",
                extension: "wmv",
            });
        }
    }

    // Matroska / WebM: EBML header (1A 45 DF A3) + scan for "webm" or "matroska"
    if data.len() >= 12 && data[0..4] == [0x1A, 0x45, 0xDF, 0xA3] {
        let header_str = String::from_utf8_lossy(data);
        if header_str.contains("webm") {
            return Some(MagicMatch {
                media_type: MediaType::Video,
                mime: "video/webm",
                extension: "webm",
            });
        }
        if header_str.contains("matroska") {
            return Some(MagicMatch {
                media_type: MediaType::Video,
                mime: "video/x-matroska",
                extension: "mkv",
            });
        }
    }

    // ISOBMFF (ftyp box): mp4 / mov / avif / heic
    if data.len() >= 12 && data[4..8] == *b"ftyp" {
        if let Some(brand) = read_u32_le(data, 8) {
            if FTYP_IMAGE_BRANDS.contains(&brand) {
                let (mime, ext) = if brand == u32::from_le_bytes(*b"avif") {
                    ("image/avif", "avif")
                } else {
                    ("image/heic", "heic")
                };
                return Some(MagicMatch {
                    media_type: MediaType::Image,
                    mime,
                    extension: ext,
                });
            }
            if FTYP_VIDEO_BRANDS.contains(&brand) {
                // MOV brand "qt  " gets special treatment
                if brand == u32::from_le_bytes(*b"qt  ") {
                    return Some(MagicMatch {
                        media_type: MediaType::Video,
                        mime: "video/quicktime",
                        extension: "mov",
                    });
                }
                return Some(MagicMatch {
                    media_type: MediaType::Video,
                    mime: "video/mp4",
                    extension: "mp4",
                });
            }
        }
    }

    // MOV fallback: ftyp with "qt  " brand already handled above,
    // but raw MOV files may have mdat/moov at offset 4 instead of ftyp.
    // If we see "moov" at any offset it's likely a quicktime file.
    if data.len() >= 36 {
        let header_str = String::from_utf8_lossy(&data[..36]);
        if header_str.contains("moov") || header_str.contains("mdat") {
            // Check if it's not already identified as ISOBMFF
            if data[4..8] != *b"ftyp" {
                return Some(MagicMatch {
                    media_type: MediaType::Video,
                    mime: "video/quicktime",
                    extension: "mov",
                });
            }
        }
    }

    None
}

// ---------------------------------------------------------------------------
// Main detection entry point
// ---------------------------------------------------------------------------

/// Detect file type from header bytes and optional extension.
///
/// Strategy:
/// 1. Try magic-byte sniffing first
/// 2. Fall back to extension-based hints
/// 3. Binary extension with no magic match → `unknown`
/// 4. Everything else → `text/plain`
pub fn detect_file_type(header: &[u8], extension: Option<&str>) -> FileType {
    let magic = sniff_from_magic(header);

    if let Some(m) = &magic {
        return FileType {
            media_type: m.media_type,
            mime: m.mime.to_string(),
            extension: m.extension.to_string(),
        };
    }

    // Extension-based fallback
    if let Some(ext) = extension {
        let ext = ext.trim_start_matches('.').to_lowercase();

        // SVG is special: XML source that renders as an image.
        // Classify as text with image/svg+xml MIME.
        if ext == "svg" {
            return FileType {
                media_type: MediaType::Text,
                mime: "image/svg+xml".to_string(),
                extension: ext,
            };
        }

        if let Some(mime) = image_mime_from_extension(&ext) {
            return FileType {
                media_type: MediaType::Image,
                mime: mime.to_string(),
                extension: ext,
            };
        }

        if let Some(mime) = video_mime_from_extension(&ext) {
            return FileType {
                media_type: MediaType::Video,
                mime: mime.to_string(),
                extension: ext,
            };
        }

        // Binary extension with no magic match → unknown
        if is_non_text_extension(&ext) {
            // Fall through to default
        }
    }

    // Default
    FileType {
        media_type: MediaType::Text,
        mime: "text/plain".to_string(),
        extension: extension
            .unwrap_or("txt")
            .trim_start_matches('.')
            .to_string(),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn header(bytes: &[u8]) -> Vec<u8> {
        bytes.to_vec()
    }

    #[test]
    fn sniff_png() {
        let data = header(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        let m = sniff_from_magic(&data).unwrap();
        assert_eq!(m.mime, "image/png");
        assert_eq!(m.extension, "png");
    }

    #[test]
    fn sniff_jpeg() {
        let data = header(&[0xFF, 0xD8, 0xFF, 0xE0]);
        let m = sniff_from_magic(&data).unwrap();
        assert_eq!(m.mime, "image/jpeg");
    }

    #[test]
    fn sniff_gif() {
        let data = header(b"GIF89a...");
        let m = sniff_from_magic(&data).unwrap();
        assert_eq!(m.mime, "image/gif");
    }

    #[test]
    fn sniff_webp() {
        let mut data = Vec::new();
        data.extend_from_slice(b"RIFF");
        data.extend_from_slice(&[0u8; 4]); // size placeholder
        data.extend_from_slice(b"WEBP");
        let m = sniff_from_magic(&data).unwrap();
        assert_eq!(m.mime, "image/webp");
    }

    #[test]
    fn sniff_bmp() {
        let data = header(b"BM...");
        let m = sniff_from_magic(&data).unwrap();
        assert_eq!(m.mime, "image/bmp");
    }

    #[test]
    fn sniff_tiff_le() {
        let data = header(&[0x49, 0x49, 0x2A, 0x00]);
        let m = sniff_from_magic(&data).unwrap();
        assert_eq!(m.mime, "image/tiff");
    }

    #[test]
    fn sniff_tiff_be() {
        let data = header(&[0x4D, 0x4D, 0x00, 0x2A]);
        let m = sniff_from_magic(&data).unwrap();
        assert_eq!(m.mime, "image/tiff");
    }

    #[test]
    fn sniff_ico() {
        let data = header(&[0x00, 0x00, 0x01, 0x00]);
        let m = sniff_from_magic(&data).unwrap();
        assert_eq!(m.mime, "image/x-icon");
    }

    #[test]
    fn sniff_avi() {
        let mut data = Vec::new();
        data.extend_from_slice(b"RIFF");
        data.extend_from_slice(&[0u8; 4]);
        data.extend_from_slice(b"AVI ");
        let m = sniff_from_magic(&data).unwrap();
        assert_eq!(m.media_type, MediaType::Video);
        assert_eq!(m.mime, "video/x-msvideo");
    }

    #[test]
    fn sniff_flv() {
        let data = header(b"FLV\x01\x05\x00\x00\x00\x09");
        let m = sniff_from_magic(&data).unwrap();
        assert_eq!(m.mime, "video/x-flv");
    }

    #[test]
    fn sniff_wmv() {
        let data = header(&[
            0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11,
            0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C,
        ]);
        let m = sniff_from_magic(&data).unwrap();
        assert_eq!(m.mime, "video/x-ms-wmv");
    }

    #[test]
    fn sniff_webm() {
        let mut data = Vec::new();
        data.extend_from_slice(&[0x1A, 0x45, 0xDF, 0xA3]);
        data.extend_from_slice(b"\x01\x00\x00\x00\x00\x00\x00\x00");
        data.extend_from_slice(b"webm");
        let m = sniff_from_magic(&data).unwrap();
        assert_eq!(m.mime, "video/webm");
    }

    #[test]
    fn sniff_mkv() {
        let mut data = Vec::new();
        data.extend_from_slice(&[0x1A, 0x45, 0xDF, 0xA3]);
        data.extend_from_slice(b"matroska");
        let m = sniff_from_magic(&data).unwrap();
        assert_eq!(m.mime, "video/x-matroska");
    }

    #[test]
    fn sniff_mp4() {
        let mut data = Vec::new();
        data.extend_from_slice(&[0u8; 4]); // size
        data.extend_from_slice(b"ftyp");
        data.extend_from_slice(b"isom");
        let m = sniff_from_magic(&data).unwrap();
        assert_eq!(m.mime, "video/mp4");
    }

    #[test]
    fn sniff_avif() {
        let mut data = Vec::new();
        data.extend_from_slice(&[0u8; 4]);
        data.extend_from_slice(b"ftyp");
        data.extend_from_slice(b"avif");
        let m = sniff_from_magic(&data).unwrap();
        assert_eq!(m.mime, "image/avif");
    }

    #[test]
    fn sniff_no_match() {
        let data = header(b"plain text content here");
        assert!(sniff_from_magic(&data).is_none());
    }

    #[test]
    fn detect_by_extension_only() {
        let ft = detect_file_type(b"", Some("png"));
        assert_eq!(ft.media_type, MediaType::Image);
        assert_eq!(ft.mime, "image/png");
    }

    #[test]
    fn detect_svg_extension() {
        let ft = detect_file_type(b"<svg>", Some("svg"));
        assert_eq!(ft.media_type, MediaType::Text);
        assert_eq!(ft.mime, "image/svg+xml");
    }

    #[test]
    fn detect_unknown_extension() {
        let ft = detect_file_type(b"", Some("xyz"));
        assert_eq!(ft.media_type, MediaType::Text);
        assert_eq!(ft.mime, "text/plain");
    }

    #[test]
    fn image_mime_lookup() {
        assert_eq!(image_mime_from_extension("png"), Some("image/png"));
        assert_eq!(image_mime_from_extension(".jpg"), Some("image/jpeg"));
        assert_eq!(image_mime_from_extension("tiff"), Some("image/tiff"));
        assert!(image_mime_from_extension("mp4").is_none());
    }

    #[test]
    fn video_mime_lookup() {
        assert_eq!(video_mime_from_extension("mp4"), Some("video/mp4"));
        assert_eq!(video_mime_from_extension("webm"), Some("video/webm"));
        assert!(video_mime_from_extension("png").is_none());
    }
}