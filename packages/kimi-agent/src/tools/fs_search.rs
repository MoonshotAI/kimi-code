//! FsSearch — filename search for the `@` file-mention picker.
//!
//! A pure, synchronous port of the upstream `sessionFs` search semantics
//! (`agent-core-v2/src/session/sessionFs/fsService.ts` `search` / `walk` /
//! `matcher`, and `fsSearch.ts` `computeFuzzyScore`) that the native toolset
//! can run without the JS host:
//!
//! - Empty query: lists the workspace root's *top-level* entries only —
//!   directories first, hidden entries excluded, `<root>/.gitignore` and
//!   `exclude_globs` respected — so the mention picker has an initial set the
//!   moment `@` is typed.
//! - Non-empty query: walks the workspace (up to `WALK_MAX_DEPTH`) and keeps
//!   entries whose *name* case-insensitively contains the query as a
//!   subsequence (the upstream fuzzy scorer), capped at `limit`.
//!
//! The tool executes natively when the search root is inside the sandbox;
//! anything else falls back to the host. Mirrors the `FS_SEARCH_TOOL_NAME`
//! registration in `NativeToolset::tool_definitions`.

use std::path::Path;

// ── Constants ───────────────────────────────────────────────────────────

/// The tool name that NativeToolset registers.
pub const FS_SEARCH_TOOL_NAME: &str = "FsSearch";
/// Default hit limit (upstream `fsSearchRequestSchema` default).
pub const DEFAULT_LIMIT: usize = 50;
/// Maximum hit limit (upstream `fsSearchRequestSchema` max).
const MAX_LIMIT: usize = 200;
/// Walk depth cap (upstream `WALK_MAX_DEPTH`).
const WALK_MAX_DEPTH: usize = 64;

// ── Types ───────────────────────────────────────────────────────────────

/// A single fs:search hit, relative to the workspace root.
#[derive(Debug, Clone, PartialEq)]
pub struct FsSearchHit {
    /// Workspace-relative path, `/`-separated.
    pub path: String,
    /// Base name of the entry.
    pub name: String,
    /// Whether the entry is a directory (symlinks are treated as non-dirs,
    /// matching the upstream `walk`'s `isDirectory && !isSymbolicLink`).
    pub is_dir: bool,
    /// Fuzzy match score in `0.0..=1.0`; the upstream scorer is effectively
    /// binary (full subsequence → 1.0, otherwise 0.0). Top-level entries in
    /// the empty-query listing score 1.0.
    pub score: f64,
}

/// Options controlling an fs:search run.
#[derive(Debug, Clone)]
pub struct FsSearchOptions {
    /// Maximum number of hits (clamped to `1..=MAX_LIMIT`).
    pub limit: usize,
    /// Respect `<root>/.gitignore` (and always skip `.git`). Mirrors the
    /// upstream `follow_gitignore` request field.
    pub follow_gitignore: bool,
    /// Extra glob patterns; workspace-relative paths matching any of them
    /// are excluded from the results. Mirrors `exclude_globs`.
    pub exclude_globs: Vec<String>,
}

impl Default for FsSearchOptions {
    fn default() -> Self {
        Self {
            limit: DEFAULT_LIMIT,
            follow_gitignore: true,
            exclude_globs: Vec::new(),
        }
    }
}

// ── Search ──────────────────────────────────────────────────────────────

/// Search `root` for `query` (empty query → top-level listing), up to `limit`
/// hits. Returns `Err` when the root is not an accessible directory.
pub fn fs_search(root: &Path, query: &str, limit: usize) -> Result<Vec<FsSearchHit>, String> {
    fs_search_with(root, query, FsSearchOptions { limit, ..FsSearchOptions::default() })
}

