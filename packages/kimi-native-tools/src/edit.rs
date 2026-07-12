/// Edit tool — exact string replacement in a file.
///
/// Replaces the first occurrence of `old_string` with `new_string` by default.
/// When `replace_all` is true, replaces all occurrences.
/// Mirrors `packages/agent-core/src/tools/builtin/file/edit.ts`.
use crate::line_endings::{materialize_model_text, to_model_text_view};
use napi_derive::napi;
use std::fs;
use std::path::Path;

/// Result of an edit operation.
#[derive(Debug, Clone)]
#[napi(object)]
pub struct EditResult {
    pub success: bool,
    pub error: Option<String>,
    pub replacements: i32,
}

/// Edit a file by replacing exact string occurrences.
///
/// Behavior:
///   - Reads the entire file, converts to model text view (CRLF → LF for pure CRLF files).
///   - If `replace_all` is false: requires exactly 1 occurrence of `old_string`.
///   - If `replace_all` is true: replaces all occurrences.
///   - Writes back using the detected line ending style.
///   - `old_string` must be non-empty.
pub fn edit_file(path: &str, old_string: &str, new_string: &str, replace_all: bool) -> EditResult {
    if old_string.is_empty() {
        return EditResult {
            success: false,
            error: Some("old_string must not be empty.".to_string()),
            replacements: 0,
        };
    }

    if old_string == new_string {
        return EditResult {
            success: false,
            error: Some(
                "No changes to make: old_string and new_string are exactly the same.".to_string(),
            ),
            replacements: 0,
        };
    }

    let file_path = Path::new(path);

    // Read file.
    let raw = match fs::read_to_string(file_path) {
        Ok(s) => s,
        Err(e) => {
            let msg = e.to_string();
            if e.kind() == std::io::ErrorKind::NotFound {
                return EditResult {
                    success: false,
                    error: Some(format!("\"{}\" does not exist.", path)),
                    replacements: 0,
                };
            }
            if msg.contains("is a directory") || msg.contains("EISDIR") {
                return EditResult {
                    success: false,
                    error: Some(format!("\"{}\" is not a file.", path)),
                    replacements: 0,
                };
            }
            return EditResult {
                success: false,
                error: Some(msg),
                replacements: 0,
            };
        }
    };

    // Convert to model text view (CRLF → LF normalization for pure CRLF files).
    let model_view = to_model_text_view(&raw);
    let content = &model_view.text;

    if replace_all {
        // Split-join approach for replace all.
        let parts: Vec<&str> = content.split(old_string).collect();
        if parts.len() == 1 {
            return EditResult {
                success: false,
                error: Some(format!(
                    "old_string not found in {}. The file contents may be out of date. Please use the Read Tool to reload the content.",
                    path
                )),
                replacements: 0,
            };
        }
        let count = parts.len() - 1;
        let new_content = parts.join(new_string);
        let disk_content = materialize_model_text(&new_content, model_view.line_ending_style);

        match fs::write(file_path, &disk_content) {
            Ok(()) => EditResult {
                success: true,
                error: None,
                replacements: count as i32,
            },
            Err(e) => EditResult {
                success: false,
                error: Some(e.to_string()),
                replacements: 0,
            },
        }
    } else {
        // Unique match path — count occurrences first.
        let count = count_occurrences(content, old_string);

        match count {
            0 => EditResult {
                success: false,
                error: Some(format!(
                    "old_string not found in {}. The file contents may be out of date. Please use the Read Tool to reload the content.",
                    path
                )),
                replacements: 0,
            },
            1 => {
                let new_content = replace_once(content, old_string, new_string);
                let disk_content = materialize_model_text(&new_content, model_view.line_ending_style);

                match fs::write(file_path, &disk_content) {
                    Ok(()) => EditResult {
                        success: true,
                        error: None,
                        replacements: 1,
                    },
                    Err(e) => EditResult {
                        success: false,
                        error: Some(e.to_string()),
                        replacements: 0,
                    },
                }
            }
            _ => EditResult {
                success: false,
                error: Some(format!(
                    "old_string is not unique in {}. Found {} occurrences. To replace every occurrence, set replace_all=true. To replace only one occurrence, include more surrounding context in old_string.",
                    path, count
                )),
                replacements: 0,
            },
        }
    }
}

