//! kimi-cli integration tests — drive the built `kimi` binary end-to-end
//! (stage C verification). Each test runs in its own temp home + cwd so the
//! engine's config lookup (project `.kimi-code/config.toml`, user config)
//! never leaks real settings in.

use std::io::BufRead;
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

    // `--json` prints a valid empty array instead.
    let output = run(&home, &["sessions", "--json"]);
    assert!(output.status.success());
    assert_eq!(stdout(&output).trim(), "[]");
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

#[test]
fn doctor_config_validates_specific_file() {
    let home = temp_dir("doctor-config");
    let good = home.join("good.toml");
    std::fs::write(
        &good,
        "[providers.mock]\ntype = \"openai\"\nbaseUrl = \"http://localhost:9999/v1\"\n",
    )
    .expect("write");
    let output = run(&home, &["doctor", "config", good.to_str().unwrap()]);
    assert!(output.status.success(), "good config should pass: {}", stderr(&output));
    assert!(stdout(&output).contains("OK"), "OK line: {}", stdout(&output));

    let bad = home.join("bad.toml");
    std::fs::write(&bad, "[model]\nname = \"x\"\n").expect("write");
    let output = run(&home, &["doctor", "config", bad.to_str().unwrap()]);
    assert_eq!(output.status.code(), Some(1), "bad config should fail");
    assert!(stdout(&output).contains("ERROR"), "ERROR line: {}", stdout(&output));

    let output = run(&home, &["doctor", "config", home.join("nope.toml").to_str().unwrap()]);
    assert_eq!(output.status.code(), Some(1), "missing file should fail");
    assert!(stdout(&output).contains("not found"));
}

#[test]
fn config_set_writes_and_persists() {
    // --set writes `.kimi-code/config.toml` under the cwd; both invocations
    // must share the cwd (unlike the `run` helper which mints a fresh one).
    let home = temp_dir("config-set");
    let cwd = temp_dir("config-set-cwd");
    let run_here = |args: &[&str]| {
        Command::new(binary())
            .args(args)
            .current_dir(&cwd)
            .env("KIMI_AGENT_HOME", &home)
            .env("HOME", &home)
            .env_remove("KIMI_MODEL")
            .env_remove("KIMI_MODEL_API_KEY")
            .output()
            .expect("spawn kimi")
    };
    let output = run_here(&[
        "config",
        "--set",
        "defaultModel=test-model",
        "--set",
        "providers.mock.apiKey=sk-test",
    ]);
    assert!(output.status.success(), "config --set failed: {}", stderr(&output));
    assert!(stdout(&output).contains("\"ok\": true"), "result: {}", stdout(&output));
    assert!(
        cwd.join(".kimi-code/config.toml").exists(),
        "config file written under cwd"
    );

    let output = run_here(&["config"]);
    assert!(output.status.success());
    let value: serde_json::Value =
        serde_json::from_str(stdout(&output).trim()).expect("config JSON");
    assert_eq!(value["defaultModel"], "test-model");
    assert_eq!(value["providers"]["mock"]["apiKey"], "sk-test");
}

#[test]
fn bare_invocation_prints_help_and_stage_d_hint() {
    let home = temp_dir("bare");
    let output = run(&home, &[]);
    assert!(output.status.success(), "bare kimi exits 0: {}", output.status);
    let out = stdout(&output);
    assert!(out.contains("Usage:"), "help printed: {out}");
    assert!(
        out.contains("stage D") && out.contains("kimi print"),
        "stage D hint present: {out}"
    );
}

#[test]
fn config_set_rejects_malformed_key() {
    let home = temp_dir("config-set-bad");
    let output = run(&home, &["config", "--set", "no-equals-sign"]);
    assert_eq!(output.status.code(), Some(1), "malformed KEY=VALUE should fail");
    assert!(stderr(&output).contains("KEY=VALUE"), "hint: {}", stderr(&output));
}

#[test]
fn chat_with_closed_stdin_exits_cleanly() {
    // No stdin (output() pipes null) -> the REPL reads EOF and exits without
    // ever touching the LLM.
    let home = temp_dir("chat");
    let output = run(&home, &["chat"]);
    assert!(
        output.status.success(),
        "chat exits 0 on EOF: {} — {}",
        output.status,
        stderr(&output)
    );
}

#[test]
fn chat_quit_command_exits() {
    let home = temp_dir("chat-quit");
    let cwd = temp_dir("chat-cwd");
    let mut child = Command::new(binary())
        .args(["chat"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn kimi chat");
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().expect("stdin");
        stdin.write_all(b"/quit\n").expect("write");
    }
    let status = child.wait().expect("wait");
    assert!(status.success(), "chat /quit exits 0: {status}");
}

#[test]
fn server_mode_verbose_emits_events() {
    // `--verbose` over the Remote path: the serve binary fans engine events
    // to stderr (session.turn.started fires before the LLM call, so it lands
    // even when the LLM is unreachable). Read stderr until the event appears,
    // then kill the CLI (its prompt may hang on an offline LLM afterwards).
    let Some(serve) = serve_bin() else {
        eprintln!("skipping: kimi-server-serve binary not built");
        return;
    };
    let home = temp_dir("server-verbose");
    let cwd = temp_dir("cwd");
    let mut child = Command::new(binary())
        .args([
            "--server",
            serve.to_str().unwrap(),
            "print",
            "hello",
            "--verbose",
        ])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("HOME", &home)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn kimi");
    let stderr = child.stderr.take().expect("stderr");
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(stderr).lines() {
            match line {
                Ok(line) => {
                    if tx.send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let mut seen = false;
    while std::time::Instant::now() < deadline {
        match rx.recv_timeout(std::time::Duration::from_millis(500)) {
            // The CLI renders engine events into progress lines ("turn 0
            // started (session …)") rather than raw "[event] {json}".
            Ok(line) if line.contains("turn ") && line.contains(" started") => {
                seen = true;
                break;
            }
            Ok(_) => {}
            Err(_) => {}
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    assert!(seen, "expected a rendered progress line on stderr");
}
