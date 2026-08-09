//! Kimi managed auth — login / logout / status over the kimi OAuth device
//! flow plus the engine's config, mirroring node-sdk's `KimiAuthFacade`.
//!
//! The token is persisted as `providers.kimi.apiKey` via the harness's
//! `config/set` (null-patch delete on logout), so a logged-in session is
//! visible to any host reading the engine config — the same key the engine's
//! `native_llm` provider resolution reads.
//!
//! Managed-account surfaces (`get_managed_usage`, feedback upload) hit the
//! public Kimi Code API (`{KIMI_CODE_BASE_URL | https://api.kimi.com/coding/v1}`)
//! with the stored bearer token — node-sdk `managed-usage.ts` /
//! `managed-feedback.ts` parity.

use kimi_oauth::{run_device_flow, DeviceAuthorization, DeviceToken, OAuthFlowConfig};

use crate::Harness;

/// The canonical managed Kimi Code API base URL (node-sdk
/// `kimiCodeBaseUrl` parity): `KIMI_CODE_BASE_URL` when set, else
/// `https://api.kimi.com/coding/v1`; a trailing slash is normalized away.
pub fn kimi_code_base_url() -> String {
    std::env::var("KIMI_CODE_BASE_URL")
        .unwrap_or_else(|_| "https://api.kimi.com/coding/v1".to_string())
        .trim_end_matches('/')
        .to_string()
}

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

    /// True when a token is present for the provider in the engine config —
    /// node-sdk `status` parity (any provider name; defaults to `kimi`).
    pub async fn status(&self, harness: &Harness, provider: Option<&str>) -> anyhow::Result<bool> {
        let provider = provider.unwrap_or("kimi");
        let config = harness.config().await?;
        Ok(config["providers"][provider]["apiKey"]
            .as_str()
            .is_some_and(|k| !k.is_empty()))
    }

    /// The stored bearer token for a provider (defaults to `kimi`) — the
    /// node-sdk `getCachedAccessToken` equivalent for config-persisted
    /// tokens (the engine config is the single token source here).
    pub async fn get_cached_access_token(
        &self,
        harness: &Harness,
        provider: Option<&str>,
    ) -> anyhow::Result<Option<String>> {
        let provider = provider.unwrap_or("kimi");
        let config = harness.config().await?;
        Ok(config["providers"][provider]["apiKey"]
            .as_str()
            .filter(|k| !k.is_empty())
            .map(str::to_string))
    }

    /// Managed usage for the kimi provider — node-sdk `getManagedUsage`
    /// parity. Resolves with the raw wire payload (`{ usages: [...], ... }`);
    /// hosts format it. Network call — errors carry an actionable hint for
    /// 401 / 404.
    pub async fn get_managed_usage(&self, harness: &Harness) -> Result<serde_json::Value, String> {
        let token = self.require_token(harness).await?;
        let url = format!("{}/usages", kimi_code_base_url());
        let response = reqwest::Client::new()
            .get(&url)
            .bearer_auth(&token)
            .header("Accept", "application/json")
            .timeout(std::time::Duration::from_secs(8))
            .send()
            .await
            .map_err(|e| format!("Failed to fetch usage: {e}"))?;
        let status = response.status();
        let body: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to fetch usage: {e}"))?;
        if !status.is_success() {
            let hint = match status.as_u16() {
                401 => "Authorization failed. Please check your API key (try /login).".to_string(),
                404 => "Usage endpoint not available. Try Kimi For Coding.".to_string(),
                _ => format!("Failed to fetch usage: HTTP {status}"),
            };
            return Err(hint);
        }
        Ok(body)
    }

    /// Submit user feedback to the managed platform — node-sdk
    /// `submitFeedback` parity. Resolves with the backend feedback id.
    #[allow(clippy::too_many_arguments)]
    pub async fn submit_feedback(
        &self,
        harness: &Harness,
        session_id: &str,
        content: &str,
        version: &str,
        os: &str,
        model: Option<&str>,
        contact: Option<&str>,
        info: Option<serde_json::Value>,
    ) -> Result<i64, String> {
        let token = self.require_token(harness).await?;
        let url = format!("{}/feedback", kimi_code_base_url());
        let mut body = serde_json::json!({
            "session_id": session_id,
            "content": content,
            "version": version,
            "os": os,
            "model": model,
        });
        if let Some(contact) = contact {
            body["contact"] = serde_json::json!(contact);
        }
        if let Some(info) = info {
            body["info"] = info;
        }
        let response = reqwest::Client::new()
            .post(&url)
            .bearer_auth(&token)
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .json(&body)
            .timeout(std::time::Duration::from_secs(8))
            .send()
            .await
            .map_err(|e| format!("Failed to submit feedback: {e}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("Failed to submit feedback: HTTP {status}"));
        }
        let payload: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to submit feedback: {e}"))?;
        payload
            .get("feedback_id")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| "Failed to submit feedback: missing feedback_id.".to_string())
    }

    /// Request multipart upload URLs for a feedback attachment — node-sdk
    /// `createFeedbackUploadUrl` parity. Resolves with `{ upload_id, parts }`
    /// as raw JSON.
    pub async fn create_feedback_upload_url(
        &self,
        harness: &Harness,
        file_hash: &str,
        file_name: &str,
        file_size: u64,
        feedback_id: i64,
    ) -> Result<serde_json::Value, String> {
        let token = self.require_token(harness).await?;
        let url = format!("{}/feedback/upload_url", kimi_code_base_url());
        let body = serde_json::json!({
            "file_hash": file_hash,
            "file_name": file_name,
            "file_size": file_size,
            "feedback_id": feedback_id,
        });
        self.post_json(&url, &token, body).await
    }

    /// Complete a multipart upload for a feedback attachment — node-sdk
    /// `completeFeedbackUpload` parity. `parts` is the
    /// `[{ part_number, etag }]` array.
    pub async fn complete_feedback_upload(
        &self,
        harness: &Harness,
        upload_id: i64,
        parts: serde_json::Value,
    ) -> Result<(), String> {
        let token = self.require_token(harness).await?;
        let url = format!("{}/feedback/upload_complete", kimi_code_base_url());
        let body = serde_json::json!({ "upload_id": upload_id, "parts": parts });
        self.post_json(&url, &token, body).await?;
        Ok(())
    }

    async fn require_token(&self, harness: &Harness) -> Result<String, String> {
        self.get_cached_access_token(harness, None)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| {
                "No kimi token in config — run /login first.".to_string()
            })
    }

    /// Shared POST-JSON helper for the managed endpoints (Bearer + JSON,
    /// 8s timeout); resolves with the parsed response body.
    async fn post_json(
        &self,
        url: &str,
        token: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let response = reqwest::Client::new()
            .post(url)
            .bearer_auth(token)
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .json(&body)
            .timeout(std::time::Duration::from_secs(8))
            .send()
            .await
            .map_err(|e| format!("{url}: {e}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("{url}: HTTP {status}"));
        }
        response
            .json()
            .await
            .map_err(|e| format!("{url}: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serializes tests that touch `KIMI_CODE_BASE_URL` / `KIMI_CODE_HOME`.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn base_url_normalizes_trailing_slash() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let previous = std::env::var_os("KIMI_CODE_BASE_URL");
        std::env::set_var("KIMI_CODE_BASE_URL", "https://example.com/api/");
        assert_eq!(kimi_code_base_url(), "https://example.com/api");
        match previous {
            Some(value) => std::env::set_var("KIMI_CODE_BASE_URL", value),
            None => std::env::remove_var("KIMI_CODE_BASE_URL"),
        }
    }

    #[test]
    fn base_url_defaults_to_managed_endpoint() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let previous = std::env::var_os("KIMI_CODE_BASE_URL");
        std::env::remove_var("KIMI_CODE_BASE_URL");
        assert_eq!(kimi_code_base_url(), "https://api.kimi.com/coding/v1");
        match previous {
            Some(value) => std::env::set_var("KIMI_CODE_BASE_URL", value),
            None => {}
        }
    }
}
