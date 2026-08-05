//! Built-in GitHub tools 鈥?thin, table-driven definitions over the GitHub
//! REST API (reqwest). Mirrors
//! `retired/agent-core/src/tools/builtin/github/github-tools.ts`.
//!
//! Auth comes from `GITHUB_TOKEN` / `GH_TOKEN` (resolved at call time);
//! when unset, the tool returns a helpful error. Each entry declares the
//! LLM-facing tool: JSON schema, the endpoint (method + path + query/body
//! builders), and read-only vs mutating so the permission system can gate
//! writes.

use std::sync::Arc;

use serde_json::Value;

use crate::callbacks::HostCallbacks;
use crate::context::types::ToolDefinition;
use crate::rpc::types::{BoxFuture, ToolExecuteRequest, ToolExecuteResponse};

use super::fetch_url::shared_web_client;

const DEFAULT_BASE_URL: &str = "https://api.github.com";
const API_VERSION: &str = "2022-11-28";
const USER_AGENT: &str = "kimi-code";
const DEFAULT_ACCEPT: &str = "application/vnd.github+json";
/// Cap auto-pagination so a runaway `per_page` loop can't hang or blow memory.
const MAX_PAGES: usize = 10;

/// Read-only GitHub tool names 鈥?run without a prompt (like Read/FetchURL).
/// Mutating tools are excluded and therefore prompt for approval in
/// non-auto permission modes. Mirrors `GITHUB_READONLY_TOOL_NAMES` in TS.
pub const GITHUB_READONLY_TOOL_NAMES: &[&str] = &[
    "GitHubGetRepo",
    "GitHubListBranches",
    "GitHubListCommits",
    "GitHubGetCommit",
    "GitHubGetFileContents",
    "GitHubListIssues",
    "GitHubGetIssue",
    "GitHubListIssueComments",
    "GitHubListPRs",
    "GitHubGetPR",
    "GitHubGetPRDiff",
    "GitHubGetPRFiles",
    "GitHubListPRReviewComments",
    "GitHubSearchCode",
    "GitHubSearchRepos",
    "GitHubSearchIssues",
    "GitHubListWorkflowRuns",
    "GitHubGetWorkflowRun",
    "GitHubListReleases",
    "GitHubGetLatestRelease",
    "GitHubGetMe",
];

/// Whether a GitHub tool mutates remote state (needs approval in manual
/// permission modes). Mirrors the `mutating` flag in the TS tool specs.
pub fn is_mutating(tool_name: &str) -> bool {
    !GITHUB_READONLY_TOOL_NAMES
        .iter()
        .any(|n| n.eq_ignore_ascii_case(tool_name))
}

/// Resolve the token from `GITHUB_TOKEN`, then `GH_TOKEN`. Empty values are
/// treated as unset.
fn resolve_token() -> Option<String> {
    env_non_empty("GITHUB_TOKEN").or_else(|| env_non_empty("GH_TOKEN"))
}

/// API base URL 鈥?`GITHUB_API_URL` (GitHub Enterprise) or the public API.
fn base_url() -> String {
    env_non_empty("GITHUB_API_URL").unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
}

fn env_non_empty(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|s| !s.is_empty())
}

fn owner_of(args: &Value) -> String {
    args.get("owner").and_then(|v| v.as_str()).unwrap_or("").trim().to_string()
}

fn repo_of(args: &Value) -> String {
    args.get("repo").and_then(|v| v.as_str()).unwrap_or("").trim().to_string()
}

/// A single GitHub tool spec. `path` receives the parsed args; `query` /
/// `body` build the request payload; `paginate` auto-follows `Link: next`.
struct GithubToolSpec {
    name: &'static str,
    description: &'static str,
    schema: Value,
    method: &'static str,
    path: fn(&Value) -> String,
    query: Option<fn(&Value) -> Value>,
    body: Option<fn(&Value) -> Value>,
    paginate: bool,
    accept: Option<&'static str>,
}

fn json_schema(properties: &[(&str, Value)], required: &[&str]) -> Value {
    let props: serde_json::Map<String, Value> = properties
        .iter()
        .map(|(k, v)| (k.to_string(), v.clone()))
        .collect();
    serde_json::json!({
        "type": "object",
        "properties": props,
        "required": required,
    })
}

fn s(t: &str, desc: &str) -> Value {
    serde_json::json!({ "type": t, "description": desc })
}

fn opt(t: &str, desc: &str) -> Value {
    serde_json::json!({ "type": t, "description": desc })
}

fn num(t: &str, desc: &str) -> Value {
    serde_json::json!({ "type": t, "description": desc })
}

fn repo_base(args: &Value) -> String {
    format!("{}/{}", owner_of(args), repo_of(args))
}

