//! Kimi Code command dispatcher — the `kimi` binary, ported from
//! `apps/kimi-code/src/cli`. Stage C slice: `kimi -p <prompt>` (non-interactive
//! run) and `kimi health`. More subcommands (doctor/login/web…) land as the
//! migration progresses.

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
    }
    Ok(())
}
