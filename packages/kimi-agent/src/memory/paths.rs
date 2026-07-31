//! Memory path resolution — disk layout for persistent memory files.
//!
//! Port of `agent-core-v2/src/app/memory/memoryPaths.ts`: memory files live
//! under `~/.kimi-code/memory/`, organized by scope:
//! - `global/` — cross-project knowledge
//! - `projects/<projectId>/` — project-specific knowledge (id = short hash of cwd)
//! - `sessions/<sessionId>/` — session-specific knowledge

use serde::{Deserialize, Serialize};

/// Memory scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryScope {
    Global,
    Project,
    Session,
}

impl MemoryScope {
    pub fn as_str(&self) -> &'static str {
        match self {
            MemoryScope::Global => "global",
            MemoryScope::Project => "project",
            MemoryScope::Session => "session",
        }
    }
}

/// A memory file entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryEntry {
    pub path: String,
    pub scope: MemoryScope,
    pub scope_id: String,
    pub r#type: String,
    pub title: String,
    pub body: String,
    pub fingerprint: String,
    pub updated_at: u64,
}

/// A search hit.
#[derive(Debug, Clone)]
pub struct MemorySearchResult {
    pub path: String,
    pub scope: MemoryScope,
    pub scope_id: String,
    pub r#type: String,
    pub title: String,
    pub snippet: String,
    pub score: f64,
}

/// Project id: short sha256 of the cwd, so the same working directory always
/// maps to the same project memory.
pub fn project_id_from_cwd(cwd: &str) -> String {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(cwd.as_bytes());
    let digest = hasher.finalize();
    hex::encode(digest)[..12].to_string()
}

/// The memory base directory (`<home>/memory`).
pub fn memory_dir(home_dir: &str) -> String {
    format!("{}/memory", home_dir.trim_end_matches(['/', '\\']))
}

/// Directory for a scope.
pub fn scope_dir(base: &str, scope: MemoryScope, scope_id: &str) -> String {
    match scope {
        MemoryScope::Global => format!("{base}/global"),
        MemoryScope::Project => format!("{base}/projects/{scope_id}"),
        MemoryScope::Session => format!("{base}/sessions/{scope_id}"),
    }
}

/// Parse a relative path into scope components:
/// `global/foo.md` → Global; `projects/abc/foo.md` → Project; `sessions/x/foo.md` → Session.
pub fn parse_memory_path(rel_path: &str) -> Option<(MemoryScope, String, String)> {
    let parts: Vec<&str> = rel_path.split('/').collect();
    if parts.len() < 2 {
        return None;
    }
    if parts[0] == "global" {
        return Some((MemoryScope::Global, String::new(), parts[1..].join("/")));
    }
    if parts[0] == "projects" && parts.len() >= 3 {
        return Some((MemoryScope::Project, parts[1].to_string(), parts[2..].join("/")));
    }
    if parts[0] == "sessions" && parts.len() >= 3 {
        return Some((MemoryScope::Session, parts[1].to_string(), parts[2..].join("/")));
    }
    None
}

/// Extract a title from markdown: first H1 heading, else the filename.
pub fn extract_title(body: &str, file_name: &str) -> String {
    for line in body.lines() {
        if let Some(rest) = line.strip_prefix("# ") {
            let t = rest.trim();
            if !t.is_empty() {
                return t.to_string();
            }
        }
    }
    file_name.trim_end_matches(".md").to_string()
}

const VALID_TYPES: [&str; 5] = ["note", "decision", "pattern", "lesson", "reference"];

/// Detect memory type from frontmatter `type:` or an H2 heading. Falls back to
/// `note`.
pub fn detect_type(body: &str) -> String {
    if let Some(fm) = body.split("---").nth(1) {
        for line in fm.lines() {
            if let Some(v) = line.trim().strip_prefix("type:") {
                let t = v.trim();
                if VALID_TYPES.contains(&t) {
                    return t.to_string();
                }
            }
        }
    }
    for line in body.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            let t = rest.trim().to_lowercase();
            if VALID_TYPES.contains(&t.as_str()) {
                return t;
            }
        }
    }
    "note".to_string()
}

