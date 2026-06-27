/// Grep tool — content search via the `regex` crate.
///
/// Pure-Rust grep implementation. Supports regex patterns, case-insensitive
/// search, context lines, output modes (content/files_with_matches/count),
/// glob filtering, head_limit, and offset.
///
/// Mirrors `packages/agent-core/src/tools/builtin/file/grep.ts`.
use ignore::WalkBuilder;
use napi_derive::napi;
use regex::RegexBuilder;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::file_type::is_sensitive_file;

/// Default head limit for grep output.
pub const DEFAULT_HEAD_LIMIT: usize = 250;
/// Maximum stdout bytes before truncation.
pub const MAX_OUTPUT_BYTES: usize = 512 * 1024;
/// Default timeout for grep searches (milliseconds). Mirrors the TS tool's
/// `DEFAULT_TIMEOUT_MS = 20_000` cap so a runaway walk does not stall the agent.
pub const DEFAULT_TIMEOUT_MS: u64 = 20_000;

/// VCS metadata directories excluded from every grep walk, regardless of
/// `.gitignore`. Mirrors the TS `VCS_DIRECTORIES_TO_EXCLUDE` list.
const VCS_DIRECTORIES_TO_EXCLUDE: &[&str] = &[".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];

/// Result of a grep operation.
#[derive(Debug, Clone)]
#[napi(object)]
pub struct GrepResult {
    pub content: String,
    pub error: Option<String>,
    pub match_count: i32,
    pub file_count: i32,
    /// Sensitive files that matched but were redacted from the output.
    pub filtered_sensitive: Vec<String>,
    /// True if the search terminated because the configured timeout fired.
    pub timed_out: bool,
}

/// Output mode for grep results.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputMode {
    Content,
    FilesWithMatches,
    CountMatches,
}

/// Grep configuration.
pub struct GrepConfig {
    pub pattern: String,
    pub path: Option<String>,
    pub glob: Option<String>,
    /// Ripgrep-style file type filter (`ts`, `py`, `rust`, ...). Resolved
    /// against a built-in extension table — see `file_type_to_globs`.
    pub file_type: Option<String>,
    pub output_mode: OutputMode,
    pub case_insensitive: bool,
    pub line_numbers: bool,
    pub after_context: usize,
    pub before_context: usize,
    pub context: usize,
    pub head_limit: usize,
    pub offset: usize,
    pub multiline: bool,
    /// Skip files excluded by `.gitignore` and friends. Defaults to false
    /// (i.e. ignore rules apply) to mirror the TS default.
    pub include_ignored: bool,
    /// Hard wall-clock timeout. `None` disables the deadline.
    pub timeout_ms: Option<u64>,
}

impl Default for GrepConfig {
    fn default() -> Self {
        Self {
            pattern: String::new(),
            path: None,
            glob: None,
            file_type: None,
            output_mode: OutputMode::FilesWithMatches,
            case_insensitive: false,
            line_numbers: true,
            after_context: 0,
            before_context: 0,
            context: 0,
            head_limit: DEFAULT_HEAD_LIMIT,
            offset: 0,
            multiline: false,
            include_ignored: false,
            timeout_ms: Some(DEFAULT_TIMEOUT_MS),
        }
    }
}

/// A single match result.
struct MatchEntry {
    file: PathBuf,
    line_no: usize,
    line: String,
}

// ============================================================================
// Structured grep (fs:grep service)
// ============================================================================

/// A single structured match for the fs:grep service.
#[derive(Debug, Clone)]
#[napi(object)]
pub struct GrepStructuredMatch {
    /// 1-indexed line number.
    pub line: u32,
    /// 1-indexed column of the first match on the line (byte offset + 1).
    pub col: u32,
    /// Full text of the matched line (no trailing newline).
    pub text: String,
    /// Context lines before the match (up to `context_lines`).
    pub before: Vec<String>,
    /// Context lines after the match (up to `context_lines`).
    pub after: Vec<String>,
}

/// A file with one or more matches.
#[derive(Debug, Clone)]
#[napi(object)]
pub struct GrepStructuredFileHit {
    /// Path relative to the search root (forward slashes).
    pub path: String,
    /// Matches in this file, in order.
    pub matches: Vec<GrepStructuredMatch>,
}

/// Structured grep result — mirrors `FsGrepResponse`.
#[derive(Debug, Clone)]
#[napi(object)]
pub struct GrepStructuredResult {
    pub files: Vec<GrepStructuredFileHit>,
    pub files_scanned: u32,
    pub truncated: bool,
    pub elapsed_ms: u32,
    pub error: Option<String>,
}

/// Configuration for structured grep (fs:grep service).
///
/// Independent from `GrepConfig` — the fs:grep service uses a different
/// field set (include/exclude globs, max_files, max_total_matches) and
/// always returns structured match data rather than a formatted string.
pub struct GrepStructuredConfig {
    /// Search pattern (regex or literal depending on `literal`).
    pub pattern: String,
    /// Root directory to search.
    pub path: String,
    /// If true, treat `pattern` as a literal string (`regex::escape` applied).
    pub literal: bool,
    /// Case-insensitive search.
    pub case_insensitive: bool,
    /// Include only paths matching any of these globs (case-sensitive GlobSet).
    pub include_globs: Vec<String>,
    /// Exclude paths matching any of these globs (case-sensitive GlobSet).
    pub exclude_globs: Vec<String>,
    /// Respect .gitignore / .git/info/exclude. Defaults to true.
    pub follow_gitignore: bool,
    /// Context lines before AND after each match (mirrors FsGrepRequest.context_lines).
    pub context_lines: u32,
    /// Max files to scan (default 200).
    pub max_files: u32,
    /// Max matches per file (default 50).
    pub max_matches_per_file: u32,
    /// Max total matches across all files (default 5000).
    pub max_total_matches: u32,
    /// Wall-clock timeout in milliseconds (default 30000).
    pub timeout_ms: u64,
}

impl Default for GrepStructuredConfig {
    fn default() -> Self {
        Self {
            pattern: String::new(),
            path: ".".to_string(),
            literal: false,
            case_insensitive: false,
            include_globs: Vec::new(),
            exclude_globs: Vec::new(),
            follow_gitignore: true,
            context_lines: 2,
            max_files: 200,
            max_matches_per_file: 50,
            max_total_matches: 5000,
            timeout_ms: 30_000,
        }
    }
}

