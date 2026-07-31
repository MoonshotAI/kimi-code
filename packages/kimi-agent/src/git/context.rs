//! Git context collection — a `<git-context>` block for the system prompt.
//!
//! Port of `agent-core-v2/src/session/sessionFs/gitContext.ts`: probes the
//! repository (remote / branch / dirty files / recent commits) and renders a
//! block an agent can orient itself with. Every probe is best-effort; the
//! block is omitted when nothing useful was collected. The one explicit state
//! surfaced is `status="unavailable" reason="not-a-repo"`.

use std::time::Duration;

use crate::git::service::{CommandOutput, GitService};

const GIT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_DIRTY_FILES: usize = 20;
const MAX_COMMIT_LINE_LENGTH: usize = 200;

/// Hosts whose remote URLs are surfaced to the model; everything else is
/// sanitized away (internal infrastructure must never leak).
const ALLOWED_HOSTS: [&str; 6] = [
    "github.com",
    "gitlab.com",
    "gitee.com",
    "bitbucket.org",
    "codeberg.org",
    "git.sr.ht",
];

/// Sanitize a remote URL: allow `git@host:path` SSH forms and https URLs on
/// the allow-list; anything else returns `None`.
pub fn sanitize_remote_url(remote_url: &str) -> Option<String> {
    for host in ALLOWED_HOSTS {
        if remote_url.starts_with(&format!("git@{host}:")) {
            return Some(remote_url.to_string());
        }
    }
    // Parse `https://host[:port]/path` without the `url` crate: strip the
    // scheme, take the authority up to the first `/`, validate the host.
    let rest = remote_url.strip_prefix("https://")?;
    let authority = rest.split('/').next()?;
    let host = authority.split(':').next()?;
    if !ALLOWED_HOSTS.contains(&host) {
        return None;
    }
    let port = authority
        .rsplit_once(':')
        .filter(|(h, _)| *h == host && !authority.contains('/'))
        .map(|(_, p)| format!(":{p}"))
        .unwrap_or_default();
    let path = rest.splitn(2, '/').nth(1).unwrap_or("");
    Some(format!("https://{host}{port}/{path}"))
}

/// Derive a short project name from a safe remote URL.
pub fn parse_project_name(safe_url: &str) -> Option<String> {
    let path = if safe_url.starts_with("git@") {
        safe_url.rsplit(':').next()?
    } else {
        safe_url.splitn(2, "://").nth(1)?.splitn(2, '/').nth(1).unwrap_or("")
    };
    let trimmed = path.trim_end_matches(".git").trim_end_matches('/');
    let last = trimmed.rsplit('/').next()?;
    if last.is_empty() {
        None
    } else {
        Some(last.to_string())
    }
}

/// Render the `<git-context>` block for a cwd. Best-effort: returns `None`
/// when nothing useful was collected, `Some("<git-context status=\"unavailable\"
/// reason=\"not-a-repo\"/>")` when the cwd is not a git work tree.
pub async fn collect_git_context(cwd: &str) -> Option<String> {
    let service = GitService::new();

    let inside = service.is_work_tree(cwd).await?;
    if !inside {
        return Some(
            "<git-context status=\"unavailable\" reason=\"not-a-repo\"/>".to_string(),
        );
    }

    async fn run(cwd: &str, args: &[&str]) -> Option<CommandOutput> {
        let out = crate::git::service::run_command_public("git", args, cwd, GIT_TIMEOUT)
            .await
            .ok()?;
        out.ok().then_some(out)
    }

    let remote = run(cwd, &["remote", "get-url", "origin"]).await;
    let branch = run(cwd, &["symbolic-ref", "--short", "HEAD"]).await;
    let status = run(cwd, &["status", "--porcelain"]).await;
    let log = run(cwd, &["log", "-3", "--format=%h %s"]).await;

    let mut sections = vec![format!("Working directory: {cwd}")];

    if let Some(ref out) = remote {
        let url = out.stdout.trim();
        if let Some(safe) = sanitize_remote_url(url) {
            sections.push(format!("Remote: {safe}"));
            if let Some(project) = parse_project_name(&safe) {
                sections.push(format!("Project: {project}"));
            }
        }
    }
    if let Some(ref out) = branch {
        let name = out.stdout.trim();
        if !name.is_empty() {
            sections.push(format!("Branch: {name}"));
        }
    }
    if let Some(ref out) = status {
        let dirty: Vec<&str> = out
            .stdout
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();
        if !dirty.is_empty() {
            let total = dirty.len();
            let mut body = String::new();
            for line in dirty.iter().take(MAX_DIRTY_FILES) {
                body.push_str(&format!("  {line}\n"));
            }
            if total > MAX_DIRTY_FILES {
                body.push_str(&format!("  ... and {} more", total - MAX_DIRTY_FILES));
            }
            sections.push(format!("Dirty files ({total}):\n{body}").trim_end().to_string());
        }
    }
    if let Some(ref out) = log {
        let commits: Vec<String> = out
            .stdout
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .map(|l| l.chars().take(MAX_COMMIT_LINE_LENGTH).collect())
            .collect();
        if !commits.is_empty() {
            sections.push(format!("Recent commits:\n{}", commits.join("\n")));
        }
    }

    if sections.len() <= 1 {
        return None;
    }
    Some(format!("<git-context>\n{}\n</git-context>", sections.join("\n")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_github_https() {
        assert_eq!(
            sanitize_remote_url("https://github.com/org/repo.git").as_deref(),
            Some("https://github.com/org/repo.git")
        );
    }

    #[test]
    fn sanitizes_ssh_and_rejects_unknown_hosts() {
        assert_eq!(
            sanitize_remote_url("git@github.com:org/repo.git").as_deref(),
            Some("git@github.com:org/repo.git")
        );
        assert_eq!(sanitize_remote_url("https://evil.example.com/x"), None);
        assert_eq!(sanitize_remote_url("file:///etc/passwd"), None);
        assert_eq!(sanitize_remote_url("not a url"), None);
    }

    #[test]
    fn parses_project_names() {
        assert_eq!(
            parse_project_name("https://github.com/org/repo.git").as_deref(),
            Some("repo")
        );
        assert_eq!(
            parse_project_name("git@github.com:org/repo").as_deref(),
            Some("repo")
        );
        assert_eq!(parse_project_name("https://github.com/org").as_deref(), Some("org"));
    }

    #[tokio::test]
    async fn collects_block_in_repo() {
        // kimi-code repo in dev; assert either a block or the not-a-repo
        // marker — never a panic.
        let ctx = collect_git_context("D:\\kimi\\kimi-code").await;
        if let Some(block) = ctx {
            assert!(
                block.starts_with("<git-context>") || block.contains("not-a-repo"),
                "unexpected block: {block}"
            );
        }
    }
}
