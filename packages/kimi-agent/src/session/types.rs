/// Session types — core data structures for session management.
///
/// These types are distinct from the persistence-layer `SessionRecord` in
/// [`crate::persistence::session_store`] which stores raw JSON blobs.  This
/// module provides a richer domain model with typed fields.
use serde::{Deserialize, Serialize};

use crate::rpc::types::Message;

// ── SessionState ────────────────────────────────────────────────────────────

/// Lifecycle state of a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    /// Session is running or ready to resume.
    #[default]
    Active,
    /// Session is temporarily suspended (resources may be freed).
    Paused,
    /// Session has been closed and cannot be resumed.
    Closed,
}

// ── ModelConfig ─────────────────────────────────────────────────────────────

/// Lightweight model configuration stored with a session.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelConfig {
    /// Provider name (e.g. `"anthropic"`, `"openai"`, `"kimi"`).
    pub provider: String,
    /// Model identifier (e.g. `"claude-sonnet-4-20250514"`).
    pub model: String,
    /// Optional maximum tokens override.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
}

// ── MessageRecord ───────────────────────────────────────────────────────────

/// A single message in the conversation history, stored as part of a session.
///
/// Wraps the RPC [`Message`] type used by the turn loop, adding a timestamp
/// for ordering and display.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageRecord {
    /// The underlying message (role, content, blocks, tool calls).
    #[serde(flatten)]
    pub message: Message,
    /// ISO-8601 timestamp of when this message was added.
    pub timestamp: String,
}

// ── SessionRecord ───────────────────────────────────────────────────────────

/// A rich session record with typed fields.
///
/// This is the primary domain object for the session module.  It is
/// serialised to/from the persistence layer's JSON blob fields when
/// saving/loading.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRecord {
    /// Unique session identifier.
    pub id: String,
    /// ISO-8601 creation timestamp.
    pub created_at: String,
    /// ISO-8601 last-update timestamp.
    pub updated_at: String,
    /// Human-readable title (may be empty).
    #[serde(default)]
    pub title: String,
    /// Working directory at session creation time.
    #[serde(default)]
    pub work_dir: String,
    /// Model configuration snapshot.
    #[serde(default)]
    pub model_config: ModelConfig,
    /// Conversation history.
    #[serde(default)]
    pub messages: Vec<MessageRecord>,
    /// Current lifecycle state.
    #[serde(default)]
    pub state: SessionState,
    /// Durable agent state (context history + goal), written by
    /// `Agent::save_session` and restored by `Agent::load_session`.
    /// Opaque to the session module itself.
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub agent_state: serde_json::Value,
    /// Host-owned custom metadata (shallow-merged via `session/update_metadata`).
    /// Always a JSON object; defaults to `{}`.
    #[serde(default, skip_serializing_if = "is_empty_object")]
    pub metadata: serde_json::Value,
}

fn is_empty_object(v: &serde_json::Value) -> bool {
    v.as_object().map_or(true, |m| m.is_empty())
}

impl SessionRecord {
    /// Create a new session with the given id and model config.
    pub fn new(id: impl Into<String>, model_config: ModelConfig) -> Self {
        let now = iso_now();
        Self {
            id: id.into(),
            created_at: now.clone(),
            updated_at: now,
            title: String::new(),
            work_dir: String::new(),
            model_config,
            messages: Vec::new(),
            state: SessionState::Active,
            agent_state: serde_json::Value::Null,
            metadata: serde_json::json!({}),
        }
    }

    /// Touch the `updated_at` timestamp.
    pub fn touch(&mut self) {
        self.updated_at = iso_now();
    }

    /// Append a message to the conversation history.
    pub fn push_message(&mut self, message: Message) {
        self.messages.push(MessageRecord {
            message,
            timestamp: iso_now(),
        });
        self.touch();
    }

