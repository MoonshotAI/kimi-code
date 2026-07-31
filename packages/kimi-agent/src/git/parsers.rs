//! Pure git-output parsers.
//!
//! Port of `agent-core-v2/src/app/git/gitParsers.ts`: parses
//! `git status --porcelain=v1 --branch`, `git diff --numstat`, and
//! `gh pr view --json` output into the wire shapes. No IO — plain functions.

use serde::Serialize;
use std::collections::BTreeMap;

/// Working-tree status of one path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FsGitStatus {
    Clean,
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Ignored,
    Conflicted,
}

/// Parsed PR info from `gh pr view --json`.
#[derive(Debug, Clone, Serialize)]
pub struct FsPullRequest {
    pub number: u32,
    #[serde(rename = "state")]
    pub state: String,
    #[serde(rename = "url")]
    pub url: String,
}

/// Parsed `git status --porcelain=v1 --branch` output.
#[derive(Debug, Clone, Serialize)]
pub struct GitStatusResponse {
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    /// path (posix) → status. BTreeMap keeps output deterministic.
    pub entries: BTreeMap<String, FsGitStatus>,
    /// Summed added/deleted lines across all changed files (`git diff
    /// --numstat HEAD`). Binary files contribute 0.
    pub additions: u32,
    pub deletions: u32,
    /// GitHub PR for the current branch; null when unavailable.
    pub pull_request: Option<FsPullRequest>,
}

/// Parse the `## <branch> [ahead N, behind M]` header line (without `## `).
fn parse_branch_header(rest: &str) -> (String, u32, u32) {
    if rest.starts_with("HEAD (no branch)") {
        return (String::new(), 0, 0);
    }
    if let Some(name) = rest.strip_prefix("No commits yet on ") {
        return (name.to_string(), 0, 0);
    }
    let mut branch = rest;
    let mut ahead = 0u32;
    let mut behind = 0u32;

    if let Some(bracket) = rest.find(" [") {
        branch = &rest[..bracket];
        let sliced = rest[bracket + 2..].trim_end_matches(']');
        if let Some(idx) = sliced.find("ahead ") {
            ahead = sliced[idx + "ahead ".len()..]
                .split(|c: char| !c.is_ascii_digit())
                .next()
                .and_then(|d| d.parse().ok())
                .unwrap_or(0);
        }
        if let Some(idx) = sliced.find("behind ") {
            behind = sliced[idx + "behind ".len()..]
                .split(|c: char| !c.is_ascii_digit())
                .next()
                .and_then(|d| d.parse().ok())
                .unwrap_or(0);
        }
    }
    if let Some(dots) = branch.find("...") {
        branch = &branch[..dots];
    }
    (branch.to_string(), ahead, behind)
}

/// Collapse a porcelain XY pair into a coarse status.
fn collapse_xy(xy: &str) -> FsGitStatus {
    let bytes = xy.as_bytes();
    if bytes.len() < 2 {
        return FsGitStatus::Clean;
    }
    let x = bytes[0] as char;
    let y = bytes[1] as char;
    if x == '?' && y == '?' {
        return FsGitStatus::Untracked;
    }
    if x == '!' && y == '!' {
        return FsGitStatus::Ignored;
    }
    // Unmerged pairs (both index and worktree disagree with HEAD).
    if matches!(
        (x, y),
        ('D', 'D')
            | ('A', 'U')
            | ('U', 'D')
            | ('U', 'A')
            | ('D', 'U')
            | ('A', 'A')
            | ('U', 'U')
    ) {
        return FsGitStatus::Conflicted;
    }
    if x == 'D' || y == 'D' {
        return FsGitStatus::Deleted;
    }
    if x == 'M' || y == 'M' || x == 'T' || y == 'T' {
        return FsGitStatus::Modified;
    }
    if x == 'R' || y == 'R' || x == 'C' || y == 'C' {
        return FsGitStatus::Renamed;
    }
    if x == 'A' || y == 'A' {
        return FsGitStatus::Added;
    }
    FsGitStatus::Clean
}

/// Parse `git status --porcelain=v1 --branch` output.
pub fn parse_porcelain(
    stdout: &str,
    filter: Option<&std::collections::HashSet<String>>,
) -> GitStatusResponse {
    let mut branch = String::new();
    let mut ahead = 0u32;
    let mut behind = 0u32;
    let mut entries = BTreeMap::new();

    for raw_line in stdout.lines() {
        let line = raw_line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("## ") {
            let (b, a, be) = parse_branch_header(rest);
            branch = b;
            ahead = a;
            behind = be;
            continue;
        }
        if line.len() < 4 {
            continue;
        }
        let xy = &line[..2];
        let mut rest = line[3..].to_string();
        if xy.starts_with('R') || xy.starts_with('C') {
            if let Some(arrow) = rest.find(" -> ") {
                rest = rest[arrow + 4..].to_string();
            }
        }
        let wire_path = rest.trim().replace('\\', "/");
        if let Some(ref filter) = filter {
            if !filter.contains(&wire_path) {
                continue;
            }
        }
        let status = collapse_xy(xy);
        entries.insert(wire_path, status);
    }

    GitStatusResponse {
        branch,
        ahead,
        behind,
        entries,
        additions: 0,
        deletions: 0,
        pull_request: None,
    }
}

