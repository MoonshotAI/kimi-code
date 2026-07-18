/// kimi-agent — Rust agent engine with stdio JSON-RPC bridge.
///
/// Usage:
///   kimi-agent [--version]
///
/// Normal operation reads JSON-RPC 2.0 requests from stdin and writes
/// responses/notifications to stdout.

use clap::Parser;

mod hooks;
mod llm;
mod rpc;
mod turn_loop;

use rpc::server::RpcServer;
use rpc::types::{self, HealthStatus, RunTurnResult};
use turn_loop::types::*;

#[derive(Parser)]
#[command(name = "kimi-agent", version = "0.1.0", about = "Kimi Agent engine (Rust)")]
struct Cli {
    /// Run a health check and exit
    #[arg(long)]
    health: bool,
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    if cli.health {
        let status = HealthStatus {
            status: "ok".into(),
            version: "0.1.0".into(),
        };
        println!("{}", serde_json::to_string(&status)?);
        return Ok(());
    }

    // Build the RPC server and register handlers
    let server = RpcServer::new();

    // Register run_turn handler — wires to the real Rust run_turn() loop
    server.register(types::methods::RUN_TURN, |params| {
        let input: types::RunTurnParams = serde_json::from_value(params)
            .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;

        let turn_id = input.turn_id.clone();
        let max_steps = input.max_steps.unwrap_or(10);

        // Create the LLM proxy
        let llm = llm::proxy::HostLlmProxy::new(input.system_prompt, input.model_name);

        // Convert messages
        let messages: Vec<LLMMessage> = input
            .messages
            .into_iter()
            .map(|m| LLMMessage {
                role: m.role,
                content: m.content,
            })
            .collect();

        // Tools are empty for now — the JS side handles tool execution
        let tools: Vec<&dyn ExecutableTool> = vec![];

        // Run the turn
        let run_input = RunTurnInput {
            turn_id: turn_id.clone(),
            llm: &llm,
            messages,
            tools: &tools,
            hooks: None,
            max_steps,
        };

        match turn_loop::run_turn::run_turn(run_input) {
            Ok(result) => {
                let output = RunTurnResult {
                    stop_reason: format!("{:?}", result.stop_reason),
                    steps: result.steps,
                    usage: result.usage,
                };
                serde_json::to_value(&output).map_err(|e| {
                    types::JsonRpcError::internal_error(format!("Serialization error: {e}"))
                })
            }
            Err(e) => {
                let output = RunTurnResult {
                    stop_reason: format!("Error: {e}"),
                    steps: 0,
                    usage: types::TokenUsage::default(),
                };
                serde_json::to_value(&output).map_err(|_| {
                    types::JsonRpcError::internal_error(format!("Turn failed: {e}"))
                })
            }
        }
    });

    // Register health handler
    server.register(types::methods::HEALTH, |_| {
        let status = HealthStatus {
            status: "ok".into(),
            version: "0.1.0".into(),
        };
        serde_json::to_value(&status)
            .map_err(|e| types::JsonRpcError::internal_error(format!("Serialization error: {e}")))
    });

    // Register shutdown handler
    server.register(types::methods::SHUTDOWN, |_| {
        std::process::exit(0);
    });

    // Run the server
    eprintln!("kimi-agent ready, listening on stdin/stdout");
    server.run()?;

    Ok(())
}