/// Kimi file URL handling — parse `kimi://file/xxx` URLs and download file content.
///
/// Corresponds to `packages/agent-core-v2/src/agent/media/kimiFileUrl.ts`.
///
/// Kimi file URLs use the custom `kimi://file/` scheme to reference files
/// managed by the Kimi host. The URL format is:
///
/// ```text
/// kimi://file/<file_id>
/// ```
///
/// where `<file_id>` is a non-empty, URL-safe identifier string.
///
/// The actual file download is delegated to the host via a callback trait,
/// since the host (JS/TS) manages file storage and access control.

use serde::{Deserialize, Serialize};
use std::future::Future;
use std::pin::Pin;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// The `kimi://file/` URL scheme prefix.
const KIMI_FILE_PREFIX: &str = "kimi://file/";

/// Maximum length for a file ID (256 chars).
const MAX_FILE_ID_LENGTH: usize = 256;

/// Minimum length for a file ID (1 char).
const MIN_FILE_ID_LENGTH: usize = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A parsed Kimi file URL (`kimi://file/<file_id>`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KimiFileUrl {
    /// The extracted file identifier.
    pub file_id: String,
    /// The original URL string.
    pub original_url: String,
}

/// Error type for Kimi file URL operations.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KimiFileUrlError {
    /// Human-readable error message.
    pub message: String,
}

impl std::fmt::Display for KimiFileUrlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for KimiFileUrlError {}

/// Boxed future for async download results.
pub type DownloadFuture = Pin<Box<dyn Future<Output = Result<Vec<u8>, String>> + Send>>;

/// Callback trait for downloading files from the host.
///
/// The host (JS/TS) is responsible for resolving the `kimi://file/<file_id>`
/// URL and returning the raw file bytes. Implementations may use HTTP, IPC,
/// or direct filesystem access depending on the runtime environment.
pub trait FileDownloader: Send + Sync {
    /// Download the file identified by `file_id`.
    ///
    /// # Arguments
    ///
    /// * `file_id` - The file identifier (extracted from the URL)
    ///
    /// # Returns
    ///
    /// The raw file bytes on success, or an error message on failure.
    fn download(&self, file_id: &str) -> DownloadFuture;
}

/// Default implementation that returns an error (useful as a placeholder).
pub struct NoopFileDownloader;

impl FileDownloader for NoopFileDownloader {
    fn download(&self, file_id: &str) -> DownloadFuture {
        let msg = format!(
            "No file downloader configured; cannot download kimi://file/{file_id}"
        );
        Box::pin(async move { Err(msg) })
    }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/// Parse a `kimi://file/<file_id>` URL.
///
/// # Arguments
///
/// * `url` - The URL string to parse (e.g. `"kimi://file/abc123"`)
///
/// # Returns
///
/// `Ok(KimiFileUrl)` if the URL is valid, `Err(KimiFileUrlError)` otherwise.
///
/// # Validation rules
///
/// - Must start with `kimi://file/`
/// - The file ID must be non-empty
/// - The file ID must be URL-safe (alphanumeric, hyphens, underscores, dots)
/// - The file ID must not exceed 256 characters
pub fn parse_kimi_file_url(url: &str) -> Result<KimiFileUrl, KimiFileUrlError> {
    let trimmed = url.trim();

    // Check prefix
    if !trimmed.starts_with(KIMI_FILE_PREFIX) {
        // Char-based truncation: URLs are external input and may contain
        // multi-byte characters — a byte slice could split a code point
        // and panic.
        let preview: String = trimmed.chars().take(40).collect();
        let truncated = preview.chars().count() < trimmed.chars().count();
        return Err(KimiFileUrlError {
            message: format!(
                "Invalid Kimi file URL: must start with 'kimi://file/', got '{}{}'",
                preview,
                if truncated { "..." } else { "" }
            ),
        });
    }

    // Extract file ID
    let file_id = &trimmed[KIMI_FILE_PREFIX.len()..];

    // Check for empty file ID
    if file_id.len() < MIN_FILE_ID_LENGTH {
        return Err(KimiFileUrlError {
            message: "Invalid Kimi file URL: file ID is empty".to_string(),
        });
    }

    // Check maximum length
    if file_id.len() > MAX_FILE_ID_LENGTH {
        return Err(KimiFileUrlError {
            message: format!(
                "Invalid Kimi file URL: file ID exceeds maximum length of {} characters (got {})",
                MAX_FILE_ID_LENGTH,
                file_id.len()
            ),
        });
    }

    // Validate file ID characters (URL-safe: alphanumeric, hyphens, underscores, dots)
    if !file_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(KimiFileUrlError {
            message: format!(
                "Invalid Kimi file URL: file ID contains invalid characters \
                 (only alphanumeric, hyphens, underscores, and dots are allowed)"
            ),
        });
    }