/// Build a snippet around the first query hit (simple alternative to FTS
/// snippet()).
pub fn build_snippet(body: &str, query: &str, max_len: usize) -> String {
    let lower_body = body.to_lowercase();
    let lower_query = query.to_lowercase();
    match lower_body.find(&lower_query) {
        None => {
            let mut s = body.chars().take(max_len).collect::<String>();
            if s.len() < body.len() {
                s.push_str("...");
            }
            s.trim().to_string()
        }
        Some(idx) => {
            let start = idx.saturating_sub(40);
            let end = (idx + lower_query.len() + 80).min(body.len());
            let mut snippet = body[start..end].trim().to_string();
            if start > 0 {
                snippet = format!("...{snippet}");
            }
            if end < body.len() {
                snippet = format!("{snippet}...");
            }
            snippet
        }
    }
}

/// Sanitize a user-provided filename: only `[A-Za-z0-9._-]`, must end in .md
/// (appended when missing). Path separators and leading dots are rejected.
pub fn sanitize_file_name(path: &str) -> Option<String> {
    if path.contains('/') || path.contains('\\') {
        return None;
    }
    if path.is_empty() || path == "." || path == ".." {
        return None;
    }
    if !path
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return None;
    }
    if path.starts_with('.') {
        return None;
    }
    let with_ext = if path.to_lowercase().ends_with(".md") {
        path.to_string()
    } else {
        format!("{path}.md")
    };
    Some(with_ext)
}

/// Build a relative path from scope components.
pub fn build_rel_path(scope: MemoryScope, scope_id: &str, file_name: &str) -> String {
    match scope {
        MemoryScope::Global => format!("global/{file_name}"),
        MemoryScope::Project => format!("projects/{scope_id}/{file_name}"),
        MemoryScope::Session => format!("sessions/{scope_id}/{file_name}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_id_is_stable_and_short() {
        let a = project_id_from_cwd("D:\\repo\\x");
        let b = project_id_from_cwd("D:\\repo\\x");
        assert_eq!(a, b);
        assert_eq!(a.len(), 12);
        assert_ne!(a, project_id_from_cwd("D:\\repo\\y"));
    }

    #[test]
    fn scope_dirs() {
        let base = "/home/u/.kimi-code/memory";
        assert_eq!(scope_dir(base, MemoryScope::Global, ""), format!("{base}/global"));
        assert_eq!(
            scope_dir(base, MemoryScope::Project, "abc123"),
            format!("{base}/projects/abc123")
        );
        assert_eq!(
            scope_dir(base, MemoryScope::Session, "s1"),
            format!("{base}/sessions/s1")
        );
    }

    #[test]
    fn parses_memory_paths() {
        let (s, id, f) = parse_memory_path("global/foo.md").unwrap();
        assert_eq!(s, MemoryScope::Global);
        assert_eq!((id.as_str(), f.as_str()), ("", "foo.md"));

        let (s, id, f) = parse_memory_path("projects/abc123/nested/foo.md").unwrap();
        assert_eq!(s, MemoryScope::Project);
        assert_eq!((id.as_str(), f.as_str()), ("abc123", "nested/foo.md"));

        let (s, id, f) = parse_memory_path("sessions/s1/foo.md").unwrap();
        assert_eq!(s, MemoryScope::Session);
        assert_eq!((id.as_str(), f.as_str()), ("s1", "foo.md"));

        assert!(parse_memory_path("foo.md").is_none());
        assert!(parse_memory_path("projects/only").is_none());
    }

    #[test]
    fn titles_and_types() {
        assert_eq!(extract_title("# My Note\nbody", "x.md"), "My Note");
        assert_eq!(extract_title("body", "x.md"), "x");
        assert_eq!(detect_type("---\ntype: decision\n---\nbody"), "decision");
        assert_eq!(detect_type("## Lesson\nbody"), "lesson");
        assert_eq!(detect_type("plain"), "note");
    }

    #[test]
    fn snippets_wrap_hits() {
        let s = build_snippet("aaaa bbb query content cccc", "query", 200);
        assert!(s.contains("query"));
        assert!(s.starts_with("...") || s.ends_with("...") || !s.contains("..."));
    }

    #[test]
    fn sanitizes_filenames() {
        assert_eq!(sanitize_file_name("auth"), Some("auth.md".into()));
        assert_eq!(sanitize_file_name("auth.md"), Some("auth.md".into()));
        assert!(sanitize_file_name("../evil").is_none());
        assert!(sanitize_file_name("a/b/c.md").is_none());
        assert!(sanitize_file_name(".hidden").is_none());
        assert!(sanitize_file_name("bad name.md").is_none());
    }
}
