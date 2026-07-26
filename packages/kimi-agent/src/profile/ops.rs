/// The agent's persistent profile config slice and its two reducers.
///
/// Declares `ProfileModelState` — `cwd`, `model_alias`, `profile_name`, the
/// resolved base thinking effort, `system_prompt`, the profile
/// `disallowed_tools` denylist and the `subagents` delegation allowlist — plus
/// the pure `profile.bind` / `config.update` reducers.
///
/// Both reducers are pure merges of an already-resolved payload: the effort is
/// resolved by the caller (against the live model + `[thinking]` config) and
/// carried in the payload, so a resumed agent restores the persisted base value
/// rather than re-resolving against a possibly-drifted config. The `chdir` side
/// effect and status emission are deliberately NOT part of `apply` — they run
/// live-only, so replay rebuilds the state silently.
///
/// `model_capabilities` is intentionally NOT part of the state: it is derived
/// live from the model catalog so resume never pins stale capabilities.
///
/// Corresponds to `packages/agent-core-v2/src/agent/profile/profileOps.ts`.
use serde::{Deserialize, Serialize};

use super::{ProfileError, ProfileErrorCode};

/// The persistent profile slice.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileModelState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_alias: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_name: Option<String>,
    pub thinking_level: String,
    pub system_prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disallowed_tools: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagents: Option<Vec<String>>,
}

impl Default for ProfileModelState {
    /// Mirrors `defaultProfileModel()`.
    fn default() -> Self {
        Self {
            cwd: None,
            model_alias: None,
            profile_name: None,
            thinking_level: "off".to_string(),
            system_prompt: String::new(),
            disallowed_tools: None,
            subagents: None,
        }
    }
}

/// Payload of the `profile.bind` Op.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProfileBindPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_alias: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_name: Option<String>,
    pub thinking_effort: String,
    pub system_prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_tool_names: Option<Vec<String>>,
    pub disallowed_tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagents: Option<Vec<String>>,
}

/// Payload of the `config.update` Op.
///
/// `thinking_level` is the legacy alias for `thinking_effort`, still accepted
/// on replay of older records.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ConfigUpdatePayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_alias: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disallowed_tools: Option<Vec<String>>,
}

/// `profile.bind` — replace the identity slice wholesale.
///
/// Absent optional fields inherit from the current state; `system_prompt`,
/// `thinking_effort` and `disallowed_tools` always overwrite, because a bind
/// establishes them.
pub fn profile_bind(state: &ProfileModelState, payload: ProfileBindPayload) -> ProfileModelState {
    ProfileModelState {
        cwd: payload.cwd.or_else(|| state.cwd.clone()),
        model_alias: payload.model_alias.or_else(|| state.model_alias.clone()),
        profile_name: payload.profile_name.or_else(|| state.profile_name.clone()),
        thinking_level: payload.thinking_effort,
        system_prompt: payload.system_prompt,
        disallowed_tools: Some(payload.disallowed_tools),
        subagents: payload.subagents,
    }
}

/// Reconcile the two spellings of the effort field.
///
/// Live records carry `thinking_effort`; legacy replay still accepts
/// `thinking_level`. Records carrying both with different values are corrupt.
fn config_update_thinking_level(
    payload: &ConfigUpdatePayload,
) -> Result<Option<String>, ProfileError> {
    match (&payload.thinking_effort, &payload.thinking_level) {
        (Some(effort), Some(level)) => {
            if effort != level {
                return Err(ProfileError::new(
                    ProfileErrorCode::ThinkingAliasConflict,
                    format!(
                        "config.update has conflicting thinkingEffort ({effort}) and legacy thinkingLevel ({level})"
                    ),
                ));
            }
            Ok(Some(effort.clone()))
        }
        (Some(effort), None) => Ok(Some(effort.clone())),
        (None, level) => Ok(level.clone()),
    }
}

