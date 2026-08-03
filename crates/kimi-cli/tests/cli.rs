//! kimi-cli integration tests — drive the built `kimi` binary end-to-end
//! (stage C verification). Each test runs in its own temp home + cwd so the
//! engine's config lookup (project `.kimi-code/config.toml`, user config)
//! never leaks real settings in.

use std::path::Path;
use std::process::{Command, Output};

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_kimi")
}

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("kimi-cli-it-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("mkdir");
    dir
}

fn run(home: &Path, args: &[&str]) -> Output {
    let cwd = temp_dir("cwd");
    Command::new(binary())
        .args(args)
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", home)
        .env("HOME", home)
        .env_remove("KIMI_MODEL")
        .env_remove("KIMI_MODEL_API_KEY")
        .output()
        .expect("spawn kimi")
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).to_string()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).to_string()
}

#[test]
fn health_reports_ok() {
    let home = temp_dir("health");
    let output = run(&home, &["health"]);
    assert!(output.status.success(), "health exited {}", output.status);
    assert_eq!(stdout(&output).trim(), "ok");
}

#[test]
fn sessions_empty_home_is_empty() {
    let home = temp_dir("sessions");
    let output = run(&home, &["sessions"]);
    assert!(output.status.success(), "sessions exited {}", output.status);
    assert_eq!(stdout(&output), "", "no sessions -> no output");
}

#[test]
fn export_without_id_and_without_yes_errors() {
    let home = temp_dir("export-noarg");
    let output = run(&home, &["export"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(
        stderr(&output).contains("session id"),
        "stderr should explain the requirement: {}",
        stderr(&output)
    );
}

#[test]
fn export_yes_with_no_sessions_errors() {
    let home = temp_dir("export-none");
    let output = run(&home, &["export", "-y"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(
        stderr(&output).contains("no sessions"),
        "stderr should say there are no sessions: {}",
        stderr(&output)
    );
}

#[test]
fn config_prints_without_errors() {
    let home = temp_dir("config");
    let output = run(&home, &["config"]);
    assert!(output.status.success(), "config exited {}", output.status);
    // The config snapshot is valid JSON (defaults at minimum).
    let value: serde_json::Value = serde_json::from_str(stdout(&output).trim())
        .expect("config output is valid JSON");
    assert!(value.is_object());
}

/// The built `kimi-server-serve` binary lives next to `kimi` in target/debug.
fn serve_bin() -> Option<std::path::PathBuf> {
    let kimi = std::path::Path::new(binary());
    let dir = kimi.parent()?;
    let exe = if cfg!(windows) { "kimi-server-serve.exe" } else { "kimi-server-serve" };
    let bin = dir.join(exe);
    bin.exists().then_some(bin)
}

#[test]
fn server_mode_health_ok() {
    // Drive a separate server process over stdio (`--server <bin>`).
    let Some(serve) = serve_bin() else {
        eprintln!("skipping: kimi-server-serve binary not built");
        return;
    };
    let home = temp_dir("server-health");
    let output = run(&home, &["--server", serve.to_str().unwrap(), "health"]);
    assert!(
        output.status.success(),
        "server-mode health exited {}: {}",
        output.status,
        stderr(&output)
    );
    assert_eq!(stdout(&output).trim(), "ok");
}

#[test]
fn server_mode_sessions_empty() {
    let Some(serve) = serve_bin() else {
        eprintln!("skipping: kimi-server-serve binary not built");
        return;
    };
    let home = temp_dir("server-sessions");
    let output = run(&home, &["--server", serve.to_str().unwrap(), "sessions"]);
    assert!(output.status.success(), "server-mode sessions exited {}", output.status);
    assert_eq!(stdout(&output), "", "no sessions -> no output");
}

#[test]
fn doctor_reports_health_and_config_files() {
    let home = temp_dir("doctor");
    let output = run(&home, &["doctor"]);
    assert!(output.status.success(), "doctor exited {}", output.status);
    let out = stdout(&output);
    assert!(out.contains("health: ok"), "health line: {out}");
    assert!(
        out.contains("config parse:") && out.contains("config file:"),
        "config checks present: {out}"
    );
}
