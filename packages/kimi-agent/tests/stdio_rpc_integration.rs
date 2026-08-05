//! Binary integration test: spawn the `kimi-agent` binary and verify the
//! stdio JSON-RPC round-trip works end-to-end.
//!
//! This test exercises the full IPC path:
//!   1. Spawn the release (or debug) binary as a child process
//!   2. Send a JSON-RPC request on stdin
//!   3. Read the JSON-RPC response on stdout
//!   4. Assert the response matches the protocol
//!
//! Tests included:
//!   - `health_check_round_trip`: agent/health returns {"status":"ok","version":"0.1.0"}
//!   - `shutdown_round_trip`: agent/shutdown terminates the process cleanly
//!   - `unknown_method_returns_error`: an unknown method yields a -32601 error
//!   - `run_turn_with_host_callbacks`: run_turn drives host/llm_chat + host/execute_tool
//!
//! These tests require the binary to be built (`cargo build --release` or
//! `cargo build`). They are skipped (with a passing assertion) when the
//! binary is not present, so `cargo test` still works in CI without a prior
//! build step.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

/// Find the kimi-agent binary across both build layouts — the per-crate
/// `target/` (pre-workspace builds) and the workspace-root `target/` —
/// picking the most recently built candidate so a stale binary can never
/// shadow the code under test.
fn find_binary() -> Option<std::path::PathBuf> {
    let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let ext = if cfg!(windows) { ".exe" } else { "" };
    let name = format!("kimi-agent-cli{ext}");
    let roots = [manifest_dir.join("target"), manifest_dir.join("../../target")];
    let mut best: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    for root in &roots {
        for profile in ["release", "debug"] {
            let candidate = root.join(profile).join(&name);
            let Ok(meta) = std::fs::metadata(&candidate) else {
                continue;
            };
            let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
            if best.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
                best = Some((mtime, candidate));
            }
        }
    }
    best.map(|(_, path)| path)
}

/// A simple RPC client driving the child process stdio.
struct RpcClient {
    child: Child,
    stdout: std::io::BufReader<std::process::ChildStdout>,
    next_id: AtomicU32,
}

impl RpcClient {
    fn start() -> Option<Self> {
        Self::start_with_env(std::collections::HashMap::new())
    }

    fn start_with_env(env: std::collections::HashMap<&str, String>) -> Option<Self> {
        let binary = find_binary()?;
        let mut cmd = Command::new(&binary);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().ok()?;
        let stdout = BufReader::new(child.stdout.take()?);
        Some(Self {
            child,
            stdout,
            next_id: AtomicU32::new(1),
        })
    }

    /// Send a JSON-RPC request and read the matching response.
    /// Returns `None` on timeout or IO error.
    fn request(&mut self, method: &str, params: serde_json::Value) -> Option<serde_json::Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let line = serde_json::to_string(&req).ok()? + "\n";
        let stdin = self.child.stdin.as_mut()?;
        stdin.write_all(line.as_bytes()).ok()?;
        stdin.flush().ok()?;

        // Read lines until we find a response with matching id.
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut buf = String::new();
        loop {
            if Instant::now() > deadline {
                return None;
            }
            buf.clear();
            let n = self.stdout.read_line(&mut buf).ok()?;
            if n == 0 {
                return None;
            }
            let trimmed = buf.trim();
            if trimmed.is_empty() {
                continue;
            }
            let parsed: serde_json::Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(_) => continue,
            };
            // A response carries no `method` field.
            if parsed.get("method").is_some() {
                continue;
            }
            if parsed.get("id") == Some(&serde_json::json!(id)) {
                return Some(parsed);
            }
        }
    }

    /// Send a raw line on stdin (used for notifications or raw protocol tests).
    fn send_raw(&mut self, line: &str) -> Option<()> {
        let stdin = self.child.stdin.as_mut()?;
        stdin.write_all(line.as_bytes()).ok()?;
        stdin.write_all(b"\n").ok()?;
        stdin.flush().ok()?;
        Some(())
    }

    fn shutdown(&mut self) {
        let _ = self.request("agent/shutdown", serde_json::json!({}));
        // Give the process a moment to exit.
        std::thread::sleep(Duration::from_millis(100));
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for RpcClient {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Skip the test if the binary is not built.
macro_rules! require_binary {
    ($client:expr) => {
        if $client.is_none() {
            eprintln!("Skipping test: kimi-agent binary not built. Run `cargo build --release`.");
            return;
        }
    };
}

#[test]
fn health_check_round_trip() {
    let mut client = RpcClient::start();
    require_binary!(client);
    let client = client.as_mut().unwrap();

    let resp = client.request("agent/health", serde_json::json!({}));
    let resp = resp.expect("health response within 10s");

    assert_eq!(resp["jsonrpc"], "2.0");
    assert!(resp.get("error").is_none(), "unexpected error: {resp}");
    assert_eq!(resp["result"]["status"], "ok");
    assert_eq!(resp["result"]["version"], "0.1.0");

    client.shutdown();
}

#[test]
fn unknown_method_returns_error() {
    let mut client = RpcClient::start();
    require_binary!(client);
    let client = client.as_mut().unwrap();

    let resp = client.request("agent/nonexistent", serde_json::json!({}));
    let resp = resp.expect("response within 10s");

    assert_eq!(resp["jsonrpc"], "2.0");
    let err = resp.get("error").expect("expected error field");
    assert_eq!(err["code"], -32601);
    assert!(
        err["message"]
            .as_str()
            .unwrap_or("")
            .contains("Method not found")
    );

    client.shutdown();
}

#[test]
fn shutdown_round_trip_terminates_process() {
    let mut client = RpcClient::start();
    require_binary!(client);
    let client = client.as_mut().unwrap();

    // agent/shutdown calls std::process::exit(0) — we expect the process to
    // terminate. The response may or may not flush before exit, so we just
    // verify the process exits within a short window.
    client.send_raw(
        &serde_json::json!({
            "jsonrpc": "2.0",
            "id": 99,
            "method": "agent/shutdown",
            "params": {},
        })
        .to_string(),
    );

    // Wait for the child to exit.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if Instant::now() > deadline {
            // Force-kill and fail.
            let _ = client.child.kill();
            panic!("process did not exit after agent/shutdown");
        }
        match client.child.try_wait() {
            Ok(Some(status)) => {
                assert!(status.success() || status.code() == Some(0));
                return;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
}

/// Full run_turn round-trip with host callbacks.
///
/// The Rust engine calls back into the host (this test process) for
/// `host/llm_chat` and `host/execute_tool`. We respond with a canned LLM
/// that emits one tool call on step 0 and stops on step 1, plus a tool
/// handler returning a known result.
#[test]
fn run_turn_with_host_callbacks() {
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping test: kimi-agent binary not built.");
            return;
        }
    };

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Host-callback scenario: isolate the engine from any ambient config
        // (project + user level) so it uses the host LLM proxy, not a
        // self-read native LLM.
        .env("KIMI_AGENT_HOME", std::env::temp_dir().join("kimi-acp-empty-home"))
        .env("KIMI_CONFIG_PATH", std::env::temp_dir().join("kimi-acp-nonexistent-config.toml"))
        .env("USERPROFILE", std::env::temp_dir().join("kimi-acp-empty-profile"))
        .env("HOME", std::env::temp_dir().join("kimi-acp-empty-home"))
        .spawn()
        .expect("failed to spawn kimi-agent");

    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));
    let llm_step = std::sync::Arc::new(AtomicU32::new(0));

    // Build the agent/run_turn request.
    let run_turn_id: u32 = 1;
    let run_turn_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": run_turn_id,
        "method": "agent/run_turn",
        "params": {
            "turn_id": "integration-test-turn",
            "system_prompt": "You are a test assistant.",
            "model_name": "test-model",
            "messages": [{"role": "user", "content": "read a file"}],
            "tools": [{"name": "read", "description": "Read a file", "input_schema": {"type": "object"}}],
            "max_steps": 5
        }
    });

    // Send agent/run_turn.
    writeln!(stdin, "{}", run_turn_req).unwrap();
    stdin.flush().unwrap();

    let llm_step_for_thread = llm_step.clone();
    let run_turn_id_for_thread = run_turn_id;

    let handler = std::thread::spawn(move || -> Result<serde_json::Value, String> {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);

        loop {
            if Instant::now() > deadline {
                return Err("timed out waiting for agent/run_turn response".into());
            }
            buf.clear();
            let n = stdout.read_line(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("stdout closed before run_turn response".into());
            }
            let trimmed = buf.trim();
            if trimmed.is_empty() {
                continue;
            }
            let msg: serde_json::Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(_) => continue,
            };

            // If this is the agent/run_turn response, return it.
            if msg.get("method").is_none()
                && msg.get("id") == Some(&serde_json::json!(run_turn_id_for_thread))
            {
                return Ok(msg);
            }

            // Otherwise it's a host request — handle it.
            let method = match msg.get("method").and_then(|m| m.as_str()) {
                Some(m) => m,
                None => continue,
            };
            let req_id = msg.get("id").cloned().unwrap_or(serde_json::Value::Null);

            let response = if method == "host/llm_chat" {
                let step = llm_step_for_thread.fetch_add(1, Ordering::SeqCst);
                let tool_calls = if step == 0 {
                    serde_json::json!([{
                        "id": "call-1",
                        "name": "read",
                        "arguments": {"path": "/tmp/test.txt"}
                    }])
                } else {
                    serde_json::json!([])
                };
                let finish_reason = if step == 0 { "tool_calls" } else { "stop" };
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "tool_calls": tool_calls,
                        "finish_reason": finish_reason,
                        "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}
                    }
                })
            } else if method == "host/execute_tool" {
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "content": "file content from host",
                        "is_error": false,
                        "is_prediction": false
                    }
                })
            } else {
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {"code": -32601, "message": format!("unknown method: {method}")}
                })
            };

            writeln!(stdin, "{}", response).map_err(|e| e.to_string())?;
            stdin.flush().map_err(|e| e.to_string())?;
        }
    });

    let result = handler.join().expect("handler thread panicked");
    let resp = result.expect("agent/run_turn response");

    assert_eq!(resp["jsonrpc"], "2.0");
    assert!(
        resp.get("error").is_none(),
        "agent/run_turn returned error: {resp}"
    );
    let result_obj = &resp["result"];
    assert!(
        result_obj["steps"].as_u64() >= Some(2),
        "expected at least 2 steps, got: {result_obj}"
    );
    let stop_reason = result_obj["stop_reason"].as_str().unwrap_or("");
    assert!(
        stop_reason.contains("EndTurn") || stop_reason.contains("End"),
        "expected EndTurn stop reason, got: {stop_reason}"
    );
    let usage = &result_obj["usage"];
    assert!(usage["input_tokens"].as_u64() >= Some(10));
    assert!(usage["output_tokens"].as_u64() >= Some(5));

    // Verify the LLM was called at least twice (step 0 with tool call,
    // step 1 with stop).
    let steps = llm_step.load(Ordering::SeqCst);
    assert!(steps >= 2, "expected at least 2 LLM calls, got {steps}");

    let _ = child.kill();
    let _ = child.wait();
}

/// Verify that a malformed JSON line on stdin produces a parse error
/// response, not a crash.
#[test]
fn malformed_line_does_not_crash() {
    let mut client = RpcClient::start();
    require_binary!(client);
    let client = client.as_mut().unwrap();

    // Send garbage.
    client.send_raw("this is not json at all");

    // Send a valid health check — the server should still be alive.
    let resp = client.request("agent/health", serde_json::json!({}));
    let resp = resp.expect("health response after malformed line");
    assert_eq!(resp["result"]["status"], "ok");

    client.shutdown();
}

/// Verify that a notification (no id) is handled without a response.
#[test]
fn notification_does_not_get_response() {
    let mut client = RpcClient::start();
    require_binary!(client);
    let client = client.as_mut().unwrap();

    // Send a notification — no response expected.
    client.send_raw(
        &serde_json::json!({
            "jsonrpc": "2.0",
            "method": "agent/notify",
            "params": {"event": "test"}
        })
        .to_string(),
    );

    // Now send a real request — we should get its response, not a stray
    // notification response.
    let resp = client.request("agent/health", serde_json::json!({}));
    let resp = resp.expect("health response");
    assert_eq!(resp["result"]["status"], "ok");

    client.shutdown();
}

// ── Cron integration tests ────────────────────────────────────────────────────

/// Test cron/create → cron/list → cron/delete lifecycle.
#[test]
fn cron_create_list_delete() {
    let mut client = RpcClient::start();
    require_binary!(client);
    let client = client.as_mut().unwrap();

    // Create a cron task
    let create_resp = client.request(
        "cron/create",
        serde_json::json!({
            "cron": "0 9 * * *",
            "prompt": "morning reminder",
            "recurring": true
        }),
    );
    let create_resp = create_resp.expect("cron/create response");
    let task_id = create_resp["result"]["id"].as_str().unwrap().to_string();
    assert_eq!(create_resp["result"]["cron"], "0 9 * * *");
    assert_eq!(create_resp["result"]["recurring"], true);

    // List tasks
    let list_resp = client.request("cron/list", serde_json::json!({}));
    let list_resp = list_resp.expect("cron/list response");
    let tasks = list_resp["result"]["tasks"].as_array().unwrap();
    assert!(
        tasks.iter().any(|t| t["id"] == task_id),
        "task should be in list"
    );

    // Delete the task
    let del_resp = client.request(
        "cron/delete",
        serde_json::json!({
            "ids": [task_id]
        }),
    );
    let del_resp = del_resp.expect("cron/delete response");
    assert!(
        del_resp["result"]["removed"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!(task_id))
    );

    // Verify it's gone
    let list_resp2 = client.request("cron/list", serde_json::json!({}));
    let list_resp2 = list_resp2.expect("cron/list response");
    let tasks2 = list_resp2["result"]["tasks"].as_array().unwrap();
    assert!(
        !tasks2.iter().any(|t| t["id"] == task_id),
        "deleted task should not be in list"
    );

    client.shutdown();
}

/// Test cron/get_next_fire returns a valid time.
#[test]
fn cron_get_next_fire() {
    let mut client = RpcClient::start();
    require_binary!(client);
    let client = client.as_mut().unwrap();

    // Create a daily-at-9 task
    let create_resp = client.request(
        "cron/create",
        serde_json::json!({
            "cron": "0 9 * * *",
            "prompt": "daily standup"
        }),
    );
    let create_resp = create_resp.expect("cron/create response");

    // Get next fire time
    let next_resp = client.request(
        "cron/get_next_fire",
        serde_json::json!({
            "task_id": create_resp["result"]["id"]
        }),
    );
    let next_resp = next_resp.expect("cron/get_next_fire response");
    let next_fire = next_resp["result"]["next_fire_at"].as_u64();
    assert!(next_fire.is_some(), "should have a next fire time");
    assert!(next_fire.unwrap() > 0, "next fire time should be positive");

    client.shutdown();
}

// ── Background task integration tests ─────────────────────────────────────────

/// Test bg/register → bg/list → bg/get → bg/stop lifecycle.
#[test]
fn bg_register_list_stop() {
    let mut client = RpcClient::start();
    require_binary!(client);
    let client = client.as_mut().unwrap();

    // Register a background task
    let reg_resp = client.request(
        "bg/register",
        serde_json::json!({
            "prefix": "bash",
            "kind": "process",
            "description": "echo hello",
            "detached": true
        }),
    );
    let reg_resp = reg_resp.expect("bg/register response");
    let task_id = reg_resp["result"]["task_id"].as_str().unwrap().to_string();
    assert!(
        task_id.starts_with("bash-"),
        "task_id should start with bash-"
    );

    // List tasks
    let list_resp = client.request("bg/list", serde_json::json!({}));
    let list_resp = list_resp.expect("bg/list response");
    let tasks = list_resp["result"].as_array().unwrap();
    assert!(
        tasks.iter().any(|t| t["base"]["task_id"] == task_id),
        "task should be in list"
    );

    // Get specific task
    let get_resp = client.request(
        "bg/get",
        serde_json::json!({
            "task_id": task_id
        }),
    );
    let get_resp = get_resp.expect("bg/get response");
    assert_eq!(get_resp["result"]["base"]["task_id"], task_id);

    // Stop the task
    let stop_resp = client.request(
        "bg/stop",
        serde_json::json!({
            "task_id": task_id,
            "reason": "test complete"
        }),
    );
    let stop_resp = stop_resp.expect("bg/stop response");
    assert_eq!(stop_resp["result"]["ok"], true);

    client.shutdown();
}

/// Test bg/register → bg/append_output → bg/output → bg/settle lifecycle.
#[test]
fn bg_append_output_settle() {
    let mut client = RpcClient::start();
    require_binary!(client);
    let client = client.as_mut().unwrap();

    // Register a task
    let reg_resp = client.request(
        "bg/register",
        serde_json::json!({
            "prefix": "bash",
            "kind": "process",
            "description": "long running task"
        }),
    );
    let reg_resp = reg_resp.expect("bg/register response");
    let task_id = reg_resp["result"]["task_id"].as_str().unwrap().to_string();

    // Append output
    let append_resp = client.request(
        "bg/append_output",
        serde_json::json!({
            "task_id": task_id,
            "chunk": "hello world\n"
        }),
    );
    let append_resp = append_resp.expect("bg/append_output response");
    assert_eq!(append_resp["result"]["ok"], true);

    // Get output snapshot
    let output_resp = client.request(
        "bg/output",
        serde_json::json!({
            "task_id": task_id
        }),
    );
    let output_resp = output_resp.expect("bg/output response");
    assert!(
        output_resp["result"]["output_size_bytes"]
            .as_u64()
            .unwrap_or(0)
            > 0
    );
    assert!(
        output_resp["result"]["preview"]
            .as_str()
            .unwrap()
            .contains("hello world")
    );

    // Settle the task
    let settle_resp = client.request(
        "bg/settle",
        serde_json::json!({
            "task_id": task_id,
            "status": "completed",
            "stop_reason": "task finished"
        }),
    );
    let settle_resp = settle_resp.expect("bg/settle response");
    assert_eq!(settle_resp["result"]["ok"], true);

    // Verify terminal status
    let get_resp = client.request(
        "bg/get",
        serde_json::json!({
            "task_id": task_id
        }),
    );
    let get_resp = get_resp.expect("bg/get response");
    assert_eq!(get_resp["result"]["base"]["status"], "completed");

    client.shutdown();
}

// ── Session-owned agent surface ───────────────────────────────────────

/// Drives one `session/prompt` request, answering host callbacks from an
/// LLM script and collecting `host/event` notifications. Returns the prompt
/// response. `inject_after_llm_call` writes a raw request line right after
/// the Nth LLM reply — that is how a mid-flight `session/cancel` rides the
/// same stdin pipe.
fn drive_session_prompt(
    stdin: &mut std::process::ChildStdin,
    stdout: &mut BufReader<std::process::ChildStdout>,
    prompt_id: u32,
    llm_script: &mut dyn FnMut(u32, &serde_json::Value) -> serde_json::Value,
    events: &mut Vec<serde_json::Value>,
    host_tool_calls: &mut u32,
    mut inject_after_llm_call: Option<(u32, String)>,
) -> Result<serde_json::Value, String> {
    let mut llm_calls: u32 = 0;
    let mut buf = String::new();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if Instant::now() > deadline {
            return Err("timed out waiting for session/prompt response".into());
        }
        buf.clear();
        let n = stdout.read_line(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("stdout closed before session/prompt response".into());
        }
        let trimmed = buf.trim();
        if trimmed.is_empty() {
            continue;
        }
        let msg: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match (msg.get("method").and_then(|m| m.as_str()), msg.get("id")) {
            // The prompt response we are waiting for.
            (None, Some(id)) if *id == serde_json::json!(prompt_id) => return Ok(msg),
            // Responses to other requests (e.g. session/cancel): ignore.
            (None, _) => continue,
            // Fire-and-forget notifications: collect lifecycle events.
            (Some("host/event"), None) => {
                if let Some(params) = msg.get("params") {
                    events.push(params.clone());
                }
            }
            (Some(method), Some(id)) => {
                let response = if method == "host/llm_chat" {
                    llm_calls += 1;
                    let tool_calls = llm_script(llm_calls, &msg);
                    let finish = if tool_calls.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
                        "tool_calls"
                    } else {
                        "stop"
                    };
                    serde_json::json!({
                        "jsonrpc": "2.0", "id": id,
                        "result": {
                            "tool_calls": tool_calls,
                            "finish_reason": finish,
                            "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}
                        }
                    })
                } else if method == "host/execute_tool" {
                    *host_tool_calls += 1;
                    serde_json::json!({
                        "jsonrpc": "2.0", "id": id,
                        "result": {"content": "ok", "is_error": false, "is_prediction": false}
                    })
                } else {
                    serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": null })
                };
                writeln!(stdin, "{response}").map_err(|e| e.to_string())?;
                stdin.flush().map_err(|e| e.to_string())?;
                if method == "host/llm_chat" {
                    if let Some((after, _)) = inject_after_llm_call {
                        if llm_calls >= after {
                            let (_, line) = inject_after_llm_call.take().unwrap();
                            writeln!(stdin, "{line}").map_err(|e| e.to_string())?;
                            stdin.flush().map_err(|e| e.to_string())?;
                        }
                    }
                }
            }
            _ => continue,
        }
    }
}

