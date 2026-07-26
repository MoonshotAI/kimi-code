/// The single authority on thinking semantics — pure effort/keep resolution.
///
/// Folds a requested effort, the `[thinking]` config defaults, and the model's
/// declared thinking metadata into the effective effort, and resolves the
/// thinking-keep value.
///
/// The registry-driven vendor verdicts (`drivesThinkingThroughTraits`,
/// `requiresStrictThinkingValidation`) are NOT reimplemented here — they read
/// the protocol-adapter registry, which is a host concern. The host answers
/// them once and hands the verdicts in as [`ModelThinkingMetadata::always_thinking`]
/// / `strict_thinking_validation` / `trait_driven_thinking`.
///
/// Corresponds to `packages/agent-core-v2/src/kosong/model/thinking.ts`.
use std::collections::HashSet;

use serde::{Deserialize, Serialize};

/// Values that explicitly disable thinking-keep.
const KEEP_OFF_VALUES: [&str; 6] = ["0", "false", "no", "off", "none", "null"];

/// The `[thinking]` config section: enabled / effort / keep, plus the env-only
/// `forced_effort`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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

/// A model's declared capabilities — either a flat list of capability names or
/// the structured flag form.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ModelCapabilities {
    List(Vec<String>),
    Flags { thinking: bool },
}

impl ModelCapabilities {
    /// Mirrors `hasCapability`: the list form matches case-insensitively on a
    /// trimmed name; the flag form knows only `thinking` and deliberately
    /// answers `false` for `always_thinking`.
    fn has(&self, capability: &str) -> bool {
        match self {
            Self::List(names) => names
                .iter()
                .any(|candidate| candidate.trim().to_lowercase() == capability),
            Self::Flags { thinking } => match capability {
                "thinking" => *thinking,
                _ => false,
            },
        }
    }
}

/// The slice of model metadata thinking resolution depends on.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModelThinkingMetadata {
    #[serde(default)]
    pub always_thinking: bool,
    #[serde(default)]
    pub adaptive_thinking: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<ModelCapabilities>,
    #[serde(default)]
    pub support_efforts: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<String>,
}

