/// Provider error taxonomy.
///
/// Corresponds to `kosong/contract/errors.ts`.
use std::fmt;

/// Wire error code for invalid model/provider configuration.
pub const CONFIG_INVALID_ERROR_CODE: &str = "config.invalid";

/// Base error type for all chat provider errors.
#[derive(Debug, Clone)]
pub enum ChatProviderError {
    ApiConnection(String),
    ApiTimeout(String),
    ApiStatus {
        status_code: u16,
        message: String,
        request_id: Option<String>,
        retry_after_ms: Option<u64>,
        trace_id: Option<String>,
    },
    ApiContextOverflow(ApiStatusPayload),
    ApiRequestTooLarge(ApiStatusPayload),
    ApiRateLimit(ApiStatusPayload),
    ApiProviderOverloaded(ApiStatusPayload),
    ApiQuotaExhausted(ApiStatusPayload),
    ApiEmptyResponse {
        message: String,
        finish_reason: Option<String>,
        raw_finish_reason: Option<String>,
    },
    VideoUploadUnsupported(String),
    Provider(String),
}

impl fmt::Display for ChatProviderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ChatProviderError::ApiConnection(msg) => write!(f, "API connection error: {}", msg),
            ChatProviderError::ApiTimeout(msg) => write!(f, "API timeout: {}", msg),
            ChatProviderError::ApiStatus { status_code, message, .. } => {
                write!(f, "API status error: {} {}", status_code, message)
            }
            ChatProviderError::ApiContextOverflow(p) => {
                write!(f, "API context overflow: {}", p.message)
            }
            ChatProviderError::ApiRequestTooLarge(p) => {
                write!(f, "API request too large: {}", p.message)
            }
            ChatProviderError::ApiRateLimit(p) => write!(f, "API rate limit (429): {}", p.message),
            ChatProviderError::ApiProviderOverloaded(p) => {
                write!(f, "API provider overloaded: {}", p.message)
            }
            ChatProviderError::ApiQuotaExhausted(p) => {
                write!(f, "API quota exhausted (429): {}", p.message)
            }
            ChatProviderError::ApiEmptyResponse { message, .. } => {
                write!(f, "API empty response: {}", message)
            }
            ChatProviderError::VideoUploadUnsupported(msg) => {
                write!(f, "Video upload unsupported: {}", msg)
            }
            ChatProviderError::Provider(msg) => write!(f, "Provider error: {}", msg),
        }
    }
}

impl std::error::Error for ChatProviderError {}

/// Payload for status-based errors.
#[derive(Debug, Clone)]
pub struct ApiStatusPayload {
    pub status_code: u16,
    pub message: String,
    pub request_id: Option<String>,
    pub retry_after_ms: Option<u64>,
    pub trace_id: Option<String>,
}

impl ChatProviderError {
    pub fn is_retryable(&self) -> bool {
        match self {
            ChatProviderError::ApiConnection(_) | ChatProviderError::ApiTimeout(_) => true,
            ChatProviderError::ApiEmptyResponse { .. } => true,
            ChatProviderError::ApiStatus { status_code, message, .. } => {
                if matches!(status_code, 408 | 409 | 429 | 500 | 502 | 503 | 504 | 529) {
                    return true;
                }
                // Some reverse proxies (e.g. Xunfei) wrap upstream transient
                // failures with non-5xx status codes while putting the real
                // failure in the body — match on `code: N` so those still
                // get retried (kosong `errors.ts` parity).
                if let Some(code) = extract_message_code(message) {
                    return is_transient_xunfei_code(&code);
                }
                false
            }
            ChatProviderError::ApiRateLimit(_) | ChatProviderError::ApiProviderOverloaded(_) => true,
            // Quota exhaustion (billing/balance) can never succeed on retry —
            // fail fast even when a Retry-After header is present.
            ChatProviderError::ApiQuotaExhausted(_) => false,
            ChatProviderError::ApiContextOverflow(_) => false,
            ChatProviderError::ApiRequestTooLarge(_) => false,
            ChatProviderError::VideoUploadUnsupported(_) => false,
            ChatProviderError::Provider(msg) => {
                // Xunfei error codes are decisive even without an HTTP
                // status: transient codes retry, non-transient (invalid key,
                // insufficient balance, blacklist) never do.
                if let Some(code) = extract_message_code(msg) {
                    return is_transient_xunfei_code(&code);
                }
                let lower = msg.to_lowercase();
                !(lower.contains("unsupported media type for base64 image")
                    || lower.contains("invalid data url for image"))
            }
        }
    }

