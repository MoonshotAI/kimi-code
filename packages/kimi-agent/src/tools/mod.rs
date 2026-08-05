//! Native read-only tool execution inside the Rust engine.
//!
//! When enabled, `Read` / `Grep` / `Glob` calls are executed directly in
//! this process instead of round-tripping to the JS host. Execution is
//! sandboxed to the workspace root; anything outside it (or any argument
//! shape this module does not understand) returns `None`, which makes the
//! caller fall back to the host path — the host then applies its full
//! permission system. Write-capable tools are never handled here.

pub mod bash;
pub mod fetch_url;
pub mod fs_search;
pub mod github;
pub mod manager;
pub mod todo;
pub mod web_search;

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
#[derive(Debug, Clone)]
pub struct NativeToolset {
    root: PathBuf,
    /// Additional directories the toolset is allowed to access (beyond root).
    additional_roots: Vec<PathBuf>,
    /// Native Bash execution (foreground only, gated by the host approval
    /// hooks). Off by default: on host-driven paths the JS Bash owns the
    /// tool (background tasks, detach, timeout-to-background live there).
    /// The standalone Rust agent path opts in via `with_shell`.
    shell: Option<bash::BashRunner>,
    /// Per-session TodoList store (in-memory, interior-mutable via Arc<Mutex>).
    todo: todo::TodoList,
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
        Some(Self { root, additional_roots: Vec::new(), shell: None, todo: todo::TodoList::new() })
    }

    /// Add an additional directory to the sandbox allowlist. Returns `false`
    /// if the path does not exist or is not a directory.
    pub fn add_additional_dir(&mut self, dir: &str) -> bool {
        let canonical = match std::fs::canonicalize(dir) {
            Ok(p) if p.is_dir() => p,
            _ => return false,
        };
        if !self.additional_roots.contains(&canonical) && canonical != self.root {
            self.additional_roots.push(canonical);
        }
        true
    }

    /// Remove a previously added additional directory. Returns `false` if it
    /// was not in the list.
    pub fn remove_additional_dir(&mut self, dir: &str) -> bool {
        let canonical = match std::fs::canonicalize(dir) {
            Ok(p) => p,
            Err(_) => return false,
        };
        let before = self.additional_roots.len();
        self.additional_roots.retain(|r| *r != canonical);
        self.additional_roots.len() < before
    }

    /// The list of additional directories.
    pub fn additional_dirs(&self) -> &[PathBuf] {
        &self.additional_roots
    }

    /// Enable native Bash execution (standalone agent path). A toolset
    /// without a detectable shell keeps Bash with the host.
    pub fn with_shell(mut self) -> Self {
        self.shell = bash::BashRunner::detect();
        self
    }

    /// The detected shell runner, when native Bash is enabled.
    pub fn shell(&self) -> Option<&bash::BashRunner> {
        self.shell.as_ref()
    }

    /// The sandbox root this toolset executes inside.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Return tool definitions for every tool this toolset provides.
    pub fn tool_definitions(&self) -> Vec<crate::context::types::ToolDefinition> {
        vec![
            crate::context::types::ToolDefinition {
                name: "Read".into(), description: "Read a file".into(),
                input_schema: Some(serde_json::json!({"type":"object","properties":{"file_path":{"type":"string"}},"required":["file_path"]})),
            },
            crate::context::types::ToolDefinition {
                name: "Write".into(), description: "Write a file".into(),
                input_schema: Some(serde_json::json!({"type":"object","properties":{"file_path":{"type":"string"},"content":{"type":"string"}},"required":["file_path","content"]})),
            },
            crate::context::types::ToolDefinition {
                name: "Edit".into(), description: "Edit a file".into(),
                input_schema: Some(serde_json::json!({"type":"object","properties":{"file_path":{"type":"string"},"old_string":{"type":"string"},"new_string":{"type":"string"}},"required":["file_path","old_string","new_string"]})),
            },
            crate::context::types::ToolDefinition {
                name: "Grep".into(), description: "Search files".into(),
                input_schema: Some(serde_json::json!({"type":"object","properties":{"pattern":{"type":"string"}},"required":["pattern"]})),
            },
            crate::context::types::ToolDefinition {
                name: "Glob".into(), description: "List files matching a pattern".into(),
                input_schema: Some(serde_json::json!({"type":"object","properties":{"pattern":{"type":"string"}},"required":["pattern"]})),
            },
            crate::context::types::ToolDefinition {
                name: "Bash".into(), description: "Execute a shell command".into(),
                input_schema: Some(serde_json::json!({"type":"object","properties":{"command":{"type":"string"},"description":{"type":"string"}},"required":["command","description"]})),
            },
            crate::context::types::ToolDefinition {
                name: todo::TODO_TOOL_NAME.into(),
                description: todo::description().into(),
                input_schema: Some(todo::input_schema()),
            },
            crate::context::types::ToolDefinition {
                name: fs_search::FS_SEARCH_TOOL_NAME.into(),
                description: fs_search::description().into(),
                input_schema: Some(fs_search::input_schema()),
            },
            crate::context::types::ToolDefinition {
                name: "WebSearch".into(),
                description: "Search the web and return titles, URLs, and snippets".into(),
                input_schema: Some(serde_json::json!({"type":"object","properties":{"query":{"type":"string"}},"required":["query"]})),
            },
            crate::context::types::ToolDefinition {
                name: "FetchUrl".into(),
                description: "Fetch a URL and return its text content".into(),
                input_schema: Some(serde_json::json!({"type":"object","properties":{"url":{"type":"string"}},"required":["url"]})),
            },
            crate::context::types::ToolDefinition {
                name: "ReadMediaFile".into(),
                description: "Read an image file (png/jpeg/gif/webp) and return it to the model".into(),
                input_schema: Some(serde_json::json!({"type":"object","properties":{"path":{"type":"string"},"full_resolution":{"type":"boolean"}},"required":["path"]})),
            },
        ]
    }

    /// Execute `tool_name` natively when supported and inside the sandbox.
    /// `None` means "not handled here — send it to the host".
    pub fn execute(&self, tool_name: &str, args: &Value) -> Option<ExecutableToolResult> {
        match tool_name.to_ascii_lowercase().as_str() {
            "read" => self.read(args),
            "grep" => self.grep(args),
            "glob" => self.glob(args),
            // Write-class tools execute natively too, but only through the
            // callback layer's gated path (`NativeToolCallbacks`): the host's
            // prepare/authorize hooks run first — driven from Rust — so the
            // permission UI still gates every write. `claims_write` is the
            // side-effect-free admission check for that path. Bash stays with
            // the host by design: its semantics (background task
            // registration, detach, timeout-to-background) belong to the
            // host's process-lifecycle domain, like approval itself.
            "write" => self.write(args),
            "edit" => self.edit(args),
            // TodoList: pure in-memory session state (no filesystem, no
            // network) — always safe to run natively.
            "todolist" => Some(todo::execute_todo_list(&self.todo, args)),
            // FsSearch: filename search for the @ file-mention picker
            // (read-class, ungated like `read`/`glob`).
            "fssearch" => self.fs_search(args),
            // ReadMediaFile: read an image inside the sandbox and return it as
            // an image media part (read-class, ungated like `read`).
            "readmediafile" => self.read_media_file(args),
            _ => None,
        }
    }

    /// Whether a tool name is write-class (mutates the filesystem) and must
    /// therefore pass the host's approval hooks before native execution.
    pub fn is_write_class(tool_name: &str) -> bool {
        matches!(tool_name.to_ascii_lowercase().as_str(), "write" | "edit")
    }

    /// Side-effect-free admission check for write-class calls: would
    /// `execute` handle this call natively? Mirrors the argument-shape and
    /// sandbox gates of `write`/`edit` WITHOUT touching the filesystem (no
    /// parent-dir creation, no file reads beyond metadata).
    ///
    /// The callback layer runs the host approval hooks exactly once for a
    /// claimed call and never falls back to the host afterwards — a fallback
    /// would re-run the host lifecycle (prepare/dedupe) for the same
    /// tool_call_id and corrupt its bookkeeping. That contract only works if
    /// this predicate is conservative: claim only what `execute` will
    /// definitely handle.
    pub fn claims_write(&self, tool_name: &str, args: &Value) -> bool {
        match tool_name.to_ascii_lowercase().as_str() {
            "write" => {
                let Some(path) = args.get("path").and_then(Value::as_str) else {
                    return false;
                };
                if args.get("content").and_then(Value::as_str).is_none() {
                    return false;
                }
                let mode = args.get("mode").and_then(Value::as_str).unwrap_or("overwrite");
                if mode != "overwrite" && mode != "append" {
                    return false;
                }
                self.lexically_contained_and_not_sensitive(path)
            }
            "edit" => {
                let Some(path) = args.get("path").and_then(Value::as_str) else {
                    return false;
                };
                let Some(old_string) = args.get("old_string").and_then(Value::as_str) else {
                    return false;
                };
                if args.get("new_string").and_then(Value::as_str).is_none() {
                    return false;
                }
                if old_string.is_empty() {
                    return false;
                }
                // `edit` additionally requires an existing readable file.
                if !self.lexically_contained_and_not_sensitive(path) {
                    return false;
                }
                self.resolve(path).is_some()
            }
            _ => false,
        }
    }

    /// Lexical containment + sensitivity gate used by `claims_write`. Joins
    /// relative paths onto the sandbox root and normalizes `.`/`..` without
    /// hitting the filesystem, so it is safe to call before approval. The
    /// effectful resolvers (`resolve` / `resolve_for_write`) re-check with
    /// canonicalization at execution time; symlink escapes are caught there.
    fn lexically_contained_and_not_sensitive(&self, path: &str) -> bool {
        let candidate = if Path::new(path).is_absolute() {
            PathBuf::from(path)
        } else {
            self.root.join(path)
        };
        let mut normalized = PathBuf::new();
        for component in candidate.components() {
            match component {
                std::path::Component::CurDir => {}
                std::path::Component::ParentDir => {
                    if !normalized.pop() {
                        return false;
                    }
                }
                other => normalized.push(other.as_os_str()),
            }
        }
        normalized.starts_with(&self.root) && !is_sensitive_file(&normalized)
            || self.additional_roots.iter().any(|r| normalized.starts_with(r))
                && !is_sensitive_file(&normalized)
    }

    /// Check whether a resolved path is within any allowed root (main or additional).
    fn is_within_any_root(&self, resolved: &Path) -> bool {
        resolved.starts_with(&self.root)
            || self.additional_roots.iter().any(|r| resolved.starts_with(r))
    }

    /// Resolve a path argument inside the workspace. `None` when the path
    /// escapes the sandbox (main root + additional dirs), is a sensitive file,
    /// or does not exist.
    fn resolve(&self, path: &str) -> Option<PathBuf> {
        let candidate = if Path::new(path).is_absolute() {
            PathBuf::from(path)
        } else {
            self.root.join(path)
        };
        let resolved = std::fs::canonicalize(&candidate).ok()?;
        // Sandbox check: resolved path must be within any allowed root.
        if !self.is_within_any_root(&resolved) {
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
                if !self.is_within_any_root(&target_abs) {
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

    // ── ReadMediaFile ──────────────────────────────────────────────────
    /// Read an image file inside the sandbox and return it as an image media
    /// part. `None` (host fallback) when the path escapes the sandbox or does
    /// not exist; an in-band error result when the file is not a supported
    /// image. The bytes are base64-inlined; the loop delivers `media` to the
    /// model as a follow-up user image message.
    fn read_media_file(&self, args: &Value) -> Option<ExecutableToolResult> {
        let path = args.get("path")?.as_str()?;
        let resolved = self.resolve(path)?;
        let meta = std::fs::metadata(&resolved).ok()?;
        if !meta.is_file() {
            return None;
        }
        let bytes = std::fs::read(&resolved).ok()?;

        // Validate against the media budget/type core (shared with the host
        // tool); reject non-images and oversize files with a text error.
        let input = crate::media::read_media::MediaReadInput {
            path: path.to_string(),
            region: None,
            full_resolution: args.get("full_resolution").and_then(|v| v.as_bool()).unwrap_or(false),
        };
        let header_len = bytes.len().min(64);
        let validation = crate::media::read_media::validate_media(
            path, &bytes[..header_len], meta.len(), &bytes, &input,
        );
        if let Some(err) = validation.error {
            return Some(err_result(err));
        }

        // Detect the image mime from magic bytes (only model-accepted formats
        // are inlined; anything else is not a deliverable image here).
        let mime = match &bytes {
            b if b.starts_with(&[0x89, 0x50, 0x4E, 0x47]) => "image/png",
            b if b.starts_with(&[0xFF, 0xD8, 0xFF]) => "image/jpeg",
            b if b.starts_with(b"GIF8") => "image/gif",
            b if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" => "image/webp",
            _ => {
                return Some(err_result(format!(
                    "{path} is not a supported image (png/jpeg/gif/webp). Use the host media tool for other formats."
                )));
            }
        };

        // Downsample/re-encode toward the model byte budget unless the caller
        // asked for full resolution. `compress_image_for_model` returns a data
        // URL when it re-encoded (possibly changing the mime, e.g. PNG→JPEG);
        // otherwise the original bytes are within budget and passed through.
        let (media_type, b64) = if input.full_resolution {
            (mime.to_string(), base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes))
        } else {
            let compressed = crate::media::image::compress_image_for_model(
                &bytes,
                mime,
                crate::media::image::FALLBACK_EDGES_PX,
                crate::media::image::JPEG_QUALITY_STEPS,
            );
            match (compressed.changed, compressed.data.as_deref().and_then(|u| u.split_once("base64,"))) {
                (true, Some((_, raw))) => (compressed.mime, raw.to_string()),
                _ => (mime.to_string(), base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes)),
            }
        };
        let note = format!("Read image {path} ({} bytes, {media_type}).", meta.len());
        Some(ExecutableToolResult {
            content: note,
            is_error: false,
            is_prediction: false,
            stop_turn: false,
            media: vec![crate::rpc::types::ContentBlock::Image { media_type, data: b64 }],
        })
    }

    // ── FsSearch ──────────────────────────────────────────────────────

    /// `FsSearch` — filename search for the @ file-mention picker. Searches
    /// the toolset root, or `workspace_root` when given and inside the
    /// sandbox. `None` falls back to the host (malformed arguments, or a
    /// workspace root outside the sandbox).
    fn fs_search(&self, args: &Value) -> Option<ExecutableToolResult> {
        let query = args.get("query").and_then(Value::as_str)?;
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .map(|n| n as usize)
            .unwrap_or(fs_search::DEFAULT_LIMIT);
        let root = match args.get("workspace_root").and_then(Value::as_str) {
            Some(r) if !r.is_empty() => {
                let resolved = std::fs::canonicalize(r).ok()?;
                if !self.is_within_any_root(&resolved) {
                    return None;
                }
                resolved
            }
            _ => self.root.clone(),
        };
        match fs_search::fs_search(&root, query, limit) {
            Ok(hits) => Some(ok_result(fs_search::render_hits(&hits))),
            Err(err) => Some(err_result(err)),
        }
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

    // ── Write ──────────────────────────────────────────────────────────

    /// Resolve a path for a write: the file may not exist yet, so the
    /// *parent* is created (mirroring the TS tool's `mkdir(parents=True)`)
    /// and canonicalized for the sandbox check; the final component is then
    /// re-checked for sensitivity. `None` falls back to the host.
    fn resolve_for_write(&self, path: &str) -> Option<PathBuf> {
        let candidate = if Path::new(path).is_absolute() {
            PathBuf::from(path)
        } else {
            self.root.join(path)
        };
        let file_name = candidate.file_name()?.to_owned();
        let parent = candidate.parent()?;
        // Creating missing parents is part of the tool's contract; do it
        // before canonicalizing so the containment check sees the real path.
        std::fs::create_dir_all(parent).ok()?;
        let parent = std::fs::canonicalize(parent).ok()?;
        if !parent.starts_with(&self.root) {
            return None;
        }
        let resolved = parent.join(file_name);
        // An existing symlink target must not escape the sandbox.
        if let Ok(existing) = std::fs::canonicalize(&resolved) {
            if !existing.starts_with(&self.root) {
                return None;
            }
        }
        if is_sensitive_file(&resolved) {
            return None;
        }
        Some(resolved)
    }

    /// `Write` — overwrite or append. Output strings mirror the TS tool's
    /// English locale verbatim (the model reads them).
    fn write(&self, args: &Value) -> Option<ExecutableToolResult> {
        let path = args.get("path")?.as_str()?;
        let content = args.get("content")?.as_str()?;
        let mode = args.get("mode").and_then(Value::as_str).unwrap_or("overwrite");
        if mode != "overwrite" && mode != "append" {
            return None;
        }
        let resolved = self.resolve_for_write(path)?;
        let bytes = content.len();
        let write_result = if mode == "append" {
            use std::io::Write as _;
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&resolved)
                .and_then(|mut file| file.write_all(content.as_bytes()))
        } else {
            std::fs::write(&resolved, content)
        };
        Some(match write_result {
            Ok(()) => ok_result(if mode == "append" {
                format!("Appended {bytes} bytes to {path}")
            } else {
                format!("Wrote {bytes} bytes to {path}")
            }),
            Err(error) => err_result(error.to_string()),
        })
    }

    // ── Edit ───────────────────────────────────────────────────────────

    /// `Edit` — literal replacement against the model's Read view.
    ///
    /// Line-ending semantics follow the TS tool exactly: a pure-CRLF file is
    /// matched and edited in its LF-normalised view and written back as CRLF;
    /// LF and mixed files are edited verbatim. Binary-ish or unreadable files
    /// fall back to the host.
    fn edit(&self, args: &Value) -> Option<ExecutableToolResult> {
        let path = args.get("path")?.as_str()?;
        let old_string = args.get("old_string")?.as_str()?;
        let new_string = args.get("new_string")?.as_str()?;
        let replace_all = args.get("replace_all").and_then(Value::as_bool).unwrap_or(false);
        if old_string.is_empty() {
            // The schema forbids this; treat a violation as not-handled so the
            // host's validation produces its canonical error.
            return None;
        }
        if old_string == new_string {
            return Some(err_result(
                "No changes to make: old_string and new_string are exactly the same.".to_string(),
            ));
        }
        let resolved = self.resolve(path)?;
        let raw = std::fs::read_to_string(&resolved).ok()?;

        // TS `toModelTextView`: only a *pure* CRLF file is normalised.
        let style = detect_line_ending_style(raw.as_bytes());
        let view = if style == LineEndingStyle::CrLf { raw.replace("\r\n", "\n") } else { raw };

        let occurrences = view.matches(old_string).count();
        if occurrences == 0 {
            return Some(err_result(format!(
                "old_string not found in {path}, the file contents may be out of date. \
                 Please use the Read Tool to reload the content."
            )));
        }
        if !replace_all && occurrences > 1 {
            return Some(err_result(format!(
                "old_string is not unique in {path} (found {occurrences} occurrences). \
                 To replace every occurrence, set replace_all=true. To replace only one \
                 occurrence, include more surrounding context in old_string."
            )));
        }

        let next_view = if replace_all {
            view.replace(old_string, new_string)
        } else {
            view.replacen(old_string, new_string, 1)
        };
        // TS `materializeModelText`: re-materialise CRLF for pure-CRLF files,
        // collapsing any CRLF the replacement text itself carried first so no
        // `\r\r\n` can be produced.
        let materialized = if style == LineEndingStyle::CrLf {
            next_view.replace("\r\n", "\n").replace('\n', "\r\n")
        } else {
            next_view
        };
        Some(match std::fs::write(&resolved, materialized) {
            Ok(()) => ok_result(if replace_all && occurrences > 1 {
                format!("Replaced {occurrences} occurrences in {path}")
            } else {
                format!("Replaced 1 occurrence in {path}")
            }),
            Err(error) => err_result(error.to_string()),
        })
    }
}

