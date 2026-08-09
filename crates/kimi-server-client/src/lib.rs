//! Kimi Code host protocol client — the interface-layer door into a
//! kimi-server. Mirrors codex's `app-server-client`: an `AppServerClient`
//! enum with an in-process variant (bounded channel, same JSON-RPC envelope)
//! and a remote variant (spawn a server process over stdio). Hosts (CLI /
//! TUI / SDK) code against this and cannot tell which path a call took.
//!
//! All methods take `&self`: the in-process variant is a channel and
//! concurrent by design, and the remote variants serialize internally, so a
//! shared client never needs a caller-owned lock — and a long-running call
//! (a prompt turn) cannot block a short control call (`session/cancel`).

use kimi_server::in_process::InProcessClient;

pub mod stdio_client;
pub mod ws_client;

/// The client-facing door: in-process or remote (stdio / websocket).
pub enum AppServerClient {
    /// In-process: a channel into a `MessageProcessor` running here.
    InProcess(InProcessClient),
    /// Remote: a spawned server process speaking line JSON-RPC over stdio.
    /// Boxed: `StdioClient` is large (spawn state + pipes); the enum is
    /// matched by value in hot paths (clippy::large_enum_variant).
    Remote(Box<stdio_client::StdioClient>),
    /// Remote: a WebSocket connection to a `kimi-server-serve --ws` process.
    RemoteWs(Box<ws_client::WsClient>),
}

impl AppServerClient {
    /// Make a JSON-RPC call; resolves with the full wire response body.
    pub async fn call(&self, method: &str, params: serde_json::Value) -> serde_json::Value {
        match self {
            Self::InProcess(client) => client.call(method, params).await,
            Self::Remote(client) => client.call(method, params).await,
            Self::RemoteWs(client) => client.call(method, params).await,
        }
    }

    /// Typed: create a session.
    pub async fn session_create(
        &self,
        session_id: &str,
    ) -> serde_json::Value {
        self.call(
            kimi_protocol::methods::SESSION_CREATE,
            serde_json::json!({ "session_id": session_id }),
        )
        .await
    }

    /// Typed: list sessions.
    pub async fn session_list(&self, limit: u32) -> serde_json::Value {
        self.call(
            kimi_protocol::methods::SESSION_LIST,
            serde_json::json!({ "limit": limit }),
        )
        .await
    }

    /// Typed: health.
    pub async fn health(&self) -> serde_json::Value {
        self.call(kimi_protocol::methods::HEALTH, serde_json::Value::Null)
            .await
    }

    /// Typed: run one prompt on a session.
    pub async fn session_prompt(
        &self,
        session_id: &str,
        text: &str,
    ) -> serde_json::Value {
        self.call(
            kimi_protocol::methods::SESSION_PROMPT,
            serde_json::json!({
                "session_id": session_id,
                "input": [{ "type": "text", "text": text }],
            }),
        )
        .await
    }

    /// Typed: the session's current context (history + token count).
    pub async fn session_get_context(&self, session_id: &str) -> serde_json::Value {
        self.call(
            kimi_protocol::methods::SESSION_GET_CONTEXT,
            serde_json::json!({ "session_id": session_id }),
        )
        .await
    }

    /// Typed: the engine's parsed config.
    pub async fn config_get(&self) -> serde_json::Value {
        self.call(kimi_protocol::methods::CONFIG_GET, serde_json::Value::Null)
            .await
    }

    /// Typed: a session's status snapshot.
    pub async fn session_get_status(&self, session_id: &str) -> serde_json::Value {
        self.call(
            kimi_protocol::methods::SESSION_GET_STATUS,
            serde_json::json!({ "session_id": session_id }),
        )
        .await
    }

    /// Typed: request cancellation of a running turn.
    pub async fn session_cancel(&self, session_id: &str) -> serde_json::Value {
        self.call(
            kimi_protocol::methods::SESSION_CANCEL,
            serde_json::json!({ "session_id": session_id }),
        )
        .await
    }

    /// Typed: run a shell command in the session workspace.
    pub async fn session_run_shell(&self, session_id: &str, command: &str) -> serde_json::Value {
        self.call(
            kimi_protocol::methods::SESSION_RUN_SHELL,
            serde_json::json!({ "session_id": session_id, "command": command }),
        )
        .await
    }

    /// Typed: pending approvals for a session scope (all when `None`).
    pub async fn approval_list(&self, session_id: Option<&str>) -> serde_json::Value {
        let params = match session_id {
            Some(id) => serde_json::json!({ "session_id": id }),
            None => serde_json::Value::Null,
        };
        self.call(kimi_protocol::methods::SESSION_APPROVAL_LIST, params).await
    }

