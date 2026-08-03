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
    },
    /// List persisted sessions.
    Sessions {
        /// Max sessions to list.
        #[arg(default_value_t = 50)]
        limit: u32,
    },
    /// Engine health check.
    Health,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Print { prompt } => {
            let result = kimi_exec::run_prompt_in_process(&prompt).await?;
            if let Some(error) = result.get("error") {
                eprintln!("error: {}", error["message"].as_str().unwrap_or("unknown"));
                std::process::exit(1);
            }
            println!("{result}");
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
