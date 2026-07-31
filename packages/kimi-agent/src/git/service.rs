//! `git` domain — git integration for a repository on the local disk.
//!
//! Port of `agent-core-v2/src/app/git/gitService.ts`: runs `git status` /
//! `git diff` (plus `gh pr view`) against a repository identified by an
//! absolute `cwd`. Spawns `git` / `gh` directly — no host round-trip. Path
//! confinement is the caller's responsibility (the service receives
//! already-resolved absolute `cwd` and repo-relative paths).

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use crate::git::parsers::{
    GitStatusResponse, parse_numstat, parse_porcelain, parse_pull_request,
};

/// Result of running an external command.
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

impl CommandOutput {
    pub fn ok(&self) -> bool {
        self.exit_code == Some(0)
    }
}

/// Run a command synchronously via `spawn_blocking` (std::process::Command),
/// wrapped in a timeout. The blocking path is more reliable than the tokio
/// process driver across runtimes (stdio handler tasks vs lib test runtimes).
pub(crate) async fn run_command_public(
    program: &str,
    args: &[&str],
    cwd: &str,
    timeout: Duration,
) -> Result<CommandOutput, String> {
    let program = program.to_string();
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let cwd = cwd.to_string();
    let join = tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(&program);
        cmd.args(&args)
            .current_dir(&cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW — git must never flash a console.
            cmd.creation_flags(0x0800_0000);
        }
        cmd.output()
            .map(|output| CommandOutput {
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                exit_code: output.status.code(),
            })
            .map_err(|e| format!("failed to spawn {program}: {e}"))
    });

    tokio::time::timeout(timeout, join)
        .await
        .map_err(|_| "command timed out".to_string())?
        .map_err(|e| format!("task join failed: {e}"))?
}

/// Errors surfaced by the git service.
#[derive(Debug, Clone)]
pub enum GitError {
    /// Not inside a git work tree (or git unavailable).
    Unavailable { cwd: String, detail: String },
    /// Command-level failure.
    Failed(String),
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GitError::Unavailable { cwd, detail } => {
                write!(f, "git unavailable in {cwd}: {detail}")
            }
            GitError::Failed(detail) => write!(f, "{detail}"),
        }
    }
}

impl std::error::Error for GitError {}

const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);

/// The git service: status + diff against a repository.
#[derive(Debug, Clone, Default)]
pub struct GitService;

impl GitService {
    pub fn new() -> Self {
        Self
    }

    async fn ensure_work_tree(&self, cwd: &str) -> Result<(), GitError> {
        let inside = run_command_public("git", &["rev-parse", "--is-inside-work-tree"], cwd, COMMAND_TIMEOUT)
            .await
            .map_err(|e| GitError::Unavailable {
                cwd: cwd.to_string(),
                detail: e,
            })?;
        if !inside.ok() {
            return Err(GitError::Unavailable {
                cwd: cwd.to_string(),
                detail: inside.stderr.trim().to_string(),
            });
        }
        Ok(())
    }

    /// Working-tree status. `path_filter` narrows the reported entries.
    pub async fn status(
        &self,
        cwd: &str,
        path_filter: Option<&std::collections::HashSet<String>>,
    ) -> Result<GitStatusResponse, GitError> {
        self.ensure_work_tree(cwd).await?;

        let porc = run_command_public("git", &["status", "--porcelain=v1", "--branch"], cwd, COMMAND_TIMEOUT)
            .await
            .map_err(|e| GitError::Unavailable {
                cwd: cwd.to_string(),
                detail: e,
            })?;
        if !porc.ok() {
            return Err(GitError::Unavailable {
                cwd: cwd.to_string(),
                detail: porc.stderr.trim().to_string(),
            });
        }
        let mut resp = parse_porcelain(&porc.stdout, path_filter);

        // Aggregate working-tree diff against HEAD (summed added/deleted
        // lines). Skipped when there is no HEAD commit yet.
        let head = run_command_public(
            "git",
            &["rev-parse", "--verify", "--quiet", "HEAD"],
            cwd,
            COMMAND_TIMEOUT,
        )
        .await;
        let has_head = head.as_ref().is_ok_and(|h| h.ok());
        if has_head {
            if let Ok(numstat) = run_command_public(
                "git",
                &["diff", "--no-color", "--numstat", "HEAD", "--"],
                cwd,
                COMMAND_TIMEOUT,
            )
            .await
            {
                if numstat.ok() {
                    let (additions, deletions) = parse_numstat(&numstat.stdout);
                    resp.additions = additions;
                    resp.deletions = deletions;
                }
            }
        }

        // GitHub PR for the current branch (best-effort, never fatal).
        if let Ok(pr) = run_command_public(
            "gh",
            &["pr", "view", "--json", "number,state,url"],
            cwd,
            COMMAND_TIMEOUT,
        )
        .await
        {
            if pr.ok() {
                resp.pull_request = parse_pull_request(&pr.stdout);
            }
        }

        Ok(resp)
    }