    pub fn status_code(&self) -> Option<u16> {
        match self {
            ChatProviderError::ApiStatus { status_code, .. }
            | ChatProviderError::ApiContextOverflow(ApiStatusPayload { status_code, .. })
            | ChatProviderError::ApiRequestTooLarge(ApiStatusPayload { status_code, .. })
            | ChatProviderError::ApiRateLimit(ApiStatusPayload { status_code, .. })
            | ChatProviderError::ApiProviderOverloaded(ApiStatusPayload { status_code, .. })
            | ChatProviderError::ApiQuotaExhausted(ApiStatusPayload { status_code, .. }) => {
                Some(*status_code)
            }
            _ => None,
        }
    }
}

/// Classification of a failed generation for telemetry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiErrorKind {
    ContextOverflow,
    Overloaded,
    RateLimit,
    QuotaExhausted,
    Auth,
    Server5xx,
    Client4xx,
    Network,
    Timeout,
    EmptyResponse,
    Other,
}

/// Result of classifying an API error.
#[derive(Debug, Clone)]
pub struct ApiErrorClassification {
    pub kind: ApiErrorKind,
    pub status_code: Option<u16>,
}

/// Classify an API error for telemetry.
pub fn classify_api_error(error: &ChatProviderError) -> ApiErrorClassification {
    let status_code = error.status_code();
    match error {
        ChatProviderError::ApiContextOverflow(_) => {
            ApiErrorClassification {
                kind: ApiErrorKind::ContextOverflow,
                status_code,
            }
        }
        ChatProviderError::ApiProviderOverloaded(_) => ApiErrorClassification {
            kind: ApiErrorKind::Overloaded,
            status_code,
        },
        ChatProviderError::ApiQuotaExhausted(_) => ApiErrorClassification {
            kind: ApiErrorKind::QuotaExhausted,
            status_code,
        },
        ChatProviderError::ApiRateLimit(_) => ApiErrorClassification {
            kind: ApiErrorKind::RateLimit,
            status_code,
        },
        ChatProviderError::ApiStatus { status_code: 401 | 403, .. } => ApiErrorClassification {
            kind: ApiErrorKind::Auth,
            status_code: Some(401),
        },
        ChatProviderError::ApiStatus { .. } if status_code.map_or(false, |c| c >= 500) => {
            ApiErrorClassification {
                kind: ApiErrorKind::Server5xx,
                status_code,
            }
        }
        ChatProviderError::ApiStatus { .. } if status_code.map_or(false, |c| c >= 400) => {
            ApiErrorClassification {
                kind: ApiErrorKind::Client4xx,
                status_code,
            }
        }
        ChatProviderError::ApiConnection(_) => ApiErrorClassification {
            kind: ApiErrorKind::Network,
            status_code: None,
        },
        ChatProviderError::ApiTimeout(_) => ApiErrorClassification {
            kind: ApiErrorKind::Timeout,
            status_code: None,
        },
        ChatProviderError::ApiEmptyResponse { .. } => ApiErrorClassification {
            kind: ApiErrorKind::EmptyResponse,
            status_code: None,
        },
        _ => ApiErrorClassification {
            kind: ApiErrorKind::Other,
            status_code: None,
        },
    }
}

/// Normalize an API status error into the appropriate error variant.
pub fn normalize_api_status_error(
    status_code: u16,
    message: &str,
    request_id: Option<String>,
    retry_after_ms: Option<u64>,
    trace_id: Option<String>,
) -> ChatProviderError {
    let msg = message.to_string();

    // Xunfei reverse-proxy rate-limit codes are the real signal when the
    // status code is not 429: 11202 second-level, 11203 concurrent, 11210
    // upstream (kosong `errors.ts` parity — the code check runs ahead of the
    // status classification).
    if let Some(code) = extract_message_code(message) {
        if XUNFEI_RATE_LIMIT_CODES.contains(&code.as_str()) {
            return ChatProviderError::ApiProviderOverloaded(ApiStatusPayload {
                status_code,
                message: msg,
                request_id,
                retry_after_ms,
                trace_id,
            });
        }
    }

    match status_code {
        429 => {
            if is_quota_exhausted_status_error(status_code, message) {
                ChatProviderError::ApiQuotaExhausted(ApiStatusPayload {
                    status_code,
                    message: msg,
                    request_id,
                    retry_after_ms,
                    trace_id,
                })
            } else {
                ChatProviderError::ApiRateLimit(ApiStatusPayload {
                    status_code,
                    message: msg,
                    request_id,
                    retry_after_ms,
                    trace_id,
                })
            }
        }
        _ if is_context_overflow_status_error(status_code, message) => {
            ChatProviderError::ApiContextOverflow(ApiStatusPayload {
                status_code,
                message: msg,
                request_id,
                retry_after_ms,
                trace_id,
            })
        }
        _ if is_request_too_large_status_error(status_code, message) => {
            ChatProviderError::ApiRequestTooLarge(ApiStatusPayload {
                status_code,
                message: msg,
                request_id,
                retry_after_ms,
                trace_id,
            })
        }
        _ if is_provider_overload_status_error(status_code, message) => {
            ChatProviderError::ApiProviderOverloaded(ApiStatusPayload {
                status_code,
                message: msg,
                request_id,
                retry_after_ms,
                trace_id,
            })
        }
        _ => ChatProviderError::ApiStatus {
            status_code,
            message: msg,
            request_id,
            retry_after_ms,
            trace_id,
        },
    }
}

