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
    #[command(subcommand)]
    command: Option<Commands>,
}

/// Build the protocol client: an embedded in-process server by default, or a
/// spawned server process when `--server <bin>` is given.
fn connect(server: &Option<String>) -> anyhow::Result<kimi_server_client::AppServerClient> {
    match server {
        Some(bin) => Ok(kimi_server_client::AppServerClient::Remote(
            kimi_server_client::stdio_client::StdioClient::spawn(bin)?,
        )),
        None => {
            let server = kimi_server::Server::build()?;
            Ok(kimi_server_client::AppServerClient::InProcess(
                kimi_server::in_process::spawn(server.processor),
            ))
        }
    }
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
    },
    /// Show the engine config (model/provider); with `--set`, write a value.
    Config {
        /// Set a config value (repeatable), e.g. `--set defaultModel=kimi-k2`
        /// or `--set providers.anthropic.apiKey=sk-…`. Values are strings.
        #[arg(long = "set", value_name = "KEY=VALUE")]
        set: Vec<String>,
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
                kimi_server_client::AppServerClient::Remote(client),
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
        let mut source = source.expect("capture path attaches a source");
        let mut printed = 0usize;
        while let Some(event) = source.next().await {
            if let Some(line) = kimi_ui::render_event(&event) {
                eprintln!("{line}");
                printed += 1;
                if printed > 64 {
                    break; // bound verbose output
                }
            }
        }
    });
    Ok((client, Some(renderer)))
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
            println!("/status      session status snapshot");
            println!("/usage       token usage");
            println!("/clear       clear the session context");
            println!("/compact     compact the session context");
            println!("/export      export the session as <session_id>.zip");
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
        _ => ChatCommand::Error(format!("unknown command {cmd} — try /help")),
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    use clap::CommandFactory;
    let Cli { server, command } = Cli::parse();
    let Some(command) = command else {
        // No subcommand: TS enters the interactive TUI here. That is stage D
        // of the Rust migration (ratatui, offline-blocked) — point the user
        // at the non-interactive paths instead.
        let mut cmd = Cli::command();
        cmd.print_help()?;
        println!();
        println!("interactive TUI is stage D of the Rust migration — use `kimi print -p \"...\"` for one-shot runs");
        return Ok(());
    };
    match command {
        Commands::Print { prompt, verbose, json } => {
            // Progress on stderr: always with `--verbose`, and by default when
            // stderr is a terminal (script pipes stay clean — stdout keeps the
            // result contract either way).
            let capture = verbose || std::io::stderr().is_terminal();
            let (mut client, renderer) = connect_with_renderer(&server, capture)?;
            let result = kimi_exec::run_prompt(&mut client, "kimi-exec", &prompt, kimi_exec::native_llm_from_config()).await;
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
                // Default: render the transcript — the last assistant text
                // from the session context (raw RPC envelope via `--json`).
                let ctx = client.session_get_context("kimi-exec").await;
                match kimi_ui::last_assistant_text(&ctx["result"]) {
                    Some(text) => println!("{text}"),
                    None => println!("{result}"),
                }
            }
        }
        Commands::Sessions { limit, json } => {
            let mut client = connect(&server)?;
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
                println!("{id}  {title}  {work_dir}");
            }
        }
        Commands::Resume { session_id, prompt, verbose, json } => {
            let (mut client, renderer) = connect_with_renderer(&server, verbose)?;
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
            client
                .call(kimi_protocol::methods::SESSION_LOAD, serde_json::json!({ "session_id": session_id }))
                .await;
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
        Commands::Config { set } => {
            let mut client = connect(&server)?;
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

            let mut client = connect(&server)?;
            let health = client.health().await;
            println!("health: {}", health["result"]["status"].as_str().unwrap_or("?"));
            let config = client.config_get().await;
            if let Some(error) = config.get("error") {
                println!("config: error — {}", error["message"].as_str().unwrap_or("unknown"));
            } else {
                let model = config["result"]["model"].as_str().unwrap_or("");
                let provider = config["result"]["provider"].as_str().unwrap_or("");
                println!("config: model={model} provider={provider}");
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
            // config parser yet). `KIMI_CODE_HOME` is itself the data dir, so
            // tui.toml is `$KIMI_CODE_HOME/tui.toml`; otherwise
            // `~/.kimi-code/tui.toml`.
            let tui_path = match std::env::var("KIMI_CODE_HOME") {
                Ok(dir) => Some(std::path::PathBuf::from(dir).join("tui.toml")),
                Err(_) => std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                    .ok()
                    .map(|home| std::path::PathBuf::from(home).join(".kimi-code").join("tui.toml")),
            };
            if let Some(p) = tui_path {
                if p.exists() {
                    println!("tui file: OK   {}", p.display());
                } else {
                    println!("tui file: SKIP {}", p.display());
                }
            }
        }
        Commands::Health => {
            let mut client = connect(&server)?;
            let body = client.health().await;
            println!("{}", body["result"]["status"].as_str().unwrap_or("?"));
        }
        Commands::Chat { session } => {
            // Stage-D prototype: a plain-text REPL over the same event
            // rendering as `print --verbose`. Progress goes to stderr when it
            // is a TTY; the assistant transcript goes to stdout per turn.
            let capture = std::io::stderr().is_terminal();
            let (mut client, renderer) = connect_with_renderer(&server, capture)?;
            let session_id = session.unwrap_or_else(|| format!("chat-{}", std::process::id()));
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
        Commands::Export { session_id, output, yes } => {
            let mut client = connect(&server)?;
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


