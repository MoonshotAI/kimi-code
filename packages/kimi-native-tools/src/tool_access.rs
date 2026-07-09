//! Tool resource access conflict detection.
//!
//! Mirrors `packages/agent-core/src/loop/tool-access.ts` so the TS and Rust
//! layers cannot drift on conflict semantics. The TS side passes
//! `ToolAccessMeta[]` across the napi boundary; Rust does the pairwise
//! conflict check at native speed.
//!
//! Only `conflict` is exposed as a napi binding; `resource_accesses_conflict`,
//! `file_operations_conflict`, `file_accesses_overlap`, and `normalize_path`
//! stay private to this module.

use napi_derive::napi;

/// Lightweight projection of a `ToolResourceAccess` for conflict detection.
///
/// `kind` is `"file"` or `"all"`. For `"all"`, the remaining fields are
/// `None` and the access conflicts with everything. For `"file"`,
/// `operation` is `"read"` / `"write"` / `"readwrite"` / `"search"`,
/// `path` is the file path, and `recursive` marks tree-wide access.
#[derive(Debug, Clone)]
#[napi(object)]
pub struct ToolAccessMeta {
    pub kind: String,
    pub operation: Option<String>,
    pub path: Option<String>,
    pub recursive: Option<bool>,
}

/// Whether any access in `left` conflicts with any access in `right`.
///
/// Two accesses conflict when they touch overlapping file paths and at
/// least one side writes. Read-only accesses (read, search) never conflict
/// with each other. `kind: "all"` conflicts with everything.
pub fn conflict(left: &[ToolAccessMeta], right: &[ToolAccessMeta]) -> bool {
    left.iter()
        .any(|l| right.iter().any(|r| resource_accesses_conflict(l, r)))
}

fn resource_accesses_conflict(left: &ToolAccessMeta, right: &ToolAccessMeta) -> bool {
    if left.kind == "all" || right.kind == "all" {
        return true;
    }
    let left_op = match left.operation.as_deref() {
        Some(op) => op,
        None => return false,
    };
    let right_op = match right.operation.as_deref() {
        Some(op) => op,
        None => return false,
    };
    if !file_operations_conflict(left_op, right_op) {
        return false;
    }
    let left_path = match left.path.as_deref() {
        Some(p) => p,
        None => return false,
    };
    let right_path = match right.path.as_deref() {
        Some(p) => p,
        None => return false,
    };
    file_accesses_overlap(left_path, left.recursive.unwrap_or(false), right_path, right.recursive.unwrap_or(false))
}

fn file_operations_conflict(left: &str, right: &str) -> bool {
    file_operation_writes(left) || file_operation_writes(right)
}

fn file_operation_writes(operation: &str) -> bool {
    matches!(operation, "write" | "readwrite")
}

fn file_accesses_overlap(
    left_path: &str,
    left_recursive: bool,
    right_path: &str,
    right_recursive: bool,
) -> bool {
    let left_normalized = normalize_path(left_path);
    let right_normalized = normalize_path(right_path);
    if left_normalized == right_normalized {
        return true;
    }

    let left_prefix = if left_normalized.ends_with('/') {
        left_normalized.clone()
    } else {
        format!("{}/", left_normalized)
    };
    let right_prefix = if right_normalized.ends_with('/') {
        right_normalized.clone()
    } else {
        format!("{}/", right_normalized)
    };

    (left_recursive && right_normalized.starts_with(&left_prefix))
        || (right_recursive && left_normalized.starts_with(&right_prefix))
}