/// Search for a pattern in files under the given path.
pub fn grep_search(config: &GrepConfig) -> GrepResult {
    let pattern_str = if config.case_insensitive {
        format!("(?i){}", config.pattern)
    } else {
        config.pattern.clone()
    };

    let regex = match RegexBuilder::new(&pattern_str)
        .multi_line(!config.multiline)
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            return GrepResult {
                content: String::new(),
                error: Some(format!("Invalid regex pattern: {}", e)),
                match_count: 0,
                file_count: 0,
                filtered_sensitive: Vec::new(),
                timed_out: false,
            };
        }
    };

    let search_path = config
        .path
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));

    if !search_path.exists() {
        return GrepResult {
            content: String::new(),
            error: Some(format!("Path does not exist: {}", search_path.display())),
            match_count: 0,
            file_count: 0,
            filtered_sensitive: Vec::new(),
            timed_out: false,
        };
    }

    // If search_path is a file, search just that file.
    if search_path.is_file() {
        return search_single_file(&search_path, &regex, config);
    }

    // Build walker with ignore rules (respects .gitignore, etc.).
    // `include_ignored=true` mirrors `rg --no-ignore`: disable .gitignore /
    // .ignore / parent rules entirely, but VCS metadata + sensitive-file
    // guards stay on because we apply them ourselves below.
    let mut builder = WalkBuilder::new(&search_path);
    builder.hidden(false); // Search hidden files
    if config.include_ignored {
        builder.git_ignore(false);
        builder.git_exclude(false);
        builder.git_global(false);
        builder.ignore(false);
        builder.parents(false);
    } else {
        builder.git_ignore(true);
        builder.git_exclude(true);
    }

    // Apply glob filter (user-supplied).
    let glob_filter = config
        .glob
        .as_deref()
        .and_then(|g| globset::GlobBuilder::new(g).build().ok())
        .map(|g| g.compile_matcher());

    // Apply file-type filter (`type=ts` → match `*.ts`, `*.tsx`, etc.).
    // Mirrors the TS `--type` flag forwarded to ripgrep.
    let file_type_globs: Vec<globset::GlobMatcher> = config
        .file_type
        .as_deref()
        .map(file_type_to_globs)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|pat| globset::GlobBuilder::new(&pat).build().ok())
        .map(|g| g.compile_matcher())
        .collect();

    let effective_before = if config.context > 0 {
        config.context
    } else {
        config.before_context
    };
    let effective_after = if config.context > 0 {
        config.context
    } else {
        config.after_context
    };
    let needs_context = effective_before > 0 || effective_after > 0;
    let is_files_with_matches = config.output_mode == OutputMode::FilesWithMatches;
    let needs_full_content = config.output_mode == OutputMode::Content || needs_context;

    // Collect results — use parallel walker for multi-file searches.
    // This mirrors ripgrep's internal approach (same `ignore` crate).
    let file_matches: Mutex<Vec<(PathBuf, usize, std::time::SystemTime)>> = Mutex::new(Vec::new());
    // Cache file content for content mode to avoid re-reading matched files.
    let content_cache: Mutex<Vec<(PathBuf, String)>> = Mutex::new(Vec::new());
    let filtered_sensitive: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let timed_out = AtomicBool::new(false);
    let deadline = config
        .timeout_ms
        .map(|ms| Instant::now() + Duration::from_millis(ms));

    builder.build_parallel().run(|| {
        let regex = &regex;
        let glob_filter = &glob_filter;
        let file_type_globs = &file_type_globs;
        let file_matches = &file_matches;
        let content_cache = &content_cache;
        let filtered_sensitive = &filtered_sensitive;
        let timed_out = &timed_out;
        let deadline = &deadline;
        let search_path = &search_path;

        Box::new(move |entry| {
            if timed_out.load(Ordering::Relaxed) {
                return ignore::WalkState::Quit;
            }
            if let Some(d) = deadline {
                if Instant::now() >= *d {
                    timed_out.store(true, Ordering::Relaxed);
                    return ignore::WalkState::Quit;
                }
            }

            let entry = match entry {
                Ok(e) => e,
                Err(_) => return ignore::WalkState::Continue,
            };

            if entry
                .path()
                .components()
                .any(|c| matches!(c.as_os_str().to_str(), Some(name) if VCS_DIRECTORIES_TO_EXCLUDE.contains(&name)))
            {
                return ignore::WalkState::Continue;
            }

            if !entry.file_type().is_some_and(|ft| ft.is_file()) {
                return ignore::WalkState::Continue;
            }

            let path = entry.path();

            if let Some(ref matcher) = glob_filter {
                if !matcher.is_match(path) {
                    return ignore::WalkState::Continue;
                }
            }

            if !file_type_globs.is_empty() && !file_type_globs.iter().any(|m| m.is_match(path)) {
                return ignore::WalkState::Continue;
            }

            let path_str = path.to_string_lossy();
            if is_sensitive_file(&path_str) {
                filtered_sensitive.lock().unwrap().push(relativize(path, search_path));
                return ignore::WalkState::Continue;
            }

            // Stream file line-by-line instead of loading entirely into memory.
            // For files_with_matches: stop at first match (early termination).
            // For count_matches: count all matches without building output.
            // For content mode: accumulate lines for caching.
            let file = match fs::File::open(path) {
                Ok(f) => f,
                Err(_) => return ignore::WalkState::Continue,
            };
            let reader = BufReader::new(file);
            let mut match_count: usize = 0;
            let mut accumulated_content = String::new();

            if is_files_with_matches {
                // Early termination: stop reading as soon as we find one match.
                for line in reader.lines().map_while(Result::ok) {
                    if regex.find(&line).is_some() {
                        match_count = 1;
                        break;
                    }
                }
            } else if needs_full_content {
                // Content mode: accumulate lines while counting matches.
                for line in reader.lines().map_while(Result::ok) {
                    match_count += regex.find_iter(&line).count();
                    accumulated_content.push_str(&line);
                    accumulated_content.push('\n');
                }
            } else {
                // Count mode: just count matches.
                for line in reader.lines().map_while(Result::ok) {
                    match_count += regex.find_iter(&line).count();
                }
            }

            if match_count > 0 {
                let mtime = fs::metadata(path)
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                file_matches.lock().unwrap().push((path.to_path_buf(), match_count, mtime));
                if needs_full_content && !accumulated_content.is_empty() {
                    content_cache.lock().unwrap().push((path.to_path_buf(), accumulated_content));
                }
            }

            ignore::WalkState::Continue
        })
    });

    let timed_out = timed_out.load(Ordering::Relaxed);
    let mut file_matches: Vec<(PathBuf, usize, std::time::SystemTime)> = file_matches.into_inner().unwrap();
    let filtered_sensitive = filtered_sensitive.into_inner().unwrap();
    let content_cache: Vec<(PathBuf, String)> = content_cache.into_inner().unwrap();
    let total_matches: usize = file_matches.iter().map(|(_, c, _)| c).sum();

    file_matches.sort_by_key(|(_, _, mtime)| std::cmp::Reverse(*mtime));

    let content = if needs_full_content {
        // Use cached content from walker to avoid re-reading matched files.
        let content_map: std::collections::HashMap<&Path, &str> = content_cache
            .iter()
            .map(|(path, content)| (path.as_path(), content.as_str()))
            .collect();

        let mut line_matches: Vec<MatchEntry> = Vec::new();
        let mut output_bytes: usize = 0;
        for (path, _, _) in &file_matches {
            let content_str = match content_map.get(path.as_path()) {
                Some(c) => c.to_string(),
                None => match fs::read_to_string(path) {
                    Ok(c) => c,
                    Err(_) => continue,
                },
            };
            let lines: Vec<&str> = content_str.split('\n').collect();
            let matched_lines: Vec<usize> = lines
                .iter()
                .enumerate()
                .filter(|(_, line)| regex.is_match(line))
                .map(|(i, _)| i)
                .collect();

            for &line_idx in &matched_lines {
                let start = if effective_before > 0 { line_idx.saturating_sub(effective_before) } else { line_idx };
                let end = if effective_after > 0 { (line_idx + effective_after + 1).min(lines.len()) } else { line_idx + 1 };

                for (ctx_idx, line_content) in lines.iter().enumerate().take(end).skip(start) {
                    let line_no = ctx_idx + 1;
                    let entry = MatchEntry { file: path.to_path_buf(), line_no, line: line_content.to_string() };
                    let entry_bytes = format_entry_bytes(&entry, config, &search_path);
                    if output_bytes + entry_bytes > MAX_OUTPUT_BYTES { break; }
                    output_bytes += entry_bytes;
                    line_matches.push(entry);
                }
            }
            if output_bytes > MAX_OUTPUT_BYTES { break; }
        }

        let mut rendered = Vec::new();
        let mut prev_file: Option<PathBuf> = None;
        for entry in &line_matches {
            if prev_file.as_ref() != Some(&entry.file) {
                if prev_file.is_some() { rendered.push("--".to_string()); }
                prev_file = Some(entry.file.clone());
            }
            let rel_path = relativize(&entry.file, &search_path);
            if config.line_numbers {
                rendered.push(format!("{}:{}:{}", rel_path, entry.line_no, entry.line));
            } else {
                rendered.push(format!("{}:{}", rel_path, entry.line));
            }
        }
        rendered.join("\n")
    } else {
        match config.output_mode {
            OutputMode::FilesWithMatches => {
                let files: Vec<String> = file_matches
                    .iter()
                    .skip(config.offset)
                    .take(config.head_limit)
                    .map(|(p, _, _)| relativize(p, &search_path))
                    .collect();
                files.join("\n")
            }
            OutputMode::CountMatches => {
                let mut lines = Vec::new();
                for (path, count, _) in &file_matches {
                    lines.push(format!("{}:{}", relativize(path, &search_path), count));
                }
                lines.join("\n")
            }
            OutputMode::Content => unreachable!(),
        }
    };

    GrepResult {
        content,
        error: None,
        match_count: total_matches as i32,
        file_count: file_matches.len() as i32,
        filtered_sensitive,
        timed_out,
    }
}