/// The session surface end-to-end: create → prompt (CreateGoal → engine-owned
/// continuation with the canonical steering → UpdateGoal complete) → save →
/// load. Goal tools must settle inside the engine, never at the host.
#[test]
fn session_prompt_drives_the_goal_and_persists() {
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping test: kimi-agent binary not built.");
            return;
        }
    };
    let goal_home = std::env::temp_dir().join(format!(
        "kimi-agent-it-goal-{}",
        std::process::id()
    ));
    let _ = std::fs::create_dir_all(&goal_home);
    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Isolate the engine home: the integration tests run in parallel
        // threads, and a shared default home (the SQLite sessions store)
        // races concurrent create/save/destroy across child processes.
        .env("KIMI_AGENT_HOME", &goal_home)
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let create = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {"session_id": "it-s1", "system_prompt": "test", "model": "mock", "goal_enabled": true}
    });
    writeln!(stdin, "{create}").unwrap();
    stdin.flush().unwrap();

    let prompt = serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "session/prompt",
        "params": {"session_id": "it-s1", "input": [{"type": "text", "text": "pursue the goal"}]}
    });
    writeln!(stdin, "{prompt}").unwrap();
    stdin.flush().unwrap();

    let mut events = Vec::new();
    let mut host_tools = 0u32;
    let mut saw_steering = false;
    let response = drive_session_prompt(
        &mut stdin,
        &mut stdout,
        2,
        &mut |call, msg| {
            if serde_json::to_string(&msg["params"]["messages"])
                .unwrap_or_default()
                .contains("Continue working toward the active thread goal")
            {
                saw_steering = true;
            }
            match call {
                1 => serde_json::json!([{"id": "g1", "name": "CreateGoal", "arguments": {"objective": "finish it"}}]),
                3 => serde_json::json!([{"id": "g2", "name": "UpdateGoal", "arguments": {"status": "complete", "reason": "done"}}]),
                _ => serde_json::json!([]),
            }
        },
        &mut events,
        &mut host_tools,
        None,
    )
    .expect("prompt response");

    assert_eq!(response["result"]["stop_reason"], "EndTurn", "got: {response}");
    assert_eq!(host_tools, 0, "goal tools must settle inside the engine");
    assert!(saw_steering, "the continuation steering must reach the model");
    let types: Vec<&str> = events.iter().filter_map(|e| e["type"].as_str()).collect();
    assert!(types.contains(&"session.turn.started"));
    assert!(types.contains(&"session.turn.ended"));

    // Persistence round trip inside the same engine process.
    let mut client_like = |id: u32, method: &str, params: serde_json::Value| {
        let req = serde_json::json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        writeln!(stdin, "{req}").unwrap();
        stdin.flush().unwrap();
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            assert!(Instant::now() <= deadline, "timed out on {method}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed during {method}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else {
                continue;
            };
            if msg.get("method").is_none() && msg.get("id") == Some(&serde_json::json!(id)) {
                return msg;
            }
        }
    };
    let saved = client_like(3, "session/save", serde_json::json!({"session_id": "it-s1"}));
    assert_eq!(saved["result"]["ok"], true);
    let loaded = client_like(4, "session/load", serde_json::json!({"session_id": "it-s1"}));
    assert_eq!(loaded["result"]["found"], true);

    let _ = child.kill();
    let _ = child.wait();
}

/// Resume round trip: a session's workdir is recorded for `session/list`, and
/// re-creating the same id (as a resume does before `session/load`) preserves
/// the persisted agent state — the restored context is readable afterwards.
#[test]
fn session_list_reports_workdir_and_resume_restores_context() {
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping test: kimi-agent binary not built.");
            return;
        }
    };
    let home =
        std::env::temp_dir().join(format!("kimi-agent-it-resume-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&home);
    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("KIMI_AGENT_HOME", &home)
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let create = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {"session_id": "it-resume", "homedir": "/work/x", "system_prompt": "test",
                   "model": "mock", "goal_enabled": false}
    });
    writeln!(stdin, "{create}").unwrap();
    stdin.flush().unwrap();

    let prompt = serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "session/prompt",
        "params": {"session_id": "it-resume", "input": [{"type": "text", "text": "hello rust"}]}
    });
    writeln!(stdin, "{prompt}").unwrap();
    stdin.flush().unwrap();

    let mut events = Vec::new();
    let mut host_tools = 0u32;
    let response = drive_session_prompt(
        &mut stdin,
        &mut stdout,
        2,
        &mut |_call, _msg| serde_json::json!([]),
        &mut events,
        &mut host_tools,
        None,
    )
    .expect("prompt response");
    assert_eq!(response["result"]["stop_reason"], "EndTurn", "got: {response}");

    let mut client_like = |id: u32, method: &str, params: serde_json::Value| {
        let req = serde_json::json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        writeln!(stdin, "{req}").unwrap();
        stdin.flush().unwrap();
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            assert!(Instant::now() <= deadline, "timed out on {method}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed during {method}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else {
                continue;
            };
            if msg.get("method").is_none() && msg.get("id") == Some(&serde_json::json!(id)) {
                return msg;
            }
        }
    };

    // Persist, then list: the record must carry the recorded workdir.
    let saved = client_like(3, "session/save", serde_json::json!({"session_id": "it-resume"}));
    assert_eq!(saved["result"]["ok"], true);
    let listed = client_like(4, "session/list", serde_json::json!({}));
    let records = listed["result"]["sessions"].as_array().expect("sessions array");
    let resumed_record = records
        .iter()
        .find(|r| r["id"] == "it-resume")
        .expect("session listed");
    assert_eq!(resumed_record["work_dir"], "/work/x");

    // Re-create the same id (resume path) — the persisted record must
    // survive, and load must restore the prompt context.
    let recreated = client_like(
        5,
        "session/create",
        serde_json::json!({"session_id": "it-resume", "homedir": "/work/x",
                           "system_prompt": "test", "model": "mock", "goal_enabled": false}),
    );
    assert!(recreated.get("error").is_none(), "re-create failed: {recreated}");
    let loaded = client_like(6, "session/load", serde_json::json!({"session_id": "it-resume"}));
    assert_eq!(loaded["result"]["found"], true);
    let ctx = client_like(7, "session/get_context", serde_json::json!({"session_id": "it-resume"}));
    let history = ctx["result"]["history"].as_array().expect("history array");
    assert!(
        serde_json::to_string(&history).unwrap_or_default().contains("hello rust"),
        "resumed context must include the prompt; got: {ctx}"
    );

    // The resume re-create must not have wiped the persisted workdir.
    let relisted = client_like(8, "session/list", serde_json::json!({}));
    let records = relisted["result"]["sessions"].as_array().expect("sessions array");
    let record = records
        .iter()
        .find(|r| r["id"] == "it-resume")
        .expect("session listed after resume");
    assert_eq!(record["work_dir"], "/work/x");

    let _ = child.kill();
    let _ = child.wait();
}
#[test]
fn session_cancel_aborts_the_prompt_and_pauses_the_goal() {
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping test: kimi-agent binary not built.");
            return;
        }
    };
    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let create = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {"session_id": "it-c1", "system_prompt": "test", "model": "mock", "goal_enabled": true}
    });
    writeln!(stdin, "{create}").unwrap();
    stdin.flush().unwrap();

    let prompt = serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "session/prompt",
        "params": {"session_id": "it-c1", "input": [{"type": "text", "text": "never stop"}]}
    });
    writeln!(stdin, "{prompt}").unwrap();
    stdin.flush().unwrap();

    let mut events = Vec::new();
    let mut host_tools = 0u32;
    // The model never volunteers to stop (every step asks for another goal
    // tool); a `session/cancel` injected right after the second LLM reply is
    // the only way the turn can end — the engine must abort at the next step
    // boundary and pause the goal with interrupt semantics.
    let cancel_line = serde_json::json!({
        "jsonrpc": "2.0", "id": 99, "method": "session/cancel",
        "params": {"session_id": "it-c1"}
    })
    .to_string();
    let response = drive_session_prompt(
        &mut stdin,
        &mut stdout,
        2,
        &mut |call, _msg| {
            if call == 1 {
                serde_json::json!([{"id": "g1", "name": "CreateGoal", "arguments": {"objective": "run forever"}}])
            } else {
                serde_json::json!([{"id": format!("k{call}"), "name": "GoalStatus", "arguments": {}}])
            }
        },
        &mut events,
        &mut host_tools,
        Some((2, cancel_line)),
    )
    .expect("prompt response");

    assert_eq!(
        response["result"]["stop_reason"], "Aborted",
        "a cancelled prompt must abort, got: {response}"
    );
    let goal_updates: Vec<&str> = events
        .iter()
        .filter(|e| e["type"] == "session.goal.updated")
        .filter_map(|e| e["status"].as_str())
        .collect();
    assert_eq!(
        goal_updates.last(),
        Some(&"Paused"),
        "the goal must pause as interrupted, events: {events:?}"
    );

    let _ = child.kill();
    let _ = child.wait();
}

// ── Native-transport integration (no JS host for LLM / read tools) ─────────
//
// These tests prove the "去 host 化" claim behaviorally: with a native LLM
// transport pointed at an in-process stub provider (and native tools enabled),
// the engine drives the whole turn itself — the host answers ZERO `host/*`
// callbacks. Mirrors `.tmp/e2e-native.mjs` but lives in `cargo test` so CI
// guards against regressions.

use std::io::Read as _;
use std::net::TcpListener;
use std::sync::Mutex;

/// Find the first occurrence of `needle` in `haystack`.
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Encode a list of JSON objects as an SSE `data:` stream terminated by
/// `[DONE]`, matching the OpenAI / Gemini streaming wire the engine parses.
fn sse(objs: &[serde_json::Value]) -> String {
    let mut out = String::new();
    for o in objs {
        out.push_str("data: ");
        out.push_str(&o.to_string());
        out.push_str("\n\n");
    }
    out.push_str("data: [DONE]\n\n");
    out
}

/// A blocking HTTP/SSE stub standing in for an OpenAI-compatible provider.
/// Serves one SSE response per connection; `responder(call_index)` returns the
/// SSE body. Records each request body for assertions.
struct SseStub {
    port: u16,
    bodies: std::sync::Arc<Mutex<Vec<String>>>,
}

fn spawn_sse_stub(responder: impl Fn(usize) -> String + Send + 'static) -> SseStub {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind stub");
    let port = listener.local_addr().unwrap().port();
    let bodies = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
    let bodies_thread = bodies.clone();
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(mut stream) = conn else { break };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
            // Read headers, then the Content-Length body.
            let mut buf: Vec<u8> = Vec::new();
            let mut tmp = [0u8; 2048];
            let mut clen: Option<usize> = None;
            let mut body_start = 0usize;
            loop {
                if let (Some(cl), true) = (clen, body_start > 0) {
                    if buf.len() >= body_start + cl {
                        break;
                    }
                }
                match stream.read(&mut tmp) {
                    Ok(0) => break,
                    Ok(n) => {
                        buf.extend_from_slice(&tmp[..n]);
                        if clen.is_none() {
                            if let Some(pos) = find_subslice(&buf, b"\r\n\r\n") {
                                let header = String::from_utf8_lossy(&buf[..pos]).to_lowercase();
                                clen = Some(
                                    header
                                        .lines()
                                        .find_map(|l| l.strip_prefix("content-length:"))
                                        .and_then(|v| v.trim().parse::<usize>().ok())
                                        .unwrap_or(0),
                                );
                                body_start = pos + 4;
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
            let body = if body_start > 0 && body_start <= buf.len() {
                String::from_utf8_lossy(&buf[body_start..]).to_string()
            } else {
                String::new()
            };
            let idx = {
                let mut b = bodies_thread.lock().unwrap();
                b.push(body);
                b.len() - 1
            };
            let payload = responder(idx);
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{payload}"
            );
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
        }
    });
    SseStub { port, bodies }
}

/// Spawn the binary, send one `agent/run_turn`, answer any `host/*` request
/// (recording its method), and return the `(response, host_methods)`.
fn run_native_turn(
    params: serde_json::Value,
    env: &[(&str, &str)],
) -> Option<(serde_json::Value, Vec<String>)> {
    let binary = find_binary()?;
    let mut cmd = Command::new(&binary);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().ok()?;
    let mut stdin = child.stdin.take()?;
    let mut stdout = BufReader::new(child.stdout.take()?);

    let req = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "agent/run_turn", "params": params
    });
    writeln!(stdin, "{req}").ok()?;
    stdin.flush().ok()?;

    let mut host_methods: Vec<String> = Vec::new();
    let mut buf = String::new();
    let deadline = Instant::now() + Duration::from_secs(30);
    let result = loop {
        if Instant::now() > deadline {
            break None;
        }
        buf.clear();
        let n = stdout.read_line(&mut buf).ok()?;
        if n == 0 {
            break None;
        }
        let trimmed = buf.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        match msg.get("method").and_then(|m| m.as_str()) {
            None => {
                if msg.get("id") == Some(&serde_json::json!(1)) {
                    break Some(msg);
                }
            }
            // Fire-and-forget notifications carry no id: ignore for host-method
            // accounting (only request/response round-trips count).
            Some("host/event") => {}
            Some(method) => {
                if let Some(id) = msg.get("id").filter(|v| !v.is_null()) {
                    host_methods.push(method.to_string());
                    let resp = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": null });
                    writeln!(stdin, "{resp}").ok()?;
                    stdin.flush().ok()?;
                }
            }
        }
    };
    let _ = child.kill();
    let _ = child.wait();
    result.map(|r| (r, host_methods))
}

/// Create a unique temp workspace dir with a single file, returning the dir.
fn temp_workspace(file: &str, contents: &str) -> std::path::PathBuf {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let pid = std::process::id();
    let dir = std::env::temp_dir().join(format!("kimi-it-ws-{pid}-{n}"));
    std::fs::create_dir_all(&dir).expect("create workspace");
    std::fs::write(dir.join(file), contents).expect("write file");
    dir
}

#[test]
fn native_llm_text_turn_needs_no_host() {
    if find_binary().is_none() {
        eprintln!("Skipping: kimi-agent binary not built.");
        return;
    }
    let stub = spawn_sse_stub(|_| {
        sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "content": "NATIVE-OK" }, "finish_reason": null }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 5, "completion_tokens": 2 } }),
        ])
    });

    let (resp, host_methods) = run_native_turn(
        serde_json::json!({
            "turn_id": "it-native-text",
            "system_prompt": "test",
            "model_name": "stub-model",
            "messages": [{"role": "user", "content": "hi"}],
            "tools": [],
            "max_steps": 3,
            "native_llm": {
                "protocol": "openai",
                "base_url": format!("http://127.0.0.1:{}/v1", stub.port),
                "api_key": "stub",
                "model": "stub-model"
            }
        }),
        &[],
    )
    .expect("native turn response");

    assert!(resp.get("error").is_none(), "unexpected error: {resp}");
    assert_eq!(resp["result"]["stop_reason"], "EndTurn", "got: {resp}");
    assert_eq!(stub.bodies.lock().unwrap().len(), 1, "provider called once");
    assert!(
        host_methods.is_empty(),
        "text turn must need zero host callbacks, saw: {host_methods:?}"
    );
}

#[test]
fn native_read_tool_feeds_result_back_without_host() {
    if find_binary().is_none() {
        eprintln!("Skipping: kimi-agent binary not built.");
        return;
    }
    let ws = temp_workspace("secret.txt", "NATIVE-FILE-BODY-77");
    let stub = spawn_sse_stub(|i| {
        if i == 0 {
            sse(&[
                serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
                serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "call_1", "type": "function", "function": { "name": "Read", "arguments": "" } }] } }] }),
                serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": "{\"path\":\"secret.txt\"}" } }] } }] }),
                serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }], "usage": { "prompt_tokens": 9, "completion_tokens": 4 } }),
            ])
        } else {
            sse(&[
                serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
                serde_json::json!({ "choices": [{ "delta": { "content": "done" }, "finish_reason": null }] }),
                serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 20, "completion_tokens": 1 } }),
            ])
        }
    });

    let (resp, host_methods) = run_native_turn(
        serde_json::json!({
            "turn_id": "it-native-read",
            "system_prompt": "test",
            "model_name": "stub-model",
            "messages": [{"role": "user", "content": "read secret.txt"}],
            "tools": [{"name": "Read", "description": "Read a file", "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}],
            "max_steps": 5,
            "native_llm": {
                "protocol": "openai",
                "base_url": format!("http://127.0.0.1:{}/v1", stub.port),
                "api_key": "stub",
                "model": "stub-model"
            },
            "workspace_root": ws.to_string_lossy(),
            "native_tools": true
        }),
        &[],
    )
    .expect("native read response");

    assert!(resp.get("error").is_none(), "unexpected error: {resp}");
    assert_eq!(resp["result"]["stop_reason"], "EndTurn", "got: {resp}");
    let bodies = stub.bodies.lock().unwrap();
    assert_eq!(bodies.len(), 2, "provider called twice (initial + after tool)");
    assert!(
        bodies[1].contains("NATIVE-FILE-BODY-77"),
        "the natively-read file bytes must be fed back to the provider; body: {}",
        bodies[1]
    );
    assert!(
        host_methods.is_empty(),
        "read is not gated — zero host callbacks expected, saw: {host_methods:?}"
    );

    let _ = std::fs::remove_dir_all(&ws);
}

#[test]
fn native_write_under_yolo_needs_no_host_authorize() {
    if find_binary().is_none() {
        eprintln!("Skipping: kimi-agent binary not built.");
        return;
    }
    let ws = temp_workspace("placeholder.txt", "x");
    let stub = spawn_sse_stub(|i| {
        if i == 0 {
            sse(&[
                serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
                serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "call_w", "type": "function", "function": { "name": "Write", "arguments": "" } }] } }] }),
                serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": "{\"path\":\"out.txt\",\"content\":\"YOLO-NATIVE\"}" } }] } }] }),
                serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }], "usage": { "prompt_tokens": 9, "completion_tokens": 4 } }),
            ])
        } else {
            sse(&[
                serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
                serde_json::json!({ "choices": [{ "delta": { "content": "ok" }, "finish_reason": null }] }),
                serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 15, "completion_tokens": 1 } }),
            ])
        }
    });

    let (resp, host_methods) = run_native_turn(
        serde_json::json!({
            "turn_id": "it-native-write",
            "system_prompt": "test",
            "model_name": "stub-model",
            "messages": [{"role": "user", "content": "write out.txt"}],
            "tools": [{"name": "Write", "description": "Write a file", "input_schema": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}}],
            "max_steps": 5,
            "native_llm": {
                "protocol": "openai",
                "base_url": format!("http://127.0.0.1:{}/v1", stub.port),
                "api_key": "stub",
                "model": "stub-model"
            },
            "workspace_root": ws.to_string_lossy(),
            "native_tools": true
        }),
        // Yolo mode: the native permission gate approves locally, so the
        // write must land on disk without any host authorize round-trip.
        &[("KIMI_PERMISSION_MODE", "yolo")],
    )
    .expect("native write response");

    assert!(resp.get("error").is_none(), "unexpected error: {resp}");
    let written = std::fs::read_to_string(ws.join("out.txt")).unwrap_or_default();
    assert_eq!(written, "YOLO-NATIVE", "native Write must land on disk under yolo");
    assert!(
        !host_methods.iter().any(|m| m == "host/authorize_tool_execution"),
        "yolo mode approves locally — no host authorize expected, saw: {host_methods:?}"
    );
    assert!(
        !host_methods.iter().any(|m| m == "host/execute_tool"),
        "Write executes natively, not via the host, saw: {host_methods:?}"
    );

    let _ = std::fs::remove_dir_all(&ws);
}