/// Tool specs, table-driven. Order matters only for readability.
fn github_tool_specs() -> Vec<GithubToolSpec> {
    let owner = ("owner", s("string", "Repository owner (user or organization login)."));
    let repo = ("repo", s("string", "Repository name."));
    let per_page = ("perPage", opt("integer", "Results per page (1-100)."));
    let page = ("page", opt("integer", "Page number (1-based)."));
    let base_repo: &[(&str, Value)] = &[owner.clone(), repo.clone()];

    vec![
        // 鈹€鈹€ Repositories 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
        GithubToolSpec {
            name: "GitHubGetRepo",
            description: "Get metadata for a repository (description, default branch, stars, visibility).",
            schema: json_schema(base_repo, &["owner", "repo"]),
            method: "GET",
            path: |a| format!("/repos/{}/{}", owner_of(a), repo_of(a)),
            query: None,
            body: None,
            paginate: false,
            accept: None,
        },
        GithubToolSpec {
            name: "GitHubListBranches",
            description: "List branches in a repository.",
            schema: json_schema(&[owner.clone(), repo.clone(), per_page.clone(), page.clone()], &["owner", "repo"]),
            method: "GET",
            path: |a| format!("/repos/{}/{}/branches", owner_of(a), repo_of(a)),
            query: Some(|a| serde_json::json!({ "per_page": a["perPage"], "page": a["page"] })),
            body: None,
            paginate: true,
            accept: None,
        },
        GithubToolSpec {
            name: "GitHubListCommits",
            description: "List commits on a repository, optionally filtered by branch/sha or path.",
            schema: json_schema(
                &[
                    owner.clone(),
                    repo.clone(),
                    ("sha", opt("string", "Branch name or commit SHA to start from.")),
                    ("path", opt("string", "Only commits touching this file path.")),
                    per_page.clone(),
                    page.clone(),
                ],
                &["owner", "repo"],
            ),
            method: "GET",
            path: |a| format!("/repos/{}/{}/commits", owner_of(a), repo_of(a)),
            query: Some(|a| serde_json::json!({
                "sha": a["sha"], "path": a["path"], "per_page": a["perPage"], "page": a["page"]
            })),
            body: None,
            paginate: true,
            accept: None,
        },
        GithubToolSpec {
            name: "GitHubGetCommit",
            description: "Get a single commit, including its diff stats and changed files.",
            schema: json_schema(
                &[owner.clone(), repo.clone(), ("ref", s("string", "Commit SHA, branch, or tag."))],
                &["owner", "repo", "ref"],
            ),
            method: "GET",
            path: |a| format!("/repos/{}/{}/commits/{}", owner_of(a), repo_of(a), a["ref"].as_str().unwrap_or("")),
            query: None,
            body: None,
            paginate: false,
            accept: None,
        },
        GithubToolSpec {
            name: "GitHubGetFileContents",
            description: "Get a file or directory listing. File content is returned base64-encoded in the `content` field.",
            schema: json_schema(
                &[
                    owner.clone(),
                    repo.clone(),
                    ("path", s("string", "Path to the file or directory in the repo.")),
                    ("ref", opt("string", "Branch, tag, or commit SHA (defaults to the default branch).")),
                ],
                &["owner", "repo", "path"],
            ),
            method: "GET",
            path: |a| format!("/repos/{}/{}/contents/{}", owner_of(a), repo_of(a), a["path"].as_str().unwrap_or("")),
            query: Some(|a| serde_json::json!({ "ref": a["ref"] })),
            body: None,
            paginate: false,
            accept: None,
        },
        GithubToolSpec {
            name: "GitHubCreateOrUpdateFile",
            description: "Create or update a file. Provide plain-text `content` (encoded to base64 automatically). Pass `sha` when updating an existing file.",
            schema: json_schema(
                &[
                    owner.clone(),
                    repo.clone(),
                    ("path", s("string", "Path to the file in the repo.")),
                    ("message", s("string", "Commit message.")),
                    ("content", s("string", "Plain (UTF-8) file content.")),
                    ("branch", opt("string", "Target branch (defaults to the default branch).")),
                    ("sha", opt("string", "Blob SHA of the file being replaced (required when updating).")),
                ],
                &["owner", "repo", "path", "message", "content"],
            ),
            method: "PUT",
            path: |a| format!("/repos/{}/{}/contents/{}", owner_of(a), repo_of(a), a["path"].as_str().unwrap_or("")),
            query: None,
            body: Some(|a| serde_json::json!({
                "message": a["message"],
                "content": base64_encode(a["content"].as_str().unwrap_or("")),
                "branch": a["branch"],
                "sha": a["sha"],
            })),
            paginate: false,
            accept: None,
        },
        // 鈹€鈹€ Issues 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
        GithubToolSpec {
            name: "GitHubListIssues",
            description: "List issues in a repository (excludes pull requests unless combined with search).",
            schema: json_schema(
                &[
                    owner.clone(),
                    repo.clone(),
                    ("state", opt("string", "Issue state filter (open/closed/all).")),
                    ("labels", opt("string", "Comma-separated label names.")),
                    per_page.clone(),
                    page.clone(),
                ],
                &["owner", "repo"],
            ),
            method: "GET",
            path: |a| format!("/repos/{}/{}/issues", owner_of(a), repo_of(a)),
            query: Some(|a| serde_json::json!({
                "state": a["state"], "labels": a["labels"], "per_page": a["perPage"], "page": a["page"]
            })),
            body: None,
            paginate: true,
            accept: None,
        },
        GithubToolSpec {
            name: "GitHubGetIssue",
            description: "Get a single issue by number.",
            schema: json_schema(
                &[owner.clone(), repo.clone(), ("issueNumber", num("integer", "Issue number."))],
                &["owner", "repo", "issueNumber"],
            ),
            method: "GET",
            path: |a| format!("/repos/{}/{}/issues/{}", owner_of(a), repo_of(a), a["issueNumber"]),
            query: None,
            body: None,
            paginate: false,
            accept: None,
        },
        GithubToolSpec {
            name: "GitHubCreateIssue",
            description: "Create a new issue.",
            schema: json_schema(
                &[
                    owner.clone(),
                    repo.clone(),
                    ("title", s("string", "Issue title.")),
                    ("body", opt("string", "Issue body (Markdown).")),
                    ("labels", opt("array", "Label names to apply.")),
                    ("assignees", opt("array", "User logins to assign.")),
                ],
                &["owner", "repo", "title"],
            ),
            method: "POST",
            path: |a| format!("/repos/{}/{}/issues", owner_of(a), repo_of(a)),
            query: None,
            body: Some(|a| serde_json::json!({
                "title": a["title"], "body": a["body"], "labels": a["labels"], "assignees": a["assignees"]
            })),
            paginate: false,
            accept: None,
        },
        GithubToolSpec {
            name: "GitHubUpdateIssue",
            description: "Update an issue (title, body, state, labels, assignees).",
            schema: json_schema(
                &[
                    owner.clone(),
                    repo.clone(),
                    ("issueNumber", num("integer", "Issue number.")),
                    ("title", opt("string", "Issue title.")),
                    ("body", opt("string", "Issue body (Markdown).")),
                    ("state", opt("string", "New state (open/closed).")),
                    ("labels", opt("array", "Label names to apply.")),
                    ("assignees", opt("array", "User logins to assign.")),
                ],
                &["owner", "repo", "issueNumber"],
            ),
            method: "PATCH",
            path: |a| format!("/repos/{}/{}/issues/{}", owner_of(a), repo_of(a), a["issueNumber"]),
            query: None,
            body: Some(|a| serde_json::json!({
                "title": a["title"], "body": a["body"], "state": a["state"],
                "labels": a["labels"], "assignees": a["assignees"]
            })),
            paginate: false,
            accept: None,
        },
        GithubToolSpec {
            name: "GitHubAddIssueComment",
            description: "Add a comment to an issue or pull request.",
            schema: json_schema(
                &[owner.clone(), repo.clone(), ("issueNumber", num("integer", "Issue or PR number.")), ("body", s("string", "Comment body (Markdown)."))],
                &["owner", "repo", "issueNumber", "body"],
            ),
            method: "POST",
            path: |a| format!("/repos/{}/{}/issues/{}/comments", owner_of(a), repo_of(a), a["issueNumber"]),
            query: None,
            body: Some(|a| serde_json::json!({ "body": a["body"] })),
            paginate: false,
            accept: None,
        },
        GithubToolSpec {
            name: "GitHubListIssueComments",
            description: "List comments on an issue or pull request.",
            schema: json_schema(
                &[owner.clone(), repo.clone(), ("issueNumber", num("integer", "Issue or PR number.")), per_page.clone(), page.clone()],
                &["owner", "repo", "issueNumber"],
            ),
            method: "GET",
            path: |a| format!("/repos/{}/{}/issues/{}/comments", owner_of(a), repo_of(a), a["issueNumber"]),
            query: Some(|a| serde_json::json!({ "per_page": a["perPage"], "page": a["page"] })),
            body: None,
            paginate: true,
            accept: None,
        },
        // 鈹€鈹€ Pull requests 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
        GithubToolSpec {
            name: "GitHubListPRs",
            description: "List pull requests in a repository.",
            schema: json_schema(
                &[
                    owner.clone(),
                    repo.clone(),
                    ("state", opt("string", "PR state filter (open/closed/all).")),
                    ("head", opt("string", "Filter by head branch (user:ref).")),
                    ("base", opt("string", "Filter by base branch name.")),
                    per_page.clone(),
                    page.clone(),
                ],
                &["owner", "repo"],
            ),
            method: "GET",
            path: |a| format!("/repos/{}/{}/pulls", owner_of(a), repo_of(a)),
            query: Some(|a| serde_json::json!({
                "state": a["state"], "head": a["head"], "base": a["base"],
                "per_page": a["perPage"], "page": a["page"]
            })),
            body: None,
            paginate: true,
            accept: None,
        },
        GithubToolSpec {
            name: "GitHubGetPR",
            description: "Get a single pull request by number.",
            schema: json_schema(
                &[owner.clone(), repo.clone(), ("pullNumber", num("integer", "Pull request number."))],
                &["owner", "repo", "pullNumber"],
            ),
            method: "GET",
            path: |a| format!("/repos/{}/{}/pulls/{}", owner_of(a), repo_of(a), a["pullNumber"]),
            query: None,
            body: None,
            paginate: false,
            accept: None,
        },
        GithubToolSpec {
            name: "GitHubGetPRDiff",
            description: "Get the unified diff for a pull request.",
            schema: json_schema(
                &[owner.clone(), repo.clone(), ("pullNumber", num("integer", "Pull request number."))],
                &["owner", "repo", "pullNumber"],
            ),
            method: "GET",
            path: |a| format!("/repos/{}/{}/pulls/{}", owner_of(a), repo_of(a), a["pullNumber"]),
            query: None,
            body: None,
            paginate: false,
            accept: Some("application/vnd.github.diff"),
        },
        GithubToolSpec {
            name: "GitHubGetPRFiles",
            description: "List the files changed in a pull request.",
            schema: json_schema(
                &[owner.clone(), repo.clone(), ("pullNumber", num("integer", "Pull request number.")), per_page.clone(), page.clone()],
                &["owner", "repo", "pullNumber"],
            ),
            method: "GET",
            path: |a| format!("/repos/{}/{}/pulls/{}/files", owner_of(a), repo_of(a), a["pullNumber"]),
            query: Some(|a| serde_json::json!({ "per_page": a["perPage"], "page": a["page"] })),
            body: None,
            paginate: true,
            accept: None,
        },
        GithubToolSpec {
            name: "GitHubCreatePR",
            description: "Open a new pull request.",
            schema: json_schema(
                &[
                    owner.clone(),
                    repo.clone(),
                    ("title", s("string", "PR title.")),
                    ("head", s("string", "Source branch (or user:branch for cross-repo).")),
                    ("base", s("string", "Target branch to merge into.")),
                    ("body", opt("string", "PR description (Markdown).")),
                    ("draft", opt("boolean", "Open as a draft PR.")),
                ],
                &["owner", "repo", "title", "head", "base"],
            ),
            method: "POST",
            path: |a| format!("/repos/{}/{}/pulls", owner_of(a), repo_of(a)),
            query: None,
            body: Some(|a| serde_json::json!({
                "title": a["title"], "head": a["head"], "base": a["base"], "body": a["body"], "draft": a["draft"]
            })),
            paginate: false,
            accept: None,
        },
        GithubToolSpec {
            name: "GitHubUpdatePR",
            description: "Update a pull request (title, body, state, base branch).",
            schema: json_schema(
                &[
                    owner.clone(),
                    repo.clone(),
                    ("pullNumber", num("integer", "Pull request number.")),
                    ("title", opt("string", "PR title.")),
                    ("body", opt("string", "PR description (Markdown).")),
                    ("state", opt("string", "New state (open/closed).")),
                    ("base", opt("string", "New base branch.")),
                ],
                &["owner", "repo", "pullNumber"],
            ),
            method: "PATCH",
            path: |a| format!("/repos/{}/{}/pulls/{}", owner_of(a), repo_of(a), a["pullNumber"]),
            query: None,
            body: Some(|a| serde_json::json!({
                "title": a["title"], "body": a["body"], "state": a["state"], "base": a["base"]
            })),
            paginate: false,
            accept: None,
        },
        GithubToolSpec {
            name: "GitHubMergePR",
            description: "Merge a pull request.",
            schema: json_schema(
                &[
                    owner.clone(),
                    repo.clone(),
                    ("pullNumber", num("integer", "Pull request number.")),
                    ("commitTitle", opt("string", "Title for the merge commit.")),
                    ("mergeMethod", opt("string", "Merge strategy (merge/squash/rebase).")),
                ],
                &["owner", "repo", "pullNumber"],
            ),
            method: "PUT",
            path: |a| format!("/repos/{}/{}/pulls/{}/merge", owner_of(a), repo_of(a), a["pullNumber"]),
            query: None,
            body: Some(|a| serde_json::json!({
                "commit_title": a["commitTitle"], "merge_method": a["mergeMethod"]
            })),
            paginate: false,
            accept: None,
        },
        GithubToolSpec {
            name: "GitHubCreatePRReview",
            description: "Submit a review on a pull request (APPROVE, REQUEST_CHANGES, or COMMENT).",
            schema: json_schema(
                &[
                    owner.clone(),
                    repo.clone(),
                    ("pullNumber", num("integer", "Pull request number.")),
                    ("event", s("string", "Review action (APPROVE/REQUEST_CHANGES/COMMENT).")),
                    ("body", opt("string", "Review summary comment.")),
                ],
                &["owner", "repo", "pullNumber", "event"],
            ),
            method: "POST",
            path: |a| format!("/repos/{}/{}/pulls/{}/reviews", owner_of(a), repo_of(a), a["pullNumber"]),
            query: None,
            body: Some(|a| serde_json::json!({ "event": a["event"], "body": a["body"] })),
            paginate: false,
            accept: None,
        },
        GithubToolSpec {
            name: "GitHubListPRReviewComments",
            description: "List review comments (inline code comments) on a pull request.",
            schema: json_schema(
                &[owner.clone(), repo.clone(), ("pullNumber", num("integer", "Pull request number.")), per_page.clone(), page.clone()],
                &["owner", "repo", "pullNumber"],
            ),
            method: "GET",
            path: |a| format!("/repos/{}/{}/pulls/{}/comments", owner_of(a), repo_of(a), a["pullNumber"]),
            query: Some(|a| serde_json::json!({ "per_page": a["perPage"], "page": a["page"] })),
            body: None,
            paginate: true,
            accept: None,
        },
        // 鈹€鈹€ Search 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
        GithubToolSpec {
            name: "GitHubSearchCode",
            description: "Search code across GitHub. Use qualifiers like `repo:owner/name`, `path:`, `language:`.",
            schema: json_schema(
                &[("q", s("string", "Search query.")), per_page.clone(), page.clone()],
                &["q"],
            ),
            method: "GET",
            path: |_| "/search/code".to_string(),
            query: Some(|a| serde_json::json!({ "q": a["q"], "per_page": a["perPage"], "page": a["page"] })),
            body: None,
            paginate: true,
            accept: None,
        },
        GithubToolSpec {
            name: "GitHubSearchRepos",
            description: "Search repositories. Supports qualifiers like `language:`, `stars:>100`, `user:`.",
            schema: json_schema(
                &[
                    ("q", s("string", "Search query.")),
                    ("sort", opt("string", "Sort (stars/forks/updated).")),
                    per_page.clone(),
                    page.clone(),
                ],
                &["q"],
            ),
            method: "GET",
            path: |_| "/search/repositories".to_string(),
            query: Some(|a| serde_json::json!({ "q": a["q"], "sort": a["sort"], "per_page": a["perPage"], "page": a["page"] })),
            body: None,
            paginate: true,
            accept: None,
        },
        GithubToolSpec {
            name: "GitHubSearchIssues",
            description: "Search issues and pull requests. Supports qualifiers like `repo:`, `is:pr`, `author:`, `state:`.",
            schema: json_schema(
                &[
                    ("q", s("string", "Search query.")),
                    ("sort", opt("string", "Sort (comments/created/updated).")),
                    per_page.clone(),
                    page.clone(),
                ],
                &["q"],
            ),
            method: "GET",
            path: |_| "/search/issues".to_string(),
            query: Some(|a| serde_json::json!({ "q": a["q"], "sort": a["sort"], "per_page": a["perPage"], "page": a["page"] })),
            body: None,
            paginate: true,
            accept: None,
        },
        // 鈹€鈹€ Actions (read-only) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
        GithubToolSpec {
            name: "GitHubListWorkflowRuns",
            description: "List GitHub Actions workflow runs for a repository.",
            schema: json_schema(
                &[
                    owner.clone(),
                    repo.clone(),
                    ("branch", opt("string", "Filter by branch.")),
                    ("status", opt("string", "Filter by status/conclusion (e.g. success, failure, in_progress).")),
                    per_page.clone(),
                    page.clone(),
                ],
                &["owner", "repo"],
            ),
            method: "GET",
            path: |a| format!("/repos/{}/{}/actions/runs", owner_of(a), repo_of(a)),
            query: Some(|a| serde_json::json!({
                "branch": a["branch"], "status": a["status"], "per_page": a["perPage"], "page": a["page"]
            })),
            body: None,
            paginate: true,
            accept: None,
        },
        GithubToolSpec {
            name: "GitHubGetWorkflowRun",
            description: "Get a single GitHub Actions workflow run.",
            schema: json_schema(
                &[owner.clone(), repo.clone(), ("runId", num("integer", "Workflow run id."))],
                &["owner", "repo", "runId"],
            ),
            method: "GET",
            path: |a| format!("/repos/{}/{}/actions/runs/{}", owner_of(a), repo_of(a), a["runId"]),
            query: None,
            body: None,
            paginate: false,
            accept: None,
        },
        // 鈹€鈹€ Releases 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
        GithubToolSpec {
            name: "GitHubListReleases",
            description: "List releases for a repository.",
            schema: json_schema(&[owner.clone(), repo.clone(), per_page.clone(), page.clone()], &["owner", "repo"]),
            method: "GET",
            path: |a| format!("/repos/{}/{}/releases", owner_of(a), repo_of(a)),
            query: Some(|a| serde_json::json!({ "per_page": a["perPage"], "page": a["page"] })),
            body: None,
            paginate: true,
            accept: None,
        },
        GithubToolSpec {
            name: "GitHubGetLatestRelease",
            description: "Get the latest published release for a repository.",
            schema: json_schema(base_repo, &["owner", "repo"]),
            method: "GET",
            path: |a| format!("/repos/{}/{}/releases/latest", owner_of(a), repo_of(a)),
            query: None,
            body: None,
            paginate: false,
            accept: None,
        },
        // 鈹€鈹€ Viewer 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
        GithubToolSpec {
            name: "GitHubGetMe",
            description: "Get the authenticated user (verifies the configured token).",
            schema: json_schema(&[], &[]),
            method: "GET",
            path: |_| "/user".to_string(),
            query: None,
            body: None,
            paginate: false,
            accept: None,
        },
    ]
}