    /// Typed: resolve a pending approval (`allow` or `deny` with a reason).
    pub async fn approval_resolve(
        &self,
        id: &str,
        allow: bool,
        reason: Option<&str>,
    ) -> serde_json::Value {
        let params = if allow {
            serde_json::json!({ "id": id, "decision": "allow" })
        } else {
            serde_json::json!({ "id": id, "decision": "deny", "reason": reason })
        };
        self.call(kimi_protocol::methods::SESSION_APPROVAL_RESOLVE, params).await
    }

    /// Typed: cancel a tracked task (task-domain stop).
    pub async fn task_cancel(&self, task_id: &str, reason: Option<&str>) -> serde_json::Value {
        let mut params = serde_json::json!({ "task_id": task_id });
        if let Some(reason) = reason {
            params["reason"] = serde_json::json!(reason);
        }
        self.call(kimi_protocol::methods::TASK_CANCEL, params).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kimi_server::processor::Processor;
    use kimi_server::request_processors::HealthProcessor;
    use kimi_server::Server;

    #[tokio::test]
    async fn in_process_client_round_trip() {
        let server = Server::build().expect("server");
        let client = AppServerClient::InProcess(kimi_server::in_process::spawn(server.processor));
        let body = client.health().await;
        assert_eq!(body["result"]["status"], "ok");

        let body = client.session_create("s-client").await;
        assert_eq!(body["result"]["session_id"], "s-client");

        let body = client.session_list(10).await;
        let sessions = body["result"]["sessions"].as_array().expect("sessions");
        assert!(sessions.iter().any(|s| s["id"] == "s-client"));
    }

    #[tokio::test]
    async fn stateless_processor_via_client() {
        let mut processor = kimi_server::MessageProcessor::new();
        HealthProcessor.register(&mut processor);
        let client = AppServerClient::InProcess(kimi_server::in_process::spawn(processor));
        let body = client.health().await;
        assert_eq!(body["result"]["status"], "ok");
    }

    #[tokio::test]
    async fn typed_methods_round_trip() {
        // config_get parses the merged engine config, which reads the
        // user-level `$KIMI_CODE_HOME/config.toml` — isolate from the real
        // user config so a broken/duplicate-key file cannot fail this test.
        // (Same-process sibling tests never read the config, so restoring the
        // var is unnecessary — the test binary exits with it.)
        let home = std::env::temp_dir().join(format!("kimi-server-client-{}", std::process::id()));
        std::fs::create_dir_all(&home).expect("create test home");
        std::env::set_var("KIMI_CODE_HOME", &home);

        let server = Server::build().expect("server");
        let client = AppServerClient::InProcess(kimi_server::in_process::spawn(server.processor));

        // config_get parses the merged engine config.
        let body = client.config_get().await;
        assert!(body.get("error").is_none(), "config_get: {body}");

        // Create, then status/context typed reads work.
        let body = client.session_create("s-typed").await;
        assert_eq!(body["result"]["session_id"], "s-typed");
        let body = client.session_get_status("s-typed").await;
        assert!(body.get("error").is_none(), "get_status: {body}");

        // Context is readable right after create.
        let body = client.session_get_context("s-typed").await;
        assert!(body.get("error").is_none(), "get_context: {body}");
        assert!(body["result"]["history"].is_array());
    }

    #[tokio::test]
    async fn typed_control_methods_round_trip() {
        let server = Server::build().expect("server");
        let client = AppServerClient::InProcess(kimi_server::in_process::spawn(server.processor));
        let body = client.session_create("s-ctrl").await;
        assert_eq!(body["result"]["session_id"], "s-ctrl");

        // Cancel of a created (idle) session sets its flag and reports true —
        // the flag is registered at session/create (unknown sessions -> false).
        let body = client.session_cancel("s-ctrl").await;
        assert!(body.get("error").is_none(), "cancel: {body}");
        assert_eq!(body["result"]["cancelled"], true);
        let body = client.session_cancel("does-not-exist").await;
        assert_eq!(body["result"]["cancelled"], false);

        // run_shell reaches the bash runner even without a turn.
        let body = client.session_run_shell("s-ctrl", "echo kimi-client-test").await;
        assert!(body.get("error").is_none(), "run_shell: {body}");

        // Approval surface: empty list; unknown resolve -> false.
        let body = client.approval_list(Some("s-ctrl")).await;
        assert!(body.get("error").is_none(), "approval_list: {body}");
        assert_eq!(body["result"]["pending"], serde_json::json!([]));
        let body = client.approval_resolve("nope", true, None).await;
        assert!(body.get("error").is_none(), "approval_resolve: {body}");
        assert_eq!(body["result"]["resolved"], false);
    }
}
