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
    /// Resume an existing session (TS `-S/--session` parity): with no
    /// subcommand, enters the interactive TUI bound to that session. A
    /// value-less `-S`/`-r` opens the session picker.
    #[arg(
        short = 'S',
        short_alias = 'r',
        long = "session",
        alias = "resume",
        global = true,
        num_args = 0..=1,
        default_missing_value = "@picker"
    )]
    session: Option<Option<String>>,
    /// Run one prompt non-interactively (TS `--prompt`/`-p` parity — the
    /// documented `kimi --prompt "..."` form). `-p` as the first token still
    /// resolves to the `print` subcommand via its plain alias; this option
    /// covers the long form and `-p<value>` attached values.
    #[arg(long = "prompt", short = 'p')]
    prompt: Option<String>,
    #[command(subcommand)]
    command: Option<Commands>,
}

/// `kimi print --output-format` values (TS parity).
#[derive(clap::ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
enum PrintOutputFormat {
    /// Plain text transcript (default).
    Text,
    /// JSONL stream of assistant/tool/meta messages.
    StreamJson,
}

/// Parse a `/goal <objective>` headless prompt prefix (TS
/// `parseHeadlessGoalCreate` parity): the objective is sent as the prompt and
/// a goal is created on the session first. Any other prompt (or a bare
/// `/goal`) runs as a normal prompt.
fn parse_headless_goal(prompt: &str) -> Option<String> {
    let trimmed = prompt.trim();
    let rest = trimmed.strip_prefix("/goal")?;
    if !rest.is_empty() && !rest.starts_with(|c: char| c.is_whitespace()) {
        return None; // `/goalX` — not a goal command.
    }
    let objective = rest.trim();
    if objective.is_empty() {
        return None;
    }
    Some(objective.to_string())
}

/// The engine's `GoalSnapshot` is camelCase (TS parity), so the summary maps
/// field-for-field onto the SDK's `GoalSummary` (TS `goalSummaryJson`).
fn goal_summary_value(snapshot: &serde_json::Value) -> serde_json::Value {
    if snapshot.is_null() {
        return serde_json::json!({
            "type": "goal.summary",
            "goalId": null,
            "status": null,
            "reason": null,
            "turnsUsed": null,
            "tokensUsed": null,
            "wallClockMs": null,
        });
    }
    serde_json::json!({
        "type": "goal.summary",
        "goalId": snapshot["goalId"],
        "status": snapshot["status"],
        "reason": snapshot["terminalReason"],
        "turnsUsed": snapshot["turnsUsed"],
        "tokensUsed": snapshot["tokensUsed"],
        "wallClockMs": snapshot["wallClockMs"],
    })
}

/// Human-readable goal summary (TS `formatGoalSummaryText` parity).
fn format_goal_summary(snapshot: &serde_json::Value) -> String {
    if snapshot.is_null() {
        return "No goal found.".to_string();
    }
    let status = snapshot["status"].as_str().unwrap_or("");
    let mut parts = vec![format!("Goal [{status}]")];
    if let Some(reason) = snapshot["terminalReason"].as_str() {
        parts.push(reason.to_string());
    }
    format!(
        "{} (turns: {}, tokens: {})",
        parts.join(": "),
        snapshot["turnsUsed"],
        snapshot["tokensUsed"],
    )
}

/// Terminal width for prompt-block wrapping (from `COLUMNS`; `None` when the
/// width is unknown or not a number).
fn terminal_columns() -> Option<u16> {
    std::env::var("COLUMNS")
        .ok()
        .and_then(|c| c.trim().parse().ok())
}

/// JSONL output writer for `--output-format stream-json` (TS
/// `PromptJsonWriter` parity): assistant text + tool calls accumulate and are
/// flushed as `{role:"assistant", …}` messages; tool results emit
/// `{role:"tool", …}` lines.
struct JsonlWriter {
    assistant_text: String,
    tool_calls: Vec<serde_json::Value>,
}

impl JsonlWriter {
    fn new() -> Self {
        Self {
            assistant_text: String::new(),
            tool_calls: Vec::new(),
        }
    }

    /// Feed one engine event; returns the JSONL lines it produces.
    fn feed(&mut self, event: &serde_json::Value) -> Vec<String> {
        let mut lines = Vec::new();
        match event["type"].as_str() {
            Some("llm.delta") => {
                if let Some(text) = kimi_ui::stream_delta(event) {
                    self.assistant_text.push_str(text);
                }
            }
            Some("session.tool.started") => {
                let id = event["tool_call_id"].as_str().unwrap_or("").to_string();
                let name = event["tool_name"].as_str().unwrap_or("").to_string();
                let args_str = serde_json::to_string(&event["arguments"]).unwrap_or_default();
                self.tool_calls.push(serde_json::json!({
                    "type": "function",
                    "id": id,
                    "function": { "name": name, "arguments": args_str },
                }));
            }
            Some("session.tool.settled") => {
                lines.extend(self.flush());
                let tool_call_id = event["tool_call_id"].as_str().unwrap_or("").to_string();
                let content = event["content"].as_str().unwrap_or("").to_string();
                lines.push(
                    serde_json::json!({
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": content,
                    })
                    .to_string(),
                );
            }
            Some("session.turn.ended") => {
                lines.extend(self.flush());
            }
            _ => {}
        }
        lines
    }

    /// Flush accumulated assistant text/tool calls as one JSONL line.
    fn flush(&mut self) -> Vec<String> {
        if self.assistant_text.is_empty() && self.tool_calls.is_empty() {
            return Vec::new();
        }
        let mut message = serde_json::json!({ "role": "assistant" });
        if !self.assistant_text.is_empty() {
            message["content"] = serde_json::json!(self.assistant_text);
        }
        if !self.tool_calls.is_empty() {
            message["tool_calls"] = serde_json::Value::Array(std::mem::take(&mut self.tool_calls));
        }
        self.assistant_text.clear();
        vec![message.to_string()]
    }

    /// Final flush at stream end.
    fn finish(&mut self) -> Vec<String> {
        self.flush()
    }
}

