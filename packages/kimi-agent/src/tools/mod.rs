//! Native read-only tool execution inside the Rust engine.
//!
//! When enabled, `Read` / `Grep` / `Glob` calls are executed directly in
//! this process instead of round-tripping to the JS host. Execution is
//! sandboxed to the workspace root; anything outside it (or any argument
//! shape this module does not understand) returns `None`, which makes the
//! caller fall back to the host path — the host then applies its full
//! permission system. Write-capable tools are never handled here.

pub mod manager;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::turn_loop::types::ExecutableToolResult;

/// Maximum number of lines a native Read returns.
const READ_MAX_LINES: usize = 2000;
/// Maximum file size a native Read serves (larger files fall back to host).
const READ_MAX_BYTES: u64 = 4 * 1024 * 1024;
/// Grep caps: matches, scanned files, and wall-clock budget.
const GREP_MAX_MATCHES: usize = 200;
const GREP_MAX_FILES: usize = 5000;
const GREP_TIME_BUDGET: Duration = Duration::from_secs(3);
/// Maximum number of Glob results returned.
const GLOB_MAX_RESULTS: usize = 500;

/// File names that are considered sensitive and should never be served by
/// native tools. Matches the `isSensitiveFile` logic in TS.
const SENSITIVE_FILE_NAMES: &[&str] = &[
    ".env",
    ".env.local",
    ".env.production",
    ".env.development",
    ".env.staging",
    ".env.test",
    ".env.example",
    ".env.sample",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "id_xmss",
    "config",
    "authorized_keys",
    "known_hosts",
    "google-credentials.json",
    "service-account.json",
    "service-account-key.json",
    "credentials.json",
    "credential.json",
    "credentials",
    "secret.key",
    "secret.json",
    "secrets.json",
    "private.key",
    "private-key.pem",
    "key.pem",
    "cert.pem",
    "chain.pem",
    "fullchain.pem",
    "ssl.key",
    "ssl.crt",
    "keystore.jks",
    "keystore",
    ".npmrc",
    ".netrc",
    ".dockercfg",
    ".dockerconfigjson",
    ".aws/credentials",
    ".aws/config",
    ".gcp/credentials",
    ".azure/credentials",
    ".kube/config",
    "kubeconfig",
    "kube-config",
    "token",
    "tokens",
    ".token",
    "oauth",
    "oauth-token",
    "oauth_token",
    "api_key",
    "api-key",
    "apikey",
    "apikey.json",
    "api_key.json",
    "session.key",
    "cookie.key",
    "master.key",
    "database.yml",
    "database.json",
    "db-credentials",
    ".pgpass",
    "id_rsa.pub",
    "id_dsa.pub",
    "config.json",
    "config.yaml",
    "config.yml",
    ".gitconfig",
    ".git-credentials",
];

/// Check if a file name is sensitive (e.g. .env, credentials, SSH keys).
/// Uses case-insensitive comparison on the file name (not the full path).
fn is_sensitive_file(path: &Path) -> bool {
    let file_name = match path.file_name() {
        Some(n) => n.to_string_lossy().to_lowercase(),
        None => return false,
    };
    // Exact match against the sensitive list
    if SENSITIVE_FILE_NAMES.iter().any(|&name| name.eq_ignore_ascii_case(&file_name)) {
        return true;
    }
    // Extension-based checks: .pem, .key files anywhere
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase());
    if let Some(ext) = ext {
        if matches!(ext.as_str(), "pem" | "key" | "p12" | "pfx" | "keystore") {
            return true;
        }
    }
    // Path-based checks: .aws/, .gcp/, .azure/, .kube/ credentials
    let path_lower = path.to_string_lossy().to_lowercase();
    if path_lower.contains("\\.aws\\") || path_lower.contains("/.aws/")
        || path_lower.contains("\\.gcp\\") || path_lower.contains("/.gcp/")
        || path_lower.contains("\\.azure\\") || path_lower.contains("/.azure/")
        || path_lower.contains("\\.kube\\") || path_lower.contains("/.kube/")
        || path_lower.contains("\\.ssh\\") || path_lower.contains("/.ssh/")
    {
        return true;
    }
    false
}

/// Sandboxed native executor for read-only tools.
pub struct NativeToolset {
    root: PathBuf,
}

impl NativeToolset {
    /// Build a toolset rooted at `workspace_root`. Returns `None` when the
    /// root does not exist or cannot be canonicalized (no sandbox — no
    /// native execution).
    pub fn new(workspace_root: &str) -> Option<Self> {
        let root = std::fs::canonicalize(workspace_root).ok()?;
        if !root.is_dir() {
            return None;
        }
        Some(Self { root })
    }