#[test]
fn permission_set_mode_rpc_makes_write_native() {
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    let ws = temp_workspace("placeholder.txt", "x");
    let stub = spawn_sse_stub(|i| {
        if i == 0 {
            sse(&[
                serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
                serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "call_w", "type": "function", "function": { "name": "Write", "arguments": "" } }] } }] }),
                serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": "{\"path\":\"rpc.txt\",\"content\":\"SET-VIA-RPC\"}" } }] } }] }),
                serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }], "usage": { "prompt_tokens": 9, "completion_tokens": 4 } }),
            ])
        } else {
            sse(&[
                serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
                serde_json::json!({ "choices": [{ "delta": { "content": "ok" }, "finish_reason": null }] }),
                serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 15, "completion_tokens": 1 } }),
            ])
        }
    });

    // Default env → Manual mode. Spawn without KIMI_PERMISSION_MODE.
    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    // Read lines until a response with the given id arrives; answer any
    // host/* request (recording its method) meanwhile.
    let read_response = |stdin: &mut std::process::ChildStdin,
                             stdout: &mut BufReader<std::process::ChildStdout>,
                             want_id: u32,
                             host_methods: &mut Vec<String>|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want_id}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want_id}");
            }
            let trimmed = buf.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(trimmed) else {
                continue;
            };
            match msg.get("method").and_then(|m| m.as_str()) {
                None => {
                    if msg.get("id") == Some(&serde_json::json!(want_id)) {
                        return msg;
                    }
                }
                Some("host/event") => {}
                Some(method) => {
                    if let Some(id) = msg.get("id").filter(|v| !v.is_null()) {
                        host_methods.push(method.to_string());
                        let resp = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": null });
                        writeln!(stdin, "{resp}").unwrap();
                        stdin.flush().unwrap();
                    }
                }
            }
        }
    };

    let mut host_methods: Vec<String> = Vec::new();

    // 1. Flip the process-wide gate to yolo at runtime over RPC.
    let set_mode = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "permission/set_mode",
        "params": {"mode": "yolo"}
    });
    writeln!(stdin, "{set_mode}").unwrap();
    stdin.flush().unwrap();
    let set_resp = read_response(&mut stdin, &mut stdout, 1, &mut host_methods);
    assert_eq!(set_resp["result"]["ok"], true, "set_mode failed: {set_resp}");

    // 2. Now run a write turn — the runtime-configured gate must approve it
    //    locally (no host/authorize), proving the RPC took effect.
    let run = serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "agent/run_turn",
        "params": {
            "turn_id": "it-perm-rpc",
            "system_prompt": "test",
            "model_name": "stub-model",
            "messages": [{"role": "user", "content": "write rpc.txt"}],
            "tools": [{"name": "Write", "description": "Write a file", "input_schema": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}}],
            "max_steps": 5,
            "native_llm": {
                "protocol": "openai",
                "base_url": format!("http://127.0.0.1:{}/v1", stub.port),
                "api_key": "stub",
                "model": "stub-model"
            },
            "workspace_root": ws.to_string_lossy(),
            "native_tools": true
        }
    });
    writeln!(stdin, "{run}").unwrap();
    stdin.flush().unwrap();
    let resp = read_response(&mut stdin, &mut stdout, 2, &mut host_methods);

    assert!(resp.get("error").is_none(), "unexpected error: {resp}");
    let written = std::fs::read_to_string(ws.join("rpc.txt")).unwrap_or_default();
    assert_eq!(written, "SET-VIA-RPC", "write must land after permission/set_mode yolo");
    assert!(
        !host_methods.iter().any(|m| m == "host/authorize_tool_execution"),
        "the RPC-configured yolo gate must approve locally, saw: {host_methods:?}"
    );

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&ws);
}

#[test]
fn native_task_spawns_a_subagent_and_feeds_its_answer_back() {
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    let ws = temp_workspace("placeholder.txt", "x");
    // Three provider calls in order:
    //   0 parent step 0 → issue a `Task` tool call
    //   1 child  step 0 → the subagent's final text
    //   2 parent step 1 → parent's final text (sees the tool result)
    let stub = spawn_sse_stub(|i| match i {
        0 => sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "call_t", "type": "function", "function": { "name": "Task", "arguments": "" } }] } }] }),
            serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": "{\"subagent_type\":\"research\",\"prompt\":\"DELEGATED-PROMPT-XYZ\"}" } }] } }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }], "usage": { "prompt_tokens": 9, "completion_tokens": 4 } }),
        ]),
        1 => sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "content": "SUBAGENT-ANSWER-42" }, "finish_reason": null }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 5, "completion_tokens": 2 } }),
        ]),
        _ => sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "content": "parent done" }, "finish_reason": null }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 30, "completion_tokens": 2 } }),
        ]),
    });

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let native_llm = serde_json::json!({
        "protocol": "openai",
        "base_url": format!("http://127.0.0.1:{}/v1", stub.port),
        "api_key": "stub",
        "model": "stub-model"
    });
    let create = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {
            "session_id": "it-task", "system_prompt": "test", "model": "stub-model",
            "goal_enabled": false, "native_llm": native_llm
        }
    });
    writeln!(stdin, "{create}").unwrap();
    stdin.flush().unwrap();

    // Wait for the create response (id 1), answering any host/* meanwhile.
    let mut host_methods: Vec<String> = Vec::new();
    let await_id = |stdin: &mut std::process::ChildStdin,
                        stdout: &mut BufReader<std::process::ChildStdout>,
                        want: u32,
                        hm: &mut Vec<String>|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
            match msg.get("method").and_then(|m| m.as_str()) {
                None => {
                    if msg.get("id") == Some(&serde_json::json!(want)) {
                        return msg;
                    }
                }
                Some("host/event") => {}
                Some(method) => {
                    if let Some(id) = msg.get("id").filter(|v| !v.is_null()) {
                        hm.push(method.to_string());
                        let resp = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": null });
                        writeln!(stdin, "{resp}").unwrap();
                        stdin.flush().unwrap();
                    }
                }
            }
        }
    };
    let created = await_id(&mut stdin, &mut stdout, 1, &mut host_methods);
    assert!(created.get("error").is_none(), "session/create failed: {created}");

    let prompt = serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "session/prompt",
        "params": { "session_id": "it-task", "input": [{ "type": "text", "text": "delegate the work" }] }
    });
    writeln!(stdin, "{prompt}").unwrap();
    stdin.flush().unwrap();
    let resp = await_id(&mut stdin, &mut stdout, 2, &mut host_methods);
    assert!(resp.get("error").is_none(), "session/prompt failed: {resp}");

    let bodies = stub.bodies.lock().unwrap();
    assert_eq!(bodies.len(), 3, "parent(2) + child(1) provider calls expected, got {}", bodies.len());
    // The child (call 1) received the delegated prompt.
    assert!(
        bodies[1].contains("DELEGATED-PROMPT-XYZ"),
        "the subagent's LLM call must carry the delegated prompt; body: {}",
        bodies[1]
    );
    // The parent (call 2) saw the child's final answer as the Task result.
    assert!(
        bodies[2].contains("SUBAGENT-ANSWER-42"),
        "the subagent's answer must feed back into the parent; body: {}",
        bodies[2]
    );
    // The whole subagent ran natively — no host LLM or host tool execution.
    assert!(!host_methods.iter().any(|m| m == "host/llm_chat"), "saw: {host_methods:?}");
    assert!(!host_methods.iter().any(|m| m == "host/execute_tool"), "saw: {host_methods:?}");

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&ws);
}

#[test]
fn native_read_media_file_inlines_the_image_for_the_model() {
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    let ws = temp_workspace("placeholder.txt", "x");
    // A minimal 1x1 PNG written into the workspace.
    const PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0B, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0xF8,
        0xCF, 0xC0, 0xF0, 0x1F, 0x00, 0x03, 0x03, 0x02, 0x00, 0x5A, 0x3D, 0x6B, 0x6B, 0x00, 0x00,
        0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    std::fs::write(ws.join("pixel.png"), PNG).unwrap();

    // Two provider calls: 0 → ReadMediaFile tool call; 1 → final text (this
    // request must carry the inlined image as a follow-up user message).
    let stub = spawn_sse_stub(|i| match i {
        0 => sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "call_img", "type": "function", "function": { "name": "ReadMediaFile", "arguments": "" } }] } }] }),
            serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": "{\"path\":\"pixel.png\"}" } }] } }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }], "usage": { "prompt_tokens": 9, "completion_tokens": 4 } }),
        ]),
        _ => sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "content": "I can see the image." }, "finish_reason": null }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 20, "completion_tokens": 4 } }),
        ]),
    });

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let native_llm = serde_json::json!({
        "protocol": "openai",
        "base_url": format!("http://127.0.0.1:{}/v1", stub.port),
        "api_key": "stub",
        "model": "stub-model"
    });
    let create = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {
            "session_id": "it-img", "system_prompt": "test", "model": "stub-model",
            "homedir": ws.to_str().unwrap(), "goal_enabled": false, "native_llm": native_llm
        }
    });
    writeln!(stdin, "{create}").unwrap();
    stdin.flush().unwrap();

    let mut host_methods: Vec<String> = Vec::new();
    let await_id = |stdin: &mut std::process::ChildStdin,
                        stdout: &mut BufReader<std::process::ChildStdout>,
                        want: u32,
                        hm: &mut Vec<String>|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
            match msg.get("method").and_then(|m| m.as_str()) {
                None => {
                    if msg.get("id") == Some(&serde_json::json!(want)) {
                        return msg;
                    }
                }
                Some("host/event") => {}
                Some(method) => {
                    if let Some(id) = msg.get("id").filter(|v| !v.is_null()) {
                        hm.push(method.to_string());
                        let resp = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": null });
                        writeln!(stdin, "{resp}").unwrap();
                        stdin.flush().unwrap();
                    }
                }
            }
        }
    };
    let created = await_id(&mut stdin, &mut stdout, 1, &mut host_methods);
    assert!(created.get("error").is_none(), "session/create failed: {created}");

    let prompt = serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "session/prompt",
        "params": { "session_id": "it-img", "input": [{ "type": "text", "text": "look at pixel.png" }] }
    });
    writeln!(stdin, "{prompt}").unwrap();
    stdin.flush().unwrap();
    let resp = await_id(&mut stdin, &mut stdout, 2, &mut host_methods);
    assert!(resp.get("error").is_none(), "session/prompt failed: {resp}");

    let bodies = stub.bodies.lock().unwrap();
    assert_eq!(bodies.len(), 2, "initial + post-tool provider calls expected, got {}", bodies.len());
    // The post-tool request carries the image inline (PNG base64 always starts
    // `iVBORw0KGgo`), proving native ReadMediaFile delivered pixels to the model.
    assert!(
        bodies[1].contains("data:image/png;base64,iVBORw0KGgo"),
        "the image must be inlined in the follow-up request; body: {}",
        bodies[1]
    );
    // Ran natively — the host never executed the tool or the LLM.
    assert!(!host_methods.iter().any(|m| m == "host/execute_tool"), "saw: {host_methods:?}");
    assert!(!host_methods.iter().any(|m| m == "host/llm_chat"), "saw: {host_methods:?}");

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&ws);
}

/// A minimal stdio MCP server (node): one `echo` tool returning `echo:<value>`.
/// Legacy-era: rejects `server/discover` so the client falls back to the
/// initialize handshake.
const MCP_ECHO_SERVER: &str = r#"
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'server/discover') {
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:m.id, error:{ code:-32601, message:'Method not found' } })+'\n');
  } else if (m.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:m.id, result:{ protocolVersion:m.params.protocolVersion, capabilities:{}, serverInfo:{name:'scripted',version:'1.0.0'} } })+'\n');
  } else if (m.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:m.id, result:{ tools:[{name:'echo',description:'Echo',inputSchema:{type:'object'}}] } })+'\n');
  } else if (m.method === 'tools/call') {
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:m.id, result:{ content:[{type:'text', text:'echo:'+m.params.arguments.value}] } })+'\n');
  }
});
"#;

fn node_on_path() -> bool {
    Command::new("node")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[test]
fn session_create_registers_mcp_servers_and_dispatches_them_natively() {
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    if !node_on_path() {
        eprintln!("Skipping: node not on PATH (needed to spawn the stdio MCP server).");
        return;
    }
    let ws = temp_workspace("placeholder.txt", "x");

    // Two provider calls: 0 → call the MCP tool `mcp__scripted__echo`; 1 →
    // final text (this request must carry the MCP tool's `echo:hi` result).
    let stub = spawn_sse_stub(|i| match i {
        0 => sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "call_m", "type": "function", "function": { "name": "mcp__scripted__echo", "arguments": "" } }] } }] }),
            serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": "{\"value\":\"hi\"}" } }] } }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }], "usage": { "prompt_tokens": 9, "completion_tokens": 4 } }),
        ]),
        _ => sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "content": "done" }, "finish_reason": null }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 20, "completion_tokens": 2 } }),
        ]),
    });

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let native_llm = serde_json::json!({
        "protocol": "openai",
        "base_url": format!("http://127.0.0.1:{}/v1", stub.port),
        "api_key": "stub",
        "model": "stub-model"
    });
    let create = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {
            "session_id": "it-mcp", "system_prompt": "test", "model": "stub-model",
            "homedir": ws.to_str().unwrap(), "goal_enabled": false, "native_llm": native_llm,
            "mcp_servers": [{
                "name": "scripted",
                "command": "node",
                "args": ["-e", MCP_ECHO_SERVER],
                "startup_timeout_ms": 15000,
                "tool_timeout_ms": 15000
            }]
        }
    });
    writeln!(stdin, "{create}").unwrap();
    stdin.flush().unwrap();

    let mut host_methods: Vec<String> = Vec::new();
    let await_id = |stdin: &mut std::process::ChildStdin,
                        stdout: &mut BufReader<std::process::ChildStdout>,
                        want: u32,
                        hm: &mut Vec<String>|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(40);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
            match msg.get("method").and_then(|m| m.as_str()) {
                None => {
                    if msg.get("id") == Some(&serde_json::json!(want)) {
                        return msg;
                    }
                }
                Some("host/event") => {}
                Some(method) => {
                    if let Some(id) = msg.get("id").filter(|v| !v.is_null()) {
                        hm.push(method.to_string());
                        let resp = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": null });
                        writeln!(stdin, "{resp}").unwrap();
                        stdin.flush().unwrap();
                    }
                }
            }
        }
    };
    let created = await_id(&mut stdin, &mut stdout, 1, &mut host_methods);
    assert!(created.get("error").is_none(), "session/create failed: {created}");

    let prompt = serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "session/prompt",
        "params": { "session_id": "it-mcp", "input": [{ "type": "text", "text": "use the tool" }] }
    });
    writeln!(stdin, "{prompt}").unwrap();
    stdin.flush().unwrap();
    let resp = await_id(&mut stdin, &mut stdout, 2, &mut host_methods);
    assert!(resp.get("error").is_none(), "session/prompt failed: {resp}");

    let bodies = stub.bodies.lock().unwrap();
    assert_eq!(bodies.len(), 2, "initial + post-tool provider calls expected, got {}", bodies.len());
    // The MCP tool ran natively (via McpToolInterceptor → the stdio server) and
    // its `echo:hi` result was fed back to the model on the second call.
    assert!(
        bodies[1].contains("echo:hi"),
        "the MCP tool result must feed back into the parent; body: {}",
        bodies[1]
    );
    // Dispatched natively — the host never executed the tool.
    assert!(!host_methods.iter().any(|m| m == "host/execute_tool"), "saw: {host_methods:?}");
    assert!(!host_methods.iter().any(|m| m == "host/llm_chat"), "saw: {host_methods:?}");

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&ws);
}

#[test]
fn session_create_registers_skills_and_activates_them_natively() {
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    let ws = temp_workspace("placeholder.txt", "x");

    // Two provider calls: 0 → call the `Skill` tool; 1 → final text (must carry
    // the rendered skill body `SKILL_BODY_HELLO`).
    let stub = spawn_sse_stub(|i| match i {
        0 => sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "call_s", "type": "function", "function": { "name": "Skill", "arguments": "" } }] } }] }),
            serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": "{\"skill\":\"greet\"}" } }] } }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }], "usage": { "prompt_tokens": 9, "completion_tokens": 4 } }),
        ]),
        _ => sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "content": "done" }, "finish_reason": null }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 20, "completion_tokens": 2 } }),
        ]),
    });

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let native_llm = serde_json::json!({
        "protocol": "openai",
        "base_url": format!("http://127.0.0.1:{}/v1", stub.port),
        "api_key": "stub",
        "model": "stub-model"
    });
    let create = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {
            "session_id": "it-skill", "system_prompt": "test", "model": "stub-model",
            "homedir": ws.to_str().unwrap(), "goal_enabled": false, "native_llm": native_llm,
            "skills": [{
                "name": "greet",
                "description": "Greet the user",
                "skill_type": "prompt",
                "content": "SKILL_BODY_HELLO"
            }]
        }
    });
    writeln!(stdin, "{create}").unwrap();
    stdin.flush().unwrap();

    let mut host_methods: Vec<String> = Vec::new();
    let await_id = |stdin: &mut std::process::ChildStdin,
                        stdout: &mut BufReader<std::process::ChildStdout>,
                        want: u32,
                        hm: &mut Vec<String>|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
            match msg.get("method").and_then(|m| m.as_str()) {
                None => {
                    if msg.get("id") == Some(&serde_json::json!(want)) {
                        return msg;
                    }
                }
                Some("host/event") => {}
                Some(method) => {
                    if let Some(id) = msg.get("id").filter(|v| !v.is_null()) {
                        hm.push(method.to_string());
                        let resp = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": null });
                        writeln!(stdin, "{resp}").unwrap();
                        stdin.flush().unwrap();
                    }
                }
            }
        }
    };
    let created = await_id(&mut stdin, &mut stdout, 1, &mut host_methods);
    assert!(created.get("error").is_none(), "session/create failed: {created}");

    let prompt = serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "session/prompt",
        "params": { "session_id": "it-skill", "input": [{ "type": "text", "text": "use the skill" }] }
    });
    writeln!(stdin, "{prompt}").unwrap();
    stdin.flush().unwrap();
    let resp = await_id(&mut stdin, &mut stdout, 2, &mut host_methods);
    assert!(resp.get("error").is_none(), "session/prompt failed: {resp}");

    let bodies = stub.bodies.lock().unwrap();
    assert_eq!(bodies.len(), 2, "initial + post-skill provider calls expected, got {}", bodies.len());
    // The skill activated natively and its rendered body fed back to the model.
    assert!(
        bodies[1].contains("SKILL_BODY_HELLO"),
        "the rendered skill prompt must feed back into the parent; body: {}",
        bodies[1]
    );
    assert!(!host_methods.iter().any(|m| m == "host/execute_tool"), "saw: {host_methods:?}");
    assert!(!host_methods.iter().any(|m| m == "host/llm_chat"), "saw: {host_methods:?}");

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&ws);
}

