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

/// Known sensitive basenames (case-insensitive match).
const SENSITIVE_BASENAMES: &[&str] = &[
    ".env",
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    "credentials",
    ".npmrc",
    ".pypirc",
    ".netrc",
    "htpasswd",
    ".pgpass",
    ".git-credentials",
    ".ppk",
    ".p12",
    ".pfx",
    "kubeconfig",
];

/// Public-key basenames that are explicitly allowed (not sensitive).
const PUBLIC_KEY_BASENAMES: &[&str] = &["id_rsa.pub", "id_ed25519.pub", "id_ecdsa.pub"];

/// Sensitive path suffixes (directory components + basename).
const SENSITIVE_PATH_SUFFIXES: &[&[&str]] = &[
    &[".aws", "credentials"],
    &[".gcp", "credentials"],
    &[".docker", "config.json"],
    &[".kube", "config"],
    &[".config", "kube", "config"],
    &[".ssh", "config"],
];

/// Sensitive key-file extensions.
const SENSITIVE_KEYFILE_EXTENSIONS: &[&str] = &[
    ".ppk", ".p12", ".pfx", ".keystore", ".jks",
];

/// Dot-variant suffixes (e.g. `.env.bak`, `id_rsa.old`).
const SENSITIVE_DOT_VARIANT_SUFFIXES: &[&str] = &[
    ".bak", ".backup", ".copy", ".disabled", ".key", ".old", ".orig", ".pem", ".save", ".tmp",
];

/// Sensitive basename prefixes for prefix-based matching (e.g. `id_rsa-*`).
const SENSITIVE_BASENAME_PREFIXES: &[&str] = &["id_rsa", "id_ed25519", "id_ecdsa", "credentials"];

/// Exemptions: env-like files that are NOT sensitive.
const ENV_EXEMPTIONS: &[&str] = &[".env.example", ".env.sample", ".env.template"];

const ENV_PREFIX: &str = ".env.";

/// Check whether a path is a known sensitive file that should be blocked
/// from Read/Write/Edit operations.
///
/// Matches the TS implementation in `packages/agent-core/src/tools/policies/sensitive.ts`.
pub fn is_sensitive_file(path: &str) -> bool {
    let path_lower = path.to_lowercase();
    let name = path_lower.rsplit(['/', '\\']).next().unwrap_or(&path_lower);

    // Exemptions first.
    if ENV_EXEMPTIONS.contains(&name) {
        return false;
    }
    if PUBLIC_KEY_BASENAMES.contains(&name) {
        return false;
    }

    // Exact basename match.
    if SENSITIVE_BASENAMES.contains(&name) {
        return true;
    }

    // .env.* prefix (e.g. .env.production).
    if name.starts_with(ENV_PREFIX) {
        return true;
    }

    // Prefix-based match (id_rsa-, id_rsa_, id_rsa.bak, etc.)
    for &prefix in SENSITIVE_BASENAME_PREFIXES {
        if name == prefix {
            return true;
        }
        if name.len() > prefix.len() && name.starts_with(prefix) {
            let suffix = &name[prefix.len()..];
            let next = suffix.chars().next().unwrap_or(' ');
            if next == '-' || next == '_' {
                return true;
            }
            if next == '.' && SENSITIVE_DOT_VARIANT_SUFFIXES.contains(&suffix) {
                return true;
            }
        }
    }

    // Path-suffix matching (e.g. .aws/credentials, .ssh/config).
    let normalized_path = path.replace('\\', "/");
    for &parts in SENSITIVE_PATH_SUFFIXES {
        let suffix = parts.join("/");
        if normalized_path.ends_with(&format!("/{}", suffix))
            || normalized_path.contains(&format!("/{}/", suffix))
        {
            return true;
        }
    }

    // Keyfile extension match.
    for &ext in SENSITIVE_KEYFILE_EXTENSIONS {
        if name.ends_with(ext) {
            return true;
        }
    }

    false
}

/// Check whether a file's content looks like a private key (content-sniff).
pub fn looks_like_private_key_content(content: &str) -> bool {
    let trimmed = content.trim_start();
    trimmed.starts_with("-----BEGIN RSA PRIVATE KEY-----")
        || trimmed.starts_with("-----BEGIN EC PRIVATE KEY-----")
        || trimmed.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----")
        || trimmed.starts_with("-----BEGIN DSA PRIVATE KEY-----")
        || trimmed.starts_with("-----BEGIN PRIVATE KEY-----")
        || trimmed.starts_with("-----BEGIN ENCRYPTED PRIVATE KEY-----")
        || trimmed.starts_with("-----BEGIN PGP PRIVATE KEY BLOCK-----")
}

// ── Symlink escape detection ─────────────────────────────────────────────────

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
    let target_str = target.to_string_lossy();

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

    let target_abs_str = target_abs.to_string_lossy();
    let is_safe = roots.iter().any(|root| {
        target_abs_str.starts_with(root) || target_abs_str.starts_with(&format!("{}/", root))
    });

    if is_safe {
        Ok(())
    } else {
        Err(format!(
            "SYMLINK_ESCAPE: \"{}\" is a symlink to \"{}\", which is outside the allowed workspace(s)",
            path, target_abs_str
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
