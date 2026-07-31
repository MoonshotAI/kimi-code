/// Model capability — describes the modalities and limits of a specific model.
///
/// Corresponds to `kosong/contract/capability.ts`.
use serde::{Deserialize, Serialize};

/// Describes what a model can do. `UNKNOWN_CAPABILITY` is the sentinel value
/// returned when nothing is known about a model: `max_context_tokens: 0` means
/// "unknown"; callers that do not gate on context length can ignore the field.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelCapability {
    #[serde(default)]
    pub image_in: bool,
    #[serde(default)]
    pub video_in: bool,
    #[serde(default)]
    pub audio_in: bool,
    #[serde(default)]
    pub thinking: bool,
    #[serde(default)]
    pub tool_use: bool,
    #[serde(default)]
    pub max_context_tokens: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_input_tokens: Option<u32>,
    #[serde(default)]
    pub dynamically_loaded_tools: bool,
    /// Internal marker: true for the unknown sentinel.
    #[serde(skip)]
    pub(crate) _unknown_marker: bool,
}

impl ModelCapability {
    /// Create a new ModelCapability with all fields set to false/0.
    pub const fn empty() -> Self {
        Self {
            image_in: false,
            video_in: false,
            audio_in: false,
            thinking: false,
            tool_use: false,
            max_context_tokens: 0,
            max_input_tokens: None,
            dynamically_loaded_tools: false,
            _unknown_marker: false,
        }
    }
}

/// The sentinel value for "unknown capability".
pub const UNKNOWN_CAPABILITY: ModelCapability = ModelCapability {
    image_in: false,
    video_in: false,
    audio_in: false,
    thinking: false,
    tool_use: false,
    max_context_tokens: 0,
    max_input_tokens: None,
    dynamically_loaded_tools: false,
    _unknown_marker: true,
};

/// Whether `capability` is the `UNKNOWN_CAPABILITY` sentinel.
pub fn is_unknown_capability(capability: &ModelCapability) -> bool {
    if capability._unknown_marker {
        return true;
    }
    // Structural check: all false, no dynamically_loaded_tools, 0 context tokens
    !capability.image_in
        && !capability.video_in
        && !capability.audio_in
        && !capability.thinking
        && !capability.tool_use
        && !capability.dynamically_loaded_tools
        && capability.max_context_tokens == 0
        && capability.max_input_tokens.is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_unknown_capability_sentinel() {
        assert!(is_unknown_capability(&UNKNOWN_CAPABILITY));
    }

    #[test]
    fn test_unknown_capability_structural() {
        let c = ModelCapability::empty();
        assert!(is_unknown_capability(&c));
    }

    #[test]
    fn test_known_capability() {
        let c = ModelCapability {
            image_in: true,
            thinking: true,
            max_context_tokens: 200_000,
            ..ModelCapability::empty()
        };
        assert!(!is_unknown_capability(&c));
    }

    #[test]
    fn test_unknown_with_dynamically_loaded_tools() {
        let c = ModelCapability {
            dynamically_loaded_tools: true,
            ..ModelCapability::empty()
        };
        assert!(!is_unknown_capability(&c));
    }
}