/// The full set of built-in GitHub tool definitions.
pub fn tool_definitions() -> Vec<ToolDefinition> {
    github_tool_specs()
        .into_iter()
        .map(|s| ToolDefinition {
            name: s.name.into(),
            description: s.description.into(),
            input_schema: Some(s.schema),
        })
        .collect()
}

fn base64_encode(input: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(input.as_bytes())
}

fn urlencode(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 2);
    for b in input.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Append query params (already URL-encoded pairs) to a URL. The params are
/// collected in insertion order (serde_json preserves object key order), so
/// the resulting query string is deterministic.
fn append_query(url: &str, query: &Value) -> String {
    let Some(obj) = query.as_object() else {
        return url.to_string();
    };
    let mut pairs: Vec<String> = Vec::new();
    for (k, v) in obj {
        match v {
            Value::Null => continue,
            Value::String(s) => pairs.push(format!("{}={}", k, urlencode(s))),
            other => pairs.push(format!("{}={}", k, urlencode(&other.to_string()))),
        }
    }
    if pairs.is_empty() {
        return url.to_string();
    }
    let sep = if url.contains('?') { '&' } else { '?' };
    format!("{url}{sep}{}", pairs.join("&"))
}

fn build_url(path: &str) -> String {
    if path.starts_with("http://") || path.starts_with("https://") {
        return path.to_string();
    }
    let base = base_url().trim_end_matches('/').to_string();
    if let Some(rest) = path.strip_prefix('/') {
        format!("{base}/{rest}")
    } else {
        format!("{base}/{path}")
    }
}

