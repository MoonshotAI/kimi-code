/// Bash tool — execute shell commands.
///
/// Runs commands via the system shell (bash on Unix, Git Bash on Windows).
/// Supports timeouts, working directory, and output capture.
///
/// Mirrors `packages/agent-core/src/tools/builtin/shell/bash.ts`.
use napi_derive::napi;
use std::process::Command;
use std::time::{Duration, Instant};

/// Default timeout for foreground commands (seconds).
pub const DEFAULT_TIMEOUT_S: u64 = 60;
/// Maximum timeout for foreground commands (seconds).
pub const MAX_TIMEOUT_S: u64 = 300;

/// Result of a bash command execution.
#[derive(Debug, Clone)]
#[napi(object)]
pub struct BashResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub error: Option<String>,
}

/// Bash command configuration.
pub struct BashConfig {
    pub command: String,
    pub cwd: Option<String>,
    pub timeout: Option<u64>,
    pub env: Option<Vec<(String, String)>>,
}

impl Default for BashConfig {
    fn default() -> Self {
        Self {
            command: String::new(),
            cwd: None,
            timeout: Some(DEFAULT_TIMEOUT_S),
            env: None,
        }
    }
}

/// Execute a shell command.
///
/// Behavior:
///   - On Unix: runs via `/bin/bash -c <command>`.
///   - On Windows: runs via Git Bash or `cmd.exe /c <command>`.
///   - Captures stdout and stderr.
///   - Applies timeout (default 60s, max 300s for foreground).
///   - Returns exit code, stdout, stderr, and timeout flag.
pub fn bash_exec(config: &BashConfig) -> BashResult {
    let timeout = config
        .timeout
        .unwrap_or(DEFAULT_TIMEOUT_S)
        .min(MAX_TIMEOUT_S);

    let (shell, shell_arg) = detect_shell_for(&config.command);

    let mut cmd = Command::new(&shell);
    cmd.arg(&shell_arg);
    cmd.arg(&config.command);

    // Set working directory.
    if let Some(ref cwd) = config.cwd {
        cmd.current_dir(cwd);
    }

    // Close stdin.
    cmd.stdin(std::process::Stdio::null());

    // Capture stdout and stderr.
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    // Inject non-interactive environment variables so tools like git / node
    // don't open a pager and paints don't colour the stream. Mirrors the
    // TS BashTool's `noninteractiveEnv` block.
    cmd.env("NO_COLOR", "1");
    cmd.env("TERM", "dumb");
    cmd.env("SHELL", &shell);
    if std::env::var("GIT_TERMINAL_PROMPT").is_err() {
        cmd.env("GIT_TERMINAL_PROMPT", "0");
    }

    // Set user-supplied environment variables (override defaults above).
    if let Some(ref env) = config.env {
        for (key, value) in env {
            cmd.env(key, value);
        }
    }

    // Spawn the process.
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return BashResult {
                exit_code: -1,
                stdout: String::new(),
                stderr: String::new(),
                timed_out: false,
                error: Some(format!("Failed to spawn process: {}", e)),
            };
        }
    };

    let start = Instant::now();
    let timeout_duration = Duration::from_secs(timeout);

    // Wait with timeout using a polling approach.
    // This is cross-platform and doesn't require tokio.
    let mut timed_out = false;
    let exit_status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if start.elapsed() >= timeout_duration {
                    // Kill the process on timeout.
                    let _ = child.kill();
                    timed_out = true;
                    break None;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => {
                return BashResult {
                    exit_code: -1,
                    stdout: String::new(),
                    stderr: String::new(),
                    timed_out: false,
                    error: Some(format!("Process error: {}", e)),
                };
            }
        }
    };

    // Collect output.
    let stdout = if let Some(out) = child.stdout.take() {
        read_pipe_to_string(out)
    } else {
        String::new()
    };

    let stderr = if let Some(err) = child.stderr.take() {
        read_pipe_to_string(err)
    } else {
        String::new()
    };

    let exit_code = exit_status
        .map(|s| s.code().unwrap_or(-1))
        .unwrap_or(-1);

    // Truncate output if too large.
    let stdout = truncate_output(&stdout, MAX_OUTPUT_BYTES);
    let stderr = truncate_output(&stderr, MAX_OUTPUT_BYTES);

    BashResult {
        exit_code,
        stdout,
        stderr,
        timed_out,
        error: None,
    }
}

/// Maximum output bytes before truncation.
const MAX_OUTPUT_BYTES: usize = 512 * 1024;

fn truncate_output(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        s.to_string()
    } else {
        let truncated = &s[..max_bytes];
        format!(
            "{}\n\n... (output truncated, {} bytes total)",
            truncated,
            s.len()
        )
    }
}

/// Detect the shell to use for a given command.
///
/// On Windows, .bat/.cmd files must be run via `cmd.exe` because Git Bash
/// does not recognize the `.bat` extension. For all other commands, Git Bash
/// is preferred (when available) for POSIX compatibility.
fn detect_shell_for(command: &str) -> (String, String) {
    #[cfg(unix)]
    {
        let _ = command;
        ("/bin/bash".to_string(), "-c".to_string())
    }
    #[cfg(windows)]
    {
        if is_bat_command(command) {
            return ("cmd.exe".to_string(), "/c".to_string());
        }
        detect_shell()
    }
}

