//! Path canonicalization and containment — pure lexical operations.
//!
//! Ported from `packages/agent-core/src/tools/policies/path-access.ts`.
//! Security-critical: runs on every Read/Write/Edit/Grep/Glob call.

/// Path class: POSIX or Windows (Win32).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathClass {
    Posix,
    Win32,
}

impl PathClass {
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "posix" => Some(Self::Posix),
            "win32" => Some(Self::Win32),
            _ => None,
        }
    }
}

/// Win32/Cygwin user-path normalization.
///
/// - Bare root `/` stays as `/`.
/// - `//` paths are unchanged.
/// - `/cygdrive/X` or `/X` → `X:` (drive letter).
pub fn normalize_user_path(path: &str, path_class: PathClass) -> String {
    if path_class != PathClass::Win32 {
        return path.to_string();
    }
    if path == "/" {
        return "/".to_string();
    }
    if path.starts_with("//") {
        return path.to_string();
    }
    if let Some((drive, prefix_len)) = regex_cygdrive(path) {
        let rest = &path[prefix_len..];
        return format!("{}:{}", drive, if rest.is_empty() { "/" } else { rest });
    }
    if let Some((drive, prefix_len)) = regex_drive(path) {
        let rest = &path[prefix_len..];
        return format!("{}:{}", drive, if rest.is_empty() { "/" } else { rest });
    }
    path.to_string()
}

fn regex_cygdrive(path: &str) -> Option<(String, usize)> {
    if !path.starts_with("/cygdrive/") {
        return None;
    }
    let bytes = path.as_bytes();
    if bytes.len() < 11 {
        return None;
    }
    let drive = bytes[10];
    if drive.is_ascii_alphabetic() {
        Some(((drive as char).to_uppercase().to_string(), 11))
    } else {
        None
    }
}

fn regex_drive(path: &str) -> Option<(String, usize)> {
    let bytes = path.as_bytes();
    if bytes.len() >= 3 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b'/' {
        return Some(((bytes[1] as char).to_uppercase().to_string(), 2));
    }
    if bytes.len() == 2 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() {
        return Some(((bytes[1] as char).to_uppercase().to_string(), 2));
    }
    None
}

/// Expand `~` → home_dir.
pub fn expand_user_path(path: &str, home_dir: Option<&str>, path_class: PathClass) -> String {
    let Some(home) = home_dir else {
        return path.to_string();
    };
    if path == "~" {
        return home.to_string();
    }
    if path.starts_with("~/") {
        return format!("{}{}", home, &path[1..]);
    }
    if path_class == PathClass::Win32 && path.starts_with("~\\") {
        return format!("{}{}", home, &path[1..]);
    }
    path.to_string()
}

/// Lexical canonicalization: relative → absolute against `cwd`, then normalize.
/// No filesystem I/O.
pub fn canonicalize_path(path: &str, cwd: &str, path_class: PathClass) -> Result<String, String> {
    if path.is_empty() {
        return Err("PATH_INVALID: Path cannot be empty".to_string());
    }
    if path_class == PathClass::Win32 && is_win32_drive_relative(path) {
        return Err(format!(
            "PATH_INVALID: \"{path}\" is a drive-relative Windows path. \
             Use an absolute path like C:\\path or a path relative to the working directory."
        ));
    }
    let abs_path = if is_absolute(path, path_class) {
        path.to_string()
    } else {
        if !is_absolute(cwd, path_class) {
            return Err(format!(
                "PATH_INVALID: Cannot resolve \"{path}\" against non-absolute cwd \"{cwd}\"."
            ));
        }
        join_path(cwd, path, path_class)
    };
    Ok(normalize_path(&abs_path, path_class))
}

/// Glob-aware canonicalization: normalizes only the path prefix before the
/// first `/`-separated component that contains a glob metacharacter (`*`, `?`,
/// `[`, `{`), leaving the glob suffix untouched. This preserves glob semantics
/// (`**`, `[a-z]`, etc.) that would be destroyed by lexical normalization.
pub fn canonicalize_path_for_glob(
    path: &str,
    cwd: &str,
    path_class: PathClass,
) -> Result<String, String> {
    if path.is_empty() {
        return Err("PATH_INVALID: Path cannot be empty".to_string());
    }
    // Split at the glob component boundary so the separator preceding the
    // glob component stays with the suffix.
    let split_at = find_glob_component_split(path);
    let (prefix, glob_suffix) = path.split_at(split_at);

    if prefix.is_empty() {
        return Ok(path.to_string());
    }

    // Strip a trailing separator from the prefix before normalization so
    // normalize_path doesn't see an empty trailing segment.
    let prefix = prefix.trim_end_matches(if path_class == PathClass::Win32 {
        &['/', '\\'][..]
    } else {
        &['/'][..]
    });

    if prefix.is_empty() {
        return Ok(path.to_string());
    }

    // Canonicalize the non-glob prefix the same way as canonicalize_path.
    let normalized_prefix = if is_absolute(prefix, path_class) {
        normalize_path(prefix, path_class)
    } else if !is_absolute(cwd, path_class) {
        return Err(format!(
            "PATH_INVALID: Cannot resolve \"{path}\" against non-absolute cwd \"{cwd}\"."
        ));
    } else {
        let abs = join_path(cwd, prefix, path_class);
        normalize_path(&abs, path_class)
    };

    let sep = if path_class == PathClass::Win32 { '\\' } else { '/' };
    Ok(format!("{}{}{}", normalized_prefix, sep, glob_suffix))
}