    Ok(KimiFileUrl {
        file_id: file_id.to_string(),
        original_url: trimmed.to_string(),
    })
}

/// Check if a string looks like a Kimi file URL (starts with `kimi://file/`).
pub fn is_kimi_file_url(url: &str) -> bool {
    url.trim().starts_with(KIMI_FILE_PREFIX)
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/// Download a file from a parsed Kimi file URL using the provided downloader.
///
/// # Arguments
///
/// * `url` - The parsed Kimi file URL
/// * `downloader` - The file downloader implementation
///
/// # Returns
///
/// The raw file bytes on success, or an error message on failure.
pub async fn download_kimi_file(
    url: &KimiFileUrl,
    downloader: &dyn FileDownloader,
) -> Result<Vec<u8>, String> {
    downloader.download(&url.file_id).await
}

/// Convenience function: parse a URL string and download the file in one step.
///
/// # Arguments
///
/// * `url_str` - The URL string (e.g. `"kimi://file/abc123"`)
/// * `downloader` - The file downloader implementation
///
/// # Returns
///
/// The raw file bytes on success, or an error message on failure.
pub async fn parse_and_download(
    url_str: &str,
    downloader: &dyn FileDownloader,
) -> Result<Vec<u8>, String> {
    let parsed = parse_kimi_file_url(url_str)
        .map_err(|e| e.message)?;
    download_kimi_file(&parsed, downloader).await
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ── Mock downloader for tests ──────────────────────────────────────────

    struct MockDownloader {
        should_fail: bool,
        data: Vec<u8>,
    }

    impl MockDownloader {
        fn new(data: Vec<u8>) -> Self {
            Self {
                should_fail: false,
                data,
            }
        }

        fn failing() -> Self {
            Self {
                should_fail: true,
                data: Vec::new(),
            }
        }
    }

    impl FileDownloader for MockDownloader {
        fn download(&self, file_id: &str) -> DownloadFuture {
            let data = self.data.clone();
            let should_fail = self.should_fail;
            let fid = file_id.to_string();
            Box::pin(async move {
                if should_fail {
                    Err(format!("Failed to download file: {fid}"))
                } else {
                    Ok(data)
                }
            })
        }
    }

    // ── Parse tests ────────────────────────────────────────────────────────

    #[test]
    fn test_parse_valid_url() {
        let url = parse_kimi_file_url("kimi://file/abc123").unwrap();
        assert_eq!(url.file_id, "abc123");
        assert_eq!(url.original_url, "kimi://file/abc123");
    }

    #[test]
    fn test_parse_url_with_hyphens() {
        let url = parse_kimi_file_url("kimi://file/my-file-id_123").unwrap();
        assert_eq!(url.file_id, "my-file-id_123");
    }

    #[test]
    fn test_parse_url_with_dots() {
        let url = parse_kimi_file_url("kimi://file/file.name.v1").unwrap();
        assert_eq!(url.file_id, "file.name.v1");
    }

    #[test]
    fn test_parse_url_trimmed() {
        let url = parse_kimi_file_url("  kimi://file/abc123  ").unwrap();
        assert_eq!(url.file_id, "abc123");
    }

    #[test]
    fn test_parse_url_uuid() {
        let uuid = "550e8400-e29b-41d4-a716-446655440000";
        let url_str = format!("kimi://file/{uuid}");
        let url = parse_kimi_file_url(&url_str).unwrap();
        assert_eq!(url.file_id, uuid);
    }

    #[test]
    fn test_parse_empty_url() {
        let err = parse_kimi_file_url("").unwrap_err();
        assert!(err.message.contains("must start with"));
    }

    #[test]
    fn test_parse_wrong_scheme() {
        let err = parse_kimi_file_url("https://example.com/file").unwrap_err();
        assert!(err.message.contains("must start with"));
    }

    #[test]
    fn test_parse_empty_file_id() {
        let err = parse_kimi_file_url("kimi://file/").unwrap_err();
        assert!(err.message.contains("file ID is empty"));
    }

    #[test]
    fn test_parse_file_id_with_invalid_chars() {
        let err = parse_kimi_file_url("kimi://file/abc 123").unwrap_err();
        assert!(err.message.contains("invalid characters"));

        let err = parse_kimi_file_url("kimi://file/abc/def").unwrap_err();
        assert!(err.message.contains("invalid characters"));
    }

    #[test]
    fn test_parse_file_id_too_long() {
        let long_id = "a".repeat(MAX_FILE_ID_LENGTH + 1);
        let url_str = format!("kimi://file/{long_id}");
        let err = parse_kimi_file_url(&url_str).unwrap_err();
        assert!(err.message.contains("exceeds maximum length"));
    }

    #[test]
    fn test_parse_file_id_max_length() {
        let long_id = "a".repeat(MAX_FILE_ID_LENGTH);
        let url_str = format!("kimi://file/{long_id}");
        let url = parse_kimi_file_url(&url_str).unwrap();
        assert_eq!(url.file_id.len(), MAX_FILE_ID_LENGTH);
    }

    // ── is_kimi_file_url tests ─────────────────────────────────────────────

    #[test]
    fn test_is_kimi_file_url_true() {
        assert!(is_kimi_file_url("kimi://file/abc123"));
    }

    #[test]
    fn test_is_kimi_file_url_false() {
        assert!(!is_kimi_file_url("https://example.com"));
        assert!(!is_kimi_file_url(""));
        assert!(!is_kimi_file_url("kimi://notfile/abc"));
    }

    #[test]
    fn test_is_kimi_file_url_trimmed() {
        assert!(is_kimi_file_url("  kimi://file/abc123  "));
    }

    // ── Download tests ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn test_download_success() {
        let data = b"hello world".to_vec();
        let downloader = MockDownloader::new(data.clone());
        let url = parse_kimi_file_url("kimi://file/test123").unwrap();
        let result = download_kimi_file(&url, &downloader).await.unwrap();
        assert_eq!(result, data);
    }

    #[tokio::test]
    async fn test_download_failure() {
        let downloader = MockDownloader::failing();
        let url = parse_kimi_file_url("kimi://file/test123").unwrap();
        let result = download_kimi_file(&url, &downloader).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Failed to download"));
    }

    #[tokio::test]
    async fn test_parse_and_download_success() {
        let data = b"test content".to_vec();
        let downloader = MockDownloader::new(data.clone());
        let result = parse_and_download("kimi://file/abc123", &downloader).await;
        assert_eq!(result.unwrap(), data);
    }

    #[tokio::test]
    async fn test_parse_and_download_invalid_url() {
        let downloader = MockDownloader::new(Vec::new());
        let result = parse_and_download("not-a-kimi-url", &downloader).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("must start with"));
    }

    // ── Noop downloader test ───────────────────────────────────────────────

    #[tokio::test]
    async fn test_noop_downloader() {
        let downloader = NoopFileDownloader;
        let url = parse_kimi_file_url("kimi://file/abc").unwrap();
        let result = download_kimi_file(&url, &downloader).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("No file downloader configured"));
    }

    // ── Round-trip test ────────────────────────────────────────────────────

    #[test]
    fn test_parse_serialize_roundtrip() {
        let url = parse_kimi_file_url("kimi://file/uuid-123").unwrap();
        let json = serde_json::to_string(&url).unwrap();
        let deserialized: KimiFileUrl = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.file_id, "uuid-123");
        assert_eq!(deserialized.original_url, "kimi://file/uuid-123");
    }
}