//! KimiAuth facade integration tests: the device flow against a local mock
//! OAuth server, plus the config persist/remove round-trip through a real
//! embedded harness (node-sdk `KimiAuthFacade` parity).

use kimi_oauth::OAuthFlowConfig;
use kimi_sdk::{Harness, KimiAuth};

/// A fresh isolated engine home (process-global `KIMI_AGENT_HOME` must be
/// unique per test to avoid cross-test store interference).
fn home(tag: &str) -> std::path::PathBuf {
    let home = std::env::temp_dir().join(format!("kimi-auth-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).expect("mkdir");
    std::env::set_var("KIMI_AGENT_HOME", &home);
    home
}

/// Serve one canned response per connection on a local port, then return the
/// base URL. The server task is detached so the test runtime never waits on
/// it.
fn mock_server(responses: &'static [(&'static str, u16)]) -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for (body, status) in responses {
            let (mut socket, _) = listener.accept().expect("accept");
            let mut buf = [0u8; 4096];
            let _ = socket.read(&mut buf).expect("read");
            let resp = format!(
                "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket.write_all(resp.as_bytes()).expect("write");
        }
    });
    format!("http://127.0.0.1:{port}")
}

use std::io::{Read, Write};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn login_persists_status_sees_it_logout_removes_it() {
    home("flow");
    // Sequence: device_authorization → pending poll → granted token.
    let host = mock_server(&[
        (
            r#"{"device_code":"dc-1","user_code":"ABCD-EFGH","verification_uri":"https://kimi.moonshot.cn/device","verification_uri_complete":"https://kimi.moonshot.cn/device?code=ABCD-EFGH","interval":0,"expires_in":600}"#,
            200,
        ),
        (r#"{"error":"authorization_pending"}"#, 400),
        (
            r#"{"access_token":"tok-1","refresh_token":"ref-1","expires_in":3600}"#,
            200,
        ),
    ]);
    let config = OAuthFlowConfig {
        oauth_host: host,
        client_id: "test-client".into(),
    };
    let auth = KimiAuth::with_flow_config(config);
    let harness = Harness::embedded().expect("embedded");

    // Not logged in initially.
    assert!(!auth.status(&harness).await.expect("status"), "fresh: not logged in");

    // Login drives the device flow and persists providers.kimi.apiKey.
    let mut prompted = false;
    let token = auth
        .login(&harness, Some(20), |authorization| {
            prompted = true;
            assert_eq!(authorization.user_code, "ABCD-EFGH");
        })
        .await
        .expect("login");
    assert!(prompted, "on_prompt called with verification info");
    assert_eq!(token.access_token, "tok-1");
    assert!(auth.status(&harness).await.expect("status after login"), "logged in");

    // Logout null-patches the provider away.
    auth.logout(&harness).await.expect("logout");
    assert!(!auth.status(&harness).await.expect("status after logout"), "logged out");
}