#[cfg(unix)]
fn detect_shell() -> (String, String) {
    ("/bin/bash".to_string(), "-c".to_string())
}

#[cfg(windows)]
fn detect_shell() -> (String, String) {
    // Try Git Bash first.
    if let Ok(git_bash) = which_bash() {
        return (git_bash, "-c".to_string());
    }
    // Fall back to cmd.exe.
    ("cmd.exe".to_string(), "/c".to_string())
}

/// Check if the command is invoking a .bat or .cmd file.
///
/// Extracts the first token of the command (before any whitespace or shell
/// operator) and checks if it ends with `.bat` or `.cmd` (case-insensitive).
#[cfg(windows)]
fn is_bat_command(command: &str) -> bool {
    let trimmed = command.trim_start();
    // Find the end of the first token (whitespace or shell operator).
    let first_token: &str = match trimmed.find(|c: char| c.is_whitespace() || c == '|' || c == '&' || c == ';' || c == '>' || c == '<') {
        Some(idx) => &trimmed[..idx],
        None => trimmed,
    };
    if first_token.is_empty() {
        return false;
    }
    let lower = first_token.to_ascii_lowercase();
    lower.ends_with(".bat") || lower.ends_with(".cmd")
}

#[cfg(windows)]
fn which_bash() -> Result<String, ()> {
    // Check common Git Bash locations.
    let candidates = [
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    ];

    for candidate in &candidates {
        if std::path::Path::new(candidate).exists() {
            return Ok(candidate.to_string());
        }
    }

    // Try PATH.
    if let Ok(output) = Command::new("where").arg("bash").output() {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(first_line) = stdout.lines().next() {
                return Ok(first_line.trim().to_string());
            }
        }
    }

    Err(())
}

use std::io::Read;

fn read_pipe_to_string<R: Read>(mut reader: R) -> String {
    let mut buf = Vec::new();
    let _ = reader.read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bash_simple_command() {
        let result = bash_exec(&BashConfig {
            command: "echo hello".to_string(),
            ..Default::default()
        });
        assert_eq!(result.exit_code, 0);
        assert!(result.stdout.contains("hello"));
        assert!(!result.timed_out);
    }

    #[test]
    fn test_bash_stderr() {
        let result = bash_exec(&BashConfig {
            command: "echo error >&2".to_string(),
            ..Default::default()
        });
        assert_eq!(result.exit_code, 0);
        assert!(result.stderr.contains("error"));
    }

    #[test]
    fn test_bash_nonzero_exit() {
        let result = bash_exec(&BashConfig {
            command: "exit 42".to_string(),
            ..Default::default()
        });
        assert_eq!(result.exit_code, 42);
    }

    #[test]
    fn test_bash_with_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let result = bash_exec(&BashConfig {
            command: "pwd".to_string(),
            cwd: Some(dir.path().to_str().unwrap().to_string()),
            ..Default::default()
        });
        assert_eq!(result.exit_code, 0);
        // On Windows, paths might differ, so just check it doesn't error.
        assert!(result.error.is_none());
    }

    #[test]
    fn test_bash_timeout() {
        let result = bash_exec(&BashConfig {
            command: "sleep 10".to_string(),
            timeout: Some(1),
            ..Default::default()
        });
        assert!(result.timed_out);
    }

    #[test]
    fn test_bash_multiline_output() {
        let result = bash_exec(&BashConfig {
            command: "echo 'line1\nline2\nline3'".to_string(),
            ..Default::default()
        });
        assert_eq!(result.exit_code, 0);
        assert!(result.stdout.contains("line1"));
        assert!(result.stdout.contains("line2"));
        assert!(result.stdout.contains("line3"));
    }

    #[test]
    fn test_bash_with_env() {
        let result = bash_exec(&BashConfig {
            command: "echo $TEST_VAR".to_string(),
            env: Some(vec![("TEST_VAR".to_string(), "hello_world".to_string())]),
            ..Default::default()
        });
        assert_eq!(result.exit_code, 0);
        assert!(result.stdout.contains("hello_world"));
    }

    #[test]
    fn test_bash_empty_command() {
        let result = bash_exec(&BashConfig {
            command: String::new(),
            ..Default::default()
        });
        // Empty command should succeed (bash -c '' is valid).
        assert_eq!(result.exit_code, 0);
    }

    #[cfg(windows)]
    #[test]
    fn test_is_bat_command() {
        assert!(is_bat_command("test.bat"));
        assert!(is_bat_command("build.cmd"));
        assert!(is_bat_command("TEST.BAT"));
        assert!(is_bat_command("test.bat arg1 arg2"));
        assert!(is_bat_command("./scripts/run.bat"));
        assert!(is_bat_command("C:\\path\\to\\script.bat"));
        assert!(!is_bat_command("echo hello"));
        assert!(!is_bat_command("bash script.sh"));
        assert!(!is_bat_command(""));
        assert!(!is_bat_command("test.bat.txt"));
    }
}
