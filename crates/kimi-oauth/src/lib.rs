//! Kimi OAuth — the device flow against the kimi auth server, ported from
//! `kimi-code-oauth` (`requestDeviceAuthorization` / `pollDeviceToken` /
//! `refreshAccessToken`). Form POSTs to `{oauthHost}/api/oauth/*`.

use serde::{Deserialize, Serialize};

/// Endpoints of the kimi OAuth server (defaults from `KIMI_CODE_FLOW_CONFIG`).
#[derive(Debug, Clone)]
pub struct OAuthFlowConfig {
    pub oauth_host: String,
    pub client_id: String,
}

impl OAuthFlowConfig {
    /// The production kimi flow config.
    pub fn kimi() -> Self {
        Self {
            oauth_host: "https://kimi.moonshot.cn".to_string(),
            client_id: "kimicode-cli".to_string(),
        }
    }
}

/// Response of `POST /api/oauth/device_authorization`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceAuthorization {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    #[serde(default)]
    pub verification_uri_complete: Option<String>,
    #[serde(default)]
    pub expires_in: Option<u64>,
    #[serde(default)]
    pub interval: Option<u64>,
}

/// Outcome of one token poll.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum DevicePollResult {
    /// The user has not approved yet.
    Pending,
    /// The token was granted.
    Success {
        access_token: String,
        refresh_token: Option<String>,
        #[serde(default)]
        expires_in: Option<u64>,
    },
    /// The device code expired before approval.
    Expired,
    /// The request was denied.
    Denied,
}