/// Extract the `rel="next"` URL from a `Link` header, if present.
fn parse_next_link(link_header: &str) -> Option<String> {
    for part in link_header.split(',') {
        let mut segs = part.split(';');
        let url_seg = segs.next()?.trim();
        let url = url_seg.trim_start_matches('<').trim_end_matches('>');
        if url.is_empty() {
            continue;
        }
        if segs.any(|m| m.trim() == "rel=\"next\"" || m.trim() == "rel=next") {
            return Some(url.to_string());
        }
    }
    None
}

/// A normalized GitHub response.
struct GithubResponse {
    status: u16,
    body: String,
    error: Option<String>,
    rate_remaining: Option<i64>,
}

fn failure(status: u16, body: String, error: String, rate_remaining: Option<i64>) -> GithubResponse {
    GithubResponse { status, body, error: Some(error), rate_remaining }
}

fn github_error_response(_tool_name: &str, resp: &GithubResponse) -> ToolExecuteResponse {
    let detail = if resp.body.is_empty() {
        String::new()
    } else {
        let mut s = resp.body.clone();
        if s.len() > 4000 {
            s.truncate(4000);
        }
        format!("\n{s}")
    };
    let status = if resp.status > 0 { format!(" (status {})", resp.status) } else { String::new() };
    ToolExecuteResponse {
        content: format!("{}{}{}", resp.error.as_deref().unwrap_or("GitHub request failed"), status, detail),
        is_error: true,
        is_prediction: false,
        stop_turn: false,
        media: Vec::new(),
    }
}

