//! HTTP-backed [`FileDownloader`] — fetches `kimi://file/<file_id>` content
//! directly from Rust via reqwest, instead of delegating the download back to
//! the JS host.
//!
//! The host previously resolved file ids over IPC; this native implementation
//! composes `{base_url}/{file_id}` and GETs it with an optional `Authorization`
//! header, so the standalone binary can materialise media without a host
//! round-trip. The transport mirrors `llm/http.rs`'s reqwest client setup.

use std::time::Duration;

use crate::media::kimi_file_url::{DownloadFuture, FileDownloader};

/// Per-request timeout for a single file fetch.
const DOWNLOAD_TIMEOUT_SECS: u64 = 120;

/// An HTTP-backed [`FileDownloader`]. Resolves a file id to
/// `{base_url}/{file_id}` and fetches the raw bytes, optionally sending an
/// `Authorization` header.
pub struct HttpFileDownloader {
    client: reqwest::Client,
    base_url: String,
    auth_header: Option<String>,
}

impl HttpFileDownloader {
    /// Build a downloader rooted at `base_url` (a trailing slash is tolerated).
    /// `auth_header`, when set, is sent verbatim as the `Authorization` value
    /// (e.g. `"Bearer <token>"`).
    pub fn new(base_url: impl Into<String>, auth_header: Option<String>) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(DOWNLOAD_TIMEOUT_SECS))
            .connect_timeout(Duration::from_secs(15))
            .build()
            .unwrap_or_default();
        Self {
            client,
            base_url: base_url.into(),
            auth_header,
        }
    }

    /// Compose the fetch URL for a file id, collapsing a trailing slash on the
    /// base so we never emit `//` between the base and the id.
    fn resolve_url(&self, file_id: &str) -> String {
        format!("{}/{}", self.base_url.trim_end_matches('/'), file_id)
    }
}

impl FileDownloader for HttpFileDownloader {
    fn download(&self, file_id: &str) -> DownloadFuture {
        let url = self.resolve_url(file_id);
        let client = self.client.clone();
        let auth = self.auth_header.clone();
        Box::pin(async move {
            let mut req = client.get(&url);
            if let Some(value) = auth {
                req = req.header("Authorization", value);
            }
            let resp = req
                .send()
                .await
                .map_err(|e| format!("file download request failed: {e}"))?;
            let resp = resp
                .error_for_status()
                .map_err(|e| format!("file download HTTP error: {e}"))?;
            let bytes = resp
                .bytes()
                .await
                .map_err(|e| format!("file download body read failed: {e}"))?;
            Ok(bytes.to_vec())
        })
    }
}

/// Build a native file downloader from the environment, or `None` when no
/// `KIMI_FILE_BASE_URL` is configured (the caller then keeps the host proxy /
/// noop). `KIMI_FILE_AUTH`, when present, is sent verbatim as the
/// `Authorization` header value (e.g. `"Bearer <token>"`).
///
/// This is the standalone-binary seam: with a file base URL set, the engine
/// materialises `kimi://file/<id>` media itself instead of relying on a JS
/// host round-trip.
pub fn from_env() -> Option<HttpFileDownloader> {
    let base_url = std::env::var("KIMI_FILE_BASE_URL")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())?;
    let auth = std::env::var("KIMI_FILE_AUTH")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    Some(HttpFileDownloader::new(base_url, auth))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_url_trims_trailing_slash() {
        let d = HttpFileDownloader::new("https://files.example.com/api/", None);
        assert_eq!(d.resolve_url("abc123"), "https://files.example.com/api/abc123");
    }

    #[test]
    fn resolve_url_without_trailing_slash() {
        let d = HttpFileDownloader::new("https://files.example.com/api", None);
        assert_eq!(d.resolve_url("f1"), "https://files.example.com/api/f1");
    }

    #[test]
    fn new_records_optional_auth() {
        let d = HttpFileDownloader::new("https://x.test", Some("Bearer t".to_string()));
        assert_eq!(d.auth_header.as_deref(), Some("Bearer t"));
    }

    #[test]
    fn new_without_auth_is_none() {
        let d = HttpFileDownloader::new("https://x.test", None);
        assert!(d.auth_header.is_none());
    }
}