/// Request a device authorization (user opens `verification_uri` and enters
/// `user_code`).
pub async fn request_device_authorization(
    config: &OAuthFlowConfig,
) -> anyhow::Result<DeviceAuthorization> {
    let url = format!("{}/api/oauth/device_authorization", config.oauth_host.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let body = client
        .post(&url)
        .form(&[("client_id", config.client_id.as_str())])
        .send()
        .await?
        .error_for_status()?;
    Ok(body.json().await?)
}

/// Poll the token endpoint; callers retry on `Pending` with the configured
/// (or default 5s) interval.
pub async fn poll_device_token(
    config: &OAuthFlowConfig,
    device_code: &str,
) -> anyhow::Result<DevicePollResult> {
    let url = format!("{}/api/oauth/token", config.oauth_host.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .form(&[
            ("client_id", config.client_id.as_str()),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if status.is_success() {
        let value: serde_json::Value = serde_json::from_str(&text)?;
        if let Some(token) = value.get("access_token").and_then(|v| v.as_str()) {
            return Ok(DevicePollResult::Success {
                access_token: token.to_string(),
                refresh_token: value.get("refresh_token").and_then(|v| v.as_str()).map(String::from),
                expires_in: value.get("expires_in").and_then(|v| v.as_u64()),
            });
        }
        // Non-token success responses (e.g. `authorization_pending`) are
        // treated as pending.
        return Ok(DevicePollResult::Pending);
    }
    match status.as_u16() {
        400 => {
            if text.contains("expired") || text.contains("expired_token") {
                Ok(DevicePollResult::Expired)
            } else if text.contains("denied") || text.contains("access_denied") {
                Ok(DevicePollResult::Denied)
            } else {
                Ok(DevicePollResult::Pending)
            }
        }
        _ => anyhow::bail!("token poll failed: HTTP {status}: {text}"),
    }
}

/// Refresh an access token with a refresh token.
pub async fn refresh_access_token(
    config: &OAuthFlowConfig,
    refresh_token: &str,
) -> anyhow::Result<String> {
    let url = format!("{}/api/oauth/token", config.oauth_host.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let body = client
        .post(&url)
        .form(&[
            ("client_id", config.client_id.as_str()),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await?
        .error_for_status()?;
    let value: serde_json::Value = body.json().await?;
    value
        .get("access_token")
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| anyhow::anyhow!("refresh response missing access_token"))
}

/// A granted token pair from a completed device flow.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceToken {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub expires_in: Option<u64>,
}

/// Run the full device authorization flow: request a device code, surface the
/// verification info via `on_prompt`, then poll until the user approves (or
/// `max_polls` is exhausted). Returns the granted token pair.
pub async fn run_device_flow(
    config: &OAuthFlowConfig,
    max_polls: Option<u32>,
    on_prompt: &mut impl FnMut(&DeviceAuthorization),
) -> anyhow::Result<DeviceToken> {
    let auth = request_device_authorization(config).await?;
    on_prompt(&auth);
    let interval = auth.interval.unwrap_or(5);
    let polls = max_polls.unwrap_or(u32::MAX);
    for _ in 0..polls {
        match poll_device_token(config, &auth.device_code).await? {
            DevicePollResult::Success {
                access_token,
                refresh_token,
                expires_in,
            } => {
                return Ok(DeviceToken {
                    access_token,
                    refresh_token,
                    expires_in,
                });
            }
            DevicePollResult::Pending => {
                tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
            }
            DevicePollResult::Expired => anyhow::bail!("device code expired before approval"),
            DevicePollResult::Denied => anyhow::bail!("authorization denied by the user"),
        }
    }
    anyhow::bail!("device flow timed out after {polls} polls")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Serve one canned response on a local port. The server task is
    /// detached (no await-before-request deadlock on the current-thread test
    /// runtime).
    async fn mock_server(response: &'static str, status: u16) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = socket.read(&mut buf).await.unwrap();
            let resp = format!(
                "HTTP/1.1 {status} OK
Content-Type: application/json
Content-Length: {}
Connection: close

{}",
                response.len(),
                response
            );
            socket.write_all(resp.as_bytes()).await.unwrap();
        });
        format!("http://127.0.0.1:{port}")
    }

    #[tokio::test]
    async fn device_authorization_parses() {
        let json = r#"{"device_code":"dc-1","user_code":"ABCD-EFGH","verification_uri":"https://kimi.moonshot.cn/device","verification_uri_complete":"https://kimi.moonshot.cn/device?code=ABCD-EFGH","expires_in":600,"interval":5}"#;
        let host = mock_server(json, 200).await;
        let config = OAuthFlowConfig { oauth_host: host, client_id: "test-client".into() };
        let auth = request_device_authorization(&config).await.unwrap();
        assert_eq!(auth.device_code, "dc-1");
        assert_eq!(auth.user_code, "ABCD-EFGH");
        assert_eq!(auth.verification_uri, "https://kimi.moonshot.cn/device");
        assert_eq!(auth.expires_in, Some(600));
        assert_eq!(auth.interval, Some(5));
    }

    #[tokio::test]
    async fn token_poll_success_and_pending() {
        let host = mock_server(r#"{"access_token":"tok-1","refresh_token":"ref-1","expires_in":3600}"#, 200).await;
        let config = OAuthFlowConfig { oauth_host: host, client_id: "c".into() };
        match poll_device_token(&config, "dc-1").await.unwrap() {
            DevicePollResult::Success { access_token, refresh_token, .. } => {
                assert_eq!(access_token, "tok-1");
                assert_eq!(refresh_token.as_deref(), Some("ref-1"));
            }
            other => panic!("expected success, got {other:?}"),
        }

        let host = mock_server(r#"{"error":"authorization_pending"}"#, 400).await;
        let config = OAuthFlowConfig { oauth_host: host, client_id: "c".into() };
        match poll_device_token(&config, "dc-1").await.unwrap() {
            DevicePollResult::Pending => {}
            other => panic!("expected pending, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn refresh_exchanges_token() {
        let host = mock_server(r#"{"access_token":"tok-2"}"#, 200).await;
        let config = OAuthFlowConfig { oauth_host: host, client_id: "c".into() };
        let token = refresh_access_token(&config, "ref-1").await.unwrap();
        assert_eq!(token, "tok-2");
    }
}
