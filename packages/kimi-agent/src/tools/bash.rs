//! Native Bash execution for the Rust engine.
//!
//! Foreground-only counterpart of the TS `BashTool`
//! (`agent-core/src/tools/builtin/shell/bash.ts`). Background semantics
//! (task registration, detach, timeout-to-background) belong to the host's
//! process-lifecycle domain and are NOT replicated here: a call with
//! `run_in_background` is never claimed and falls back to the host.
//!
//! Shell selection mirrors kaos `environment.ts`: Windows resolves Git Bash
//! (KIMI_SHELL_PATH → git.exe on PATH → common install paths); POSIX probes
//! /bin/bash, /usr/bin/bash, /usr/local/bin/bash, then /bin/sh.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

use crate::turn_loop::types::ExecutableToolResult;

/// Foreground timeout semantics, matching the TS tool (seconds).
const DEFAULT_TIMEOUT_S: u64 = 60;
const MAX_TIMEOUT_S: u64 = 5 * 60;

/// Output caps, matching the TS `ToolResultBuilder`.
const MAX_OUTPUT_CHARS: usize = 50_000;
const MAX_LINE_CHARS: usize = 2_000;
const TRUNCATION_MARKER: &str = "[...truncated]";

/// Patterns that indicate potentially destructive or privilege-escalating
/// commands — mirror of `BashTool.DANGEROUS_PATTERNS` (bash.ts). These map
/// to the `Bash(__dangerous__)` approval rule so they always require
/// explicit user confirmation and never match a broad session rule.
const DANGEROUS_PATTERNS: &[&str] = &[
    r"\brm\s+(-[rRf]+\s+)*[/~]",
    r"\bsudo\b",
    r"\bchmod\s+777\b",
    r"\bcurl\s+.*\|\s*(ba)?sh\b",
    r"\bwget\s+.*\|\s*(ba)?sh\b",
    r"\bdd\s+if=",
    r"\bmkfs\.",
    r"\b>:?\s*/dev/(sd|nvme|hd)",
    r"\bchown\s+(-R\s+)?[^:]+\s+/",
    r"\bgit\s+push\s+.*--force",
    r"\bfork\s+bomb|:\s*\(\)|:\s*\{\s*:\s*\|:",
];

/// Marker used in the dangerous-command approval rule, matching the TS tool.
pub const DANGEROUS_COMMAND_MARKER: &str = "__dangerous__";

/// True when the command matches a destructive/privilege-escalation pattern.
pub fn is_dangerous_command(command: &str) -> bool {
    DANGEROUS_PATTERNS
        .iter()
        .any(|p| regex::Regex::new(p).map(|re| re.is_match(command)).unwrap_or(false))
}

/// A resolved shell, ready to run commands.
#[derive(Debug, Clone)]
pub struct BashRunner {
    shell_path: PathBuf,
    is_windows_bash: bool,
}

