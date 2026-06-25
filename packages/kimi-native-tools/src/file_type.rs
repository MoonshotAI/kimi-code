/// File type detection via magic bytes and extension sniffing.
/// Mirrors the TypeScript `detectFileType` in `support/file-type.ts`.
use napi_derive::napi;
use std::path::Path;

/// Number of bytes to read from file header for magic-byte detection.
pub const MEDIA_SNIFF_BYTES: usize = 512;

/// Detected file kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    Text,
    Image,
    Video,
    Unknown,
}

/// Detect file type from path extension and header bytes.
pub fn detect_file_type(path: &Path, header: &[u8]) -> FileKind {
    // Check extension first for known media types.
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        let ext_lower = ext.to_ascii_lowercase();
        match ext_lower.as_str() {
            // Image extensions
            | "png" | "jpg" | "jpeg" | "gif" | "bmp" | "ico" | "webp" | "svg"
            | "tiff" | "tif" | "avif" | "heic" | "heif" | "raw" | "cr2" | "nef"
            | "arw" | "dng" | "psd" | "ai" => return FileKind::Image,
            // Video extensions
            | "mp4" | "webm" | "mkv" | "avi" | "mov" | "wmv" | "flv" | "m4v"
            | "mpg" | "mpeg" | "3gp" | "ogv" => return FileKind::Video,
            _ => {}
        }
    }

    // Magic byte detection for images.
    if is_image_magic(header) {
        return FileKind::Image;
    }

    // Magic byte detection for videos.
    if is_video_magic(header) {
        return FileKind::Video;
    }

    // Check for NUL bytes — strong indicator of binary content.
    if header.contains(&0) {
        return FileKind::Unknown;
    }

    // If we got here and the header is valid UTF-8 (or ASCII), it's text.
    if std::str::from_utf8(header).is_ok() {
        FileKind::Text
    } else {
        FileKind::Unknown
    }
}

fn is_image_magic(header: &[u8]) -> bool {
    if header.len() < 4 {
        return false;
    }
    // PNG: 89 50 4E 47
    if header.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        return true;
    }
    // JPEG: FF D8 FF
    if header.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return true;
    }
    // GIF: GIF8
    if header.starts_with(b"GIF8") {
        return true;
    }
    // BMP: BM
    if header.starts_with(b"BM") {
        return true;
    }
    // ICO: 00 00 01 00
    if header.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        return true;
    }
    // WebP: RIFF....WEBP
    if header.len() >= 12 && header.starts_with(b"RIFF") && &header[8..12] == b"WEBP" {
        return true;
    }
    // TIFF: II or MM
    if header.starts_with(b"II") || header.starts_with(b"MM") {
        return true;
    }
    false
}

fn is_video_magic(header: &[u8]) -> bool {
    if header.len() < 8 {
        return false;
    }
    // ftyp box (MP4, MOV, M4V, 3GP): starts with ....ftyp
    if header.len() >= 8 && &header[4..8] == b"ftyp" {
        return true;
    }
    // WebM/MKV: EBML header (1A 45 DF A3)
    if header.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return true;
    }
    // AVI: RIFF....AVI
    if header.len() >= 12 && header.starts_with(b"RIFF") && &header[8..12] == b"AVI " {
        return true;
    }
    // FLV: FLV\x01
    if header.starts_with(b"FLV\x01") {
        return true;
    }
    // OGG: OggS
    if header.starts_with(b"OggS") {
        return true;
    }
    false
}

/// Returns true if the content appears to be readable UTF-8 text.
#[allow(dead_code)]
pub fn is_readable_text(data: &[u8]) -> bool {
    if data.contains(&0) {
        return false;
    }
    std::str::from_utf8(data).is_ok()
}

/// Sensitive-file basenames that grep / read should refuse to surface.
///
/// Mirrors `packages/agent-core/src/tools/policies/sensitive.ts` —
/// keep the two lists in sync. The list is intentionally short to
/// avoid false positives; exemptions like `.env.example` are handled
/// explicitly in `is_sensitive_file`.
const SENSITIVE_BASENAMES: &[&str] = &[".env", "id_rsa", "id_ed25519", "id_ecdsa", "credentials"];

const ENV_EXEMPTIONS: &[&str] = &[".env.example", ".env.sample", ".env.template"];
const PUBLIC_KEY_BASENAMES: &[&str] = &["id_rsa.pub", "id_ed25519.pub", "id_ecdsa.pub"];

const SENSITIVE_BASENAME_PREFIXES: &[&str] = &["id_rsa", "id_ed25519", "id_ecdsa", "credentials"];

