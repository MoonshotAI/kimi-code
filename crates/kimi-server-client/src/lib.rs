//! Kimi Code host protocol client — the interface-layer door into a
//! kimi-server. Mirrors codex's `app-server-client`: an `AppServerClient`
//! enum with an in-process variant (bounded channel, same JSON-RPC envelope)
//! and a remote variant (spawn a server process over stdio). Hosts (CLI /
//! TUI / SDK) code against this and cannot tell which path a call took.

use kimi_server::in_process::InProcessClient;

pub mod stdio_client;

/// The client-facing door: in-process or remote stdio.
pub enum AppServerClient {
    /// In-process: a channel into a `MessageProcessor` running here.
    InProcess(InProcessClient),
    /// Remote: a spawned server process speaking line JSON-RPC over stdio.
    Remote(stdio_client::StdioClient),
}

impl AppServerClient {
    /// Make a JSON-RPC call; resolves with the full wire response body.
    pub async fn call(&mut self, method: &str, params: serde_json::Value) -> serde_json::Value {
        match self {
            Self::InProcess(client) => client.call(method, params).await,
            Self::Remote(client) => client.call(method, params).await,
        }
    }

    /// Typed: create a session.
    pub async fn session_create(
        &mut self,
        session_id: &str,
    ) -> serde_json::Value {
        self.call(
            kimi_protocol::methods::SESSION_CREATE,
            serde_json::json!({ "session_id": session_id }),
        )
        .await
    }

    /// Typed: list sessions.
    pub async fn session_list(&mut self, limit: u32) -> serde_json::Value {
        self.call(
            kimi_protocol::methods::SESSION_LIST,
            serde_json::json!({ "limit": limit }),
        )
        .await
    }

    /// Typed: health.
    pub async fn health(&mut self) -> serde_json::Value {
        self.call(kimi_protocol::methods::HEALTH, serde_json::Value::Null)
            .await
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
        let mut client = AppServerClient::InProcess(kimi_server::in_process::spawn(server.processor));
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
        let mut client = AppServerClient::InProcess(kimi_server::in_process::spawn(processor));
        let body = client.health().await;
        assert_eq!(body["result"]["status"], "ok");
    }
}