// ---------------------------------------------------------------------------
// Error classification helpers
// ---------------------------------------------------------------------------

/// Xunfei wraps upstream transient failures as non-5xx statuses with the
/// real cause in `code: N, msg: ...` (kosong `errors.ts` parity).
const XUNFEI_TRANSIENT_CODES: &[&str] = &[
    "10006", "10007", "10008", "10009", "10010", "10011", "10012", "10110", "10222", "10223",
    "11202", "11203", "11210",
];

/// Xunfei error codes that are deterministic — never retried.
const XUNFEI_NON_TRANSIENT_CODES: &[&str] = &["10001", "10002", "10015"];

/// Xunfei reverse-proxy rate-limit codes: 11202 second-level, 11203
/// concurrent, 11210 upstream.
const XUNFEI_RATE_LIMIT_CODES: &[&str] = &["11202", "11203", "11210"];

/// Whether a `code: N` message code is transient and retryable (transient
/// wins only when not also listed as deterministic).
fn is_transient_xunfei_code(code: &str) -> bool {
    XUNFEI_TRANSIENT_CODES.contains(&code) && !XUNFEI_NON_TRANSIENT_CODES.contains(&code)
}

/// Extract the `code: N` value a reverse proxy (Xunfei) embeds in an error
/// message; `None` when the message carries no such code.
pub fn extract_message_code(message: &str) -> Option<String> {
    let idx = message.find("code:")?;
    let rest = message[idx + "code:".len()..].trim_start();
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        None
    } else {
        Some(digits)
    }
}

fn message_contains_any(message: &str, patterns: &[&str]) -> bool {
    let lower = message.to_lowercase();
    patterns.iter().any(|p| lower.contains(p))
}

pub fn is_context_overflow_status_error(status_code: u16, message: &str) -> bool {
    if !matches!(status_code, 400 | 413 | 422) {
        return false;
    }
    let patterns = [
        "context_length",
        "context_length_exceeded",
        "context window",
        "maximum context",
        "max tokens",
        "too many tokens",
        "prompt is too long",
        "input token count",
        "model token limit",
    ];
    message_contains_any(message, &patterns)
}

pub fn is_provider_overload_status_error(status_code: u16, message: &str) -> bool {
    if status_code == 529 {
        return true;
    }
    if !matches!(status_code, 500 | 503) {
        return false;
    }
    message_contains_any(message, &["overload"])
}

/// Detect a quota-exhausted 429 (account quota / insufficient balance).
///
/// Corresponds to upstream `classifyKimiQuotaError` / the OpenAI
/// `insufficient_quota` code (#1857): such a 429 can never succeed on
/// retry, so it must be classified as `ApiQuotaExhausted` (non-retryable)
/// instead of `ApiRateLimit`. Signals cover both Moonshot's
/// `exceeded_current_quota_error` error.type and OpenAI's documented
/// `insufficient_quota` code, plus billing-anchored message wordings as a
/// fallback for gateways that flatten the body to text.
pub fn is_quota_exhausted_status_error(status_code: u16, message: &str) -> bool {
    if status_code != 429 {
        return false;
    }
    let lower = message.to_lowercase();
    const PATTERNS: &[&str] = &[
        "exceeded_current_quota_error", // Moonshot error.type
        "insufficient_quota",           // OpenAI error.code
        "quota exceeded",
        "quota_exceeded",
        "quota exhausted",
        "out of quota",
        "insufficient balance",
        "billing limit",
        "account balance",
    ];
    PATTERNS.iter().any(|p| lower.contains(p))
}