const SENSITIVE_DOT_VARIANT_SUFFIXES: &[&str] = &[
    ".bak", ".backup", ".copy", ".disabled", ".key", ".old", ".orig", ".pem", ".save", ".tmp",
];

/// Image dimensions (width × height in pixels).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[napi(object)]
pub struct ImageDimensions {
    pub width: u32,
    pub height: u32,
}

/// Best-effort pixel-dimension reader for common raster formats.
///
/// Inspects only the fixed region near the start of the file where each
/// format records its dimensions (the IHDR/DIB header, the RIFF chunk
/// after the `WEBP` tag, or the first JPEG SOFn segment). Returns `None`
/// for formats whose dimensions are not locatable from that region, or
/// when the supplied buffer is too short to cover it.
///
/// Mirrors `sniffImageDimensions` in `support/file-type.ts`.
pub fn sniff_image_dimensions(data: &[u8]) -> Option<ImageDimensions> {
    // PNG — IHDR is the first chunk; width/height are big-endian uint32
    // at offsets 16 and 20.
    if data.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) && data.len() >= 24 {
        let width = u32::from_be_bytes([data[16], data[17], data[18], data[19]]);
        let height = u32::from_be_bytes([data[20], data[21], data[22], data[23]]);
        return Some(ImageDimensions { width, height });
    }

    // GIF — logical-screen width/height are little-endian uint16 at
    // offsets 6 and 8.
    if (data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a")) && data.len() >= 10 {
        let width = u16::from_le_bytes([data[6], data[7]]) as u32;
        let height = u16::from_le_bytes([data[8], data[9]]) as u32;
        return Some(ImageDimensions { width, height });
    }

    // BMP — DIB header width/height are little-endian int32 at offsets 18
    // and 22 (height may be negative for top-down bitmaps).
    if data.starts_with(b"BM") && data.len() >= 26 {
        let width = i32::from_le_bytes([data[18], data[19], data[20], data[21]]) as u32;
        let height_raw = i32::from_le_bytes([data[22], data[23], data[24], data[25]]);
        let height = height_raw.unsigned_abs();
        return Some(ImageDimensions { width, height });
    }

    // WEBP — RIFF container; VP8/VP8L/VP8X each store dimensions
    // differently in the chunk that follows the 'WEBP' tag.
    if data.starts_with(b"RIFF") && data.len() >= 30 {
        let four_cc = &data[12..16];
        if four_cc == b"VP8 " {
            let width = (u16::from_le_bytes([data[26], data[27]]) & 0x3fff) as u32;
            let height = (u16::from_le_bytes([data[28], data[29]]) & 0x3fff) as u32;
            return Some(ImageDimensions { width, height });
        }
        if four_cc == b"VP8L" && data.len() >= 25 {
            let bits = u32::from_le_bytes([data[21], data[22], data[23], data[24]]);
            let width = (bits & 0x3fff) + 1;
            let height = ((bits >> 14) & 0x3fff) + 1;
            return Some(ImageDimensions { width, height });
        }
        if four_cc == b"VP8X" {
            let width = 1 + data[24] as u32 + ((data[25] as u32) << 8) + ((data[26] as u32) << 16);
            let height = 1 + data[27] as u32 + ((data[28] as u32) << 8) + ((data[29] as u32) << 16);
            return Some(ImageDimensions { width, height });
        }
    }

    // JPEG — scan segment markers for a Start-Of-Frame (SOFn) marker,
    // whose payload carries height/width as big-endian uint16.
    if data.starts_with(&[0xFF, 0xD8]) {
        let mut offset = 2usize;
        while offset + 9 < data.len() {
            if data[offset] != 0xFF {
                offset += 1;
                continue;
            }
            let marker = data[offset + 1];
            // SOFn markers carry frame dimensions; skip SOF4/SOF8/SOF12 (0xc4/0xc8/0xcc).
            if (0xC0..=0xCF).contains(&marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC {
                let height = u16::from_be_bytes([data[offset + 5], data[offset + 6]]) as u32;
                let width = u16::from_be_bytes([data[offset + 7], data[offset + 8]]) as u32;
                return Some(ImageDimensions { width, height });
            }
            // Standalone markers (RSTn, SOI, EOI) carry no length field.
            if marker == 0xD8 || marker == 0xD9 || (0xD0..=0xD7).contains(&marker) {
                offset += 2;
                continue;
            }
            let segment_length = u16::from_be_bytes([data[offset + 2], data[offset + 3]]) as usize;
            if segment_length < 2 {
                break;
            }
            offset += 2 + segment_length;
        }
    }

    None
}

