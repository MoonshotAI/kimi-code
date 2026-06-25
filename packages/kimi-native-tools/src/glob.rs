/// Glob tool — file pattern matching.
///
/// Finds files matching a glob pattern, sorted by modification time
/// (most recent first). Supports brace expansion and directory filtering.
///
/// Mirrors `packages/agent-core/src/tools/builtin/file/glob.ts`.
use ignore::WalkBuilder;
use napi_derive::napi;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;

/// Maximum number of matches to return.
pub const MAX_MATCHES: usize = 100;
/// Maximum brace expansions before falling through as literal.
const MAX_BRACE_EXPANSIONS: usize = 64;

/// Result of a glob operation.
#[derive(Debug, Clone)]
#[napi(object)]
pub struct GlobResult {
    pub files: Vec<String>,
    pub error: Option<String>,
    pub truncated: bool,
}

/// Glob configuration.
pub struct GlobConfig {
    pub pattern: String,
    pub path: Option<String>,
    pub include_dirs: bool,
}

impl Default for GlobConfig {
    fn default() -> Self {
        Self {
            pattern: String::new(),
            path: None,
            include_dirs: true,
        }
    }
}

/// Find files matching a glob pattern.
///
/// Behavior:
///   - Brace expansion (`*.{ts,tsx}`, `{src,test}/**`) is expanded at this layer.
///   - Results are sorted by modification time (most recent first).
///   - Match count is capped at MAX_MATCHES.
///   - Respects .gitignore rules.
pub fn glob_search(config: &GlobConfig) -> GlobResult {
    let search_path = config
        .path
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));

    if !search_path.exists() {
        return GlobResult {
            files: Vec::new(),
            error: Some(format!("Path does not exist: {}", search_path.display())),
            truncated: false,
        };
    }

    if !search_path.is_dir() {
        return GlobResult {
            files: Vec::new(),
            error: Some(format!("Path is not a directory: {}", search_path.display())),
            truncated: false,
        };
    }

    // Expand braces in the pattern.
    let patterns = expand_braces(&config.pattern);
    let matchers: Vec<globset::GlobMatcher> = patterns
        .iter()
        .filter_map(|p| build_glob_matcher(p))
        .collect();

    if matchers.is_empty() {
        return GlobResult {
            files: Vec::new(),
            error: None,
            truncated: false,
        };
    }

    let mut builder = WalkBuilder::new(&search_path);
    builder.hidden(false);
    builder.git_ignore(true);
    builder.git_exclude(true);

    let include_dirs = config.include_dirs;
    let all_files: Mutex<Vec<(PathBuf, SystemTime)>> = Mutex::new(Vec::new());

    builder.build_parallel().run(|| {
        let matchers = &matchers;
        let all_files = &all_files;
        let search_path = &search_path;

        Box::new(move |entry| {
            if all_files.lock().unwrap().len() >= MAX_MATCHES * 2 {
                return ignore::WalkState::Quit;
            }

            let entry = match entry {
                Ok(e) => e,
                Err(_) => return ignore::WalkState::Continue,
            };

            let path = entry.path();
            let is_dir = entry.file_type().is_some_and(|ft| ft.is_dir());

            if is_dir && !include_dirs {
                return ignore::WalkState::Continue;
            }

            let rel_path = path.strip_prefix(search_path).unwrap_or(path);
            let matches = matchers.iter().any(|m| m.is_match(rel_path) || m.is_match(path));
            if !matches {
                return ignore::WalkState::Continue;
            }

            let mtime = fs::metadata(path)
                .and_then(|m| m.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);

            all_files.lock().unwrap().push((path.to_path_buf(), mtime));
            ignore::WalkState::Continue
        })
    });

    let mut sorted: Vec<(PathBuf, SystemTime)> = all_files.into_inner().unwrap();
    sorted.sort_by_key(|a| std::cmp::Reverse(a.1));

    let truncated = sorted.len() > MAX_MATCHES;
    let files: Vec<String> = sorted
        .into_iter()
        .take(MAX_MATCHES)
        .map(|(p, _)| {
            p.strip_prefix(&search_path)
                .unwrap_or(&p)
                .display()
                .to_string()
        })
        .collect();

    GlobResult {
        files,
        error: None,
        truncated,
    }
}

fn build_glob_matcher(pattern: &str) -> Option<globset::GlobMatcher> {
    globset::GlobBuilder::new(pattern)
        .case_insensitive(true)
        .build()
        .ok()
        .map(|g| g.compile_matcher())
}

/// Expand brace expressions in a glob pattern.
///
/// Supports:
///   - `*.{ts,tsx}` → `["*.ts", "*.tsx"]`
///   - `{src,test}/**` → `["src/**", "test/**"]`
///   - Nested braces: `{a,{b,c}}` → `["a", "b", "c"]`
///   - Cartesian: `{a,b}{c,d}` → `["ac", "ad", "bc", "bd"]`
///
/// Falls through as literal if braces are unbalanced or empty.
fn expand_braces(pattern: &str) -> Vec<String> {
    // Find the first top-level brace group and expand it.
    // Then recursively expand the results.
    if let Some(group) = find_first_brace_group(pattern) {
        let before = &pattern[..group.start];
        let after = &pattern[group.end + 1..];

        let mut results = Vec::new();
        for alt in &group.alternatives {
            let expanded = format!("{}{}{}", before, alt, after);
            // Recursively expand any remaining brace groups.
            let sub_results = expand_braces(&expanded);
            results.extend(sub_results);
        }

        if results.len() > MAX_BRACE_EXPANSIONS {
            return vec![pattern.to_string()];
        }

        results
    } else {
        vec![pattern.to_string()]
    }
}