    /// Execute `tool_name` natively when supported and inside the sandbox.
    /// `None` means "not handled here — send it to the host".
    pub fn execute(&self, tool_name: &str, args: &Value) -> Option<ExecutableToolResult> {
        match tool_name.to_ascii_lowercase().as_str() {
            "read" => self.read(args),
            "grep" => self.grep(args),
            "glob" => self.glob(args),
            _ => None,
        }
    }

    /// Resolve a path argument inside the workspace. `None` when the path
    /// escapes the sandbox, is a sensitive file, or does not exist.
    fn resolve(&self, path: &str) -> Option<PathBuf> {
        let candidate = if Path::new(path).is_absolute() {
            PathBuf::from(path)
        } else {
            self.root.join(path)
        };
        let resolved = std::fs::canonicalize(&candidate).ok()?;
        // Sandbox check: resolved path must be within the workspace root.
        if !resolved.starts_with(&self.root) {
            return None;
        }
        // Symlink escape check: verify the original path (before canonicalize)
        // didn't use symlinks to redirect outside the workspace.
        if let Ok(metadata) = std::fs::metadata(&candidate) {
            if metadata.file_type().is_symlink() {
                let link_target = std::fs::read_link(&candidate).ok()?;
                let target_abs = if link_target.is_absolute() {
                    link_target
                } else if let Some(parent) = candidate.parent() {
                    parent.join(&link_target)
                } else {
                    link_target
                };
                if !target_abs.starts_with(&self.root) {
                    return None;
                }
            }
        }
        // Sensitive file check
        if is_sensitive_file(&resolved) {
            return None;
        }
        Some(resolved)
    }

    // ── Read ───────────────────────────────────────────────────────────

    fn read(&self, args: &Value) -> Option<ExecutableToolResult> {
        let path = args.get("path")?.as_str()?;
        // Negative offsets (tail reads) keep their host semantics.
        let offset = match args.get("line_offset") {
            None | Some(Value::Null) => 1,
            Some(v) => {
                let n = v.as_i64()?;
                if n < 1 {
                    return None;
                }
                n as usize
            }
        };
        let n_lines = match args.get("n_lines") {
            None | Some(Value::Null) => READ_MAX_LINES,
            Some(v) => (v.as_u64()? as usize).min(READ_MAX_LINES),
        };

        let resolved = self.resolve(path)?;
        let meta = std::fs::metadata(&resolved).ok()?;
        if !meta.is_file() || meta.len() > READ_MAX_BYTES {
            return None;
        }
        let bytes = std::fs::read(&resolved).ok()?;
        // Binary files fall back to the host (media handling lives there).
        if bytes.contains(&0) {
            return None;
        }
        let text = String::from_utf8_lossy(&bytes);

        let all: Vec<&str> = text.lines().collect();
        if offset > all.len() && !all.is_empty() {
            return Some(err_result(format!(
                "line_offset {offset} is past the end of {path} ({} lines)",
                all.len()
            )));
        }
        let end = (offset - 1 + n_lines).min(all.len());
        let mut out = String::new();
        for (i, line) in all[offset - 1..end].iter().enumerate() {
            out.push_str(&format!("{:>6}→{}\n", offset + i, line));
        }
        if end < all.len() {
            out.push_str(&format!(
                "\n[truncated — showing lines {offset}-{end} of {}]",
                all.len()
            ));
        }
        Some(ok_result(out))
    }

    // ── Grep ───────────────────────────────────────────────────────────

    fn grep(&self, args: &Value) -> Option<ExecutableToolResult> {
        let pattern = args.get("pattern")?.as_str()?;
        let regex = match regex::RegexBuilder::new(pattern).build() {
            Ok(r) => r,
            Err(e) => return Some(err_result(format!("invalid regex: {e}"))),
        };
        let glob_filter = match args.get("glob").and_then(|g| g.as_str()) {
            Some(g) => Some(build_glob(g)?),
            None => None,
        };
        // Unsupported extra filters (e.g. `type`) fall back to the host.
        if args.get("type").is_some_and(|t| !t.is_null()) {
            return None;
        }

        let search_root = match args.get("path").and_then(|p| p.as_str()) {
            Some(p) => self.resolve(p)?,
            None => self.root.clone(),
        };

        let started = Instant::now();
        let mut matches: Vec<String> = Vec::new();
        let mut scanned = 0usize;
        let mut truncated = false;

        let walker = ignore::WalkBuilder::new(&search_root).build();
        'outer: for entry in walker.flatten() {
            if started.elapsed() > GREP_TIME_BUDGET || scanned >= GREP_MAX_FILES {
                truncated = true;
                break;
            }
            let path = entry.path();
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            if let Some(ref gs) = glob_filter {
                if !gs.is_match(path) {
                    continue;
                }
            }
            scanned += 1;
            let Ok(bytes) = std::fs::read(path) else { continue };
            if bytes.contains(&0) {
                continue;
            }
            let text = String::from_utf8_lossy(&bytes);
            let display = path.strip_prefix(&self.root).unwrap_or(path);
            for (lineno, line) in text.lines().enumerate() {
                if regex.is_match(line) {
                    matches.push(format!("{}:{}: {}", display.display(), lineno + 1, line.trim_end()));
                    if matches.len() >= GREP_MAX_MATCHES {
                        truncated = true;
                        break 'outer;
                    }
                }
            }
        }