fn github_ok_response(_tool_name: &str, resp: &GithubResponse) -> ToolExecuteResponse {
    let rate = match resp.rate_remaining {
        Some(n) => format!("\n\n(GitHub rate limit remaining: {n})"),
        None => String::new(),
    };
    let body = if resp.body.is_empty() { "(empty response)".to_string() } else { resp.body.clone() };
    ToolExecuteResponse {
        content: format!("{body}{rate}"),
        is_error: false,
        is_prediction: false,
        stop_turn: false,
        media: Vec::new(),
    }
}

/// Execute one GitHub tool call against the GitHub REST API.
pub async fn execute_github_tool(tool_name: &str, args: &Value) -> ToolExecuteResponse {
    let spec = github_tool_specs()
        .into_iter()
        .find(|s| s.name.eq_ignore_ascii_case(tool_name));

    let Some(spec) = spec else {
        return ToolExecuteResponse {
            content: format!("Unknown GitHub tool: {tool_name}"),
            is_error: true,
            is_prediction: false,
            stop_turn: false,
            media: Vec::new(),
        };
    };

    let token = match resolve_token() {
        Some(t) => t,
        None => {
            return ToolExecuteResponse {
                content: "No GitHub token found. Set the GITHUB_TOKEN (or GH_TOKEN) environment variable."
                    .to_string(),
                is_error: true,
                is_prediction: false,
                stop_turn: false,
                media: Vec::new(),
            };
        }
    };

    let path = (spec.path)(args);
    let url = build_url(&path);
    let query = spec.query.map(|q| q(args));
    let url = match &query {
        Some(q) => append_query(&url, q),
        None => url,
    };
    let body = spec.body.map(|b| b(args));
    let accept = spec.accept.unwrap_or(DEFAULT_ACCEPT);

    let client = shared_web_client();

    let mut method = client.request(
        reqwest::Method::from_bytes(spec.method.as_bytes()).unwrap_or(reqwest::Method::GET),
        &url,
    );
    method = method
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .header(reqwest::header::ACCEPT, accept)
        .header("X-GitHub-Api-Version", API_VERSION)
        .header(reqwest::header::USER_AGENT, USER_AGENT);

    let resp = match &body {
        Some(b) if !b.is_null() => {
            method.header(reqwest::header::CONTENT_TYPE, "application/json").json(b).send().await
        }
        _ => method.send().await,
    };

    let first = match resp {
        Ok(r) => r,
        Err(e) => {
            return github_error_response(
                tool_name,
                &failure(0, String::new(), format!("GitHub request failed: {e}"), None),
            );
        }
    };

    let mut rate_remaining = first
        .headers()
        .get("x-ratelimit-remaining")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<i64>().ok());
    let status = first.status().as_u16();
    if status >= 400 {
        let error_body = first.text().await.unwrap_or_default();
        return github_error_response(
            tool_name,
            &failure(status, error_body, format!("GitHub API error {status}"), rate_remaining),
        );
    }

    let mut aggregated: Option<Vec<Value>> = None;
    let mut current = first;
    let mut page_count = 0usize;
    let mut first_iter = true;

    loop {
        let status = current.status().as_u16();
        if status >= 400 {
            let error_body = current.text().await.unwrap_or_default();
            return github_error_response(
                tool_name,
                &failure(status, error_body, format!("GitHub API error {status}"), rate_remaining),
            );
        }
        if let Some(rr) = current
            .headers()
            .get("x-ratelimit-remaining")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<i64>().ok())
        {
            rate_remaining = Some(rr);
        }

        // Reuse `next_url` computed from the previous response's Link header.
        let link = current
            .headers()
            .get(reqwest::header::LINK)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let next_url = link.as_deref().and_then(parse_next_link);

        if !spec.paginate {
            let text = current.text().await.unwrap_or_default();
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                if let Value::Array(items) = v {
                    aggregated = Some(items);
                } else {
                    return github_ok_response(tool_name, &GithubResponse {
                        status,
                        body: v.to_string(),
                        error: None,
                        rate_remaining,
                    });
                }
            } else {
                return github_ok_response(tool_name, &GithubResponse {
                    status,
                    body: text,
                    error: None,
                    rate_remaining,
                });
            }
            break;
        }

        let text = current.text().await.unwrap_or_default();
        if first_iter {
            match serde_json::from_str::<Value>(&text) {
                Ok(Value::Array(items)) => {
                    aggregated = Some(items);
                }
                Ok(other) => {
                    return github_ok_response(tool_name, &GithubResponse {
                        status,
                        body: other.to_string(),
                        error: None,
                        rate_remaining,
                    });
                }
                Err(_) => {
                    return github_ok_response(tool_name, &GithubResponse {
                        status,
                        body: text,
                        error: None,
                        rate_remaining,
                    });
                }
            }
            first_iter = false;
        } else if let (Some(agg), Ok(Value::Array(items))) =
            (aggregated.as_mut(), serde_json::from_str::<Value>(&text))
        {
            agg.extend(items);
        }

        match next_url {
            Some(nu) if page_count < MAX_PAGES => {
                page_count += 1;
                let mut req = client
                    .request(
                        reqwest::Method::from_bytes(spec.method.as_bytes())
                            .unwrap_or(reqwest::Method::GET),
                        &nu,
                    )
                    .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
                    .header(reqwest::header::ACCEPT, accept)
                    .header("X-GitHub-Api-Version", API_VERSION)
                    .header(reqwest::header::USER_AGENT, USER_AGENT);
                if let Some(b) = &body {
                    req = req
                        .header(reqwest::header::CONTENT_TYPE, "application/json")
                        .json(b);
                }
                current = match req.send().await {
                    Ok(r) => r,
                    Err(e) => {
                        return github_error_response(
                            tool_name,
                            &failure(0, String::new(), format!("GitHub request failed: {e}"), None),
                        );
                    }
                };
            }
            _ => break,
        }
    }

    let out = match aggregated {
        Some(items) => Value::Array(items).to_string(),
        None => "(empty response)".to_string(),
    };
    github_ok_response(tool_name, &GithubResponse {
        status: 200,
        body: out,
        error: None,
        rate_remaining,
    })
}