#[test]
fn session_create_registers_hooks_and_pretooluse_vetoes_natively() {
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    let ws = temp_workspace("secret.txt", "top secret");

    // Two provider calls: 0 → the model calls Read on the workspace file;
    // 1 → final text. The PreToolUse hook must veto the Read natively, so the
    // second request body carries the hook's stderr reason instead of the
    // file's content — and the host never sees an execute_tool.
    let stub = spawn_sse_stub(|i| match i {
        0 => sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "call_r", "type": "function", "function": { "name": "Read", "arguments": "" } }] } }] }),
            serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": "{\"file_path\":\"secret.txt\"}" } }] } }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }], "usage": { "prompt_tokens": 9, "completion_tokens": 4 } }),
        ]),
        _ => sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "content": "done" }, "finish_reason": null }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 20, "completion_tokens": 2 } }),
        ]),
    });

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let native_llm = serde_json::json!({
        "protocol": "openai",
        "base_url": format!("http://127.0.0.1:{}/v1", stub.port),
        "api_key": "stub",
        "model": "stub-model"
    });
    // Exit code 2 = block, stderr carries the reason (TS hook protocol).
    let hook_command = if cfg!(windows) {
        "echo HOOK_DENY_MARKER 1>&2 & exit /b 2"
    } else {
        "echo HOOK_DENY_MARKER 1>&2; exit 2"
    };
    let create = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {
            "session_id": "it-hook", "system_prompt": "test", "model": "stub-model",
            "homedir": ws.to_str().unwrap(), "goal_enabled": false, "native_llm": native_llm,
            "hooks": [{
                "event": "PreToolUse",
                "matcher": "^Read$",
                "command": hook_command,
                "timeout": 10
            }]
        }
    });
    writeln!(stdin, "{create}").unwrap();
    stdin.flush().unwrap();

    let mut host_methods: Vec<String> = Vec::new();
    let await_id = |stdin: &mut std::process::ChildStdin,
                        stdout: &mut BufReader<std::process::ChildStdout>,
                        want: u32,
                        hm: &mut Vec<String>|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
            match msg.get("method").and_then(|m| m.as_str()) {
                None => {
                    if msg.get("id") == Some(&serde_json::json!(want)) {
                        return msg;
                    }
                }
                Some("host/event") => {}
                Some(method) => {
                    if let Some(id) = msg.get("id").filter(|v| !v.is_null()) {
                        hm.push(method.to_string());
                        let resp = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": null });
                        writeln!(stdin, "{resp}").unwrap();
                        stdin.flush().unwrap();
                    }
                }
            }
        }
    };
    let created = await_id(&mut stdin, &mut stdout, 1, &mut host_methods);
    assert!(created.get("error").is_none(), "session/create failed: {created}");

    let prompt = serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "session/prompt",
        "params": { "session_id": "it-hook", "input": [{ "type": "text", "text": "read secret.txt" }] }
    });
    writeln!(stdin, "{prompt}").unwrap();
    stdin.flush().unwrap();
    let resp = await_id(&mut stdin, &mut stdout, 2, &mut host_methods);
    assert!(resp.get("error").is_none(), "session/prompt failed: {resp}");

    let bodies = stub.bodies.lock().unwrap();
    assert_eq!(bodies.len(), 2, "initial + post-veto provider calls expected, got {}", bodies.len());
    // The hook vetoed the Read: its reason fed back to the model instead of
    // the file's content.
    assert!(
        bodies[1].contains("HOOK_DENY_MARKER"),
        "the hook's block reason must feed back to the model; body: {}",
        bodies[1]
    );
    assert!(
        !bodies[1].contains("top secret"),
        "the vetoed Read must not leak the file content; body: {}",
        bodies[1]
    );
    assert!(!host_methods.iter().any(|m| m == "host/execute_tool"), "saw: {host_methods:?}");
    assert!(!host_methods.iter().any(|m| m == "host/llm_chat"), "saw: {host_methods:?}");

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&ws);
}

#[test]
fn session_goal_lifecycle_rpcs_drive_the_native_goal_mode() {
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    let ws = temp_workspace("placeholder.txt", "x");

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    // No prompt runs in this test, so no provider stub is needed.
    let create = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {
            "session_id": "it-goal", "system_prompt": "test", "model": "m",
            "homedir": ws.to_str().unwrap(), "goal_enabled": true
        }
    });
    writeln!(stdin, "{create}").unwrap();
    stdin.flush().unwrap();

    let await_id = |stdout: &mut BufReader<std::process::ChildStdout>,
                        want: u32|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
            if msg.get("method").is_none() && msg.get("id") == Some(&serde_json::json!(want)) {
                return msg;
            }
        }
    };
    let created = await_id(&mut stdout, 1);
    assert!(created.get("error").is_none(), "session/create failed: {created}");

    let mut call = |id: u32, method: &str, params: serde_json::Value| -> serde_json::Value {
        let req = serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        writeln!(stdin, "{req}").unwrap();
        stdin.flush().unwrap();
        await_id(&mut stdout, id)
    };

    // Create → active.
    let created_goal = call(
        2,
        "session/goal_create",
        serde_json::json!({ "session_id": "it-goal", "objective": "ship the feature" }),
    );
    let snapshot = created_goal.get("result").expect("goal_create result");
    assert_eq!(snapshot.get("objective").and_then(|v| v.as_str()), Some("ship the feature"));

    // Get → the active record round-trips.
    let got = call(3, "session/goal_get", serde_json::json!({ "session_id": "it-goal" }));
    let goal = got.get("result").and_then(|r| r.get("goal")).expect("goal_get goal");
    assert_eq!(goal.get("objective").and_then(|v| v.as_str()), Some("ship the feature"));

    // Pause → resume → cancel; each returns the updated snapshot.
    let paused = call(
        4,
        "session/goal_pause",
        serde_json::json!({ "session_id": "it-goal", "reason": "user pause" }),
    );
    assert!(paused.get("error").is_none(), "goal_pause failed: {paused}");
    let resumed = call(5, "session/goal_resume", serde_json::json!({ "session_id": "it-goal" }));
    assert!(resumed.get("error").is_none(), "goal_resume failed: {resumed}");
    let cancelled = call(6, "session/goal_cancel", serde_json::json!({ "session_id": "it-goal" }));
    assert!(cancelled.get("error").is_none(), "goal_cancel failed: {cancelled}");

    // Cancelling again errors (no active goal) rather than silently succeeding.
    let again = call(7, "session/goal_cancel", serde_json::json!({ "session_id": "it-goal" }));
    assert!(again.get("error").is_some(), "double cancel must error: {again}");

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&ws);
}

#[test]
fn session_set_swarm_mode_injects_the_enter_reminder_into_the_context() {
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    let ws = temp_workspace("placeholder.txt", "x");

    // A single text-only provider reply; the assertion is on the request body.
    let stub = spawn_sse_stub(|_i| {
        sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "content": "ok" }, "finish_reason": null }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 5, "completion_tokens": 1 } }),
        ])
    });

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let native_llm = serde_json::json!({
        "protocol": "openai",
        "base_url": format!("http://127.0.0.1:{}/v1", stub.port),
        "api_key": "stub",
        "model": "stub-model"
    });
    let create = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {
            "session_id": "it-swarm", "system_prompt": "test", "model": "stub-model",
            "homedir": ws.to_str().unwrap(), "goal_enabled": false, "native_llm": native_llm
        }
    });
    writeln!(stdin, "{create}").unwrap();
    stdin.flush().unwrap();

    let await_id = |stdout: &mut BufReader<std::process::ChildStdout>,
                        want: u32|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
            if msg.get("method").is_none() && msg.get("id") == Some(&serde_json::json!(want)) {
                return msg;
            }
        }
    };
    let created = await_id(&mut stdout, 1);
    assert!(created.get("error").is_none(), "session/create failed: {created}");

    // Enter swarm mode (manual): the enter reminder lands in the context.
    let swarm_on = serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "session/set_swarm_mode",
        "params": { "session_id": "it-swarm", "enabled": true, "trigger": "manual" }
    });
    writeln!(stdin, "{swarm_on}").unwrap();
    stdin.flush().unwrap();
    let on = await_id(&mut stdout, 2);
    assert_eq!(
        on.get("result").and_then(|r| r.get("active")).and_then(|v| v.as_bool()),
        Some(true),
        "set_swarm_mode(enabled) must report active: {on}"
    );

    // A prompt now carries the swarm enter reminder to the provider.
    let prompt = serde_json::json!({
        "jsonrpc": "2.0", "id": 3, "method": "session/prompt",
        "params": { "session_id": "it-swarm", "input": [{ "type": "text", "text": "hi" }] }
    });
    writeln!(stdin, "{prompt}").unwrap();
    stdin.flush().unwrap();
    let resp = await_id(&mut stdout, 3);
    assert!(resp.get("error").is_none(), "session/prompt failed: {resp}");

    {
        let bodies = stub.bodies.lock().unwrap();
        assert!(!bodies.is_empty(), "provider must have been called");
        assert!(
            bodies[0].contains("Parallel Execution Required"),
            "the swarm enter reminder must ride the request; body: {}",
            bodies[0]
        );
    }

    // Manual trigger persists across the turn; disabling reports inactive.
    let swarm_off = serde_json::json!({
        "jsonrpc": "2.0", "id": 4, "method": "session/set_swarm_mode",
        "params": { "session_id": "it-swarm", "enabled": false }
    });
    writeln!(stdin, "{swarm_off}").unwrap();
    stdin.flush().unwrap();
    let off = await_id(&mut stdout, 4);
    assert_eq!(
        off.get("result").and_then(|r| r.get("active")).and_then(|v| v.as_bool()),
        Some(false),
        "set_swarm_mode(disabled) must report inactive: {off}"
    );

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&ws);
}

#[test]
fn session_get_status_reports_live_state_and_cumulative_usage() {
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    let ws = temp_workspace("placeholder.txt", "x");

    // One text-only reply per prompt, with usage the status must accumulate.
    let stub = spawn_sse_stub(|_i| {
        sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "content": "ok" }, "finish_reason": null }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 7, "completion_tokens": 3 } }),
        ])
    });

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let native_llm = serde_json::json!({
        "protocol": "openai",
        "base_url": format!("http://127.0.0.1:{}/v1", stub.port),
        "api_key": "stub",
        "model": "status-model"
    });
    let create = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {
            "session_id": "it-status", "system_prompt": "test", "model": "status-model",
            "homedir": ws.to_str().unwrap(), "goal_enabled": false, "native_llm": native_llm
        }
    });
    writeln!(stdin, "{create}").unwrap();
    stdin.flush().unwrap();

    let await_id = |stdout: &mut BufReader<std::process::ChildStdout>,
                        want: u32|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
            if msg.get("method").is_none() && msg.get("id") == Some(&serde_json::json!(want)) {
                return msg;
            }
        }
    };
    let created = await_id(&mut stdout, 1);
    assert!(created.get("error").is_none(), "session/create failed: {created}");

    let mut call = |id: u32, method: &str, params: serde_json::Value| -> serde_json::Value {
        let req = serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        writeln!(stdin, "{req}").unwrap();
        stdin.flush().unwrap();
        await_id(&mut stdout, id)
    };

    // Fresh session: model + defaults, no usage yet, no MCP servers.
    let s0 = call(2, "session/get_status", serde_json::json!({ "session_id": "it-status" }));
    let r0 = s0.get("result").expect("status result");
    assert_eq!(r0.get("model").and_then(|v| v.as_str()), Some("status-model"));
    assert_eq!(r0.get("permission").and_then(|v| v.as_str()), Some("manual"));
    assert_eq!(r0.get("swarm_mode").and_then(|v| v.as_bool()), Some(false));
    assert!(r0.get("usage").map(|u| u.is_null()).unwrap_or(true), "no usage before a turn: {r0}");
    let mcp = call(3, "session/list_mcp_servers", serde_json::json!({ "session_id": "it-status" }));
    assert_eq!(
        mcp.get("result").and_then(|r| r.get("servers")).and_then(|s| s.as_array()).map(|a| a.len()),
        Some(0),
        "no MCP servers registered: {mcp}"
    );

    // A turn accumulates usage; set_thinking + swarm change the snapshot.
    let prompt = call(
        4,
        "session/prompt",
        serde_json::json!({ "session_id": "it-status", "input": [{ "type": "text", "text": "hi" }] }),
    );
    assert!(prompt.get("error").is_none(), "session/prompt failed: {prompt}");
    let _ = call(5, "session/set_thinking", serde_json::json!({ "session_id": "it-status", "effort": "high" }));
    let _ = call(6, "session/set_swarm_mode", serde_json::json!({ "session_id": "it-status", "enabled": true }));

    let s1 = call(7, "session/get_status", serde_json::json!({ "session_id": "it-status" }));
    let r1 = s1.get("result").expect("status result");
    assert_eq!(r1.get("thinking_effort").and_then(|v| v.as_str()), Some("high"));
    assert_eq!(r1.get("swarm_mode").and_then(|v| v.as_bool()), Some(true));
    let total = r1
        .get("usage")
        .and_then(|u| u.get("total"))
        .and_then(|t| t.get("total_tokens"))
        .and_then(|v| v.as_u64());
    assert_eq!(total, Some(10), "the turn's 7+3 tokens must accumulate: {r1}");
    assert!(
        r1.get("context_tokens").and_then(|v| v.as_u64()).unwrap_or(0) > 0,
        "context tokens must reflect the recorded turn: {r1}"
    );

    // getUsage returns the same cumulative tally as get_status.usage.
    let usage = call(8, "session/get_usage", serde_json::json!({ "session_id": "it-status" }));
    let ut = usage
        .get("result")
        .and_then(|u| u.get("total"))
        .and_then(|t| t.get("total_tokens"))
        .and_then(|v| v.as_u64());
    assert_eq!(ut, Some(10), "get_usage total must match: {usage}");

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&ws);
}

#[test]
fn session_set_plan_mode_toggles_and_reflects_in_status() {
    // set_plan_mode flips the permission plan context, which get_status
    // reports as plan_mode; re-entering an active plan mode errors (TS parity).
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    let ws = temp_workspace("placeholder.txt", "x");

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let create = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {
            "session_id": "it-plan", "system_prompt": "test", "model": "m",
            "homedir": ws.to_str().unwrap(), "goal_enabled": false
        }
    });
    writeln!(stdin, "{create}").unwrap();
    stdin.flush().unwrap();

    let await_id = |stdout: &mut BufReader<std::process::ChildStdout>,
                        want: u32|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
            if msg.get("method").is_none() && msg.get("id") == Some(&serde_json::json!(want)) {
                return msg;
            }
        }
    };
    let created = await_id(&mut stdout, 1);
    assert!(created.get("error").is_none(), "session/create failed: {created}");

    let mut call = |id: u32, method: &str, params: serde_json::Value| -> serde_json::Value {
        let req = serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        writeln!(stdin, "{req}").unwrap();
        stdin.flush().unwrap();
        await_id(&mut stdout, id)
    };

    // Fresh session: not in plan mode.
    let s0 = call(2, "session/get_status", serde_json::json!({ "session_id": "it-plan" }));
    assert_eq!(
        s0.get("result").and_then(|r| r.get("plan_mode")).and_then(|v| v.as_bool()),
        Some(false),
        "fresh session must not be in plan mode: {s0}"
    );

    // Enter plan mode → status reflects it.
    let on = call(3, "session/set_plan_mode", serde_json::json!({ "session_id": "it-plan", "enabled": true }));
    assert_eq!(
        on.get("result").and_then(|r| r.get("plan_mode")).and_then(|v| v.as_bool()),
        Some(true),
        "set_plan_mode(true) must report plan_mode: {on}"
    );
    let s1 = call(4, "session/get_status", serde_json::json!({ "session_id": "it-plan" }));
    assert_eq!(
        s1.get("result").and_then(|r| r.get("plan_mode")).and_then(|v| v.as_bool()),
        Some(true),
        "status must reflect plan mode: {s1}"
    );

    // Re-entering an active plan mode is idempotent (the permission gate is
    // process-wide, so a re-entry from another session must not error; the
    // agent's own plan state is what governs).
    let again = call(5, "session/set_plan_mode", serde_json::json!({ "session_id": "it-plan", "enabled": true }));
    assert_eq!(
        again.get("result").and_then(|r| r.get("plan_mode")).and_then(|v| v.as_bool()),
        Some(true),
        "re-entering plan mode is a no-op reporting plan_mode: {again}"
    );

    // Exit → status back to false.
    let off = call(6, "session/set_plan_mode", serde_json::json!({ "session_id": "it-plan", "enabled": false }));
    assert_eq!(
        off.get("result").and_then(|r| r.get("plan_mode")).and_then(|v| v.as_bool()),
        Some(false),
        "set_plan_mode(false) must clear plan mode: {off}"
    );
    let s2 = call(7, "session/get_status", serde_json::json!({ "session_id": "it-plan" }));
    assert_eq!(
        s2.get("result").and_then(|r| r.get("plan_mode")).and_then(|v| v.as_bool()),
        Some(false),
        "status must reflect plan mode cleared: {s2}"
    );

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&ws);
}

#[test]
fn session_run_shell_streams_output_and_cancel_is_addressable() {
    // run_shell with a commandId streams `session.shell.output` chunks and
    // returns the final combined output; cancel_shell_command targets a
    // command by id (a no-op for an unknown/finished one).
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    let ws = temp_workspace("placeholder.txt", "x");

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let create = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {
            "session_id": "it-shell", "system_prompt": "test", "model": "m",
            "homedir": ws.to_str().unwrap(), "goal_enabled": false
        }
    });
    writeln!(stdin, "{create}").unwrap();
    stdin.flush().unwrap();

    // Collects `session.shell.output` chunks seen while awaiting a response.
    let mut shell_chunks: Vec<String> = Vec::new();
    let await_id = |stdin: &mut std::process::ChildStdin,
                    stdout: &mut BufReader<std::process::ChildStdout>,
                    want: u32,
                    chunks: &mut Vec<String>|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
            // Capture streamed shell chunks (delivered as host/event notifications).
            if msg.get("method").and_then(|m| m.as_str()) == Some("host/event") {
                let ev = msg.get("params").and_then(|p| p.get("event")).unwrap_or(&msg["params"]);
                if ev.get("type").and_then(|t| t.as_str()) == Some("session.shell.output") {
                    if let Some(c) = ev.get("chunk").and_then(|c| c.as_str()) {
                        chunks.push(c.to_string());
                    }
                }
                continue;
            }
            if msg.get("method").is_none() && msg.get("id") == Some(&serde_json::json!(want)) {
                return msg;
            }
            // Any other request notification with an id gets a null reply.
            if let (Some(_m), Some(id)) =
                (msg.get("method").and_then(|m| m.as_str()), msg.get("id").filter(|v| !v.is_null()))
            {
                let resp = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": null });
                writeln!(stdin, "{resp}").unwrap();
                stdin.flush().unwrap();
            }
        }
    };
    let created = await_id(&mut stdin, &mut stdout, 1, &mut shell_chunks);
    assert!(created.get("error").is_none(), "session/create failed: {created}");

    // Stream an echo with a commandId.
    let run = serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "session/run_shell",
        "params": { "session_id": "it-shell", "command": "echo shell-stream-marker", "command_id": "cmd-1" }
    });
    writeln!(stdin, "{run}").unwrap();
    stdin.flush().unwrap();
    let resp = await_id(&mut stdin, &mut stdout, 2, &mut shell_chunks);
    let result = resp.get("result").expect("run_shell result");
    // No native shell in this environment → skip the output assertions.
    if result.get("unavailable").and_then(|v| v.as_bool()) == Some(true) {
        eprintln!("Skipping shell assertions: no native shell available.");
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&ws);
        return;
    }
    assert_eq!(
        result.get("is_error").and_then(|v| v.as_bool()),
        Some(false),
        "echo must succeed: {resp}"
    );
    assert!(
        result.get("output").and_then(|v| v.as_str()).unwrap_or("").contains("shell-stream-marker"),
        "final output must contain the marker: {resp}"
    );
    assert!(
        shell_chunks.iter().any(|c| c.contains("shell-stream-marker")),
        "a session.shell.output chunk must carry the marker; chunks: {shell_chunks:?}"
    );

    // Cancel targets a command by id; an unknown/finished id reports false.
    let cancel = serde_json::json!({
        "jsonrpc": "2.0", "id": 3, "method": "session/cancel_shell_command",
        "params": { "session_id": "it-shell", "command_id": "cmd-1" }
    });
    writeln!(stdin, "{cancel}").unwrap();
    stdin.flush().unwrap();
    let cresp = await_id(&mut stdin, &mut stdout, 3, &mut shell_chunks);
    assert_eq!(
        cresp.get("result").and_then(|r| r.get("cancelled")).and_then(|v| v.as_bool()),
        Some(false),
        "cancelling an already-finished command reports false: {cresp}"
    );

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&ws);
}