/// TS `detectLineEndingStyle`: lone `\r` or a CRLF/LF mix is `Mixed`. Shared
/// implementation lives in `kimi-shared` (`line_endings.rs`) — the single
/// source for both the napi toolset and the engine. (The previous local copy
/// here was semantically equivalent — its CRLF walk skips the LF of a CRLF
/// pair, so its `has_lf` flag is exactly the shared `has_bare_lf` — but the
/// duplication is gone.)
use kimi_shared::line_endings::{detect_line_ending_style, LineEndingStyle};

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
    ExecutableToolResult { content, is_error: false, is_prediction: false, stop_turn: false, media: Vec::new() }
}

fn err_result(content: String) -> ExecutableToolResult {
    ExecutableToolResult { content, is_error: true, is_prediction: false, stop_turn: false, media: Vec::new() }
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
    fn todolist_writes_and_reads_natively_through_the_toolset() {
        let (_dir, ts) = setup();
        // TodoList is advertised in the native tool definitions.
        assert!(ts.tool_definitions().iter().any(|d| d.name == "TodoList"));

        // Write a list.
        let write = ts
            .execute(
                "TodoList",
                &json!({ "todos": [
                    { "title": "first task", "status": "in_progress" },
                    { "title": "second task", "status": "pending" }
                ] }),
            )
            .expect("TodoList write handled natively");
        assert!(!write.is_error, "{}", write.content);
        assert!(write.content.contains("first task"), "{}", write.content);

        // Query (no `todos`) returns the current list from session state.
        let read = ts.execute("TodoList", &json!({})).expect("TodoList read handled natively");
        assert!(read.content.contains("first task"));
        assert!(read.content.contains("second task"));
    }

    #[test]
    fn read_media_file_returns_an_image_media_part() {
        let (dir, ts) = setup();
        // A minimal 1x1 PNG.
        let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
        let png = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, png_b64).unwrap();
        std::fs::write(dir.path().join("pixel.png"), &png).unwrap();

        assert!(ts.tool_definitions().iter().any(|d| d.name == "ReadMediaFile"));

        let result = ts
            .execute("ReadMediaFile", &json!({ "path": "pixel.png" }))
            .expect("ReadMediaFile handled natively");
        assert!(!result.is_error, "{}", result.content);
        assert_eq!(result.media.len(), 1, "one image media part expected");
        match &result.media[0] {
            crate::rpc::types::ContentBlock::Image { media_type, data } => {
                assert_eq!(media_type, "image/png");
                assert!(!data.is_empty());
            }
            other => panic!("expected an Image block, got {other:?}"),
        }
    }

    #[test]
    fn read_media_file_missing_path_falls_back_to_host() {
        let (_dir, ts) = setup();
        // A path that does not resolve inside the sandbox → None (host handles it).
        assert!(ts.execute("ReadMediaFile", &json!({ "path": "nope.png" })).is_none());
    }

    #[test]
    fn new_rejects_missing_root() {
        assert!(NativeToolset::new("/definitely/not/a/real/dir").is_none());
    }

    // ── Write ─────────────────────────────────────────────────────────

    #[test]
    fn write_creates_a_file_and_reports_utf8_bytes() {
        let (dir, ts) = setup();
        let result = ts
            .execute("Write", &json!({ "path": "new.txt", "content": "héllo" }))
            .unwrap();
        assert!(!result.is_error);
        // "héllo" is 6 UTF-8 bytes — the byte count, not the char count.
        assert_eq!(result.content, "Wrote 6 bytes to new.txt");
        assert_eq!(std::fs::read_to_string(dir.path().join("new.txt")).unwrap(), "héllo");
    }

    #[test]
    fn write_creates_missing_parent_directories() {
        let (dir, ts) = setup();
        let result = ts
            .execute("Write", &json!({ "path": "deep/nested/dir/f.txt", "content": "x" }))
            .unwrap();
        assert!(!result.is_error, "{}", result.content);
        assert!(dir.path().join("deep/nested/dir/f.txt").exists());
    }

    #[test]
    fn write_overwrites_and_appends() {
        let (dir, ts) = setup();
        ts.execute("Write", &json!({ "path": "a.txt", "content": "fresh\n" })).unwrap();
        assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).unwrap(), "fresh\n");
        let appended = ts
            .execute("Write", &json!({ "path": "a.txt", "content": "more\n", "mode": "append" }))
            .unwrap();
        assert_eq!(appended.content, "Appended 5 bytes to a.txt");
        assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).unwrap(), "fresh\nmore\n");
    }

    #[test]
    fn write_outside_the_sandbox_falls_back_to_the_host() {
        let (_dir, ts) = setup();
        assert!(ts.execute("Write", &json!({ "path": "/tmp/escape.txt", "content": "x" })).is_none());
        assert!(ts
            .execute("Write", &json!({ "path": "../escape.txt", "content": "x" }))
            .is_none());
    }

    #[test]
    fn write_to_a_sensitive_file_falls_back_to_the_host() {
        let (_dir, ts) = setup();
        assert!(ts.execute("Write", &json!({ "path": ".env", "content": "SECRET=1" })).is_none());
    }

    #[test]
    fn claims_write_admits_only_what_execute_would_handle() {
        let (dir, ts) = setup();
        // Valid in-sandbox write — claimed, and without side effects: the
        // parent directory must NOT be created by the admission check.
        assert!(ts.claims_write("Write", &json!({ "path": "new/deep/f.txt", "content": "x" })));
        assert!(!dir.path().join("new").exists(), "claims_write must not create directories");
        // Sandbox escape / sensitive file / bad mode / missing args — not claimed.
        assert!(!ts.claims_write("Write", &json!({ "path": "../escape.txt", "content": "x" })));
        assert!(!ts.claims_write("Write", &json!({ "path": "/tmp/escape.txt", "content": "x" })));
        assert!(!ts.claims_write("Write", &json!({ "path": ".env", "content": "x" })));
        assert!(!ts.claims_write("Write", &json!({ "path": "a.txt", "content": "x", "mode": "patch" })));
        assert!(!ts.claims_write("Write", &json!({ "path": "a.txt" })));
        // Edit: requires an existing file and non-empty old_string.
        std::fs::write(dir.path().join("e.txt"), "alpha").unwrap();
        assert!(ts.claims_write("Edit", &json!({ "path": "e.txt", "old_string": "alpha", "new_string": "beta" })));
        assert!(!ts.claims_write("Edit", &json!({ "path": "missing.txt", "old_string": "a", "new_string": "b" })));
        assert!(!ts.claims_write("Edit", &json!({ "path": "e.txt", "old_string": "", "new_string": "b" })));
        // Non-write-class names are never claimed.
        assert!(!ts.claims_write("Read", &json!({ "path": "e.txt" })));
    }

    #[test]
    fn write_with_an_unknown_mode_falls_back() {
        let (_dir, ts) = setup();
        assert!(ts
            .execute("Write", &json!({ "path": "a.txt", "content": "x", "mode": "patch" }))
            .is_none());
    }

    // ── Edit ──────────────────────────────────────────────────────────

    #[test]
    fn edit_replaces_a_unique_occurrence() {
        let (dir, ts) = setup();
        let result = ts
            .execute(
                "Edit",
                &json!({ "path": "a.txt", "old_string": "beta", "new_string": "BETA" }),
            )
            .unwrap();
        assert!(!result.is_error, "{}", result.content);
        assert_eq!(result.content, "Replaced 1 occurrence in a.txt");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "alpha\nBETA\ngamma\n"
        );
    }

    #[test]
    fn edit_missing_old_string_is_the_reload_error() {
        let (_dir, ts) = setup();
        let result = ts
            .execute("Edit", &json!({ "path": "a.txt", "old_string": "nope", "new_string": "x" }))
            .unwrap();
        assert!(result.is_error);
        assert!(result.content.contains("old_string not found in a.txt"));
        assert!(result.content.contains("Read Tool"));
    }

    #[test]
    fn edit_ambiguous_old_string_demands_replace_all_or_context() {
        let (dir, ts) = setup();
        std::fs::write(dir.path().join("dup.txt"), "x y x\n").unwrap();
        let result = ts
            .execute("Edit", &json!({ "path": "dup.txt", "old_string": "x", "new_string": "z" }))
            .unwrap();
        assert!(result.is_error);
        assert!(result.content.contains("not unique in dup.txt (found 2 occurrences)"));
    }

    #[test]
    fn edit_replace_all_counts_occurrences() {
        let (dir, ts) = setup();
        std::fs::write(dir.path().join("dup.txt"), "x y x\n").unwrap();
        let result = ts
            .execute(
                "Edit",
                &json!({ "path": "dup.txt", "old_string": "x", "new_string": "z", "replace_all": true }),
            )
            .unwrap();
        assert_eq!(result.content, "Replaced 2 occurrences in dup.txt");
        assert_eq!(std::fs::read_to_string(dir.path().join("dup.txt")).unwrap(), "z y z\n");
    }

    #[test]
    fn edit_identical_strings_is_the_no_changes_error() {
        let (_dir, ts) = setup();
        let result = ts
            .execute("Edit", &json!({ "path": "a.txt", "old_string": "beta", "new_string": "beta" }))
            .unwrap();
        assert!(result.is_error);
        assert!(result.content.contains("exactly the same"));
    }

    #[test]
    fn edit_pure_crlf_file_matches_lf_and_writes_back_crlf() {
        let (dir, ts) = setup();
        std::fs::write(dir.path().join("win.txt"), "one\r\ntwo\r\nthree\r\n").unwrap();
        // The model edits the LF view, per the Read output contract.
        let result = ts
            .execute(
                "Edit",
                &json!({ "path": "win.txt", "old_string": "one\ntwo", "new_string": "ONE\nTWO" }),
            )
            .unwrap();
        assert!(!result.is_error, "{}", result.content);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("win.txt")).unwrap(),
            "ONE\r\nTWO\r\nthree\r\n",
            "pure-CRLF files materialise back to CRLF"
        );
    }

    #[test]
    fn edit_mixed_line_endings_are_edited_verbatim() {
        let (dir, ts) = setup();
        std::fs::write(dir.path().join("mix.txt"), "a\r\nb\nc\n").unwrap();
        let result = ts
            .execute("Edit", &json!({ "path": "mix.txt", "old_string": "b", "new_string": "B" }))
            .unwrap();
        assert!(!result.is_error);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("mix.txt")).unwrap(),
            "a\r\nB\nc\n",
            "mixed files keep their exact byte layout"
        );
    }

    #[test]
    fn edit_missing_file_and_empty_old_string_fall_back() {
        let (_dir, ts) = setup();
        assert!(ts
            .execute("Edit", &json!({ "path": "ghost.txt", "old_string": "a", "new_string": "b" }))
            .is_none());
        assert!(ts
            .execute("Edit", &json!({ "path": "a.txt", "old_string": "", "new_string": "b" }))
            .is_none());
    }

    #[test]
    fn line_ending_detection_matches_ts() {
        assert_eq!(detect_line_ending_style(b"a\nb\n"), LineEndingStyle::Lf);
        assert_eq!(detect_line_ending_style(b"a\r\nb\r\n"), LineEndingStyle::CrLf);
        assert_eq!(detect_line_ending_style(b"a\r\nb\n"), LineEndingStyle::Mixed);
        assert_eq!(detect_line_ending_style(b"a\rb"), LineEndingStyle::Mixed);
        assert_eq!(detect_line_ending_style(b"plain"), LineEndingStyle::Lf);
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
    fn bash_and_unknown_tools_are_never_handled() {
        // Write/Edit execute natively (post-authorization); Bash stays with
        // the host, whose task system owns process lifecycle.
        let (_dir, ts) = setup();
        assert!(ts.execute("Bash", &json!({ "command": "rm -rf /" })).is_none());
        assert!(ts.execute("FetchURL", &json!({ "url": "https://x" })).is_none());
        // A malformed Edit (missing fields) is not handled either — the host's
        // schema validation owns that error.
        assert!(ts.execute("Edit", &json!({ "path": "a.txt" })).is_none());
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