/// `config.update` — merge a partial payload into the state in place.
///
/// Returns whether anything actually changed. That answer is the Rust analogue
/// of the TS reducer returning the same reference when nothing changed: it lets
/// the caller keep the change-notification gate quiet.
pub fn config_update(
    state: &mut ProfileModelState,
    payload: &ConfigUpdatePayload,
) -> Result<bool, ProfileError> {
    let mut changed = false;

    if let Some(cwd) = &payload.cwd {
        if state.cwd.as_deref() != Some(cwd.as_str()) {
            state.cwd = Some(cwd.clone());
            changed = true;
        }
    }
    if let Some(alias) = &payload.model_alias {
        if state.model_alias.as_deref() != Some(alias.as_str()) {
            state.model_alias = Some(alias.clone());
            changed = true;
        }
    }
    if let Some(name) = &payload.profile_name {
        if state.profile_name.as_deref() != Some(name.as_str()) {
            state.profile_name = Some(name.clone());
            changed = true;
        }
    }
    if let Some(level) = config_update_thinking_level(payload)? {
        if state.thinking_level != level {
            state.thinking_level = level;
            changed = true;
        }
    }
    if let Some(prompt) = &payload.system_prompt {
        if &state.system_prompt != prompt {
            state.system_prompt = prompt.clone();
            changed = true;
        }
    }
    if let Some(tools) = &payload.disallowed_tools {
        if !string_slice_equal(Some(tools), state.disallowed_tools.as_ref()) {
            state.disallowed_tools = Some(tools.clone());
            changed = true;
        }
    }

    Ok(changed)
}