/// Find the first top-level brace group in a pattern.
fn find_first_brace_group(pattern: &str) -> Option<BraceGroup> {
    let bytes = pattern.as_bytes();
    let mut depth = 0;
    let mut group_start: Option<usize> = None;
    let mut alternatives: Vec<String> = Vec::new();
    let mut current_alt_start = 0;

    for i in 0..bytes.len() {
        match bytes[i] {
            b'{' if depth == 0 => {
                group_start = Some(i);
                current_alt_start = i + 1;
                depth = 1;
            }
            b'{' => {
                depth += 1;
            }
            b'}' if depth > 0 => {
                depth -= 1;
                if depth == 0 {
                    if let Some(start) = group_start {
                        let alt = &pattern[current_alt_start..i];
                        if !alt.is_empty() {
                            alternatives.push(alt.to_string());
                        }

                        if !alternatives.is_empty() {
                            return Some(BraceGroup {
                                start,
                                end: i,
                                alternatives,
                            });
                        }
                    }
                    return None;
                }
            }
            b',' if depth == 1 => {
                let alt = &pattern[current_alt_start..i];
                alternatives.push(alt.to_string());
                current_alt_start = i + 1;
            }
            _ => {}
        }
    }

    None
}

/// A brace group found in a pattern.
struct BraceGroup {
    /// Start index of the opening `{`.
    start: usize,
    /// End index of the closing `}` (inclusive).
    end: usize,
    /// The alternatives inside the braces.
    alternatives: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    fn setup_test_dir() -> TempDir {
        let dir = TempDir::new().unwrap();

        // Create files with different extensions.
        for ext in &["ts", "tsx", "js", "rs", "txt"] {
            let file = dir.path().join(format!("file.{}", ext));
            let mut f = fs::File::create(&file).unwrap();
            writeln!(f, "content of {}", ext).unwrap();
        }

        // Create subdirectory with files.
        let subdir = dir.path().join("subdir");
        fs::create_dir(&subdir).unwrap();
        let file = subdir.join("nested.ts");
        let mut f = fs::File::create(&file).unwrap();
        writeln!(f, "nested content").unwrap();

        dir
    }

    #[test]
    fn test_glob_simple_extension() {
        let dir = setup_test_dir();
        let result = glob_search(&GlobConfig {
            pattern: "*.ts".to_string(),
            path: Some(dir.path().to_str().unwrap().to_string()),
            include_dirs: false,
        });
        assert!(result.error.is_none());
        assert!(result.files.iter().any(|f| f.ends_with(".ts")));
    }

    #[test]
    fn test_glob_brace_expansion() {
        let dir = setup_test_dir();
        let result = glob_search(&GlobConfig {
            pattern: "*.{ts,tsx}".to_string(),
            path: Some(dir.path().to_str().unwrap().to_string()),
            include_dirs: false,
        });
        assert!(result.error.is_none());
        assert!(result.files.iter().any(|f| f.ends_with(".ts")));
        assert!(result.files.iter().any(|f| f.ends_with(".tsx")));
    }

    #[test]
    fn test_glob_recursive() {
        let dir = setup_test_dir();
        let result = glob_search(&GlobConfig {
            pattern: "**/*.ts".to_string(),
            path: Some(dir.path().to_str().unwrap().to_string()),
            include_dirs: false,
        });
        assert!(result.error.is_none());
        // Should find files in subdirectory too.
        assert!(result.files.iter().any(|f| f.contains("nested")));
    }

    #[test]
    fn test_glob_no_matches() {
        let dir = setup_test_dir();
        let result = glob_search(&GlobConfig {
            pattern: "*.py".to_string(),
            path: Some(dir.path().to_str().unwrap().to_string()),
            include_dirs: false,
        });
        assert!(result.error.is_none());
        assert!(result.files.is_empty());
    }

    #[test]
    fn test_glob_nonexistent_path() {
        let result = glob_search(&GlobConfig {
            pattern: "*.ts".to_string(),
            path: Some("/nonexistent/path".to_string()),
            ..Default::default()
        });
        assert!(result.error.is_some());
        assert!(result.error.unwrap().contains("does not exist"));
    }

    #[test]
    fn test_glob_max_matches() {
        let dir = TempDir::new().unwrap();
        // Create more files than MAX_MATCHES.
        for i in 0..150 {
            let file = dir.path().join(format!("file_{:03}.txt", i));
            fs::File::create(&file).unwrap();
        }

        let result = glob_search(&GlobConfig {
            pattern: "*.txt".to_string(),
            path: Some(dir.path().to_str().unwrap().to_string()),
            include_dirs: false,
        });
        assert!(result.error.is_none());
        assert!(result.files.len() <= MAX_MATCHES);
        assert!(result.truncated);
    }

    #[test]
    fn test_brace_expansion_simple() {
        let expanded = expand_braces("*.{ts,tsx}");
        assert_eq!(expanded, vec!["*.ts", "*.tsx"]);
    }

    #[test]
    fn test_brace_expansion_multiple() {
        let expanded = expand_braces("{src,test}/**/*.{ts,tsx}");
        assert_eq!(expanded.len(), 4);
        assert!(expanded.contains(&"src/**/*.ts".to_string()));
        assert!(expanded.contains(&"src/**/*.tsx".to_string()));
        assert!(expanded.contains(&"test/**/*.ts".to_string()));
        assert!(expanded.contains(&"test/**/*.tsx".to_string()));
    }

    #[test]
    fn test_brace_expansion_no_braces() {
        let expanded = expand_braces("*.ts");
        assert_eq!(expanded, vec!["*.ts"]);
    }

    #[test]
    fn test_brace_expansion_unbalanced() {
        let expanded = expand_braces("*.{ts,tsx");
        // Unbalanced braces — should fall through as literal.
        assert_eq!(expanded, vec!["*.{ts,tsx"]);
    }
}
