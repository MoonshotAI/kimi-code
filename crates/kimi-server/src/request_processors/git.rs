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

    #[tokio::test]
    async fn git_status_and_diff_in_real_repo() {
        // Build a throwaway repo: init -> commit -> modify; then the methods
        // must see the dirty file and its diff. Skipped when git is absent.
        let repo = std::env::temp_dir().join(format!("kimi-git-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&repo);
        std::fs::create_dir_all(&repo).expect("mkdir");
        let run_git = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
        };
        if run_git(&["init", "-q"]).unwrap_or(false) == false {
            eprintln!("skipping: git unavailable");
            return;
        }
        std::fs::write(repo.join("a.txt"), "one\n").expect("write");
        let _ = run_git(&["add", "a.txt"]);
        let _ = run_git(&[
            "-c", "user.name=test", "-c", "user.email=test@test",
            "commit", "-q", "-m", "init",
        ]);
        std::fs::write(repo.join("a.txt"), "one\ntwo\n").expect("modify");

        let mut server = MessageProcessor::new();
        GitProcessor.register(&mut server);
        let cwd = repo.to_string_lossy().to_string();

        // git/status surfaces the modified file.
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "git/status".into(),
                params: serde_json::json!({ "cwd": cwd }),
            })
            .await;
        assert!(body.get("error").is_none(), "git/status failed: {body}");
        assert!(
            serde_json::to_string(&body["result"])
                .unwrap_or_default()
                .contains("a.txt"),
            "modified file in status: {body}"
        );

        // git/diff of that path shows the added line.
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(2),
                method: "git/diff".into(),
                params: serde_json::json!({ "cwd": cwd, "path": "a.txt" }),
            })
            .await;
        assert!(body.get("error").is_none(), "git/diff failed: {body}");
        assert!(
            body["result"]["diff"].as_str().unwrap_or("").contains("+two"),
            "diff shows the added line: {body}"
        );

        let _ = std::fs::remove_dir_all(&repo);
    }
}
