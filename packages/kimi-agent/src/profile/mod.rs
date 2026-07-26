/// ProfileService — the active agent's identity.
///
/// Owns the bound profile, model alias, thinking level, system prompt, and
/// active-tool set. `bind()` takes an optional model, falling back to the
/// configured default so callers don't each re-implement the fallback, and an
/// optional thinking effort; `strict_thinking` marks that effort as an explicit
/// user request rather than inherited state, so it is validated against the
/// model's supported efforts and the bind rejects up front when unsupported —
/// internal spawns pass inherited thinking without the flag, and a persisted
/// effort that drifted out of the model's support list clamps instead of
/// breaking the spawn.
///
/// `bind()` is first-bind only: a profile is the session's identity. The guard
/// runs before name resolution so `already bound` fails fast, and again before
/// the state is written, so two concurrent binds cannot both pass.
///
/// The effective active-tool set is the persisted base overlaid with ephemeral
/// per-tool deltas from `add_active_tool` / `remove_active_tool` (used by
/// `user_tool`); the overlay is intentionally not persisted and is re-derived
/// on resume, so no restore-ordering coupling arises.
///
/// WHAT STAYS WITH THE HOST: catalog lookups, system-prompt rendering (which
/// needs the filesystem and the skill/tool catalogs), `chdir`, telemetry and
/// event publication. Those arrive through [`ProfileDelegate`]; everything
/// here is pure state.
///
/// Corresponds to `packages/agent-core-v2/src/agent/profile/`.
pub mod ops;
pub mod thinking;

use std::collections::HashSet;
use std::fmt;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

pub use ops::{ConfigUpdatePayload, ProfileBindPayload, ProfileModelState, config_update, profile_bind};
pub use thinking::{
    ModelCapabilities, ModelThinkingMetadata, ThinkingConfig, default_thinking_effort_for_model,
    model_supports_thinking, model_supports_thinking_effort, normalize_requested_thinking_effort,
    resolve_forced_thinking_effort, resolve_thinking_effort_for_model, resolve_thinking_keep,
    wire_has_protocol_thinking_disable,
};

/// The profile bound when a model is set before any explicit bind.
pub const DEFAULT_AGENT_PROFILE_NAME: &str = "agent";

// ── Errors ───────────────────────────────────────────────────────────────

/// Model/provider configuration failures.
///
/// The serde names are the wire codes, identical to `ProfileErrors.codes`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProfileErrorCode {
    #[serde(rename = "model.not_configured")]
    ModelNotConfigured,
    #[serde(rename = "model.config_invalid")]
    ModelConfigInvalid,
    #[serde(rename = "profile.thinking_alias_conflict")]
    ThinkingAliasConflict,
    #[serde(rename = "profile.unknown")]
    ProfileUnknown,
    #[serde(rename = "profile.already_bound")]
    ProfileAlreadyBound,
    #[serde(rename = "profile.not_bound")]
    ProfileNotBound,
}

impl ProfileErrorCode {
    /// The wire code, identical to the TS `ProfileErrors.codes` values.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ModelNotConfigured => "model.not_configured",
            Self::ModelConfigInvalid => "model.config_invalid",
            Self::ThinkingAliasConflict => "profile.thinking_alias_conflict",
            Self::ProfileUnknown => "profile.unknown",
            Self::ProfileAlreadyBound => "profile.already_bound",
            Self::ProfileNotBound => "profile.not_bound",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileError {
    pub code: ProfileErrorCode,
    pub message: String,
}

impl ProfileError {
    pub fn new(code: ProfileErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for ProfileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for ProfileError {}

// ── Host-supplied data ───────────────────────────────────────────────────

/// The model facts the profile needs, resolved live from the host catalog so
/// resume never pins stale capabilities.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModelInfo {
    pub alias: String,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_size: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_input_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_context_tokens: Option<u32>,
    #[serde(default)]
    pub thinking: ModelThinkingMetadata,
    /// Registry verdict: does this (protocol, provider_type) pair require
    /// strict effort validation? Answered by the host's protocol-adapter
    /// registry — never re-derived from vendor strings here.
    #[serde(default)]
    pub strict_thinking_validation: bool,
    /// Registry verdict: does the vendor drive thinking through its traits?
    #[serde(default)]
    pub trait_driven_thinking: bool,
}

/// A profile the host has already resolved and rendered.
///
/// System-prompt rendering needs the filesystem plus the skill and tool
/// catalogs, so the host does it and hands back the finished text.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ResolvedAgentProfile {
    pub name: String,
    pub system_prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disallowed_tools: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagents: Option<Vec<String>>,
    /// Surfaced as an `agents-md-oversized` warning after a successful bind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agents_md_warning: Option<String>,
}

/// Emitted whenever the identity slice changes in a user-visible way.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentStatusUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_context_tokens: Option<u32>,
}

/// Host-side lookups and side effects.
pub trait ProfileDelegate: Send + Sync {
    /// Resolve a model alias. `None` means "not configured" — never an error.
    fn model(&self, alias: &str) -> Option<ModelInfo>;

    /// Resolve and render a profile by name.
    fn resolve_profile(&self, name: &str) -> Option<ResolvedAgentProfile>;

    /// Names of every available profile, used to build the `profile.unknown`
    /// message.
    fn list_profile_names(&self) -> Vec<String> {
        Vec::new()
    }

    fn chdir(&self, _cwd: &str) {}

    fn emit_warning(&self, _code: &str, _message: &str) {}

    fn emit_status_updated(&self, _update: &AgentStatusUpdate) {}
}

/// Env/config overrides applied on top of the model's own defaults.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModelOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_keep: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_completion_tokens: Option<u32>,
}

/// Static configuration the service reads but never writes.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProfileConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(default)]
    pub thinking: ThinkingConfig,
    #[serde(default)]
    pub model_overrides: ModelOverrides,
    #[serde(default)]
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reserved_context_size: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction_trigger_ratio: Option<f64>,
}

// ── Public data shapes ───────────────────────────────────────────────────