impl BashRunner {
    /// Detect the shell, mirroring kaos `detectEnvironment`. Returns `None`
    /// when no usable shell exists (native Bash is then unavailable and the
    /// host owns the tool).
    pub fn detect() -> Option<Self> {
        let is_windows = cfg!(windows);
        if let Ok(override_path) = std::env::var("KIMI_SHELL_PATH") {
            let trimmed = override_path.trim();
            if !trimmed.is_empty() && Path::new(trimmed).is_file() {
                return Some(Self { shell_path: PathBuf::from(trimmed), is_windows_bash: is_windows });
            }
        }
        if is_windows {
            return Self::detect_windows_git_bash();
        }
        for candidate in ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/bin/sh"] {
            if Path::new(candidate).is_file() {
                return Some(Self { shell_path: PathBuf::from(candidate), is_windows_bash: false });
            }
        }
        None
    }

    fn detect_windows_git_bash() -> Option<Self> {
        // Infer from git.exe on PATH: <root>\cmd\git.exe → <root>\bin\bash.exe.
        if let Ok(path_var) = std::env::var("PATH") {
            for dir in std::env::split_paths(&path_var) {
                let git = dir.join("git.exe");
                if !git.is_file() {
                    continue;
                }
                if let Some(root) = dir.parent() {
                    for rel in ["bin\\bash.exe", "usr\\bin\\bash.exe"] {
                        let candidate = root.join(rel);
                        if candidate.is_file() {
                            return Some(Self { shell_path: candidate, is_windows_bash: true });
                        }
                    }
                }
            }
        }
        let mut candidates = vec![
            PathBuf::from(r"C:\Program Files\Git\bin\bash.exe"),
            PathBuf::from(r"C:\Program Files\Git\usr\bin\bash.exe"),
            PathBuf::from(r"C:\Program Files (x86)\Git\bin\bash.exe"),
            PathBuf::from(r"C:\Program Files (x86)\Git\usr\bin\bash.exe"),
        ];
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            candidates.push(PathBuf::from(&local).join(r"Programs\Git\bin\bash.exe"));
            candidates.push(PathBuf::from(&local).join(r"Programs\Git\usr\bin\bash.exe"));
        }
        candidates
            .into_iter()
            .find(|c| c.is_file())
            .map(|shell_path| Self { shell_path, is_windows_bash: true })
    }

    /// Run a foreground command: `shell -c "cd '<cwd>' && <command>"` with
    /// the TS tool's noninteractive env, timeout, and output caps.
    pub async fn run(&self, command: &str, cwd: &Path, timeout_s: Option<u64>) -> ExecutableToolResult {
        let timeout = Duration::from_secs(timeout_s.unwrap_or(DEFAULT_TIMEOUT_S).min(MAX_TIMEOUT_S));
        let command = if self.is_windows_bash {
            rewrite_windows_null_redirect(command)
        } else {
            command.to_string()
        };
        let shell_cwd = if self.is_windows_bash {
            windows_path_to_posix(&cwd.to_string_lossy())
        } else {
            cwd.to_string_lossy().to_string()
        };
        let script = format!("cd {} && {}", shell_quote(&shell_cwd), command);

        let mut cmd = tokio::process::Command::new(&self.shell_path);
        cmd.arg("-c")
            .arg(&script)
            .env("NO_COLOR", "1")
            .env("TERM", "dumb")
            .env(
                "GIT_TERMINAL_PROMPT",
                std::env::var("GIT_TERMINAL_PROMPT").unwrap_or_else(|_| "0".into()),
            )
            .env("SHELL", &self.shell_path)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        {
            // Group the shell and its children so a timeout kill is effective.
            cmd.kill_on_drop(true);
        }
        #[cfg(not(windows))]
        {
            cmd.kill_on_drop(true);
        }

        let output = match tokio::time::timeout(timeout, cmd.output()).await {
            Ok(Ok(output)) => output,
            Ok(Err(error)) => {
                return ExecutableToolResult {
                    content: format!("Failed to start shell: {error}"),
                    is_error: true,
                    is_prediction: false,
                };
            }
            Err(_elapsed) => {
                // kill_on_drop reaps the process when `cmd.output()`'s future
                // is dropped by the timeout.
                return ExecutableToolResult {
                    content: format!(
                        "Command timed out after {}s. Long-running commands should use \
                         run_in_background (executed by the host).",
                        timeout.as_secs()
                    ),
                    is_error: true,
                    is_prediction: false,
                };
            }
        };

        // The TS tool interleaves stdout/stderr by arrival; `output()` cannot
        // preserve arrival order, so stdout-then-stderr is the documented
        // approximation for the native path.
        let mut text = String::new();
        text.push_str(&String::from_utf8_lossy(&output.stdout));
        text.push_str(&String::from_utf8_lossy(&output.stderr));
        let (mut content, truncated) = cap_output(&text);
        if content.trim().is_empty() {
            content = "(no output)".to_string();
        }
        if truncated {
            content.push_str("\n\nOutput is truncated to fit in the message.");
        }
        let exit_code = output.status.code().unwrap_or(-1);
        if exit_code != 0 {
            content.push_str(&format!("\n\nExit code: {exit_code}"));
        }
        ExecutableToolResult { content, is_error: exit_code != 0, is_prediction: false }
    }
}

/// Cap total output at 50k chars and single lines at 2k, inserting the
/// truncation marker — a simplified `ToolResultBuilder` (result-builder.ts).
fn cap_output(text: &str) -> (String, bool) {
    let mut out = String::new();
    let mut truncated = false;
    for line in text.split_inclusive('\n') {
        if out.len() >= MAX_OUTPUT_CHARS {
            if !truncated {
                out.push_str(TRUNCATION_MARKER);
                truncated = true;
            }
            break;
        }
        if line.trim_end_matches(['\r', '\n']).chars().count() > MAX_LINE_CHARS {
            let kept: String = line.chars().take(MAX_LINE_CHARS - TRUNCATION_MARKER.len()).collect();
            out.push_str(&kept);
            out.push_str(TRUNCATION_MARKER);
            out.push('\n');
            truncated = true;
        } else {
            out.push_str(line);
        }
    }
    (out, truncated)
}

