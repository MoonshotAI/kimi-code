//! Error types for LLM provider communication.
//! Mirrors `packages/kosong/src/errors.ts`.

use napi_derive::napi;
use thiserror::Error;

/// Base error for all provider-related errors.
#[derive(Error, Debug)]
pub enum ProviderError {
    #[error("Connection error: {0}")]
    Connection(String),

    #[error("Timeout: {0}")]
    Timeout(String),

    #[error("API error (status={status}): {message}")]
    ApiStatus {
        status: u16,
        message: String,
        request_id: Option<String>,
        retry_after_ms: Option<u64>,
    },

    #[error("Rate limited: {0}")]
    RateLimit(String),

    #[error("Empty response: {0}")]
    EmptyResponse(String),

    #[error("Provider error: {0}")]
    Provider(String),

    #[error("HTTP error: {0}")]
    Http(#[from] super::http::HttpError),

    #[error("Serialization error: {0}")]
    Serialization(String),
}

impl ProviderError {
    /// Whether this error is retryable.
    pub fn is_retryable(&self) -> bool {
        match self {
            ProviderError::Connection(_) => true,
            ProviderError::Timeout(_) => true,
            ProviderError::ApiStatus { status, .. } => {
                matches!(status, 408 | 409 | 429 | 500 | 502 | 503 | 504 | 529)
            }
            ProviderError::RateLimit(_) => true,
            ProviderError::EmptyResponse(_) => true,
            ProviderError::Provider(_) => false,
            ProviderError::Http(_) => true,
            ProviderError::Serialization(_) => false,
        }
    }

    /// Whether this error is specifically a rate limit.
    pub fn is_rate_limit(&self) -> bool {
        matches!(self, ProviderError::RateLimit(_) | ProviderError::ApiStatus { status: 429, .. })
    }
}

// napi-exported error for JS consumption
#[napi(object)]
pub struct NativeError {
    pub code: i32,
    pub message: String,
    pub retryable: bool,
    pub is_rate_limit: bool,
}

impl From<ProviderError> for NativeError {
    fn from(err: ProviderError) -> Self {
        let (code, retryable, is_rate_limit) = match &err {
            ProviderError::Connection(_) => (1, true, false),
            ProviderError::Timeout(_) => (2, true, false),
            ProviderError::ApiStatus { status, .. } => (*status as i32, true, *status == 429),
            ProviderError::RateLimit(_) => (429, true, true),
            ProviderError::EmptyResponse(_) => (3, true, false),
            ProviderError::Provider(_) => (4, false, false),
            ProviderError::Http(_) => (5, true, false),
            ProviderError::Serialization(_) => (6, false, false),
        };
        NativeError {
            code,
            message: err.to_string(),
            retryable,
            is_rate_limit,
        }
    }
}