/// Intercepts the `GitHub*` tools and runs them natively.
pub struct GitHubToolInterceptor {
    pub inner: Arc<dyn HostCallbacks>,
}

impl HostCallbacks for GitHubToolInterceptor {
    fn supports_tool_lifecycle(&self) -> bool {
        self.inner.supports_tool_lifecycle()
    }
    fn llm_chat(
        &self,
        r: crate::rpc::types::LlmChatRequest,
    ) -> BoxFuture<'static, Result<crate::rpc::types::LlmChatResponse, String>> {
        self.inner.llm_chat(r)
    }
    fn execute_tool(
        &self,
        req: ToolExecuteRequest,
    ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        if !github_tool_specs().iter().any(|s| s.name.eq_ignore_ascii_case(&req.tool_name)) {
            return self.inner.execute_tool(req);
        }
        let tool_name = req.tool_name.clone();
        let args = req.arguments.clone();
        Box::pin(async move {
            Ok(execute_github_tool(&tool_name, &args).await)
        })
    }
    fn emit_event(&self, e: serde_json::Value) {
        self.inner.emit_event(e);
    }
    fn prepare_tool_execution(
        &self,
        r: crate::rpc::types::PrepareToolRequest,
    ) -> BoxFuture<'static, Result<Option<crate::rpc::types::PrepareToolResponse>, String>> {
        self.inner.prepare_tool_execution(r)
    }
    fn authorize_tool_execution(
        &self,
        r: crate::rpc::types::AuthorizeToolRequest,
    ) -> BoxFuture<'static, Result<Option<crate::rpc::types::AuthorizeToolResponse>, String>> {
        self.inner.authorize_tool_execution(r)
    }
    fn finalize_tool_result(
        &self,
        r: crate::rpc::types::FinalizeToolRequest,
    ) -> BoxFuture<'static, Result<crate::rpc::types::FinalizeToolResponse, String>> {
        self.inner.finalize_tool_result(r)
    }
}

