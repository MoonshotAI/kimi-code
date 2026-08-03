//! Git method family — working-tree status + diff via the engine's
//! `GitService`. No session state; the repo root comes from the request.

use kimi_protocol::rpc::JsonRpcError;
use kimi_protocol::wire_types::{GitDiffParams, GitStatusParams};

use crate::processor::{MessageProcessor, Processor};

/// Git methods.
pub struct GitProcessor;

impl Processor for GitProcessor {
    fn register(&self, processor: &mut MessageProcessor) {
        // `git/status` — working-tree status; `{ unavailable }` in-band on error.
        processor.register(kimi_protocol::methods::GIT_STATUS, move |params| {
            Box::pin(async move {
                let input: GitStatusParams = serde_json::from_value(params)
                    .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let service = kimi_agent::git::GitService::new();
                let cwd = kimi_agent::git::absolutize(&input.cwd);
                match service.status(&cwd, None).await {
                    Ok(status) => serde_json::to_value(status)
                        .map_err(|e| JsonRpcError::internal_error(e.to_string())),
                    Err(e) => Ok(serde_json::json!({ "unavailable": e.to_string() })),
                }
            })
        });

        // `git/diff` — diff of one repo-relative path.
        processor.register(kimi_protocol::methods::GIT_DIFF, move |params| {
            Box::pin(async move {
                let input: GitDiffParams = serde_json::from_value(params)
                    .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let service = kimi_agent::git::GitService::new();
                let cwd = kimi_agent::git::absolutize(&input.cwd);
                match service.diff(&cwd, &input.path).await {
                    Ok((diff, truncated)) => serde_json::to_value(serde_json::json!({
                        "path": input.path,
                        "diff": diff,
                        "truncated": truncated,
                    }))
                    .map_err(|e| JsonRpcError::internal_error(e.to_string())),
                    Err(e) => Ok(serde_json::json!({ "unavailable": e.to_string() })),
                }
            })
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kimi_protocol::rpc::JsonRpcRequest;

    #[tokio::test]
    async fn git_status_invalid_cwd_is_unavailable() {
        let mut server = MessageProcessor::new();
        GitProcessor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "git/status".into(),
                params: serde_json::json!({ "cwd": std::env::temp_dir().to_string_lossy() }),
            })
            .await;
        // Temp dir is not a repo -> in-band unavailable, not an RPC error.
        assert!(body.get("error").is_none(), "git/status should not RPC-error: {body}");
        assert!(body["result"].is_object());
    }
}