fn normalize_path(path: &str) -> String {
    let mut normalized = path.replace('\\', "/");
    while normalized.contains("//") {
        normalized = normalized.replace("//", "/");
    }
    let folded = normalized.to_lowercase();
    if folded.len() > 1 && folded.ends_with('/') {
        folded[..folded.len() - 1].to_string()
    } else {
        folded
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file_access(operation: &str, path: &str, recursive: bool) -> ToolAccessMeta {
        ToolAccessMeta {
            kind: "file".to_string(),
            operation: Some(operation.to_string()),
            path: Some(path.to_string()),
            recursive: Some(recursive),
        }
    }

    fn all_access() -> ToolAccessMeta {
        ToolAccessMeta {
            kind: "all".to_string(),
            operation: None,
            path: None,
            recursive: None,
        }
    }

    // ---- conflict: basic cases ----

    #[test]
    fn empty_accesses_never_conflict() {
        let empty: Vec<ToolAccessMeta> = vec![];
        let write = vec![file_access("write", "/a", false)];
        assert!(!conflict(&empty, &write));
        assert!(!conflict(&write, &empty));
        assert!(!conflict(&empty, &empty));
    }

    #[test]
    fn all_conflicts_with_everything() {
        let all = vec![all_access()];
        let read = vec![file_access("read", "/a", false)];
        let write = vec![file_access("write", "/b", false)];
        assert!(conflict(&all, &read));
        assert!(conflict(&read, &all));
        assert!(conflict(&all, &write));
        assert!(conflict(&all, &all));
    }

    #[test]
    fn read_read_no_conflict() {
        let a = vec![file_access("read", "/a", false)];
        let b = vec![file_access("read", "/a", false)];
        assert!(!conflict(&a, &b));
    }

    #[test]
    fn read_write_same_path_conflicts() {
        let read = vec![file_access("read", "/a", false)];
        let write = vec![file_access("write", "/a", false)];
        assert!(conflict(&read, &write));
        assert!(conflict(&write, &read));
    }

    #[test]
    fn search_read_no_conflict() {
        let search = vec![file_access("search", "/a", true)];
        let read = vec![file_access("read", "/a", false)];
        assert!(!conflict(&search, &read));
    }

    #[test]
    fn different_paths_no_conflict() {
        let a = vec![file_access("write", "/a", false)];
        let b = vec![file_access("write", "/b", false)];
        assert!(!conflict(&a, &b));
    }

    // ---- recursive path overlap ----

    #[test]
    fn recursive_write_conflicts_with_child_read() {
        let parent = vec![file_access("write", "/parent", true)];
        let child = vec![file_access("read", "/parent/child", false)];
        assert!(conflict(&parent, &child));
    }

    #[test]
    fn non_recursive_write_no_conflict_with_child() {
        let parent = vec![file_access("write", "/parent", false)];
        let child = vec![file_access("read", "/parent/child", false)];
        assert!(!conflict(&parent, &child));
    }

    #[test]
    fn recursive_read_no_conflict_with_recursive_read() {
        let a = vec![file_access("read", "/parent", true)];
        let b = vec![file_access("read", "/parent/child", true)];
        assert!(!conflict(&a, &b));
    }

    #[test]
    fn recursive_read_conflicts_with_recursive_write() {
        let read = vec![file_access("read", "/parent", true)];
        let write = vec![file_access("write", "/parent/child", true)];
        assert!(conflict(&read, &write));
    }

    // ---- path normalization ----

    #[test]
    fn backslash_normalized_to_forward_slash() {
        let a = vec![file_access("write", r"C:\Users\test", false)];
        let b = vec![file_access("read", "c:/users/test", false)];
        assert!(conflict(&a, &b));
    }

    #[test]
    fn trailing_slash_normalized() {
        let a = vec![file_access("write", "/a/b/", false)];
        let b = vec![file_access("read", "/a/b", false)];
        assert!(conflict(&a, &b));
    }

    #[test]
    fn double_slashes_collapsed() {
        let a = vec![file_access("write", "/a//b", false)];
        let b = vec![file_access("read", "/a/b", false)];
        assert!(conflict(&a, &b));
    }

    #[test]
    fn case_insensitive_match() {
        let a = vec![file_access("write", "/A/B", false)];
        let b = vec![file_access("read", "/a/b", false)];
        assert!(conflict(&a, &b));
    }

    // ---- multiple accesses ----

    #[test]
    fn multiple_accesses_any_conflict() {
        let left = vec![
            file_access("read", "/x", false),
            file_access("write", "/a", false),
        ];
        let right = vec![
            file_access("read", "/y", false),
            file_access("read", "/a", false),
        ];
        assert!(conflict(&left, &right));
    }

    #[test]
    fn multiple_accesses_no_conflict() {
        let left = vec![
            file_access("read", "/x", false),
            file_access("write", "/a", false),
        ];
        let right = vec![
            file_access("read", "/y", false),
            file_access("read", "/z", false),
        ];
        assert!(!conflict(&left, &right));
    }
}