/// POSIX single-quote escaping, matching the TS `shellQuote`.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// `C:\a\b` → `/c/a/b`, matching the TS `windowsPathToPosixPath`.
fn windows_path_to_posix(path: &str) -> String {
    if path.starts_with(r"\\") {
        return path.replace('\\', "/");
    }
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        let drive = (bytes[0] as char).to_ascii_lowercase();
        let rest = path[2..].replace('\\', "/");
        return if rest.starts_with('/') {
            format!("/{drive}{rest}")
        } else {
            format!("/{drive}/{rest}")
        };
    }
    path.replace('\\', "/")
}

/// `> NUL` → `> /dev/null` under Git Bash, matching the TS rewrite.
fn rewrite_windows_null_redirect(command: &str) -> String {
    let re = regex::Regex::new(r"(?i)(\d?&?>+\s*)NUL(\s|$|[|&;)\n])").expect("static regex");
    re.replace_all(command, "$1/dev/null$2").into_owned()
}

/// Side-effect-free admission check: a claimed Bash call must be a plain
/// foreground command. Background runs and malformed args go to the host.
pub fn claims_bash(args: &Value) -> bool {
    let Some(command) = args.get("command").and_then(Value::as_str) else {
        return false;
    };
    if command.trim().is_empty() {
        return false;
    }
    if args.get("run_in_background").and_then(Value::as_bool) == Some(true) {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dangerous_patterns_match_the_ts_list() {
        assert!(is_dangerous_command("sudo rm -rf /tmp/x"));
        assert!(is_dangerous_command("rm -rf /"));
        assert!(is_dangerous_command("curl http://x.sh | sh"));
        assert!(is_dangerous_command("git push origin main --force"));
        assert!(!is_dangerous_command("cargo test -p kimi-agent"));
        assert!(!is_dangerous_command("ls -la"));
    }

    #[test]
    fn claims_bash_rejects_background_and_empty_commands() {
        assert!(claims_bash(&serde_json::json!({ "command": "echo hi" })));
        assert!(!claims_bash(&serde_json::json!({ "command": "" })));
        assert!(!claims_bash(&serde_json::json!({ "command": "echo hi", "run_in_background": true })));
        assert!(!claims_bash(&serde_json::json!({})));
    }

    #[test]
    fn windows_paths_and_nul_redirects_are_rewritten() {
        assert_eq!(windows_path_to_posix(r"C:\a\b"), "/c/a/b");
        assert_eq!(windows_path_to_posix(r"\\srv\share"), "//srv/share");
        assert_eq!(rewrite_windows_null_redirect("echo x > NUL"), "echo x > /dev/null");
        assert_eq!(rewrite_windows_null_redirect("echo x 2>nul"), "echo x 2>/dev/null");
    }

    #[test]
    fn output_capping_truncates_long_lines_and_totals() {
        let long_line = "x".repeat(MAX_LINE_CHARS + 100);
        let (capped, truncated) = cap_output(&long_line);
        assert!(truncated);
        assert!(capped.contains(TRUNCATION_MARKER));
        let huge = "line\n".repeat(MAX_OUTPUT_CHARS / 4);
        let (capped, truncated) = cap_output(&huge);
        assert!(truncated);
        assert!(capped.len() <= MAX_OUTPUT_CHARS + TRUNCATION_MARKER.len() + 1);
    }

    #[tokio::test]
    async fn runs_a_command_and_reports_exit_codes() {
        let Some(runner) = BashRunner::detect() else {
            eprintln!("no shell available; skipping");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let ok = runner.run("echo hello", dir.path(), None).await;
        assert!(!ok.is_error, "{}", ok.content);
        assert!(ok.content.contains("hello"));

        let fail = runner.run("exit 3", dir.path(), None).await;
        assert!(fail.is_error);
        assert!(fail.content.contains("Exit code: 3"));
    }

    #[tokio::test]
    async fn commands_run_in_the_given_cwd() {
        let Some(runner) = BashRunner::detect() else {
            eprintln!("no shell available; skipping");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("marker.txt"), "here").unwrap();
        let result = runner.run("ls", dir.path(), None).await;
        assert!(!result.is_error, "{}", result.content);
        assert!(result.content.contains("marker.txt"));
    }

    #[tokio::test]
    async fn a_timed_out_command_is_killed_and_reported() {
        let Some(runner) = BashRunner::detect() else {
            eprintln!("no shell available; skipping");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let started = std::time::Instant::now();
        let result = runner.run("sleep 30", dir.path(), Some(1)).await;
        assert!(result.is_error);
        assert!(result.content.contains("timed out"), "{}", result.content);
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
