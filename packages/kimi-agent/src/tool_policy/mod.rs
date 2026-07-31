/// `toolPolicy` — Agent-scope tool authorization.
///
/// Combines profile, global configuration, and session-owned restrictions into
/// one policy that implements `ToolSelectHost`, used by both provider schema
/// projection and executor preflight.
///
/// Port of `packages/agent-core-v2/src/agent/toolPolicy/toolPolicyService.ts`.
pub mod evaluate;

use evaluate::GlobalToolsPolicy;
use crate::context::types::ToolDefinition;
use crate::profile::ProfileData;
use crate::tool_select::{ToolSelectHost, ToolSelectInfo};

// Re-export key types from evaluate.
pub use evaluate::{
    GlobPattern, InactiveToolPattern, InactiveToolPatternKind, ToolActivationPolicy, ToolPolicyLayers,
    find_inactive_tool_patterns, is_tool_active, is_tool_active_composed, literal_tool_names,
    resolve_active_tool_names,
};

/// Global `[tools]` configuration section, mirroring the TS `ToolsConfig`.
#[derive(Debug, Clone, Default)]
pub struct ToolsConfig {
    /// Allowlist: when non-empty, only these tools are active.
    pub enabled: Option<Vec<String>>,
    /// Denylist: these tools are explicitly disabled.
    pub disabled: Option<Vec<String>>,
}

/// Service that implements `ToolSelectHost` by composing the three policy
/// layers: profile, global `[tools]` config, and session denylist.
///
/// Non-policy methods (`list_tools`, `resolve_schema`, etc.) are delegated to
/// an inner host.
pub struct ToolPolicyService<H: ToolSelectHost> {
    inner: H,
    profile: Option<ProfileData>,
    config_tools: Option<ToolsConfig>,
    session_disabled: Vec<String>,
}

impl<H: ToolSelectHost> ToolPolicyService<H> {
    pub fn new(inner: H) -> Self {
        Self {
            inner,
            profile: None,
            config_tools: None,
            session_disabled: Vec::new(),
        }
    }

    /// Set the profile data used for the profile policy layer.
    pub fn set_profile(&mut self, profile: Option<ProfileData>) {
        self.profile = profile;
    }

    /// Set the global `[tools]` configuration.
    pub fn set_config_tools(&mut self, config: Option<ToolsConfig>) {
        self.config_tools = config;
    }

    /// Set the session-level disabled tools (denylist).
    pub fn set_session_disabled(&mut self, names: Vec<String>) {
        self.session_disabled = names;
    }

    /// Check whether a tool is active using only the profile allowlist and
    /// denylist (no global or session layer), matching TS
    /// `isToolActiveForDisclosure` behavior.
    pub fn is_tool_active_for_profile(
        &self,
        profile: &ToolActivationPolicy,
        name: &str,
        source: &str,
    ) -> bool {
        is_tool_active_composed(
            &evaluate::ToolPolicyLayers {
                profile: profile.clone(),
                global: self.config_tools.as_ref().map(|cfg| GlobalToolsPolicy {
                    enabled: cfg.enabled.clone(),
                    disabled: cfg.disabled.clone(),
                }),
                session_disabled_tools: Some(self.session_disabled.clone())
                    .filter(|v: &Vec<String>| !v.is_empty()),
            },
            name,
            source,
        )
    }

    /// The profile policy layer built from the current profile data.
    fn profile_policy(&self) -> ToolActivationPolicy {
        ToolActivationPolicy {
            tools: self
                .profile
                .as_ref()
                .and_then(|p| p.active_tool_names.clone()),
            disallowed_tools: Some(
                self.profile
                    .as_ref()
                    .map(|p| p.disallowed_tools.clone())
                    .unwrap_or_default(),
            )
            .filter(|v: &Vec<String>| !v.is_empty()),
        }
    }
}

impl<H: ToolSelectHost> ToolSelectHost for ToolPolicyService<H> {
    fn list_tools(&self) -> Vec<ToolSelectInfo> {
        self.inner.list_tools()
    }

    fn resolve_schema(&self, name: &str) -> Option<ToolDefinition> {
        self.inner.resolve_schema(name)
    }

    fn is_tool_active(&self, name: &str, source: &str) -> bool {
        let profile = self.profile_policy();
        is_tool_active_composed(
            &ToolPolicyLayers {
                profile,
                global: self.config_tools.as_ref().map(|cfg| GlobalToolsPolicy {
                    enabled: cfg.enabled.clone(),
                    disabled: cfg.disabled.clone(),
                }),
                session_disabled_tools: Some(self.session_disabled.clone())
                    .filter(|v: &Vec<String>| !v.is_empty()),
            },
            name,
            source,
        )
    }

    /// Disclosure check: uses only the profile denylist (no allowlist), so
    /// disclosure entries retain their implicit availability even when the
    /// profile allowlist omits them, while explicit deny layers still apply.
    fn is_tool_active_for_disclosure(&self, name: &str, source: &str) -> bool {
        let profile = self.profile_policy();
        let disclosure_profile = ToolActivationPolicy {
            tools: None,
            disallowed_tools: profile.disallowed_tools,
        };
        is_tool_active_composed(
            &ToolPolicyLayers {
                profile: disclosure_profile,
                global: self.config_tools.as_ref().map(|cfg| GlobalToolsPolicy {
                    enabled: cfg.enabled.clone(),
                    disabled: cfg.disabled.clone(),
                }),
                session_disabled_tools: Some(self.session_disabled.clone())
                    .filter(|v: &Vec<String>| !v.is_empty()),
            },
            name,
            source,
        )
    }

    fn model_supports_dynamic_tools(&self) -> bool {
        self.inner.model_supports_dynamic_tools()
    }

    fn flag_enabled(&self) -> bool {
        self.inner.flag_enabled()
    }
}

#[cfg(test)]
mod tests;