pub fn is_request_too_large_status_error(status_code: u16, message: &str) -> bool {
    if status_code != 413 {
        return false;
    }
    let patterns = [
        "request exceeds the maximum size",
        "request entity too large",
        "request_too_large",
        "payload too large",
        "content too large",
        "request body too large",
        "request too large",
    ];
    message_contains_any(message, &patterns)
}

pub fn is_image_format_error(error: &ChatProviderError) -> bool {
    match error {
        ChatProviderError::ApiContextOverflow(_) | ChatProviderError::ApiRequestTooLarge(_) => {
            return false;
        }
        ChatProviderError::ApiStatus { status_code: 400, message, .. } => {
            let lower = message.to_lowercase();
            check_image_format_patterns(&lower)
        }
        ChatProviderError::Provider(msg) => {
            let lower = msg.to_lowercase();
            lower.contains("unsupported media type for base64 image")
                || lower.contains("invalid data url for image")
        }
        _ => false,
    }
}

fn check_image_format_patterns(lower: &str) -> bool {
    let image_patterns = [
        "unsupported image",
        "invalid image",
        "could not process image",
        "could not decode image",
        "unable to process image",
        "failed to decode image",
        "does not represent a valid image",
    ];
    let media_type_pattern = ["media_type", "mime_type", "mimetype"];
    (image_patterns.iter().any(|p| lower.contains(p)))
        || (media_type_pattern.iter().any(|p| lower.contains(p)) && lower.contains("image"))
}

pub fn is_tool_exchange_adjacency_error(error: &ChatProviderError) -> bool {
    match error {
        ChatProviderError::ApiContextOverflow(_) => return false,
        ChatProviderError::ApiStatus { status_code, message, .. }
            if *status_code == 400 || *status_code == 422 =>
        {
            has_tool_exchange_pattern(message)
        }
        _ => false,
    }
}