#[test]
fn bg_detach_marks_task_detached_and_returns_info() {
    // bg/detach marks a registered task detached and returns its info with
    // detached=true; detaching an unknown id returns null.
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let await_id = |stdout: &mut BufReader<std::process::ChildStdout>,
                        want: u32|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
            if msg.get("method").is_none() && msg.get("id") == Some(&serde_json::json!(want)) {
                return msg;
            }
        }
    };
    let mut call = |id: u32, method: &str, params: serde_json::Value| -> serde_json::Value {
        let req = serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        writeln!(stdin, "{req}").unwrap();
        stdin.flush().unwrap();
        await_id(&mut stdout, id)
    };

    let reg = call(
        1,
        "bg/register",
        serde_json::json!({ "prefix": "it-detach", "kind": "process", "description": "detach-probe" }),
    );
    let task_id = reg["result"]["task_id"].as_str().expect("task_id").to_string();

    let det = call(2, "bg/detach", serde_json::json!({ "task_id": task_id }));
    let info = det.get("result").expect("detach result");
    assert!(!info.is_null(), "detach must return the task info: {det}");
    assert_eq!(
        info.get("base").and_then(|b| b.get("detached")).and_then(|v| v.as_bool()),
        Some(true),
        "detached flag must be set: {det}"
    );

    let unknown = call(3, "bg/detach", serde_json::json!({ "task_id": "no-such-task" }));
    assert!(
        unknown.get("result").map(|r| r.is_null()).unwrap_or(false),
        "detaching an unknown task must return null: {unknown}"
    );

    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn plugin_list_and_get_read_surface() {
    // plugin/list returns the (initially empty) installed set; plugin/get for
    // an unknown id returns null. Exercises the read RPCs end-to-end without a
    // populated store (install is not exposed yet).
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let await_id = |stdout: &mut BufReader<std::process::ChildStdout>,
                        want: u32|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
            if msg.get("method").is_none() && msg.get("id") == Some(&serde_json::json!(want)) {
                return msg;
            }
        }
    };

    let mut call = |id: u32, method: &str, params: serde_json::Value| -> serde_json::Value {
        let req = serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        writeln!(stdin, "{req}").unwrap();
        stdin.flush().unwrap();
        await_id(&mut stdout, id)
    };

    let list = call(1, "plugin/list", serde_json::json!({}));
    assert!(list.get("error").is_none(), "plugin/list failed: {list}");
    assert_eq!(
        list.get("result").and_then(|r| r.get("plugins")).and_then(|p| p.as_array()).map(|a| a.len()),
        Some(0),
        "fresh plugin list must be empty: {list}"
    );

    let get = call(2, "plugin/get", serde_json::json!({ "id": "no/such-plugin" }));
    assert!(get.get("error").is_none(), "plugin/get failed: {get}");
    assert!(
        get.get("result").map(|r| r.is_null()).unwrap_or(false),
        "plugin/get for an unknown id must be null: {get}"
    );

    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn session_reconnect_mcp_and_startup_metrics() {
    // reconnect_mcp_server re-attempts a known server (a bogus command stays
    // failed), rejects an unknown one, and get_mcp_startup_metrics reports the
    // connect duration recorded at session/create.
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    let ws = temp_workspace("placeholder.txt", "x");

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let create = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {
            "session_id": "it-mcp", "system_prompt": "test", "model": "m",
            "homedir": ws.to_str().unwrap(), "goal_enabled": false,
            "mcp_servers": [{
                "name": "brokenmcp",
                "command": "this-command-does-not-exist-kimi-xyz",
                "args": [],
                "startup_timeout_ms": 5000
            }]
        }
    });
    writeln!(stdin, "{create}").unwrap();
    stdin.flush().unwrap();

    let await_id = |stdout: &mut BufReader<std::process::ChildStdout>,
                        want: u32|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
            if msg.get("method").is_none() && msg.get("id") == Some(&serde_json::json!(want)) {
                return msg;
            }
        }
    };
    let created = await_id(&mut stdout, 1);
    assert!(created.get("error").is_none(), "session/create failed: {created}");

    let mut call = |id: u32, method: &str, params: serde_json::Value| -> serde_json::Value {
        let req = serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        writeln!(stdin, "{req}").unwrap();
        stdin.flush().unwrap();
        await_id(&mut stdout, id)
    };

    // Startup metrics: a duration_ms field is reported (>= 0) after connecting.
    let m = call(2, "session/get_mcp_startup_metrics", serde_json::json!({ "session_id": "it-mcp" }));
    assert!(
        m.get("result").and_then(|r| r.get("duration_ms")).and_then(|v| v.as_u64()).is_some(),
        "get_mcp_startup_metrics must report a duration_ms: {m}"
    );

    // Reconnect the known (bogus) server: re-attempts, stays failed.
    let rc = call(3, "session/reconnect_mcp_server", serde_json::json!({ "session_id": "it-mcp", "name": "brokenmcp" }));
    let rr = rc.get("result").expect("reconnect result");
    assert_eq!(rr.get("name").and_then(|v| v.as_str()), Some("brokenmcp"), "reconnect echoes the server: {rc}");
    assert_eq!(
        rr.get("status").and_then(|v| v.as_str()),
        Some("failed"),
        "a bogus command must stay failed after reconnect: {rc}"
    );

    // Reconnecting an unknown server errors.
    let rc2 = call(4, "session/reconnect_mcp_server", serde_json::json!({ "session_id": "it-mcp", "name": "no-such-server" }));
    assert!(rc2.get("error").is_some(), "reconnecting an unknown server must error: {rc2}");

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&ws);
}

#[test]
fn session_activate_skill_runs_a_turn_with_skill_origin() {
    // activate_skill renders the registered skill's prompt, seeds it into the
    // context tagged as a skill_activation, and runs a real turn against the
    // native-LLM stub. get_context then shows the skill_activation message.
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    let ws = temp_workspace("placeholder.txt", "x");

    let stub = spawn_sse_stub(|_i| {
        sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "content": "skill-ran" }, "finish_reason": null }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 6, "completion_tokens": 2 } }),
        ])
    });

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let native_llm = serde_json::json!({
        "protocol": "openai",
        "base_url": format!("http://127.0.0.1:{}/v1", stub.port),
        "api_key": "stub",
        "model": "skill-model"
    });
    let create = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {
            "session_id": "it-skill", "system_prompt": "test", "model": "skill-model",
            "homedir": ws.to_str().unwrap(), "goal_enabled": false, "native_llm": native_llm,
            "skills": [{
                "name": "brainstorm",
                "description": "Brainstorm ideas thoroughly before acting.",
                "skill_type": "prompt"
            }]
        }
    });
    writeln!(stdin, "{create}").unwrap();
    stdin.flush().unwrap();

    let await_id = |stdout: &mut BufReader<std::process::ChildStdout>,
                        want: u32|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
            if msg.get("method").is_none() && msg.get("id") == Some(&serde_json::json!(want)) {
                return msg;
            }
        }
    };
    let created = await_id(&mut stdout, 1);
    assert!(created.get("error").is_none(), "session/create failed: {created}");

    let mut call = |id: u32, method: &str, params: serde_json::Value| -> serde_json::Value {
        let req = serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        writeln!(stdin, "{req}").unwrap();
        stdin.flush().unwrap();
        await_id(&mut stdout, id)
    };

    // Activate the skill: a turn runs against the stub.
    let act = call(
        2,
        "session/activate_skill",
        serde_json::json!({ "session_id": "it-skill", "name": "brainstorm", "args": "auth flow" }),
    );
    assert!(act.get("error").is_none(), "activate_skill failed: {act}");
    assert!(
        act.get("result").and_then(|r| r.get("steps")).and_then(|v| v.as_u64()).unwrap_or(0) >= 1,
        "activation must run at least one step: {act}"
    );

    // The context carries a skill_activation-origin message rendered from the
    // skill (its description body + the passed args).
    let ctx = call(3, "session/get_context", serde_json::json!({ "session_id": "it-skill" }));
    let ctx_str = serde_json::to_string(&ctx).unwrap();
    assert!(ctx_str.contains("skill_activation"), "context must record a skill_activation origin: {ctx}");
    assert!(ctx_str.contains("brainstorm"), "context must reference the activated skill: {ctx}");
    assert!(
        stub.bodies.lock().unwrap().len() >= 1,
        "the native provider must have been called for the skill turn"
    );

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&ws);
}

#[test]
fn session_get_plan_tracks_the_plan_file_across_enter_and_exit() {
    // set_plan_mode drives the engine plan-file state machine: entering yields
    // a real plan file get_plan reports (id + .md path), clear_plan keeps the
    // plan active with empty content, and exiting clears the plan entirely.
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    let ws = temp_workspace("placeholder.txt", "x");

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let create = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {
            "session_id": "it-plan-file", "system_prompt": "test", "model": "m",
            "homedir": ws.to_str().unwrap(), "goal_enabled": false
        }
    });
    writeln!(stdin, "{create}").unwrap();
    stdin.flush().unwrap();

    let await_id = |stdout: &mut BufReader<std::process::ChildStdout>,
                        want: u32|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
            if msg.get("method").is_none() && msg.get("id") == Some(&serde_json::json!(want)) {
                return msg;
            }
        }
    };
    let created = await_id(&mut stdout, 1);
    assert!(created.get("error").is_none(), "session/create failed: {created}");

    let mut call = |id: u32, method: &str, params: serde_json::Value| -> serde_json::Value {
        let req = serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        writeln!(stdin, "{req}").unwrap();
        stdin.flush().unwrap();
        await_id(&mut stdout, id)
    };

    // Fresh: no plan.
    let p0 = call(2, "session/get_plan", serde_json::json!({ "session_id": "it-plan-file" }));
    assert!(
        p0.get("result").map(|r| r.is_null()).unwrap_or(false),
        "fresh session must have no plan: {p0}"
    );

    // Enter plan mode → get_plan returns a real plan file (id + .md path).
    let on = call(3, "session/set_plan_mode", serde_json::json!({ "session_id": "it-plan-file", "enabled": true }));
    assert_eq!(
        on.get("result").and_then(|r| r.get("plan_mode")).and_then(|v| v.as_bool()),
        Some(true),
        "set_plan_mode(true) failed: {on}"
    );
    let p1 = call(4, "session/get_plan", serde_json::json!({ "session_id": "it-plan-file" }));
    let r1 = p1.get("result").expect("plan result");
    assert!(!r1.is_null(), "plan must be active after enter: {p1}");
    let plan_path = r1.get("path").and_then(|v| v.as_str()).unwrap_or("");
    assert!(plan_path.ends_with(".md"), "plan path must be a .md file: {p1}");
    assert!(
        r1.get("id").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false),
        "plan must carry an id: {p1}"
    );

    // clear_plan keeps the plan active but empties the content.
    let cl = call(5, "session/clear_plan", serde_json::json!({ "session_id": "it-plan-file" }));
    assert!(cl.get("error").is_none(), "clear_plan failed: {cl}");
    let p2 = call(6, "session/get_plan", serde_json::json!({ "session_id": "it-plan-file" }));
    assert_eq!(
        p2.get("result").and_then(|r| r.get("content")).and_then(|v| v.as_str()),
        Some(""),
        "plan content must be empty after clear: {p2}"
    );

    // Exiting plan mode clears the plan entirely.
    let off = call(7, "session/set_plan_mode", serde_json::json!({ "session_id": "it-plan-file", "enabled": false }));
    assert!(off.get("error").is_none(), "set_plan_mode(false) failed: {off}");
    let p3 = call(8, "session/get_plan", serde_json::json!({ "session_id": "it-plan-file" }));
    assert!(
        p3.get("result").map(|r| r.is_null()).unwrap_or(false),
        "plan must be gone after exit: {p3}"
    );

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&ws);
}

#[test]
fn session_context_ops_import_get_clear_and_undo_guard() {
    // Exercises the context-ops RPCs against the real engine: import appends a
    // user message that get_context reports (with a non-zero token count),
    // clear empties it, and undo on an empty history errors (all-or-nothing).
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    let ws = temp_workspace("placeholder.txt", "x");

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let create = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {
            "session_id": "it-ctx", "system_prompt": "test", "model": "m",
            "homedir": ws.to_str().unwrap(), "goal_enabled": false
        }
    });
    writeln!(stdin, "{create}").unwrap();
    stdin.flush().unwrap();

    let await_id = |stdout: &mut BufReader<std::process::ChildStdout>,
                        want: u32|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
            if msg.get("method").is_none() && msg.get("id") == Some(&serde_json::json!(want)) {
                return msg;
            }
        }
    };
    let created = await_id(&mut stdout, 1);
    assert!(created.get("error").is_none(), "session/create failed: {created}");

    let mut call = |id: u32, method: &str, params: serde_json::Value| -> serde_json::Value {
        let req = serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        writeln!(stdin, "{req}").unwrap();
        stdin.flush().unwrap();
        await_id(&mut stdout, id)
    };

    let history_len = |v: &serde_json::Value| -> usize {
        v.get("result")
            .and_then(|r| r.get("history"))
            .and_then(|h| h.as_array())
            .map(|a| a.len())
            .unwrap_or(usize::MAX)
    };

    // Fresh: empty history, zero tokens.
    let c0 = call(2, "session/get_context", serde_json::json!({ "session_id": "it-ctx" }));
    assert_eq!(history_len(&c0), 0, "fresh context must be empty: {c0}");
    assert_eq!(
        c0.get("result").and_then(|r| r.get("token_count")).and_then(|v| v.as_u64()),
        Some(0),
        "fresh token_count must be 0: {c0}"
    );

    // Undo on empty history errors (nothing to undo).
    let u0 = call(3, "session/undo_history", serde_json::json!({ "session_id": "it-ctx", "count": 1 }));
    assert!(u0.get("error").is_some(), "undo on empty history must error: {u0}");

    // Import appends a user message get_context reports, with a marker.
    let imp = call(
        4,
        "session/import_context",
        serde_json::json!({ "session_id": "it-ctx", "content": "CTXMARK_IMPORT_9Z", "source": "unit-test" }),
    );
    assert_eq!(
        imp.get("result").and_then(|r| r.get("imported")).and_then(|v| v.as_bool()),
        Some(true),
        "import_context must succeed: {imp}"
    );
    let c1 = call(5, "session/get_context", serde_json::json!({ "session_id": "it-ctx" }));
    assert_eq!(history_len(&c1), 1, "context must hold the imported message: {c1}");
    assert!(
        serde_json::to_string(&c1).unwrap().contains("CTXMARK_IMPORT_9Z"),
        "imported marker must be present in context: {c1}"
    );
    assert!(
        c1.get("result").and_then(|r| r.get("token_count")).and_then(|v| v.as_u64()).unwrap_or(0) > 0,
        "token_count must be non-zero after import: {c1}"
    );

    // Clear empties the context; a second clear is a no-op (cleared=false).
    let cl1 = call(6, "session/clear_context", serde_json::json!({ "session_id": "it-ctx" }));
    assert_eq!(
        cl1.get("result").and_then(|r| r.get("cleared")).and_then(|v| v.as_bool()),
        Some(true),
        "clear must report cleared=true: {cl1}"
    );
    let c2 = call(7, "session/get_context", serde_json::json!({ "session_id": "it-ctx" }));
    assert_eq!(history_len(&c2), 0, "context must be empty after clear: {c2}");
    let cl2 = call(8, "session/clear_context", serde_json::json!({ "session_id": "it-ctx" }));
    assert_eq!(
        cl2.get("result").and_then(|r| r.get("cleared")).and_then(|v| v.as_bool()),
        Some(false),
        "clearing an empty context must report cleared=false: {cl2}"
    );

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&ws);
}

#[test]
fn session_lists_skills_and_surfaces_failed_mcp_as_warnings() {
    // list_skills reflects the skills registered at create; get_warnings
    // synthesizes a warning from an MCP server that fails to connect (a
    // command that cannot spawn always registers as `failed`).
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    let ws = temp_workspace("placeholder.txt", "x");

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    // No native_llm needed — no turn runs. A bogus stdio MCP command fails to
    // spawn during registration, landing the server in `failed`.
    let create = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {
            "session_id": "it-skillwarn", "system_prompt": "test", "model": "m",
            "homedir": ws.to_str().unwrap(), "goal_enabled": false,
            "skills": [
                { "name": "greet", "description": "Greet the user", "skill_type": "prompt" },
                { "name": "review", "description": "Review code", "skill_type": "workflow" }
            ],
            "mcp_servers": [{
                "name": "brokenmcp",
                "command": "this-command-does-not-exist-kimi-xyz",
                "args": [],
                "startup_timeout_ms": 5000
            }]
        }
    });
    writeln!(stdin, "{create}").unwrap();
    stdin.flush().unwrap();

    let await_id = |stdout: &mut BufReader<std::process::ChildStdout>,
                        want: u32|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
            if msg.get("method").is_none() && msg.get("id") == Some(&serde_json::json!(want)) {
                return msg;
            }
        }
    };
    let created = await_id(&mut stdout, 1);
    assert!(created.get("error").is_none(), "session/create failed: {created}");

    let mut call = |id: u32, method: &str, params: serde_json::Value| -> serde_json::Value {
        let req = serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        writeln!(stdin, "{req}").unwrap();
        stdin.flush().unwrap();
        await_id(&mut stdout, id)
    };

    // list_skills: both registered skills, sorted by name (greet < review).
    let skills = call(2, "session/list_skills", serde_json::json!({ "session_id": "it-skillwarn" }));
    let list = skills
        .get("result")
        .and_then(|r| r.get("skills"))
        .and_then(|s| s.as_array())
        .unwrap_or_else(|| panic!("list_skills failed: {skills}"));
    assert_eq!(list.len(), 2, "both skills expected: {skills}");
    assert_eq!(list[0].get("name").and_then(|v| v.as_str()), Some("greet"));
    assert_eq!(list[0].get("skill_type").and_then(|v| v.as_str()), Some("prompt"));
    assert_eq!(list[1].get("name").and_then(|v| v.as_str()), Some("review"));

    // get_warnings: the broken MCP server surfaces as a warning.
    let warns = call(3, "session/get_warnings", serde_json::json!({ "session_id": "it-skillwarn" }));
    let warnings = warns
        .get("result")
        .and_then(|r| r.get("warnings"))
        .and_then(|w| w.as_array())
        .unwrap_or_else(|| panic!("get_warnings failed: {warns}"));
    assert!(
        warnings.iter().any(|w| {
            w.get("message").and_then(|m| m.as_str()).is_some_and(|m| m.contains("brokenmcp"))
                && w.get("severity").and_then(|s| s.as_str()) == Some("warning")
        }),
        "the failed MCP server must surface as a warning: {warns}"
    );

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&ws);
}

#[test]
fn session_persists_assistant_replies_across_turns() {
    // Regression for the context-fidelity gap: the session-owned engine must
    // write each turn's assistant reply back into its ContextMemory, so the
    // next turn's provider request carries the prior assistant text.
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    let ws = temp_workspace("placeholder.txt", "x");

    // Turn 1 reply carries a marker; turn 2 reply is generic. We assert the
    // marker reappears in turn 2's request body (i.e. it came from persisted
    // context, not the new user input).
    let stub = spawn_sse_stub(|i| {
        if i == 0 {
            sse(&[
                serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
                serde_json::json!({ "choices": [{ "delta": { "content": "ASSISTANT_MEMO_XYZ" }, "finish_reason": null }] }),
                serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 5, "completion_tokens": 4 } }),
            ])
        } else {
            sse(&[
                serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
                serde_json::json!({ "choices": [{ "delta": { "content": "second reply" }, "finish_reason": null }] }),
                serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 9, "completion_tokens": 2 } }),
            ])
        }
    });

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let native_llm = serde_json::json!({
        "protocol": "openai",
        "base_url": format!("http://127.0.0.1:{}/v1", stub.port),
        "api_key": "stub",
        "model": "memo-model"
    });
    let create = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {
            "session_id": "it-memo", "system_prompt": "test", "model": "memo-model",
            "homedir": ws.to_str().unwrap(), "goal_enabled": false, "native_llm": native_llm
        }
    });
    writeln!(stdin, "{create}").unwrap();
    stdin.flush().unwrap();

    let await_id = |stdout: &mut BufReader<std::process::ChildStdout>,
                        want: u32|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
            if msg.get("method").is_none() && msg.get("id") == Some(&serde_json::json!(want)) {
                return msg;
            }
        }
    };
    let created = await_id(&mut stdout, 1);
    assert!(created.get("error").is_none(), "session/create failed: {created}");

    let mut call = |id: u32, method: &str, params: serde_json::Value| -> serde_json::Value {
        let req = serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        writeln!(stdin, "{req}").unwrap();
        stdin.flush().unwrap();
        await_id(&mut stdout, id)
    };

    let t1 = call(2, "session/prompt", serde_json::json!({ "session_id": "it-memo", "input": [{ "type": "text", "text": "turn one" }] }));
    assert!(t1.get("error").is_none(), "turn 1 failed: {t1}");
    let t2 = call(3, "session/prompt", serde_json::json!({ "session_id": "it-memo", "input": [{ "type": "text", "text": "turn two" }] }));
    assert!(t2.get("error").is_none(), "turn 2 failed: {t2}");

    let bodies = stub.bodies.lock().unwrap();
    assert_eq!(bodies.len(), 2, "two provider turns expected, got {}", bodies.len());
    // Turn 1's request cannot know the assistant reply yet.
    assert!(!bodies[0].contains("ASSISTANT_MEMO_XYZ"), "turn 1 body must not contain the reply");
    // Turn 2's request must carry the persisted assistant reply from turn 1.
    assert!(
        bodies[1].contains("ASSISTANT_MEMO_XYZ"),
        "turn 2 must include the persisted turn-1 assistant reply; body: {}",
        bodies[1]
    );

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&ws);
}