/// Trim, then treat an empty result as absent.
fn non_empty(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Trim and lowercase a requested effort; empty becomes absent.
pub fn normalize_requested_thinking_effort(requested: Option<&str>) -> Option<String> {
    non_empty(requested).map(|value| value.to_lowercase())
}

/// The operational forced-effort override (`KIMI_MODEL_THINKING_EFFORT`).
///
/// Applies only when the vendor drives thinking through traits and the
/// effective effort is not `off`.
pub fn resolve_forced_thinking_effort(
    forced: Option<&str>,
    effective: &str,
    trait_driven: bool,
) -> Option<String> {
    if !trait_driven || effective == "off" {
        return None;
    }
    normalize_requested_thinking_effort(forced)
}

/// Whether the wire encodes a true protocol-level thinking disable.
///
/// Only the Anthropic and Kimi wires do; everywhere else "off" is the absence
/// of an effort field.
pub fn wire_has_protocol_thinking_disable(protocol: Option<&str>) -> bool {
    matches!(protocol, Some("anthropic") | Some("kimi"))
}

/// The model's declared efforts, trimmed, with empties dropped.
fn efforts_for(model: Option<&ModelThinkingMetadata>) -> Vec<String> {
    model
        .map(|m| {
            m.support_efforts
                .iter()
                .filter_map(|value| non_empty(Some(value)))
                .collect()
        })
        .unwrap_or_default()
}

fn middle_of(values: &[String]) -> Option<&String> {
    values.get(values.len() / 2)
}

pub fn model_supports_thinking(model: Option<&ModelThinkingMetadata>) -> bool {
    let Some(model) = model else {
        return false;
    };
    model.always_thinking
        || model.adaptive_thinking
        || model
            .capabilities
            .as_ref()
            .is_some_and(|c| c.has("thinking"))
        || model
            .capabilities
            .as_ref()
            .is_some_and(|c| c.has("always_thinking"))
}

pub fn default_thinking_effort_for_model(model: Option<&ModelThinkingMetadata>) -> String {
    if !model_supports_thinking(model) {
        return "off".to_string();
    }
    let efforts = efforts_for(model);
    if efforts.is_empty() {
        return "on".to_string();
    }
    let declared_default = model.and_then(|m| non_empty(m.default_effort.as_deref()));
    match declared_default {
        Some(declared) if efforts.contains(&declared) => declared,
        // `middle_of` cannot be None here — `efforts` is non-empty.
        _ => middle_of(&efforts).cloned().unwrap_or_else(|| "on".to_string()),
    }
}

/// Whether an effort is acceptable for a model.
///
/// Lenient transports accept anything: the backend may support values the
/// local catalog does not list.
pub fn model_supports_thinking_effort(
    effort: &str,
    model: Option<&ModelThinkingMetadata>,
    strict_validation: bool,
) -> bool {
    if !strict_validation || effort == "off" {
        return true;
    }
    if !model_supports_thinking(model) {
        return false;
    }
    let efforts = efforts_for(model);
    efforts.is_empty() || effort == "on" || efforts.iter().any(|e| e == effort)
}

/// Clamp an effort into something the model can actually be asked for.
///
/// The always-on clamp is UNCONDITIONAL — a model declaring `always_thinking`
/// never resolves to `off` on any wire, because a claimed off state would be a
/// lie when upstream keeps reasoning at its default.
fn normalize_thinking_effort_for_model(
    effort: &str,
    model: Option<&ModelThinkingMetadata>,
    strict_validation: bool,
) -> String {
    if effort == "off" && !model.is_some_and(|m| m.always_thinking) {
        return "off".to_string();
    }
    let efforts = efforts_for(model);
    if !strict_validation {
        return if effort == "on" && !efforts.is_empty() {
            default_thinking_effort_for_model(model)
        } else {
            effort.to_string()
        };
    }
    if !model_supports_thinking(model) {
        return "off".to_string();
    }
    if efforts.is_empty() {
        return "on".to_string();
    }
    if effort == "on" || !efforts.iter().any(|e| e == effort) {
        return default_thinking_effort_for_model(model);
    }
    effort.to_string()
}

/// Resolve the effective thinking effort from a requested effort, the config
/// defaults, and the model's declared metadata.
pub fn resolve_thinking_effort_for_model(
    requested: Option<&str>,
    defaults: Option<&ThinkingConfig>,
    model: Option<&ModelThinkingMetadata>,
    strict_validation: bool,
) -> String {
    let configured = normalize_requested_thinking_effort(defaults.and_then(|d| d.effort.as_deref()));
    let normalized = normalize_requested_thinking_effort(requested);

    let mut effort = if let Some(value) = normalized {
        value
    } else if defaults.is_some_and(|d| d.enabled == Some(false)) {
        "off".to_string()
    } else {
        configured
            .clone()
            .unwrap_or_else(|| default_thinking_effort_for_model(model))
    };

    if effort == "off" && model.is_some_and(|m| m.always_thinking) {
        effort = match &configured {
            Some(value) if value != "off" => value.clone(),
            _ => default_thinking_effort_for_model(model),
        };
    }

    normalize_thinking_effort_for_model(&effort, model, strict_validation)
}

enum KeepResolution {
    Unspecified,
    Specified(Option<String>),
}

fn parse_keep_value(raw: Option<&str>) -> KeepResolution {
    let Some(trimmed) = non_empty(raw) else {
        return KeepResolution::Unspecified;
    };
    let off: HashSet<&str> = KEEP_OFF_VALUES.into_iter().collect();
    if off.contains(trimmed.to_lowercase().as_str()) {
        return KeepResolution::Specified(None);
    }
    KeepResolution::Specified(Some(trimmed))
}

/// Resolve thinking-keep from the env override, the config `keep`, and the
/// effective effort. Off-values explicitly disable keep; `off` never keeps.
pub fn resolve_thinking_keep(
    env_keep: Option<&str>,
    config_keep: Option<&str>,
    thinking_effort: &str,
) -> Option<String> {
    if thinking_effort == "off" {
        return None;
    }
    if let KeepResolution::Specified(value) = parse_keep_value(env_keep) {
        return value;
    }
    if let KeepResolution::Specified(value) = parse_keep_value(config_keep) {
        return value;
    }
    Some("all".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(efforts: &[&str]) -> ModelThinkingMetadata {
        ModelThinkingMetadata {
            always_thinking: false,
            adaptive_thinking: false,
            capabilities: Some(ModelCapabilities::List(vec!["thinking".to_string()])),
            support_efforts: efforts.iter().map(|s| s.to_string()).collect(),
            default_effort: None,
        }
    }

    fn no_thinking_model() -> ModelThinkingMetadata {
        ModelThinkingMetadata::default()
    }

    #[test]
    fn normalize_trims_and_lowercases() {
        assert_eq!(
            normalize_requested_thinking_effort(Some("  HIGH ")),
            Some("high".to_string())
        );
        assert_eq!(normalize_requested_thinking_effort(Some("   ")), None);
        assert_eq!(normalize_requested_thinking_effort(None), None);
    }

    #[test]
    fn capabilities_list_matches_case_insensitively() {
        let caps = ModelCapabilities::List(vec![" Thinking ".to_string()]);
        assert!(caps.has("thinking"));
        assert!(!caps.has("always_thinking"));
    }

    #[test]
    fn capabilities_flags_never_report_always_thinking() {
        let caps = ModelCapabilities::Flags { thinking: true };
        assert!(caps.has("thinking"));
        assert!(!caps.has("always_thinking"), "flag form has no always_thinking");
    }

    #[test]
    fn supports_thinking_via_any_signal() {
        assert!(!model_supports_thinking(None));
        assert!(!model_supports_thinking(Some(&no_thinking_model())));
        assert!(model_supports_thinking(Some(&model(&[]))));

        let mut always = no_thinking_model();
        always.always_thinking = true;
        assert!(model_supports_thinking(Some(&always)));

        let mut adaptive = no_thinking_model();
        adaptive.adaptive_thinking = true;
        assert!(model_supports_thinking(Some(&adaptive)));
    }

    #[test]
    fn default_effort_picks_middle_of_declared_list() {
        assert_eq!(
            default_thinking_effort_for_model(Some(&model(&["low", "medium", "high"]))),
            "medium"
        );
        // Even-length list floors to the upper-middle index, matching JS.
        assert_eq!(
            default_thinking_effort_for_model(Some(&model(&["low", "high"]))),
            "high"
        );
    }

    #[test]
    fn default_effort_honours_declared_default_when_listed() {
        let mut m = model(&["low", "medium", "high"]);
        m.default_effort = Some(" low ".to_string());
        assert_eq!(default_thinking_effort_for_model(Some(&m)), "low");

        m.default_effort = Some("bogus".to_string());
        assert_eq!(
            default_thinking_effort_for_model(Some(&m)),
            "medium",
            "unlisted declared default falls back to the middle"
        );
    }

    #[test]
    fn default_effort_is_on_without_a_list_and_off_without_thinking() {
        assert_eq!(default_thinking_effort_for_model(Some(&model(&[]))), "on");
        assert_eq!(default_thinking_effort_for_model(None), "off");
        assert_eq!(
            default_thinking_effort_for_model(Some(&no_thinking_model())),
            "off"
        );
    }

    #[test]
    fn empty_declared_efforts_are_dropped() {
        let m = model(&["", "  ", "high"]);
        assert_eq!(default_thinking_effort_for_model(Some(&m)), "high");
    }

    #[test]
    fn effort_support_is_lenient_unless_strict() {
        let m = model(&["low", "high"]);
        assert!(model_supports_thinking_effort("bogus", Some(&m), false));
        assert!(!model_supports_thinking_effort("bogus", Some(&m), true));
        assert!(model_supports_thinking_effort("high", Some(&m), true));
        assert!(model_supports_thinking_effort("on", Some(&m), true));
        assert!(
            model_supports_thinking_effort("off", Some(&m), true),
            "off is always supported"
        );
        assert!(
            !model_supports_thinking_effort("high", Some(&no_thinking_model()), true),
            "a non-thinking model supports no concrete effort"
        );
    }

    #[test]
    fn requested_effort_wins_over_config() {
        let m = model(&["low", "medium", "high"]);
        let defaults = ThinkingConfig {
            effort: Some("low".into()),
            ..Default::default()
        };
        assert_eq!(
            resolve_thinking_effort_for_model(Some("high"), Some(&defaults), Some(&m), false),
            "high"
        );
    }

    #[test]
    fn disabled_config_resolves_off() {
        let m = model(&["low", "high"]);
        let defaults = ThinkingConfig {
            enabled: Some(false),
            ..Default::default()
        };
        assert_eq!(
            resolve_thinking_effort_for_model(None, Some(&defaults), Some(&m), false),
            "off"
        );
    }

    #[test]
    fn config_effort_is_the_fallback_then_model_default() {
        let m = model(&["low", "medium", "high"]);
        let defaults = ThinkingConfig {
            effort: Some("LOW".into()),
            ..Default::default()
        };
        assert_eq!(
            resolve_thinking_effort_for_model(None, Some(&defaults), Some(&m), false),
            "low"
        );
        assert_eq!(
            resolve_thinking_effort_for_model(None, None, Some(&m), false),
            "medium"
        );
    }

    #[test]
    fn always_thinking_model_never_resolves_off() {
        let mut m = model(&["low", "medium", "high"]);
        m.always_thinking = true;
        assert_eq!(
            resolve_thinking_effort_for_model(Some("off"), None, Some(&m), false),
            "medium",
            "off is clamped to the model default"
        );

        let defaults = ThinkingConfig {
            effort: Some("high".into()),
            ..Default::default()
        };
        assert_eq!(
            resolve_thinking_effort_for_model(Some("off"), Some(&defaults), Some(&m), false),
            "high",
            "a configured non-off effort wins the clamp"
        );
    }

    #[test]
    fn always_thinking_clamp_applies_even_when_lenient() {
        let mut m = model(&[]);
        m.always_thinking = true;
        assert_eq!(
            resolve_thinking_effort_for_model(Some("off"), None, Some(&m), false),
            "on"
        );
    }

    #[test]
    fn off_stays_off_for_ordinary_models() {
        let m = model(&["low", "high"]);
        assert_eq!(
            resolve_thinking_effort_for_model(Some("off"), None, Some(&m), true),
            "off"
        );
        assert_eq!(resolve_thinking_effort_for_model(Some("off"), None, None, true), "off");
    }

    #[test]
    fn strict_validation_clamps_unlisted_effort_to_default() {
        let m = model(&["low", "medium", "high"]);
        assert_eq!(
            resolve_thinking_effort_for_model(Some("bogus"), None, Some(&m), true),
            "medium"
        );
        assert_eq!(
            resolve_thinking_effort_for_model(Some("bogus"), None, Some(&m), false),
            "bogus",
            "lenient transports send the value unchanged"
        );
    }

    #[test]
    fn strict_validation_projects_on_to_the_default_effort() {
        let m = model(&["low", "medium", "high"]);
        assert_eq!(
            resolve_thinking_effort_for_model(Some("on"), None, Some(&m), true),
            "medium"
        );
        assert_eq!(
            resolve_thinking_effort_for_model(Some("on"), None, Some(&m), false),
            "medium",
            "'on' also projects when the model declares a list"
        );
        assert_eq!(
            resolve_thinking_effort_for_model(Some("on"), None, Some(&model(&[])), false),
            "on",
            "no declared list means 'on' stays 'on'"
        );
    }

    #[test]
    fn strict_validation_falls_back_to_off_for_non_thinking_models() {
        assert_eq!(
            resolve_thinking_effort_for_model(Some("high"), None, Some(&no_thinking_model()), true),
            "off"
        );
    }

    #[test]
    fn forced_effort_applies_only_to_trait_driven_non_off() {
        assert_eq!(
            resolve_forced_thinking_effort(Some("HIGH"), "low", true),
            Some("high".to_string())
        );
        assert_eq!(resolve_forced_thinking_effort(Some("high"), "off", true), None);
        assert_eq!(resolve_forced_thinking_effort(Some("high"), "low", false), None);
        assert_eq!(resolve_forced_thinking_effort(Some("  "), "low", true), None);
    }

    #[test]
    fn keep_defaults_to_all_and_is_disabled_by_off_values() {
        assert_eq!(resolve_thinking_keep(None, None, "high"), Some("all".into()));
        assert_eq!(resolve_thinking_keep(None, None, "off"), None);
        for value in ["0", "false", "NO", "off", "None", "null"] {
            assert_eq!(resolve_thinking_keep(Some(value), None, "high"), None, "{value}");
        }
    }

    #[test]
    fn keep_env_overrides_config() {
        assert_eq!(
            resolve_thinking_keep(Some("2"), Some("5"), "high"),
            Some("2".into())
        );
        assert_eq!(
            resolve_thinking_keep(Some("  "), Some("5"), "high"),
            Some("5".into()),
            "a blank env value is unspecified, not an override"
        );
        assert_eq!(
            resolve_thinking_keep(Some("off"), Some("5"), "high"),
            None,
            "an explicit env off-value beats the config"
        );
    }

    #[test]
    fn protocol_thinking_disable_is_anthropic_and_kimi_only() {
        assert!(wire_has_protocol_thinking_disable(Some("anthropic")));
        assert!(wire_has_protocol_thinking_disable(Some("kimi")));
        assert!(!wire_has_protocol_thinking_disable(Some("openai")));
        assert!(!wire_has_protocol_thinking_disable(None));
    }
}
