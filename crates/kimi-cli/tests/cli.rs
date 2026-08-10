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
        .env("KIMI_CODE_HOME", home)
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
        stderr(&output).contains("No previous session"),
        "stderr should explain there is nothing to export: {}",
        stderr(&output)
    );
}

#[test]
fn export_yes_with_no_sessions_errors() {
    let home = temp_dir("export-none");
    let output = run(&home, &["export", "-y"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(
        stderr(&output).contains("No previous session"),
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
    assert!(out.contains("Kimi doctor"), "title: {out}");
    assert!(out.contains("health: ok"), "health line: {out}");
    assert!(
        out.contains("OK   config.toml") || out.contains("SKIP config.toml"),
        "config check present: {out}"
    );
    assert!(out.contains("tui.toml"), "tui check present: {out}");
    assert!(
        out.contains("All checked config files are valid."),
        "verdict line: {out}"
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
    assert!(stdout(&output).contains("File does not exist."));
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
            .env("KIMI_CODE_HOME", &home)
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
        home.join("config.toml").exists(),
        "config file written to the user-level config dir"
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
fn chat_session_shows_id_and_renames() {
    // `/session` shows the active session id; `/session set <title>` renames
    // it via session/rename (kimi-server processor).
    let home = temp_dir("chat-session-rename");
    let cwd = temp_dir("chat-session-rename-cwd");
    let mut child = Command::new(binary())
        .args(["chat", "-s", "s-rename-me"])
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
        stdin.write_all(b"/session\n/session set my title\n/quit\n").expect("write");
    }
    let output = child.wait_with_output().expect("wait");
    assert!(output.status.success(), "chat exits 0: {}", output.status);
    let out = String::from_utf8_lossy(&output.stdout);
    assert!(out.contains("s-rename-me"), "session id shown: {out}");
    assert!(out.contains("my title"), "title shown after rename: {out}");
}

#[test]
fn chat_plugins_empty_home_lists_none() {
    // `/plugins` with an empty home lists no installed plugins (the engine
    // reports an empty array rather than failing).
    let home = temp_dir("chat-plugins");
    let cwd = temp_dir("chat-plugins-cwd");
    let mut child = Command::new(binary())
        .args(["chat", "-s", "s-plugins"])
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
        stdin.write_all(b"/plugins\n/quit\n").expect("write");
    }
    let output = child.wait_with_output().expect("wait");
    assert!(output.status.success(), "chat exits 0: {}", output.status);
    let out = String::from_utf8_lossy(&output.stdout);
    assert!(out.contains("no plugins installed"), "empty plugins listed: {out}");
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
    // of erroring "unknown subcommand". `web` now launches the in-process
    // server (spawned separately below); `upgrade`/`vis` keep the hint/error.
    let home = temp_dir("recognized");
    let out = run(&home, &["upgrade"]);
    assert!(out.status.success(), "upgrade exits 0: {}", out.status);
    let text = stdout(&out);
    assert!(text.contains("package manager"), "upgrade hint: {text}");
    let out = run(&home, &["migrate"]);
    assert!(out.status.success(), "migrate exits 0: {}", out.status);
    let text = stdout(&out);
    assert!(text.contains("TS distribution"), "migrate hint: {text}");
    let out = run(&home, &["vis"]);
    assert!(!out.status.success(), "vis exits non-zero");
    let err = stderr(&out);
    assert!(err.contains("TS distribution"), "vis: {err}");
    // `kimi web --no-open --port <ephemeral>` serves the API: probe /health,
    // then let Ctrl-C-less shutdown via killing the child.
    let mut child = Command::new(binary())
        .args(["web", "--no-open", "--port", "28627"])
        .current_dir(&home)
        .env("KIMI_AGENT_HOME", &home)
        .env("HOME", &home)
        .env("KIMI_CODE_HOME", &home)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn kimi web");
    let mut ok = false;
    for _ in 0..40 {
        std::thread::sleep(std::time::Duration::from_millis(250));
        if let Ok(mut stream) =
            std::net::TcpStream::connect(("127.0.0.1", 28627))
        {
            use std::io::{Read, Write};
            let _ = stream.write_all(
                b"GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
            );
            let mut buf = [0u8; 512];
            let _ = stream.read(&mut buf);
            if String::from_utf8_lossy(&buf).contains("200") {
                ok = true;
                break;
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    assert!(ok, "kimi web serves /api/v1/health");
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
fn print_dash_p_alias_runs_the_print_subcommand() {
    // TS parity: the documented headless form `kimi -p "..."` must resolve to
    // the `print` subcommand (clap matches the plain alias on the first token
    // before option parsing).
    let home = temp_dir("print-dash-p");
    let out = run(&home, &["-p", "--plan", "--model", "flag-test-model", "hi"]);
    assert!(!out.status.success(), "no LLM -> print errors: {}", out.status);
    let err = stderr(&out);
    assert!(err.contains("error"), "stderr: {err}");
    let out = run(&home, &["-p", ""]);
    assert!(!out.status.success(), "empty prompt must fail");
    assert!(stderr(&out).contains("cannot be empty"), "stderr: {}", stderr(&out));
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
    assert!(stdout(&out).contains("OK tui.toml"), "stdout: {}", stdout(&out));

    let invalid = home.join("tui-invalid.toml");
    std::fs::write(&invalid, "theme = { accent = }\n").expect("write invalid");
    let out = run(&home, &["doctor", "tui", invalid.to_str().expect("path")]);
    assert!(!out.status.success(), "invalid tui exits 1");
    assert!(stdout(&out).contains("ERROR tui.toml"), "stdout: {}", stdout(&out));

    let missing = home.join("tui-missing.toml");
    let out = run(&home, &["doctor", "tui", missing.to_str().expect("path")]);
    assert!(!out.status.success(), "missing tui exits 1");
    assert!(stdout(&out).contains("ERROR tui.toml"), "stdout: {}", stdout(&out));
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
fn config_delete_removes_section_entry() {
    // `--set providers.acme.apiKey=…` then `--delete providers.acme` round
    // trips through the engine's section-scoped null delete.
    let home = temp_dir("config-del");
    let out = run(&home, &["config", "--set", "providers.acme.apiKey=sk-test"]);
    assert!(out.status.success(), "set: {}", out.status);
    let out = run(&home, &["config", "--delete", "providers.acme"]);
    assert!(out.status.success(), "delete: {}", out.status);
    assert!(stdout(&out).contains("\"ok\": true"), "delete result: {}", stdout(&out));
    let out = run(&home, &["config"]);
    let config: serde_json::Value = serde_json::from_str(stdout(&out).trim()).expect("config JSON");
    assert!(
        config["providers"].get("acme").is_none(),
        "provider removed: {}",
        config["providers"]
    );
}

#[test]
fn provider_remove_deletes_config_entry() {
    // `kimi provider remove <id>` null-patches providers.<id> out of the
    // engine config (offline-safe; an absent provider is a no-op deletion).
    let home = temp_dir("provider-remove");
    let out = run(&home, &["config", "--set", "providers.acme.apiKey=sk-test"]);
    assert!(out.status.success(), "set: {}", out.status);
    let out = run(&home, &["provider", "remove", "acme"]);
    assert!(out.status.success(), "remove: {}", out.status);
    assert!(stdout(&out).contains("Removed provider"), "remove output: {}", stdout(&out));
    let out = run(&home, &["config"]);
    let config: serde_json::Value = serde_json::from_str(stdout(&out).trim()).expect("config JSON");
    assert!(
        config["providers"].get("acme").is_none(),
        "provider removed: {}",
        config["providers"]
    );
}

#[test]
fn provider_remove_unknown_provider_errors() {
    // TS parity: removing a provider that is not configured is an error, not
    // a silent no-op.
    let home = temp_dir("provider-remove-unknown");
    let output = run(&home, &["provider", "remove", "nope"]);
    assert!(!output.status.success(), "unknown provider must fail");
    assert!(
        stderr(&output).contains("not found"),
        "stderr: {}",
        stderr(&output)
    );
}

#[test]
fn print_json_and_stream_json_are_mutually_exclusive() {
    let home = temp_dir("print-json-conflict");
    let output = run(
        &home,
        &["print", "--json", "--output-format", "stream-json", "hi"],
    );
    assert!(!output.status.success(), "conflict must fail");
    assert!(
        stderr(&output).contains("mutually exclusive"),
        "stderr: {}",
        stderr(&output)
    );
}

#[test]
fn print_rejects_empty_prompt_and_model() {
    let home = temp_dir("print-empty");
    let out = run(&home, &["print", ""]);
    assert!(!out.status.success(), "empty prompt must fail");
    assert!(stderr(&out).contains("cannot be empty"), "stderr: {}", stderr(&out));
    let out = run(&home, &["print", "--model", "", "hi"]);
    assert!(!out.status.success(), "empty model must fail");
    assert!(stderr(&out).contains("cannot be empty"), "stderr: {}", stderr(&out));
}

#[test]
fn print_continue_conflicts_with_session_flag() {
    // TS parity: `--continue` and `-S <id>` are mutually exclusive.
    let home = temp_dir("print-continue-conflict");
    let out = run(&home, &["print", "--continue", "-S", "some-session", "hi"]);
    assert!(!out.status.success(), "conflict must fail");
    assert!(
        stderr(&out).contains("cannot be used with"),
        "stderr: {}",
        stderr(&out)
    );
}

#[test]
fn chat_undo_and_fork_offline() {
    // /undo (empty history errors cleanly) + /fork (creates a new session)
    // are pure state ops — no LLM needed.
    let home = temp_dir("chat-undo-fork");
    let cwd = temp_dir("chat-undo-fork-cwd");
    let mut child = Command::new(binary())
        .args(["chat", "-s", "s-undo-fork"])
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
            .write_all(b"/undo\n/fork s-undo-fork-2\n/import some prior context\n/quit\n")
            .expect("write");
    }
    let output = child.wait_with_output().expect("wait");
    assert!(output.status.success(), "chat exits 0: {}", output.status);
    let out = String::from_utf8_lossy(&output.stdout);
    assert!(out.contains("forked to s-undo-fork-2"), "fork line: {out}");
    assert!(out.contains("imported 18 chars"), "import line: {out}");

    // The fork is a persisted session.
    let list = run(&home, &["sessions", "--json"]);
    assert!(stdout(&list).contains("s-undo-fork-2"), "fork listed: {}", stdout(&list));
}

#[test]
fn print_goal_mode_creates_goal() {
    // print --goal runs create -> goal_create -> prompt; the prompt errors
    // without an LLM but the goal persists on the session.
    let home = temp_dir("print-goal");
    let out = run(&home, &["print", "--goal", "do the thing", "hi"]);
    assert!(!out.status.success(), "no LLM -> print errors: {}", out.status);

    // The goal is readable back on the same session via chat /goal-status.
    let cwd = temp_dir("print-goal-cwd");
    let mut child = Command::new(binary())
        .args(["chat", "-s", "kimi-exec"])
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
        stdin.write_all(b"/goal-status\n/quit\n").expect("write");
    }
    let output = child.wait_with_output().expect("wait");
    assert!(output.status.success(), "chat exits 0: {}", output.status);
    let out = String::from_utf8_lossy(&output.stdout);
    assert!(out.contains("do the thing"), "goal persisted on session: {out}");
}

#[test]
fn chat_continue_reuses_latest_session() {
    // chat --continue must reuse the most recent session instead of creating
    // a fresh chat-<pid> one.
    let home = temp_dir("chat-continue");
    let cwd = temp_dir("chat-continue-cwd");

    // Seed a session.
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
    assert!(child.wait_with_output().expect("wait").status.success());

    // --continue picks it up; no fresh chat-* session is created.
    let mut child = Command::new(binary())
        .args(["chat", "--continue"])
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
    assert!(child.wait_with_output().expect("wait").status.success());

    let list = run(&home, &["sessions", "--json"]);
    let text = stdout(&list);
    assert!(text.contains("continue-me"), "seeded session listed: {text}");
    assert!(!text.contains("chat-"), "no fresh chat session created: {text}");
}

#[test]
fn export_with_session_id_writes_zip() {
    // The success path (explicit session id) was untested — only the error
    // branches were covered.
    let home = temp_dir("export-id");
    let cwd = temp_dir("export-id-cwd");
    let mut child = Command::new(binary())
        .args(["chat", "-s", "export-me"])
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
    assert!(child.wait_with_output().expect("wait").status.success());

    let out = run(&home, &["export", "export-me"]);
    assert!(out.status.success(), "export exits 0: {}", out.status);
    assert!(stdout(&out).contains("export-me.zip"), "path printed: {}", stdout(&out));
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
fn provider_catalog_list_from_catalog() {
    let home = temp_dir("provider");
    // `provider catalog list --json` (the catalog browse surface); `provider
    // list` itself now lists *configured* providers.
    let output = run(&home, &["provider", "catalog", "list", "--json"]);
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
fn provider_list_lists_configured_providers() {
    let home = temp_dir("provider-list");
    // Fresh home: no configured providers -> the list prints the empty hint.
    let output = run(&home, &["provider", "list"]);
    assert!(output.status.success(), "provider list exits 0: {}", output.status);
    assert!(
        stdout(&output).contains("no providers configured"),
        "empty hint: {}",
        stdout(&output)
    );
    // A configured provider shows up with a masked apiKey.
    let cfg = home.join("config.toml");
    std::fs::write(
        &cfg,
        "[providers.mock]\ntype = \"openai\"\nbaseUrl = \"http://localhost:9999/v1\"\napiKey = \"sk-test\"\n",
    )
    .expect("write config");
    let output = run(&home, &["provider", "list"]);
    assert!(output.status.success(), "provider list exits 0: {}", output.status);
    let out = stdout(&output);
    assert!(out.contains("mock"), "listed provider: {out}");
    assert!(out.contains("***"), "apiKey masked: {out}");
    assert!(!out.contains("sk-test"), "raw apiKey must not leak: {out}");
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

#[test]
fn provider_catalog_add_imports_models_and_sets_default() {
    use std::io::{Read, Write};
    // A one-shot local fixture catalog server (no network dependency).
    let fixture = r#"{
      "acme": {
        "id": "acme",
        "name": "Acme",
        "api": "https://acme.example/v1",
        "env": ["ACME_API_KEY"],
        "models": {
          "acme-1": { "id": "acme-1", "name": "Acme 1", "status": "active",
            "limit": { "context": 128000, "input": 100000, "output": 8192 },
            "tool_call": true, "reasoning": true,
            "modalities": { "input": ["text", "image"], "output": ["text"] },
            "reasoning_options": [{ "type": "effort", "values": ["low", "high", "none"] }] },
          "old": { "id": "old", "name": "Old", "status": "deprecated",
            "limit": { "context": 8000 },
            "modalities": { "input": ["text"], "output": ["text"] } }
        }
      }
    }"#;
    let body = fixture.to_string();
    let listener = match std::net::TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(e) => panic!("fixture bind: {e}"),
    };
    let addr = listener.local_addr().expect("addr");
    std::thread::spawn(move || {
        match listener.accept() {
            Ok((mut stream, _peer)) => {
                // Consume the request first: dropping a TcpStream with
                // unread data sends RST on Windows, which surfaces in the
                // client as "error sending request".
                let mut buf = [0u8; 8192];
                let _ = stream.read(&mut buf);
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.shutdown(std::net::Shutdown::Write);
                // Drain until the client closes so the drop never RSTs.
                let mut drain = [0u8; 1024];
                let _ = stream.read(&mut drain);
            }
            Err(e) => eprintln!("fixture: accept error: {e}"),
        }
    });

    let home = temp_dir("provider-add");
    let url = format!("http://{addr}");
    std::thread::sleep(std::time::Duration::from_millis(500));
    let output = run(
        &home,
        &[
            "provider", "catalog", "add", "acme", "--api-key", "sk-test", "--default-model",
            "acme-1", "--url", &url,
        ],
    );
    assert!(output.status.success(), "add: {}", stderr(&output));
    assert!(
        stdout(&output).contains("default model acme/acme-1"),
        "stdout: {}",
        stdout(&output)
    );

    // Read the config back and verify the full import shape.
    let cfg = run(&home, &["config"]);
    assert!(cfg.status.success(), "config: {}", stderr(&cfg));
    let value: serde_json::Value =
        serde_json::from_str(stdout(&cfg).trim()).expect("config JSON");
    assert_eq!(value["providers"]["acme"]["type"], "openai");
    assert_eq!(value["providers"]["acme"]["apiKey"], "sk-test");
    assert_eq!(value["providers"]["acme"]["baseUrl"], "https://acme.example/v1");
    assert_eq!(value["defaultModel"], "acme/acme-1");
    assert_eq!(value["models"]["acme/acme-1"]["model"], "acme-1");
    assert_eq!(value["models"]["acme/acme-1"]["max_tokens"], 128000);
    assert!(
        value["models"].get("acme/old").is_none(),
        "deprecated model must not be imported"
    );
    // Note: the engine has no global `[thinking]` config domain (thinking is
    // session-level); `apply_catalog_provider` still accepts the flag for
    // node-sdk parity, and the engine's serde simply ignores it on merge.
}

#[test]
fn provider_catalog_add_requires_base_url_when_catalog_has_none() {
    use std::io::{Read, Write};
    // A provider with no `api` and a non-official npm needs an explicit
    // base URL (the fallback default would point at the wrong host).
    let fixture = r#"{
      "gateway": {
        "id": "gateway",
        "name": "Gateway",
        "npm": "acme-gateway-sdk",
        "models": {
          "g-1": { "id": "g-1", "name": "G 1", "status": "active",
            "limit": { "context": 64000 },
            "modalities": { "input": ["text"], "output": ["text"] } }
        }
      }
    }"#;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("addr");
    let body = fixture.to_string();
    std::thread::spawn(move || {
        // The test drives two imports against the same fixture.
        for _ in 0..2 {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 8192];
                let _ = stream.read(&mut buf);
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.shutdown(std::net::Shutdown::Write);
                let mut drain = [0u8; 1024];
                let _ = stream.read(&mut drain);
            }
        }
    });
    let url = format!("http://{addr}");

    // Without --base-url the import refuses with a hint.
    let home = temp_dir("provider-add-nourl");
    let output = run(&home, &["provider", "catalog", "add", "gateway", "--url", &url]);
    assert!(!output.status.success(), "must refuse: {}", stdout(&output));
    assert!(
        stderr(&output).contains("--base-url"),
        "hint: {}",
        stderr(&output)
    );

    // With --base-url the import proceeds (provider-only — the gateway
    // entry's model carries no context limit, so no aliases are written).
    let home2 = temp_dir("provider-add-url");
    let output = run(
        &home2,
        &[
            "provider", "catalog", "add", "gateway", "--base-url",
            "https://gateway.example/v1", "--url", &url,
        ],
    );
    assert!(output.status.success(), "add: {}", stderr(&output));
    let cfg = run(&home2, &["config"]);
    let value: serde_json::Value =
        serde_json::from_str(stdout(&cfg).trim()).expect("config JSON");
    assert_eq!(value["providers"]["gateway"]["type"], "openai");
    assert_eq!(value["providers"]["gateway"]["baseUrl"], "https://gateway.example/v1");
}
