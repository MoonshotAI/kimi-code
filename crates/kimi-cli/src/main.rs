//! Kimi Code command dispatcher — the `kimi` binary, ported from
//! `apps/kimi-code/src/cli`. Stage C slice: `kimi -p <prompt>` (non-interactive
//! run), `kimi health`, `kimi export`. More subcommands (doctor/login/web…)
//! land as the migration progresses.

use base64::Engine;
use clap::{Parser, Subcommand};
use std::io::IsTerminal;

#[derive(Parser)]
#[command(name = "kimi", version, about = "Kimi Code CLI (Rust-first)")]
struct Cli {
    /// Drive a separate server process (`kimi-server-serve`) over stdio
    /// instead of an embedded in-process server.
    #[arg(long, global = true)]
    server: Option<String>,
    /// Resume an existing session (TS `-r/--resume` parity): with no
    /// subcommand, enters the interactive TUI bound to that session.
    #[arg(short = 'r', long, global = true)]
    resume: Option<String>,
    #[command(subcommand)]
    command: Option<Commands>,
}

/// Build the protocol client: an embedded in-process server by default, or a
/// spawned server process when `--server <bin>` is given.
fn connect(server: &Option<String>) -> anyhow::Result<kimi_server_client::AppServerClient> {
    match server {
        Some(bin) => Ok(kimi_server_client::AppServerClient::Remote(Box::new(
            kimi_server_client::stdio_client::StdioClient::spawn(bin)?,
        ))),
        None => {
            let server = kimi_server::Server::build()?;
            Ok(kimi_server_client::AppServerClient::InProcess(
                kimi_server::in_process::spawn(server.processor),
            ))
        }
    }
}

/// High-level harness over the same engine choice (embedded or Remote).
fn connect_harness(server: &Option<String>) -> anyhow::Result<kimi_sdk::Harness> {
    match server {
        Some(bin) => kimi_sdk::Harness::remote(bin),
        None => kimi_sdk::Harness::embedded(),
    }
}

/// The most recently updated persisted session id (session list is ordered
/// by `updated_at DESC`), if any.
async fn latest_session_id(client: &mut kimi_server_client::AppServerClient) -> Option<String> {
    let body = client
        .call(kimi_protocol::methods::SESSION_LIST, serde_json::json!({ "limit": 1 }))
        .await;
    body["result"]["sessions"]
        .as_array()
        .and_then(|sessions| sessions.first())
        .and_then(|session| session["id"].as_str())
        .map(str::to_string)
}

/// Best-effort open a URL in the platform browser (Windows `start`, macOS
/// `open`, Linux `xdg-open`). Never fails the caller — the printed URL + code
/// remain the manual fallback.
fn open_browser(url: &str) {
    let (program, args) = if cfg!(windows) {
        ("cmd", vec!["/c", "start", "", url])
    } else if cfg!(target_os = "macos") {
        ("open", vec![url])
    } else {
        ("xdg-open", vec![url])
    };
    let _ = std::process::Command::new(program)
        .args(&args)
        .spawn()
        .map(|_| ());
}

/// Run the kimi OAuth device-code login flow and persist the granted token
/// as `providers.kimi.apiKey` (shared by `kimi login` and `kimi acp --login`).
async fn run_kimi_login(
    server: &Option<String>,
    oauth_host: Option<String>,
    max_polls: u32,
) -> anyhow::Result<()> {
    let mut config = kimi_oauth::OAuthFlowConfig::kimi();
    if let Some(host) = oauth_host {
        config.oauth_host = host;
    }
    // Request a device authorization and show the user how to approve.
    let auth = kimi_oauth::request_device_authorization(&config).await.map_err(|e| {
        anyhow::anyhow!("device authorization failed: {e}")
    })?;
    println!("Open: {}", auth.verification_uri);
    println!("Enter code: {}", auth.user_code);
    if let Some(complete) = auth.verification_uri_complete {
        println!("(or open: {complete})");
        // Best effort: open the deep link so the user can approve directly.
        open_browser(&complete);
    } else {
        open_browser(&auth.verification_uri);
    }
    // Poll until the user approves (or the code expires/denies).
    let interval = auth.interval.unwrap_or(5).max(1);
    for _ in 0..max_polls {
        tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
        match kimi_oauth::poll_device_token(&config, &auth.device_code).await.map_err(|e| {
            anyhow::anyhow!("token poll failed: {e}")
        })? {
            kimi_oauth::DevicePollResult::Success { access_token, refresh_token, .. } => {
                println!("logged in — storing kimi provider key into config");
                // Persist the token so the native engine path can use it
                // (config `providers.kimi.apiKey`).
                let client = connect(server)?;
                let body = client
                    .call(
                        kimi_protocol::methods::CONFIG_SET,
                        serde_json::json!({
                            "patch": { "providers": { "kimi": { "apiKey": access_token } } }
                        }),
                    )
                    .await;
                if let Some(error) = body.get("error") {
                    eprintln!(
                        "warning: token granted but config write failed: {}",
                        error["message"].as_str().unwrap_or("unknown")
                    );
                }
                if let Some(rt) = refresh_token {
                    eprintln!("refresh token: {rt}");
                }
                return Ok(());
            }
            kimi_oauth::DevicePollResult::Pending => {}
            kimi_oauth::DevicePollResult::Expired => {
                anyhow::bail!("device code expired — run `kimi login` again");
            }
            kimi_oauth::DevicePollResult::Denied => {
                anyhow::bail!("login denied");
            }
        }
    }
    anyhow::bail!("timed out waiting for approval");
}