/// `fs_search` with full options (gitignore and exclude globs).
pub fn fs_search_with(
    root: &Path,
    query: &str,
    opts: FsSearchOptions,
) -> Result<Vec<FsSearchHit>, String> {
    let root = std::fs::canonicalize(root)
        .map_err(|e| format!("workspace root {} is not accessible: {e}", root.display()))?;
    if !root.is_dir() {
        return Err(format!("workspace root {} is not a directory", root.display()));
    }
    let limit = opts.limit.clamp(1, MAX_LIMIT);
    let query_lower = query.to_lowercase();
    let exclude = build_globset(&opts.exclude_globs)?;
    if query_lower.is_empty() {
        top_level_entries(&root, &opts, exclude.as_ref(), limit)
    } else {
        search_walk(&root, &query_lower, &opts, exclude.as_ref(), limit)
    }
}

/// Empty query: list the root's top-level entries — directories first, then
/// name ascending. Hidden names, `.git`, gitignored entries, and excluded
/// globs are dropped before sorting.
fn top_level_entries(
    root: &Path,
    opts: &FsSearchOptions,
    exclude: Option<&globset::GlobSet>,
    limit: usize,
) -> Result<Vec<FsSearchHit>, String> {
    let matcher = if opts.follow_gitignore { load_gitignore_matcher(root) } else { None };
    let mut hits: Vec<FsSearchHit> = Vec::new();
    let entries = std::fs::read_dir(root)
        .map_err(|e| format!("failed to read workspace root {}: {e}", root.display()))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" || is_hidden(&name) {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if let Some(ig) = &matcher {
            if ig.matched(&entry.path(), is_dir).is_ignore() {
                continue;
            }
        }
        if let Some(gs) = exclude {
            if gs.is_match(&name) {
                continue;
            }
        }
        hits.push(FsSearchHit { path: name.clone(), name, is_dir, score: 1.0 });
    }
    // Directories first, then name ascending (upstream `type_first` sort).
    hits.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    hits.truncate(limit);
    Ok(hits)
}

/// Non-empty query: walk `root` and keep entries whose name fuzzy-matches the
/// query, ranked by score then path, capped at `limit`. The walker applies
/// the same filters as the top-level listing (hidden, `.git`, root
/// `.gitignore`, exclude globs).
fn search_walk(
    root: &Path,
    query_lower: &str,
    opts: &FsSearchOptions,
    exclude: Option<&globset::GlobSet>,
    limit: usize,
) -> Result<Vec<FsSearchHit>, String> {
    let mut builder = ignore::WalkBuilder::new(root);
    builder
        .hidden(true) // dotfiles excluded (matches the top-level listing)
        .ignore(false) // no `.ignore` files — upstream reads only <root>/.gitignore
        .git_ignore(false) // applied manually below via the root matcher
        .git_global(false)
        .git_exclude(false)
        .parents(false)
        .follow_links(false)
        .max_depth(Some(WALK_MAX_DEPTH));
    if opts.follow_gitignore {
        if let Some(ig) = load_gitignore_matcher(root) {
            builder.filter_entry(move |entry| {
                if entry.depth() == 0 {
                    return true;
                }
                let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
                !ig.matched(entry.path(), is_dir).is_ignore()
            });
        }
    }
    let walker = builder.build();

    let mut hits: Vec<FsSearchHit> = Vec::new();
    for entry in walker.flatten() {
        if entry.depth() == 0 {
            continue;
        }
        let Some(file_type) = entry.file_type() else { continue };
        let is_dir = file_type.is_dir();
        if !is_dir && !file_type.is_file() && !file_type.is_symlink() {
            continue;
        }
        let Some(name_os) = entry.path().file_name() else { continue };
        let name = name_os.to_string_lossy().into_owned();
        let score = compute_fuzzy_score(&name, query_lower);
        if score <= 0.0 {
            continue;
        }
        let rel = rel_display(entry.path().strip_prefix(root).unwrap_or(entry.path()));
        if let Some(gs) = exclude {
            if gs.is_match(&rel) {
                continue;
            }
        }
        hits.push(FsSearchHit { path: rel, name, is_dir, score });
    }
    // Score desc, then path asc (upstream `b.score - a.score` + localeCompare;
    // the scorer is binary, so this is effectively path-ascending).
    hits.sort_by(|a, b| {
        b.score.total_cmp(&a.score).then_with(|| a.path.cmp(&b.path))
    });
    hits.truncate(limit);
    Ok(hits)
}