/// Returns the byte index where the glob-containing component begins (i.e.
/// the position right after the `/` that precedes the glob component).
fn find_glob_component_split(path: &str) -> usize {
    let first_glob = path.find(['*', '?', '[', '{']).unwrap_or(path.len());
    match path[..first_glob].rfind('/') {
        Some(slash_idx) => slash_idx + 1,
        None => first_glob,
    }
}

fn is_win32_drive_relative(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes.len() == 2 || (bytes[2] != b'\\' && bytes[2] != b'/'))
}

fn is_absolute(path: &str, path_class: PathClass) -> bool {
    if path_class == PathClass::Win32 {
        // C:\path, \\server\share, or /path (POSIX-style on Win32 host)
        path.len() >= 2 && path[..2].chars().next().unwrap().is_ascii_alphabetic()
            && path.as_bytes()[1] == b':'
            || path.starts_with("\\\\")
            || path.starts_with('/')
    } else {
        path.starts_with('/')
    }
}

fn join_path(base: &str, rel: &str, path_class: PathClass) -> String {
    let sep = if path_class == PathClass::Win32 { '\\' } else { '/' };
    if base.ends_with('/') || base.ends_with('\\') {
        format!("{}{}", base, rel)
    } else {
        format!("{}{}{}", base, sep, rel)
    }
}

fn normalize_path(path: &str, path_class: PathClass) -> String {
    let sep = if path_class == PathClass::Win32 { '\\' } else { '/' };
    let slash_sep = if path_class == PathClass::Win32 { '/' } else { '\\' };
    let normalized = path.replace(slash_sep, &sep.to_string());
    let parts: Vec<&str> = normalized.split(sep).collect();
    let mut result: Vec<&str> = Vec::new();
    let is_abs = normalized.starts_with(sep);
    for part in parts {
        match part {
            "" | "." => {}
            ".." => {
                if let Some(last) = result.last() {
                    if *last != ".." {
                        result.pop();
                    } else {
                        result.push("..");
                    }
                } else if !is_abs {
                    result.push("..");
                }
            }
            _ => result.push(part),
        }
    }
    let joined = result.join(&sep.to_string());
    if is_abs {
        format!("{}{}", sep, joined)
    } else if joined.is_empty() {
        ".".to_string()
    } else {
        joined
    }
}

/// True iff `candidate` is `base` itself or a descendant, compared on
/// path-component boundaries. Both arguments must already be canonical.
pub fn is_within_directory(candidate: &str, base: &str, path_class: PathClass) -> bool {
    let nc = normalize_path(candidate, path_class);
    let nb = normalize_path(base, path_class);
    let (comp_c, comp_b) = if path_class == PathClass::Win32 {
        (nc.to_lowercase(), nb.to_lowercase())
    } else {
        (nc, nb)
    };
    if comp_c == comp_b {
        return true;
    }
    let sep = if path_class == PathClass::Win32 { '\\' } else { '/' };
    let prefix = if comp_b.ends_with('/') || comp_b.ends_with('\\') {
        comp_b.clone()
    } else {
        format!("{}{}", comp_b, sep)
    };
    comp_c.starts_with(&prefix)
}