/// Search for a pattern in files under the given path, returning structured
/// match data (file → matches with line/col/context).
///
/// Mirrors `fsSearchService.ts:grepWithNode`. Used as the middle tier of the
/// `rg → native → TS fallback` chain in `FsSearchService.grep()`.
///
/// Behavior:
///   - `literal=true` → pattern is regex-escaped (matches fixed strings only).
///   - `case_insensitive=true` → case-insensitive matching.
///   - `include_globs`/`exclude_globs` are compiled into a single `GlobSet`
///     (case-sensitive, `literal_separator(true)` so `*` does not cross `/`,
///     matching `globToRegExp` semantics and ripgrep's `--glob`).
///   - `follow_gitignore=true` → respect .gitignore / .git/info/exclude.
///   - `context_lines` applies to both before and after each match.
///   - Each line records only the first match's column (mirrors TS `re.exec`).
///   - `max_files`, `max_matches_per_file`, `max_total_matches` enforce caps.
///   - `timeout_ms` is a wall-clock deadline; on expiry, returns partial
///     results with `truncated=true`.
///   - File order follows walk order (NOT mtime-sorted) to match TS behavior.
pub fn grep_search_structured(config: &GrepStructuredConfig) -> GrepStructuredResult {
    let started = Instant::now();
    let search_path = PathBuf::from(&config.path);

    if !search_path.exists() {
        return GrepStructuredResult {
            files: Vec::new(),
            files_scanned: 0,
            truncated: false,
            elapsed_ms: started.elapsed().as_millis() as u32,
            error: Some(format!("Path does not exist: {}", search_path.display())),
        };
    }

    // Build regex: apply regex::escape if literal, prepend (?i) if case_insensitive.
    let escaped_pattern = if config.literal {
        regex::escape(&config.pattern)
    } else {
        config.pattern.clone()
    };
    let pattern_str = if config.case_insensitive {
        format!("(?i){}", escaped_pattern)
    } else {
        escaped_pattern
    };
    let regex = match RegexBuilder::new(&pattern_str).build() {
        Ok(r) => r,
        Err(e) => {
            return GrepStructuredResult {
                files: Vec::new(),
                files_scanned: 0,
                truncated: false,
                elapsed_ms: started.elapsed().as_millis() as u32,
                error: Some(format!("Invalid regex pattern: {}", e)),
            };
        }
    };

    let include_set = build_glob_set(&config.include_globs);
    let exclude_set = build_glob_set(&config.exclude_globs);

    let mut builder = WalkBuilder::new(&search_path);
    builder.hidden(false);
    if config.follow_gitignore {
        builder.git_ignore(true);
        builder.git_exclude(true);
    } else {
        builder.git_ignore(false);
        builder.git_exclude(false);
        builder.git_global(false);
        builder.ignore(false);
        builder.parents(false);
    }

    let context_lines = config.context_lines as usize;
    let max_files = config.max_files as usize;
    let max_matches_per_file = config.max_matches_per_file as usize;
    let max_total_matches = config.max_total_matches as usize;
    let timeout_ms = config.timeout_ms;

    let files: Mutex<Vec<GrepStructuredFileHit>> = Mutex::new(Vec::new());
    let files_scanned = AtomicUsize::new(0usize);
    let total_matches = AtomicUsize::new(0usize);
    let truncated = AtomicBool::new(false);
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);

    builder.build_parallel().run(|| {
        let regex = &regex;
        let include_set = &include_set;
        let exclude_set = &exclude_set;
        let files = &files;
        let files_scanned = &files_scanned;
        let total_matches = &total_matches;
        let truncated = &truncated;
        let deadline = &deadline;
        let search_path = &search_path;

        Box::new(move |entry| {
            if truncated.load(Ordering::Relaxed) {
                return ignore::WalkState::Quit;
            }
            if Instant::now() >= *deadline {
                truncated.store(true, Ordering::Relaxed);
                return ignore::WalkState::Quit;
            }

            let entry = match entry {
                Ok(e) => e,
                Err(_) => return ignore::WalkState::Continue,
            };

            // Skip VCS metadata directories.
            if entry
                .path()
                .components()
                .any(|c| matches!(c.as_os_str().to_str(), Some(name) if VCS_DIRECTORIES_TO_EXCLUDE.contains(&name)))
            {
                return ignore::WalkState::Continue;
            }

            if !entry.file_type().is_some_and(|ft| ft.is_file()) {
                return ignore::WalkState::Continue;
            }

            let path = entry.path();
            let rel_path = path.strip_prefix(search_path).unwrap_or(path);
            let rel_str = rel_path.to_string_lossy().replace('\\', "/");

            // Apply glob filters (case-sensitive, mirroring globToRegExp).
            if let Some(ref inc) = *include_set {
                if !inc.is_match(&rel_str) && !inc.is_match(path) {
                    return ignore::WalkState::Continue;
                }
            }
            if let Some(ref exc) = *exclude_set {
                if exc.is_match(&rel_str) || exc.is_match(path) {
                    return ignore::WalkState::Continue;
                }
            }

            // Enforce max_files cap (approximate — parallel workers may overshoot by 1-2).
            if files_scanned.load(Ordering::Relaxed) >= max_files {
                truncated.store(true, Ordering::Relaxed);
                return ignore::WalkState::Quit;
            }
            files_scanned.fetch_add(1, Ordering::Relaxed);

            // Read file content.
            let content = match fs::read_to_string(path) {
                Ok(c) => c,
                Err(_) => return ignore::WalkState::Continue,
            };

            // Split into lines (mirrors TS content.split(/\r?\n/) — uses split('\n')
            // for consistency with existing grep_search).
            let lines: Vec<&str> = content.split('\n').collect();
            let mut matches: Vec<GrepStructuredMatch> = Vec::new();

            for (i, line) in lines.iter().enumerate() {
                if matches.len() >= max_matches_per_file {
                    truncated.store(true, Ordering::Relaxed);
                    break;
                }
                if total_matches.load(Ordering::Relaxed) >= max_total_matches {
                    truncated.store(true, Ordering::Relaxed);
                    break;
                }
                // Find first match only (mirrors TS re.exec(line)).
                if let Some(m) = regex.find(line) {
                    let before_start = i.saturating_sub(context_lines);
                    let before: Vec<String> = lines[before_start..i]
                        .iter()
                        .map(|s| s.to_string())
                        .collect();
                    let after_end = (i + 1 + context_lines).min(lines.len());
                    let after: Vec<String> = lines[i + 1..after_end]
                        .iter()
                        .map(|s| s.to_string())
                        .collect();
                    matches.push(GrepStructuredMatch {
                        line: (i + 1) as u32,
                        col: (m.start() + 1) as u32,
                        text: line.to_string(),
                        before,
                        after,
                    });
                    total_matches.fetch_add(1, Ordering::Relaxed);
                }
            }

            if !matches.is_empty() {
                files.lock().unwrap().push(GrepStructuredFileHit {
                    path: rel_str,
                    matches,
                });
            }

            ignore::WalkState::Continue
        })
    });

    let files = files.into_inner().unwrap();
    let files_scanned = files_scanned.load(Ordering::Relaxed) as u32;
    let truncated = truncated.load(Ordering::Relaxed);

    GrepStructuredResult {
        files,
        files_scanned,
        truncated,
        elapsed_ms: started.elapsed().as_millis() as u32,
        error: None,
    }
}