/// A partial update to the identity slice.
#[derive(Debug, Clone, Default)]
pub struct ProfileUpdateData {
    pub cwd: Option<String>,
    pub model_alias: Option<String>,
    pub profile_name: Option<String>,
    pub thinking_level: Option<String>,
    pub system_prompt: Option<String>,
    pub disallowed_tools: Option<Vec<String>>,
    /// Whole-set replacement of the persisted active-tool base.
    /// `Some(None)` resets to the unrestricted default.
    pub active_tool_names: Option<Option<Vec<String>>>,
}

impl ProfileUpdateData {
    /// Whether any field outside `active_tool_names` is present — the TS
    /// `Object.keys(configChanged).length > 0` guard.
    fn has_config_changes(&self) -> bool {
        self.cwd.is_some()
            || self.model_alias.is_some()
            || self.profile_name.is_some()
            || self.thinking_level.is_some()
            || self.system_prompt.is_some()
            || self.disallowed_tools.is_some()
    }
}

/// The full restorable identity, used to rehydrate a forked or resumed agent.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProfileBindingSnapshot {
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_alias: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_name: Option<String>,
    pub thinking_level: String,
    pub system_prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_tool_names: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disallowed_tools: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagents: Option<Vec<String>>,
}

/// The outward-facing view of the identity slice.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileData {
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_alias: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_name: Option<String>,
    pub thinking_level: String,
    pub system_prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_tool_names: Option<Vec<String>>,
    pub disallowed_tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagents: Option<Vec<String>>,
}

/// Everything the loop needs to size and drive one model request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileModelContext {
    pub model_alias: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_size: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub always_thinking: Option<bool>,
    pub thinking_level: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reserved_context_size: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction_trigger_ratio: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SamplingOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,
}

/// The dialect-free per-turn intent for the bound model.
///
/// Wire encoding is each dialect's own business — the profile never branches
/// on protocol or vendor.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelRequestParams {
    pub cache_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sampling: Option<SamplingOptions>,
    pub thinking_effort: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_keep: Option<String>,
}

/// Input to [`ProfileService::bind`].
#[derive(Debug, Clone, Default)]
pub struct BindAgentInput {
    pub profile: String,
    pub model: Option<String>,
    pub thinking: Option<String>,
    /// Marks `thinking` as an explicit user request: validate it up front and
    /// reject rather than clamp.
    pub strict_thinking: bool,
    pub cwd: Option<String>,
}

/// Result of [`ProfileService::set_model`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileSetModelResult {
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_name: Option<String>,
}

struct ThinkingState {
    effective: String,
    #[allow(dead_code)]
    forced: Option<String>,
}

// ── The service ──────────────────────────────────────────────────────────

pub struct ProfileService {
    state: ProfileModelState,
    /// The persisted base set. `None` = every tool active.
    active_tools_base: Option<Vec<String>>,
    /// Ephemeral per-tool deltas; shadows the base while set.
    active_tools_overlay: Option<Vec<String>>,
    agents_md_warning: Option<String>,
    emitted_thinking_effort_warnings: HashSet<String>,
    config: ProfileConfig,
    configured_cwd: Option<String>,
    delegate: Option<Arc<dyn ProfileDelegate>>,
}

impl ProfileService {
    pub fn new(config: ProfileConfig) -> Self {
        Self {
            state: ProfileModelState::default(),
            active_tools_base: None,
            active_tools_overlay: None,
            agents_md_warning: None,
            emitted_thinking_effort_warnings: HashSet::new(),
            config,
            configured_cwd: None,
            delegate: None,
        }
    }

    pub fn with_delegate(config: ProfileConfig, delegate: Arc<dyn ProfileDelegate>) -> Self {
        let mut service = Self::new(config);
        service.delegate = Some(delegate);
        service
    }

    pub fn set_delegate(&mut self, delegate: Arc<dyn ProfileDelegate>) {
        self.delegate = Some(delegate);
    }

    /// The fallback cwd when the state carries none.
    pub fn set_configured_cwd(&mut self, cwd: impl Into<String>) {
        self.configured_cwd = Some(cwd.into());
    }

    pub fn config(&self) -> &ProfileConfig {
        &self.config
    }

    pub fn set_config(&mut self, config: ProfileConfig) {
        self.config = config;
    }

    /// The raw persisted slice — for wire replay and snapshotting.
    pub fn state(&self) -> &ProfileModelState {
        &self.state
    }

    // ── Binding ──────────────────────────────────────────────────────────

