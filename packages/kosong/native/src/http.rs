//! HTTP client for LLM provider communication.
//! Replaces `packages/kosong/src/http/undici-agent.ts` and the SDK HTTP layer.

use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE};
use std::time::Duration;

/// Default timeout for the full response body (300s for streaming).
const BODY_TIMEOUT_SECS: u64 = 300;

/// A shared HTTP client for LLM provider requests.
/// Created once and reused across all provider calls.
pub struct HttpClient {
    inner: reqwest::Client,
}

impl HttpClient {
    /// Create a new shared HTTP client with sensible defaults.
    pub fn shared() -> &'static Self {
        static CLIENT: std::sync::OnceLock<HttpClient> = std::sync::OnceLock::new();
        CLIENT.get_or_init(|| {
            let inner = reqwest::Client::builder()
                .timeout(Duration::from_secs(BODY_TIMEOUT_SECS))
                .connect_timeout(Duration::from_secs(10))
                .pool_max_idle_per_host(16)
                .pool_idle_timeout(Duration::from_secs(60))
                .tcp_keepalive(Duration::from_secs(30))
                .http1_only()
                .build()
                .expect("Failed to create HTTP client");
            HttpClient { inner }
        })
    }

    /// Build a POST request with JSON body and send it.
    pub async fn post_json(
        &self,
        url: &str,
        api_key: &str,
        body: &str,
        extra_headers: Option<&std::collections::HashMap<String, String>>,
    ) -> Result<reqwest::Response, HttpError> {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-api-key",
            HeaderValue::from_str(api_key).map_err(|e| HttpError::InvalidHeader(e.to_string()))?,
        );
        headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );

        if let Some(extra) = extra_headers {
            for (key, value) in extra {
                if let Ok(hv) = HeaderValue::from_str(value) {
                    headers.insert(
                        reqwest::header::HeaderName::from_bytes(key.as_bytes())
                            .map_err(|e| HttpError::InvalidHeader(e.to_string()))?,
                        hv,
                    );
                }
            }
        }

        let response = self
            .inner
            .post(url)
            .headers(headers)
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| HttpError::RequestFailed(e.to_string()))?;

        Ok(response)
    }

    /// Stream a POST request with JSON body, returning the response for streaming.
    pub async fn post_json_stream(
        &self,
        url: &str,
        api_key: &str,
        body: &str,
        extra_headers: Option<&std::collections::HashMap<String, String>>,
    ) -> Result<reqwest::Response, HttpError> {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-api-key",
            HeaderValue::from_str(api_key).map_err(|e| HttpError::InvalidHeader(e.to_string()))?,
        );
        headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );

        if let Some(extra) = extra_headers {
            for (key, value) in extra {
                if let Ok(hv) = HeaderValue::from_str(value) {
                    headers.insert(
                        reqwest::header::HeaderName::from_bytes(key.as_bytes())
                            .map_err(|e| HttpError::InvalidHeader(e.to_string()))?,
                        hv,
                    );
                }
            }
        }

        let response = self
            .inner
            .post(url)
            .headers(headers)
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| HttpError::RequestFailed(e.to_string()))?;

        Ok(response)
    }
}

/// HTTP-level errors.
#[derive(Debug)]
pub enum HttpError {
    RequestFailed(String),
    InvalidHeader(String),
    StatusError(u16, String),
    Timeout(String),
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HttpError::RequestFailed(msg) => write!(f, "HTTP request failed: {}", msg),
            HttpError::InvalidHeader(msg) => write!(f, "Invalid header: {}", msg),
            HttpError::StatusError(code, msg) => write!(f, "HTTP {}: {}", code, msg),
            HttpError::Timeout(msg) => write!(f, "HTTP timeout: {}", msg),
        }
    }
}

impl std::error::Error for HttpError {}