fn numstat_count(value: &str) -> u32 {
    if value == "-" {
        return 0;
    }
    value.parse::<u32>().unwrap_or(0)
}

/// Parse `git diff --numstat` output (tab-separated added/deleted per file).
pub fn parse_numstat(stdout: &str) -> (u32, u32) {
    let mut additions = 0u32;
    let mut deletions = 0u32;
    for line in stdout.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split('\t');
        if let Some(added) = parts.next() {
            additions += numstat_count(added);
        }
        if let Some(deleted) = parts.next() {
            deletions += numstat_count(deleted);
        }
    }
    (additions, deletions)
}

fn is_safe_http_url(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

/// Parse `gh pr view --json` output; `None` for malformed input.
pub fn parse_pull_request(stdout: &str) -> Option<FsPullRequest> {
    let raw: serde_json::Value = serde_json::from_str(stdout).ok()?;
    let number = raw.get("number")?.as_u64()?;
    if number == 0 {
        return None;
    }
    let url = raw.get("url")?.as_str()?;
    if !is_safe_http_url(url) {
        return None;
    }
    let state = raw.get("state")?.as_str()?.to_lowercase();
    if !matches!(state.as_str(), "open" | "merged" | "closed") {
        return None;
    }
    Some(FsPullRequest {
        number: number as u32,
        state,
        url: url.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_header_with_ahead_behind() {
        let (branch, ahead, behind) = parse_branch_header("main...origin/main [ahead 3, behind 1]");
        assert_eq!(branch, "main");
        assert_eq!(ahead, 3);
        assert_eq!(behind, 1);
    }

    #[test]
    fn parses_detached_head_and_no_commits() {
        assert_eq!(parse_branch_header("HEAD (no branch)"), (String::new(), 0, 0));
        let (branch, ahead, behind) = parse_branch_header("No commits yet on feature");
        assert_eq!(branch, "feature");
        assert_eq!((ahead, behind), (0, 0));
    }

    #[test]
    fn collapses_xy_pairs() {
        assert_eq!(collapse_xy("??"), FsGitStatus::Untracked);
        assert_eq!(collapse_xy("!!"), FsGitStatus::Ignored);
        assert_eq!(collapse_xy(" M"), FsGitStatus::Modified);
        assert_eq!(collapse_xy("M "), FsGitStatus::Modified);
        assert_eq!(collapse_xy("UU"), FsGitStatus::Conflicted);
        assert_eq!(collapse_xy("DD"), FsGitStatus::Conflicted);
        assert_eq!(collapse_xy(" D"), FsGitStatus::Deleted);
        assert_eq!(collapse_xy("R "), FsGitStatus::Renamed);
        assert_eq!(collapse_xy("A "), FsGitStatus::Added);
    }

    #[test]
    fn parses_porcelain_full() {
        let stdout = "## main...origin/main [ahead 2]\n M src/lib.rs\n?? new.txt\nR  old.txt -> new/name.txt\n";
        let resp = parse_porcelain(stdout, None);
        assert_eq!(resp.branch, "main");
        assert_eq!(resp.ahead, 2);
        assert_eq!(resp.entries.len(), 3);
        assert_eq!(resp.entries["src/lib.rs"], FsGitStatus::Modified);
        assert_eq!(resp.entries["new.txt"], FsGitStatus::Untracked);
        assert_eq!(resp.entries["new/name.txt"], FsGitStatus::Renamed);
    }

    #[test]
    fn porcelain_respects_filter() {
        let stdout = " M src/lib.rs\n?? new.txt\n";
        let filter: std::collections::HashSet<String> =
            ["src/lib.rs".to_string()].into_iter().collect();
        let resp = parse_porcelain(stdout, Some(&filter));
        assert_eq!(resp.entries.len(), 1);
    }

    #[test]
    fn numstat_sums_and_skips_binary() {
        let stdout = "10\t3\tsrc/lib.rs\n-\t-\tbin/data.png\n2\t1\tsrc/main.rs\n";
        let (additions, deletions) = parse_numstat(stdout);
        assert_eq!(additions, 12);
        assert_eq!(deletions, 4);
    }

    #[test]
    fn parses_pr_json_and_rejects_bad() {
        let ok = r#"{"number":42,"state":"OPEN","url":"https://github.com/a/b/pull/42"}"#;
        let pr = parse_pull_request(ok).unwrap();
        assert_eq!(pr.number, 42);
        assert_eq!(pr.state, "open");

        assert!(parse_pull_request("not json").is_none());
        assert!(parse_pull_request(r#"{"number":0,"state":"open","url":"https://x"}"#).is_none());
        assert!(parse_pull_request(r#"{"number":1,"state":"weird","url":"https://x"}"#).is_none());
        assert!(parse_pull_request(r#"{"number":1,"state":"open","url":"javascript:alert(1)"}"#).is_none());
    }
}