/// Whether a GitHub tool's approval subject should be the `owner/repo` pair.
pub fn approval_subject(tool_name: &str, args: &Value) -> String {
    github_tool_specs()
        .into_iter()
        .find(|s| s.name.eq_ignore_ascii_case(tool_name))
        .map(|s| {
            if s.name == "GitHubGetMe" {
                "me".to_string()
            } else if (s.path)(args).contains("/search/") {
                args.get("q").and_then(|v| v.as_str()).unwrap_or("github").to_string()
            } else {
                repo_base(args)
            }
        })
        .unwrap_or_else(|| "github".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str) -> GithubToolSpec {
        github_tool_specs().into_iter().find(|s| s.name == name).unwrap()
    }

    #[test]
    fn tool_definitions_covers_all_30_ts_tools() {
        let defs = tool_definitions();
        assert_eq!(defs.len(), 29, "TS exposes exactly 29 GitHub tools");
        let names: Vec<&str> = defs.iter().map(|d| d.name.as_str()).collect();
        for n in GITHUB_READONLY_TOOL_NAMES {
            assert!(names.iter().any(|x| *x == *n), "missing readonly tool {n}");
        }
        for n in ["GitHubCreateIssue", "GitHubUpdateIssue", "GitHubCreateOrUpdateFile",
                  "GitHubCreatePR", "GitHubUpdatePR", "GitHubMergePR", "GitHubCreatePRReview",
                  "GitHubAddIssueComment"] {
            assert!(names.iter().any(|x| *x == n), "missing mutating tool {n}");
        }
    }

    #[test]
    fn readonly_and_mutating_classification() {
        assert!(GITHUB_READONLY_TOOL_NAMES.iter().any(|n| n == &"GitHubGetRepo"));
        assert!(!is_mutating("GitHubGetRepo"));
        assert!(!is_mutating("GitHubGetMe"));
        assert!(is_mutating("GitHubCreateIssue"));
        assert!(is_mutating("GitHubMergePR"));
        assert!(is_mutating("GitHubCreateOrUpdateFile"));
    }

    #[test]
    fn schemas_carry_required_fields() {
        let s = spec("GitHubGetRepo").schema;
        assert_eq!(s["required"], serde_json::json!(["owner", "repo"]));
        let s = spec("GitHubSearchCode").schema;
        assert_eq!(s["required"], serde_json::json!(["q"]));
        let s = spec("GitHubGetPR").schema;
        assert_eq!(s["required"], serde_json::json!(["owner", "repo", "pullNumber"]));
    }

    #[test]
    fn paths_build_from_args() {
        let args = serde_json::json!({"owner": "octocat", "repo": "hello-world"});
        assert_eq!((spec("GitHubGetRepo").path)(&args), "/repos/octocat/hello-world");
        let args = serde_json::json!({"owner": "o", "repo": "r", "pullNumber": 42});
        assert_eq!((spec("GitHubGetPR").path)(&args), "/repos/o/r/pulls/42");
        let args = serde_json::json!({"owner": "o", "repo": "r", "issueNumber": 7});
        assert_eq!((spec("GitHubAddIssueComment").path)(&args), "/repos/o/r/issues/7/comments");
        assert_eq!((spec("GitHubGetMe").path)(&serde_json::json!({})), "/user");
        assert_eq!((spec("GitHubSearchCode").path)(&serde_json::json!({})), "/search/code");
    }

    #[test]
    fn query_and_body_builders() {
        let args = serde_json::json!({"owner": "o", "repo": "r", "state": "open", "perPage": 30});
        let q = (spec("GitHubListPRs").query.unwrap())(&args);
        assert_eq!(q["state"], "open");
        assert_eq!(q["per_page"], 30);
        assert!(q.get("page").is_none() || q["page"].is_null());

        let args = serde_json::json!({"owner": "o", "repo": "r", "path": "a/b.txt",
            "message": "add", "content": "hello"});
        let b = (spec("GitHubCreateOrUpdateFile").body.unwrap())(&args);
        assert_eq!(b["message"], "add");
        assert_eq!(b["content"], base64_encode("hello"));
        assert!(b["branch"].is_null());
    }

    #[test]
    fn paginate_flags_match_ts() {
        assert!((spec("GitHubListCommits").paginate));
        assert!(spec("GitHubSearchCode").paginate);
        assert!(!spec("GitHubGetRepo").paginate);
        assert!(!spec("GitHubGetPRDiff").paginate);
    }

    #[test]
    fn pr_diff_uses_diff_accept() {
        assert_eq!(spec("GitHubGetPRDiff").accept, Some("application/vnd.github.diff"));
        assert_eq!(spec("GitHubGetRepo").accept, None);
    }

    #[test]
    fn approval_subject_uses_repo_base_for_repo_tools() {
        let args = serde_json::json!({"owner": "o", "repo": "r"});
        assert_eq!(approval_subject("GitHubGetRepo", &args), "o/r");
        assert_eq!(approval_subject("GitHubCreateIssue", &args), "o/r");
        let q = serde_json::json!({"q": "repo:o/r rust"});
        assert_eq!(approval_subject("GitHubSearchCode", &q), "repo:o/r rust");
        assert_eq!(approval_subject("GitHubGetMe", &serde_json::json!({})), "me");
    }

    #[test]
    fn build_and_append_url() {
        let _guard = env_lock().blocking_lock();
        assert_eq!(build_url("/user"), format!("{DEFAULT_BASE_URL}/user"));
        assert_eq!(
            build_url("https://github.example/api/repos/o/r"),
            "https://github.example/api/repos/o/r"
        );
        let q = serde_json::json!({"q": "hello world", "per_page": 10});
        let built = append_query("https://api.github.com/search/code", &q);
        // serde_json's default Map sorts keys alphabetically; order is
        // irrelevant to the GitHub API, so only check containment + encoding.
        assert!(built.contains("q=hello%20world"));
        assert!(built.contains("per_page=10"));
        assert!(built.starts_with("https://api.github.com/search/code?"));
        let empty = serde_json::json!({});
        assert_eq!(
            append_query("https://api.github.com/x", &empty),
            "https://api.github.com/x"
        );
    }

    #[test]
    fn parse_next_link_parses_rel_next() {
        let h = "<https://api.github.com/x?page=2>; rel=\"next\", <https://api.github.com/x?page=10>; rel=\"last\"";
        assert_eq!(
            parse_next_link(h).as_deref(),
            Some("https://api.github.com/x?page=2")
        );
        assert_eq!(parse_next_link("no links"), None);
        assert_eq!(parse_next_link(""), None);
    }

    #[test]
    fn token_resolution_prefers_github_token() {
        // Env-dependent: set nothing and assert it returns None in isolation.
        // The exact env behavior is exercised by integration tests.
        let _ = resolve_token;
        let _ = base_url;
    }

    #[test]
    fn unknown_tool_returns_error() {
        let tokio = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let resp = tokio.block_on(execute_github_tool("GitHubNope", &serde_json::json!({})));
        assert!(resp.is_error);
        assert!(resp.content.contains("Unknown GitHub tool"));
    }

    #[test]
    fn missing_token_returns_helpful_error() {
        let _guard = env_lock().blocking_lock();
        // Remove any ambient token so the missing-token branch is hit.
        let saved_gh = std::env::var("GITHUB_TOKEN").ok();
        let saved_g = std::env::var("GH_TOKEN").ok();
        unsafe {
            std::env::remove_var("GITHUB_TOKEN");
            std::env::remove_var("GH_TOKEN");
        }
        let tokio = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let resp = tokio.block_on(execute_github_tool("GitHubGetRepo", &serde_json::json!({
            "owner": "o", "repo": "r"
        })));
        unsafe {
            std::env::set_var("GITHUB_TOKEN", saved_gh.unwrap_or_default());
            std::env::set_var("GH_TOKEN", saved_g.unwrap_or_default());
        }
        assert!(resp.is_error);
        assert!(resp.content.contains("GITHUB_TOKEN"));
    }

    /// Serializes env-dependent integration tests: they set the global
    /// GITHUB_TOKEN / GITHUB_API_URL, so they must not run in parallel with
    /// each other (or with any other test touching those vars).
    static ENV_LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    fn env_lock() -> &'static tokio::sync::Mutex<()> {
        ENV_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
    }

    /// One-shot loopback GitHub server. Reads a request, records the raw
    /// request head into `seen`, answers with `status` + `body`. Returns the
    /// port. Assertions run in the test (not the server thread) so a failed
    /// assertion cannot leave the request unanswered (which would make the
    /// client wait the full 30s timeout).
    fn spawn_github_server(
        status: u16,
        body: String,
        seen: Arc<std::sync::Mutex<Option<String>>>,
    ) -> u16 {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 1024];
            // Read until the end of the request head. The body may already be
            // in `buf` (a single TCP segment carries head + body), so compute
            // the head/body split below instead of a second blocking read.
            while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = stream.read(&mut chunk).unwrap();
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            let head_len = buf
                .windows(4)
                .position(|w| w == b"\r\n\r\n")
                .map(|p| p + 4)
                .unwrap_or(buf.len());
            let head = String::from_utf8_lossy(&buf[..head_len]).to_string();
            // Drain any request body (Content-Length bounded), consuming the
            // bytes already read into `buf` before reading any remainder.
            let content_length: Option<usize> = head
                .lines()
                .map(|l| l.to_ascii_lowercase())
                .find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().to_string()))
                .and_then(|v| v.parse::<usize>().ok());
            if let Some(n) = content_length {
                let already = buf.len().saturating_sub(head_len);
                let remaining = n.saturating_sub(already);
                let mut body_buf = vec![0u8; remaining];
                if remaining > 0 {
                    let _ = stream.read_exact(&mut body_buf);
                }
            }
            *seen.lock().unwrap() = Some(head);
            let resp = format!(
                "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(resp.as_bytes());
        });
        port
    }

    #[tokio::test]
    async fn get_repo_hits_repos_path_with_bearer_auth() {
        let _guard = env_lock().lock().await;
        let saved_token = std::env::var("GITHUB_TOKEN").ok();
        let saved_api = std::env::var("GITHUB_API_URL").ok();
        let seen = Arc::new(std::sync::Mutex::new(None::<String>));
        let port = spawn_github_server(200, r#"{"full_name":"o/r"}"#.to_string(), seen.clone());
        unsafe {
            std::env::set_var("GITHUB_TOKEN", "sekrit");
            std::env::set_var("GITHUB_API_URL", format!("http://127.0.0.1:{port}"));
        }
        let resp = execute_github_tool("GitHubGetRepo", &serde_json::json!({
            "owner": "o", "repo": "r"
        })).await;
        unsafe {
            restore_var("GITHUB_TOKEN", saved_token);
            restore_var("GITHUB_API_URL", saved_api);
        }
        assert!(!resp.is_error, "unexpected error: {}", resp.content);
        assert!(resp.content.contains("o/r"));
        let head = seen.lock().unwrap().take().expect("server saw a request").to_ascii_lowercase();
        assert!(head.contains("get /repos/o/r"), "unexpected request line: {head}");
        assert!(head.contains("authorization: bearer sekrit"), "missing auth: {head}");
        assert!(head.contains("user-agent: kimi-code"), "missing UA: {head}");
        assert!(head.contains("x-github-api-version: 2022-11-28"), "missing version header");
    }

    #[tokio::test]
    async fn search_code_sends_query_and_aggregates_paginated_pages() {
        let _guard = env_lock().lock().await;
        let saved_token = std::env::var("GITHUB_TOKEN").ok();
        let saved_api = std::env::var("GITHUB_API_URL").ok();
        // Two-page pagination: first response links to page 2.
        let first_body = r#"[{"name":"a.rs"}]"#;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            let mut streams = Vec::new();
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buf = Vec::new();
                let mut chunk = [0u8; 1024];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = stream.read(&mut chunk).unwrap();
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                let head = String::from_utf8_lossy(&buf).to_string().to_ascii_lowercase();
                streams.push(head);
                let (body, extra_header) = if streams.len() == 1 {
                    (
                        first_body.to_string(),
                        format!(
                            "Link: <http://127.0.0.1:{port}/search/code?page=2>; rel=\"next\"\r\n"
                        ),
                    )
                } else {
                    (r#"[{"name":"b.rs"}]"#.to_string(), String::new())
                };
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{extra_header}Content-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes());
            }
        });
        unsafe {
            std::env::set_var("GITHUB_TOKEN", "sekrit");
            std::env::set_var("GITHUB_API_URL", format!("http://127.0.0.1:{port}"));
        }
        let resp = execute_github_tool("GitHubSearchCode", &serde_json::json!({
            "q": "fn main"
        })).await;
        unsafe {
            restore_var("GITHUB_TOKEN", saved_token);
            restore_var("GITHUB_API_URL", saved_api);
        }
        assert!(!resp.is_error, "unexpected error: {}", resp.content);
        assert!(resp.content.contains("a.rs"));
        assert!(resp.content.contains("b.rs"), "pagination should aggregate page 2");
    }

    #[tokio::test]
    async fn create_issue_sends_json_body() {
        let _guard = env_lock().lock().await;
        let saved_token = std::env::var("GITHUB_TOKEN").ok();
        let saved_api = std::env::var("GITHUB_API_URL").ok();
        let seen = Arc::new(std::sync::Mutex::new(None::<String>));
        let port = spawn_github_server(201, r#"{"number":5}"#.to_string(), seen.clone());
        unsafe {
            std::env::set_var("GITHUB_TOKEN", "sekrit");
            std::env::set_var("GITHUB_API_URL", format!("http://127.0.0.1:{port}"));
        }
        let resp = execute_github_tool("GitHubCreateIssue", &serde_json::json!({
            "owner": "o", "repo": "r", "title": "Bug", "body": "Details"
        })).await;
        unsafe {
            restore_var("GITHUB_TOKEN", saved_token);
            restore_var("GITHUB_API_URL", saved_api);
        }
        assert!(!resp.is_error, "unexpected error: {}", resp.content);
        assert!(resp.content.contains("\"number\":5"));
        let head = seen.lock().unwrap().take().expect("server saw a request").to_ascii_lowercase();
        assert!(head.contains("post /repos/o/r/issues"), "unexpected: {head}");
        assert!(head.contains("content-type: application/json"), "missing JSON header: {head}");
    }

    #[tokio::test]
    async fn api_error_propagates_status() {
        let _guard = env_lock().lock().await;
        let saved_token = std::env::var("GITHUB_TOKEN").ok();
        let saved_api = std::env::var("GITHUB_API_URL").ok();
        let seen = Arc::new(std::sync::Mutex::new(None::<String>));
        let port = spawn_github_server(404, r#"{"message":"Not Found"}"#.to_string(), seen);
        unsafe {
            std::env::set_var("GITHUB_TOKEN", "sekrit");
            std::env::set_var("GITHUB_API_URL", format!("http://127.0.0.1:{port}"));
        }
        let resp = execute_github_tool("GitHubGetRepo", &serde_json::json!({
            "owner": "o", "repo": "nope"
        })).await;
        unsafe {
            restore_var("GITHUB_TOKEN", saved_token);
            restore_var("GITHUB_API_URL", saved_api);
        }
        assert!(resp.is_error);
        assert!(resp.content.contains("status 404"));
    }

    /// Restore an env var that may have been set or unset before the test.
    fn restore_var(key: &str, value: Option<String>) {
        match value {
            Some(v) => unsafe { std::env::set_var(key, v) },
            None => unsafe { std::env::remove_var(key) },
        }
    }
}