#[test]
fn session_compact_requires_a_native_summarizer() {
    // The compaction write-back is unit-tested in
    // `compaction::native_delegate::tests` (deterministic, no LLM). Here we
    // assert the RPC wiring + guard end to end: a session without a native-LLM
    // provider has no summarizer, so `session/compact` must surface a clear
    // error rather than silently no-op.
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    let ws = temp_workspace("placeholder.txt", "x");

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    // No native_llm → host-proxy mode → no engine-side summarizer.
    let create = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {
            "session_id": "it-compact", "system_prompt": "test", "model": "m",
            "homedir": ws.to_str().unwrap(), "goal_enabled": false
        }
    });
    writeln!(stdin, "{create}").unwrap();
    stdin.flush().unwrap();

    let await_id = |stdout: &mut BufReader<std::process::ChildStdout>,
                        want: u32|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
            if msg.get("method").is_none() && msg.get("id") == Some(&serde_json::json!(want)) {
                return msg;
            }
        }
    };
    let created = await_id(&mut stdout, 1);
    assert!(created.get("error").is_none(), "session/create failed: {created}");

    let compact = serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "session/compact",
        "params": { "session_id": "it-compact" }
    });
    writeln!(stdin, "{compact}").unwrap();
    stdin.flush().unwrap();
    let resp = await_id(&mut stdout, 2);
    let message = resp
        .get("error")
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .unwrap_or("");
    assert!(
        message.contains("delegate"),
        "compact without a native summarizer must error clearly, got: {resp}"
    );

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&ws);
}

#[test]
fn session_compact_summarizes_via_native_llm_and_rewrites_context() {
    // Now that assistant replies persist, a prompt turn leaves a
    // [user, assistant] history with a safe split point, so a manual compact
    // can summarize it via the native LLM and rewrite the context.
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    let ws = temp_workspace("placeholder.txt", "x");

    // Call 0: the prompt turn. Call 1: the compaction summarizer, whose reply
    // is the summary; its request body must carry the earlier turn content.
    let stub = spawn_sse_stub(|i| {
        if i == 0 {
            sse(&[
                serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
                serde_json::json!({ "choices": [{ "delta": { "content": "reply about FROBNICATE" }, "finish_reason": null }] }),
                serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 5, "completion_tokens": 4 } }),
            ])
        } else {
            sse(&[
                serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
                serde_json::json!({ "choices": [{ "delta": { "content": "COMPACTION_SUMMARY_TEXT" }, "finish_reason": null }] }),
                serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 8, "completion_tokens": 2 } }),
            ])
        }
    });

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let native_llm = serde_json::json!({
        "protocol": "openai",
        "base_url": format!("http://127.0.0.1:{}/v1", stub.port),
        "api_key": "stub",
        "model": "compact-model"
    });
    let create = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {
            "session_id": "it-compact2", "system_prompt": "test", "model": "compact-model",
            "homedir": ws.to_str().unwrap(), "goal_enabled": false, "native_llm": native_llm
        }
    });
    writeln!(stdin, "{create}").unwrap();
    stdin.flush().unwrap();

    let await_id = |stdout: &mut BufReader<std::process::ChildStdout>,
                        want: u32|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
            if msg.get("method").is_none() && msg.get("id") == Some(&serde_json::json!(want)) {
                return msg;
            }
        }
    };
    let created = await_id(&mut stdout, 1);
    assert!(created.get("error").is_none(), "session/create failed: {created}");

    let mut call = |id: u32, method: &str, params: serde_json::Value| -> serde_json::Value {
        let req = serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        writeln!(stdin, "{req}").unwrap();
        stdin.flush().unwrap();
        await_id(&mut stdout, id)
    };

    let prompt = call(2, "session/prompt", serde_json::json!({ "session_id": "it-compact2", "input": [{ "type": "text", "text": "tell me about FROBNICATE" }] }));
    assert!(prompt.get("error").is_none(), "session/prompt failed: {prompt}");

    let compact = call(3, "session/compact", serde_json::json!({ "session_id": "it-compact2" }));
    let r = compact.get("result").unwrap_or_else(|| panic!("compact failed: {compact}"));
    assert_eq!(r.get("compacted").and_then(|v| v.as_bool()), Some(true), "compact must run: {compact}");
    assert_eq!(
        r.get("summary").and_then(|v| v.as_str()),
        Some("COMPACTION_SUMMARY_TEXT"),
        "the summarizer reply must be the compaction summary: {compact}"
    );

    {
        let bodies = stub.bodies.lock().unwrap();
        assert_eq!(bodies.len(), 2, "prompt + compaction summarizer expected, got {}", bodies.len());
        assert!(
            bodies[1].contains("FROBNICATE"),
            "the summarizer must receive the persisted history; body: {}",
            bodies[1]
        );
    }

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&ws);
}

#[test]
fn session_set_model_changes_the_provider_model_on_the_next_turn() {
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    let ws = temp_workspace("placeholder.txt", "x");

    // One provider call per prompt; each just returns final text. We assert the
    // request body's model field, which `session/set_model` must change.
    let stub = spawn_sse_stub(|_i| {
        sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "content": "ok" }, "finish_reason": null }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 5, "completion_tokens": 1 } }),
        ])
    });

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let native_llm = serde_json::json!({
        "protocol": "openai",
        "base_url": format!("http://127.0.0.1:{}/v1", stub.port),
        "api_key": "stub",
        "model": "model-alpha"
    });
    let create = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {
            "session_id": "it-model", "system_prompt": "test", "model": "model-alpha",
            "homedir": ws.to_str().unwrap(), "goal_enabled": false, "native_llm": native_llm
        }
    });
    writeln!(stdin, "{create}").unwrap();
    stdin.flush().unwrap();

    let mut host_methods: Vec<String> = Vec::new();
    let await_id = |stdin: &mut std::process::ChildStdin,
                        stdout: &mut BufReader<std::process::ChildStdout>,
                        want: u32,
                        hm: &mut Vec<String>|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
            match msg.get("method").and_then(|m| m.as_str()) {
                None => {
                    if msg.get("id") == Some(&serde_json::json!(want)) {
                        return msg;
                    }
                }
                Some("host/event") => {}
                Some(method) => {
                    if let Some(id) = msg.get("id").filter(|v| !v.is_null()) {
                        hm.push(method.to_string());
                        let resp = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": null });
                        writeln!(stdin, "{resp}").unwrap();
                        stdin.flush().unwrap();
                    }
                }
            }
        }
    };
    await_id(&mut stdin, &mut stdout, 1, &mut host_methods);

    // Turn 1 on model-alpha.
    writeln!(stdin, "{}", serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "session/prompt",
        "params": { "session_id": "it-model", "input": [{ "type": "text", "text": "hi" }] }
    })).unwrap();
    stdin.flush().unwrap();
    await_id(&mut stdin, &mut stdout, 2, &mut host_methods);

    // Switch model, then Turn 2 must use model-beta.
    writeln!(stdin, "{}", serde_json::json!({
        "jsonrpc": "2.0", "id": 3, "method": "session/set_model",
        "params": { "session_id": "it-model", "model": "model-beta" }
    })).unwrap();
    stdin.flush().unwrap();
    let set = await_id(&mut stdin, &mut stdout, 3, &mut host_methods);
    assert!(set.get("error").is_none(), "session/set_model failed: {set}");

    writeln!(stdin, "{}", serde_json::json!({
        "jsonrpc": "2.0", "id": 4, "method": "session/prompt",
        "params": { "session_id": "it-model", "input": [{ "type": "text", "text": "again" }] }
    })).unwrap();
    stdin.flush().unwrap();
    await_id(&mut stdin, &mut stdout, 4, &mut host_methods);

    let bodies = stub.bodies.lock().unwrap();
    assert_eq!(bodies.len(), 2, "two turns → two provider calls, got {}", bodies.len());
    assert!(bodies[0].contains("\"model\":\"model-alpha\""), "turn 1 body: {}", bodies[0]);
    assert!(
        bodies[1].contains("\"model\":\"model-beta\""),
        "set_model must change the model on turn 2; body: {}",
        bodies[1]
    );

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&ws);
}

#[test]
fn session_run_shell_executes_natively_and_returns_output() {
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    // No LLM needed: session/run_shell is a silent user command. Create a
    // session without native_llm, then run a portable echo.
    let ws = temp_workspace("placeholder.txt", "x");
    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let create = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {
            "session_id": "it-shell", "system_prompt": "test", "model": "m",
            "homedir": ws.to_str().unwrap(), "goal_enabled": false
        }
    });
    writeln!(stdin, "{create}").unwrap();
    stdin.flush().unwrap();

    let await_id = |stdin: &mut std::process::ChildStdin,
                        stdout: &mut BufReader<std::process::ChildStdout>,
                        want: u32|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
            match msg.get("method").and_then(|m| m.as_str()) {
                None => {
                    if msg.get("id") == Some(&serde_json::json!(want)) {
                        return msg;
                    }
                }
                Some(_) => {
                    if let Some(id) = msg.get("id").filter(|v| !v.is_null()) {
                        let resp = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": null });
                        writeln!(stdin, "{resp}").unwrap();
                        stdin.flush().unwrap();
                    }
                }
            }
        }
    };
    let created = await_id(&mut stdin, &mut stdout, 1);
    assert!(created.get("error").is_none(), "session/create failed: {created}");

    writeln!(stdin, "{}", serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "session/run_shell",
        "params": { "session_id": "it-shell", "command": "echo SHELL_OUT_MARKER" }
    })).unwrap();
    stdin.flush().unwrap();
    let resp = await_id(&mut stdin, &mut stdout, 2);
    assert!(resp.get("error").is_none(), "session/run_shell failed: {resp}");
    let result = resp.get("result").expect("result");

    // Either the native shell ran the command (output carries the marker) or no
    // shell exists on this host (unavailable → host would run it). Both are
    // correct; assert the shape and, when available, the output.
    if result.get("unavailable").and_then(|v| v.as_bool()) == Some(true) {
        eprintln!("native shell unavailable on this host; run_shell correctly deferred");
    } else {
        let output = result.get("output").and_then(|v| v.as_str()).unwrap_or("");
        assert!(output.contains("SHELL_OUT_MARKER"), "shell output: {output}");
        assert_eq!(result.get("is_error").and_then(|v| v.as_bool()), Some(false));
    }

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&ws);
}

#[test]
fn session_set_thinking_emits_reasoning_effort_on_the_next_turn() {
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    let ws = temp_workspace("placeholder.txt", "x");
    let stub = spawn_sse_stub(|_i| {
        sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "content": "ok" }, "finish_reason": null }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 5, "completion_tokens": 1 } }),
        ])
    });

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let native_llm = serde_json::json!({
        "protocol": "openai",
        "base_url": format!("http://127.0.0.1:{}/v1", stub.port),
        "api_key": "stub",
        "model": "m"
    });
    writeln!(stdin, "{}", serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {
            "session_id": "it-think", "system_prompt": "test", "model": "m",
            "homedir": ws.to_str().unwrap(), "goal_enabled": false, "native_llm": native_llm
        }
    })).unwrap();
    stdin.flush().unwrap();

    let await_id = |stdin: &mut std::process::ChildStdin,
                        stdout: &mut BufReader<std::process::ChildStdout>,
                        want: u32|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
            match msg.get("method").and_then(|m| m.as_str()) {
                None => {
                    if msg.get("id") == Some(&serde_json::json!(want)) {
                        return msg;
                    }
                }
                Some(_) => {
                    if let Some(id) = msg.get("id").filter(|v| !v.is_null()) {
                        let resp = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": null });
                        writeln!(stdin, "{resp}").unwrap();
                        stdin.flush().unwrap();
                    }
                }
            }
        }
    };
    await_id(&mut stdin, &mut stdout, 1);

    // Turn 1 (no reasoning). Then set_thinking("high"), then Turn 2.
    writeln!(stdin, "{}", serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "session/prompt",
        "params": { "session_id": "it-think", "input": [{ "type": "text", "text": "a" }] }
    })).unwrap();
    stdin.flush().unwrap();
    await_id(&mut stdin, &mut stdout, 2);

    writeln!(stdin, "{}", serde_json::json!({
        "jsonrpc": "2.0", "id": 3, "method": "session/set_thinking",
        "params": { "session_id": "it-think", "effort": "high" }
    })).unwrap();
    stdin.flush().unwrap();
    let set = await_id(&mut stdin, &mut stdout, 3);
    assert!(set.get("error").is_none(), "session/set_thinking failed: {set}");

    writeln!(stdin, "{}", serde_json::json!({
        "jsonrpc": "2.0", "id": 4, "method": "session/prompt",
        "params": { "session_id": "it-think", "input": [{ "type": "text", "text": "b" }] }
    })).unwrap();
    stdin.flush().unwrap();
    await_id(&mut stdin, &mut stdout, 4);

    let bodies = stub.bodies.lock().unwrap();
    assert_eq!(bodies.len(), 2, "two turns → two provider calls, got {}", bodies.len());
    assert!(!bodies[0].contains("reasoning_effort"), "turn 1 must not carry it: {}", bodies[0]);
    assert!(
        bodies[1].contains("\"reasoning_effort\":\"high\""),
        "set_thinking must emit reasoning_effort on turn 2; body: {}",
        bodies[1]
    );

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&ws);
}

#[test]
fn session_steer_input_is_injected_into_the_next_turn() {
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    let ws = temp_workspace("placeholder.txt", "x");
    let stub = spawn_sse_stub(|_i| {
        sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "content": "ok" }, "finish_reason": null }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 5, "completion_tokens": 1 } }),
        ])
    });

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let native_llm = serde_json::json!({
        "protocol": "openai",
        "base_url": format!("http://127.0.0.1:{}/v1", stub.port),
        "api_key": "stub",
        "model": "m"
    });
    writeln!(stdin, "{}", serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {
            "session_id": "it-steer", "system_prompt": "test", "model": "m",
            "homedir": ws.to_str().unwrap(), "goal_enabled": false, "native_llm": native_llm
        }
    })).unwrap();
    stdin.flush().unwrap();

    let await_id = |stdin: &mut std::process::ChildStdin,
                        stdout: &mut BufReader<std::process::ChildStdout>,
                        want: u32|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
            match msg.get("method").and_then(|m| m.as_str()) {
                None => {
                    if msg.get("id") == Some(&serde_json::json!(want)) {
                        return msg;
                    }
                }
                Some(_) => {
                    if let Some(id) = msg.get("id").filter(|v| !v.is_null()) {
                        let resp = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": null });
                        writeln!(stdin, "{resp}").unwrap();
                        stdin.flush().unwrap();
                    }
                }
            }
        }
    };
    await_id(&mut stdin, &mut stdout, 1);

    // Steer BEFORE prompting: the queued text must be drained into the turn.
    writeln!(stdin, "{}", serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "session/steer",
        "params": { "session_id": "it-steer", "input": [{ "type": "text", "text": "STEER_MARKER_QWE" }] }
    })).unwrap();
    stdin.flush().unwrap();
    let steer = await_id(&mut stdin, &mut stdout, 2);
    assert_eq!(steer.get("result").and_then(|r| r.get("queued")).and_then(|v| v.as_bool()), Some(true));

    writeln!(stdin, "{}", serde_json::json!({
        "jsonrpc": "2.0", "id": 3, "method": "session/prompt",
        "params": { "session_id": "it-steer", "input": [{ "type": "text", "text": "go" }] }
    })).unwrap();
    stdin.flush().unwrap();
    await_id(&mut stdin, &mut stdout, 3);

    let bodies = stub.bodies.lock().unwrap();
    assert_eq!(bodies.len(), 1, "one prompt → one provider call, got {}", bodies.len());
    assert!(
        bodies[0].contains("STEER_MARKER_QWE"),
        "steered input must appear in the turn's request; body: {}",
        bodies[0]
    );

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&ws);
}

// ── Cross-session persistence ────────────────────────────────────────────────

/// Spawn the binary with a scratch `KIMI_AGENT_HOME`, run `cron/create`,
/// restart with the same home, and verify the task survived the restart.
#[test]
fn cron_survives_restart() {
    let home = std::env::temp_dir().join(format!("kimi-agent-it-cron-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&home);
    let mut env = std::collections::HashMap::new();
    env.insert("KIMI_AGENT_HOME", home.to_string_lossy().to_string());

    let mut client = RpcClient::start_with_env(env.clone());
    require_binary!(client);
    let client = client.as_mut().unwrap();
    let resp = client
        .request(
            "cron/create",
            serde_json::json!({ "cron": "*/5 * * * *", "prompt": "restart-probe", "recurring": true }),
        )
        .expect("cron/create response");
    assert!(resp.get("error").is_none(), "unexpected error: {resp}");
    let task_id = resp["result"]["id"].as_str().unwrap().to_string();
    client.shutdown();

    // Restart with the same KIMI_AGENT_HOME — the task must come back.
    let mut client2 = RpcClient::start_with_env(env);
    require_binary!(client2);
    let client2 = client2.as_mut().unwrap();
    let list = client2
        .request("cron/list", serde_json::json!({}))
        .expect("cron/list response");
    let tasks = list["result"]["tasks"].as_array().unwrap();
    assert!(
        tasks.iter().any(|t| t["id"] == task_id),
        "cron task {task_id} must survive a restart; list: {tasks:?}"
    );
    client2.shutdown();

    let _ = std::fs::remove_dir_all(&home);
}

/// Register a background task, append output, restart, and read the output
/// back through the SQLite fallback in `bg/output` (ghost task path).
#[test]
fn bg_output_readable_after_restart() {
    let home = std::env::temp_dir().join(format!("kimi-agent-it-bg-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&home);
    let mut env = std::collections::HashMap::new();
    env.insert("KIMI_AGENT_HOME", home.to_string_lossy().to_string());

    let mut client = RpcClient::start_with_env(env.clone());
    require_binary!(client);
    let client = client.as_mut().unwrap();
    let reg = client
        .request(
            "bg/register",
            serde_json::json!({ "prefix": "it-bg", "kind": "process", "description": "restart-probe" }),
        )
        .expect("bg/register response");
    assert!(reg.get("error").is_none(), "unexpected error: {reg}");
    let task_id = reg["result"]["task_id"].as_str().unwrap().to_string();
    let app = client
        .request(
            "bg/append_output",
            serde_json::json!({ "task_id": task_id, "chunk": "hello-from-before-restart" }),
        )
        .expect("bg/append_output response");
    assert!(app.get("error").is_none(), "unexpected error: {app}");
    client.shutdown();

    // Restart — the task is a ghost; bg/output must serve the persisted chunk.
    let mut client2 = RpcClient::start_with_env(env);
    require_binary!(client2);
    let client2 = client2.as_mut().unwrap();
    let out = client2
        .request("bg/output", serde_json::json!({ "task_id": task_id }))
        .expect("bg/output response");
    let result = &out["result"];
    assert_eq!(
        result["preview"].as_str(),
        Some("hello-from-before-restart"),
        "ghost task output must be served from SQLite; response: {out}"
    );
    client2.shutdown();

    let _ = std::fs::remove_dir_all(&home);
}

/// The native AgentSwarm tool: the parent issues one AgentSwarm call with two
/// items; two child agents run in parallel (each gets its own provider call
/// with the substituted prompt); the parent's next turn sees the rendered
/// `<agent_swarm_result>` summary. Zero host/llm_chat, zero host/execute_tool.
#[test]
fn native_agent_swarm_dispatches_children_and_renders_results() {
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    let ws = temp_workspace("placeholder.txt", "x");
    // Provider calls in order:
    //   0 parent step 0 -> AgentSwarm tool call (2 items)
    //   1 child A       -> SWARM_ANSWER_A
    //   2 child B       -> SWARM_ANSWER_B
    //   3 parent step 1 -> parent final text (sees the rendered swarm result)
    let stub = spawn_sse_stub(|i| match i {
        0 => sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "call_swarm", "type": "function", "function": { "name": "AgentSwarm", "arguments": "" } }] } }] }),
            serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": "{\"description\":\"swarm it\",\"prompt_template\":\"Investigate {{item}}\",\"items\":[\"topic-alpha\",\"topic-beta\"]}" } }] } }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }], "usage": { "prompt_tokens": 9, "completion_tokens": 4 } }),
        ]),
        1 => sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "content": "SWARM_ANSWER_A" }, "finish_reason": null }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 5, "completion_tokens": 2 } }),
        ]),
        2 => sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "content": "SWARM_ANSWER_B" }, "finish_reason": null }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 5, "completion_tokens": 2 } }),
        ]),
        _ => sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "content": "parent swarm done" }, "finish_reason": null }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 30, "completion_tokens": 2 } }),
        ]),
    });

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let native_llm = serde_json::json!({
        "protocol": "openai",
        "base_url": format!("http://127.0.0.1:{}/v1", stub.port),
        "api_key": "stub",
        "model": "stub-model"
    });
    let create = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {
            "session_id": "it-swarm", "system_prompt": "test", "model": "stub-model",
            "goal_enabled": false, "native_llm": native_llm
        }
    });
    writeln!(stdin, "{create}").unwrap();
    stdin.flush().unwrap();

    let mut host_methods: Vec<String> = Vec::new();
    let await_id = |stdin: &mut std::process::ChildStdin,
                        stdout: &mut BufReader<std::process::ChildStdout>,
                        want: u32,
                        hm: &mut Vec<String>|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
            match msg.get("method").and_then(|m| m.as_str()) {
                None => {
                    if msg.get("id") == Some(&serde_json::json!(want)) {
                        return msg;
                    }
                }
                Some("host/event") => {}
                Some(method) => {
                    if let Some(id) = msg.get("id").filter(|v| !v.is_null()) {
                        hm.push(method.to_string());
                        let resp = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": null });
                        writeln!(stdin, "{resp}").unwrap();
                        stdin.flush().unwrap();
                    }
                }
            }
        }
    };
    let created = await_id(&mut stdin, &mut stdout, 1, &mut host_methods);
    assert!(created.get("error").is_none(), "session/create failed: {created}");

    let prompt = serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "session/prompt",
        "params": { "session_id": "it-swarm", "input": [{ "type": "text", "text": "swarm the topics" }] }
    });
    writeln!(stdin, "{prompt}").unwrap();
    stdin.flush().unwrap();
    let resp = await_id(&mut stdin, &mut stdout, 2, &mut host_methods);
    assert!(resp.get("error").is_none(), "session/prompt failed: {resp}");

    let bodies = stub.bodies.lock().unwrap();
    assert_eq!(bodies.len(), 4, "parent(2) + two children expected, got {}", bodies.len());
    // Each child got its item substituted into the prompt template (the two
    // children run in parallel, so their provider-call order is not fixed).
    let child_has_item = |body: &str, item: &str| body.contains(&format!("Investigate {item}"));
    assert!(
        (child_has_item(&bodies[1], "topic-alpha") && child_has_item(&bodies[2], "topic-beta"))
            || (child_has_item(&bodies[1], "topic-beta") && child_has_item(&bodies[2], "topic-alpha")),
        "children must carry their item prompts; bodies: {} | {}",
        bodies[1],
        bodies[2]
    );
    // The parent's second call saw the rendered swarm summary with both answers.
    assert!(
        bodies[3].contains("<agent_swarm_result>"),
        "parent must see the swarm result XML; body: {}",
        bodies[3]
    );
    assert!(bodies[3].contains("SWARM_ANSWER_A"), "body: {}", bodies[3]);
    assert!(bodies[3].contains("SWARM_ANSWER_B"), "body: {}", bodies[3]);
    assert!(bodies[3].contains("2 completed, 0 failed"), "body: {}", bodies[3]);
    // Whole swarm ran natively — no host LLM or host tool execution.
    assert!(!host_methods.iter().any(|m| m == "host/llm_chat"), "saw: {host_methods:?}");
    assert!(!host_methods.iter().any(|m| m == "host/execute_tool"), "saw: {host_methods:?}");

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&ws);
}

