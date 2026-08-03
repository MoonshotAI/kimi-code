//! Kimi Code command dispatcher — the `kimi` binary, ported from
//! `apps/kimi-code/src/cli`. Stage C slice: `kimi -p <prompt>` (non-interactive
//! run), `kimi health`, `kimi export`. More subcommands (doctor/login/web…)
//! land as the migration progresses.

use base64::Engine;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "kimi", version, about = "Kimi Code CLI (Rust-first)")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
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
    },
    /// List persisted sessions.
    Sessions {
        /// Max sessions to list.
        #[arg(default_value_t = 50)]
        limit: u32,
    },
    /// Resume a session and run a prompt on it.
    Resume {
        /// Session id to resume.
        session_id: String,
        /// The prompt to run.
        prompt: String,
    },
    /// Show the current engine config (model/provider).
    Config,
    /// Environment + config diagnostics.
    Doctor,
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
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Print { prompt, verbose } => {
            if verbose {
                let server = kimi_server::Server::build()?;
                let mut events = server.state.subscribe_events();
                let mut client = kimi_server_client::AppServerClient::InProcess(
                    kimi_server::in_process::spawn(server.processor),
                );
                let spawned = tokio::spawn(async move {
                    let mut lines = 0usize;
                    while let Ok(event) = events.recv().await {
                        eprintln!("[event] {}", serde_json::to_string(&event).unwrap_or_default());
                        lines += 1;
                        if lines > 64 {
                            break; // bound verbose output
                        }
                    }
                });
                let result = kimi_exec::run_prompt(&mut client, "kimi-exec", &prompt, kimi_exec::native_llm_from_config()).await;
                spawned.abort();
                if let Some(error) = result.get("error") {
                    eprintln!("error: {}", error["message"].as_str().unwrap_or("unknown"));
                    std::process::exit(1);
                }
                println!("{result}");
            } else {
                let result = kimi_exec::run_prompt_in_process(&prompt).await?;
                if let Some(error) = result.get("error") {
                    eprintln!("error: {}", error["message"].as_str().unwrap_or("unknown"));
                    std::process::exit(1);
                }
                println!("{result}");
            }
        }
        Commands::Sessions { limit } => {
            let server = kimi_server::Server::build()?;
            let mut client = kimi_server_client::AppServerClient::InProcess(
                kimi_server::in_process::spawn(server.processor),
            );
            let body = client.session_list(limit).await;
            if let Some(error) = body.get("error") {
                eprintln!("error: {}", error["message"].as_str().unwrap_or("unknown"));
                std::process::exit(1);
            }
            for session in body["result"]["sessions"].as_array().unwrap_or(&vec![]) {
                println!("{}  {}", session["id"], session["title"]);
            }
        }
        Commands::Resume { session_id, prompt } => {
            let server = kimi_server::Server::build()?;
            let mut client = kimi_server_client::AppServerClient::InProcess(
                kimi_server::in_process::spawn(server.processor),
            );
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
                .call(
                    kimi_protocol::methods::SESSION_PROMPT,
                    serde_json::json!({
                        "session_id": session_id,
                        "input": [{ "type": "text", "text": prompt }],
                    }),
                )
                .await;
            if let Some(error) = result.get("error") {
                eprintln!("error: {}", error["message"].as_str().unwrap_or("unknown"));
                std::process::exit(1);
            }
            println!("{result}");
        }
        Commands::Config => {
            let server = kimi_server::Server::build()?;
            let mut client = kimi_server_client::AppServerClient::InProcess(
                kimi_server::in_process::spawn(server.processor),
            );
            let config = client
                .call(kimi_protocol::methods::CONFIG_GET, serde_json::Value::Null)
                .await;
            if let Some(error) = config.get("error") {
                eprintln!("error: {}", error["message"].as_str().unwrap_or("unknown"));
                std::process::exit(1);
            }
            println!("{}", serde_json::to_string_pretty(&config["result"]).unwrap_or_default());
        }
        Commands::Doctor => {
            let server = kimi_server::Server::build()?;
            let mut client = kimi_server_client::AppServerClient::InProcess(
                kimi_server::in_process::spawn(server.processor),
            );
            let health = client.health().await;
            println!("health: {}", health["result"]["status"].as_str().unwrap_or("?"));
            let config = client.call(kimi_protocol::methods::CONFIG_GET, serde_json::Value::Null).await;
            if let Some(error) = config.get("error") {
                println!("config: error — {}", error["message"].as_str().unwrap_or("unknown"));
            } else {
                let model = config["result"]["model"].as_str().unwrap_or("");
                let provider = config["result"]["provider"].as_str().unwrap_or("");
                println!("config: model={model} provider={provider}");
            }
        }
        Commands::Health => {
            let server = kimi_server::Server::build()?;
            let mut client = kimi_server_client::AppServerClient::InProcess(
                kimi_server::in_process::spawn(server.processor),
            );
            let body = client.health().await;
            println!("{}", body["result"]["status"].as_str().unwrap_or("?"));
        }
        Commands::Export { session_id, output, yes } => {
            let server = kimi_server::Server::build()?;
            let mut client = kimi_server_client::AppServerClient::InProcess(
                kimi_server::in_process::spawn(server.processor),
            );
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