/// Returns true when the supplied path points at a credentials-bearing
/// file. Matching is case-insensitive and pattern-aware: `.env.local` is
/// flagged but `.env.example` is exempted, and `id_rsa.bak` is flagged
/// while `id_rsafoo` is not.
pub fn is_sensitive_file(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    let basename = normalized.rsplit('/').next().unwrap_or(path);
    let comparable_name = basename.to_lowercase();
    let comparable_path = normalized.to_lowercase();

    if ENV_EXEMPTIONS.iter().any(|e| *e == comparable_name) {
        return false;
    }
    if PUBLIC_KEY_BASENAMES.iter().any(|e| *e == comparable_name) {
        return false;
    }
    if SENSITIVE_BASENAMES.iter().any(|e| *e == comparable_name) {
        return true;
    }
    if comparable_name.starts_with(".env.") {
        return true;
    }

    for prefix in SENSITIVE_BASENAME_PREFIXES {
        if comparable_name == *prefix {
            return true;
        }
        if comparable_name.len() > prefix.len() && comparable_name.starts_with(prefix) {
            let suffix = &comparable_name[prefix.len()..];
            let next = suffix.chars().next();
            if next == Some('-') || next == Some('_') {
                return true;
            }
            if next == Some('.') && SENSITIVE_DOT_VARIANT_SUFFIXES.iter().any(|s| *s == suffix) {
                return true;
            }
        }
    }

    for suffix in [".aws/credentials", ".gcp/credentials"] {
        if comparable_path.ends_with(&format!("/{}", suffix))
            || comparable_path.contains(&format!("/{}/", suffix))
        {
            return true;
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_png_magic() {
        let header = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        assert_eq!(
            detect_file_type(&PathBuf::from("test"), header),
            FileKind::Image
        );
    }

    #[test]
    fn test_jpeg_magic() {
        let header = &[0xFF, 0xD8, 0xFF, 0xE0];
        assert_eq!(
            detect_file_type(&PathBuf::from("test"), header),
            FileKind::Image
        );
    }

    #[test]
    fn test_gif_magic() {
        assert_eq!(
            detect_file_type(&PathBuf::from("test"), b"GIF89a"),
            FileKind::Image
        );
    }

    #[test]
    fn test_mp4_magic() {
        let header = b"\x00\x00\x00\x1cftypisom\x00\x00\x02\x00";
        assert_eq!(
            detect_file_type(&PathBuf::from("test"), header),
            FileKind::Video
        );
    }

    #[test]
    fn test_webm_magic() {
        let header = &[0x1A, 0x45, 0xDF, 0xA3, 0x01, 0x00, 0x00, 0x00];
        assert_eq!(
            detect_file_type(&PathBuf::from("test"), header),
            FileKind::Video
        );
    }

    #[test]
    fn test_text_content() {
        assert_eq!(
            detect_file_type(&PathBuf::from("test.txt"), b"hello world\n"),
            FileKind::Text
        );
    }

    #[test]
    fn test_nul_bytes_unknown() {
        assert_eq!(
            detect_file_type(&PathBuf::from("test.bin"), b"hello\x00world"),
            FileKind::Unknown
        );
    }

    #[test]
    fn test_extension_override() {
        assert_eq!(
            detect_file_type(&PathBuf::from("photo.png"), b"not a png"),
            FileKind::Image
        );
    }

    #[test]
    fn test_is_readable_text() {
        assert!(is_readable_text(b"hello world"));
        assert!(!is_readable_text(b"hello\x00world"));
        assert!(!is_readable_text(&[0xFF, 0xFE]));
    }

    #[test]
    fn test_is_sensitive_file_basenames() {
        assert!(is_sensitive_file("/repo/.env"));
        assert!(is_sensitive_file("/repo/.env.local"));
        assert!(is_sensitive_file("/repo/.env.production"));
        assert!(is_sensitive_file("/home/user/.ssh/id_rsa"));
        assert!(is_sensitive_file("/home/user/.ssh/id_ed25519"));
        assert!(is_sensitive_file("/home/user/.aws/credentials"));
        assert!(is_sensitive_file("/some/path/.gcp/credentials"));
        assert!(is_sensitive_file("C:\\Users\\foo\\.aws\\credentials"));
    }

    #[test]
    fn test_is_sensitive_file_exemptions() {
        assert!(!is_sensitive_file("/repo/.env.example"));
        assert!(!is_sensitive_file("/repo/.env.sample"));
        assert!(!is_sensitive_file("/repo/.env.template"));
        assert!(!is_sensitive_file("/home/user/.ssh/id_rsa.pub"));
        assert!(!is_sensitive_file("/home/user/.ssh/id_ed25519.pub"));
    }

    #[test]
    fn test_is_sensitive_file_variants() {
        assert!(is_sensitive_file("/secrets/id_rsa.bak"));
        assert!(is_sensitive_file("/secrets/id_rsa.old"));
        assert!(is_sensitive_file("/secrets/id_rsa-backup"));
        assert!(is_sensitive_file("/secrets/id_rsa_disabled"));
        assert!(!is_sensitive_file("/code/id_rsafoo.txt"));
        assert!(!is_sensitive_file("/code/credentials.json"));
    }

    #[test]
    fn test_is_sensitive_file_case_insensitive() {
        assert!(is_sensitive_file("/repo/.ENV"));
        assert!(is_sensitive_file("/home/User/.SSH/ID_RSA"));
    }

    // ============================================================================
    // sniff_image_dimensions tests
    // ============================================================================

    #[test]
    fn test_sniff_png_dimensions() {
        let png = [
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // signature
            0x00, 0x00, 0x00, 0x0D, // IHDR length (13)
            0x49, 0x48, 0x44, 0x52, // "IHDR"
            0x00, 0x00, 0x00, 0x64, // width = 100
            0x00, 0x00, 0x00, 0xC8, // height = 200
        ];
        let dims = sniff_image_dimensions(&png);
        assert!(dims.is_some());
        let dims = dims.unwrap();
        assert_eq!(dims.width, 100);
        assert_eq!(dims.height, 200);
    }

    #[test]
    fn test_sniff_gif_dimensions() {
        let gif = b"GIF89a\x64\x00\xC8\x00"; // width=100, height=200 (little-endian)
        let dims = sniff_image_dimensions(gif);
        assert!(dims.is_some());
        let dims = dims.unwrap();
        assert_eq!(dims.width, 100);
        assert_eq!(dims.height, 200);
    }

    #[test]
    fn test_sniff_bmp_dimensions() {
        let mut bmp = vec![0u8; 26];
        bmp[0] = b'B';
        bmp[1] = b'M';
        bmp[18] = 100;
        bmp[19] = 0;
        bmp[20] = 0;
        bmp[21] = 0;
        bmp[22] = 200;
        bmp[23] = 0;
        bmp[24] = 0;
        bmp[25] = 0;
        let dims = sniff_image_dimensions(&bmp);
        assert!(dims.is_some());
        let dims = dims.unwrap();
        assert_eq!(dims.width, 100);
        assert_eq!(dims.height, 200);
    }

    #[test]
    fn test_sniff_bmp_negative_height() {
        let mut bmp = vec![0u8; 26];
        bmp[0] = b'B';
        bmp[1] = b'M';
        bmp[18] = 100;
        bmp[19] = 0;
        bmp[20] = 0;
        bmp[21] = 0;
        let neg200 = (-200i32).to_le_bytes();
        bmp[22] = neg200[0];
        bmp[23] = neg200[1];
        bmp[24] = neg200[2];
        bmp[25] = neg200[3];
        let dims = sniff_image_dimensions(&bmp);
        assert!(dims.is_some());
        let dims = dims.unwrap();
        assert_eq!(dims.width, 100);
        assert_eq!(dims.height, 200);
    }

    #[test]
    fn test_sniff_webp_vp8_dimensions() {
        let mut data = vec![0u8; 30];
        data[0..4].copy_from_slice(b"RIFF");
        data[8..12].copy_from_slice(b"WEBP");
        data[12..16].copy_from_slice(b"VP8 ");
        // width = 320 (0x0140), height = 240 (0x00F0), little-endian with 0x3fff mask
        data[26] = 0x40;
        data[27] = 0x01;
        data[28] = 0xF0;
        data[29] = 0x00;
        let dims = sniff_image_dimensions(&data);
        assert!(dims.is_some());
        let dims = dims.unwrap();
        assert_eq!(dims.width, 320);
        assert_eq!(dims.height, 240);
    }

    #[test]
    fn test_sniff_jpeg_dimensions() {
        let mut jpeg = vec![0xFF, 0xD8]; // SOI
        jpeg.extend_from_slice(&[
            0xFF, 0xC0, // SOF0
            0x00, 0x0B, // length = 11
            0x08,       // precision
            0x00, 0xC8, // height = 200
            0x00, 0x64, // width = 100
            0x03,       // components
        ]);
        let dims = sniff_image_dimensions(&jpeg);
        assert!(dims.is_some());
        let dims = dims.unwrap();
        assert_eq!(dims.width, 100);
        assert_eq!(dims.height, 200);
    }

    #[test]
    fn test_sniff_unknown_format() {
        let data = b"not an image at all";
        let dims = sniff_image_dimensions(data);
        assert!(dims.is_none());
    }

    #[test]
    fn test_sniff_buffer_too_short() {
        let png_short = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]; // only 8 bytes
        let dims = sniff_image_dimensions(png_short);
        assert!(dims.is_none());
    }
}