        let mut out = if matches.is_empty() {
            format!("No matches found for pattern: {pattern}")
        } else {
            matches.join("\n")
        };
        if truncated {
            out.push_str("\n\n[truncated — refine the pattern or scope to see more]");
        }
        Some(ok_result(out))
    }

    // ── Glob ───────────────────────────────────────────────────────────

    fn glob(&self, args: &Value) -> Option<ExecutableToolResult> {
        let pattern = args.get("pattern")?.as_str()?;
        // include_ignored changes walker semantics — let the host handle it.
        if args.get("include_ignored").is_some_and(|v| v.as_bool() == Some(true)) {
            return None;
        }
        let glob = build_glob(pattern)?;
        let search_root = match args.get("path").and_then(|p| p.as_str()) {
            Some(p) => self.resolve(p)?,
            None => self.root.clone(),
        };

        let mut results: Vec<String> = Vec::new();
        let mut truncated = false;
        let walker = ignore::WalkBuilder::new(&search_root).build();
        for entry in walker.flatten() {
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            let path = entry.path();
            let relative = path.strip_prefix(&search_root).unwrap_or(path);
            if glob.is_match(relative) || glob.is_match(path) {
                let display = path.strip_prefix(&self.root).unwrap_or(path);
                results.push(display.display().to_string());
                if results.len() >= GLOB_MAX_RESULTS {
                    truncated = true;
                    break;
                }
            }
        }
        results.sort();

        let mut out = if results.is_empty() {
            format!("No files matched pattern: {pattern}")
        } else {
            results.join("\n")
        };
        if truncated {
            out.push_str("\n\n[truncated — narrow the pattern to see more]");
        }
        Some(ok_result(out))
    }
}

/// Compile a glob, auto-prefixing bare patterns with `**/` the way the JS
/// Glob tool does, so `*.rs` matches at any depth.
fn build_glob(pattern: &str) -> Option<globset::GlobSet> {
    let mut builder = globset::GlobSetBuilder::new();
    builder.add(globset::Glob::new(pattern).ok()?);
    if !pattern.starts_with("**/") && !pattern.contains('/') && !pattern.contains('\\') {
        builder.add(globset::Glob::new(&format!("**/{pattern}")).ok()?);
    }
    builder.build().ok()
}

fn ok_result(content: String) -> ExecutableToolResult {
    ExecutableToolResult { content, is_error: false, is_prediction: false }
}

