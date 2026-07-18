/// kimi-agent — Rust agent engine with stdio JSON-RPC bridge.
///
/// Usage:
///   kimi-agent [--health] [--test]

use clap::Parser;

mod hooks;
mod llm;
mod rpc;
mod turn_loop;

use rpc::server::RpcServer;
use rpc::types::{self, HealthStatus, RunTurnResult, TokenUsage};
use turn_loop::types::*;

#[derive(Parser)]
#[command(name = "kimi-agent", version = "0.1.0", about = "Kimi Agent engine (Rust)")]
struct Cli {
    /// Run a health check and exit
    #[arg(long)]
    health: bool,

    /// Run a self-test and exit
    #[arg(long)]
    test: bool,
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

    if cli.test {
        return run_self_test();
    }

    // Build the RPC server and register handlers
    let server = RpcServer::new();

    // Register run_turn handler
    server.register(types::methods::RUN_TURN, |params| {
        let input: types::RunTurnParams = serde_json::from_value(params)
            .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;

        let turn_id = input.turn_id.clone();
        let max_steps = input.max_steps.unwrap_or(10);

        let llm = llm::proxy::HostLlmProxy::new(input.system_prompt, input.model_name);

        let messages: Vec<LLMMessage> = input
            .messages
            .into_iter()
            .map(|m| LLMMessage {
                role: m.role,
                content: m.content,
            })
            .collect();

        let tool_defs: Vec<ToolInfo> = input
            .tools
            .into_iter()
            .map(|t| ToolInfo {
                name: t.name,
                description: t.description,
                input_schema: t.input_schema,
            })
            .collect();

        let tools: Vec<&dyn ExecutableTool> = vec![];

        let run_input = RunTurnInput {
            turn_id: turn_id.clone(),
            llm: &llm,
            messages,
            tools: &tools,
            tool_defs,
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
                    usage: TokenUsage::default(),
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

    eprintln!("kimi-agent ready, listening on stdin/stdout");
    server.run()?;

    Ok(())
}

/// Self-test: runs the turn loop with a mock LLM.
fn run_self_test() -> anyhow::Result<()> {
    eprintln!("Running self-test...");

    // Create a mock LLM that returns a simple response
    let mock_llm = MockLlm {
        system_prompt: "You are a helpful assistant.".into(),
        model_name: "test-model".into(),
    };

    let messages = vec![LLMMessage {
        role: "user".into(),
        content: "Hello!".into(),
    }];

    let input = RunTurnInput {
        turn_id: "test-turn-1".into(),
        llm: &mock_llm,
        messages,
        tools: &[],
        tool_defs: vec![],
        hooks: None,
        max_steps: 5,
    };

    match turn_loop::run_turn::run_turn(input) {
        Ok(result) => {
            eprintln!("  Turn completed: {:?}", result.stop_reason);
            eprintln!("  Steps: {}", result.steps);
            eprintln!("  Usage: {} in / {} out / {} total",
                result.usage.input_tokens,
                result.usage.output_tokens,
                result.usage.total_tokens);
            eprintln!("Self-test PASSED");
            Ok(())
        }
        Err(e) => {
            eprintln!("  Turn failed: {e}");
            eprintln!("Self-test FAILED");
            Err(anyhow::anyhow!("{e}"))
        }
    }
}

/// A mock LLM that returns a fixed response without tool calls.
struct MockLlm {
    system_prompt: String,
    model_name: String,
}

impl LLM for MockLlm {
    fn system_prompt(&self) -> &str {
        &self.system_prompt
    }

    fn model_name(&self) -> &str {
        &self.model_name
    }

    fn is_retryable_error(&self, _error: &str) -> bool {
        false
    }

    fn chat(&self, _params: LLMChatParams) -> Result<LLMChatResponse, Box<dyn std::error::Error>> {
        Ok(LLMChatResponse {
            tool_calls: vec![],
            finish_reason: Some("stop".into()),
            usage: TokenUsage {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15,
            },
        })
    }
}