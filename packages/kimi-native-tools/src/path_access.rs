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

// ── Sensitive file detection ─────────────────────────────────────────────────

// Single source of truth lives in `kimi-shared::sensitive` (extracted from
// this module's former `is_sensitive_file` / `looks_like_private_key_content`
// and the agent's mirror `permission::sensitive_path`). Re-exported here so
// the `path_access::is_sensitive_file` path keeps working unchanged.
// `allow(unused_imports)`: the crate currently has no internal caller of these
// two (they are a preserved public path), so plain re-exports would warn.
#[allow(unused_imports)]
pub use kimi_shared::sensitive::{is_sensitive_file, looks_like_private_key_content};

// ── Symlink escape detection ─────────────────────────────────────────────────

/// Best-effort path class inference from a path string. `check_symlink_escape`
/// has no path-class argument, so infer it: a drive letter or a backslash
/// separator marks a Win32 path, anything else is treated as POSIX. Root
/// arguments are compared with the same class so both sides stay consistent.
fn infer_path_class(path: &str) -> PathClass {
    let bytes = path.as_bytes();
    let win32 = path.contains('\\')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':');
    if win32 {
        PathClass::Win32
    } else {
        PathClass::Posix
    }
}

/// Check whether a path is a symlink that escapes the allowed workspace.
///
/// Returns `Ok(())` if the path is safe, or `Err` with a description if the
/// path is a symlink pointing outside the given workspace roots.
///
/// This resolves the symlink and checks if the target is within any of the
/// workspace roots. If the path is not a symlink, it returns Ok.
pub fn check_symlink_escape(path: &str, roots: &[String]) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(path).map_err(|e| format!("Cannot access path: {}", e))?;
    if !meta.file_type().is_symlink() {
        return Ok(());
    }

    let target = std::fs::read_link(path).map_err(|e| format!("Cannot read symlink: {}", e))?;

    // Check if the target is within any workspace root.
    let target_abs = if target.is_relative() {
        // Resolve relative symlink target against the symlink's parent directory.
        if let Some(parent) = std::path::Path::new(path).parent() {
            parent.join(&target)
        } else {
            target
        }
    } else {
        target
    };

    // Compare on path-component boundaries (never string prefix): with
    // `root = /workspace` a string-prefix check wrongly accepts
    // `/workspace-evil/...`. `is_within_directory` normalizes `.`/`..` and
    // compares component-wise, so it handles the lexical `..` the join above
    // may have introduced.
    let path_class = infer_path_class(path);
    let target_abs_str = target_abs.to_string_lossy();
    let is_safe = roots
        .iter()
        .any(|root| is_within_directory(&target_abs_str, root, path_class));

    if is_safe {
        Ok(())
    } else {
        Err(format!(
            "SYMLINK_ESCAPE: \"{}\" is a symlink to \"{}\", which is outside the allowed workspace(s)",
            path, target_abs_str
        ))
    }
}

