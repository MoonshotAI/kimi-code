//! Kimi managed auth — login / logout / status over the kimi OAuth device
//! flow plus the engine's config, mirroring node-sdk's `KimiAuthFacade`.
//!
//! The token is persisted as `providers.kimi.apiKey` via the harness's
//! `config/set` (null-patch delete on logout), so a logged-in session is
//! visible to any host reading the engine config — the same key the engine's
//! `native_llm` provider resolution reads.

use kimi_oauth::{run_device_flow, DeviceAuthorization, DeviceToken, OAuthFlowConfig};

use crate::Harness;

/// Kimi managed-auth facade (node-sdk `KimiAuthFacade` parity).
#[derive(Clone, Debug)]
pub struct KimiAuth {
    flow: OAuthFlowConfig,
}

impl Default for KimiAuth {
    fn default() -> Self {
        Self::new()
    }
}

impl KimiAuth {
    /// The facade against the production kimi OAuth endpoints.
    pub fn new() -> Self {
        Self {
            flow: OAuthFlowConfig::kimi(),
        }
    }

    /// The facade against custom OAuth endpoints (test hooks).
    pub fn with_flow_config(flow: OAuthFlowConfig) -> Self {
        Self { flow }
    }

    /// The underlying flow config (endpoints / client id).
    pub fn flow_config(&self) -> &OAuthFlowConfig {
        &self.flow
    }

    /// Run the full device flow, then persist the granted token as
    /// `providers.kimi.apiKey`. `on_prompt` receives the verification info
    /// (URI / user code) so the caller can print it or open a browser.
    ///
    /// Resolves with the granted token pair. A config write failure is
    /// surfaced as an error after the flow itself completed.
    pub async fn login(
        &self,
        harness: &Harness,
        max_polls: Option<u32>,
        mut on_prompt: impl FnMut(&DeviceAuthorization),
    ) -> anyhow::Result<DeviceToken> {
        let token = run_device_flow(&self.flow, max_polls, &mut on_prompt).await?;
        harness
            .set_config(serde_json::json!({
                "providers": { "kimi": { "apiKey": token.access_token } }
            }))
            .await?;
        Ok(token)
    }

    /// Remove `providers.kimi` (null-patch delete) — node-sdk `logout`
    /// parity.
    pub async fn logout(&self, harness: &Harness) -> anyhow::Result<()> {
        harness
            .set_config(serde_json::json!({ "providers": { "kimi": null } }))
            .await?;
        Ok(())
    }

    /// True when a kimi token is present in the engine config — node-sdk
    /// `status` parity.
    pub async fn status(&self, harness: &Harness) -> anyhow::Result<bool> {
        let config = harness.config().await?;
        Ok(config["providers"]["kimi"]["apiKey"]
            .as_str()
            .is_some_and(|k| !k.is_empty()))
    }
}
