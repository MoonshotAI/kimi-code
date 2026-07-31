/// Thinking semantics — the single authority on effort/keep resolution.
///
/// Corresponds to `kosong/model/thinking.ts`.
use serde::{Deserialize, Serialize};

use crate::kosong::contract::provider::ThinkingEffort;

use super::model_types::{ModelThinkingCapabilities, ModelThinkingMetadata, ThinkingDefaults};

/// Thinking configuration section.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ThinkingConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forced_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep: Option<String>,
}

// ---------------------------------------------------------------------------
// Registry-driven vendor verdicts
// ---------------------------------------------------------------------------

/// Whether the vendor drives thinking through its traits.
pub fn drives_thinking_through_traits(provider_type: Option<&str>) -> bool {
    let provider_type = match provider_type {
        Some(pt) => pt,
        None => return false,
    };
    let defs = crate::kosong::provider::provider_definition::get_provider_definitions(provider_type);
    defs.iter().any(|def| {
        def.traits.iter().any(|t| t.with_thinking.is_some())
    })
}

/// Whether the wire encodes a true protocol-level thinking disable.
pub fn wire_has_protocol_thinking_disable(protocol: Option<&str>) -> bool {
    matches!(protocol, Some("anthropic" | "kimi"))
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

fn non_empty(value: Option<&str>) -> Option<String> {
    value.and_then(|v| {
        let trimmed = v.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

/// Normalize a requested thinking effort string.
pub fn normalize_requested_thinking_effort(requested: Option<&str>) -> Option<ThinkingEffort> {
    non_empty(requested).map(|s| ThinkingEffort(s.to_lowercase()))
}

/// Resolve the forced thinking effort (KIMI_MODEL_THINKING_EFFORT override).
pub fn resolve_forced_thinking_effort(
    forced: Option<&str>,
    effective: &ThinkingEffort,
    trait_driven: bool,
) -> Option<ThinkingEffort> {
    if !trait_driven || effective.is_off() {
        return None;
    }
    non_empty(forced).map(|s| ThinkingEffort(s.to_lowercase()))
}

fn has_thinking_capability(
    capabilities: &Option<ModelThinkingCapabilities>,
) -> bool {
    match capabilities {
        Some(ModelThinkingCapabilities::Flags(cap)) => cap.thinking,
        Some(ModelThinkingCapabilities::List(list)) => {
            list.iter().any(|c| c.trim().to_lowercase() == "thinking")
        }
        None => false,
    }
}

fn has_always_thinking_capability(
    capabilities: &Option<ModelThinkingCapabilities>,
) -> bool {
    match capabilities {
        Some(ModelThinkingCapabilities::List(list)) => {
            list.iter().any(|c| c.trim().to_lowercase() == "always_thinking")
        }
        _ => false,
    }
}

fn efforts_for(model: &Option<ModelThinkingMetadata>) -> Vec<String> {
    model
        .as_ref()
        .and_then(|m| m.support_efforts.clone())
        .unwrap_or_default()
        .into_iter()
        .filter(|e| !e.trim().is_empty())
        .collect()
}

fn middle_of(values: &[String]) -> String {
    values[values.len() / 2].clone()
}

/// Whether the model supports thinking at all.
pub fn model_supports_thinking(model: &Option<ModelThinkingMetadata>) -> bool {
    match model {
        Some(m) => {
            m.always_thinking == Some(true)
                || m.adaptive_thinking == Some(true)
                || has_thinking_capability(&m.capabilities)
                || has_always_thinking_capability(&m.capabilities)
        }
        None => false,
    }
}

/// Default thinking effort for a model.
pub fn default_thinking_effort_for_model(model: &Option<ModelThinkingMetadata>) -> ThinkingEffort {
    if !model_supports_thinking(model) {
        return ThinkingEffort(ThinkingEffort::OFF.to_string());
    }
    let efforts = efforts_for(model);
    if !efforts.is_empty() {
        let declared = model
            .as_ref()
            .and_then(|m| m.default_effort.clone());
        if let Some(ref de) = declared {
            if efforts.contains(de) {
                return ThinkingEffort(de.clone());
            }
        }
        return ThinkingEffort(middle_of(&efforts));
    }
    ThinkingEffort(ThinkingEffort::ON.to_string())
}

/// Whether the model supports a specific thinking effort (strict mode).
pub fn model_supports_thinking_effort(
    effort: &ThinkingEffort,
    model: &Option<ModelThinkingMetadata>,
    strict_validation: bool,
) -> bool {
    if !strict_validation || effort.is_off() {
        return true;
    }
    if !model_supports_thinking(model) {
        return false;
    }
    let efforts = efforts_for(model);
    efforts.is_empty() || effort.is_on() || efforts.contains(&effort.0)
}

fn normalize_thinking_effort_for_model(
    effort: ThinkingEffort,
    model: &Option<ModelThinkingMetadata>,
    strict_validation: bool,
) -> ThinkingEffort {
    if effort.is_off() && model.as_ref().and_then(|m| m.always_thinking) != Some(true) {
        return effort;
    }
    let efforts = efforts_for(model);
    if !strict_validation {
        if effort.is_on() && !efforts.is_empty() {
            return default_thinking_effort_for_model(model);
        }
        return effort;
    }
    if !model_supports_thinking(model) {
        return ThinkingEffort(ThinkingEffort::OFF.to_string());
    }
    if efforts.is_empty() {
        return ThinkingEffort(ThinkingEffort::ON.to_string());
    }
    if effort.is_on() || !efforts.contains(&effort.0) {
        return default_thinking_effort_for_model(model);
    }
    effort
}

/// Resolve the effective thinking effort.
pub fn resolve_thinking_effort_for_model(
    requested: Option<&str>,
    defaults: Option<&ThinkingDefaults>,
    model: &Option<ModelThinkingMetadata>,
    strict_validation: bool,
) -> ThinkingEffort {
    let configured = normalize_requested_thinking_effort(defaults.and_then(|d| d.effort.as_deref()));
    let normalized = normalize_requested_thinking_effort(requested);
    let effort: ThinkingEffort;
    let is_always_thinking = model.as_ref().and_then(|m| m.always_thinking) == Some(true);

    if let Some(n) = normalized {
        effort = n;
    } else if defaults.map_or(false, |d| d.enabled == Some(false)) {
        effort = ThinkingEffort(ThinkingEffort::OFF.to_string());
    } else {
        effort = configured.clone().unwrap_or_else(|| default_thinking_effort_for_model(model));
    };

    // Always-on clamp
    let effort = if effort.is_off() && is_always_thinking {
        configured
            .filter(|c| !c.is_off())
            .unwrap_or_else(|| default_thinking_effort_for_model(model))
    } else {
        effort
    };

    normalize_thinking_effort_for_model(effort, model, strict_validation)
}

// ---------------------------------------------------------------------------
// Keep resolution
// ---------------------------------------------------------------------------

const KEEP_OFF_VALUES: &[&str] = &["0", "false", "no", "off", "none", "null"];

struct KeepResolution {
    specified: bool,
    value: Option<String>,
}

fn parse_keep_value(raw: Option<&str>) -> KeepResolution {
    let trimmed = raw.and_then(|r| {
        let t = r.trim();
        if t.is_empty() { None } else { Some(t) }
    });
    match trimmed {
        Some(v) if KEEP_OFF_VALUES.contains(&v.to_lowercase().as_str()) => {
            KeepResolution {
                specified: true,
                value: None,
            }
        }
        Some(v) => KeepResolution {
            specified: true,
            value: Some(v.to_string()),
        },
        None => KeepResolution {
            specified: false,
            value: None,
        },
    }
}

/// Resolve the thinking-keep value.
pub fn resolve_thinking_keep(
    env_keep: Option<&str>,
    config_keep: Option<&str>,
    thinking_effort: &ThinkingEffort,
) -> Option<String> {
    if thinking_effort.is_off() {
        return None;
    }
    let from_env = parse_keep_value(env_keep);
    if from_env.specified {
        return from_env.value;
    }
    let from_config = parse_keep_value(config_keep);
    if from_config.specified {
        return from_config.value;
    }
    Some("all".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_off_is_off() {
        let e = ThinkingEffort("off".to_string());
        assert!(e.is_off());
    }

    #[test]
    fn test_default_effort_no_model() {
        let effort = default_thinking_effort_for_model(&None);
        assert!(effort.is_off());
    }

    #[test]
    fn test_model_supports_thinking_unknown() {
        assert!(!model_supports_thinking(&None));
    }

    #[test]
    fn test_resolve_thinking_keep_default() {
        let effort = ThinkingEffort("high".to_string());
        let keep = resolve_thinking_keep(None, None, &effort);
        assert_eq!(keep, Some("all".to_string()));
    }

    #[test]
    fn test_resolve_thinking_keep_off_effort() {
        let effort = ThinkingEffort("off".to_string());
        let keep = resolve_thinking_keep(Some("all"), None, &effort);
        assert_eq!(keep, None);
    }

    #[test]
    fn test_resolve_thinking_keep_env_off() {
        let effort = ThinkingEffort("high".to_string());
        let keep = resolve_thinking_keep(Some("off"), None, &effort);
        assert_eq!(keep, None);
    }

    #[test]
    fn test_drives_thinking_through_traits_unregistered() {
        assert!(!drives_thinking_through_traits(Some("nonexistent")));
    }
}