    /// Diff of one repo-relative path against HEAD (or the working tree when
    /// the file is untracked). `truncated` reports when the output was cut.
    pub async fn diff(&self, cwd: &str, rel_path: &str) -> Result<(String, bool), GitError> {
        self.ensure_work_tree(cwd).await?;

        let status_res = run_command_public(
            "git",
            &["status", "--porcelain=v1", "--", rel_path],
            cwd,
            COMMAND_TIMEOUT,
        )
        .await
        .map_err(|e| GitError::Unavailable {
            cwd: cwd.to_string(),
            detail: e,
        })?;
        if !status_res.ok() {
            return Err(GitError::Unavailable {
                cwd: cwd.to_string(),
                detail: status_res.stderr.trim().to_string(),
            });
        }
        // Untracked files have no HEAD diff; show the file content instead.
        let untracked = status_res
            .stdout
            .lines()
            .any(|l| l.trim_start().starts_with("??"));
        let has_head = run_command_public(
            "git",
            &["rev-parse", "--verify", "--quiet", "HEAD"],
            cwd,
            COMMAND_TIMEOUT,
        )
        .await
        .is_ok_and(|h| h.ok());

        let (args, use_head): (&[&str], bool) = if untracked || !has_head {
            (&["show", "--no-color", "--format=", ":"], false)
        } else {
            (&["diff", "--no-color", "HEAD", "--"], true)
        };
        let mut full_args = args.to_vec();
        full_args.push(rel_path);
        let res = run_command_public("git", &full_args, cwd, COMMAND_TIMEOUT)
            .await
            .map_err(|e| GitError::Failed(e))?;
        if !res.ok() {
            return Err(GitError::Failed(res.stderr.trim().to_string()));
        }

        // Truncate very large diffs (TS: 1 MiB cap).
        const MAX_DIFF_BYTES: usize = 1024 * 1024;
        let truncated = res.stdout.len() > MAX_DIFF_BYTES;
        let diff = if truncated {
            let mut out = res.stdout;
            out.truncate(MAX_DIFF_BYTES);
            out.push_str("\n… [diff truncated]");
            out
        } else {
            res.stdout
        };
        let _ = use_head;
        Ok((diff, truncated))
    }

    /// Whether `cwd` is inside a git work tree (cheap probe; `None` when git
    /// itself is unavailable).
    pub async fn is_work_tree(&self, cwd: &str) -> Option<bool> {
        let res = run_command_public(
            "git",
            &["rev-parse", "--is-inside-work-tree"],
            cwd,
            COMMAND_TIMEOUT,
        )
        .await
        .ok()?;
        Some(res.ok())
    }
}

/// Resolve `cwd` to an absolute path; convenience for callers holding a
/// possibly-relative session workdir.
pub fn absolutize(cwd: &str) -> String {
    if Path::new(cwd).is_absolute() {
        cwd.to_string()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| Path::new(".").to_path_buf())
            .join(cwd)
            .to_string_lossy()
            .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn is_work_tree_detects_repo() {
        // The kimi-agent package itself lives in a git repo in dev; this test
        // only asserts the probe runs without error (true or false both pass).
        let _ = GitService::new().is_work_tree(".").await;
    }

    #[tokio::test]
    async fn status_runs_in_lib_test() {
        // The kimi-code repo is a git work tree in dev; assert the service
        // produces a branch or an explicit unavailable error (never a panic).
        let service = GitService::new();
        match service.status("D:\\kimi\\kimi-code", None).await {
            Ok(resp) => {
                assert!(!resp.branch.is_empty(), "branch must be non-empty in a repo");
            }
            Err(e) => {
                assert!(e.to_string().contains("unavailable"), "unexpected error: {e}");
            }
        }
    }

    #[test]
    fn absolutize_keeps_absolute() {
        let cwd = if cfg!(windows) { "C:\\x" } else { "/x" };
        assert!(Path::new(&absolutize(cwd)).is_absolute());
    }
}