#[derive(Subcommand)]
enum Commands {
    /// Run one prompt non-interactively.
    #[command(name = "print", alias = "-p")]
    Print {
        /// The prompt to run.
        prompt: String,
        /// Print engine events (progress/deltas) as they arrive.
        #[arg(long)]
        verbose: bool,
        /// Print the raw RPC result JSON instead of the rendered transcript.
        #[arg(long)]
        json: bool,
        /// Create a goal on the session before prompting (goal mode).
        #[arg(long)]
        goal: Option<String>,
        /// Set the session model before prompting.
        #[arg(long)]
        model: Option<String>,
        /// Enable plan mode before prompting.
        #[arg(long)]
        plan: bool,
        /// Resume the most recently updated session instead of a fresh one.
        #[arg(long = "continue")]
        continue_: bool,
    },
    /// List persisted sessions.
    Sessions {
        /// Max sessions to list.
        #[arg(default_value_t = 50)]
        limit: u32,
        /// Print the raw session list JSON instead of the table.
        #[arg(long)]
        json: bool,
    },
    /// Resume a session and run a prompt on it.
    Resume {
        /// Session id to resume.
        session_id: String,
        /// The prompt to run.
        prompt: String,
        /// Print engine events (progress/deltas) as they arrive.
        #[arg(long)]
        verbose: bool,
        /// Print the raw RPC result JSON instead of the rendered transcript.
        #[arg(long)]
        json: bool,
        /// Create a goal on the session before prompting (goal mode).
        #[arg(long)]
        goal: Option<String>,
        /// Set the session model before prompting.
        #[arg(long)]
        model: Option<String>,
        /// Enable plan mode before prompting.
        #[arg(long)]
        plan: bool,
    },
    /// Show the engine config (model/provider); with `--set`, write a value.
    Config {
        /// Set a config value (repeatable), e.g. `--set defaultModel=kimi-k2`
        /// or `--set providers.anthropic.apiKey=sk-…`. Values are strings.
        #[arg(long = "set", value_name = "KEY=VALUE")]
        set: Vec<String>,
        /// Delete a config section entry (repeatable), e.g.
        /// `--delete providers.kimi` or `--delete models.kimi-k2`. Only
        /// section-level entries (`providers.<id>`, `models.<alias>`) can be
        /// removed — the engine's null-delete path is section-scoped.
        #[arg(long = "delete", value_name = "SECTION.KEY")]
        delete: Vec<String>,
    },
    /// Environment + config diagnostics.
    Doctor {
        /// Validate a specific config.toml file (TS `kimi doctor config`
        /// parity); without this, the default full checks run.
        #[command(subcommand)]
        target: Option<DoctorTarget>,
    },
    /// Engine health check.
    Health,
    /// Export a session as a ZIP archive (`session/export` parity).
    Export {
        /// Session id to export (defaults to the most recent session).
        session_id: Option<String>,
        /// Output zip path (defaults to `<session_id>.zip` in the cwd).
        #[arg(short, long)]
        output: Option<String>,
        /// Pick the most recent session without confirmation.
        #[arg(short, long)]
        yes: bool,
    },
    /// Interactive chat loop (stage-D prototype: plain text, no ratatui).
    Chat {
        /// Session id to reuse (defaults to a fresh `chat-<pid>` one).
        #[arg(short, long)]
        session: Option<String>,
        /// Resume the most recently updated session instead of a fresh one.
        #[arg(long = "continue")]
        continue_: bool,
        /// Set the session model at startup.
        #[arg(long)]
        model: Option<String>,
    },
    /// Serve the Agent Client Protocol (ACP) over stdio.
    Acp {
        /// Run the kimi OAuth login flow instead of serving (TS parity).
        #[arg(long)]
        login: bool,
    },
    /// Generate a shell completion script.
    Completions {
        /// Target shell.
        shell: clap_complete::Shell,
    },
    /// Provider management from the models.dev catalog.
    Provider {
        #[command(subcommand)]
        cmd: ProviderCmd,
    },
    /// Log in via the kimi OAuth device flow.
    Login {
        /// Override the OAuth host (defaults to the kimi production server).
        #[arg(long)]
        oauth_host: Option<String>,
        /// Max poll attempts (default 60, ~5s apart).
        #[arg(long, default_value_t = 60)]
        max_polls: u32,
    },
    /// Remove the kimi provider credentials from the engine config.
    Logout,
    /// Update the CLI to the latest version (managed by the distribution).
    Upgrade,
    /// Launch the web UI (frontend ships with the TS distribution).
    Web,
    /// Launch the visualization frontend (ships with the TS distribution).
    Vis,
}

/// Sub-commands of `kimi provider`.
#[derive(Subcommand)]
enum ProviderCmd {
    /// List providers from the model catalog.
    List {
        /// Print the raw catalog JSON.
        #[arg(long)]
        json: bool,
    },
    /// Search providers/models by keyword.
    Search {
        /// Keyword to match against provider and model names.
        query: String,
    },
    /// Add a provider from the catalog to the engine config.
    Add {
        /// Catalog provider id (e.g. `openai`, `anthropic`).
        id: String,
        /// API key (falls back to the provider's env var when absent).
        #[arg(long)]
        api_key: Option<String>,
        /// Set this model as the engine default (must be a configured alias).
        #[arg(long)]
        default_model: Option<String>,
    },
    /// Remove a provider from the engine config.
    Remove {
        /// Provider id (e.g. `openai`, `anthropic`, `kimi`).
        id: String,
    },
}

/// Sub-targets of `kimi doctor`.
#[derive(Subcommand)]
enum DoctorTarget {
    /// Validate a specific config.toml file.
    Config {
        /// Path to the config file (defaults to the first found).
        #[arg(value_name = "path")]
        path: Option<String>,
    },
    /// Validate a specific tui.toml file (syntax only — TS `doctor tui`
    /// parity; the engine has no theme engine yet).
    Tui {
        /// Path to the tui.toml file (defaults to the first found).
        #[arg(value_name = "path")]
        path: Option<String>,
    },
}

/// The well-known `tui.toml` path: `$KIMI_CODE_HOME/tui.toml`, otherwise
/// `~/.kimi-code/tui.toml` (Windows: `%USERPROFILE%\.kimi-code\tui.toml`).
fn tui_config_path() -> Option<std::path::PathBuf> {
    match std::env::var("KIMI_CODE_HOME") {
        Ok(dir) => Some(std::path::PathBuf::from(dir).join("tui.toml")),
        Err(_) => std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .ok()
            .map(|home| std::path::PathBuf::from(home).join(".kimi-code").join("tui.toml")),
    }
}

/// Connect the protocol client and — when `capture` is set — start the event
/// renderer (embedded EventBus / Remote captured stderr), so progress lines
/// appear on stderr while the prompt runs. Returns the client and the renderer
/// task handle (abort it after the prompt completes).
fn connect_with_renderer(
    server: &Option<String>,
    capture: bool,
) -> anyhow::Result<(
    kimi_server_client::AppServerClient,
    Option<tokio::task::JoinHandle<()>>,
)> {
    if !capture {
        return Ok((connect(server)?, None));
    }
    let (client, source) = match server {
        Some(bin) => {
            let (client, stderr) =
                kimi_server_client::stdio_client::StdioClient::spawn_captured(bin)?;
            (
                kimi_server_client::AppServerClient::Remote(Box::new(client)),
                Some(kimi_ui::EventSource::from_lines(stderr)),
            )
        }
        None => {
            let embedded = kimi_server::Server::build()?;
            (
                kimi_server_client::AppServerClient::InProcess(
                    kimi_server::in_process::spawn(embedded.processor),
                ),
                Some(kimi_ui::EventSource::from_bus(embedded.state.subscribe_events())),
            )
        }
    };
    let renderer = tokio::spawn(async move {
        use std::io::Write;
        let mut source = source.expect("capture path attaches a source");
        let mut printed = 0usize;
        // Live assistant text rolls on a TTY (codex-style streaming); piped
        // stderr stays clean (the final transcript still lands on stdout).
        let tty = std::io::stderr().is_terminal();
        while let Some(event) = source.next().await {
            match cli_render(&event) {
                CliRender::Stream(delta) => {
                    if tty {
                        eprint!("{delta}");
                        let _ = std::io::stderr().flush();
                    }
                }
                CliRender::StreamThink(delta) => {
                    if tty {
                        // Dimmed ANSI: reasoning reads lighter than the answer.
                        eprint!("\x1b[2m{delta}\x1b[0m");
                        let _ = std::io::stderr().flush();
                    }
                }
                CliRender::Line(line) => {
                    if event.get("type").and_then(|t| t.as_str())
                        == Some("session.approval.requested")
                    {
                        eprintln!("⚠ {line} — /approvals, /approve <id>");
                    } else if tty {
                        // Close any mid-line streaming text first.
                        eprintln!("\r{line}");
                    } else {
                        eprintln!("{line}");
                    }
                    printed += 1;
                    if printed > 64 {
                        break; // bound verbose output
                    }
                }
                CliRender::Skip => {}
            }
        }
    });
    Ok((client, Some(renderer)))
}

/// The CLI's per-event render decision: live text deltas stream on a TTY,
/// known event types render as progress lines, everything else stays silent.
#[derive(Debug, Clone, PartialEq, Eq)]
enum CliRender {
    /// Live assistant text delta (llm.delta text parts).
    Stream(String),
    /// Live model reasoning delta (llm.delta think parts) — dimmed on a TTY.
    StreamThink(String),
    /// One progress line.
    Line(String),
    /// Not rendered.
    Skip,
}

fn cli_render(event: &serde_json::Value) -> CliRender {
    if event.get("type").and_then(|t| t.as_str()) == Some("llm.delta") {
        if let Some(think) = kimi_ui::stream_thinking(event) {
            return CliRender::StreamThink(think.to_string());
        }
        return match kimi_ui::stream_delta(event) {
            Some(delta) => CliRender::Stream(delta.to_string()),
            None => CliRender::Skip,
        };
    }
    match kimi_ui::render_event(event) {
        Some(line) => CliRender::Line(line),
        None => CliRender::Skip,
    }
}