// ── Matching helpers ────────────────────────────────────────────────────

/// Upstream `computeFuzzyScore`: case-insensitive subsequence match of the
/// query's characters in the name, with a startswith bonus. Because every
/// query character must match (the first miss zeroes the score), the result
/// is effectively binary: full subsequence → 1.0, otherwise 0.0.
fn compute_fuzzy_score(name: &str, query_lower: &str) -> f64 {
    if query_lower.is_empty() {
        return 0.0;
    }
    let name_lower = name.to_lowercase();
    let name_chars: Vec<char> = name_lower.chars().collect();
    let mut matched = 0usize;
    let mut name_idx = 0usize;
    for ch in query_lower.chars() {
        let Some(found) = name_chars.iter().skip(name_idx).position(|&c| c == ch) else {
            return 0.0;
        };
        matched += 1;
        name_idx += found + 1;
    }
    let mut score = matched as f64 / query_lower.chars().count() as f64;
    if name_lower.starts_with(query_lower) {
        score = (score + 0.2).min(1.0);
    }
    score.clamp(0.0, 1.0)
}

/// Hidden entries: dotfiles (upstream `HIDDEN_NAME_RE = /^\./`; the
/// `MACOS_NOISE` set is subsumed since every member starts with `.`).
fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

/// Build a gitignore matcher rooted at `root`, reading `<root>/.gitignore`
/// when present. Mirrors the upstream `matcher()` (root `.gitignore` plus
/// `.git/`, which the callers also skip by name). A malformed `.gitignore`
/// degrades to no matcher (ignore support disabled) instead of failing the
/// whole search.
fn load_gitignore_matcher(root: &Path) -> Option<ignore::gitignore::Gitignore> {
    let path = root.join(".gitignore");
    if !path.is_file() {
        return None;
    }
    let mut builder = ignore::gitignore::GitignoreBuilder::new(root);
    builder.add(path);
    builder.build().ok()
}

/// Compile exclude globs into a matcher. `Ok(None)` when there are none.
fn build_globset(globs: &[String]) -> Result<Option<globset::GlobSet>, String> {
    if globs.is_empty() {
        return Ok(None);
    }
    let mut builder = globset::GlobSetBuilder::new();
    for g in globs {
        let glob = globset::Glob::new(g)
            .map_err(|e| format!("invalid exclude glob {g:?}: {e}"))?;
        builder.add(glob);
    }
    builder.build().map(Some).map_err(|e| e.to_string())
}

/// Normalize a workspace-relative path to `/`-separated display form.
fn rel_display(rel: &Path) -> String {
    let s = rel.to_string_lossy();
    if s.contains('\\') {
        s.replace('\\', "/")
    } else {
        s.into_owned()
    }
}

// ── Tool definition for NativeToolset registration ──────────────────────

/// The tool description sent to the LLM.
pub fn description() -> &'static str {
    "Search file and directory names in the workspace for the @ file-mention picker. \
     An empty query lists the workspace root's top-level entries (directories first); \
     a non-empty query fuzzy-matches entry names (case-insensitive subsequence), up to \
     `limit` hits (default 50, max 200)."
}

/// Return the JSON input schema for the FsSearch tool.
pub fn input_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Filename query. Empty to list the workspace root's top-level entries (directories first)."
            },
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 200,
                "description": "Maximum number of results (default 50)."
            },
            "workspace_root": {
                "type": "string",
                "description": "Workspace root to search. Defaults to the toolset's workspace root."
            }
        },
        "required": ["query"]
    })
}

