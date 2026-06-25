/// List directory — compact 2-level directory tree for LLM context.
///
/// Mirrors `packages/agent-core/src/tools/support/list-directory.ts`.
///
/// Width caps keep the system-prompt token budget bounded:
///   - Depth 0 (root):  up to LIST_DIR_ROOT_WIDTH entries
///   - Depth 1 (children of root dirs): up to LIST_DIR_CHILD_WIDTH entries
///   - Truncated levels show "... and N more" so the LLM knows more exists.
use napi_derive::napi;
use std::fs;
use std::path::Path;

/// Maximum number of entries at the root level.
pub const LIST_DIR_ROOT_WIDTH: usize = 30;
/// Maximum number of entries per child directory.
pub const LIST_DIR_CHILD_WIDTH: usize = 10;

/// Result of a list-directory operation.
#[derive(Debug, Clone)]
#[napi(object)]
pub struct ListDirectoryResult {
    pub output: String,
    pub error: Option<String>,
}

/// Configuration for list_directory.
pub struct ListDirectoryConfig {
    pub path: Option<String>,
    pub collapse_hidden_dirs: bool,
}

impl Default for ListDirectoryConfig {
    fn default() -> Self {
        Self {
            path: None,
            collapse_hidden_dirs: false,
        }
    }
}

#[derive(Debug, Clone)]
struct Entry {
    name: String,
    is_dir: bool,
}

/// Collect sorted entries from a directory, capped at `max_width`.
/// Returns (entries, total_count, readable).
fn collect_entries(dir_path: &Path, max_width: usize) -> (Vec<Entry>, usize, bool) {
    let mut all: Vec<Entry> = Vec::new();

    match fs::read_dir(dir_path) {
        Ok(iter) => {
            for entry in iter.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                // Use the entry's file_type to avoid an extra stat call.
                let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
                all.push(Entry { name, is_dir });
            }
        }
        Err(_) => {
            return (Vec::new(), 0, false);
        }
    }

    let total = all.len();

    // Sort: directories first, then alphabetically (case-insensitive).
    all.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    let entries = if all.len() > max_width {
        all.into_iter().take(max_width).collect()
    } else {
        all
    };

    (entries, total, true)
}

fn should_collapse_directory(entry: &Entry, collapse_hidden_dirs: bool) -> bool {
    collapse_hidden_dirs && entry.is_dir && entry.name.starts_with('.')
}