/// True iff `candidate` sits inside any of the workspace roots.
pub fn is_within_workspace(candidate: &str, roots: &[String], path_class: PathClass) -> bool {
    for root in roots {
        if is_within_directory(candidate, root, path_class) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_user_path_posix() {
        assert_eq!(normalize_user_path("/foo/bar", PathClass::Posix), "/foo/bar");
        assert_eq!(normalize_user_path("relative", PathClass::Posix), "relative");
    }

    #[test]
    fn test_normalize_user_path_win32_cygdrive() {
        assert_eq!(normalize_user_path("/cygdrive/c/path", PathClass::Win32), "C:/path");
        assert_eq!(normalize_user_path("/cygdrive/z", PathClass::Win32), "Z:/");
    }

    #[test]
    fn test_normalize_user_path_win32_drive() {
        assert_eq!(normalize_user_path("/c/path", PathClass::Win32), "C:/path");
        assert_eq!(normalize_user_path("/z", PathClass::Win32), "Z:/");
    }

    #[test]
    fn test_normalize_user_path_win32_bare_root() {
        assert_eq!(normalize_user_path("/", PathClass::Win32), "/");
        assert_eq!(normalize_user_path("//server", PathClass::Win32), "//server");
    }

    #[test]
    fn test_expand_user_path_posix() {
        assert_eq!(expand_user_path("~/foo", Some("/home/user"), PathClass::Posix), "/home/user/foo");
        assert_eq!(expand_user_path("~", Some("/home/user"), PathClass::Posix), "/home/user");
        assert_eq!(expand_user_path("/abs", Some("/home/user"), PathClass::Posix), "/abs");
    }

    #[test]
    fn test_expand_user_path_win32() {
        assert_eq!(expand_user_path("~\\foo", Some("C:\\User"), PathClass::Win32), "C:\\User\\foo");
    }

    #[test]
    fn test_canonicalize_empty() {
        assert!(canonicalize_path("", "/cwd", PathClass::Posix).is_err());
    }

    #[test]
    fn test_canonicalize_drive_relative_win32() {
        assert!(canonicalize_path("C:path", "C:\\cwd", PathClass::Win32).is_err());
    }

    #[test]
    fn test_canonicalize_relative() {
        assert_eq!(canonicalize_path("foo/bar", "/cwd", PathClass::Posix).unwrap(), "/cwd/foo/bar");
        assert_eq!(canonicalize_path("./foo", "/cwd", PathClass::Posix).unwrap(), "/cwd/foo");
    }

    #[test]
    fn test_canonicalize_dotdot() {
        assert_eq!(canonicalize_path("foo/../bar", "/cwd", PathClass::Posix).unwrap(), "/cwd/bar");
        assert_eq!(canonicalize_path("../bar", "/cwd/sub", PathClass::Posix).unwrap(), "/cwd/bar");
    }

    #[test]
    fn test_canonicalize_already_absolute() {
        assert_eq!(canonicalize_path("/foo/bar", "/cwd", PathClass::Posix).unwrap(), "/foo/bar");
    }

    #[test]
    fn test_is_within_directory_exact() {
        assert!(is_within_directory("/workspace/file", "/workspace", PathClass::Posix));
    }

    #[test]
    fn test_is_within_directory_descendant() {
        assert!(is_within_directory("/workspace/sub/file", "/workspace", PathClass::Posix));
    }

    #[test]
    fn test_is_within_directory_shared_prefix_escape() {
        assert!(!is_within_directory("/workspace-evil", "/workspace", PathClass::Posix));
        assert!(!is_within_directory("/workspace/sub/../../../etc/passwd", "/workspace", PathClass::Posix));
    }

    #[test]
    fn test_is_within_directory_win32_case() {
        assert!(is_within_directory("C:/Workspace/File", "c:/workspace", PathClass::Win32));
    }

    #[test]
    fn test_canonicalize_for_glob_match() {
        // Plain canonicalize (no glob chars) — behaves same for both.
        assert_eq!(
            canonicalize_path("./src/**", "/workspace", PathClass::Posix).unwrap(),
            "/workspace/src/**"
        );
        assert_eq!(
            canonicalize_path("/workspace/src/a.ts", "/workspace", PathClass::Posix).unwrap(),
            "/workspace/src/a.ts"
        );
    }

    #[test]
    fn test_canonicalize_path_for_glob() {
        // Glob suffix is preserved; only prefix is normalized.
        assert_eq!(
            canonicalize_path_for_glob("./src/**", "/workspace", PathClass::Posix).unwrap(),
            "/workspace/src/**"
        );
        // Absolute glob pattern.
        assert_eq!(
            canonicalize_path_for_glob("/workspace/src/**", "/workspace", PathClass::Posix).unwrap(),
            "/workspace/src/**"
        );
        // Pattern starting with glob char — untouched.
        assert_eq!(
            canonicalize_path_for_glob("**/*.ts", "/workspace", PathClass::Posix).unwrap(),
            "**/*.ts"
        );
        // Character class glob.
        assert_eq!(
            canonicalize_path_for_glob("./src/file[0-9].txt", "/workspace", PathClass::Posix).unwrap(),
            "/workspace/src/file[0-9].txt"
        );
        // Brace glob.
        assert_eq!(
            canonicalize_path_for_glob("./src/*.{ts,js}", "/workspace", PathClass::Posix).unwrap(),
            "/workspace/src/*.{ts,js}"
        );
        // No glob chars — same as canonicalize_path.
        assert_eq!(
            canonicalize_path_for_glob("./src/file.txt", "/workspace", PathClass::Posix).unwrap(),
            "/workspace/src/file.txt"
        );
        // Question mark glob.
        assert_eq!(
            canonicalize_path_for_glob("./src/file?.txt", "/workspace", PathClass::Posix).unwrap(),
            "/workspace/src/file?.txt"
        );
    }

    #[test]
    fn test_is_within_workspace_multi_root() {
        let roots = vec!["/primary".to_string(), "/secondary".to_string()];
        assert!(is_within_workspace("/primary/file", &roots, PathClass::Posix));
        assert!(is_within_workspace("/secondary/file", &roots, PathClass::Posix));
        assert!(!is_within_workspace("/other/file", &roots, PathClass::Posix));
    }
}