/// Count non-overlapping occurrences of `needle` in `haystack`.
fn count_occurrences(haystack: &str, needle: &str) -> usize {
    let mut count = 0;
    let mut pos = 0;
    while let Some(idx) = haystack[pos..].find(needle) {
        count += 1;
        pos += idx + needle.len();
    }
    count
}

/// Replace the first occurrence of `old` with `new` in `content`.
fn replace_once(content: &str, old: &str, new: &str) -> String {
    if let Some(idx) = content.find(old) {
        let mut result = String::with_capacity(content.len() + new.len() - old.len());
        result.push_str(&content[..idx]);
        result.push_str(new);
        result.push_str(&content[idx + old.len()..]);
        result
    } else {
        content.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn write_temp(content: &[u8]) -> NamedTempFile {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(content).unwrap();
        f.flush().unwrap();
        f
    }

    #[test]
    fn test_edit_single_occurrence() {
        let f = write_temp(b"hello world\n");
        let result = edit_file(
            f.path().to_str().unwrap(),
            "world",
            "rust",
            false,
        );
        assert!(result.success);
        assert_eq!(result.replacements, 1);
        let content = fs::read_to_string(f.path()).unwrap();
        assert_eq!(content, "hello rust\n");
    }

    #[test]
    fn test_edit_not_found() {
        let f = write_temp(b"hello world\n");
        let result = edit_file(
            f.path().to_str().unwrap(),
            "xyz",
            "abc",
            false,
        );
        assert!(!result.success);
        assert!(result.error.unwrap().contains("not found"));
    }

    #[test]
    fn test_edit_multiple_occurrences_error() {
        let f = write_temp(b"aaa\n");
        let result = edit_file(
            f.path().to_str().unwrap(),
            "a",
            "b",
            false,
        );
        assert!(!result.success);
        assert!(result.error.unwrap().contains("not unique"));
    }

    #[test]
    fn test_edit_replace_all() {
        let f = write_temp(b"aaa\n");
        let result = edit_file(
            f.path().to_str().unwrap(),
            "a",
            "b",
            true,
        );
        assert!(result.success);
        assert_eq!(result.replacements, 3);
        let content = fs::read_to_string(f.path()).unwrap();
        assert_eq!(content, "bbb\n");
    }

    #[test]
    fn test_edit_empty_old_string() {
        let f = write_temp(b"hello\n");
        let result = edit_file(
            f.path().to_str().unwrap(),
            "",
            "x",
            false,
        );
        assert!(!result.success);
        assert!(result.error.unwrap().contains("must not be empty"));
    }

    #[test]
    fn test_edit_same_string() {
        let f = write_temp(b"hello\n");
        let result = edit_file(
            f.path().to_str().unwrap(),
            "hello",
            "hello",
            false,
        );
        assert!(!result.success);
        assert!(result.error.unwrap().contains("exactly the same"));
    }

    #[test]
    fn test_edit_preserves_crlf() {
        let f = write_temp(b"hello\r\nworld\r\n");
        let result = edit_file(
            f.path().to_str().unwrap(),
            "hello",
            "hi",
            false,
        );
        assert!(result.success);
        let content = fs::read_to_string(f.path()).unwrap();
        assert_eq!(content, "hi\r\nworld\r\n");
    }

    #[test]
    fn test_edit_nonexistent_file() {
        let temp_dir = tempfile::tempdir().unwrap();
        let nonexistent = temp_dir.path().join("nope.txt");
        drop(temp_dir);
        let result = edit_file(
            &nonexistent.to_string_lossy(),
            "old",
            "new",
            false,
        );
        assert!(!result.success);
        assert!(result.error.unwrap().contains("does not exist"));
    }

    #[test]
    fn test_count_occurrences() {
        assert_eq!(count_occurrences("aaa", "a"), 3);
        assert_eq!(count_occurrences("hello", "ll"), 1);
        assert_eq!(count_occurrences("hello", "xyz"), 0);
        assert_eq!(count_occurrences("", "a"), 0);
    }

    #[test]
    fn test_replace_once() {
        assert_eq!(replace_once("hello world", "world", "rust"), "hello rust");
        assert_eq!(replace_once("hello", "xyz", "abc"), "hello");
    }
}