/// Build a case-sensitive GlobSet from a list of patterns.
///
/// Mirrors `glob::glob_matches_any` — uses `GlobBuilder::new(g)
/// .literal_separator(true).build()` so `*` does not cross `/`, matching
/// `globToRegExp` semantics in `fsSearchService.ts` and ripgrep's `--glob`.
fn build_glob_set(globs: &[String]) -> Option<globset::GlobSet> {
    if globs.is_empty() {
        return None;
    }
    let mut builder = globset::GlobSetBuilder::new();
    for g in globs {
        if let Ok(glob) = globset::GlobBuilder::new(g)
            .literal_separator(true)
            .build()
        {
            builder.add(glob);
        }
    }
    builder.build().ok()
}

fn search_single_file(path: &Path, regex: &regex::Regex, config: &GrepConfig) -> GrepResult {
    // Sensitive-file guard: a caller pointing grep directly at `.env`
    // (or similar) should not be able to bypass the redaction the
    // directory walk applies.
    let path_str = path.to_string_lossy();
    if is_sensitive_file(&path_str) {
        return GrepResult {
            content: String::new(),
            error: None,
            match_count: 0,
            file_count: 0,
            filtered_sensitive: vec![path.display().to_string()],
            timed_out: false,
        };
    }

    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            return GrepResult {
                content: String::new(),
                error: Some(format!("Failed to read {}: {}", path.display(), e)),
                match_count: 0,
                file_count: 0,
                filtered_sensitive: Vec::new(),
                timed_out: false,
            };
        }
    };

    let lines: Vec<&str> = content.split('\n').collect();
    let matched_lines: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| regex.is_match(line))
        .map(|(i, _)| i)
        .collect();

    let match_count = matched_lines.len();

    let effective_before = if config.context > 0 {
        config.context
    } else {
        config.before_context
    };
    let effective_after = if config.context > 0 {
        config.context
    } else {
        config.after_context
    };

    let content = match config.output_mode {
        OutputMode::FilesWithMatches => {
            if match_count > 0 {
                path.display().to_string()
            } else {
                String::new()
            }
        }
        OutputMode::CountMatches => {
            format!("{}:{}", path.display(), match_count)
        }
        OutputMode::Content => {
            let mut rendered = Vec::new();
            let mut shown_lines: std::collections::HashSet<usize> = std::collections::HashSet::new();

            for &line_idx in &matched_lines {
                let start = line_idx.saturating_sub(effective_before);
                let end = (line_idx + effective_after + 1).min(lines.len());

                for (ctx_idx, line_content) in lines.iter().enumerate().take(end).skip(start) {
                    if shown_lines.contains(&ctx_idx) {
                        continue;
                    }
                    shown_lines.insert(ctx_idx);
                    let line_no = ctx_idx + 1;
                    if config.line_numbers {
                        rendered.push(format!("{}:{}", line_no, line_content));
                    } else {
                        rendered.push(line_content.to_string());
                    }
                }
            }

            rendered.join("\n")
        }
    };

    GrepResult {
        content,
        error: None,
        match_count: match_count as i32,
        file_count: if match_count > 0 { 1 } else { 0 },
        filtered_sensitive: Vec::new(),
        timed_out: false,
    }
}