/// Render hits as one workspace-relative path per line, directories suffixed
/// with `/`. Used by `NativeToolset` to turn a hit list into tool output.
pub fn render_hits(hits: &[FsSearchHit]) -> String {
    if hits.is_empty() {
        return "No files found.".to_string();
    }
    let mut lines: Vec<String> = Vec::with_capacity(hits.len());
    for hit in hits {
        let mut line = hit.path.clone();
        if hit.is_dir {
            line.push('/');
        }
        lines.push(line);
    }
    lines.join("\n")
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(hits: &[FsSearchHit]) -> Vec<String> {
        hits.iter().map(|h| h.path.clone()).collect()
    }

    /// A scratch workspace with top-level files and dirs, nested files, and
    /// hidden entries.
    fn scratch() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("alpha.txt"), "").unwrap();
        std::fs::write(dir.path().join("beta.txt"), "").unwrap();
        std::fs::create_dir(dir.path().join("docs")).unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        std::fs::create_dir_all(dir.path().join("src/lib")).unwrap();
        std::fs::write(dir.path().join("src/lib.rs"), "").unwrap();
        std::fs::write(dir.path().join("src/lib/lib.rs"), "").unwrap();
        std::fs::create_dir(dir.path().join(".hidden_dir")).unwrap();
        std::fs::write(dir.path().join(".hidden.txt"), "").unwrap();
        dir
    }

    #[test]
    fn empty_query_lists_top_level_dirs_first() {
        let dir = scratch();
        let hits = fs_search(dir.path(), "", 50).unwrap();
        let names = paths(&hits);
        // Directories first (name-ascending), then files (name-ascending);
        // nested entries are not part of the top-level listing.
        assert_eq!(names, vec!["docs", "src", "alpha.txt", "beta.txt"]);
        assert!(hits[0].is_dir && hits[1].is_dir);
        assert!(!hits[2].is_dir && !hits[3].is_dir);
        assert_eq!(hits[0].score, 1.0);
    }

    #[test]
    fn empty_query_excludes_hidden_entries() {
        let dir = scratch();
        let hits = fs_search(dir.path(), "", 50).unwrap();
        let names = paths(&hits);
        assert!(!names.iter().any(|n| n.starts_with('.')));
    }

    #[test]
    fn empty_query_honors_limit() {
        let dir = scratch();
        let hits = fs_search(dir.path(), "", 2).unwrap();
        assert_eq!(paths(&hits), vec!["docs", "src"]);
    }

    #[test]
    fn empty_query_respects_gitignore() {
        let dir = scratch();
        std::fs::write(dir.path().join("ignored.txt"), "").unwrap();
        std::fs::create_dir(dir.path().join("ignored_dir")).unwrap();
        std::fs::write(dir.path().join("ignored_dir/x.txt"), "").unwrap();
        std::fs::write(
            dir.path().join(".gitignore"),
            "ignored.txt\nignored_dir/\n",
        )
        .unwrap();
        let hits = fs_search(dir.path(), "", 50).unwrap();
        let names = paths(&hits);
        assert!(!names.contains(&"ignored.txt".to_string()));
        assert!(!names.contains(&"ignored_dir".to_string()));
        assert!(names.contains(&"alpha.txt".to_string()));
        assert!(names.contains(&"src".to_string()));
    }

    #[test]
    fn empty_query_respects_exclude_globs() {
        let dir = scratch();
        std::fs::create_dir(dir.path().join("build")).unwrap();
        std::fs::write(dir.path().join("build/out.txt"), "").unwrap();
        let opts = FsSearchOptions {
            exclude_globs: vec!["build".into(), "build/**".into()],
            ..FsSearchOptions::default()
        };
        let hits = fs_search_with(dir.path(), "", opts).unwrap();
        let names = paths(&hits);
        assert!(!names.contains(&"build".to_string()));
        assert!(names.contains(&"src".to_string()));
    }

    #[test]
    fn non_empty_query_matches_names_across_depths() {
        let dir = scratch();
        let hits = fs_search(dir.path(), "lib", 50).unwrap();
        let names = paths(&hits);
        // Name-based fuzzy match: the `src` dir's name does not match, but
        // `src/lib`, `src/lib.rs` and `src/lib/lib.rs` do.
        assert!(names.contains(&"src/lib".to_string()));
        assert!(names.contains(&"src/lib.rs".to_string()));
        assert!(names.contains(&"src/lib/lib.rs".to_string()));
        assert!(!names.contains(&"src".to_string()));
        assert!(!names.contains(&"docs".to_string()));
    }

    #[test]
    fn non_empty_query_ranks_prefix_matches_first() {
        let dir = scratch();
        std::fs::write(dir.path().join("lib.rs"), "").unwrap();
        let hits = fs_search(dir.path(), "lib", 50).unwrap();
        let names = paths(&hits);
        // All matches score 1.0; ties break on path ascending, so the
        // top-level `lib.rs` outranks the nested `src/lib` entries.
        assert_eq!(names[0], "lib.rs");
        assert!(names.contains(&"src/lib/lib.rs".to_string()));
    }

    #[test]
    fn non_empty_query_matches_subsequence_not_just_substring() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("kimi-code.rs"), "").unwrap();
        std::fs::write(dir.path().join("kimo.txt"), "").unwrap();
        let hits = fs_search(dir.path(), "kc", 50).unwrap();
        let names = paths(&hits);
        // "kc" is a subsequence of "kimi-code.rs" but not of "kimo.txt".
        assert!(names.contains(&"kimi-code.rs".to_string()));
        assert!(!names.contains(&"kimo.txt".to_string()));
    }

    #[test]
    fn non_empty_query_excludes_hidden_entries() {
        let dir = scratch();
        std::fs::write(dir.path().join("src/.cached.rs"), "").unwrap();
        let hits = fs_search(dir.path(), "cached", 50).unwrap();
        let names = paths(&hits);
        assert!(!names.iter().any(|n| n.contains(".cached")));
    }

    #[test]
    fn non_empty_query_honors_limit() {
        let dir = scratch();
        let hits = fs_search(dir.path(), "ib", 1).unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn fuzzy_score_matches_upstream_semantics() {
        // Full subsequence → 1.0; missing any character → 0.0; empty query → 0.0.
        assert_eq!(compute_fuzzy_score("alpha.txt", "al"), 1.0);
        assert_eq!(compute_fuzzy_score("alpha.txt", "pat"), 1.0);
        assert_eq!(compute_fuzzy_score("alpha.txt", "plt"), 0.0); // wrong order
        assert_eq!(compute_fuzzy_score("alpha.txt", "aa"), 1.0);
        assert_eq!(compute_fuzzy_score("alpha.txt", "plx"), 0.0);
        assert_eq!(compute_fuzzy_score("alpha.txt", ""), 0.0);
        // Case-insensitive (the query is lowercased by the caller, matching
        // the upstream `queryLower` contract).
        assert_eq!(compute_fuzzy_score("Alpha.Txt", "al"), 1.0);
    }

    #[test]
    fn missing_root_is_an_error() {
        assert!(fs_search(Path::new("/definitely/not/a/real/dir"), "", 50).is_err());
    }

    #[test]
    fn render_hits_suffixes_directories() {
        let hits = vec![
            FsSearchHit { path: "src".into(), name: "src".into(), is_dir: true, score: 1.0 },
            FsSearchHit { path: "a.txt".into(), name: "a.txt".into(), is_dir: false, score: 1.0 },
        ];
        assert_eq!(render_hits(&hits), "src/\na.txt");
        assert_eq!(render_hits(&[]), "No files found.");
    }
}