fn has_tool_exchange_pattern(message: &str) -> bool {
    let lower = message.to_lowercase();
    let patterns = [
        "tool_use",
        "tool_result",
        "unexpected tool_result",
        "tool_call_id not found",
        "role 'tool' must be a response",
        "tool_calls must be followed by",
        "tool_call_ids did not have response",
        "insufficient tool messages",
    ];
    patterns.iter().any(|p| lower.contains(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_retryable_status_codes() {
        for code in &[408, 409, 429, 500, 502, 503, 504, 529] {
            let err = ChatProviderError::ApiStatus {
                status_code: *code,
                message: "error".to_string(),
                request_id: None,
                retry_after_ms: None,
                trace_id: None,
            };
            assert!(err.is_retryable(), "code {} should be retryable", code);
        }
    }

    #[test]
    fn test_non_retryable_4xx() {
        let err = ChatProviderError::ApiStatus {
            status_code: 400,
            message: "bad request".to_string(),
            request_id: None,
            retry_after_ms: None,
            trace_id: None,
        };
        assert!(!err.is_retryable());
    }

    #[test]
    fn test_context_overflow_detection() {
        assert!(is_context_overflow_status_error(400, "context_length_exceeded"));
        assert!(is_context_overflow_status_error(400, "max tokens exceeded"));
        assert!(!is_context_overflow_status_error(400, "bad request"));
    }

    #[test]
    fn test_rate_limit() {
        let err = normalize_api_status_error(429, "too many requests", None, None, None);
        assert!(matches!(err, ChatProviderError::ApiRateLimit(_)));
    }

    #[test]
    fn test_quota_exhausted_429_is_not_rate_limit() {
        // Moonshot error.type signal
        let err = normalize_api_status_error(
            429,
            "{\"error\":{\"type\":\"exceeded_current_quota_error\"}}",
            None,
            None,
            None,
        );
        assert!(
            matches!(err, ChatProviderError::ApiQuotaExhausted(_)),
            "quota signal must map to ApiQuotaExhausted, got {err:?}"
        );
        assert!(!err.is_retryable(), "quota exhaustion must not retry");

        // OpenAI error.code signal
        let err = normalize_api_status_error(
            429,
            "{\"error\":{\"code\":\"insufficient_quota\"}}",
            None,
            None,
            None,
        );
        assert!(matches!(err, ChatProviderError::ApiQuotaExhausted(_)));

        // Billing wording fallback
        let err = normalize_api_status_error(429, "Quota exceeded for the account", None, None, None);
        assert!(matches!(err, ChatProviderError::ApiQuotaExhausted(_)));

        // A plain rate-limit 429 stays retryable
        let err = normalize_api_status_error(429, "Too Many Requests", None, None, None);
        assert!(matches!(err, ChatProviderError::ApiRateLimit(_)));
        assert!(err.is_retryable());
    }

    #[test]
    fn test_image_format_error() {
        let err = ChatProviderError::ApiStatus {
            status_code: 400,
            message: "unsupported image format".to_string(),
            request_id: None,
            retry_after_ms: None,
            trace_id: None,
        };
        assert!(is_image_format_error(&err));
    }

    #[test]
    fn test_classify_api_error() {
        let err = ChatProviderError::ApiConnection("connection failed".to_string());
        let classification = classify_api_error(&err);
        assert_eq!(classification.kind, ApiErrorKind::Network);

        let err = ChatProviderError::ApiTimeout("timed out".to_string());
        let classification = classify_api_error(&err);
        assert_eq!(classification.kind, ApiErrorKind::Timeout);
    }

    #[test]
    fn test_api_rate_limit_classification() {
        let err = ChatProviderError::ApiRateLimit(ApiStatusPayload {
            status_code: 429,
            message: "rate limited".to_string(),
            request_id: None,
            retry_after_ms: None,
            trace_id: None,
        });
        let classification = classify_api_error(&err);
        assert_eq!(classification.kind, ApiErrorKind::RateLimit);
    }

    #[test]
    fn test_api_quota_exhausted_classification() {
        let err = ChatProviderError::ApiQuotaExhausted(ApiStatusPayload {
            status_code: 429,
            message: "exceeded_current_quota_error".to_string(),
            request_id: None,
            retry_after_ms: None,
            trace_id: None,
        });
        let classification = classify_api_error(&err);
        assert_eq!(classification.kind, ApiErrorKind::QuotaExhausted);
    }

    #[test]
    fn test_is_tool_exchange_adjacency() {
        let err = ChatProviderError::ApiStatus {
            status_code: 400,
            message: "tool_use blocks must be followed by tool_result".to_string(),
            request_id: None,
            retry_after_ms: None,
            trace_id: None,
        };
        assert!(is_tool_exchange_adjacency_error(&err));
    }
}
    #[test]
    fn test_xunfei_transient_codes_retry_on_non_5xx_status() {
        for code in ["10006", "10012", "10222", "11202"] {
            let err = ChatProviderError::ApiStatus {
                status_code: 400,
                message: format!("code: {code}, msg: upstream transient"),
                request_id: None,
                retry_after_ms: None,
                trace_id: None,
            };
            assert!(err.is_retryable(), "code {code} should retry");
        }
    }

    #[test]
    fn test_xunfei_non_transient_codes_never_retry() {
        for code in ["10001", "10002", "10015"] {
            let err = ChatProviderError::ApiStatus {
                status_code: 400,
                message: format!("code: {code}, msg: deterministic"),
                request_id: None,
                retry_after_ms: None,
                trace_id: None,
            };
            assert!(!err.is_retryable(), "code {code} must not retry");
            // Also decisive without an HTTP status (bare provider error).
            let err = ChatProviderError::Provider(format!("code: {code}, msg: deterministic"));
            assert!(!err.is_retryable(), "provider code {code} must not retry");
        }
    }

    #[test]
    fn test_xunfei_rate_limit_codes_normalize_to_overloaded() {
        for code in ["11202", "11203", "11210"] {
            let err = normalize_api_status_error(400, &format!("code: {code}, msg: rate limited"), None, None, None);
            assert!(
                matches!(err, ChatProviderError::ApiProviderOverloaded(_)),
                "code {code} should classify as overloaded"
            );
        }
        // A transient-but-not-rate-limit code keeps its status classification.
        let err = normalize_api_status_error(400, "code: 10006, msg: upstream", None, None, None);
        assert!(matches!(err, ChatProviderError::ApiStatus { .. }));
    }

    #[test]
    fn test_extract_message_code() {
        assert_eq!(extract_message_code("code: 11202, msg: x"), Some("11202".to_string()));
        assert_eq!(extract_message_code("code:12345"), Some("12345".to_string()));
        assert_eq!(extract_message_code("no code here"), None);
        assert_eq!(extract_message_code("code: abc"), None);
    }