fn err_result(content: String) -> ExecutableToolResult {
    ExecutableToolResult { content, is_error: true, is_prediction: false }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn setup() -> (tempfile::TempDir, NativeToolset) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "alpha\nbeta\ngamma\n").unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/lib.rs"), "fn main() {}\n// beta marker\n").unwrap();
        let toolset = NativeToolset::new(dir.path().to_str().unwrap()).unwrap();
        (dir, toolset)
    }

    #[test]
    fn new_rejects_missing_root() {
        assert!(NativeToolset::new("/definitely/not/a/real/dir").is_none());
    }

    #[test]
    fn read_returns_numbered_lines() {
        let (_dir, ts) = setup();
        let result = ts.execute("Read", &json!({ "path": "a.txt" })).unwrap();
        assert!(!result.is_error);
        assert!(result.content.contains("1→alpha"), "content: {}", result.content);
        assert!(result.content.contains("3→gamma"));
    }

    #[test]
    fn read_respects_offset_and_count() {
        let (_dir, ts) = setup();
        let result = ts
            .execute("read", &json!({ "path": "a.txt", "line_offset": 2, "n_lines": 1 }))
            .unwrap();
        assert!(result.content.contains("2→beta"));
        assert!(!result.content.contains("alpha"));
        assert!(!result.content.contains("3→gamma"));
    }

    #[test]
    fn read_outside_workspace_falls_back() {
        let (_dir, ts) = setup();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "nope").unwrap();
        let escaped = outside.path().join("secret.txt");
        assert!(ts.execute("Read", &json!({ "path": escaped.to_str().unwrap() })).is_none());
    }

    #[test]
    fn read_negative_offset_falls_back_to_host() {
        let (_dir, ts) = setup();
        assert!(ts.execute("Read", &json!({ "path": "a.txt", "line_offset": -5 })).is_none());
    }

    #[test]
    fn grep_finds_matches_across_files() {
        let (_dir, ts) = setup();
        let result = ts.execute("Grep", &json!({ "pattern": "beta" })).unwrap();
        assert!(!result.is_error);
        assert!(result.content.contains("a.txt:2"), "content: {}", result.content);
        assert!(result.content.contains("lib.rs:2"), "content: {}", result.content);
    }

    #[test]
    fn grep_with_glob_filter() {
        let (_dir, ts) = setup();
        let result = ts
            .execute("Grep", &json!({ "pattern": "beta", "glob": "*.rs" }))
            .unwrap();
        assert!(result.content.contains("lib.rs"));
        assert!(!result.content.contains("a.txt"));
    }

    #[test]
    fn grep_invalid_regex_is_an_error_result() {
        let (_dir, ts) = setup();
        let result = ts.execute("Grep", &json!({ "pattern": "([unclosed" })).unwrap();
        assert!(result.is_error);
        assert!(result.content.contains("invalid regex"));
    }

    #[test]
    fn grep_with_type_filter_falls_back() {
        let (_dir, ts) = setup();
        assert!(ts.execute("Grep", &json!({ "pattern": "x", "type": "rust" })).is_none());
    }

    #[test]
    fn glob_matches_at_any_depth() {
        let (_dir, ts) = setup();
        let result = ts.execute("Glob", &json!({ "pattern": "*.rs" })).unwrap();
        assert!(result.content.contains("lib.rs"), "content: {}", result.content);
        assert!(!result.content.contains("a.txt"));
    }

    #[test]
    fn glob_no_matches_reports_cleanly() {
        let (_dir, ts) = setup();
        let result = ts.execute("Glob", &json!({ "pattern": "*.xyz" })).unwrap();
        assert!(!result.is_error);
        assert!(result.content.contains("No files matched"));
    }

    #[test]
    fn write_tools_are_never_handled() {
        let (_dir, ts) = setup();
        assert!(ts.execute("Write", &json!({ "path": "a.txt", "content": "x" })).is_none());
        assert!(ts.execute("Edit", &json!({ "path": "a.txt" })).is_none());
        assert!(ts.execute("Bash", &json!({ "command": "rm -rf /" })).is_none());
    }
}

#[cfg(test)]
mod security_tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn test_sensitive_dot_env() {
        assert!(is_sensitive_file(Path::new("/project/.env")));
    }

    #[test]
    fn test_sensitive_ssh_key() {
        assert!(is_sensitive_file(Path::new("/home/user/.ssh/id_rsa")));
        assert!(is_sensitive_file(Path::new("/root/.ssh/authorized_keys")));
    }

    #[test]
    fn test_sensitive_aws_credentials() {
        assert!(is_sensitive_file(Path::new("/home/user/.aws/credentials")));
    }

    #[test]
    fn test_sensitive_kube_config() {
        assert!(is_sensitive_file(Path::new("/home/user/.kube/config")));
    }

    #[test]
    fn test_sensitive_pem_file() {
        assert!(is_sensitive_file(Path::new("/project/private-key.pem")));
    }

    #[test]
    fn test_normal_source_file_not_sensitive() {
        assert!(!is_sensitive_file(Path::new("/project/src/main.rs")));
        assert!(!is_sensitive_file(Path::new("/project/index.ts")));
        assert!(!is_sensitive_file(Path::new("/project/package.json")));
        assert!(!is_sensitive_file(Path::new("/project/README.md")));
    }

    #[test]
    fn test_sensitive_file_in_subdirectory() {
        assert!(is_sensitive_file(Path::new("/project/config/.env")));
        assert!(is_sensitive_file(Path::new("/project/deploy/.env.production")));
    }

    #[test]
    fn test_normal_json_config_not_sensitive() {
        assert!(!is_sensitive_file(Path::new("/project/tsconfig.json")));
        assert!(!is_sensitive_file(Path::new("/project/.eslintrc.json")));
    }
}