fn format_entry_bytes(entry: &MatchEntry, config: &GrepConfig, base: &Path) -> usize {
    let rel = relativize(&entry.file, base);
    if config.line_numbers {
        rel.len() + 1 + 10 + 1 + entry.line.len() + 1 // path:line_no:line\n
    } else {
        rel.len() + 1 + entry.line.len() + 1 // path:line\n
    }
}

fn relativize(path: &Path, base: &Path) -> String {
    path.strip_prefix(base)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| path.display().to_string())
}

/// Map a ripgrep-style file type name to a list of glob patterns.
///
/// Only the most common languages are covered. Unknown types return an
/// empty list, which makes the search match nothing — same behaviour as
/// `rg --type unknown`, which exits with an error. We choose to fall
/// through silently and rely on the caller's empty result to signal the
/// mismatch, because the agent loop has no UI to escalate a malformed
/// type name into an actionable error.
fn file_type_to_globs(name: &str) -> Vec<String> {
    let lower = name.to_lowercase();
    let exts: &[&str] = match lower.as_str() {
        "ts" => &["ts", "tsx", "cts", "mts"],
        "tsx" => &["tsx"],
        "js" => &["js", "jsx", "cjs", "mjs"],
        "jsx" => &["jsx"],
        "py" | "python" => &["py", "pyi", "pyx"],
        "rs" | "rust" => &["rs"],
        "go" => &["go"],
        "java" => &["java"],
        "kt" | "kotlin" => &["kt", "kts"],
        "rb" | "ruby" => &["rb", "rake", "gemspec"],
        "c" => &["c", "h"],
        "cpp" | "cxx" | "c++" => &["cpp", "cxx", "cc", "hpp", "hxx", "hh", "h"],
        "cs" | "csharp" => &["cs"],
        "swift" => &["swift"],
        "php" => &["php", "phtml"],
        "sh" | "shell" | "bash" => &["sh", "bash", "zsh", "fish"],
        "md" | "markdown" => &["md", "markdown"],
        "json" => &["json"],
        "yaml" | "yml" => &["yaml", "yml"],
        "toml" => &["toml"],
        "xml" => &["xml"],
        "html" => &["html", "htm"],
        "css" => &["css", "scss", "sass", "less"],
        "sql" => &["sql"],
        "lua" => &["lua"],
        "vue" => &["vue"],
        "svelte" => &["svelte"],
        _ => &[],
    };
    exts.iter().map(|ext| format!("**/*.{}", ext)).collect()
}

// ============================================================================
// Structured grep — returns typed match data instead of formatted strings.
// Used by fsSearchService when rg is not available on PATH.
// ============================================================================

/// A single match in a file.
#[derive(Debug, Clone)]
#[napi(object)]
pub struct GrepStructuredMatch {
    pub line: u32,
    pub col: u32,
    pub text: String,
    pub before: Vec<String>,
    pub after: Vec<String>,
}

/// A file hit with its matches.
#[derive(Debug, Clone)]
#[napi(object)]
pub struct GrepStructuredFileHit {
    pub path: String,
    pub matches: Vec<GrepStructuredMatch>,
}

/// Result of a structured grep operation.
#[derive(Debug, Clone)]
#[napi(object)]
pub struct GrepStructuredResult {
    pub files: Vec<GrepStructuredFileHit>,
    pub files_scanned: u32,
    pub truncated: bool,
    pub error: Option<String>,
}

/// Configuration for a structured grep operation.
#[derive(Debug, Clone)]
pub struct GrepStructuredConfig {
    pub pattern: String,
    pub path: String,
    pub literal: bool,
    pub case_insensitive: bool,
    pub include_globs: Option<Vec<String>>,
    pub exclude_globs: Option<Vec<String>>,
    pub context_lines: u32,
    pub max_files: u32,
    pub max_matches_per_file: u32,
    pub max_total_matches: u32,
    pub timeout_ms: u32,
    pub follow_gitignore: bool,
}