    /// Shape check for cached session records.
    ///
    /// A cached `SessionRecord` is only trusted when it carries the fields the
    /// session layer relies on. Entries whose key fields are empty (e.g. an
    /// `id` or timestamp that was missing on write and came back as an empty
    /// string — mirroring the TS read-model bug where `undefined` fields were
    /// dropped by JSON serialization) are treated as poisoned: the session
    /// manager treats them as a cold miss, rebuilds from the store, and
    /// overwrites the bad cache entry. `state` is excluded from the check: the
    /// enum guarantees a valid variant by construction, and an invalid variant
    /// fails at deserialization instead.
    pub fn is_valid_shape(&self) -> bool {
        !self.id.is_empty() && !self.created_at.is_empty() && !self.updated_at.is_empty()
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn iso_now() -> String {
    // Use a simple UTC ISO-8601 format.  chrono is not a dependency, so we
    // build the string from the system clock via std::time.
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    // Microseconds as fractional seconds.
    let micros = dur.subsec_micros();
    // Format as UTC ISO-8601 (no chrono dependency).
    // We use a simple calculation from Unix timestamp.
    let (y, mo, d, h, mi, s) = unix_epoch_to_ymdhms(secs);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:06}Z",
        y, mo, d, h, mi, s, micros
    )
}

/// Convert a Unix timestamp (seconds since epoch) to (year, month, day,
/// hour, minute, second) in UTC.
fn unix_epoch_to_ymdhms(secs: u64) -> (u64, u64, u64, u64, u64, u64) {
    // Days since Unix epoch.
    let days = secs / 86_400;
    let time_secs = secs % 86_400;
    let h = time_secs / 3600;
    let mi = (time_secs % 3600) / 60;
    let s = time_secs % 60;

    // Civil date from days since 1970-01-01.
    let (y, mo, d) = civil_from_days(days as i64);
    (y as u64, mo as u64, d as u64, h, mi, s)
}

/// Convert days since 1970-01-01 to (year, month, day).
/// Uses the Howard Hinnant algorithm (public domain).
fn civil_from_days(z: i64) -> (i64, u64, u64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097; // day of era [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // year of era [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // day of year [0, 365]
    let mp = (5 * doy + 2) / 153; // month phase [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // day [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // month [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    (y, m as u64, d as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_session_record_new() {
        let cfg = ModelConfig {
            provider: "anthropic".into(),
            model: "claude-sonnet-4-20250514".into(),
            max_tokens: Some(8192),
        };
        let record = SessionRecord::new("sess-1", cfg.clone());
        assert_eq!(record.id, "sess-1");
        assert_eq!(record.model_config.provider, "anthropic");
        assert_eq!(record.model_config.model, "claude-sonnet-4-20250514");
        assert_eq!(record.state, SessionState::Active);
        assert!(record.messages.is_empty());
        assert!(!record.created_at.is_empty());
        assert_eq!(record.created_at, record.updated_at);
    }

    #[test]
    fn test_push_message() {
        let cfg = ModelConfig {
            provider: "openai".into(),
            model: "gpt-4".into(),
            max_tokens: None,
        };
        let mut record = SessionRecord::new("sess-2", cfg);
        let msg = Message {
            role: "user".into(),
            content: "Hello".into(),
            blocks: vec![],
            tool_calls: vec![],
            tool_call_id: None,
        };
        record.push_message(msg.clone());
        assert_eq!(record.messages.len(), 1);
        assert_eq!(record.messages[0].message.role, "user");
        assert_eq!(record.messages[0].message.content, "Hello");
        assert!(record.updated_at > record.created_at);
    }

    #[test]
    fn test_session_state_serde() {
        let json = serde_json::to_string(&SessionState::Active).unwrap();
        assert_eq!(json, "\"active\"");
        let parsed: SessionState = serde_json::from_str("\"paused\"").unwrap();
        assert_eq!(parsed, SessionState::Paused);
    }

    #[test]
    fn test_model_config_serde() {
        let cfg = ModelConfig {
            provider: "kimi".into(),
            model: "kimi-latest".into(),
            max_tokens: Some(4096),
        };
        let json = serde_json::to_value(&cfg).unwrap();
        assert_eq!(json["provider"], "kimi");
        assert_eq!(json["max_tokens"], 4096);
    }

    #[test]
    fn test_iso_now_format() {
        let s = iso_now();
        // Must end with Z and have at least the T separator.
        assert!(s.ends_with('Z'), "expected Z suffix, got {s}");
        assert!(s.contains('T'), "expected T separator, got {s}");
    }

    #[test]
    fn test_unix_epoch_known_values() {
        // 1970-01-01T00:00:00Z
        assert_eq!(unix_epoch_to_ymdhms(0), (1970, 1, 1, 0, 0, 0));
        // 2025-01-15T10:30:00Z
        assert_eq!(unix_epoch_to_ymdhms(1736937000), (2025, 1, 15, 10, 30, 0));
    }
}