/// Return a 2-level tree listing of `work_dir` suitable for inclusion in a
/// tool error message. Returns `"(empty directory)"` if the directory is
/// empty, or an error marker line if the directory itself is unreadable.
pub fn list_directory(config: &ListDirectoryConfig) -> ListDirectoryResult {
    let work_dir = config
        .path
        .as_deref()
        .map(Path::new)
        .unwrap_or_else(|| Path::new("."));

    if !work_dir.exists() {
        return ListDirectoryResult {
            output: String::new(),
            error: Some(format!("{} does not exist", work_dir.display())),
        };
    }
    if !work_dir.is_dir() {
        return ListDirectoryResult {
            output: String::new(),
            error: Some(format!("{} is not a directory", work_dir.display())),
        };
    }

    let mut lines: Vec<String> = Vec::new();
    let (entries, total, readable) = collect_entries(work_dir, LIST_DIR_ROOT_WIDTH);

    if !readable {
        return ListDirectoryResult {
            output: "[not readable]".to_string(),
            error: None,
        };
    }

    let remaining = total.saturating_sub(entries.len());

    for (i, entry) in entries.iter().enumerate() {
        let is_last = i == entries.len() - 1 && remaining == 0;
        let connector = if is_last { "└── " } else { "├── " };

        if entry.is_dir {
            lines.push(format!("{}{}/", connector, entry.name));

            if should_collapse_directory(entry, config.collapse_hidden_dirs) {
                continue;
            }

            let child_prefix = if is_last { "    " } else { "│   " };
            let child_dir = work_dir.join(&entry.name);
            let (child_entries, child_total, child_readable) =
                collect_entries(&child_dir, LIST_DIR_CHILD_WIDTH);

            if !child_readable {
                lines.push(format!("{}└── [not readable]", child_prefix));
                continue;
            }

            let child_remaining = child_total.saturating_sub(child_entries.len());

            for (j, ce) in child_entries.iter().enumerate() {
                let c_is_last = j == child_entries.len() - 1 && child_remaining == 0;
                let c_connector = if c_is_last { "└── " } else { "├── " };
                let suffix = if ce.is_dir { "/" } else { "" };
                lines.push(format!(
                    "{}{}{}{}",
                    child_prefix, c_connector, ce.name, suffix
                ));
            }

            if child_remaining > 0 {
                lines.push(format!(
                    "{}└── ... and {} more",
                    child_prefix, child_remaining
                ));
            }
        } else {
            lines.push(format!("{}{}", connector, entry.name));
        }
    }

    if remaining > 0 {
        lines.push(format!("└── ... and {} more entries", remaining));
    }

    let output = if lines.is_empty() {
        "(empty directory)".to_string()
    } else {
        lines.join("\n")
    };

    ListDirectoryResult {
        output,
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn setup_test_dir() -> TempDir {
        let dir = TempDir::new().unwrap();
        // Create some files and directories.
        fs::write(dir.path().join("README.md"), "# Test").unwrap();
        fs::write(dir.path().join("package.json"), "{}").unwrap();
        fs::create_dir(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src").join("main.ts"), "// main").unwrap();
        fs::create_dir(dir.path().join("test")).unwrap();
        fs::write(dir.path().join("test").join("main.test.ts"), "// test").unwrap();
        // Hidden directory (collapsed by default).
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".git").join("config"), "").unwrap();
        dir
    }

    #[test]
    fn test_list_directory_basic() {
        let dir = setup_test_dir();
        let config = ListDirectoryConfig {
            path: Some(dir.path().to_string_lossy().to_string()),
            collapse_hidden_dirs: false,
        };
        let result = list_directory(&config);
        assert!(result.error.is_none());
        let output = result.output;
        // Should contain the directories and files we created.
        assert!(output.contains("src/"));
        assert!(output.contains("test/"));
        assert!(output.contains("README.md"));
        assert!(output.contains("package.json"));
        // .git should be listed when not collapsing hidden dirs.
        assert!(output.contains(".git/"));
    }

    #[test]
    fn test_list_directory_collapse_hidden() {
        let dir = setup_test_dir();
        let config = ListDirectoryConfig {
            path: Some(dir.path().to_string_lossy().to_string()),
            collapse_hidden_dirs: true,
        };
        let result = list_directory(&config);
        assert!(result.error.is_none());
        let output = result.output;
        // .git should be listed but its children should not be expanded.
        assert!(output.contains(".git/"));
        // The children of .git should not appear (collapsed).
        assert!(!output.contains("config"));
    }

    #[test]
    fn test_list_directory_empty() {
        let dir = TempDir::new().unwrap();
        let config = ListDirectoryConfig {
            path: Some(dir.path().to_string_lossy().to_string()),
            collapse_hidden_dirs: false,
        };
        let result = list_directory(&config);
        assert!(result.error.is_none());
        assert_eq!(result.output, "(empty directory)");
    }

    #[test]
    fn test_list_directory_not_found() {
        let config = ListDirectoryConfig {
            path: Some("/nonexistent/path/12345".to_string()),
            collapse_hidden_dirs: false,
        };
        let result = list_directory(&config);
        assert!(result.error.is_some());
        assert!(result.error.unwrap().contains("does not exist"));
    }

    #[test]
    fn test_list_directory_not_a_directory() {
        let dir = setup_test_dir();
        let file_path = dir.path().join("README.md");
        let config = ListDirectoryConfig {
            path: Some(file_path.to_string_lossy().to_string()),
            collapse_hidden_dirs: false,
        };
        let result = list_directory(&config);
        assert!(result.error.is_some());
        assert!(result.error.unwrap().contains("is not a directory"));
    }

    #[test]
    fn test_list_directory_child_truncation() {
        let dir = TempDir::new().unwrap();
        // Create a directory with more than LIST_DIR_CHILD_WIDTH files.
        let sub = dir.path().join("many");
        fs::create_dir(&sub).unwrap();
        for i in 0..(LIST_DIR_CHILD_WIDTH + 5) {
            fs::write(sub.join(format!("file_{}.txt", i)), "").unwrap();
        }
        let config = ListDirectoryConfig {
            path: Some(dir.path().to_string_lossy().to_string()),
            collapse_hidden_dirs: false,
        };
        let result = list_directory(&config);
        assert!(result.error.is_none());
        let output = result.output;
        // Should show truncation message.
        assert!(output.contains("... and 5 more"));
    }
}