/// Post-open descriptor validation (TOCTOU hardening).
///
/// Verifies that the just-opened `file` refers to the same file as the
/// canonical form of `path`. On Unix this compares the fstat `(dev, ino)` of
/// the open descriptor against the stat `(dev, ino)` of the canonicalized
/// path and fails closed on any mismatch — i.e. when a path component was
/// swapped for a symlink (or the file replaced) between the caller's
/// containment check and this open.
///
/// When `path` does not exist yet (write-to-new-file), the canonical parent is
/// used as the anchor, mirroring the agent's `resolve_for_write` semantics.
///
/// The check is only defined on Unix: there is no portable descriptor
/// identity on other platforms, so the function is compiled out there and
/// callers must rely on their earlier containment check alone.
///
/// Note: an *in-flight* swap that is reverted before the post-open `stat` is
/// still detected (the fd is pinned to the pre-swap inode). A swap that
/// persists can only be defeated by a root-aware open (`openat2(2)` with
/// `RESOLVE_BENEATH` on Linux) — tracked as follow-up.
#[cfg(unix)]
pub fn validate_opened_file(path: &str, file: &std::fs::File) -> Result<(), String> {
    use std::io::ErrorKind;
    use std::os::unix::fs::MetadataExt;
    use std::path::Path;

    let canonical = match std::fs::canonicalize(path) {
        Ok(c) => c,
        Err(e) if e.kind() == ErrorKind::NotFound => {
            // The file may have just been created by `open(O_CREAT)`; anchor
            // on the canonical parent + final component instead.
            let p = Path::new(path);
            let name = p
                .file_name()
                .ok_or_else(|| "PATH_INVALID: cannot identify file name".to_string())?;
            let parent = p
                .parent()
                .filter(|x| !x.as_os_str().is_empty())
                .ok_or_else(|| "PATH_INVALID: path has no parent directory".to_string())?;
            std::fs::canonicalize(parent)
                .map_err(|e| format!("Cannot canonicalize parent: {e}"))?
                .join(name)
        }
        Err(e) => return Err(format!("Cannot canonicalize path: {e}")),
    };

    // File::metadata() on a File performs fstat — the identity of the *open*
    // descriptor, pinned regardless of later path changes.
    let fd_meta = file
        .metadata()
        .map_err(|e| format!("Cannot stat opened file: {e}"))?;
    let path_meta = std::fs::metadata(&canonical)
        .map_err(|e| format!("Cannot stat canonical path \"{}\": {e}", canonical.display()))?;
    if fd_meta.dev() == path_meta.dev() && fd_meta.ino() == path_meta.ino() {
        Ok(())
    } else {
        Err(format!(
            "PATH_SWAPPED: the opened file no longer matches canonical path \"{}\"; \
             a path component may have been replaced by a symlink. Refusing to proceed.",
            canonical.display()
        ))
    }
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

    // ── Sensitive file tests ─────────────────────────────────────────────────

    #[test]
    fn test_is_sensitive_file_dot_env() {
        assert!(is_sensitive_file("/project/.env"));
        assert!(is_sensitive_file("/project/.env.production"));
    }

    #[test]
    fn test_is_sensitive_file_dot_env_exemptions() {
        assert!(!is_sensitive_file("/project/.env.example"));
        assert!(!is_sensitive_file("/project/.env.sample"));
        assert!(!is_sensitive_file("/project/.env.template"));
    }

    #[test]
    fn test_is_sensitive_file_ssh_keys() {
        assert!(is_sensitive_file("/home/user/.ssh/id_rsa"));
        assert!(is_sensitive_file("/home/user/.ssh/id_ed25519"));
        assert!(is_sensitive_file("/home/user/.ssh/id_ecdsa"));
    }

    #[test]
    fn test_is_sensitive_file_public_keys_allowed() {
        assert!(!is_sensitive_file("/home/user/.ssh/id_rsa.pub"));
        assert!(!is_sensitive_file("/home/user/.ssh/id_ed25519.pub"));
    }

    #[test]
    fn test_is_sensitive_file_ssh_key_variants() {
        assert!(is_sensitive_file("/home/user/.ssh/id_rsa.bak"));
        assert!(is_sensitive_file("/home/user/.ssh/id_rsa.old"));
        assert!(is_sensitive_file("/home/user/.ssh/id_rsa_copy"));
        assert!(is_sensitive_file("/home/user/.ssh/id_rsa-backup"));
    }

    #[test]
    fn test_is_sensitive_file_git_credentials() {
        assert!(is_sensitive_file("/project/.git-credentials"));
    }

    #[test]
    fn test_is_sensitive_file_path_suffix() {
        assert!(is_sensitive_file("/home/user/.aws/credentials"));
        assert!(is_sensitive_file("/home/user/.ssh/config"));
        assert!(is_sensitive_file("/home/user/.docker/config.json"));
    }

    #[test]
    fn test_is_sensitive_file_keyfile_extensions() {
        assert!(is_sensitive_file("/certs/server.p12"));
        assert!(is_sensitive_file("/certs/truststore.jks"));
    }

    #[test]
    fn test_is_sensitive_file_normal_file_not_sensitive() {
        assert!(!is_sensitive_file("/project/src/main.rs"));
        assert!(!is_sensitive_file("/project/package.json"));
        assert!(!is_sensitive_file("/project/README.md"));
    }

    #[test]
    fn test_looks_like_private_key_content() {
        assert!(looks_like_private_key_content("-----BEGIN RSA PRIVATE KEY-----\nbase64data"));
        assert!(looks_like_private_key_content("  \n-----BEGIN OPENSSH PRIVATE KEY-----"));
        assert!(!looks_like_private_key_content("public data"));
        assert!(!looks_like_private_key_content(""));
    }

    #[test]
    fn test_check_symlink_escape_non_symlink() {
        // Create a temp file and check it's not a symlink escape.
        let dir = std::env::temp_dir();
        let path = dir.join("path_access_test_file.txt");
        std::fs::write(&path, "test").ok();
        let roots = vec![dir.to_string_lossy().to_string()];
        let result = check_symlink_escape(&path.to_string_lossy(), &roots);
        assert!(result.is_ok());
        std::fs::remove_file(&path).ok();
    }

    /// Create a symlink; returns `None` when the platform or privileges do not
    /// allow it (e.g. unprivileged Windows), so tests can skip gracefully.
    fn try_symlink_file(target: &std::path::Path, link: &std::path::Path) -> Option<()> {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).ok()
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(target, link).ok()
        }
        #[cfg(not(any(unix, windows)))]
        {
            None
        }
    }

    #[test]
    fn test_check_symlink_escape_shared_prefix_sibling_rejected() {
        // Regression for the string-prefix containment bug: with root `/ws`,
        // a target under `/ws-evil` must be rejected. The old code compared
        // with `starts_with(root)` and wrongly accepted it.
        let base = tempfile::tempdir().unwrap();
        let ws = base.path().join("ws");
        let evil = base.path().join("ws-evil");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::create_dir_all(&evil).unwrap();
        std::fs::write(evil.join("secret.txt"), "x").unwrap();

        let link = ws.join("link");
        let Some(()) = try_symlink_file(std::path::Path::new("../ws-evil/secret.txt"), &link)
        else {
            return; // symlink creation unavailable
        };

        let roots = vec![ws.to_string_lossy().to_string()];
        let result = check_symlink_escape(&link.to_string_lossy(), &roots);
        assert!(
            result.is_err(),
            "escape to a sibling sharing the root's string prefix must be rejected, got: {:?}",
            result
        );
    }

    #[test]
    fn test_check_symlink_escape_outside_root_rejected() {
        let base = tempfile::tempdir().unwrap();
        let ws = base.path().join("ws");
        let outside = base.path().join("totally-outside");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "x").unwrap();

        let link = ws.join("link");
        let Some(()) = try_symlink_file(std::path::Path::new("../totally-outside/secret.txt"), &link)
        else {
            return; // symlink creation unavailable
        };

        let roots = vec![ws.to_string_lossy().to_string()];
        let result = check_symlink_escape(&link.to_string_lossy(), &roots);
        assert!(
            result.is_err(),
            "symlink pointing outside the root must be rejected, got: {:?}",
            result
        );
    }

    #[test]
    fn test_check_symlink_escape_within_root_accepted() {
        let base = tempfile::tempdir().unwrap();
        let ws = base.path().join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::write(ws.join("real.txt"), "x").unwrap();

        let link = ws.join("link");
        let Some(()) = try_symlink_file(std::path::Path::new("real.txt"), &link) else {
            return; // symlink creation unavailable
        };

        let roots = vec![ws.to_string_lossy().to_string()];
        let result = check_symlink_escape(&link.to_string_lossy(), &roots);
        assert!(
            result.is_ok(),
            "symlink staying inside the root must be accepted, got: {:?}",
            result
        );
    }

    #[test]
    fn test_check_symlink_escape_relative_target_above_root_rejected() {
        // A relative target walking above the root (`../../outside/...`) must
        // be rejected after lexical normalization.
        let base = tempfile::tempdir().unwrap();
        let ws = base.path().join("ws");
        let outside = base.path().join("outside");
        std::fs::create_dir_all(ws.join("sub")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "x").unwrap();

        let link = ws.join("sub").join("link");
        let Some(()) = try_symlink_file(std::path::Path::new("../../outside/secret.txt"), &link)
        else {
            return; // symlink creation unavailable
        };

        let roots = vec![ws.to_string_lossy().to_string()];
        let result = check_symlink_escape(&link.to_string_lossy(), &roots);
        assert!(
            result.is_err(),
            "relative target escaping above the root must be rejected, got: {:?}",
            result
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_validate_opened_file_matches() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.txt");
        std::fs::write(&path, "abc").unwrap();
        let file = std::fs::File::open(&path).unwrap();
        assert!(validate_opened_file(&path.to_string_lossy(), &file).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn test_validate_opened_file_detects_path_swap() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.txt");
        std::fs::write(&path, "original").unwrap();
        let file = std::fs::File::open(&path).unwrap(); // fd pinned to the original inode
        std::fs::rename(&path, dir.path().join("moved.txt")).unwrap();
        std::fs::write(&path, "attacker").unwrap(); // new inode at the same path
        let result = validate_opened_file(&path.to_string_lossy(), &file);
        assert!(
            result.is_err(),
            "fd no longer matches the file at the path, must fail closed, got: {:?}",
            result
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_validate_opened_file_fails_when_path_removed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.txt");
        std::fs::write(&path, "x").unwrap();
        let file = std::fs::File::open(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert!(
            validate_opened_file(&path.to_string_lossy(), &file).is_err(),
            "a removed path must fail closed"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_validate_opened_file_new_file_via_parent_anchor() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        let path = sub.join("new.txt");
        let file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .open(&path)
            .unwrap();
        assert!(
            validate_opened_file(&path.to_string_lossy(), &file).is_ok(),
            "a freshly created file must validate against its canonical path"
        );
    }

    #[test]
    fn test_is_sensitive_file_dot_env_variants() {
        assert!(is_sensitive_file("/project/.env.production"));
        assert!(is_sensitive_file("/project/.env.development.local"));
        assert!(!is_sensitive_file("/project/.env.example"));
        assert!(!is_sensitive_file("/project/.env.sample"));
    }

    #[test]
    fn test_is_sensitive_file_ssh_key_variant_formats() {
        // Rename-shielded variants
        assert!(is_sensitive_file("/home/user/.ssh/id_rsa.backup"));
        assert!(is_sensitive_file("/home/user/.ssh/id_rsa_copy"));
        assert!(is_sensitive_file("/home/user/.ssh/id_ed25519-old"));
        // Public keys are allowed
        assert!(!is_sensitive_file("/home/user/.ssh/id_rsa.pub"));
        // Unrelated files with similar prefix should not match
        assert!(!is_sensitive_file("/home/user/id_rsafoo.txt"));
    }

    #[test]
    fn test_is_sensitive_file_path_suffix_edge_cases() {
        assert!(is_sensitive_file("/home/user/.aws/credentials"));
        assert!(is_sensitive_file("/home/user/.ssh/config"));
        // Deep path with suffix
        assert!(is_sensitive_file("/home/user/project/.aws/credentials"));
        // Not sensitive if just directory name matches
        assert!(!is_sensitive_file("/home/user/.aws"));
    }

    #[test]
    fn test_is_sensitive_file_npmrc_and_netrc() {
        assert!(is_sensitive_file("/project/.npmrc"));
        assert!(is_sensitive_file("/project/.netrc"));
        assert!(is_sensitive_file("/project/.pypirc"));
    }

    #[test]
    fn test_is_sensitive_file_kubeconfig() {
        assert!(is_sensitive_file("/home/user/.kube/config"));
        assert!(is_sensitive_file("/home/user/.config/kube/config"));
    }

    #[test]
    fn test_is_sensitive_file_keyfile_extensions_detailed() {
        assert!(is_sensitive_file("/certs/server.p12"));
        assert!(is_sensitive_file("/certs/truststore.jks"));
        assert!(is_sensitive_file("/certs/keystore.jks"));
        assert!(is_sensitive_file("/certs/domain.pfx"));
    }

    #[test]
    fn test_is_sensitive_file_pgpass_and_htpasswd() {
        assert!(is_sensitive_file("/home/user/.pgpass"));
        assert!(!is_sensitive_file("/etc/nginx/.htpasswd")); // htpasswd is lowercase without dot prefix
        assert!(is_sensitive_file("/etc/nginx/htpasswd"));
    }

    #[test]
    fn test_looks_like_private_key_content_all_formats() {
        assert!(looks_like_private_key_content("-----BEGIN RSA PRIVATE KEY-----\nMIIEpA"));
        assert!(looks_like_private_key_content("-----BEGIN EC PRIVATE KEY-----\nMHQCAQ"));
        assert!(looks_like_private_key_content("-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn"));
        assert!(looks_like_private_key_content("-----BEGIN DSA PRIVATE KEY-----"));
        assert!(looks_like_private_key_content("-----BEGIN PRIVATE KEY-----"));
        assert!(looks_like_private_key_content("-----BEGIN ENCRYPTED PRIVATE KEY-----"));
        assert!(looks_like_private_key_content("-----BEGIN PGP PRIVATE KEY BLOCK-----"));
    }

    #[test]
    fn test_looks_like_private_key_content_negative() {
        assert!(!looks_like_private_key_content(""));
        assert!(!looks_like_private_key_content("public data"));
        assert!(!looks_like_private_key_content("-----BEGIN CERTIFICATE-----"));
        assert!(!looks_like_private_key_content("-----BEGIN PUBLIC KEY-----"));
    }
}