/// Search for a pattern in files and return structured match data.
///
/// This is the native replacement for `grepWithNode` in fsSearchService.ts.
/// It walks the directory tree, applies include/exclude globs, reads each
/// file, and collects matches with context lines.
pub fn grep_search_structured(config: &GrepStructuredConfig) -> GrepStructuredResult {
    let pattern_str = if config.literal {
        regex::escape(&config.pattern)
    } else {
        config.pattern.clone()
    };

    let mut regex_builder = RegexBuilder::new(&pattern_str);
    if config.case_insensitive {
        regex_builder.case_insensitive(true);
    }

    let regex = match regex_builder.build() {
        Ok(r) => r,
        Err(e) => {
            return GrepStructuredResult {
                files: Vec::new(),
                files_scanned: 0,
                truncated: false,
                error: Some(format!("Invalid regex pattern: {}", e)),
            };
        }
    };

    let search_path = PathBuf::from(&config.path);
    if !search_path.is_dir() {
        return GrepStructuredResult {
            files: Vec::new(),
            files_scanned: 0,
            truncated: false,
            error: Some(format!("Path is not a directory: {}", search_path.display())),
        };
    }

    let include_set = config
        .include_globs
        .as_ref()
        .and_then(|globs| build_glob_set(globs).ok());

    let exclude_set = config
        .exclude_globs
        .as_ref()
        .and_then(|globs| build_glob_set(globs).ok());

    let deadline = if config.timeout_ms > 0 {
        Some(Instant::now() + Duration::from_millis(config.timeout_ms as u64))
    } else {
        None
    };

    let mut builder = WalkBuilder::new(&search_path);
    builder.hidden(false);
    if config.follow_gitignore {
        builder.git_ignore(true);
        builder.git_exclude(true);
    } else {
        builder.git_ignore(false);
        builder.git_exclude(false);
        builder.git_global(false);
        builder.ignore(false);
        builder.parents(false);
    }

    let files_collected: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
    let timed_out = AtomicBool::new(false);

    builder.build_parallel().run(|| {
        let include_set = &include_set;
        let exclude_set = &exclude_set;
        let files_collected = &files_collected;
        let timed_out = &timed_out;
        let deadline = &deadline;
        let search_path = &search_path;

        Box::new(move |entry| {
            if timed_out.load(Ordering::Relaxed) {
                return ignore::WalkState::Quit;
            }
            if let Some(d) = deadline {
                if Instant::now() >= *d {
                    timed_out.store(true, Ordering::Relaxed);
                    return ignore::WalkState::Quit;
                }
            }

            let entry = match entry {
                Ok(e) => e,
                Err(_) => return ignore::WalkState::Continue,
            };

            if entry
                .path()
                .components()
                .any(|c| matches!(c.as_os_str().to_str(), Some(name) if VCS_DIRECTORIES_TO_EXCLUDE.contains(&name)))
            {
                return ignore::WalkState::Continue;
            }

            if !entry.file_type().is_some_and(|ft| ft.is_file()) {
                return ignore::WalkState::Continue;
            }

            let path = entry.path();
            let rel = relativize(path, search_path);

            if let Some(ref set) = include_set {
                if !set.is_match(&rel) {
                    return ignore::WalkState::Continue;
                }
            }
            if let Some(ref set) = exclude_set {
                if set.is_match(&rel) {
                    return ignore::WalkState::Continue;
                }
            }

            if is_sensitive_file(&path.to_string_lossy()) {
                return ignore::WalkState::Continue;
            }

            files_collected.lock().unwrap().push(path.to_path_buf());
            ignore::WalkState::Continue
        })
    });

    let mut files_collected = files_collected.into_inner().unwrap();
    // Sort for deterministic output — parallel walker order is undefined.
    files_collected.sort();
    let mut files_scanned = 0u32;
    let mut total_matches = 0u32;
    let mut truncated = timed_out.load(Ordering::Relaxed);
    let mut result_files: Vec<GrepStructuredFileHit> = Vec::new();

    for file_path in &files_collected {
        if truncated {
            break;
        }
        if files_scanned >= config.max_files {
            truncated = true;
            break;
        }
        files_scanned += 1;

        let content = match fs::read_to_string(file_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let lines: Vec<&str> = content.split('\n').collect();
        let mut matches: Vec<GrepStructuredMatch> = Vec::new();

        for (line_idx, line) in lines.iter().enumerate() {
            if matches.len() as u32 >= config.max_matches_per_file {
                break;
            }
            if total_matches >= config.max_total_matches {
                truncated = true;
                break;
            }

            let m = match regex.find(line) {
                Some(m) => m,
                None => continue,
            };

            // Collect lines BEFORE the match in forward order (closest line last).
            // The .rev() iterator walks backward from line_idx-1, and we
            // reverse only the k-iteration order so the result is forward.
            let before_count = config.context_lines as usize;
            let before_start = line_idx.saturating_sub(before_count);
            let before: Vec<String> = lines[before_start..line_idx]
                .iter()
                .map(|s| s.to_string())
                .collect();

            let after: Vec<String> = (1..=config.context_lines as usize)
                .filter_map(|k| lines.get(line_idx + k))
                .map(|s| s.to_string())
                .collect();

            matches.push(GrepStructuredMatch {
                line: (line_idx + 1) as u32,
                col: (m.start() + 1) as u32,
                text: line.to_string(),
                before,
                after,
            });
            total_matches += 1;
        }

        if total_matches >= config.max_total_matches {
            truncated = true;
        }

        if !matches.is_empty() {
            let rel = relativize(file_path, &search_path);
            result_files.push(GrepStructuredFileHit {
                path: rel,
                matches,
            });
        }

        if total_matches >= config.max_total_matches {
            break;
        }
    }

    GrepStructuredResult {
        files: result_files,
        files_scanned,
        truncated,
        error: None,
    }
}

fn build_glob_set(globs: &[String]) -> Result<globset::GlobSet, globset::Error> {
    let mut builder = globset::GlobSetBuilder::new();
    for g in globs {
        if let Ok(glob) = globset::GlobBuilder::new(g)
            .literal_separator(true)
            .build()
        {
            builder.add(glob);
        }
    }
    builder.build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    fn setup_test_dir() -> TempDir {
        let dir = TempDir::new().unwrap();
        let file1 = dir.path().join("test1.txt");
        let file2 = dir.path().join("test2.txt");
        let file3 = dir.path().join("subdir").join("test3.txt");

        fs::create_dir_all(file3.parent().unwrap()).unwrap();

        let mut f1 = fs::File::create(&file1).unwrap();
        writeln!(f1, "hello world").unwrap();
        writeln!(f1, "foo bar baz").unwrap();
        writeln!(f1, "hello again").unwrap();

        let mut f2 = fs::File::create(&file2).unwrap();
        writeln!(f2, "nothing here").unwrap();
        writeln!(f2, "some HELLO text").unwrap();

        let mut f3 = fs::File::create(&file3).unwrap();
        writeln!(f3, "nested hello").unwrap();

        dir
    }

    #[test]
    fn test_grep_files_with_matches() {
        let dir = setup_test_dir();
        let result = grep_search(&GrepConfig {
            pattern: "hello".to_string(),
            path: Some(dir.path().to_str().unwrap().to_string()),
            output_mode: OutputMode::FilesWithMatches,
            ..Default::default()
        });
        assert!(result.error.is_none());
        assert!(result.match_count >= 2);
        assert!(result.file_count >= 2);
    }

    #[test]
    fn test_grep_content_mode() {
        let dir = setup_test_dir();
        let result = grep_search(&GrepConfig {
            pattern: "hello".to_string(),
            path: Some(dir.path().to_str().unwrap().to_string()),
            output_mode: OutputMode::Content,
            line_numbers: true,
            ..Default::default()
        });
        assert!(result.error.is_none());
        assert!(result.content.contains("1:hello world"));
    }

    #[test]
    fn test_grep_case_insensitive() {
        let dir = setup_test_dir();
        let result = grep_search(&GrepConfig {
            pattern: "hello".to_string(),
            path: Some(dir.path().to_str().unwrap().to_string()),
            output_mode: OutputMode::Content,
            case_insensitive: true,
            ..Default::default()
        });
        assert!(result.error.is_none());
        assert!(result.content.contains("HELLO"));
    }

    #[test]
    fn test_grep_count_mode() {
        let dir = setup_test_dir();
        let result = grep_search(&GrepConfig {
            pattern: "hello".to_string(),
            path: Some(dir.path().to_str().unwrap().to_string()),
            output_mode: OutputMode::CountMatches,
            case_insensitive: true,
            ..Default::default()
        });
        assert!(result.error.is_none());
        assert!(result.match_count >= 4);
    }

    #[test]
    fn test_grep_invalid_regex() {
        let dir = setup_test_dir();
        let result = grep_search(&GrepConfig {
            pattern: "[invalid".to_string(),
            path: Some(dir.path().to_str().unwrap().to_string()),
            ..Default::default()
        });
        assert!(result.error.is_some());
        assert!(result.error.unwrap().contains("Invalid regex"));
    }

    #[test]
    fn test_grep_nonexistent_path() {
        let result = grep_search(&GrepConfig {
            pattern: "test".to_string(),
            path: Some("/nonexistent/path".to_string()),
            ..Default::default()
        });
        assert!(result.error.is_some());
        assert!(result.error.unwrap().contains("does not exist"));
    }

    #[test]
    fn test_grep_single_file() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("test.txt");
        let mut f = fs::File::create(&file).unwrap();
        writeln!(f, "line one").unwrap();
        writeln!(f, "line two").unwrap();
        writeln!(f, "line three").unwrap();

        let result = grep_search(&GrepConfig {
            pattern: "two".to_string(),
            path: Some(file.to_str().unwrap().to_string()),
            output_mode: OutputMode::Content,
            ..Default::default()
        });
        assert!(result.error.is_none());
        assert_eq!(result.match_count, 1);
        assert!(result.content.contains("line two"));
    }

    #[test]
    fn test_grep_with_context() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("test.txt");
        let mut f = fs::File::create(&file).unwrap();
        writeln!(f, "line 1").unwrap();
        writeln!(f, "line 2").unwrap();
        writeln!(f, "MATCH HERE").unwrap();
        writeln!(f, "line 4").unwrap();
        writeln!(f, "line 5").unwrap();

        let result = grep_search(&GrepConfig {
            pattern: "MATCH".to_string(),
            path: Some(file.to_str().unwrap().to_string()),
            output_mode: OutputMode::Content,
            context: 1,
            ..Default::default()
        });
        assert!(result.error.is_none());
        assert!(result.content.contains("line 2"));
        assert!(result.content.contains("MATCH HERE"));
        assert!(result.content.contains("line 4"));
    }

    // ── Structured grep (fs:grep service) ────────────────────────────────

    #[test]
    fn test_grep_structured_basic() {
        let dir = setup_test_dir();
        let result = grep_search_structured(&GrepStructuredConfig {
            pattern: "hello".to_string(),
            path: dir.path().to_str().unwrap().to_string(),
            context_lines: 0,
            ..Default::default()
        });
        assert!(result.error.is_none());
        assert!(result.files_scanned >= 2);
        // test1.txt contains "hello world" (line 1) and "hello again" (line 3).
        let test1 = result.files.iter().find(|f| f.path == "test1.txt");
        assert!(test1.is_some(), "test1.txt should be in results");
        let matches = &test1.unwrap().matches;
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].line, 1);
        assert_eq!(matches[0].text, "hello world");
        assert_eq!(matches[0].col, 1);
        assert_eq!(matches[1].line, 3);
        assert_eq!(matches[1].text, "hello again");
    }

    #[test]
    fn test_grep_structured_literal() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("test.txt");
        let mut f = fs::File::create(&file).unwrap();
        writeln!(f, "1 + 2 = 3").unwrap();
        writeln!(f, "no match here").unwrap();

        // literal=true: pattern "+" is escaped, matches literal "+".
        let result = grep_search_structured(&GrepStructuredConfig {
            pattern: "+".to_string(),
            path: dir.path().to_str().unwrap().to_string(),
            literal: true,
            context_lines: 0,
            ..Default::default()
        });
        assert!(result.error.is_none());
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].matches.len(), 1);
        assert_eq!(result.files[0].matches[0].line, 1);
        assert_eq!(result.files[0].matches[0].col, 3); // "+" is at byte offset 2 (0-indexed) → col 3
    }

    #[test]
    fn test_grep_structured_case_insensitive() {
        let dir = setup_test_dir();
        // "HELLO" appears in test2.txt line 2.
        let result = grep_search_structured(&GrepStructuredConfig {
            pattern: "hello".to_string(),
            path: dir.path().to_str().unwrap().to_string(),
            case_insensitive: true,
            context_lines: 0,
            ..Default::default()
        });
        assert!(result.error.is_none());
        let test2 = result.files.iter().find(|f| f.path == "test2.txt");
        assert!(test2.is_some(), "test2.txt should match with case_insensitive");
        assert_eq!(test2.unwrap().matches[0].text, "some HELLO text");
    }

    #[test]
    fn test_grep_structured_context_lines() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("ctx.txt");
        let mut f = fs::File::create(&file).unwrap();
        writeln!(f, "line 1").unwrap();
        writeln!(f, "line 2").unwrap();
        writeln!(f, "MATCH").unwrap();
        writeln!(f, "line 4").unwrap();
        writeln!(f, "line 5").unwrap();

        let result = grep_search_structured(&GrepStructuredConfig {
            pattern: "MATCH".to_string(),
            path: dir.path().to_str().unwrap().to_string(),
            context_lines: 2,
            ..Default::default()
        });
        assert!(result.error.is_none());
        assert_eq!(result.files.len(), 1);
        let m = &result.files[0].matches[0];
        assert_eq!(m.line, 3);
        assert_eq!(m.before, vec!["line 1".to_string(), "line 2".to_string()]);
        assert_eq!(m.after, vec!["line 4".to_string(), "line 5".to_string()]);
    }

    #[test]
    fn test_grep_structured_include_globs() {
        let dir = setup_test_dir();
        // Only include test1.txt — should not return test2.txt or subdir/test3.txt.
        let result = grep_search_structured(&GrepStructuredConfig {
            pattern: "hello".to_string(),
            path: dir.path().to_str().unwrap().to_string(),
            include_globs: vec!["test1.txt".to_string()],
            case_insensitive: true,
            context_lines: 0,
            ..Default::default()
        });
        assert!(result.error.is_none());
        let paths: Vec<&str> = result.files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.iter().all(|p| *p == "test1.txt"), "only test1.txt should match");
    }

    #[test]
    fn test_grep_structured_exclude_globs() {
        let dir = setup_test_dir();
        // Exclude test1.txt — should still return test2.txt and subdir/test3.txt.
        let result = grep_search_structured(&GrepStructuredConfig {
            pattern: "hello".to_string(),
            path: dir.path().to_str().unwrap().to_string(),
            exclude_globs: vec!["test1.txt".to_string()],
            case_insensitive: true,
            context_lines: 0,
            ..Default::default()
        });
        assert!(result.error.is_none());
        let paths: Vec<&str> = result.files.iter().map(|f| f.path.as_str()).collect();
        assert!(!paths.contains(&"test1.txt"), "test1.txt should be excluded");
        assert!(paths.contains(&"test2.txt") || paths.contains(&"subdir/test3.txt"));
    }

    #[test]
    fn test_grep_structured_max_matches_per_file() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("many.txt");
        let mut f = fs::File::create(&file).unwrap();
        for i in 0..10 {
            writeln!(f, "match {}", i).unwrap();
        }

        let result = grep_search_structured(&GrepStructuredConfig {
            pattern: "match".to_string(),
            path: dir.path().to_str().unwrap().to_string(),
            max_matches_per_file: 3,
            context_lines: 0,
            ..Default::default()
        });
        assert!(result.error.is_none());
        assert_eq!(result.files[0].matches.len(), 3);
        assert!(result.truncated);
    }

    #[test]
    fn test_grep_structured_truncated_max_total() {
        let dir = TempDir::new().unwrap();
        // Create 5 files, each with 2 matches → 10 total.
        for i in 0..5 {
            let file = dir.path().join(format!("file{}.txt", i));
            let mut f = fs::File::create(&file).unwrap();
            writeln!(f, "match one").unwrap();
            writeln!(f, "match two").unwrap();
        }

        let result = grep_search_structured(&GrepStructuredConfig {
            pattern: "match".to_string(),
            path: dir.path().to_str().unwrap().to_string(),
            max_total_matches: 4,
            context_lines: 0,
            ..Default::default()
        });
        assert!(result.error.is_none());
        assert!(result.truncated);
        let total: usize = result.files.iter().map(|f| f.matches.len()).sum();
        assert_eq!(total, 4);
    }

    #[test]
    fn test_grep_structured_nonexistent_path() {
        let result = grep_search_structured(&GrepStructuredConfig {
            pattern: "x".to_string(),
            path: "/nonexistent/path/xyz".to_string(),
            context_lines: 0,
            ..Default::default()
        });
        assert!(result.error.is_some());
        assert!(result.error.unwrap().contains("does not exist"));
        assert_eq!(result.files.len(), 0);
    }

    #[test]
    fn test_grep_structured_invalid_regex() {
        let dir = setup_test_dir();
        let result = grep_search_structured(&GrepStructuredConfig {
            pattern: "[invalid".to_string(),
            path: dir.path().to_str().unwrap().to_string(),
            literal: false,
            context_lines: 0,
            ..Default::default()
        });
        assert!(result.error.is_some());
        assert!(result.error.unwrap().contains("Invalid regex"));
    }

    #[test]
    fn test_grep_structured_no_matches() {
        let dir = setup_test_dir();
        let result = grep_search_structured(&GrepStructuredConfig {
            pattern: "zzz_nonexistent_zzz".to_string(),
            path: dir.path().to_str().unwrap().to_string(),
            context_lines: 0,
            ..Default::default()
        });
        assert!(result.error.is_none());
        assert_eq!(result.files.len(), 0);
        assert!(!result.truncated);
    }
}