/// The native SwarmDiscussion tool (roundtable mode): the parent issues one
/// SwarmDiscussion call with two participants; each participant speaks via a
/// fresh child agent (per-turn provider calls); the parent's next turn sees
/// the rendered `<discussion_result>` transcript. Zero host round-trips.
#[test]
fn native_swarm_discussion_orchestrates_roundtable() {
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    let ws = temp_workspace("placeholder.txt", "x");
    // Provider calls in order:
    //   0 parent step 0 -> SwarmDiscussion tool call
    //   1 participant 1 -> SPEECH_ONE
    //   2 participant 2 -> SPEECH_TWO
    //   3 parent step 1 -> parent final text (sees the discussion result)
    let stub = spawn_sse_stub(|i| match i {
        0 => sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "call_disc", "type": "function", "function": { "name": "SwarmDiscussion", "arguments": "" } }] } }] }),
            serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": "{\"topic\":\"best language\",\"participants\":[{\"profileName\":\"coder\",\"roleDescription\":\"Argue for Rust\"},{\"profileName\":\"coder\",\"roleDescription\":\"Argue for Go\"}],\"maxRounds\":1}" } }] } }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }], "usage": { "prompt_tokens": 9, "completion_tokens": 4 } }),
        ]),
        1 => sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "content": "SPEECH_ONE_RUST" }, "finish_reason": null }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 5, "completion_tokens": 2 } }),
        ]),
        2 => sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "content": "SPEECH_TWO_GO" }, "finish_reason": null }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 5, "completion_tokens": 2 } }),
        ]),
        _ => sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "content": "parent discussion done" }, "finish_reason": null }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 30, "completion_tokens": 2 } }),
        ]),
    });

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let native_llm = serde_json::json!({
        "protocol": "openai",
        "base_url": format!("http://127.0.0.1:{}/v1", stub.port),
        "api_key": "stub",
        "model": "stub-model"
    });
    let create = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {
            "session_id": "it-disc", "system_prompt": "test", "model": "stub-model",
            "goal_enabled": false, "native_llm": native_llm
        }
    });
    writeln!(stdin, "{create}").unwrap();
    stdin.flush().unwrap();

    let mut host_methods: Vec<String> = Vec::new();
    let await_id = |stdin: &mut std::process::ChildStdin,
                        stdout: &mut BufReader<std::process::ChildStdout>,
                        want: u32,
                        hm: &mut Vec<String>|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
            match msg.get("method").and_then(|m| m.as_str()) {
                None => {
                    if msg.get("id") == Some(&serde_json::json!(want)) {
                        return msg;
                    }
                }
                Some("host/event") => {}
                Some(method) => {
                    if let Some(id) = msg.get("id").filter(|v| !v.is_null()) {
                        hm.push(method.to_string());
                        let resp = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": null });
                        writeln!(stdin, "{resp}").unwrap();
                        stdin.flush().unwrap();
                    }
                }
            }
        }
    };
    let created = await_id(&mut stdin, &mut stdout, 1, &mut host_methods);
    assert!(created.get("error").is_none(), "session/create failed: {created}");

    let prompt = serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "session/prompt",
        "params": { "session_id": "it-disc", "input": [{ "type": "text", "text": "discuss the languages" }] }
    });
    writeln!(stdin, "{prompt}").unwrap();
    stdin.flush().unwrap();
    let resp = await_id(&mut stdin, &mut stdout, 2, &mut host_methods);
    assert!(resp.get("error").is_none(), "session/prompt failed: {resp}");

    let bodies = stub.bodies.lock().unwrap();
    assert_eq!(bodies.len(), 4, "parent(2) + two participant speeches expected, got {}", bodies.len());
    // The parent's second call saw the rendered discussion transcript.
    assert!(
        bodies[3].contains("<discussion_result>"),
        "parent must see the discussion result XML; body: {}",
        bodies[3]
    );
    assert!(bodies[3].contains("rounds: 1, speeches: 2, status: completed"), "body: {}", bodies[3]);
    assert!(bodies[3].contains("SPEECH_ONE_RUST"), "body: {}", bodies[3]);
    assert!(bodies[3].contains("SPEECH_TWO_GO"), "body: {}", bodies[3]);
    // The whole discussion ran natively.
    assert!(!host_methods.iter().any(|m| m == "host/llm_chat"), "saw: {host_methods:?}");
    assert!(!host_methods.iter().any(|m| m == "host/execute_tool"), "saw: {host_methods:?}");

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&ws);
}

/// session/init (SDK `Session.init` parity): the engine spawns an init
/// subagent, then injects the AGENTS.md completion reminder into the parent
/// context — the parent's next provider call must carry the reminder.
#[test]
fn session_init_generates_agents_md_and_injects_reminder() {
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    let ws = temp_workspace("placeholder.txt", "x");
    // Provider calls in order:
    //   0 init subagent -> "initialized"
    //   1 parent prompt -> parent final text (sees the init reminder)
    let stub = spawn_sse_stub(|i| match i {
        0 => sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "content": "initialized the workspace" }, "finish_reason": null }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 5, "completion_tokens": 2 } }),
        ]),
        _ => sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "content": "parent done after init" }, "finish_reason": null }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 30, "completion_tokens": 2 } }),
        ]),
    });

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let native_llm = serde_json::json!({
        "protocol": "openai",
        "base_url": format!("http://127.0.0.1:{}/v1", stub.port),
        "api_key": "stub",
        "model": "stub-model"
    });
    let create = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {
            "session_id": "it-init", "system_prompt": "test", "model": "stub-model",
            "goal_enabled": false, "native_llm": native_llm
        }
    });
    writeln!(stdin, "{create}").unwrap();
    stdin.flush().unwrap();

    let mut host_methods: Vec<String> = Vec::new();
    let await_id = |stdin: &mut std::process::ChildStdin,
                        stdout: &mut BufReader<std::process::ChildStdout>,
                        want: u32,
                        hm: &mut Vec<String>|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
            match msg.get("method").and_then(|m| m.as_str()) {
                None => {
                    if msg.get("id") == Some(&serde_json::json!(want)) {
                        return msg;
                    }
                }
                Some("host/event") => {}
                Some(method) => {
                    if let Some(id) = msg.get("id").filter(|v| !v.is_null()) {
                        hm.push(method.to_string());
                        let resp = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": null });
                        writeln!(stdin, "{resp}").unwrap();
                        stdin.flush().unwrap();
                    }
                }
            }
        }
    };
    let created = await_id(&mut stdin, &mut stdout, 1, &mut host_methods);
    assert!(created.get("error").is_none(), "session/create failed: {created}");

    // Run session/init — the engine spawns the init subagent (provider call 0).
    let init_req = serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "session/init",
        "params": { "session_id": "it-init" }
    });
    writeln!(stdin, "{init_req}").unwrap();
    stdin.flush().unwrap();
    let init_resp = await_id(&mut stdin, &mut stdout, 2, &mut host_methods);
    assert!(init_resp.get("error").is_none(), "session/init failed: {init_resp}");

    // Prompt the parent — its provider call must carry the init reminder.
    let prompt = serde_json::json!({
        "jsonrpc": "2.0", "id": 3, "method": "session/prompt",
        "params": { "session_id": "it-init", "input": [{ "type": "text", "text": "what now" }] }
    });
    writeln!(stdin, "{prompt}").unwrap();
    stdin.flush().unwrap();
    let resp = await_id(&mut stdin, &mut stdout, 3, &mut host_methods);
    assert!(resp.get("error").is_none(), "session/prompt failed: {resp}");

    let bodies = stub.bodies.lock().unwrap();
    assert_eq!(bodies.len(), 2, "init subagent + parent expected, got {}", bodies.len());
    // The init subagent received the DEFAULT_INIT_PROMPT.
    assert!(
        bodies[0].contains("write it to the `AGENTS.md` file"),
        "init subagent must carry the init prompt; body: {}",
        bodies[0]
    );
    // The parent's call carries the completion reminder (no AGENTS.md was
    // written by the stub subagent, so the fallback text appears).
    assert!(
        bodies[1].contains("The user just ran `/init` slash command"),
        "parent must see the init reminder; body: {}",
        bodies[1]
    );
    assert!(
        bodies[1].contains("No AGENTS.md content was found"),
        "parent must see the no-content fallback; body: {}",
        bodies[1]
    );
    // The whole init ran natively.
    assert!(!host_methods.iter().any(|m| m == "host/llm_chat"), "saw: {host_methods:?}");
    assert!(!host_methods.iter().any(|m| m == "host/execute_tool"), "saw: {host_methods:?}");

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&ws);
}

/// session/start_btw (SDK `Session.startBtw` parity): the engine spawns a
/// side-question subagent that inherits the main transport config and carries
/// the side-channel reminder; prompts routed with the btw agent id drive the
/// child (no tools, no goal), and end_btw cleans it up. Zero host round-trips.
#[test]
fn session_start_btw_drives_a_side_question_agent() {
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    let ws = temp_workspace("placeholder.txt", "x");
    // Provider calls in order:
    //   0 btw subagent -> "SIDE_ANSWER_42"
    let stub = spawn_sse_stub(|i| match i {
        _ => sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "content": "SIDE_ANSWER_42" }, "finish_reason": null }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 5, "completion_tokens": 2 } }),
        ]),
    });

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let native_llm = serde_json::json!({
        "protocol": "openai",
        "base_url": format!("http://127.0.0.1:{}/v1", stub.port),
        "api_key": "stub",
        "model": "stub-model"
    });
    let create = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {
            "session_id": "it-btw", "system_prompt": "main prompt", "model": "stub-model",
            "goal_enabled": false, "native_llm": native_llm
        }
    });
    writeln!(stdin, "{create}").unwrap();
    stdin.flush().unwrap();

    let mut host_methods: Vec<String> = Vec::new();
    let await_id = |stdin: &mut std::process::ChildStdin,
                        stdout: &mut BufReader<std::process::ChildStdout>,
                        want: u32,
                        hm: &mut Vec<String>|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
            match msg.get("method").and_then(|m| m.as_str()) {
                None => {
                    if msg.get("id") == Some(&serde_json::json!(want)) {
                        return msg;
                    }
                }
                Some("host/event") => {}
                Some(method) => {
                    if let Some(id) = msg.get("id").filter(|v| !v.is_null()) {
                        hm.push(method.to_string());
                        let resp = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": null });
                        writeln!(stdin, "{resp}").unwrap();
                        stdin.flush().unwrap();
                    }
                }
            }
        }
    };
    let created = await_id(&mut stdin, &mut stdout, 1, &mut host_methods);
    assert!(created.get("error").is_none(), "session/create failed: {created}");

    // Spawn the side agent.
    let start = serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "session/start_btw",
        "params": { "session_id": "it-btw" }
    });
    writeln!(stdin, "{start}").unwrap();
    stdin.flush().unwrap();
    let start_resp = await_id(&mut stdin, &mut stdout, 2, &mut host_methods);
    assert!(start_resp.get("error").is_none(), "session/start_btw failed: {start_resp}");
    let btw_id = start_resp["result"]["btw_id"].as_str().unwrap().to_string();
    assert_eq!(btw_id, "btw-it-btw");

    // Drive the side agent with its agent id.
    let prompt = serde_json::json!({
        "jsonrpc": "2.0", "id": 3, "method": "session/prompt",
        "params": {
            "session_id": "it-btw",
            "agent_id": btw_id,
            "input": [{ "type": "text", "text": "quick question?" }]
        }
    });
    writeln!(stdin, "{prompt}").unwrap();
    stdin.flush().unwrap();
    let resp = await_id(&mut stdin, &mut stdout, 3, &mut host_methods);
    assert!(resp.get("error").is_none(), "side prompt failed: {resp}");

    let bodies = stub.bodies.lock().unwrap();
    assert_eq!(bodies.len(), 1, "one side-agent call expected, got {}", bodies.len());
    // The side agent carries the side-channel reminder (no tools, text only).
    assert!(
        bodies[0].contains("side-channel conversation"),
        "side agent must carry the SIDE_QUESTION reminder; body: {}",
        bodies[0]
    );
    assert!(
        bodies[0].contains("Do not call any tools"),
        "side agent must be tool-disabled; body: {}",
        bodies[0]
    );

    // End the side agent — the next prompt with a btw id fails cleanly.
    let end = serde_json::json!({
        "jsonrpc": "2.0", "id": 4, "method": "session/end_btw",
        "params": { "session_id": "it-btw" }
    });
    writeln!(stdin, "{end}").unwrap();
    stdin.flush().unwrap();
    let end_resp = await_id(&mut stdin, &mut stdout, 4, &mut host_methods);
    assert!(end_resp.get("error").is_none(), "session/end_btw failed: {end_resp}");
    assert_eq!(end_resp["result"]["ended"], true);

    // The whole side conversation ran natively.
    assert!(!host_methods.iter().any(|m| m == "host/llm_chat"), "saw: {host_methods:?}");
    assert!(!host_methods.iter().any(|m| m == "host/execute_tool"), "saw: {host_methods:?}");

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&ws);
}

/// session/destroy tears the in-memory agent down (SessionEnd hooks fire
/// first); the persisted record survives for session/load. A prompt after
/// destroy fails with "no agent"; after load it works again.
#[test]
fn session_destroy_tears_down_and_load_recovers() {
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    let home = std::env::temp_dir().join(format!("kimi-agent-it-destroy-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&home);
    let ws = temp_workspace("placeholder.txt", "x");
    let stub = spawn_sse_stub(|i| match i {
        _ => sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "content": "done" }, "finish_reason": null }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 5, "completion_tokens": 2 } }),
        ]),
    });

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("KIMI_AGENT_HOME", &home)
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let native_llm = serde_json::json!({
        "protocol": "openai",
        "base_url": format!("http://127.0.0.1:{}/v1", stub.port),
        "api_key": "stub",
        "model": "stub-model"
    });
    let create = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {
            "session_id": "it-destroy", "system_prompt": "test", "model": "stub-model",
            "goal_enabled": false, "native_llm": native_llm
        }
    });
    writeln!(stdin, "{create}").unwrap();
    stdin.flush().unwrap();

    let mut host_methods: Vec<String> = Vec::new();
    let await_id = |stdin: &mut std::process::ChildStdin,
                        stdout: &mut BufReader<std::process::ChildStdout>,
                        want: u32,
                        hm: &mut Vec<String>|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
            match msg.get("method").and_then(|m| m.as_str()) {
                None => {
                    if msg.get("id") == Some(&serde_json::json!(want)) {
                        return msg;
                    }
                }
                Some("host/event") => {}
                Some(method) => {
                    if let Some(id) = msg.get("id").filter(|v| !v.is_null()) {
                        hm.push(method.to_string());
                        let resp = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": null });
                        writeln!(stdin, "{resp}").unwrap();
                        stdin.flush().unwrap();
                    }
                }
            }
        }
    };
    let created = await_id(&mut stdin, &mut stdout, 1, &mut host_methods);
    assert!(created.get("error").is_none(), "session/create failed: {created}");

    // Save, then destroy.
    let save = serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "session/save",
        "params": { "session_id": "it-destroy" }
    });
    writeln!(stdin, "{save}").unwrap();
    stdin.flush().unwrap();
    await_id(&mut stdin, &mut stdout, 2, &mut host_methods);

    let destroy = serde_json::json!({
        "jsonrpc": "2.0", "id": 3, "method": "session/destroy",
        "params": { "session_id": "it-destroy" }
    });
    writeln!(stdin, "{destroy}").unwrap();
    stdin.flush().unwrap();
    let destroy_resp = await_id(&mut stdin, &mut stdout, 3, &mut host_methods);
    assert!(destroy_resp.get("error").is_none(), "session/destroy failed: {destroy_resp}");
    assert_eq!(destroy_resp["result"]["destroyed"], true);

    // A prompt after destroy fails with "no agent".
    let prompt = serde_json::json!({
        "jsonrpc": "2.0", "id": 4, "method": "session/prompt",
        "params": { "session_id": "it-destroy", "input": [{ "type": "text", "text": "hi" }] }
    });
    writeln!(stdin, "{prompt}").unwrap();
    stdin.flush().unwrap();
    let prompt_resp = await_id(&mut stdin, &mut stdout, 4, &mut host_methods);
    assert!(
        prompt_resp.get("error").is_some(),
        "prompt after destroy must fail; got: {prompt_resp}"
    );

    // Load recovers the persisted agent; prompt works again.
    let load = serde_json::json!({
        "jsonrpc": "2.0", "id": 5, "method": "session/load",
        "params": { "session_id": "it-destroy" }
    });
    writeln!(stdin, "{load}").unwrap();
    stdin.flush().unwrap();
    let load_resp = await_id(&mut stdin, &mut stdout, 5, &mut host_methods);
    assert_eq!(load_resp["result"]["found"], true);

    let prompt2 = serde_json::json!({
        "jsonrpc": "2.0", "id": 6, "method": "session/prompt",
        "params": { "session_id": "it-destroy", "input": [{ "type": "text", "text": "again" }] }
    });
    writeln!(stdin, "{prompt2}").unwrap();
    stdin.flush().unwrap();
    let prompt2_resp = await_id(&mut stdin, &mut stdout, 6, &mut host_methods);
    assert!(prompt2_resp.get("error").is_none(), "prompt after load failed: {prompt2_resp}");

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&ws);
    let _ = std::fs::remove_dir_all(&home);
}

