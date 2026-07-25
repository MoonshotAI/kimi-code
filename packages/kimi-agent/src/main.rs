/// kimi-agent — Rust agent engine with stdio JSON-RPC bridge.
///
/// Usage:
///   kimi-agent [--health] [--test]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};

use clap::Parser;

use kimi_agent::{
    callbacks::{HostCallbacks, RpcHostCallbacks},
    llm::{proxy::HostLlmProxy, multi::{LlmProvider, MultiLLM}},
    rpc::{
        server::RpcServer,
        types::{self, CancelTurnParams, HealthStatus, RunTurnResult, TokenUsage},
    },
    turn_loop::{types::*, run_turn::run_turn},
};

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

#[tokio::main]
async fn main() -> anyhow::Result<()> {
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
        return run_self_test().await;
    }

    // Build the RPC server and register handlers
    let server = Arc::new(RpcServer::new());

    // Shared map of turn_id → cancellation flag, so CANCEL_TURN can
    // signal a running turn to abort before its next step.
    let cancel_map: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    // Register run_turn handler
    let s = server.clone();
    let cm = cancel_map.clone();
    RpcServer::register_arc(
        &s.clone(),
        types::methods::RUN_TURN,
        move |params| {
            let server = s.clone();
            let cancel_map = cm.clone();
            Box::pin(async move {
                let input: types::RunTurnParams = serde_json::from_value(params)
                    .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;

                let turn_id = input.turn_id.clone();
                let max_steps = input.max_steps.unwrap_or(10);

                // Create and register a cancellation flag for this turn.
                let cancel_flag = Arc::new(AtomicBool::new(false));
                {
                    let mut map = cancel_map.lock().unwrap();
                    map.insert(turn_id.clone(), cancel_flag.clone());
                }

                // Build the HostCallbacks from the RPC server.
                let callbacks: Arc<dyn HostCallbacks> = Arc::new(
                    RpcHostCallbacks { server: server.clone() },
                );

                // Build the LLM — single provider or MultiLLM
                let llm: Box<dyn LLM> = if input.providers.is_empty() {
                    Box::new(
                        HostLlmProxy::new(input.system_prompt.clone(), input.model_name.clone())
                            .with_callbacks(callbacks.clone()),
                    )
                } else {
                    let providers: Vec<LlmProvider> = input
                        .providers
                        .iter()
                        .map(|p| LlmProvider {
                            name: p.name.clone(),
                            system_prompt: p.system_prompt.clone(),
                            model: p.model.clone(),
                            callbacks: callbacks.clone(),
                        })
                        .collect();
                    let multi = MultiLLM::new(providers);
                    Box::new(multi)
                };

                let messages: Vec<LLMMessage> = input
                    .messages
                    .into_iter()
                    .map(|m| LLMMessage {
                        role: m.role,
                        content: m.content,
                        ..Default::default()
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
                    llm: &*llm,
                    messages,
                    tools: &tools,
                    tool_defs,
                    hooks: None,
                    max_steps,
                    goal: input.goal,
                    cancellation: Some(cancel_flag.clone()),
                };

                let result = run_turn(run_input, &callbacks).await;

                // Clean up the cancellation flag.
                {
                    let mut map = cancel_map.lock().unwrap();
                    map.remove(&turn_id);
                }

                match result {
                    Ok(res) => {
                        let output = RunTurnResult {
                            stop_reason: format!("{:?}", res.stop_reason),
                            steps: res.steps,
                            usage: res.usage,
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
            })
        },
    );

    // Register cancel_turn handler
    let cm = cancel_map.clone();
    RpcServer::register_arc(
        &server,
        types::methods::CANCEL_TURN,
        move |params| {
            let cancel_map = cm.clone();
            Box::pin(async move {
                let input: CancelTurnParams = serde_json::from_value(params)
                    .map_err(|e| types::JsonRpcError::internal_error(format!("Invalid params: {e}")))?;

                let cancelled = {
                    let map = cancel_map.lock().unwrap();
                    if let Some(flag) = map.get(&input.turn_id) {
                        flag.store(true, Ordering::Relaxed);
                        true
                    } else {
                        false
                    }
                };

                let result = serde_json::json!({ "cancelled": cancelled });
                Ok(result)
            })
        },
    );

    // Register health handler
    RpcServer::register_arc(
        &server,
        types::methods::HEALTH,
        |_| {
            Box::pin(async move {
                let status = HealthStatus {
                    status: "ok".into(),
                    version: "0.1.0".into(),
                };
                serde_json::to_value(&status)
                    .map_err(|e| types::JsonRpcError::internal_error(format!("Serialization error: {e}")))
            })
        },
    );

    // Register shutdown handler
    RpcServer::register_arc(
        &server,
        types::methods::SHUTDOWN,
        |_| {
            Box::pin(async move {
                std::process::exit(0);
            })
        },
    );

    eprintln!("kimi-agent ready, listening on stdin/stdout");

    // Handlers hold Arc clones of the server (self-referential by design: the
    // RUN_TURN handler captures a server clone to spawn tool/LLM callbacks), so
    // the strong count is never 1 here. Keep the Arc and run on it directly.
    server.run().await
}

/// Self-test: runs the turn loop with a mock LLM.
async fn run_self_test() -> anyhow::Result<()> {
    eprintln!("Running self-test...");

    // Create a mock LLM that returns a simple response
    let mock_llm = MockLlm {
        system_prompt: "You are a helpful assistant.".into(),
        model_name: "test-model".into(),
    };

    let messages = vec![LLMMessage {
        role: "user".into(),
        content: "Hello!".into(),
        ..Default::default()
    }];

    let input = RunTurnInput {
        turn_id: "test-turn-1".into(),
        llm: &mock_llm,
        messages,
        tools: &[],
        tool_defs: vec![],
        hooks: None,
        max_steps: 5,
        goal: None,
        cancellation: None,
    };

    // Create a minimal server for the test
    let server = Arc::new(RpcServer::new());
    let callbacks: Arc<dyn HostCallbacks> = Arc::new(
        RpcHostCallbacks { server },
    );

    let result = run_turn(input, &callbacks).await;

    match result {
        Ok(res) => {
            eprintln!("  Turn completed: {:?}", res.stop_reason);
            eprintln!("  Steps: {}", res.steps);
            eprintln!(
                "  Usage: {} in / {} out / {} total",
                res.usage.input_tokens,
                res.usage.output_tokens,
                res.usage.total_tokens
            );
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
#[allow(dead_code)]
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

    fn chat(&self, _params: LLMChatParams) -> kimi_agent::rpc::types::BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>> {
        Box::pin(async move {
            Ok(LLMChatResponse {
                tool_calls: vec![],
                finish_reason: Some("stop".into()),
                usage: TokenUsage {
                    input_tokens: 10,
                    output_tokens: 5,
                    total_tokens: 15,
                },
            })
        })
    }
}