#[cfg(test)]
mod cli_render_tests {
    use super::{cli_render, CliRender};

    #[test]
    fn delta_streams_and_lines_render() {
        let delta = serde_json::json!({ "type": "llm.delta", "part": { "type": "text", "text": "hi" } });
        assert_eq!(cli_render(&delta), CliRender::Stream("hi".to_string()));
        // Thinking deltas stream dimmed; unknown events stay silent.
        let think = serde_json::json!({ "type": "llm.delta", "part": { "type": "think", "think": "hmm" } });
        assert_eq!(cli_render(&think), CliRender::StreamThink("hmm".to_string()));
        assert_eq!(cli_render(&serde_json::json!({ "type": "mystery.thing" })), CliRender::Skip);
        // Known progress types render as lines.
        let turn = serde_json::json!({ "type": "session.turn.started", "session_id": "s", "turn_id": 1 });
        assert_eq!(
            cli_render(&turn),
            CliRender::Line("turn 1 started (session s)".to_string())
        );
    }
}

/// Outcome of a chat slash command.
enum ChatCommand {
    /// Leave the REPL (e.g. `/quit`).
    Done,
    /// Handled; continue the loop.
    Handled,
    /// Handled but failed; print the message and continue.
    Error(String),
}

/// Dispatch chat slash commands (offline-safe — none triggers the LLM).
async fn handle_chat_command(
    text: &str,
    client: &mut kimi_server_client::AppServerClient,
    session_id: &mut String,
) -> ChatCommand {
    let (cmd, rest) = match text.split_once(' ') {
        Some((c, r)) => (c, r.trim()),
        None => (text, ""),
    };
    match cmd {
        "/quit" | "/exit" => ChatCommand::Done,
        "/help" => {
            println!("/help        this list");
            println!("/quit        exit the chat");
            println!("/resume <id> switch to (and resume) another session");
            println!("/model <id>  set the session model");
            println!("/models      list configured model aliases");
            println!("/status      session status snapshot");
            println!("/config      show the engine config");
            println!("/info        show version and session info");
            println!("/skills      list registered skills");
            println!("/usage       token usage");
            println!("/clear       clear the session context");
            println!("/compact     compact the session context");
            println!("/export      export the session as <session_id>.zip");
            println!("/archive     archive the session (kept on disk, marked archived)");
            println!("/sessions    list persisted sessions");
            println!("/undo        undo the last turn");
            println!("/fork <id>   fork this session under a new id");
            println!("/import <t>  import prior conversation text");
            println!("/steer <t>   steer the running turn");
            println!("/approvals   list pending tool approvals");
            println!("/approve <id> allow a pending approval");
            println!("/deny <id>   deny a pending approval");
            println!("/goal <obj>  create a goal on the session");
            println!("/goal-status show the active goal");
            println!("/goal-pause  pause the active goal");
            println!("/goal-resume resume the active goal");
            println!("/goal-cancel cancel the active goal");
            println!("/plan on|off toggle plan mode");
            println!("/swarm on|off toggle swarm mode");
            println!("/thinking <e> set thinking effort (low/medium/high)");
            ChatCommand::Handled
        }
        "/resume" => {
            if rest.is_empty() {
                return ChatCommand::Error("usage: /resume <session-id>".into());
            }
            let body = client
                .call(
                    kimi_protocol::methods::SESSION_CREATE,
                    serde_json::json!({ "session_id": rest }),
                )
                .await;
            if let Some(error) = body.get("error") {
                return ChatCommand::Error(error["message"].as_str().unwrap_or("unknown").into());
            }
            // Restore the persisted state of the resumed session (create
            // rebuilds a fresh agent; load re-applies context + goal).
            let _ = client
                .call(
                    kimi_protocol::methods::SESSION_LOAD,
                    serde_json::json!({ "session_id": rest }),
                )
                .await;
            *session_id = rest.to_string();
            println!("switched to session {session_id}");
            ChatCommand::Handled
        }
        "/model" => {
            if rest.is_empty() {
                return ChatCommand::Error("usage: /model <model-id>".into());
            }
            let body = client
                .call(
                    kimi_protocol::methods::SESSION_SET_MODEL,
                    serde_json::json!({ "session_id": *session_id, "model": rest }),
                )
                .await;
            if let Some(error) = body.get("error") {
                return ChatCommand::Error(error["message"].as_str().unwrap_or("unknown").into());
            }
            println!("model set to {rest}");
            ChatCommand::Handled
        }
        "/models" => {
            // List the configured model aliases + default (from config).
            let body = client.call(kimi_protocol::methods::CONFIG_GET, serde_json::Value::Null).await;
            if let Some(error) = body.get("error") {
                return ChatCommand::Error(error["message"].as_str().unwrap_or("unknown").into());
            }
            let config = &body["result"];
            let default_model = config["defaultModel"].as_str().unwrap_or("");
            let models = config["models"].as_object().cloned().unwrap_or_default();
            if models.is_empty() {
                println!("no model aliases configured (default: {default_model})");
            }
            for (alias, _) in models {
                println!("{alias}");
            }
            if !default_model.is_empty() {
                println!("default: {default_model}");
            }
            ChatCommand::Handled
        }
        "/status" => {
            let body = client
                .call(
                    kimi_protocol::methods::SESSION_GET_STATUS,
                    serde_json::json!({ "session_id": *session_id }),
                )
                .await;
            if let Some(error) = body.get("error") {
                return ChatCommand::Error(error["message"].as_str().unwrap_or("unknown").into());
            }
            println!(
                "{}",
                serde_json::to_string_pretty(&body["result"]).unwrap_or_default()
            );
            ChatCommand::Handled
        }
        "/config" => {
            let body = client.config_get().await;
            if let Some(error) = body.get("error") {
                return ChatCommand::Error(error["message"].as_str().unwrap_or("unknown").into());
            }
            println!("{}", serde_json::to_string_pretty(&body["result"]).unwrap_or_default());
            ChatCommand::Handled
        }
        "/info" => {
            let body = client.call("agent/version", serde_json::Value::Null).await;
            if let Some(error) = body.get("error") {
                return ChatCommand::Error(error["message"].as_str().unwrap_or("unknown").into());
            }
            println!(
                "kimi {} — session {}",
                body["result"]["version"].as_str().unwrap_or("?"),
                session_id
            );
            ChatCommand::Handled
        }
        "/skills" => {
            let body = client
                .call(
                    kimi_protocol::methods::SESSION_LIST_SKILLS,
                    serde_json::json!({ "session_id": *session_id }),
                )
                .await;
            if let Some(error) = body.get("error") {
                return ChatCommand::Error(error["message"].as_str().unwrap_or("unknown").into());
            }
            let names: Vec<&str> = body["result"]["skills"]
                .as_array()
                .map(|arr| arr.iter().filter_map(|s| s["name"].as_str()).collect())
                .unwrap_or_default();
            if names.is_empty() {
                println!("no skills registered");
            } else {
                println!("skills: {}", names.join(", "));
            }
            ChatCommand::Handled
        }
        "/usage" => {
            let body = client
                .call(
                    kimi_protocol::methods::SESSION_GET_USAGE,
                    serde_json::json!({ "session_id": *session_id }),
                )
                .await;
            if let Some(error) = body.get("error") {
                return ChatCommand::Error(error["message"].as_str().unwrap_or("unknown").into());
            }
            println!("{}", serde_json::to_string_pretty(&body["result"]).unwrap_or_default());
            ChatCommand::Handled
        }
        "/clear" => {
            let body = client
                .call(
                    kimi_protocol::methods::SESSION_CLEAR_CONTEXT,
                    serde_json::json!({ "session_id": *session_id }),
                )
                .await;
            if let Some(error) = body.get("error") {
                return ChatCommand::Error(error["message"].as_str().unwrap_or("unknown").into());
            }
            println!("context cleared");
            ChatCommand::Handled
        }
        "/compact" => {
            let body = client
                .call(
                    kimi_protocol::methods::SESSION_COMPACT,
                    serde_json::json!({ "session_id": *session_id }),
                )
                .await;
            if let Some(error) = body.get("error") {
                return ChatCommand::Error(error["message"].as_str().unwrap_or("unknown").into());
            }
            println!("context compacted");
            ChatCommand::Handled
        }
        "/export" => {
            let path = if rest.is_empty() {
                format!("{session_id}.zip")
            } else {
                rest.to_string()
            };
            let body = client
                .call(
                    kimi_protocol::methods::SESSION_EXPORT,
                    serde_json::json!({ "session_id": *session_id }),
                )
                .await;
            if let Some(error) = body.get("error") {
                return ChatCommand::Error(error["message"].as_str().unwrap_or("unknown").into());
            }
            let b64 = match body["result"]["zip_base64"].as_str() {
                Some(s) => s,
                None => return ChatCommand::Error("export returned no zip_base64".into()),
            };
            let bytes = match base64::engine::general_purpose::STANDARD.decode(b64) {
                Ok(bytes) => bytes,
                Err(e) => return ChatCommand::Error(format!("zip_base64 decode failed: {e}")),
            };
            if let Err(e) = std::fs::write(&path, &bytes) {
                return ChatCommand::Error(format!("write {path}: {e}"));
            }
            println!("exported to {path}");
            ChatCommand::Handled
        }
        "/archive" => {
            let body = client
                .call(
                    kimi_protocol::methods::SESSION_ARCHIVE,
                    serde_json::json!({ "session_id": *session_id }),
                )
                .await;
            if let Some(error) = body.get("error") {
                return ChatCommand::Error(error["message"].as_str().unwrap_or("unknown").into());
            }
            if body["result"]["archived"].as_bool().unwrap_or(false) {
                println!("session archived");
                ChatCommand::Handled
            } else {
                ChatCommand::Error("archive: session not found".into())
            }
        }
        "/sessions" => {
            let body = client
                .call(
                    kimi_protocol::methods::SESSION_LIST,
                    serde_json::json!({ "limit": 50 }),
                )
                .await;
            if let Some(error) = body.get("error") {
                return ChatCommand::Error(error["message"].as_str().unwrap_or("unknown").into());
            }
            let sessions = body["result"]["sessions"].as_array().cloned().unwrap_or_default();
            if sessions.is_empty() {
                println!("no sessions");
            }
            for session in sessions {
                let id = session["id"].as_str().unwrap_or("");
                let title = session["title"].as_str().unwrap_or("");
                let title = if title.is_empty() { "(untitled)" } else { title };
                println!("{id}  {title}");
            }
            ChatCommand::Handled
        }
        "/undo" => {
            // Undo the last turn (pure state op; errors cleanly when there is
            // nothing to undo).
            let body = client
                .call(
                    kimi_protocol::methods::SESSION_UNDO_HISTORY,
                    serde_json::json!({ "session_id": *session_id }),
                )
                .await;
            if let Some(error) = body.get("error") {
                return ChatCommand::Error(error["message"].as_str().unwrap_or("unknown").into());
            }
            println!("{}", serde_json::to_string_pretty(&body["result"]).unwrap_or_default());
            ChatCommand::Handled
        }
        "/fork" => {
            // Fork the current session under a new id (pure state op).
            if rest.is_empty() {
                return ChatCommand::Error("usage: /fork <new-session-id>".into());
            }
            let body = client
                .call(
                    kimi_protocol::methods::SESSION_FORK,
                    serde_json::json!({ "session_id": *session_id, "fork_id": rest }),
                )
                .await;
            if let Some(error) = body.get("error") {
                return ChatCommand::Error(error["message"].as_str().unwrap_or("unknown").into());
            }
            println!("forked to {rest}");
            ChatCommand::Handled
        }
        "/import" => {
            // Import prior conversation text into the session context.
            if rest.is_empty() {
                return ChatCommand::Error("usage: /import <text>".into());
            }
            let body = client
                .call(
                    kimi_protocol::methods::SESSION_IMPORT_CONTEXT,
                    serde_json::json!({ "session_id": *session_id, "content": rest, "source": "repl" }),
                )
                .await;
            if let Some(error) = body.get("error") {
                return ChatCommand::Error(error["message"].as_str().unwrap_or("unknown").into());
            }
            println!("imported {} chars", rest.chars().count());
            ChatCommand::Handled
        }
        "/steer" => {
            // Steer the running turn with extra instruction text.
            if rest.is_empty() {
                return ChatCommand::Error("usage: /steer <text>".into());
            }
            let body = client
                .call(
                    kimi_protocol::methods::SESSION_STEER,
                    serde_json::json!({
                        "session_id": *session_id,
                        "input": [{ "type": "text", "text": rest }],
                    }),
                )
                .await;
            if let Some(error) = body.get("error") {
                return ChatCommand::Error(error["message"].as_str().unwrap_or("unknown").into());
            }
            println!("steer queued");
            ChatCommand::Handled
        }
        "/approvals" => {
            let body = client.approval_list(Some(session_id.as_str())).await;
            if let Some(error) = body.get("error") {
                return ChatCommand::Error(error["message"].as_str().unwrap_or("unknown").into());
            }
            let pending = body["result"]["pending"].as_array().cloned().unwrap_or_default();
            if pending.is_empty() {
                println!("no pending approvals");
            }
            for item in pending.iter().take(10) {
                let id = item["id"].as_str().unwrap_or("?");
                let tool = item["tool_name"].as_str().unwrap_or("?");
                let rule = item["approval_rule"].as_str().unwrap_or("?");
                println!("{id}  {tool}  ({rule})");
            }
            ChatCommand::Handled
        }
        "/approve" => {
            if rest.is_empty() {
                return ChatCommand::Error("usage: /approve <approval-id>".into());
            }
            let body = client.approval_resolve(rest, true, None).await;
            if let Some(error) = body.get("error") {
                return ChatCommand::Error(error["message"].as_str().unwrap_or("unknown").into());
            }
            if body["result"]["resolved"].as_bool().unwrap_or(false) {
                println!("approval allowed");
            } else {
                println!("approval not found");
            }
            ChatCommand::Handled
        }
        "/deny" => {
            if rest.is_empty() {
                return ChatCommand::Error("usage: /deny <approval-id>".into());
            }
            let body = client.approval_resolve(rest, false, Some("denied by user")).await;
            if let Some(error) = body.get("error") {
                return ChatCommand::Error(error["message"].as_str().unwrap_or("unknown").into());
            }
            if body["result"]["resolved"].as_bool().unwrap_or(false) {
                println!("approval denied");
            } else {
                println!("approval not found");
            }
            ChatCommand::Handled
        }
        "/goal" => {
            // Create a goal on the current session (pure state op — no LLM).
            if rest.is_empty() {
                return ChatCommand::Error("usage: /goal <objective>".into());
            }
            let body = client
                .call(
                    kimi_protocol::methods::SESSION_GOAL_CREATE,
                    serde_json::json!({ "session_id": *session_id, "objective": rest }),
                )
                .await;
            if let Some(error) = body.get("error") {
                return ChatCommand::Error(error["message"].as_str().unwrap_or("unknown").into());
            }
            println!(
                "{}",
                serde_json::to_string_pretty(&body["result"]).unwrap_or_default()
            );
            ChatCommand::Handled
        }
        "/goal-status" => {
            let body = client
                .call(
                    kimi_protocol::methods::SESSION_GOAL_GET,
                    serde_json::json!({ "session_id": *session_id }),
                )
                .await;
            if let Some(error) = body.get("error") {
                return ChatCommand::Error(error["message"].as_str().unwrap_or("unknown").into());
            }
            println!(
                "{}",
                serde_json::to_string_pretty(&body["result"]).unwrap_or_default()
            );
            ChatCommand::Handled
        }
        "/goal-cancel" => {
            let body = client
                .call(
                    kimi_protocol::methods::SESSION_GOAL_CANCEL,
                    serde_json::json!({ "session_id": *session_id }),
                )
                .await;
            if let Some(error) = body.get("error") {
                return ChatCommand::Error(error["message"].as_str().unwrap_or("unknown").into());
            }
            println!("goal cancelled");
            ChatCommand::Handled
        }
        "/goal-pause" => {
            let body = client
                .call(
                    kimi_protocol::methods::SESSION_GOAL_PAUSE,
                    serde_json::json!({ "session_id": *session_id, "reason": rest }),
                )
                .await;
            if let Some(error) = body.get("error") {
                return ChatCommand::Error(error["message"].as_str().unwrap_or("unknown").into());
            }
            println!("goal paused");
            ChatCommand::Handled
        }
        "/plan" => {
            // `/plan on|off` toggles plan mode (pure state op).
            let enabled = match rest {
                "on" => true,
                "off" => false,
                "" => true,
                other => {
                    return ChatCommand::Error(format!("usage: /plan on|off (got: {other})"));
                }
            };
            let body = client
                .call(
                    kimi_protocol::methods::SESSION_SET_PLAN_MODE,
                    serde_json::json!({ "session_id": *session_id, "enabled": enabled }),
                )
                .await;
            if let Some(error) = body.get("error") {
                return ChatCommand::Error(error["message"].as_str().unwrap_or("unknown").into());
            }
            println!("plan mode {}", if enabled { "on" } else { "off" });
            ChatCommand::Handled
        }
        "/swarm" => {
            // `/swarm on|off` toggles swarm mode (pure state op).
            let enabled = match rest {
                "on" => true,
                "off" => false,
                "" => true,
                other => {
                    return ChatCommand::Error(format!("usage: /swarm on|off (got: {other})"));
                }
            };
            let body = client
                .call(
                    kimi_protocol::methods::SESSION_SET_SWARM_MODE,
                    serde_json::json!({ "session_id": *session_id, "enabled": enabled }),
                )
                .await;
            if let Some(error) = body.get("error") {
                return ChatCommand::Error(error["message"].as_str().unwrap_or("unknown").into());
            }
            println!("swarm mode {}", if enabled { "on" } else { "off" });
            ChatCommand::Handled
        }
        "/thinking" => {
            // `/thinking <effort>` sets the thinking effort (low/medium/high).
            if rest.is_empty() {
                return ChatCommand::Error("usage: /thinking <low|medium|high>".into());
            }
            let body = client
                .call(
                    kimi_protocol::methods::SESSION_SET_THINKING,
                    serde_json::json!({ "session_id": *session_id, "effort": rest }),
                )
                .await;
            if let Some(error) = body.get("error") {
                return ChatCommand::Error(error["message"].as_str().unwrap_or("unknown").into());
            }
            println!("thinking effort set to {rest}");
            ChatCommand::Handled
        }
        "/goal-resume" => {
            let body = client
                .call(
                    kimi_protocol::methods::SESSION_GOAL_RESUME,
                    serde_json::json!({ "session_id": *session_id, "reason": rest }),
                )
                .await;
            if let Some(error) = body.get("error") {
                return ChatCommand::Error(error["message"].as_str().unwrap_or("unknown").into());
            }
            println!("goal resumed");
            ChatCommand::Handled
        }
        _ => ChatCommand::Error(format!("unknown command {cmd} — try /help")),
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    use clap::CommandFactory;
    let Cli { server, resume, command } = Cli::parse();
    let Some(command) = command else {
        // No subcommand: enter the interactive TUI (stage D) when the
        // terminal supports it; otherwise fall back to help + a hint.
        if std::io::stdin().is_terminal() {
            let harness = connect_harness(&server)?;
            // `-r <id>` resumes the named session; otherwise a fresh id.
            let session_id = resume.unwrap_or_else(|| format!("kimi-{}", std::process::id()));
            let mut app = kimi_tui::App::new(harness, &session_id);
            return app.run().await;
        }
        let mut cmd = Cli::command();
        cmd.print_help()?;
        println!();
        println!("interactive TUI needs a terminal — use `kimi chat` for a plain-text REPL or `kimi print -p \"...\"` for one-shot runs");
        return Ok(());
    };
    match command {
        Commands::Print { prompt, verbose, json, goal, model, plan, continue_ } => {
            // Progress on stderr: always with `--verbose`, and by default when
            // stderr is a terminal (script pipes stay clean — stdout keeps the
            // result contract either way).
            let capture = verbose || std::io::stderr().is_terminal();
            let (mut client, renderer) = connect_with_renderer(&server, capture)?;
            // `--continue` resumes the most recently updated session (session
            // list is ordered by updated_at DESC); otherwise a fresh id.
            let session_id = if continue_ {
                latest_session_id(&mut client)
                    .await
                    .unwrap_or_else(|| "kimi-exec".to_string())
            } else {
                "kimi-exec".to_string()
            };
            // Goal mode is applied inside run_prompt_with_setup, AFTER the
            // (idempotent) create — creating the goal first and then letting
            // run_prompt re-create the session would rebuild the agent and
            // wipe it (create_agent replaces the live agent). `--continue`
            // also loads the persisted session state.
            let setup = kimi_exec::PromptSetup { model, plan, goal, resume: continue_ };
            let result = kimi_exec::run_prompt_with_setup(
                &mut client,
                &session_id,
                &prompt,
                kimi_exec::native_llm_from_config(),
                &setup,
            )
            .await;
            if let Some(renderer) = renderer {
                // Drain a short window so a fast-failing prompt still lets
                // events already on the pipe be rendered before we abort.
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                renderer.abort();
            }
            // Persist the session (context + goal) so a later `kimi resume`
            // can continue it — even when the prompt itself failed. The
            // engine only persists on session/save; the goal and context live
            // in the agent otherwise.
            let _ = client
                .call(
                    kimi_protocol::methods::SESSION_SAVE,
                    serde_json::json!({ "session_id": session_id }),
                )
                .await;
            if let Some(error) = result.get("error") {
                eprintln!("error: {}", error["message"].as_str().unwrap_or("unknown"));
                std::process::exit(1);
            }
            if json {
                println!("{result}");
            } else {
                // Default: render the transcript — the last assistant text
                // from the session context (raw RPC envelope via `--json`).
                let ctx = client.session_get_context(&session_id).await;
                match kimi_ui::last_assistant_text(&ctx["result"]) {
                    Some(text) => println!("{text}"),
                    None => println!("{result}"),
                }
            }
            // Resume hint (TS parity): points at the persisted session so a
            // one-shot run can be continued interactively.
            eprintln!("To resume this session: kimi resume {session_id}");
        }
        Commands::Sessions { limit, json } => {
            let client = connect(&server)?;
            let body = client.session_list(limit).await;
            if let Some(error) = body.get("error") {
                eprintln!("error: {}", error["message"].as_str().unwrap_or("unknown"));
                std::process::exit(1);
            }
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&body["result"]["sessions"]).unwrap_or_default()
                );
                return Ok(());
            }
            for session in body["result"]["sessions"].as_array().unwrap_or(&vec![]) {
                let id = session["id"].as_str().unwrap_or("");
                let title = session["title"].as_str().unwrap_or("");
                let title = if title.is_empty() { "(untitled)" } else { title };
                let work_dir = session["work_dir"].as_str().unwrap_or("");
                let updated = session["updated_at"].as_str().unwrap_or("");
                println!("{id}  {title}  {work_dir}  {updated}");
            }
        }
        Commands::Resume { session_id, prompt, verbose, json, goal, model, plan } => {
            // TTY default capture, like print (verbose forces it; script
            // pipes stay clean).
            let capture = verbose || std::io::stderr().is_terminal();
            let (client, renderer) = connect_with_renderer(&server, capture)?;
            let native_llm = kimi_exec::native_llm_from_config();
            let mut create_params = serde_json::json!({ "session_id": session_id });
            if let Some(nllm) = native_llm {
                create_params["native_llm"] = serde_json::to_value(&nllm).unwrap_or_default();
            }
            let created = client.call(kimi_protocol::methods::SESSION_CREATE, create_params).await;
            if created.get("error").is_some() {
                eprintln!("error: {}", created["error"]["message"].as_str().unwrap_or("unknown"));
                std::process::exit(1);
            }
            // Model / plan-mode setup right after create (Print parity).
            if let Some(model) = &model {
                let body = client
                    .call(
                        kimi_protocol::methods::SESSION_SET_MODEL,
                        serde_json::json!({ "session_id": session_id, "model": model }),
                    )
                    .await;
                if let Some(error) = body.get("error") {
                    eprintln!("error: {}", error["message"].as_str().unwrap_or("unknown"));
                    std::process::exit(1);
                }
            }
            if plan {
                let body = client
                    .call(
                        kimi_protocol::methods::SESSION_SET_PLAN_MODE,
                        serde_json::json!({ "session_id": session_id, "enabled": true }),
                    )
                    .await;
                if let Some(error) = body.get("error") {
                    eprintln!("error: {}", error["message"].as_str().unwrap_or("unknown"));
                    std::process::exit(1);
                }
            }
            // Resume: restore the persisted context + goal BEFORE creating a
            // new goal — the load's durable-state restore would otherwise
            // overwrite the freshly created goal.
            client
                .call(kimi_protocol::methods::SESSION_LOAD, serde_json::json!({ "session_id": session_id }))
                .await;
            // Goal mode: create the goal on the (now restored) session so the
            // engine drives continuation turns toward the objective.
            if let Some(objective) = goal {
                let goal_created = client
                    .call(
                        kimi_protocol::methods::SESSION_GOAL_CREATE,
                        serde_json::json!({
                            "session_id": session_id,
                            "objective": objective,
                        }),
                    )
                    .await;
                if let Some(error) = goal_created.get("error") {
                    eprintln!("error: {}", error["message"].as_str().unwrap_or("unknown"));
                    std::process::exit(1);
                }
            }
            let result = client
                .session_prompt(&session_id, &prompt)
                .await;
            if let Some(renderer) = renderer {
                renderer.abort();
            }
            if let Some(error) = result.get("error") {
                eprintln!("error: {}", error["message"].as_str().unwrap_or("unknown"));
                std::process::exit(1);
            }
            if json {
                println!("{result}");
            } else {
                // Default: render the transcript (last assistant text), same
                // as `kimi print`; raw RPC envelope via `--json`.
                let ctx = client.session_get_context(&session_id).await;
                match kimi_ui::last_assistant_text(&ctx["result"]) {
                    Some(text) => println!("{text}"),
                    None => println!("{result}"),
                }
            }
        }
        Commands::Config { set, delete } => {
            let client = connect(&server)?;
            if !delete.is_empty() {
                // `kimi config --delete providers.<id>`: build a section-level
                // null patch (the engine's null-delete path is section-scoped
                // — providers.<id> / models.<alias>).
                let mut patch = serde_json::json!({});
                for key in &delete {
                    let (section, id) = key.split_once('.').ok_or_else(|| {
                        anyhow::anyhow!("--delete expects SECTION.KEY, got: {key}")
                    })?;
                    if section.is_empty() || id.is_empty() {
                        anyhow::bail!("invalid config key: {key}");
                    }
                    patch[section][id] = serde_json::Value::Null;
                }
                let body = client
                    .call(kimi_protocol::methods::CONFIG_SET, serde_json::json!({ "patch": patch }))
                    .await;
                if let Some(error) = body.get("error") {
                    eprintln!("error: {}", error["message"].as_str().unwrap_or("unknown"));
                    std::process::exit(1);
                }
                println!(
                    "{}",
                    serde_json::to_string_pretty(&body["result"]).unwrap_or_default()
                );
                return Ok(());
            }
            if !set.is_empty() {
                // `kimi config --set key=value`: build a nested patch from
                // dot-paths ("providers.x.apiKey") and hand it to config/set,
                // which merges with the loaded config and writes it back.
                let mut patch = serde_json::json!({});
                for kv in &set {
                    let (key, value) = kv.split_once('=').ok_or_else(|| {
                        anyhow::anyhow!("--set expects KEY=VALUE, got: {kv}")
                    })?;
                    let parts: Vec<&str> = key.split('.').collect();
                    if parts.is_empty() || parts.iter().any(|p| p.is_empty()) {
                        anyhow::bail!("invalid config key: {key}");
                    }
                    let mut obj = patch
                        .as_object_mut()
                        .expect("patch starts as an object");
                    for part in &parts[..parts.len() - 1] {
                        obj = obj
                            .entry((*part).to_string())
                            .or_insert_with(|| serde_json::json!({}))
                            .as_object_mut()
                            .expect("intermediate nodes are objects");
                    }
                    obj.insert(
                        parts.last().expect("non-empty").to_string(),
                        serde_json::json!(value),
                    );
                }
                let body = client
                    .call(kimi_protocol::methods::CONFIG_SET, serde_json::json!({ "patch": patch }))
                    .await;
                if let Some(error) = body.get("error") {
                    eprintln!("error: {}", error["message"].as_str().unwrap_or("unknown"));
                    std::process::exit(1);
                }
                println!(
                    "{}",
                    serde_json::to_string_pretty(&body["result"]).unwrap_or_default()
                );
                return Ok(());
            }
            let config = client.config_get().await;
            if let Some(error) = config.get("error") {
                eprintln!("error: {}", error["message"].as_str().unwrap_or("unknown"));
                std::process::exit(1);
            }
            println!("{}", serde_json::to_string_pretty(&config["result"]).unwrap_or_default());
        }
        Commands::Doctor { target } => {
            // `kimi doctor tui [path]` — validate one specific tui.toml file
            // (TS `doctor tui` parity): existence, then TOML parse.
            if let Some(DoctorTarget::Tui { path }) = target {
                let resolved = match path {
                    Some(p) => std::path::PathBuf::from(p),
                    None => tui_config_path().unwrap_or_else(|| std::path::PathBuf::from("tui.toml")),
                };
                let text = match std::fs::read_to_string(&resolved) {
                    Ok(text) => text,
                    Err(e) => {
                        println!("tui file: ERROR (not found) {} — {e}", resolved.display());
                        std::process::exit(1);
                    }
                };
                match text.parse::<toml::Value>() {
                    Ok(_) => println!("tui file: OK {}", resolved.display()),
                    Err(e) => {
                        println!("tui file: ERROR {} — {e}", resolved.display());
                        std::process::exit(1);
                    }
                }
                return Ok(());
            }
            // `kimi doctor config [path]` — validate one specific config file
            // (TS `doctor config` parity): existence, then parse + validate.
            if let Some(DoctorTarget::Config { path }) = target {
                let resolved = match path {
                    Some(p) => std::path::PathBuf::from(p),
                    None => kimi_agent::config::loader::find_config_paths()
                        .into_iter()
                        .find(|p| p.exists())
                        .unwrap_or_else(|| std::path::PathBuf::from("config.toml")),
                };
                if !resolved.exists() {
                    println!("config file: ERROR (not found) {}", resolved.display());
                    std::process::exit(1);
                }
                match kimi_agent::config::loader::parse_config_file(&resolved) {
                    Ok(_) => println!("config file: OK {}", resolved.display()),
                    Err(e) => {
                        println!("config file: ERROR {} — {e}", resolved.display());
                        std::process::exit(1);
                    }
                }
                return Ok(());
            }

            println!("version: {}", env!("CARGO_PKG_VERSION"));
            let harness = connect_harness(&server)?;
            match harness.health().await {
                Ok(status) => println!("health: {status}"),
                Err(e) => {
                    println!("health: error — {e}");
                    // A doctor that cannot reach a healthy engine must fail
                    // the check for CI (not just print and exit 0).
                    std::process::exit(1);
                }
            }
            match harness.config().await {
                Ok(config) => {
                    let model = config["model"].as_str().unwrap_or("");
                    let provider = config["provider"].as_str().unwrap_or("");
                    println!("config: model={model} provider={provider}");
                }
                Err(e) => println!("config: error — {e}"),
            }

            // File-level config checks (TS `kimi doctor` parity): report every
            // well-known config path with OK / SKIP / ERROR, then verify the
            // merged config parses at all.
            let mut found = 0usize;
            for path in kimi_agent::config::loader::find_config_paths() {
                if path.exists() {
                    println!("config file: OK   {}", path.display());
                    found += 1;
                } else {
                    println!("config file: SKIP {}", path.display());
                }
            }
            if found == 0 {
                println!("config file: SKIP (no config.toml found — defaults in effect)");
            }
            match kimi_agent::config::loader::load_config_with_env() {
                Ok(_) => println!("config parse: OK"),
                Err(e) => {
                    println!("config parse: ERROR — {e}");
                    std::process::exit(1);
                }
            }

            // tui.toml (TS parity, existence only — the engine has no TUI
            // config parser yet; `doctor tui` validates syntax explicitly).
            if let Some(p) = tui_config_path() {
                if p.exists() {
                    println!("tui file: OK   {}", p.display());
                } else {
                    println!("tui file: SKIP {}", p.display());
                }
            }
        }
        Commands::Health => {
            let client = connect(&server)?;
            let body = client.health().await;
            println!("{}", body["result"]["status"].as_str().unwrap_or("?"));
        }
        Commands::Chat { session, continue_, model } => {
            // Stage-D prototype: a plain-text REPL over the same event
            // rendering as `print --verbose`. Progress goes to stderr when it
            // is a TTY; the assistant transcript goes to stdout per turn.
            let capture = std::io::stderr().is_terminal();
            let (mut client, renderer) = connect_with_renderer(&server, capture)?;
            let session_id = if continue_ {
                latest_session_id(&mut client)
                    .await
                    .unwrap_or_else(|| format!("chat-{}", std::process::id()))
            } else {
                session.unwrap_or_else(|| format!("chat-{}", std::process::id()))
            };
            let created = client
                .call(
                    kimi_protocol::methods::SESSION_CREATE,
                    serde_json::json!({ "session_id": session_id }),
                )
                .await;
            if let Some(error) = created.get("error") {
                eprintln!("error: {}", error["message"].as_str().unwrap_or("unknown"));
                std::process::exit(1);
            }
            // Restore persisted state (context + goal) when resuming an
            // existing session: create rebuilds a fresh agent, load re-applies
            // the durable state. A no-op for brand-new sessions.
            let _ = client
                .call(
                    kimi_protocol::methods::SESSION_LOAD,
                    serde_json::json!({ "session_id": session_id }),
                )
                .await;
            // `--model` at startup (the REPL's `/model` covers mid-session).
            if let Some(model) = &model {
                let body = client
                    .call(
                        kimi_protocol::methods::SESSION_SET_MODEL,
                        serde_json::json!({ "session_id": session_id, "model": model }),
                    )
                    .await;
                if let Some(error) = body.get("error") {
                    eprintln!("error: {}", error["message"].as_str().unwrap_or("unknown"));
                    std::process::exit(1);
                }
            }
            if std::io::stderr().is_terminal() {
                eprintln!("chat session {session_id} — type /help for commands");
            }
            let stdin = std::io::stdin();
            let mut line = String::new();
            let mut session_id = session_id;
            loop {
                line.clear();
                match stdin.read_line(&mut line) {
                    Ok(0) => break, // EOF
                    Ok(_) => {}
                    Err(e) => {
                        eprintln!("read error: {e}");
                        break;
                    }
                }
                let text = line.trim();
                if text.is_empty() {
                    continue;
                }
                if text.starts_with('/') {
                    // Slash command — offline-safe; a `continue` keeps the loop.
                    match handle_chat_command(text, &mut client, &mut session_id).await {
                        ChatCommand::Done => break,
                        ChatCommand::Handled => continue,
                        ChatCommand::Error(message) => {
                            eprintln!("error: {message}");
                            continue;
                        }
                    }
                }
                let result = client
                    .call(
                        kimi_protocol::methods::SESSION_PROMPT,
                        serde_json::json!({
                            "session_id": session_id,
                            "input": [{ "type": "text", "text": text }],
                        }),
                    )
                    .await;
                if let Some(error) = result.get("error") {
                    eprintln!("error: {}", error["message"].as_str().unwrap_or("unknown"));
                    continue;
                }
                let ctx = client.session_get_context(&session_id).await;
                match kimi_ui::last_assistant_text(&ctx["result"]) {
                    Some(text) => println!("{text}"),
                    None => println!("{result}"),
                }
            }
            if let Some(renderer) = renderer {
                renderer.abort();
            }
        }
        Commands::Acp { login } => {
            if login {
                // `kimi acp --login` runs the OAuth flow and exits (TS parity).
                run_kimi_login(&server, None, 60).await?;
                return Ok(());
            }
            // ACP stdio server (stage E): initialize + session lifecycle,
            // driving the engine through the SDK harness.
            let harness = connect_harness(&server)?;
            let stdin = tokio::io::stdin();
            let mut stdout = tokio::io::stdout();
            kimi_acp::serve(harness, stdin, &mut stdout).await;
        }
        Commands::Completions { shell } => {
            use clap::CommandFactory;
            let mut cmd = Cli::command();
            clap_complete::generate(shell, &mut cmd, "kimi", &mut std::io::stdout());
        }
        Commands::Login { oauth_host, max_polls } => {
            run_kimi_login(&server, oauth_host, max_polls).await?;
        }
        Commands::Logout => {
            // Remove the kimi provider from the engine config (null patch
            // deletes the whole provider entry, mirroring `provider remove`).
            let client = connect(&server)?;
            let body = client
                .call(
                    kimi_protocol::methods::CONFIG_SET,
                    serde_json::json!({ "patch": { "providers": { "kimi": null } } }),
                )
                .await;
            if let Some(error) = body.get("error") {
                eprintln!("error: {}", error["message"].as_str().unwrap_or("unknown"));
                std::process::exit(1);
            }
            println!("logged out — kimi provider removed from config");
        }
        Commands::Upgrade => {
            // Self-update is owned by the distribution (npm wrapper / package
            // manager), not the Rust binary — give the user the right lever
            // instead of a silent unknown-subcommand.
            println!("upgrade is managed by your package manager:");
            println!("  npm i -g kimi-code@latest        # TS distribution");
            println!("  npm i -g kimi-code-rust-bin@latest  # Rust-first wrapper");
        }
        Commands::Web | Commands::Vis => {
            // The web/vis frontends stay in the TS distribution (pure UI); the
            // Rust build has no bundled frontend. Fail loudly rather than
            // pretending to launch.
            eprintln!(
                "{} ships with the TS distribution (npm wrapper) — not bundled in the Rust build",
                if matches!(command, Commands::Web) { "the web UI" } else { "the vis frontend" }
            );
            std::process::exit(1);
        }
        Commands::Provider { cmd } => {
            match cmd {
                ProviderCmd::List { json } => {
                    match kimi_sdk::catalog::fetch_catalog(kimi_sdk::catalog::DEFAULT_CATALOG_URL).await {
                        Ok(catalog) => {
                            if json {
                                println!(
                                    "{}",
                                    serde_json::to_string_pretty(&catalog).unwrap_or_default()
                                );
                            } else {
                                let mut providers: Vec<_> = catalog.into_iter().collect();
                                providers.sort_by(|a, b| a.0.cmp(&b.0));
                                for (id, provider) in providers {
                                    println!(
                                        "{id}  {}  ({} models)",
                                        provider.name,
                                        provider.models.len()
                                    );
                                }
                            }
                        }
                        Err(e) => {
                            eprintln!("error: catalog fetch failed — {e}");
                            std::process::exit(1);
                        }
                    }
                }
                ProviderCmd::Search { query } => {
                    let query = query.to_lowercase();
                    match kimi_sdk::catalog::fetch_catalog(kimi_sdk::catalog::DEFAULT_CATALOG_URL).await {
                        Ok(catalog) => {
                            let mut matched = 0usize;
                            let mut providers: Vec<_> = catalog.into_iter().collect();
                            providers.sort_by(|a, b| a.0.cmp(&b.0));
                            for (id, provider) in providers {
                                let model_hits: Vec<&str> = provider
                                    .models
                                    .keys()
                                    .filter(|m| m.to_lowercase().contains(&query))
                                    .map(|m| m.as_str())
                                    .collect();
                                let provider_hit =
                                    id.to_lowercase().contains(&query)
                                        || provider.name.to_lowercase().contains(&query);
                                if provider_hit || !model_hits.is_empty() {
                                    println!(
                                        "{id}  {}  ({} models)",
                                        provider.name,
                                        provider.models.len()
                                    );
                                    for m in model_hits.iter().take(5) {
                                        println!("    {m}");
                                    }
                                    matched += 1;
                                }
                            }
                            if matched == 0 {
                                println!("no providers match \"{query}\"");
                            }
                        }
                        Err(e) => {
                            eprintln!("error: catalog fetch failed — {e}");
                            std::process::exit(1);
                        }
                    }
                }
                ProviderCmd::Add { id, api_key, default_model } => {
                    let catalog =
                        match kimi_sdk::catalog::fetch_catalog(kimi_sdk::catalog::DEFAULT_CATALOG_URL).await {
                            Ok(c) => c,
                            Err(e) => {
                                eprintln!("error: catalog fetch failed — {e}");
                                std::process::exit(1);
                            }
                        };
                    let Some(provider) = catalog.get(&id) else {
                        eprintln!("error: provider \"{id}\" not in the catalog");
                        std::process::exit(1);
                    };
                    // Resolve the API key: explicit flag, the provider's env
                    // var, or none (the provider stays key-less for now).
                    let resolved_key = api_key.or_else(|| {
                        provider
                            .env
                            .first()
                            .and_then(|env| std::env::var(env).ok())
                    });
                    let base_url = provider.api.clone().unwrap_or_default();
                    // models.dev omits `api` for hosted providers; fall back
                    // to well-known endpoints for the majors.
                    let base_url = if base_url.is_empty() {
                        match id.as_str() {
                            "openai" => "https://api.openai.com/v1".to_string(),
                            "anthropic" => "https://api.anthropic.com".to_string(),
                            "google-genai" => {
                                "https://generativelanguage.googleapis.com".to_string()
                            }
                            _ => String::new(),
                        }
                    } else {
                        base_url
                    };
                    if base_url.is_empty() {
                        eprintln!("error: provider \"{id}\" has no api endpoint in the catalog");
                        std::process::exit(1);
                    }
                    let provider_type = if id == "anthropic" { "anthropic" } else { "openai" };
                    // Write providers.<id> via config/set (merge + persist).
                    let mut patch = serde_json::json!({
                        "providers": {
                            id.clone(): {
                                "type": provider_type,
                                "baseUrl": base_url,
                            }
                        }
                    });
                    if let Some(key) = resolved_key {
                        patch["providers"][&id]["apiKey"] = serde_json::json!(key);
                    }
                    if let Some(model) = default_model {
                        patch["defaultModel"] = serde_json::json!(model);
                    }
                    let client = connect(&server)?;
                    let body = client
                        .call(
                            kimi_protocol::methods::CONFIG_SET,
                            serde_json::json!({ "patch": patch }),
                        )
                        .await;
                    if let Some(error) = body.get("error") {
                        eprintln!("error: {}", error["message"].as_str().unwrap_or("unknown"));
                        std::process::exit(1);
                    }
                    println!("provider {id} added (baseUrl {base_url})");
                }
                ProviderCmd::Remove { id } => {
                    // Drop providers.<id> via a null patch (the engine's
                    // strip_null_deletes semantics; same lever as `kimi logout`).
                    let id = id.as_str();
                    let patch = serde_json::json!({
                        "providers": {
                            id: null,
                        }
                    });
                    let client = connect(&server)?;
                    let body = client
                        .call(
                            kimi_protocol::methods::CONFIG_SET,
                            serde_json::json!({ "patch": patch }),
                        )
                        .await;
                    if let Some(error) = body.get("error") {
                        eprintln!("error: {}", error["message"].as_str().unwrap_or("unknown"));
                        std::process::exit(1);
                    }
                    println!("provider {id} removed");
                }
            }
        }
        Commands::Export { session_id, output, yes } => {
            let client = connect(&server)?;
            // Resolve the session id: explicit, or the most recent session when
            // `-y` opts in (mirrors the TS CLI's previous-session flow).
            let resolved_id = match session_id {
                Some(id) if !id.trim().is_empty() => id,
                _ => {
                    if !yes {
                        eprintln!("no session id given; pass one or use -y to pick the most recent session");
                        std::process::exit(1);
                    }
                    let list = client
                        .call(kimi_protocol::methods::SESSION_LIST, serde_json::json!({ "limit": 1 }))
                        .await;
                    if let Some(error) = list.get("error") {
                        eprintln!("error: {}", error["message"].as_str().unwrap_or("unknown"));
                        std::process::exit(1);
                    }
                    let sessions = list["result"]["sessions"].as_array().cloned().unwrap_or_default();
                    let Some(first) = sessions.into_iter().next() else {
                        eprintln!("no sessions to export");
                        std::process::exit(1);
                    };
                    let id = first["id"].as_str().unwrap_or("").to_string();
                    eprintln!("exporting most recent session: {id}");
                    id
                }
            };
            let body = client
                .call(
                    kimi_protocol::methods::SESSION_EXPORT,
                    serde_json::json!({ "session_id": resolved_id }),
                )
                .await;
            if let Some(error) = body.get("error") {
                eprintln!("error: {}", error["message"].as_str().unwrap_or("unknown"));
                std::process::exit(1);
            }
            let b64 = body["result"]["zip_base64"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("export returned no zip_base64"))?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|e| anyhow::anyhow!("zip_base64 decode failed: {e}"))?;
            let out_path = match output {
                Some(p) => std::path::PathBuf::from(p),
                None => std::path::PathBuf::from(format!("{resolved_id}.zip")),
            };
            std::fs::write(&out_path, &bytes)?;
            println!("{}", out_path.display());
        }
    }
    Ok(())
}