/// git/status — the engine runs git against the given cwd natively.
#[test]
fn git_status_reports_the_work_tree() {
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let req = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "git/status",
        "params": { "cwd": env!("CARGO_MANIFEST_DIR") }
    });
    writeln!(stdin, "{req}").unwrap();
    stdin.flush().unwrap();

    let mut buf = String::new();
    let deadline = Instant::now() + Duration::from_secs(30);
    let resp = loop {
        assert!(Instant::now() <= deadline, "timed out waiting for git/status");
        buf.clear();
        if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
            panic!("stdout closed");
        }
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
        if msg.get("id") == Some(&serde_json::json!(1)) {
            break msg;
        }
    };
    assert!(resp.get("error").is_none(), "git/status failed: {resp}");
    let result = &resp["result"];
    // CARGO_MANIFEST_DIR is inside the kimi-code git repo in dev.
    if result.get("unavailable").is_some() {
        eprintln!("git/status unavailable (expected in non-repo CI): {result}");
    } else {
        assert!(result["branch"].as_str().is_some(), "branch expected: {result}");
    }

    let _ = child.kill();
    let _ = child.wait();
}

/// The native Memory tool: the model calls Memory (write + search) and the
/// engine persists/retrieves from the home-dir markdown store. Zero host
/// round-trips.
#[test]
fn native_memory_tool_persists_and_searches() {
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    let home = std::env::temp_dir().join(format!("kimi-agent-it-mem-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&home);
    let ws = temp_workspace("placeholder.txt", "x");
    // Provider calls:
    //   0 parent step 0 -> Memory write call
    //   1 parent step 1 -> Memory search call
    //   2 parent step 2 -> final text
    let stub = spawn_sse_stub(|i| match i {
        0 => sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "call_m1", "type": "function", "function": { "name": "Memory", "arguments": "" } }] } }] }),
            serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": "{\"action\":\"write\",\"path\":\"pref\",\"scope\":\"global\",\"content\":\"# Pref\\nPrefer Rust for new tools.\"}" } }] } }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }], "usage": { "prompt_tokens": 9, "completion_tokens": 4 } }),
        ]),
        1 => sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "call_m2", "type": "function", "function": { "name": "Memory", "arguments": "" } }] } }] }),
            serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": "{\"action\":\"search\",\"query\":\"Rust\"}" } }] } }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }], "usage": { "prompt_tokens": 9, "completion_tokens": 4 } }),
        ]),
        _ => sse(&[
            serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            serde_json::json!({ "choices": [{ "delta": { "content": "memory done" }, "finish_reason": null }] }),
            serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 30, "completion_tokens": 2 } }),
        ]),
    });

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("KIMI_AGENT_HOME", &home)
        .spawn()
        .expect("spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let native_llm = serde_json::json!({
        "protocol": "openai",
        "base_url": format!("http://127.0.0.1:{}/v1", stub.port),
        "api_key": "stub",
        "model": "stub-model"
    });
    let create = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "session/create",
        "params": {
            "session_id": "it-mem", "system_prompt": "test", "model": "stub-model",
            "goal_enabled": false, "native_llm": native_llm,
            "homedir": home.to_string_lossy().to_string()
        }
    });
    writeln!(stdin, "{create}").unwrap();
    stdin.flush().unwrap();

    let mut host_methods: Vec<String> = Vec::new();
    let await_id = |stdin: &mut std::process::ChildStdin,
                        stdout: &mut BufReader<std::process::ChildStdout>,
                        want: u32,
                        hm: &mut Vec<String>|
     -> serde_json::Value {
        let mut buf = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() <= deadline, "timed out waiting for id {want}");
            buf.clear();
            if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
                panic!("stdout closed waiting for id {want}");
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
            match msg.get("method").and_then(|m| m.as_str()) {
                None => {
                    if msg.get("id") == Some(&serde_json::json!(want)) {
                        return msg;
                    }
                }
                Some("host/event") => {}
                Some(method) => {
                    if let Some(id) = msg.get("id").filter(|v| !v.is_null()) {
                        hm.push(method.to_string());
                        let resp = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": null });
                        writeln!(stdin, "{resp}").unwrap();
                        stdin.flush().unwrap();
                    }
                }
            }
        }
    };
    let created = await_id(&mut stdin, &mut stdout, 1, &mut host_methods);
    assert!(created.get("error").is_none(), "session/create failed: {created}");

    let prompt = serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "session/prompt",
        "params": { "session_id": "it-mem", "input": [{ "type": "text", "text": "remember and search" }] }
    });
    writeln!(stdin, "{prompt}").unwrap();
    stdin.flush().unwrap();
    let resp = await_id(&mut stdin, &mut stdout, 2, &mut host_methods);
    assert!(resp.get("error").is_none(), "session/prompt failed: {resp}");

    let bodies = stub.bodies.lock().unwrap();
    assert_eq!(bodies.len(), 3, "write + search + final expected, got {}", bodies.len());
    // The search step's request must contain the search RESULT fed back.
    assert!(
        bodies[2].contains("Prefer Rust for new tools"),
        "the search result must feed back to the model; body: {}",
        bodies[2]
    );
    // The memory file landed on disk.
    let mem_file = home.join("memory/global/pref.md");
    assert!(
        mem_file.exists(),
        "memory file must be written: {}",
        mem_file.display()
    );
    // Zero host round-trips.
    assert!(!host_methods.iter().any(|m| m == "host/llm_chat"), "saw: {host_methods:?}");
    assert!(!host_methods.iter().any(|m| m == "host/execute_tool"), "saw: {host_methods:?}");

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&ws);
    let _ = std::fs::remove_dir_all(&home);
}

// ── Approval-surface integration tests ──────────────────────────────────────

/// Approval surface end-to-end: a gated Write tool call in manual permission
/// mode defers into the pending-approval store, `session/approval_list` sees
/// it, and `session/approval_resolve` wakes the waiting tool call so the turn
/// completes. The host deliberately does NOT answer `host/authorize_tool_execution`
/// — the decision must come from the approval RPC channel.
#[test]
fn approval_rpc_resolves_pending_write() {
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping test: kimi-agent binary not built.");
            return;
        }
    };
    let ws = tempfile::tempdir().expect("tempdir");
    let home = ws.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    // Canonicalize so the Write target and the toolset sandbox root share the
    // same (long-form) path spelling — 8.3 short names break lexical
    // containment checks on Windows.
    let home = std::fs::canonicalize(&home).unwrap();

    let mut env: std::collections::HashMap<&str, String> = std::collections::HashMap::new();
    env.insert("KIMI_PERMISSION_MODE", "manual".to_string());
    // Isolate from any ambient config (project + user level) so the
    // host-callback turn uses the host LLM proxy rather than a self-read
    // native LLM.
    env.insert("KIMI_AGENT_HOME", home.to_string_lossy().into_owned());
    env.insert(
        "KIMI_CONFIG_PATH",
        std::env::temp_dir().join("kimi-acp-nonexistent-config.toml").to_string_lossy().into_owned(),
    );
    env.insert(
        "USERPROFILE",
        std::env::temp_dir().join("kimi-acp-empty-profile").to_string_lossy().into_owned(),
    );
    env.insert(
        "HOME",
        std::env::temp_dir().join("kimi-acp-empty-home").to_string_lossy().into_owned(),
    );
    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .envs(env)
        .spawn()
        .expect("failed to spawn kimi-agent");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));
    let mut llm_step = 0u32;
    let mut approval_seen = false;
    let mut approve_resolved = false;

    let run_turn = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "agent/run_turn",
        "params": {
            "turn_id": "approval-turn",
            "system_prompt": "You are a test assistant.",
            "model_name": "test-model",
            "messages": [{"role": "user", "content": "write a file"}],
            "tools": [{
                "name": "Write", "description": "Write a file",
                "input_schema": {"type": "object", "properties": {
                    "path": {"type": "string"}, "content": {"type": "string"}
                }}
            }],
            "max_steps": 5,
            "native_tools": true,
            "workspace_root": home.to_str().unwrap()
        }
    });
    writeln!(stdin, "{run_turn}").unwrap();
    stdin.flush().unwrap();

    let mut buf = String::new();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        assert!(Instant::now() <= deadline, "timed out in approval loop");
        buf.clear();
        if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
            panic!("stdout closed in approval loop");
        }
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(buf.trim()) else { continue };
        let method_for_debug = msg.get("method").and_then(|m| m.as_str()).unwrap_or("<response>");
        let id_for_debug = msg.get("id").cloned().unwrap_or(serde_json::Value::Null);
        eprintln!("[approval-test] << {method_for_debug} id={id_for_debug} {:?}", msg.get("params"));
        let Some(method) = msg.get("method").and_then(|m| m.as_str()) else {
            if msg.get("id") == Some(&serde_json::json!(1)) {
                break;
            }
            if msg.get("id") == Some(&serde_json::json!(100)) {
                // Response to our approval_list request: assert one pending
                // approval and resolve it over the RPC channel.
                let pending = msg["result"]["pending"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                assert_eq!(pending.len(), 1, "expected 1 pending approval, got: {msg}");
                let approval_id = pending[0]["id"].as_str().unwrap().to_string();
                let resolve_req = serde_json::json!({
                    "jsonrpc": "2.0", "id": 101, "method": "session/approval_resolve",
                    "params": {"id": approval_id, "decision": "allow"}
                });
                writeln!(stdin, "{resolve_req}").unwrap();
                stdin.flush().unwrap();
            } else if msg.get("id") == Some(&serde_json::json!(101)) {
                assert_eq!(msg["result"]["resolved"], true, "resolve failed: {msg}");
                approve_resolved = true;
            }
            continue;
        };
        // host/event is a notification (no id): handle it before the id gate.
        if method == "host/event" {
            let event_type = msg["params"]["type"].as_str().unwrap_or("");
            if event_type == "session.approval.requested" {
                approval_seen = true;
                // List pending approvals, then resolve the first one.
                let list_req = serde_json::json!({
                    "jsonrpc": "2.0", "id": 100, "method": "session/approval_list", "params": {}
                });
                writeln!(stdin, "{list_req}").unwrap();
                stdin.flush().unwrap();
            }
            continue;
        }
        let Some(id) = msg.get("id").filter(|v| !v.is_null()) else { continue };
        let req_id = id.clone();
        match method {
            "host/llm_chat" => {
                let step = llm_step;
                llm_step += 1;
                let tool_calls = if step == 0 {
                    serde_json::json!([{
                        "id": "call-write",
                        "name": "Write",
                        "arguments": {"path": home.join("out.txt").to_str().unwrap(), "content": "approved"}
                    }])
                } else {
                    serde_json::json!([])
                };
                let finish = if step == 0 { "tool_calls" } else { "stop" };
                let resp = serde_json::json!({
                    "jsonrpc": "2.0", "id": req_id, "result": {
                        "tool_calls": tool_calls,
                        "finish_reason": finish,
                        "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}
                    }
                });
                writeln!(stdin, "{resp}").unwrap();
                stdin.flush().unwrap();
            }
            "host/authorize_tool_execution" => {
                // Deliberately NOT answered: the decision must come from the
                // approval RPC channel, so the waiting tool call stays parked
                // until session/approval_resolve feeds it.
            }
            "host/prepare_tool_execution" | "host/finalize_tool_result" => {
                // Answer null (allow unchanged / use as-is) so the lifecycle
                // proceeds to the authorize gate.
                let resp = serde_json::json!({ "jsonrpc": "2.0", "id": req_id, "result": null });
                writeln!(stdin, "{resp}").unwrap();
                stdin.flush().unwrap();
            }
            "session/approval_list" | "session/approval_resolve" => {
                // Responses to our own RPCs carry no method — they are handled
                // in the no-method branch above. Requests here are impossible
                // (we are the only client), so this arm is defensive only.
                let resp = serde_json::json!({ "jsonrpc": "2.0", "id": req_id, "result": null });
                writeln!(stdin, "{resp}").unwrap();
                stdin.flush().unwrap();
            }
            _ => {
                // Unknown host request — answer null to keep the engine moving.
                let resp = serde_json::json!({ "jsonrpc": "2.0", "id": req_id, "result": null });
                writeln!(stdin, "{resp}").unwrap();
                stdin.flush().unwrap();
            }
        }
    }

    assert!(approval_seen, "session.approval.requested event must fire");
    assert!(approve_resolved, "session/approval_resolve must succeed");
    // The approved write landed on disk (native execution after the gate).
    let out = home.join("out.txt");
    assert!(
        out.exists(),
        "approved Write must execute; missing {}",
        out.display()
    );
    let content = std::fs::read_to_string(&out).unwrap_or_default();
    assert_eq!(content, "approved");

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&ws);
}

// ---------------------------------------------------------------------------
// P2-2 (RUST_MIGRATION_PLAN.non-agent.md): zero-host full chain — native LLM,
// native Read tool, persisted session, cross-process resume. Neither process
// may reach the host for the LLM or tool execution.
// ---------------------------------------------------------------------------

fn spawn_engine(
    binary: &std::path::Path,
    home: &std::path::Path,
) -> (
    std::process::Child,
    std::process::ChildStdin,
    BufReader<std::process::ChildStdout>,
) {
    let mut child = Command::new(binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("KIMI_AGENT_HOME", home)
        .spawn()
        .expect("spawn kimi-agent");
    let stdin = child.stdin.take().expect("stdin");
    let stdout = BufReader::new(child.stdout.take().expect("stdout"));
    (child, stdin, stdout)
}

/// Send one RPC request and read until its response. Host-bound methods
/// (request/response round trips) are recorded and answered with `null` so the
/// engine can continue; `host/event` notifications are skipped.
fn rpc_call(
    stdin: &mut std::process::ChildStdin,
    stdout: &mut BufReader<std::process::ChildStdout>,
    id: u32,
    method: &str,
    params: serde_json::Value,
    host_methods: &mut Vec<String>,
) -> serde_json::Value {
    let req = serde_json::json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
    writeln!(stdin, "{req}").unwrap();
    stdin.flush().unwrap();
    let mut buf = String::new();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        assert!(Instant::now() <= deadline, "timed out on {method}");
        buf.clear();
        if stdout.read_line(&mut buf).unwrap_or(0) == 0 {
            panic!("stdout closed during {method}");
        }
        let trimmed = buf.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        match msg.get("method").and_then(|m| m.as_str()) {
            None => {
                if msg.get("id") == Some(&serde_json::json!(id)) {
                    return msg;
                }
            }
            // Fire-and-forget notifications carry no id: skip.
            Some("host/event") => {}
            Some(method_name) => {
                if let Some(rid) = msg.get("id").filter(|v| !v.is_null()) {
                    host_methods.push(method_name.to_string());
                    let resp = serde_json::json!({"jsonrpc": "2.0", "id": rid, "result": null});
                    writeln!(stdin, "{resp}").unwrap();
                    stdin.flush().unwrap();
                }
            }
        }
    }
}

#[test]
fn native_full_chain_self_served_persists_and_resumes() {
    let binary = match find_binary() {
        Some(b) => b,
        None => {
            eprintln!("Skipping: kimi-agent binary not built.");
            return;
        }
    };
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let pid = std::process::id();
    let home = std::env::temp_dir().join(format!("kimi-agent-it-fullchain-{pid}-{n}"));
    std::fs::create_dir_all(&home).expect("create home");
    let ws = temp_workspace("secret.txt", "NATIVE-CHAIN-BODY-88");

    // Turn 1 asks the model for a Read tool call; turn 2 completes the text.
    let stub = spawn_sse_stub(|i| {
        if i == 0 {
            sse(&[
                serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
                serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "call_1", "type": "function", "function": { "name": "Read", "arguments": "" } }] } }] }),
                serde_json::json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": "{\"path\":\"secret.txt\"}" } }] } }] }),
                serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }], "usage": { "prompt_tokens": 9, "completion_tokens": 4 } }),
            ])
        } else {
            sse(&[
                serde_json::json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
                serde_json::json!({ "choices": [{ "delta": { "content": "CHAIN-DONE" }, "finish_reason": null }] }),
                serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 20, "completion_tokens": 1 } }),
            ])
        }
    });

    let native_llm = serde_json::json!({
        "protocol": "openai",
        "base_url": format!("http://127.0.0.1:{}/v1", stub.port),
        "api_key": "stub",
        "model": "stub-model"
    });

    // ── Process 1: create → prompt (native LLM + native Read) → save ──
    let (mut child1, mut stdin1, mut stdout1) = spawn_engine(&binary, &home);
    let mut host_methods: Vec<String> = Vec::new();
    let create = rpc_call(
        &mut stdin1,
        &mut stdout1,
        1,
        "session/create",
        serde_json::json!({
            "session_id": "it-fullchain",
            "homedir": ws.to_string_lossy(),
            "system_prompt": "test",
            "model": "stub-model",
            "goal_enabled": false,
            "native_llm": native_llm,
            "native_tools": true
        }),
        &mut host_methods,
    );
    assert!(create.get("error").is_none(), "create failed: {create}");

    let prompt = rpc_call(
        &mut stdin1,
        &mut stdout1,
        2,
        "session/prompt",
        serde_json::json!({
            "session_id": "it-fullchain",
            "input": [{"type": "text", "text": "read secret.txt"}]
        }),
        &mut host_methods,
    );
    assert!(prompt.get("error").is_none(), "prompt failed: {prompt}");
    assert_eq!(prompt["result"]["stop_reason"], "EndTurn", "got: {prompt}");
    assert_eq!(stub.bodies.lock().unwrap().len(), 2, "provider called twice");

    let save = rpc_call(
        &mut stdin1,
        &mut stdout1,
        3,
        "session/save",
        serde_json::json!({"session_id": "it-fullchain"}),
        &mut host_methods,
    );
    assert_eq!(save["result"]["ok"], true, "got: {save}");

    assert!(
        !host_methods.iter().any(|m| m == "host/llm_chat" || m == "host/execute_tool"),
        "process 1 must be zero-host for LLM + tools, saw: {host_methods:?}"
    );
    drop(stdin1);
    let _ = child1.kill();
    let _ = child1.wait();

    // ── Process 2: resume — recreate the same id, load, read context ──
    let (mut child2, mut stdin2, mut stdout2) = spawn_engine(&binary, &home);
    let mut host_methods2: Vec<String> = Vec::new();
    let recreate = rpc_call(
        &mut stdin2,
        &mut stdout2,
        1,
        "session/create",
        serde_json::json!({
            "session_id": "it-fullchain",
            "homedir": ws.to_string_lossy(),
            "system_prompt": "test",
            "model": "stub-model",
            "goal_enabled": false,
            "native_llm": native_llm,
            "native_tools": true
        }),
        &mut host_methods2,
    );
    assert!(recreate.get("error").is_none(), "recreate failed: {recreate}");

    let loaded = rpc_call(
        &mut stdin2,
        &mut stdout2,
        2,
        "session/load",
        serde_json::json!({"session_id": "it-fullchain"}),
        &mut host_methods2,
    );
    assert_eq!(loaded["result"]["found"], true, "got: {loaded}");

    let ctx = rpc_call(
        &mut stdin2,
        &mut stdout2,
        3,
        "session/get_context",
        serde_json::json!({"session_id": "it-fullchain"}),
        &mut host_methods2,
    );
    let ctx_text = serde_json::to_string(&ctx["result"]).unwrap_or_default();
    assert!(
        ctx_text.contains("read secret.txt"),
        "resumed context must include the user prompt; got: {ctx}"
    );
    assert!(
        ctx_text.contains("NATIVE-CHAIN-BODY-88"),
        "resumed context must include the native tool result; got: {ctx}"
    );

    drop(stdin2);
    let _ = child2.kill();
    let _ = child2.wait();
    let _ = std::fs::remove_dir_all(&ws);
}