fn string_slice_equal(a: Option<&Vec<String>>, b: Option<&Vec<String>>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => a == b,
        // `undefined` never compares equal to a concrete list, matching the TS
        // `stringArrayEqual` guard.
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bind_payload() -> ProfileBindPayload {
        ProfileBindPayload {
            cwd: Some("/work".into()),
            model_alias: Some("kimi".into()),
            profile_name: Some("agent".into()),
            thinking_effort: "medium".into(),
            system_prompt: "You are helpful.".into(),
            active_tool_names: Some(vec!["Read".into()]),
            disallowed_tools: vec!["Bash".into()],
            subagents: Some(vec!["coder".into()]),
        }
    }

    #[test]
    fn default_state_matches_the_wire_default() {
        let s = ProfileModelState::default();
        assert_eq!(s.thinking_level, "off");
        assert_eq!(s.system_prompt, "");
        assert!(s.cwd.is_none() && s.model_alias.is_none() && s.profile_name.is_none());
    }

    #[test]
    fn bind_establishes_the_identity_slice() {
        let next = profile_bind(&ProfileModelState::default(), bind_payload());
        assert_eq!(next.cwd.as_deref(), Some("/work"));
        assert_eq!(next.model_alias.as_deref(), Some("kimi"));
        assert_eq!(next.profile_name.as_deref(), Some("agent"));
        assert_eq!(next.thinking_level, "medium");
        assert_eq!(next.disallowed_tools.as_deref(), Some(&["Bash".to_string()][..]));
        assert_eq!(next.subagents.as_deref(), Some(&["coder".to_string()][..]));
    }

    #[test]
    fn bind_inherits_absent_optionals_from_state() {
        let mut state = ProfileModelState::default();
        state.cwd = Some("/previous".into());
        state.model_alias = Some("old-model".into());
        let mut payload = bind_payload();
        payload.cwd = None;
        payload.model_alias = None;

        let next = profile_bind(&state, payload);
        assert_eq!(next.cwd.as_deref(), Some("/previous"));
        assert_eq!(next.model_alias.as_deref(), Some("old-model"));
    }

    #[test]
    fn bind_always_overwrites_prompt_effort_and_denylist() {
        let mut state = ProfileModelState::default();
        state.system_prompt = "old".into();
        state.thinking_level = "high".into();
        state.disallowed_tools = Some(vec!["Write".into()]);
        state.subagents = Some(vec!["stale".into()]);

        let mut payload = bind_payload();
        payload.subagents = None;
        let next = profile_bind(&state, payload);

        assert_eq!(next.system_prompt, "You are helpful.");
        assert_eq!(next.thinking_level, "medium");
        assert_eq!(next.disallowed_tools.as_deref(), Some(&["Bash".to_string()][..]));
        assert!(next.subagents.is_none(), "absent subagents clears the allowlist");
    }

    #[test]
    fn config_update_reports_no_change_for_identical_values() {
        let mut state = profile_bind(&ProfileModelState::default(), bind_payload());
        let before = state.clone();
        let payload = ConfigUpdatePayload {
            cwd: Some("/work".into()),
            model_alias: Some("kimi".into()),
            thinking_effort: Some("medium".into()),
            system_prompt: Some("You are helpful.".into()),
            disallowed_tools: Some(vec!["Bash".into()]),
            ..Default::default()
        };
        assert!(!config_update(&mut state, &payload).unwrap());
        assert_eq!(state, before);
    }

    #[test]
    fn config_update_applies_only_present_fields() {
        let mut state = profile_bind(&ProfileModelState::default(), bind_payload());
        let payload = ConfigUpdatePayload {
            model_alias: Some("kimi-2".into()),
            ..Default::default()
        };
        assert!(config_update(&mut state, &payload).unwrap());
        assert_eq!(state.model_alias.as_deref(), Some("kimi-2"));
        assert_eq!(state.cwd.as_deref(), Some("/work"), "absent fields untouched");
        assert_eq!(state.thinking_level, "medium");
    }

    #[test]
    fn config_update_accepts_the_legacy_thinking_level_alias() {
        let mut state = ProfileModelState::default();
        let payload = ConfigUpdatePayload {
            thinking_level: Some("high".into()),
            ..Default::default()
        };
        assert!(config_update(&mut state, &payload).unwrap());
        assert_eq!(state.thinking_level, "high");
    }

    #[test]
    fn config_update_accepts_both_spellings_when_they_agree() {
        let mut state = ProfileModelState::default();
        let payload = ConfigUpdatePayload {
            thinking_effort: Some("high".into()),
            thinking_level: Some("high".into()),
            ..Default::default()
        };
        assert!(config_update(&mut state, &payload).unwrap());
        assert_eq!(state.thinking_level, "high");
    }

    #[test]
    fn config_update_rejects_conflicting_thinking_spellings() {
        let mut state = ProfileModelState::default();
        let payload = ConfigUpdatePayload {
            thinking_effort: Some("high".into()),
            thinking_level: Some("low".into()),
            ..Default::default()
        };
        let err = config_update(&mut state, &payload).unwrap_err();
        assert_eq!(err.code, ProfileErrorCode::ThinkingAliasConflict);
        assert_eq!(
            state,
            ProfileModelState::default(),
            "a rejected update must not partially apply"
        );
    }

    #[test]
    fn config_update_detects_denylist_changes_by_value() {
        let mut state = ProfileModelState::default();
        let payload = ConfigUpdatePayload {
            disallowed_tools: Some(vec!["Bash".into()]),
            ..Default::default()
        };
        assert!(
            config_update(&mut state, &payload).unwrap(),
            "None never equals a concrete list"
        );
        assert!(!config_update(&mut state, &payload).unwrap());

        let reordered = ConfigUpdatePayload {
            disallowed_tools: Some(vec!["Write".into(), "Bash".into()]),
            ..Default::default()
        };
        assert!(config_update(&mut state, &reordered).unwrap());
    }

    #[test]
    fn config_update_can_set_an_empty_denylist() {
        let mut state = ProfileModelState::default();
        state.disallowed_tools = Some(vec!["Bash".into()]);
        let payload = ConfigUpdatePayload {
            disallowed_tools: Some(vec![]),
            ..Default::default()
        };
        assert!(config_update(&mut state, &payload).unwrap());
        assert_eq!(state.disallowed_tools.as_deref(), Some(&[][..]));
    }
}
