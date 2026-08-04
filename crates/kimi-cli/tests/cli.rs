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

/// Unique cwd per `run` invocation — tests share one process id, and two
/// tests running `run()` in parallel must not delete each other's cwd.
static CWD_COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn run(home: &Path, args: &[&str]) -> Output {
    let n = CWD_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let cwd = temp_dir(&format!("cwd{n}"));
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
    assert!(out.contains("version:"), "version line: {out}");
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
        out.contains("needs a terminal") && out.contains("kimi chat"),
        "non-TTY hint present: {out}"
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
fn every_subcommand_help_renders() {
    let home = temp_dir("help-all");
    for sub in ["print", "sessions", "resume", "config", "doctor", "health", "export", "chat", "acp"] {
        let output = run(&home, &[sub, "--help"]);
        assert!(
            output.status.success(),
            "{sub} --help exits 0: {} — {}",
            output.status,
            stderr(&output)
        );
        assert!(
            !stdout(&output).trim().is_empty(),
            "{sub} --help prints a description"
        );
    }
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
fn chat_help_then_quit() {
    let home = temp_dir("chat-help");
    let cwd = temp_dir("chat-help-cwd");
    let mut child = Command::new(binary())
        .args(["chat"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn kimi chat");
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().expect("stdin");
        stdin.write_all(b"/help\n/quit\n").expect("write");
    }
    let output = child.wait_with_output().expect("wait");
    assert!(output.status.success(), "chat exits 0: {}", output.status);
    let out = String::from_utf8_lossy(&output.stdout);
    assert!(out.contains("/resume") && out.contains("/compact"), "help list: {out}");
}

#[test]
fn chat_export_writes_zip() {
    // `kimi chat -s <id>` + `/export` writes <id>.zip in the cwd. The shared
    // store needs KIMI_AGENT_HOME so session/export finds the created session.
    let home = temp_dir("chat-export");
    let cwd = temp_dir("chat-export-cwd");
    let mut child = Command::new(binary())
        .args(["chat", "-s", "s-chat-export"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn kimi chat");
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().expect("stdin");
        stdin.write_all(b"/export\n/quit\n").expect("write");
    }
    let output = child.wait_with_output().expect("wait");
    assert!(output.status.success(), "chat exits 0: {}", output.status);
    let out = String::from_utf8_lossy(&output.stdout);
    assert!(out.contains("exported to"), "export line: {out}");
    assert!(cwd.join("s-chat-export.zip").exists(), "zip written to cwd");
}

#[test]
fn chat_sessions_lists_persisted() {
    // `kimi chat -s <id>` persists the session at create; `/sessions` lists
    // it. KIMI_AGENT_HOME keeps the store shared within the process.
    let home = temp_dir("chat-sessions");
    let cwd = temp_dir("chat-sessions-cwd");
    let mut child = Command::new(binary())
        .args(["chat", "-s", "s-chat-list"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn kimi chat");
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().expect("stdin");
        stdin.write_all(b"/sessions\n/quit\n").expect("write");
    }
    let output = child.wait_with_output().expect("wait");
    assert!(output.status.success(), "chat exits 0: {}", output.status);
    let out = String::from_utf8_lossy(&output.stdout);
    assert!(out.contains("s-chat-list"), "session listed: {out}");
}

#[test]
fn acp_initialize_handshake() {
    // `kimi acp` speaks ACP over stdio: initialize -> protocolVersion.
    let home = temp_dir("acp");
    let cwd = temp_dir("acp-cwd");
    let mut child = Command::new(binary())
        .args(["acp"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn kimi acp");
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().expect("stdin");
        stdin
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"clientCapabilities\":{}}}\n")
            .expect("write");
    }
    let output = child.wait_with_output().expect("wait");
    assert!(output.status.success(), "kimi acp exits 0: {}", output.status);
    let out = String::from_utf8_lossy(&output.stdout);
    let line = out.lines().next().expect("a response line");
    let body: serde_json::Value = serde_json::from_str(line).expect("JSON response");
    assert!(body.get("error").is_none(), "initialize: {body}");
    assert!(
        body["result"]["protocolVersion"].as_str().is_some_and(|v| !v.is_empty()),
        "negotiated protocol version: {body}"
    );
}

#[test]
fn chat_goal_lifecycle() {
    // `/goal` is a pure state op (no LLM): create -> status -> cancel.
    let home = temp_dir("chat-goal");
    let cwd = temp_dir("chat-goal-cwd");
    let mut child = Command::new(binary())
        .args(["chat", "-s", "s-chat-goal"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn kimi chat");
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().expect("stdin");
        stdin
            .write_all(b"/goal do the thing\n/goal-pause\n/goal-resume\n/goal-status\n/goal-cancel\n/quit\n")
            .expect("write");
    }
    let output = child.wait_with_output().expect("wait");
    assert!(output.status.success(), "chat exits 0: {}", output.status);
    let out = String::from_utf8_lossy(&output.stdout);
    assert!(out.contains("objective"), "goal create snapshot: {out}");
    assert!(out.contains("goal paused") && out.contains("goal resumed"), "pause/resume: {out}");
    assert!(out.contains("goal cancelled"), "cancel line: {out}");
}

#[test]
fn upgrade_and_frontend_commands_are_recognized() {
    // Stage-C "待" surface: the Rust CLI recognizes TS-owned commands instead
    // of erroring "unknown subcommand".
    let home = temp_dir("recognized");
    let out = run(&home, &["upgrade"]);
    assert!(out.status.success(), "upgrade exits 0: {}", out.status);
    let text = stdout(&out);
    assert!(text.contains("package manager"), "upgrade hint: {text}");
    for cmd in ["web", "vis"] {
        let out = run(&home, &[cmd]);
        assert!(!out.status.success(), "{cmd} exits non-zero");
        let err = stderr(&out);
        assert!(err.contains("TS distribution"), "{cmd}: {err}");
    }
}

#[test]
fn print_accepts_model_and_plan_flags() {
    // --model/--plan are accepted and run the create->setup->prompt pipeline
    // (setup semantics are asserted in kimi-exec's unit test); with no LLM
    // configured the prompt itself errors fast.
    let home = temp_dir("print-flags");
    let out = run(&home, &["print", "--plan", "--model", "flag-test-model", "hi"]);
    assert!(!out.status.success(), "no LLM -> print errors: {}", out.status);
    let err = stderr(&out);
    assert!(err.contains("error"), "stderr: {err}");
}

#[test]
fn print_continue_resumes_latest_session() {
    // `print --continue` reuses the most recently updated session instead of
    // creating the default kimi-exec session.
    let home = temp_dir("print-continue");
    let cwd = temp_dir("print-continue-cwd");
    let mut child = Command::new(binary())
        .args(["chat", "-s", "continue-me"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn kimi chat");
    {
        use std::io::Write;
        child.stdin.as_mut().expect("stdin").write_all(b"/quit\n").expect("write");
    }
    let out = child.wait_with_output().expect("wait");
    assert!(out.status.success(), "chat exits 0: {}", out.status);

    let out = run(&home, &["print", "--continue", "hi"]);
    assert!(!out.status.success(), "no LLM -> print errors: {}", out.status);
    let list = run(&home, &["sessions", "--json"]);
    let text = stdout(&list);
    assert!(text.contains("continue-me"), "resumed session listed: {text}");
    assert!(!text.contains("kimi-exec"), "no fresh session created: {text}");
}

#[test]
fn print_continue_empty_home_falls_back_to_default_session() {
    // No persisted sessions: --continue must fall back to the default
    // kimi-exec session id instead of failing or crashing (the create step
    // is idempotent, so the prompt still runs and errors fast without LLM).
    let home = temp_dir("print-continue-empty");
    let out = run(&home, &["print", "--continue", "hi"]);
    assert!(!out.status.success(), "no LLM -> print errors: {}", out.status);
    let err = stderr(&out);
    assert!(err.contains("error"), "stderr: {err}");
    let list = run(&home, &["sessions", "--json"]);
    let text = stdout(&list);
    assert!(text.contains("kimi-exec"), "default session id used: {text}");
}

#[test]
fn doctor_tui_validates_specific_file() {
    // `doctor tui <path>` (TS parity): valid TOML -> OK; invalid -> ERROR + 1.
    let home = temp_dir("doctor-tui");
    let valid = home.join("tui-valid.toml");
    std::fs::write(&valid, "[theme]\naccent = \"#ff0000\"\n").expect("write valid");
    let out = run(&home, &["doctor", "tui", valid.to_str().expect("path")]);
    assert!(out.status.success(), "valid tui exits 0: {}", out.status);
    assert!(stdout(&out).contains("tui file: OK"), "stdout: {}", stdout(&out));

    let invalid = home.join("tui-invalid.toml");
    std::fs::write(&invalid, "theme = { accent = }\n").expect("write invalid");
    let out = run(&home, &["doctor", "tui", invalid.to_str().expect("path")]);
    assert!(!out.status.success(), "invalid tui exits 1");
    assert!(stdout(&out).contains("tui file: ERROR"), "stdout: {}", stdout(&out));

    let missing = home.join("tui-missing.toml");
    let out = run(&home, &["doctor", "tui", missing.to_str().expect("path")]);
    assert!(!out.status.success(), "missing tui exits 1");
    assert!(stdout(&out).contains("tui file: ERROR"), "stdout: {}", stdout(&out));
}

#[test]
fn logout_removes_kimi_provider() {
    // `kimi logout` null-patches the kimi provider out of the engine config
    // (offline-safe; an empty config is a no-op deletion).
    let home = temp_dir("logout");
    let out = run(&home, &["logout"]);
    assert!(out.status.success(), "logout exits 0: {}", out.status);
    assert!(stdout(&out).contains("logged out"), "stdout: {}", stdout(&out));
    // The config file still parses afterwards and has no kimi provider.
    let out = run(&home, &["config"]);
    assert!(out.status.success(), "config after logout: {}", out.status);
    let config: serde_json::Value =
        serde_json::from_str(stdout(&out).trim()).expect("config JSON");
    assert!(
        config["providers"].get("kimi").is_none(),
        "no kimi provider left: {}",
        config["providers"]
    );
}

#[test]
fn chat_approval_commands_offline_safe() {
    // /approvals + /approve|/deny are pure state ops (no LLM): an empty store
    // lists nothing and unknown ids resolve to "not found" without erroring.
    let home = temp_dir("chat-approvals");
    let cwd = temp_dir("chat-approvals-cwd");
    let mut child = Command::new(binary())
        .args(["chat", "-s", "s-chat-approvals"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn kimi chat");
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().expect("stdin");
        stdin
            .write_all(b"/help\n/approvals\n/approve nope\n/deny nope\n/quit\n")
            .expect("write");
    }
    let output = child.wait_with_output().expect("wait");
    assert!(output.status.success(), "chat exits 0: {}", output.status);
    let out = String::from_utf8_lossy(&output.stdout);
    assert!(out.contains("no pending approvals"), "approvals list: {out}");
    assert!(out.contains("approval not found"), "unknown id resolve: {out}");
    assert!(out.contains("/approvals") && out.contains("/approve"), "help lists commands: {out}");
}

#[test]
fn chat_plan_mode_toggle() {
    // `/plan on` is a pure state op: no LLM, exit 0.
    let home = temp_dir("chat-plan");
    let cwd = temp_dir("chat-plan-cwd");
    let mut child = Command::new(binary())
        .args(["chat", "-s", "s-chat-plan"])
        .current_dir(&cwd)
        .env("KIMI_AGENT_HOME", &home)
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn kimi chat");
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().expect("stdin");
        stdin
            .write_all(b"/models\n/plan on\n/plan off\n/swarm on\n/swarm off\n/thinking high\n/quit\n")
            .expect("write");
    }
    let output = child.wait_with_output().expect("wait");
    assert!(output.status.success(), "chat exits 0: {}", output.status);
    let out = String::from_utf8_lossy(&output.stdout);
    // /models is config-driven; it must be handled (no crash) and the rest of
    // the mode controls must report their toggles.
    assert!(out.contains("plan mode on") && out.contains("plan mode off"), "plan toggles: {out}");
    assert!(out.contains("swarm mode on") && out.contains("swarm mode off"), "swarm toggles: {out}");
    assert!(out.contains("thinking effort set to high"), "thinking: {out}");
}

#[test]
fn completions_generate_scripts() {
    let home = temp_dir("completions");
    for shell in ["bash", "zsh", "fish"] {
        let output = run(&home, &["completions", shell]);
        assert!(
            output.status.success(),
            "completions {shell} exits 0: {}",
            output.status
        );
        assert!(
            !stdout(&output).trim().is_empty(),
            "completions {shell} prints a script"
        );
    }
}

#[test]
fn provider_list_from_catalog() {
    let home = temp_dir("provider");
    let output = run(&home, &["provider", "list", "--json"]);
    // Network-dependent: on success the raw catalog JSON is printed; on a
    // blocked network the command reports the fetch error without panicking.
    if output.status.success() {
        let value: serde_json::Value =
            serde_json::from_str(stdout(&output).trim()).expect("catalog JSON");
        assert!(value.is_object(), "catalog is an object of providers");
    } else {
        assert!(
            stderr(&output).contains("catalog fetch failed"),
            "graceful fetch error: {}",
            stderr(&output)
        );
    }
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