    /// Bind this agent's identity. First-bind only.
    pub fn bind(&mut self, input: BindAgentInput) -> Result<(), ProfileError> {
        // Fail fast before any resolution work.
        self.assert_bindable(&input.profile)?;

        let profile = self.resolve_profile_or_err(&input.profile)?;

        let alias = input
            .model
            .clone()
            .or_else(|| self.config.default_model.clone())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                ProfileError::new(
                    ProfileErrorCode::ModelNotConfigured,
                    format!(
                        "model is required to bind profile \"{}\" (no default model configured)",
                        input.profile
                    ),
                )
            })?;

        let model = self.lookup_model(Some(&alias));

        if input.strict_thinking {
            if let Some(requested) = &input.thinking {
                self.assert_thinking_effort_supported(requested, model.as_ref(), &alias)?;
            }
        }

        // Re-check after resolution: an edge-level guard always leaves an
        // interleaving window, so two concurrent binds must not both pass.
        self.assert_bindable(&profile.name)?;

        let had_profile = self.state.profile_name.is_some();
        // A same-name rebind keeps the persisted effort unless overridden.
        let requested = input
            .thinking
            .clone()
            .or_else(|| had_profile.then(|| self.thinking_level()));
        let thinking_level =
            self.resolve_thinking_effort(requested.as_deref(), model.as_ref());

        self.agents_md_warning = profile.agents_md_warning.clone();
        self.active_tools_overlay = None;
        self.active_tools_base = profile.tools.clone();

        self.state = profile_bind(
            &self.state,
            ProfileBindPayload {
                cwd: input.cwd.clone(),
                model_alias: Some(alias.clone()),
                profile_name: Some(profile.name.clone()),
                thinking_effort: thinking_level.clone(),
                system_prompt: profile.system_prompt.clone(),
                active_tool_names: profile.tools.clone(),
                disallowed_tools: profile.disallowed_tools.clone().unwrap_or_default(),
                subagents: profile.subagents.clone(),
            },
        );

        self.after_config_dispatch(input.cwd.as_deref(), true, true);
        self.publish_agents_md_warning();
        Ok(())
    }

    /// Rehydrate from a persisted snapshot. Bypasses the first-bind guard —
    /// restoring an identity is not switching one.
    pub fn apply_binding_snapshot(&mut self, snapshot: ProfileBindingSnapshot) {
        self.active_tools_overlay = None;
        self.active_tools_base = snapshot.active_tool_names.clone();
        self.state = profile_bind(
            &self.state,
            ProfileBindPayload {
                cwd: Some(snapshot.cwd.clone()),
                model_alias: snapshot.model_alias.clone(),
                profile_name: snapshot.profile_name.clone(),
                thinking_effort: snapshot.thinking_level.clone(),
                system_prompt: snapshot.system_prompt.clone(),
                active_tool_names: snapshot.active_tool_names.clone(),
                disallowed_tools: snapshot.disallowed_tools.clone().unwrap_or_default(),
                subagents: snapshot.subagents.clone(),
            },
        );
        self.after_config_dispatch(Some(&snapshot.cwd), true, true);
    }

    /// The current identity as a restorable snapshot.
    pub fn binding_snapshot(&self) -> ProfileBindingSnapshot {
        ProfileBindingSnapshot {
            cwd: self.cwd(),
            model_alias: self.state.model_alias.clone(),
            profile_name: self.state.profile_name.clone(),
            thinking_level: self.state.thinking_level.clone(),
            system_prompt: self.state.system_prompt.clone(),
            active_tool_names: self.active_tool_names().map(<[String]>::to_vec),
            disallowed_tools: self.state.disallowed_tools.clone(),
            subagents: self.state.subagents.clone(),
        }
    }

    /// Adopt an already-resolved profile without the first-bind guard —
    /// the re-render path after a tool-policy or config change.
    pub fn use_profile(&mut self, profile: &ResolvedAgentProfile) -> Result<(), ProfileError> {
        self.update(ProfileUpdateData {
            profile_name: Some(profile.name.clone()),
            system_prompt: Some(profile.system_prompt.clone()),
            disallowed_tools: Some(profile.disallowed_tools.clone().unwrap_or_default()),
            active_tool_names: Some(profile.tools.clone()),
            ..Default::default()
        })?;
        self.agents_md_warning = profile.agents_md_warning.clone();
        self.publish_agents_md_warning();
        Ok(())
    }

    // ── Updates ──────────────────────────────────────────────────────────

    pub fn update(&mut self, changed: ProfileUpdateData) -> Result<(), ProfileError> {
        if changed.has_config_changes() {
            let payload = self.resolve_config_payload(&changed);
            let cwd = payload.cwd.clone();
            let model_changed = payload.model_alias.is_some();
            let thinking_changed = changed.thinking_level.is_some();
            config_update(&mut self.state, &payload)?;
            self.after_config_dispatch(cwd.as_deref(), model_changed, thinking_changed);
        }
        if let Some(names) = changed.active_tool_names {
            self.set_active_tools(names);
        }
        Ok(())
    }

    /// Switch the bound model, binding the default profile if none is bound.
    pub fn set_model(&mut self, alias: &str) -> Result<ProfileSetModelResult, ProfileError> {
        let model = self.lookup_model(Some(alias));
        if self.state.profile_name.is_none() {
            self.bind(BindAgentInput {
                profile: DEFAULT_AGENT_PROFILE_NAME.to_string(),
                model: Some(alias.to_string()),
                ..Default::default()
            })?;
        } else if self.state.model_alias.as_deref() != Some(alias) {
            self.update(ProfileUpdateData {
                model_alias: Some(alias.to_string()),
                ..Default::default()
            })?;
        }
        Ok(ProfileSetModelResult {
            model: alias.to_string(),
            provider_name: model.and_then(|m| m.provider_name),
        })
    }

    /// Set the thinking effort. Explicit user input, so unsupported efforts
    /// are rejected rather than clamped.
    pub fn set_thinking(&mut self, level: &str) -> Result<(), ProfileError> {
        let model = self.current_model();
        let alias = self.state.model_alias.clone().unwrap_or_default();
        self.assert_thinking_effort_supported(level, model.as_ref(), &alias)?;
        let normalized =
            normalize_requested_thinking_effort(Some(level)).unwrap_or_else(|| level.to_string());
        self.update(ProfileUpdateData {
            thinking_level: Some(normalized),
            ..Default::default()
        })
    }

    // ── Reads ────────────────────────────────────────────────────────────

    pub fn get_model(&self) -> String {
        self.state.model_alias.clone().unwrap_or_default()
    }

    pub fn has_model(&self) -> bool {
        self.state.model_alias.is_some()
    }

    /// Bound to a profile *and* a model — the precondition for running a turn.
    pub fn is_runnable(&self) -> bool {
        self.state.profile_name.is_some() && self.has_model()
    }

    /// The bound alias actually resolves in the host catalog.
    pub fn has_provider(&self) -> bool {
        self.current_model().is_some()
    }

    pub fn get_system_prompt(&self) -> &str {
        &self.state.system_prompt
    }

    pub fn get_agents_md_warning(&self) -> Option<&str> {
        self.agents_md_warning.as_deref()
    }

    pub fn cwd(&self) -> String {
        self.state
            .cwd
            .clone()
            .or_else(|| self.configured_cwd.clone())
            .unwrap_or_default()
    }

    pub fn data(&self) -> ProfileData {
        ProfileData {
            cwd: self.cwd(),
            model_alias: self.state.model_alias.clone(),
            profile_name: self.state.profile_name.clone(),
            thinking_level: self.thinking_level(),
            system_prompt: self.state.system_prompt.clone(),
            active_tool_names: self.active_tool_names().map(<[String]>::to_vec),
            disallowed_tools: self.state.disallowed_tools.clone().unwrap_or_default(),
            subagents: self.state.subagents.clone(),
        }
    }

    /// The effort actually sent upstream, after the forced-effort override.
    pub fn get_effective_thinking_level(&self) -> String {
        self.resolve_thinking_state(self.current_model().as_ref())
            .effective
    }

    pub fn get_max_output_size(&self) -> Option<u32> {
        self.current_model().and_then(|m| m.max_output_size)
    }

    pub fn resolve_model_context(&self) -> Result<ProfileModelContext, ProfileError> {
        let alias = self.state.model_alias.clone().ok_or_else(|| {
            ProfileError::new(ProfileErrorCode::ModelNotConfigured, "Model not set")
        })?;
        let model = self.lookup_model(Some(&alias));
        Ok(ProfileModelContext {
            model_alias: alias,
            max_output_size: model.as_ref().and_then(|m| m.max_output_size),
            // `None` rather than `Some(false)`, matching the TS `|| undefined`.
            always_thinking: model
                .as_ref()
                .and_then(|m| m.thinking.always_thinking.then_some(true)),
            thinking_level: self.resolve_thinking_state(model.as_ref()).effective,
            reserved_context_size: self.config.reserved_context_size,
            compaction_trigger_ratio: self.config.compaction_trigger_ratio,
        })
    }

    pub fn resolve_request_params(&self) -> ModelRequestParams {
        let model = self.current_model();
        let thinking = self.resolve_thinking_state(model.as_ref());
        let overrides = &self.config.model_overrides;
        let sampling = SamplingOptions {
            temperature: overrides.temperature,
            top_p: overrides.top_p,
        };
        ModelRequestParams {
            cache_key: self.config.session_id.clone(),
            sampling: (sampling.temperature.is_some() || sampling.top_p.is_some())
                .then_some(sampling),
            thinking_keep: resolve_thinking_keep(
                overrides.thinking_keep.as_deref(),
                self.config.thinking.keep.as_deref(),
                &thinking.effective,
            ),
            thinking_effort: thinking.effective,
        }
    }

    // ── Active tools ─────────────────────────────────────────────────────

    /// The effective set: overlay if present, else the persisted base.
    /// `None` = every tool active.
    pub fn active_tool_names(&self) -> Option<&[String]> {
        self.active_tools_overlay
            .as_deref()
            .or(self.active_tools_base.as_deref())
    }

    /// Ephemeral add. A no-op when every tool is already active.
    pub fn add_active_tool(&mut self, name: &str) {
        let Some(current) = self.active_tool_names() else {
            return;
        };
        if current.iter().any(|candidate| candidate == name) {
            return;
        }
        let mut next = current.to_vec();
        next.push(name.to_string());
        self.active_tools_overlay = Some(next);
    }

    /// Ephemeral remove. A no-op when every tool is already active.
    pub fn remove_active_tool(&mut self, name: &str) {
        let Some(current) = self.active_tool_names() else {
            return;
        };
        if !current.iter().any(|candidate| candidate == name) {
            return;
        }
        self.active_tools_overlay = Some(
            current
                .iter()
                .filter(|candidate| candidate.as_str() != name)
                .cloned()
                .collect(),
        );
    }

    /// Whole-set replacement of the persisted base; drops the overlay.
    fn set_active_tools(&mut self, names: Option<Vec<String>>) {
        self.active_tools_overlay = None;
        self.active_tools_base = names;
    }

    // ── Internals ────────────────────────────────────────────────────────

    fn assert_bindable(&self, requested: &str) -> Result<(), ProfileError> {
        match &self.state.profile_name {
            Some(current) if current != requested => Err(ProfileError::new(
                ProfileErrorCode::ProfileAlreadyBound,
                format!(
                    "agent is already bound to profile \"{current}\"; cannot switch to \"{requested}\" in this session"
                ),
            )),
            _ => Ok(()),
        }
    }

    fn resolve_profile_or_err(&self, name: &str) -> Result<ResolvedAgentProfile, ProfileError> {
        self.delegate
            .as_ref()
            .and_then(|d| d.resolve_profile(name))
            .ok_or_else(|| {
                let available = self
                    .delegate
                    .as_ref()
                    .map(|d| d.list_profile_names().join(", "))
                    .unwrap_or_default();
                ProfileError::new(
                    ProfileErrorCode::ProfileUnknown,
                    format!(
                        "Unknown agent profile: \"{name}\". Available profiles: {available}"
                    ),
                )
            })
    }

    fn lookup_model(&self, alias: Option<&str>) -> Option<ModelInfo> {
        let alias = alias?;
        self.delegate.as_ref()?.model(alias)
    }

    fn current_model(&self) -> Option<ModelInfo> {
        self.lookup_model(self.state.model_alias.as_deref())
    }

    /// The persisted base effort, with the unconditional always-on clamp.
    fn thinking_level(&self) -> String {
        let stored = &self.state.thinking_level;
        if stored == "off" {
            let model = self.current_model();
            if model
                .as_ref()
                .is_some_and(|m| m.thinking.always_thinking)
            {
                return self.resolve_thinking_effort(Some(stored), model.as_ref());
            }
        }
        stored.clone()
    }

    fn resolve_thinking_state(&self, model: Option<&ModelInfo>) -> ThinkingState {
        let base = self.thinking_level();
        let forced = resolve_forced_thinking_effort(
            self.config.thinking.forced_effort.as_deref(),
            &base,
            model.is_some_and(|m| m.trait_driven_thinking),
        );
        ThinkingState {
            effective: forced.clone().unwrap_or_else(|| base.clone()),
            forced,
        }
    }

    fn resolve_thinking_effort(&self, requested: Option<&str>, model: Option<&ModelInfo>) -> String {
        resolve_thinking_effort_for_model(
            requested,
            Some(&self.config.thinking),
            model.map(|m| &m.thinking),
            model.is_some_and(|m| m.strict_thinking_validation),
        )
    }

    fn assert_thinking_effort_supported(
        &self,
        requested: &str,
        model: Option<&ModelInfo>,
        model_alias: &str,
    ) -> Result<(), ProfileError> {
        let Some(normalized) = normalize_requested_thinking_effort(Some(requested)) else {
            return Ok(());
        };
        let strict = model.is_some_and(|m| m.strict_thinking_validation);
        if model_supports_thinking_effort(&normalized, model.map(|m| &m.thinking), strict) {
            return Ok(());
        }
        let efforts: Vec<String> = model
            .map(|m| m.thinking.support_efforts.clone())
            .unwrap_or_default();
        let supported = if efforts.is_empty() {
            "off".to_string()
        } else {
            let mut all = vec!["off".to_string()];
            all.extend(efforts);
            all.join(", ")
        };
        Err(ProfileError::new(
            ProfileErrorCode::ModelConfigInvalid,
            format!(
                "Thinking effort \"{requested}\" is not supported by model \"{model_alias}\". Supported efforts: {supported}."
            ),
        ))
    }

    /// Resolve a partial update into a `config.update` payload, folding the
    /// requested effort against the (possibly new) model.
    fn resolve_config_payload(&self, changed: &ProfileUpdateData) -> ConfigUpdatePayload {
        let mut payload = ConfigUpdatePayload {
            cwd: changed.cwd.clone(),
            model_alias: changed.model_alias.clone(),
            profile_name: changed.profile_name.clone(),
            system_prompt: changed.system_prompt.clone(),
            disallowed_tools: changed.disallowed_tools.clone(),
            ..Default::default()
        };
        // A model switch re-resolves the effort even when the caller did not
        // ask for one: the new model may not support the current value.
        if changed.thinking_level.is_some() || changed.model_alias.is_some() {
            let alias = changed
                .model_alias
                .clone()
                .or_else(|| self.state.model_alias.clone());
            let model = self.lookup_model(alias.as_deref());
            let requested = changed
                .thinking_level
                .clone()
                .or_else(|| self.state.model_alias.as_ref().map(|_| self.thinking_level()));
            payload.thinking_effort =
                Some(self.resolve_thinking_effort(requested.as_deref(), model.as_ref()));
        }
        payload
    }

    /// Live-only side effects. Never part of the reducer, so replay stays
    /// silent.
    fn after_config_dispatch(
        &mut self,
        cwd: Option<&str>,
        model_changed: bool,
        thinking_changed: bool,
    ) {
        if let (Some(cwd), Some(delegate)) = (cwd, &self.delegate) {
            delegate.chdir(cwd);
        }
        if model_changed || thinking_changed {
            self.warn_about_unlisted_thinking_effort();
        }
        self.emit_status_updated(model_changed || thinking_changed);
    }

    /// Warn once per (model, effort) when an Anthropic-protocol model is asked
    /// for an effort it does not list. Lenient transports still send it — the
    /// backend may accept values the local catalog does not know.
    fn warn_about_unlisted_thinking_effort(&mut self) {
        let Some(model) = self.current_model() else {
            return;
        };
        if model.protocol.as_deref() != Some("anthropic") {
            return;
        }
        let effort = self.get_effective_thinking_level();
        if effort == "on" || effort == "off" {
            return;
        }
        let efforts: Vec<String> = model
            .thinking
            .support_efforts
            .iter()
            .filter(|value| !value.is_empty())
            .cloned()
            .collect();
        if efforts.is_empty() || efforts.contains(&effort) {
            return;
        }
        let known = efforts.join(",");
        let key = format!("{}\0{}\0{}\0{}", model.id, model.name, effort, known);
        if !self.emitted_thinking_effort_warnings.insert(key) {
            return;
        }
        let message = format!(
            "Thinking effort \"{}\" is not listed for model \"{}\" (known: {}). The configured value will be sent unchanged to the Anthropic-compatible backend.",
            effort,
            model.name,
            efforts.join(", ")
        );
        if let Some(delegate) = &self.delegate {
            delegate.emit_warning("anthropic-thinking-effort-not-listed", &message);
        }
    }

    fn emit_status_updated(&self, include_thinking_effort: bool) {
        if !self.has_model() {
            return;
        }
        let Some(delegate) = &self.delegate else {
            return;
        };
        let capabilities = self.current_model();
        delegate.emit_status_updated(&AgentStatusUpdate {
            model: self.state.model_alias.clone(),
            thinking_effort: include_thinking_effort
                .then(|| self.get_effective_thinking_level()),
            max_context_tokens: capabilities
                .as_ref()
                .and_then(|m| m.max_input_tokens.or(m.max_context_tokens)),
        });
    }

    fn publish_agents_md_warning(&self) {
        let (Some(warning), Some(delegate)) = (&self.agents_md_warning, &self.delegate) else {
            return;
        };
        delegate.emit_warning("agents-md-oversized", warning);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct TestDelegate {
        models: Vec<ModelInfo>,
        profiles: Vec<ResolvedAgentProfile>,
        warnings: Mutex<Vec<(String, String)>>,
        statuses: Mutex<Vec<AgentStatusUpdate>>,
        chdirs: Mutex<Vec<String>>,
    }

    impl ProfileDelegate for TestDelegate {
        fn model(&self, alias: &str) -> Option<ModelInfo> {
            self.models.iter().find(|m| m.alias == alias).cloned()
        }
        fn resolve_profile(&self, name: &str) -> Option<ResolvedAgentProfile> {
            self.profiles.iter().find(|p| p.name == name).cloned()
        }
        fn list_profile_names(&self) -> Vec<String> {
            self.profiles.iter().map(|p| p.name.clone()).collect()
        }
        fn chdir(&self, cwd: &str) {
            self.chdirs
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(cwd.to_string());
        }
        fn emit_warning(&self, code: &str, message: &str) {
            self.warnings
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push((code.to_string(), message.to_string()));
        }
        fn emit_status_updated(&self, update: &AgentStatusUpdate) {
            self.statuses
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(update.clone());
        }
    }

    impl TestDelegate {
        fn warning_codes(&self) -> Vec<String> {
            self.warnings
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .iter()
                .map(|(code, _)| code.clone())
                .collect()
        }
    }

    fn thinking_model(alias: &str, efforts: &[&str]) -> ModelInfo {
        ModelInfo {
            alias: alias.to_string(),
            id: format!("id-{alias}"),
            name: alias.to_string(),
            max_input_tokens: Some(128_000),
            max_output_size: Some(8_192),
            provider_name: Some("moonshot".to_string()),
            thinking: ModelThinkingMetadata {
                capabilities: Some(ModelCapabilities::List(vec!["thinking".to_string()])),
                support_efforts: efforts.iter().map(|s| s.to_string()).collect(),
                ..Default::default()
            },
            ..Default::default()
        }
    }

    fn profile(name: &str) -> ResolvedAgentProfile {
        ResolvedAgentProfile {
            name: name.to_string(),
            system_prompt: format!("prompt for {name}"),
            tools: Some(vec!["Read".to_string(), "Grep".to_string()]),
            disallowed_tools: Some(vec!["Bash".to_string()]),
            subagents: Some(vec!["coder".to_string()]),
            agents_md_warning: None,
        }
    }

    fn service() -> (ProfileService, Arc<TestDelegate>) {
        let delegate = Arc::new(TestDelegate {
            models: vec![
                thinking_model("kimi", &["low", "medium", "high"]),
                thinking_model("kimi-2", &["low", "high"]),
            ],
            profiles: vec![profile("agent"), profile("coder")],
            ..Default::default()
        });
        let config = ProfileConfig {
            default_model: Some("kimi".to_string()),
            session_id: "sess-1".to_string(),
            ..Default::default()
        };
        (
            ProfileService::with_delegate(config, delegate.clone()),
            delegate,
        )
    }

    #[test]
    fn starts_unbound_and_not_runnable() {
        let (s, _) = service();
        assert!(!s.has_model());
        assert!(!s.is_runnable());
        assert!(!s.has_provider());
        assert_eq!(s.get_model(), "");
        assert_eq!(s.get_system_prompt(), "");
    }

    #[test]
    fn bind_establishes_identity() {
        let (mut s, d) = service();
        s.bind(BindAgentInput {
            profile: "agent".into(),
            cwd: Some("/work".into()),
            ..Default::default()
        })
        .unwrap();

        let data = s.data();
        assert_eq!(data.profile_name.as_deref(), Some("agent"));
        assert_eq!(data.model_alias.as_deref(), Some("kimi"), "default model applied");
        assert_eq!(data.system_prompt, "prompt for agent");
        assert_eq!(data.cwd, "/work");
        assert_eq!(data.disallowed_tools, vec!["Bash".to_string()]);
        assert_eq!(data.subagents.as_deref(), Some(&["coder".to_string()][..]));
        assert!(s.is_runnable() && s.has_provider());
        assert_eq!(
            d.chdirs.lock().unwrap().as_slice(),
            &["/work".to_string()],
            "chdir runs live-only after the state write"
        );
    }

    #[test]
    fn bind_defaults_thinking_from_the_model() {
        let (mut s, _) = service();
        s.bind(BindAgentInput {
            profile: "agent".into(),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(s.data().thinking_level, "medium", "middle of the declared list");
    }

    #[test]
    fn bind_is_first_bind_only() {
        let (mut s, _) = service();
        s.bind(BindAgentInput {
            profile: "agent".into(),
            ..Default::default()
        })
        .unwrap();
        let err = s
            .bind(BindAgentInput {
                profile: "coder".into(),
                ..Default::default()
            })
            .unwrap_err();
        assert_eq!(err.code, ProfileErrorCode::ProfileAlreadyBound);
        assert_eq!(s.data().profile_name.as_deref(), Some("agent"));
    }

    #[test]
    fn same_name_rebind_keeps_the_persisted_effort() {
        let (mut s, _) = service();
        s.bind(BindAgentInput {
            profile: "agent".into(),
            thinking: Some("high".into()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(s.data().thinking_level, "high");

        s.bind(BindAgentInput {
            profile: "agent".into(),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(s.data().thinking_level, "high", "inherited, not reset");
    }

    #[test]
    fn bind_rejects_an_unknown_profile() {
        let (mut s, _) = service();
        let err = s
            .bind(BindAgentInput {
                profile: "nope".into(),
                ..Default::default()
            })
            .unwrap_err();
        assert_eq!(err.code, ProfileErrorCode::ProfileUnknown);
        assert!(err.message.contains("agent, coder"), "lists what is available");
    }

    #[test]
    fn bind_requires_a_model() {
        let delegate = Arc::new(TestDelegate {
            profiles: vec![profile("agent")],
            ..Default::default()
        });
        let mut s = ProfileService::with_delegate(ProfileConfig::default(), delegate);
        let err = s
            .bind(BindAgentInput {
                profile: "agent".into(),
                ..Default::default()
            })
            .unwrap_err();
        assert_eq!(err.code, ProfileErrorCode::ModelNotConfigured);
    }

    #[test]
    fn strict_thinking_rejects_an_unsupported_effort_up_front() {
        let (mut s, _) = service();
        let mut model = thinking_model("strict", &["low", "high"]);
        model.strict_thinking_validation = true;
        let delegate = Arc::new(TestDelegate {
            models: vec![model],
            profiles: vec![profile("agent")],
            ..Default::default()
        });
        s.set_delegate(delegate);

        let err = s
            .bind(BindAgentInput {
                profile: "agent".into(),
                model: Some("strict".into()),
                thinking: Some("ludicrous".into()),
                strict_thinking: true,
                ..Default::default()
            })
            .unwrap_err();
        assert_eq!(err.code, ProfileErrorCode::ModelConfigInvalid);
        assert!(err.message.contains("off, low, high"));
        assert!(!s.is_runnable(), "a rejected bind must not partially apply");
    }

    #[test]
    fn inherited_thinking_clamps_instead_of_rejecting() {
        let mut model = thinking_model("strict", &["low", "high"]);
        model.strict_thinking_validation = true;
        let delegate = Arc::new(TestDelegate {
            models: vec![model],
            profiles: vec![profile("agent")],
            ..Default::default()
        });
        let mut s = ProfileService::with_delegate(
            ProfileConfig {
                default_model: Some("strict".into()),
                ..Default::default()
            },
            delegate,
        );
        s.bind(BindAgentInput {
            profile: "agent".into(),
            thinking: Some("drifted".into()),
            strict_thinking: false,
            ..Default::default()
        })
        .unwrap();
        assert_eq!(s.data().thinking_level, "high", "clamped to the model default");
    }

    #[test]
    fn set_thinking_normalizes_and_rejects() {
        let (mut s, _) = service();
        s.bind(BindAgentInput {
            profile: "agent".into(),
            ..Default::default()
        })
        .unwrap();
        s.set_thinking("  HIGH ").unwrap();
        assert_eq!(s.data().thinking_level, "high");

        let mut model = thinking_model("strict", &["low"]);
        model.strict_thinking_validation = true;
        let delegate = Arc::new(TestDelegate {
            models: vec![model],
            profiles: vec![profile("agent")],
            ..Default::default()
        });
        s.set_delegate(delegate);
        s.update(ProfileUpdateData {
            model_alias: Some("strict".into()),
            ..Default::default()
        })
        .unwrap();
        assert!(s.set_thinking("bogus").is_err());
    }

    #[test]
    fn set_model_binds_the_default_profile_when_unbound() {
        let (mut s, _) = service();
        let result = s.set_model("kimi-2").unwrap();
        assert_eq!(result.model, "kimi-2");
        assert_eq!(result.provider_name.as_deref(), Some("moonshot"));
        assert_eq!(s.data().profile_name.as_deref(), Some(DEFAULT_AGENT_PROFILE_NAME));
        assert_eq!(s.data().model_alias.as_deref(), Some("kimi-2"));
    }

    #[test]
    fn set_model_switch_re_resolves_the_effort_against_the_new_model() {
        let (mut s, _) = service();
        s.bind(BindAgentInput {
            profile: "agent".into(),
            thinking: Some("medium".into()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(s.data().thinking_level, "medium");

        // kimi-2 declares only low/high — "medium" is not listed. The
        // transport is lenient, so the value is kept and sent unchanged.
        s.set_model("kimi-2").unwrap();
        assert_eq!(s.data().model_alias.as_deref(), Some("kimi-2"));
        assert_eq!(s.data().thinking_level, "medium");
    }

    #[test]
    fn model_switch_to_a_strict_model_clamps_the_effort() {
        let (mut s, _) = service();
        s.bind(BindAgentInput {
            profile: "agent".into(),
            thinking: Some("medium".into()),
            ..Default::default()
        })
        .unwrap();

        let mut strict = thinking_model("strict", &["low", "high"]);
        strict.strict_thinking_validation = true;
        let delegate = Arc::new(TestDelegate {
            models: vec![strict],
            profiles: vec![profile("agent")],
            ..Default::default()
        });
        s.set_delegate(delegate);
        s.update(ProfileUpdateData {
            model_alias: Some("strict".into()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(s.data().thinking_level, "high", "unlisted effort clamped");
    }

    #[test]
    fn active_tools_overlay_shadows_the_persisted_base() {
        let (mut s, _) = service();
        s.bind(BindAgentInput {
            profile: "agent".into(),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(s.active_tool_names().unwrap(), ["Read", "Grep"]);

        s.add_active_tool("Write");
        assert_eq!(s.active_tool_names().unwrap(), ["Read", "Grep", "Write"]);
        s.add_active_tool("Write");
        assert_eq!(
            s.active_tool_names().unwrap().len(),
            3,
            "adding twice is a no-op"
        );

        s.remove_active_tool("Grep");
        assert_eq!(s.active_tool_names().unwrap(), ["Read", "Write"]);
        s.remove_active_tool("Absent");
        assert_eq!(s.active_tool_names().unwrap(), ["Read", "Write"]);
    }

    #[test]
    fn active_tool_deltas_are_noops_when_every_tool_is_active() {
        let (mut s, _) = service();
        assert!(s.active_tool_names().is_none());
        s.add_active_tool("Write");
        s.remove_active_tool("Read");
        assert!(
            s.active_tool_names().is_none(),
            "unrestricted stays unrestricted"
        );
    }

    #[test]
    fn setting_the_base_drops_the_overlay() {
        let (mut s, _) = service();
        s.bind(BindAgentInput {
            profile: "agent".into(),
            ..Default::default()
        })
        .unwrap();
        s.add_active_tool("Write");
        s.update(ProfileUpdateData {
            active_tool_names: Some(Some(vec!["Only".into()])),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(s.active_tool_names().unwrap(), ["Only"]);

        s.update(ProfileUpdateData {
            active_tool_names: Some(None),
            ..Default::default()
        })
        .unwrap();
        assert!(s.active_tool_names().is_none(), "reset to unrestricted");
    }

    #[test]
    fn snapshot_round_trips_the_identity() {
        let (mut s, _) = service();
        s.bind(BindAgentInput {
            profile: "agent".into(),
            cwd: Some("/work".into()),
            thinking: Some("high".into()),
            ..Default::default()
        })
        .unwrap();
        s.add_active_tool("Write");
        let snapshot = s.binding_snapshot();

        let (mut restored, _) = service();
        restored.apply_binding_snapshot(snapshot);
        assert_eq!(restored.data().profile_name.as_deref(), Some("agent"));
        assert_eq!(restored.data().thinking_level, "high");
        assert_eq!(restored.data().cwd, "/work");
        assert_eq!(
            restored.active_tool_names().unwrap(),
            ["Read", "Grep", "Write"],
            "the overlay is folded into the snapshot"
        );
    }

    #[test]
    fn snapshot_restore_bypasses_the_first_bind_guard() {
        let (mut s, _) = service();
        s.bind(BindAgentInput {
            profile: "agent".into(),
            ..Default::default()
        })
        .unwrap();
        let mut snapshot = s.binding_snapshot();
        snapshot.profile_name = Some("coder".into());
        s.apply_binding_snapshot(snapshot);
        assert_eq!(s.data().profile_name.as_deref(), Some("coder"));
    }

    #[test]
    fn request_params_carry_session_cache_key_and_keep() {
        let (mut s, _) = service();
        s.bind(BindAgentInput {
            profile: "agent".into(),
            ..Default::default()
        })
        .unwrap();
        let params = s.resolve_request_params();
        assert_eq!(params.cache_key, "sess-1");
        assert_eq!(params.thinking_effort, "medium");
        assert_eq!(params.thinking_keep.as_deref(), Some("all"));
        assert!(params.sampling.is_none(), "no overrides means no sampling block");
    }

    #[test]
    fn request_params_include_sampling_only_when_overridden() {
        let (mut s, _) = service();
        let mut config = s.config().clone();
        config.model_overrides.temperature = Some(0.3);
        config.model_overrides.thinking_keep = Some("off".into());
        s.set_config(config);
        s.bind(BindAgentInput {
            profile: "agent".into(),
            ..Default::default()
        })
        .unwrap();

        let params = s.resolve_request_params();
        assert_eq!(params.sampling.as_ref().unwrap().temperature, Some(0.3));
        assert!(params.sampling.as_ref().unwrap().top_p.is_none());
        assert!(params.thinking_keep.is_none(), "an off-value disables keep");
    }

    #[test]
    fn forced_effort_applies_only_to_trait_driven_models() {
        let mut model = thinking_model("kimi", &["low", "medium", "high"]);
        model.trait_driven_thinking = true;
        let delegate = Arc::new(TestDelegate {
            models: vec![model],
            profiles: vec![profile("agent")],
            ..Default::default()
        });
        let mut s = ProfileService::with_delegate(
            ProfileConfig {
                default_model: Some("kimi".into()),
                thinking: ThinkingConfig {
                    forced_effort: Some("LOW".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
            delegate,
        );
        s.bind(BindAgentInput {
            profile: "agent".into(),
            thinking: Some("high".into()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(s.data().thinking_level, "high", "the base is untouched");
        assert_eq!(
            s.get_effective_thinking_level(),
            "low",
            "the forced override wins on the wire"
        );
    }

    #[test]
    fn model_context_reports_never_and_requires_a_model() {
        let (mut s, _) = service();
        assert_eq!(
            s.resolve_model_context().unwrap_err().code,
            ProfileErrorCode::ModelNotConfigured
        );
        s.bind(BindAgentInput {
            profile: "agent".into(),
            ..Default::default()
        })
        .unwrap();
        let ctx = s.resolve_model_context().unwrap();
        assert_eq!(ctx.model_alias, "kimi");
        assert_eq!(ctx.max_output_size, Some(8_192));
        assert_eq!(ctx.thinking_level, "medium");
        assert!(
            ctx.always_thinking.is_none(),
            "false is reported as absent, matching the TS `|| undefined`"
        );
    }

    #[test]
    fn status_updates_are_emitted_only_once_a_model_exists() {
        let (mut s, d) = service();
        s.update(ProfileUpdateData {
            cwd: Some("/work".into()),
            ..Default::default()
        })
        .unwrap();
        assert!(
            d.statuses.lock().unwrap().is_empty(),
            "no model, no status"
        );

        s.bind(BindAgentInput {
            profile: "agent".into(),
            ..Default::default()
        })
        .unwrap();
        let statuses = d.statuses.lock().unwrap();
        let last = statuses.last().expect("status");
        assert_eq!(last.model.as_deref(), Some("kimi"));
        assert_eq!(last.max_context_tokens, Some(128_000));
        assert_eq!(last.thinking_effort.as_deref(), Some("medium"));
    }

    #[test]
    fn agents_md_warning_is_surfaced_after_bind() {
        let mut p = profile("agent");
        p.agents_md_warning = Some("AGENTS.md is very large".into());
        let delegate = Arc::new(TestDelegate {
            models: vec![thinking_model("kimi", &["low", "high"])],
            profiles: vec![p],
            ..Default::default()
        });
        let mut s = ProfileService::with_delegate(
            ProfileConfig {
                default_model: Some("kimi".into()),
                ..Default::default()
            },
            delegate.clone(),
        );
        s.bind(BindAgentInput {
            profile: "agent".into(),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(s.get_agents_md_warning(), Some("AGENTS.md is very large"));
        assert!(delegate.warning_codes().contains(&"agents-md-oversized".to_string()));
    }

    #[test]
    fn unlisted_anthropic_effort_warns_exactly_once() {
        let mut model = thinking_model("claude", &["low", "high"]);
        model.protocol = Some("anthropic".into());
        let delegate = Arc::new(TestDelegate {
            models: vec![model],
            profiles: vec![profile("agent")],
            ..Default::default()
        });
        let mut s = ProfileService::with_delegate(
            ProfileConfig {
                default_model: Some("claude".into()),
                ..Default::default()
            },
            delegate.clone(),
        );
        s.bind(BindAgentInput {
            profile: "agent".into(),
            thinking: Some("medium".into()),
            ..Default::default()
        })
        .unwrap();
        s.set_thinking("medium").unwrap();

        let warned = delegate
            .warning_codes()
            .iter()
            .filter(|c| c.as_str() == "anthropic-thinking-effort-not-listed")
            .count();
        assert_eq!(warned, 1, "deduplicated per (model, effort)");
    }

    #[test]
    fn listed_anthropic_effort_does_not_warn() {
        let mut model = thinking_model("claude", &["low", "high"]);
        model.protocol = Some("anthropic".into());
        let delegate = Arc::new(TestDelegate {
            models: vec![model],
            profiles: vec![profile("agent")],
            ..Default::default()
        });
        let mut s = ProfileService::with_delegate(
            ProfileConfig {
                default_model: Some("claude".into()),
                ..Default::default()
            },
            delegate.clone(),
        );
        s.bind(BindAgentInput {
            profile: "agent".into(),
            thinking: Some("high".into()),
            ..Default::default()
        })
        .unwrap();
        assert!(
            !delegate
                .warning_codes()
                .contains(&"anthropic-thinking-effort-not-listed".to_string())
        );
    }

    #[test]
    fn use_profile_re_renders_without_the_bind_guard() {
        let (mut s, _) = service();
        s.bind(BindAgentInput {
            profile: "agent".into(),
            ..Default::default()
        })
        .unwrap();

        let mut refreshed = profile("agent");
        refreshed.system_prompt = "re-rendered".into();
        refreshed.tools = Some(vec!["Read".into()]);
        s.use_profile(&refreshed).unwrap();

        assert_eq!(s.get_system_prompt(), "re-rendered");
        assert_eq!(s.active_tool_names().unwrap(), ["Read"]);
    }

    #[test]
    fn cwd_falls_back_to_the_configured_value() {
        let (mut s, _) = service();
        assert_eq!(s.cwd(), "");
        s.set_configured_cwd("/fallback");
        assert_eq!(s.cwd(), "/fallback");
        s.bind(BindAgentInput {
            profile: "agent".into(),
            cwd: Some("/explicit".into()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(s.cwd(), "/explicit", "state wins over the fallback");
    }

    #[test]
    fn has_provider_is_false_for_an_unresolvable_alias() {
        let (mut s, _) = service();
        s.bind(BindAgentInput {
            profile: "agent".into(),
            model: Some("ghost".into()),
            ..Default::default()
        })
        .unwrap();
        assert!(s.has_model(), "the alias is recorded");
        assert!(!s.has_provider(), "but it resolves to nothing");
        assert_eq!(s.data().thinking_level, "off", "no model means no thinking");
    }
}
