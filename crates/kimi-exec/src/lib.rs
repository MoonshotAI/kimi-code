//! Kimi Code non-interactive execution — the `-p`/print path, ported from
//! `apps/kimi-code/src/cli/run-prompt.ts`. Uses the host protocol client
//! (in-process or remote) and shares the engine exactly like the TUI does;
//! only the output handling differs (plain text / JSONL).

use kimi_server_client::AppServerClient;

/// Run one prompt: create a session, prompt it, return the wire result.
pub async fn run_prompt(
    client: &mut AppServerClient,
    session_id: &str,
    prompt: &str,
) -> serde_json::Value {
    let created = client
        .session_create(session_id)
        .await;
    if created.get("error").is_some() {
        return created;
    }
    client
        .call(
            kimi_protocol::methods::SESSION_PROMPT,
            serde_json::json!({
                "session_id": session_id,
                "input": [{ "type": "text", "text": prompt }],
            }),
        )
        .await
}

/// Run one prompt against a freshly built in-process server (convenience for
/// tests / embedded hosts).
pub async fn run_prompt_in_process(prompt: &str) -> anyhow::Result<serde_json::Value> {
    let server = kimi_server::Server::build()?;
    let mut client = AppServerClient::InProcess(kimi_server::in_process::spawn(server.processor));
    Ok(run_prompt(&mut client, "kimi-exec", prompt).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn run_prompt_creates_then_prompts() {
        let server = kimi_server::Server::build().expect("server");
        let mut client = AppServerClient::InProcess(kimi_server::in_process::spawn(server.processor));
        let result = run_prompt(&mut client, "s-exec", "hello").await;
        // Create succeeded; prompt fails with not-configured LLM (no
        // native_llm) — the pipeline (create -> prompt) is exercised.
        assert!(result.get("error").is_some(), "expected engine error without LLM: {result}");
        let msg = result["error"]["message"].as_str().unwrap_or("");
        assert!(
            msg.contains("run_prompt failed") || msg.contains("LLM"),
            "unexpected error: {msg}"
        );
    }

    #[tokio::test]
    async fn run_prompt_in_process_builds_server() {
        let result = run_prompt_in_process("hi").await.expect("run");
        assert!(result.get("error").is_some(), "no LLM -> engine error expected");
    }
}