/// Build the protocol client: an embedded in-process server by default, or a
/// spawned server process when `--server <bin>` is given.
fn connect(server: &Option<String>) -> anyhow::Result<kimi_server_client::AppServerClient> {    match server {
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

/// Launch the web UI server — an in-process `kimi-server-serve --http`
/// equivalent (Rust `/api/v1` + WS + optional SPA assets). Auth follows the
/// serve-binary resolution: `KIMI_CODE_PASSWORD`, then
/// `<KIMI_CODE_HOME>/server.token` (generated + persisted when absent), or
/// lenient with `--dangerous-bypass-auth`.
async fn run_web(
    host: &str,
    port: u16,
    no_auth: bool,
    no_open: bool,
    assets: Option<&str>,
) -> anyhow::Result<()> {
    let server = kimi_server::Server::build()?;
    let processor = std::sync::Arc::new(server.processor);
    let auth = web_auth_config(no_auth);
    // The SPA reads the bearer credential from `#token=` (apps/kimi-web
    // serverAuth.ts); append it so the opened page authenticates.
    let url = match &auth.token {
        Some(token) => format!("http://{host}:{port}/#token={token}"),
        None => format!("http://{host}:{port}"),
    };
    let state = kimi_server_transport::http::HttpState::with_events(
        processor,
        server.state.event_sender(),
    )
    .with_auth(auth);
    let listener = tokio::net::TcpListener::bind((host, port)).await?;
    println!("Kimi Code web server running at {url}");
    if !no_open {
        open_browser(&url);
    }
    let router = match assets {
        Some(dir) => kimi_server_transport::http::router_with_assets(state, dir),
        None => kimi_server_transport::http::router(state),
    };
    axum::serve(listener, kimi_server_transport::http::colon_make_service(router))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

/// Ctrl-C / SIGTERM graceful shutdown for the web server.
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.expect("ctrl-c handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("sigterm handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

/// Resolve the web bearer credential (serve-binary parity): password env
/// wins, then the persisted token (generated when absent). `no_auth` →
/// lenient.
fn web_auth_config(no_auth: bool) -> kimi_server_transport::http::AuthConfig {
    let token = if no_auth {
        None
    } else {
        let path = format!("{}/server.token", kimi_code_home());
        let resolved = std::env::var("KIMI_CODE_PASSWORD").ok().or_else(|| {
            std::fs::read_to_string(&path)
                .ok()
                // Strip a UTF-8 BOM (some editors/tools write one); Rust's
                // `trim()` does not treat U+FEFF as whitespace.
                .map(|s| s.trim().trim_start_matches('\u{FEFF}').trim().to_string())
                .filter(|s| !s.is_empty())
        });
        match resolved {
            Some(token) => Some(token),
            None => {
                // Neither source present: mint + persist one so the web flow
                // (which hands the browser `#token=<server.token>`) works.
                let token = generate_token();
                if let Some(parent) = std::path::Path::new(&path).parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if std::fs::write(&path, &token).is_ok() {
                    eprintln!("generated server.token at {path}");
                    Some(token)
                } else {
                    eprintln!("could not persist server.token at {path}; running lenient");
                    None
                }
            }
        }
    };
    kimi_server_transport::http::AuthConfig { token }
}

/// Generate a bearer token without a rand dependency.
fn generate_token() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!(
        "kimi-{:016x}{:08x}{:08x}",
        now.as_nanos() as u64,
        std::process::id(),
        n
    )
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
            kimi_oauth::DevicePollResult::Success { access_token, .. } => {
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
        /// Resume the most recently updated session instead of a fresh one
        /// (mutually exclusive with `-S <id>`/`-r <id>`).
        #[arg(long = "continue", conflicts_with = "session")]
        continue_: bool,
        /// Output format: `text` (default) or `stream-json` (JSONL).
        #[arg(long, value_enum, default_value_t = PrintOutputFormat::Text)]
        output_format: PrintOutputFormat,
        /// Auto-approve tool calls (permission mode auto).
        #[arg(long)]
        yolo: bool,
        /// Auto permission mode (mutually exclusive with --yolo).
        #[arg(long, conflicts_with = "yolo")]
        auto: bool,
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
        /// Output format: `text` (default) or `stream-json` (JSONL).
        #[arg(long, value_enum, default_value_t = PrintOutputFormat::Text)]
        output_format: PrintOutputFormat,
        /// Auto-approve tool calls (permission mode auto).
        #[arg(long)]
        yolo: bool,
        /// Auto permission mode (mutually exclusive with --yolo).
        #[arg(long, conflicts_with = "yolo")]
        auto: bool,
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
        /// Include the global log file in the archive (default on).
        #[arg(long, action = clap::ArgAction::SetTrue)]
        include_global_log: bool,
        /// Omit the global log file from the archive (TS parity: the default
        /// is to include it; this flips that default off).
        #[arg(long = "no-include-global-log", action = clap::ArgAction::SetTrue)]
        no_include_global_log: bool,
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
    /// Migrate legacy kimi-cli data — a one-time step handled by the TS
    /// distribution (the Rust binary does not bundle the migration screen).
    Migrate,
    /// Launch the web UI server (the Rust `/api/v1` + WS surface; the SPA
    /// frontend is served from `--assets` when given, otherwise it ships with
    /// the TS distribution).
    Web {
        /// Port to serve on (default 58627).
        #[arg(long, default_value_t = 58627)]
        port: u16,
        /// Host to bind (default 127.0.0.1).
        #[arg(long, default_value = "127.0.0.1")]
        host: String,
        /// Disable bearer auth (dev mode).
        #[arg(long)]
        dangerous_bypass_auth: bool,
        /// Do not open the browser automatically.
        #[arg(long)]
        no_open: bool,
        /// Serve the bundled SPA from this directory (`--assets <dir>`).
        #[arg(long)]
        assets: Option<String>,
    },
    /// Launch the visualization frontend (ships with the TS distribution).
    Vis,
}

/// Sub-commands of `kimi provider`.
#[derive(Subcommand)]
enum ProviderCmd {
    /// List configured providers (from the engine config; apiKey masked).
    List {
        /// Print the raw (masked) providers config as JSON.
        #[arg(long)]
        json: bool,
    },
    /// Import providers from a registry api.json URL (TS `provider add`
    /// parity — the model catalog is such a registry).
    Add {
        /// Registry api.json URL.
        url: String,
        /// API key for the imported providers (falls back to
        /// KIMI_REGISTRY_API_KEY).
        #[arg(long)]
        api_key: Option<String>,
    },
    /// Remove a provider from the engine config.
    Remove {
        /// Provider id (e.g. `openai`, `anthropic`, `kimi`).
        id: String,
    },
    /// Browse the model catalog (models.dev) and import providers from it.
    Catalog {
        #[command(subcommand)]
        cmd: CatalogCmd,
    },
}

/// Sub-commands of `kimi provider catalog`.
#[derive(Subcommand)]
enum CatalogCmd {
    /// List catalog providers, optionally drilled into one.
    List {
        /// Optional provider id to drill into (shows its models).
        provider_id: Option<String>,
        /// Case-insensitive id/name substring filter.
        #[arg(long)]
        filter: Option<String>,
        /// Print the matching catalog slice as JSON.
        #[arg(long)]
        json: bool,
        /// Catalog URL override (tests / mirrors).
        #[arg(long)]
        url: Option<String>,
    },
    /// Search catalog providers/models by keyword.
    Search {
        /// Keyword to match against provider and model names.
        query: String,
        /// Catalog URL override (tests / mirrors).
        #[arg(long)]
        url: Option<String>,
    },
    /// Import one catalog provider into the engine config.
    Add {
        /// Catalog provider id (e.g. `openai`, `anthropic`).
        id: String,
        /// API key (falls back to the provider's env var when absent).
        #[arg(long)]
        api_key: Option<String>,
        /// Set this model as the engine default.
        #[arg(long)]
        default_model: Option<String>,
        /// Catalog URL override (tests / mirrors).
        #[arg(long)]
        url: Option<String>,
        /// Explicit base URL (required when the import resolution reports
        /// `needs-base-url`; wins over the catalog endpoint otherwise).
        #[arg(long)]
        base_url: Option<String>,
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

/// Resolve `<KIMI_CODE_HOME>` (default `~/.kimi-code`).
fn kimi_code_home() -> String {
    std::env::var("KIMI_CODE_HOME").unwrap_or_else(|_| {
        std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .map(|h| format!("{h}/.kimi-code"))
            .unwrap_or_default()
    })
}

/// Check one config.toml file: existence + parse + validate (TS `doctor
/// config` parity — the engine's `validate_config` requires at least one
/// provider; unknown sections are ignored like TS's Zod strip). A missing
/// file is ERROR when explicitly targeted, SKIP on the default path.
fn check_config_file(path: &std::path::Path, explicit: bool) -> (String, Option<String>) {
    if !path.exists() {
        let message = if explicit {
            "File does not exist.".to_string()
        } else {
            "File does not exist; built-in defaults will apply.".to_string()
        };
        return ((if explicit { "ERROR" } else { "SKIP" }).to_string(), Some(message));
    }
    match kimi_agent::config::loader::parse_config_file(path) {
        Ok(_) => ("OK".to_string(), None),
        Err(e) => ("ERROR".to_string(), Some(e.to_string())),
    }
}

/// Check one tui.toml file: existence, then TOML parse (TS `doctor tui`
/// parity; the engine has no TUI config parser yet, so syntax only).
fn check_tui_file(path: &std::path::Path, explicit: bool) -> (String, Option<String>) {
    if !path.exists() {
        let message = if explicit {
            "File does not exist.".to_string()
        } else {
            "File does not exist; built-in defaults will apply.".to_string()
        };
        return ((if explicit { "ERROR" } else { "SKIP" }).to_string(), Some(message));
    }
    match std::fs::read_to_string(path) {
        Ok(text) => match text.parse::<toml::Value>() {
            Ok(_) => ("OK".to_string(), None),
            Err(e) => ("ERROR".to_string(), Some(e.to_string())),
        },
        Err(e) => ("ERROR".to_string(), Some(e.to_string())),
    }
}

/// Print the doctor verdict line; exit 1 when any check failed (TS parity).
fn finish_doctor(issue_count: usize) {
    if issue_count == 0 {
        println!("All checked config files are valid.");
    } else {
        eprintln!(
            "Kimi doctor found {} issue{}.",
            issue_count,
            if issue_count == 1 { "" } else { "s" }
        );
        std::process::exit(1);
    }
}

/// Connect the protocol client and — when `capture` is set — start the event
/// renderer (embedded EventBus / Remote captured stderr), so progress lines
/// appear on stderr while the prompt runs. Returns the client and the renderer
/// task handle (abort it after the prompt completes). `jsonl` additionally
/// emits a `--output-format stream-json` JSONL transcript on stdout.
fn connect_with_renderer(
    server: &Option<String>,
    capture: bool,
    jsonl: bool,
) -> anyhow::Result<(
    kimi_server_client::AppServerClient,
    Option<tokio::task::JoinHandle<()>>,
)> {
    if !capture && !jsonl {
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
        let mut jsonl = jsonl.then(JsonlWriter::new);
        // Live assistant text rolls on a TTY (codex-style streaming); piped
        // stderr stays clean (the final transcript still lands on stdout).
        let tty = std::io::stderr().is_terminal();
        while let Some(event) = source.next().await {
            if let Some(writer) = jsonl.as_mut() {
                for line in writer.feed(&event) {
                    println!("{line}");
                }
            }
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
        if let Some(mut writer) = jsonl {
            // Final flush: a turn that produced text but no explicit
            // turn.ended event still emits its assistant message.
            for line in writer.finish() {
                println!("{line}");
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
#[cfg(test)]
mod headless_tests {
    use super::*;

    #[test]
    fn parses_goal_prefix() {
        assert_eq!(
            parse_headless_goal("/goal build the thing"),
            Some("build the thing".into())
        );
        assert_eq!(
            parse_headless_goal("/goal\nmulti line"),
            Some("multi line".into())
        );
        assert_eq!(parse_headless_goal("hello world"), None);
        assert_eq!(parse_headless_goal("/goal"), None); // bare — not a create
        assert_eq!(parse_headless_goal("/goalX"), None); // not a goal command
    }

    #[test]
    fn goal_summary_maps_engine_snapshot() {
        let snapshot = serde_json::json!({
            "goalId": "g1",
            "status": "blocked",
            "terminalReason": "budget",
            "turnsUsed": 3,
            "tokensUsed": 100,
            "wallClockMs": 5000,
        });
        let v = goal_summary_value(&snapshot);
        assert_eq!(v["type"], "goal.summary");
        assert_eq!(v["status"], "blocked");
        assert_eq!(v["reason"], "budget");
        assert_eq!(v["turnsUsed"], 3);
        assert_eq!(
            goal_summary_value(&serde_json::Value::Null)["goalId"],
            serde_json::Value::Null
        );
        let text = format_goal_summary(&snapshot);
        assert!(text.contains("Goal [blocked]"), "text: {text}");
        assert!(text.contains("budget"), "text: {text}");
        assert!(text.contains("turns: 3"), "text: {text}");
        assert_eq!(format_goal_summary(&serde_json::Value::Null), "No goal found.");
    }

    #[test]
    fn jsonl_writer_accumulates_and_flushes() {
        let mut w = JsonlWriter::new();
        assert!(
            w.feed(&serde_json::json!({ "type": "llm.delta", "part": { "type": "text", "text": "hi " } }))
                .is_empty()
        );
        let lines = w.feed(&serde_json::json!({ "type": "session.turn.ended" }));
        assert_eq!(lines.len(), 1, "flush on turn end: {lines:?}");
        let v: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(v["role"], "assistant");
        assert_eq!(v["content"], "hi ");
    }

    #[test]
    fn jsonl_writer_emits_tool_messages() {
        let mut w = JsonlWriter::new();
        w.feed(&serde_json::json!({
            "type": "session.tool.started",
            "tool_call_id": "t1",
            "tool_name": "Bash",
            "arguments": { "command": "ls" },
        }));
        let lines = w.feed(&serde_json::json!({
            "type": "session.tool.settled",
            "tool_call_id": "t1",
            "content": "ok",
            "is_error": false,
        }));
        assert_eq!(lines.len(), 2, "assistant flush + tool line: {lines:?}");
        let tool: serde_json::Value = serde_json::from_str(&lines[1]).unwrap();
        assert_eq!(tool["role"], "tool");
        assert_eq!(tool["tool_call_id"], "t1");
        assert_eq!(tool["content"], "ok");
    }

    #[test]
    fn web_auth_respects_bypass_and_password() {
        // --dangerous-bypass-auth -> lenient.
        assert!(web_auth_config(true).token.is_none());
        // KIMI_CODE_PASSWORD env wins over the persisted token.
        std::env::set_var("KIMI_CODE_PASSWORD", "pw-test");
        let cfg = web_auth_config(false);
        assert_eq!(cfg.token.as_deref(), Some("pw-test"));
        std::env::remove_var("KIMI_CODE_PASSWORD");
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
            println!("/session     show this session id, or `/session set <title>` to rename");
            println!("/plugins     list plugins; subcommands: enable|disable|remove|reload|install <source>");
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
            println!("/reload      reload the persisted session state");
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
        "/reload" => {
            if session_id.is_empty() {
                return ChatCommand::Error("no active session; create one with /new or /resume <id>".into());
            }
            let body = client
                .call(
                    kimi_protocol::methods::SESSION_LOAD,
                    serde_json::json!({ "session_id": session_id }),
                )
                .await;
            if let Some(error) = body.get("error") {
                return ChatCommand::Error(format!(
                    "reload failed: {}",
                    error["message"].as_str().unwrap_or("unknown")
                ));
            }
            if body["found"].as_bool().unwrap_or(false) {
                println!("session {session_id} reloaded");
                ChatCommand::Handled
            } else {
                ChatCommand::Error("reload failed: session not found".into())
            }
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
        "/session" => {
            let parts: Vec<&str> = rest.split_whitespace().collect();
            match parts.first().copied() {
                Some("set") if parts.len() >= 2 => {
                    let title = parts[1..].join(" ");
                    let body = client
                        .call(
                            kimi_protocol::methods::SESSION_RENAME,
                            serde_json::json!({ "session_id": *session_id, "title": title }),
                        )
                        .await;
                    if let Some(error) = body.get("error") {
                        return ChatCommand::Error(error["message"].as_str().unwrap_or("unknown").into());
                    }
                    println!("session renamed to {title}");
                    ChatCommand::Handled
                }
                _ if parts.is_empty() => {
                    println!("session {}", session_id);
                    ChatCommand::Handled
                }
                _ => ChatCommand::Error("usage: /session [set <title>]".into()),
            }
        }
        "/plugins" => {
            let parts: Vec<&str> = rest.split_whitespace().collect();
            let action = parts.first().copied().unwrap_or("list");
            let id = parts.get(1).copied().unwrap_or("");
            let body = match (action, id) {
                ("list", _) => client
                    .call(kimi_protocol::methods::PLUGIN_LIST, serde_json::Value::Null)
                    .await,
                ("enable", id) if !id.is_empty() => client
                    .call(
                        kimi_protocol::methods::PLUGIN_SET_ENABLED,
                        serde_json::json!({ "id": id, "enabled": true }),
                    )
                    .await,
                ("disable", id) if !id.is_empty() => client
                    .call(
                        kimi_protocol::methods::PLUGIN_SET_ENABLED,
                        serde_json::json!({ "id": id, "enabled": false }),
                    )
                    .await,
                ("remove", id) if !id.is_empty() => client
                    .call(kimi_protocol::methods::PLUGIN_REMOVE, serde_json::json!({ "id": id }))
                    .await,
                ("reload", _) => client
                    .call(kimi_protocol::methods::PLUGIN_RELOAD, serde_json::Value::Null)
                    .await,
                ("install", source) if !source.is_empty() => client
                    .call(kimi_protocol::methods::PLUGIN_INSTALL, serde_json::json!({ "source": source }))
                    .await,
                _ => {
                    return ChatCommand::Error(
                        "usage: /plugins [list|enable <id>|disable <id>|remove <id>|reload|install <source>]".into(),
                    );
                }
            };
            if let Some(error) = body.get("error") {
                return ChatCommand::Error(error["message"].as_str().unwrap_or("unknown").into());
            }
            if action == "list" {
                let plugins = body["result"]["plugins"].as_array().cloned().unwrap_or_default();
                if plugins.is_empty() {
                    println!("no plugins installed");
                }
                for plugin in plugins {
                    let id = plugin["id"].as_str().unwrap_or("?");
                    let enabled = plugin["enabled"].as_bool().unwrap_or(false);
                    println!("{id} {}", if enabled { "[on]" } else { "[off]" });
                }
            } else {
                println!("{}", serde_json::to_string_pretty(&body["result"]).unwrap_or_default());
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
    let Cli { server, session, command, prompt } = Cli::parse();
    // Top-level `--prompt`/`-p` (long form or attached value) routes into the
    // `print` subcommand with defaults — TS parity for `kimi --prompt "..."`.
    let command = match command {
        Some(cmd) => Some(cmd),
        None => prompt.map(|prompt| Commands::Print {
            prompt,
            verbose: false,
            json: false,
            goal: None,
            model: None,
            plan: false,
            continue_: false,
            output_format: PrintOutputFormat::Text,
            yolo: false,
            auto: false,
        }),
    };
    let Some(command) = command else {
        // No subcommand: enter the interactive TUI (stage D) when the
        // terminal supports it; otherwise fall back to help + a hint.
        if std::io::stdin().is_terminal() {
            let harness = connect_harness(&server)?;
            // `-S <id>`/`-r <id>` resumes the named session; a value-less
            // `-S`/`-r` opens the session picker; nothing given starts a
            // fresh session.
            let mut app = match session {
                Some(Some(id)) => kimi_tui::App::new(harness, Some(&id)),
                Some(None) => kimi_tui::App::new(harness, None),
                None => {
                    let fresh = format!("kimi-{}", std::process::id());
                    kimi_tui::App::new(harness, Some(&fresh))
                }
            };
            return app.run().await;
        }
        let mut cmd = Cli::command();
        cmd.print_help()?;
        println!();
        println!("interactive TUI needs a terminal — use `kimi chat` for a plain-text REPL or `kimi -p \"...\"` for one-shot runs");
        return Ok(());
    };
    match command {
        Commands::Print { prompt, verbose, json, goal, model, plan, continue_, output_format, yolo, auto } => {
            // TS `validateOptions` parity: empty prompt/model are rejected
            // before anything is sent to the engine.
            if prompt.trim().is_empty() {
                eprintln!("error: Prompt cannot be empty.");
                std::process::exit(1);
            }
            if model.as_deref().is_some_and(|m| m.trim().is_empty()) {
                eprintln!("error: Model cannot be empty.");
                std::process::exit(1);
            }
            let stream_json = output_format == PrintOutputFormat::StreamJson;
            if json && stream_json {
                eprintln!("error: --json and --output-format stream-json are mutually exclusive");
                std::process::exit(1);
            }
            // Progress on stderr: always with `--verbose`, and by default when
            // stderr is a terminal (script pipes stay clean — stdout keeps the
            // result contract either way).
            let capture = verbose || std::io::stderr().is_terminal();
            let (mut client, renderer) = connect_with_renderer(&server, capture, stream_json)?;
            // `--continue` resumes the most recently updated session (session
            // list is ordered by updated_at DESC); otherwise a fresh id.
            let session_id = if continue_ {
                latest_session_id(&mut client)
                    .await
                    .unwrap_or_else(|| "kimi-exec".to_string())
            } else {
                "kimi-exec".to_string()
            };
            // `/goal <objective>` prompt prefix (TS `parseHeadlessGoalCreate`
            // parity): the objective is sent as the prompt and a goal is
            // created first. An explicit `--goal` wins over the prefix.
            let goal = goal.or_else(|| parse_headless_goal(&prompt));
            let has_goal = goal.is_some();
            // Goal mode is applied inside run_prompt_with_setup, AFTER the
            // (idempotent) create — creating the goal first and then letting
            // run_prompt re-create the session would rebuild the agent and
            // wipe it (create_agent replaces the live agent). `--continue`
            // also loads the persisted session state.
            let setup = kimi_exec::PromptSetup {
                model,
                plan,
                goal,
                resume: continue_,
                permission_auto: yolo || auto,
            };
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
            } else if !stream_json {
                // Default: render the transcript — the last assistant text
                // from the session context as a bullet block (TS
                // `PromptBlockWriter` parity; raw RPC envelope via `--json`).
                let ctx = client.session_get_context(&session_id).await;
                match kimi_ui::last_assistant_text(&ctx["result"]) {
                    Some(text) => {
                        println!("{}", kimi_ui::render_prompt_block(&text, terminal_columns()))
                    }
                    None => println!("{result}"),
                }
            }
            // Goal mode: emit the machine-readable/text summary and map the
            // terminal goal status to a distinct exit code (TS parity:
            // complete → 0, blocked → 3, paused → 6).
            if has_goal {
                let goal_body = client
                    .call(
                        kimi_protocol::methods::SESSION_GOAL_GET,
                        serde_json::json!({ "session_id": session_id }),
                    )
                    .await;
                let snapshot = &goal_body["result"]["goal"];
                if stream_json {
                    println!("{}", goal_summary_value(snapshot));
                } else {
                    eprintln!("{}", format_goal_summary(snapshot));
                }
                let status = snapshot["status"].as_str().unwrap_or("complete");
                if status != "complete" {
                    let code = match status {
                        "blocked" => 3,
                        "paused" => 6,
                        _ => 0,
                    };
                    std::process::exit(code);
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
        Commands::Resume { session_id, prompt, verbose, json, goal, model, plan, output_format, yolo, auto } => {
            let stream_json = output_format == PrintOutputFormat::StreamJson;
            if json && stream_json {
                eprintln!("error: --json and --output-format stream-json are mutually exclusive");
                std::process::exit(1);
            }
            // TTY default capture, like print (verbose forces it; script
            // pipes stay clean).
            let capture = verbose || std::io::stderr().is_terminal();
            let (client, renderer) = connect_with_renderer(&server, capture, stream_json)?;
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
            // Auto permission mode (`--yolo`/`--auto` parity): a headless run
            // must not stall on tool approvals.
            if yolo || auto {
                let body = client
                    .call(
                        kimi_protocol::methods::PERMISSION_SET_MODE,
                        serde_json::json!({ "session_id": session_id, "mode": "auto" }),
                    )
                    .await;
                if let Some(error) = body.get("error") {
                    eprintln!("error: {}", error["message"].as_str().unwrap_or("unknown"));
                    std::process::exit(1);
                }
            }
            // `/goal <objective>` prompt prefix (Print parity).
            let goal = goal.or_else(|| parse_headless_goal(&prompt));
            // Resume: restore the persisted context + goal BEFORE creating a
            // new goal — the load's durable-state restore would otherwise
            // overwrite the freshly created goal.
            client
                .call(kimi_protocol::methods::SESSION_LOAD, serde_json::json!({ "session_id": session_id }))
                .await;
            // Goal mode: create the goal on the (now restored) session so the
            // engine drives continuation turns toward the objective.
            if let Some(objective) = goal.clone() {
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
            } else if !stream_json {
                // Default: render the transcript (last assistant text) as a
                // bullet block, same as `kimi print`; raw RPC via `--json`.
                let ctx = client.session_get_context(&session_id).await;
                match kimi_ui::last_assistant_text(&ctx["result"]) {
                    Some(text) => {
                        println!("{}", kimi_ui::render_prompt_block(&text, terminal_columns()))
                    }
                    None => println!("{result}"),
                }
            }
            // Goal mode: summary + terminal-status exit code (Print parity).
            if goal.is_some() {
                let goal_body = client
                    .call(
                        kimi_protocol::methods::SESSION_GOAL_GET,
                        serde_json::json!({ "session_id": session_id }),
                    )
                    .await;
                let snapshot = &goal_body["result"]["goal"];
                if stream_json {
                    println!("{}", goal_summary_value(snapshot));
                } else {
                    eprintln!("{}", format_goal_summary(snapshot));
                }
                let status = snapshot["status"].as_str().unwrap_or("complete");
                if status != "complete" {
                    let code = match status {
                        "blocked" => 3,
                        "paused" => 6,
                        _ => 0,
                    };
                    std::process::exit(code);
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
            // TS `kimi doctor` output contract: a title, one
            // `STATUS label(12) path` line per checked file with indented
            // detail, and a closing verdict. Rust keeps the health/config
            // summary as an extra block before the file checks.
            let print_results = |results: &[(String, String, std::path::PathBuf, Option<String>)]| {
                for (status, label, path, message) in results {
                    println!("{status} {label:<12} {}", path.display());
                    if let Some(msg) = message {
                        for line in msg.lines() {
                            println!("  {line}");
                        }
                    }
                }
            };
            // `kimi doctor tui [path]` — validate one specific tui.toml file
            // (TS `doctor tui` parity): existence, then TOML parse.
            if let Some(DoctorTarget::Tui { path }) = target {
                let resolved = match path {
                    Some(p) => std::path::PathBuf::from(p),
                    None => tui_config_path().unwrap_or_else(|| std::path::PathBuf::from("tui.toml")),
                };
                let (status, message) = check_tui_file(&resolved, true);
                let is_error = status == "ERROR";
                println!("Kimi doctor");
                println!();
                print_results(&[(status, "tui.toml".into(), resolved, message)]);
                println!();
                finish_doctor(if is_error { 1 } else { 0 });
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
                let (status, message) = check_config_file(&resolved, true);
                let is_error = status == "ERROR";
                println!("Kimi doctor");
                println!();
                print_results(&[(status, "config.toml".into(), resolved, message)]);
                println!();
                finish_doctor(if is_error { 1 } else { 0 });
                return Ok(());
            }

            // Full doctor (TS parity): the default config.toml + tui.toml.
            println!("Kimi doctor");
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
            println!();

            // File-level checks (TS parity): the default config path and the
            // default tui path; a missing default file is SKIP, not ERROR.
            let config_path = kimi_agent::config::loader::find_config_paths()
                .into_iter()
                .find(|p| p.exists())
                .unwrap_or_else(|| {
                    kimi_agent::config::loader::find_config_paths()
                        .into_iter()
                        .next()
                        .unwrap_or_else(|| std::path::PathBuf::from("config.toml"))
                });
            let (config_status, config_message) = check_config_file(&config_path, false);
            let tui_path =
                tui_config_path().unwrap_or_else(|| std::path::PathBuf::from("tui.toml"));
            let (tui_status, tui_message) = check_tui_file(&tui_path, false);
            let results = vec![
                (config_status, "config.toml".into(), config_path, config_message),
                (tui_status, "tui.toml".into(), tui_path, tui_message),
            ];
            print_results(&results);
            println!();
            finish_doctor(results.iter().filter(|r| r.0 == "ERROR").count());
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
            let (mut client, renderer) = connect_with_renderer(&server, capture, false)?;
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
        Commands::Migrate => {
            // Legacy data migration (~/.kimi -> ~/.kimi-code) is a one-time
            // host-level step owned by the TS distribution; the Rust binary
            // does not bundle the migration engine or screen.
            println!("migrating legacy kimi-cli data is a one-time step handled by the TS distribution:");
            println!("  npm i -g kimi-code@latest && kimi migrate");
            println!("(the Rust distribution does not bundle the legacy migration screen)");
        }
        Commands::Web { port, host, dangerous_bypass_auth, no_open, assets } => {
            // Launch the Rust web server in-process (API + WS + optional SPA
            // assets). This replaces the TS `startRustServerForeground` path;
            // the SPA itself ships with the TS distribution unless `--assets`
            // points at a built `dist-web`.
            run_web(
                &host,
                port,
                dangerous_bypass_auth,
                no_open,
                assets.as_deref(),
            )
            .await?;
        }
        Commands::Vis => {
            // The vis frontend stays in the TS distribution (pure UI); the
            // Rust build has no bundled frontend. Fail loudly rather than
            // pretending to launch.
            eprintln!(
                "the vis frontend ships with the TS distribution (npm wrapper) — not bundled in the Rust build"
            );
            std::process::exit(1);
        }
        Commands::Provider { cmd } => {
            match cmd {
                // `kimi provider list` — configured providers from the engine
                // config (TS parity); apiKey values are masked.
                ProviderCmd::List { json } => {
                    let client = connect(&server)?;
                    let config = client.call(kimi_protocol::methods::CONFIG_GET, serde_json::Value::Null).await;
                    if let Some(error) = config.get("error") {
                        eprintln!("error: {}", error["message"].as_str().unwrap_or("unknown"));
                        std::process::exit(1);
                    }
                    let providers = config["result"]["providers"]
                        .as_object()
                        .cloned()
                        .unwrap_or_default();
                    if json {
                        let masked: serde_json::Map<String, serde_json::Value> = providers
                            .into_iter()
                            .map(|(id, p)| {
                                let mut p = p;
                                if p.get("apiKey").is_some() {
                                    p["apiKey"] = serde_json::json!("***");
                                }
                                (id, p)
                            })
                            .collect();
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&serde_json::Value::Object(masked))
                                .unwrap_or_default()
                        );
                        return Ok(());
                    }
                    let mut ids: Vec<&String> = providers.keys().collect();
                    ids.sort();
                    for id in ids {
                        let p = &providers[id];
                        let provider_type = p["type"].as_str().unwrap_or("");
                        let model = p["model"].as_str().unwrap_or("");
                        let has_key = p.get("apiKey").is_some();
                        println!(
                            "{id}  type={provider_type}  model={model}  apiKey={}",
                            if has_key { "***" } else { "none" }
                        );
                    }
                    if providers.is_empty() {
                        println!("no providers configured — use `kimi provider catalog add <id>` or `kimi provider add <url>`");
                    }
                }
                // `kimi provider add <url>` — import every provider from a
                // registry api.json URL (TS parity; the model catalog is such
                // a registry). Requires an API key.
                ProviderCmd::Add { url, api_key } => {
                    let api_key = api_key
                        .or_else(|| std::env::var("KIMI_REGISTRY_API_KEY").ok());
                    let Some(api_key) = api_key else {
                        eprintln!("Missing API key. Pass --api-key <key> or set KIMI_REGISTRY_API_KEY.");
                        std::process::exit(1);
                    };
                    let trimmed = url.trim();
                    if trimmed.is_empty() {
                        eprintln!("Registry URL is required.");
                        std::process::exit(1);
                    }
                    let catalog =
                        match kimi_sdk::catalog::fetch_catalog(trimmed).await {
                            Ok(c) => c,
                            Err(e) => {
                                eprintln!("Failed to fetch registry: {e}");
                                std::process::exit(1);
                            }
                        };
                    if catalog.is_empty() {
                        eprintln!("Registry at {trimmed} contained no usable providers.");
                        std::process::exit(1);
                    }
                    let mut patch = serde_json::json!({});
                    let mut model_count = 0usize;
                    let mut added = Vec::new();
                    for (id, provider) in &catalog {
                        let provider_type = if id == "anthropic" { "anthropic" } else { "openai" };
                        let base_url = provider.api.clone().unwrap_or_default();
                        if base_url.is_empty() {
                            // Skip providers without an endpoint (same rule as
                            // the catalog-add path).
                            continue;
                        }
                        patch["providers"][id] = serde_json::json!({
                            "type": provider_type,
                            "baseUrl": base_url,
                            "apiKey": api_key,
                        });
                        added.push(id.clone());
                        model_count += provider.models.len();
                    }
                    if added.is_empty() {
                        eprintln!("Registry at {trimmed} contained no usable providers.");
                        std::process::exit(1);
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
                    println!(
                        "Imported {} provider{} ({} model{}) from {trimmed}:",
                        added.len(),
                        if added.len() == 1 { "" } else { "s" },
                        model_count,
                        if model_count == 1 { "" } else { "s" },
                    );
                    for id in &added {
                        println!("  - {id}");
                    }
                }
                // `kimi provider remove <id>` — drop a configured provider
                // (TS parity: unknown ids are an error, not a silent no-op).
                ProviderCmd::Remove { id } => {
                    let client = connect(&server)?;
                    let config = client.call(kimi_protocol::methods::CONFIG_GET, serde_json::Value::Null).await;
                    let exists = config["result"]["providers"][&id]
                        .as_object()
                        .is_some();
                    if !exists {
                        eprintln!("Provider \"{id}\" not found.");
                        std::process::exit(1);
                    }
                    let patch = serde_json::json!({
                        "providers": {
                            id.clone(): null,
                        }
                    });
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
                    println!("Removed provider \"{id}\".");
                }
                ProviderCmd::Catalog { cmd } => match cmd {
                    // `kimi provider catalog list [id] [--filter]` — browse
                    // the models.dev catalog.
                    CatalogCmd::List { provider_id, filter, json, url } => {
                        let catalog_url =
                            url.as_deref().unwrap_or(kimi_sdk::catalog::DEFAULT_CATALOG_URL);
                        match kimi_sdk::catalog::fetch_catalog(catalog_url).await {
                            Ok(catalog) => {
                                if let Some(pid) = provider_id {
                                    let Some(provider) = catalog.get(&pid) else {
                                        eprintln!("error: provider \"{pid}\" not in the catalog");
                                        std::process::exit(1);
                                    };
                                    if json {
                                        println!(
                                            "{}",
                                            serde_json::to_string_pretty(&serde_json::json!({ pid: provider }))
                                                .unwrap_or_default()
                                        );
                                    } else {
                                        println!("{pid}  {}", provider.name);
                                        let mut models: Vec<&String> = provider.models.keys().collect();
                                        models.sort();
                                        for m in models {
                                            println!("    {m}");
                                        }
                                    }
                                    return Ok(());
                                }
                                let filter = filter.map(|f| f.to_lowercase());
                                let mut providers: Vec<_> = catalog.into_iter().collect();
                                providers.sort_by(|a, b| a.0.cmp(&b.0));
                                if let Some(f) = &filter {
                                    providers.retain(|(id, p)| {
                                        id.to_lowercase().contains(f)
                                            || p.name.to_lowercase().contains(f)
                                    });
                                }
                                if json {
                                    let slice: serde_json::Map<_, _> =
                                        providers.into_iter().map(|(id, p)| (id, serde_json::to_value(p).unwrap_or_default())).collect();
                                    println!(
                                        "{}",
                                        serde_json::to_string_pretty(&serde_json::Value::Object(slice))
                                            .unwrap_or_default()
                                    );
                                } else {
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
                    // `kimi provider catalog search <q>` — keyword search.
                    CatalogCmd::Search { query, url } => {
                        let query = query.to_lowercase();
                        let catalog_url =
                            url.as_deref().unwrap_or(kimi_sdk::catalog::DEFAULT_CATALOG_URL);
                        match kimi_sdk::catalog::fetch_catalog(catalog_url).await {
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
                    // `kimi provider catalog add <id>` — import one catalog
                    // provider into the engine config.
                    CatalogCmd::Add { id, api_key, default_model, url, base_url } => {
                        let catalog_url =
                            url.as_deref().unwrap_or(kimi_sdk::catalog::DEFAULT_CATALOG_URL);
                        let catalog =
                            match kimi_sdk::catalog::fetch_catalog(catalog_url).await {
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
                        // Resolve the API key: explicit flag, the provider's
                        // env var, or none (key-less provider for now).
                        let resolved_key = api_key.or_else(|| {
                            provider
                                .env
                                .first()
                                .and_then(|env| std::env::var(env).ok())
                        });
                        // Wire + endpoint decision (kosong
                        // `resolveCatalogImport` parity).
                        let resolution =
                            kimi_sdk::catalog::resolve_catalog_import(provider, base_url.as_deref());
                        let (wire, resolved_base_url) = match &resolution.kind {
                            kimi_sdk::catalog::CatalogImportKind::Ok => {
                                (resolution.wire.clone().expect("ok has wire"), resolution.base_url)
                            }
                            kimi_sdk::catalog::CatalogImportKind::NeedsBaseUrl => {
                                eprintln!(
                                    "error: provider \"{id}\" needs an explicit base URL — pass --base-url <url>"
                                );
                                std::process::exit(1);
                            }
                            kimi_sdk::catalog::CatalogImportKind::Invalid(reason) => {
                                eprintln!(
                                    "error: provider \"{id}\" cannot be imported: {reason:?}"
                                );
                                std::process::exit(1);
                            }
                        };
                        // Normalize the provider's models (models.dev shape →
                        // importable chat models); the aliases are written into
                        // the config so context/capability metadata rides along
                        // without hand-writing.
                        let models = kimi_sdk::catalog::catalog_provider_models(provider);
                        let selected_model_id = default_model
                            .as_deref()
                            .map(str::to_string)
                            .or_else(|| models.first().map(|m| m.id.clone()));
                        let mut config = serde_json::json!({
                            "providers": {},
                            "models": {},
                            "thinking": { "enabled": false },
                        });
                        let default_model_key = match (selected_model_id.as_deref(), models.is_empty()) {
                            (Some(selected), false) => kimi_sdk::catalog::apply_catalog_provider(
                                &mut config,
                                &id,
                                &wire,
                                resolved_base_url.as_deref(),
                                resolved_key.as_deref(),
                                &models,
                                selected,
                                true,
                            ),
                            _ => {
                                // No importable models: fall back to the
                                // provider-only write (key-less providers and
                                // catalog entries without a usable list).
                                let mut provider_cfg = serde_json::json!({ "type": wire });
                                if let Some(base_url) = &resolved_base_url {
                                    provider_cfg["baseUrl"] = serde_json::json!(base_url);
                                }
                                if let Some(key) = resolved_key {
                                    provider_cfg["apiKey"] = serde_json::json!(key);
                                }
                                config["providers"][&id] = provider_cfg;
                                if let Some(model) = &default_model {
                                    config["defaultModel"] = serde_json::json!(model);
                                }
                                default_model.unwrap_or_default()
                            }
                        };
                        let client = connect(&server)?;
                        let body = client
                            .call(
                                kimi_protocol::methods::CONFIG_SET,
                                serde_json::json!({ "patch": config }),
                            )
                            .await;
                        if let Some(error) = body.get("error") {
                            eprintln!("error: {}", error["message"].as_str().unwrap_or("unknown"));
                            std::process::exit(1);
                        }
                        if default_model_key.is_empty() {
                            println!("provider {id} added (baseUrl {})", resolved_base_url.unwrap_or_default());
                        } else {
                            println!(
                                "provider {id} added (baseUrl {}, default model {default_model_key})",
                                resolved_base_url.unwrap_or_default()
                            );
                        }
                    }
                },
            }
        }
        Commands::Export { session_id, output, yes, include_global_log, no_include_global_log } => {
            let include_global_log = include_global_log || !no_include_global_log;
            let client = connect(&server)?;
            // Resolve the session id: explicit, or the most recent session
            // (TS parity: interactive confirm on a TTY, otherwise require
            // `-y` to pick the most recent session).
            let resolved_id = match session_id {
                Some(id) if !id.trim().is_empty() => id,
                _ => {
                    let list = client
                        .call(kimi_protocol::methods::SESSION_LIST, serde_json::json!({ "limit": 1 }))
                        .await;
                    if let Some(error) = list.get("error") {
                        eprintln!("error: {}", error["message"].as_str().unwrap_or("unknown"));
                        std::process::exit(1);
                    }
                    let sessions = list["result"]["sessions"].as_array().cloned().unwrap_or_default();
                    let Some(first) = sessions.into_iter().next() else {
                        eprintln!("No previous session found to export.");
                        std::process::exit(1);
                    };
                    let id = first["id"].as_str().unwrap_or("").to_string();
                    if !yes && std::io::stdin().is_terminal() {
                        // Interactive confirm (TS parity): `Y/n`, default yes.
                        eprint!("Export session {id}? [Y/n] ");
                        std::io::Write::flush(&mut std::io::stderr()).ok();
                        let mut answer = String::new();
                        std::io::stdin().read_line(&mut answer).ok();
                        let answer = answer.trim();
                        if answer.eq_ignore_ascii_case("n") || answer.eq_ignore_ascii_case("no") {
                            println!("Export cancelled.");
                            return Ok(());
                        }
                    } else if !yes {
                        eprintln!(
                            "no session id given; pass one or use -y to pick the most recent session"
                        );
                        std::process::exit(1);
                    }
                    eprintln!("exporting most recent session: {id}");
                    id
                }
            };
            // The global web log (TS parity: bundled by default). The engine
            // `session/export` accepts the log text as `web_log` and packs it
            // into the archive.
            let web_log = if include_global_log {
                let home = kimi_code_home();
                let path = std::path::Path::new(&home).join("logs/global/kimi-code.log");
                std::fs::read_to_string(&path).unwrap_or_default()
            } else {
                String::new()
            };
            let mut params = serde_json::json!({ "session_id": resolved_id });
            if include_global_log && !web_log.is_empty() {
                params["web_log"] = serde_json::json!(web_log);
            }
            let body = client.call(kimi_protocol::methods::SESSION_EXPORT, params).await;
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


