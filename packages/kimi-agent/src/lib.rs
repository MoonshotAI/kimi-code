/// kimi-agent — Rust agent engine library.
///
/// Shared library entry point for both the CLI binary (stdio JSON-RPC)
/// and the napi-rs native addon (direct Node.js integration).

pub mod agent;
pub mod background;
pub mod callbacks;
pub mod compaction;
pub mod config;
pub mod context;
pub mod context_injector;
pub mod cron;
pub mod discussion;
pub mod fault_injection;
pub mod permission;
pub mod plan;
pub mod profile;
pub mod prompt;
pub mod question_tools;
pub mod records;
pub mod replay;
pub mod swarm;
pub mod task;
pub mod goal;
pub mod hooks;
pub mod injection;
pub mod knowledge;
pub mod llm;
pub mod mcp;
pub mod media;
#[cfg(feature = "napi")]
pub mod napi_bindings;
pub mod rpc;
pub mod shell_command;
pub mod skill;
pub mod tool_select;
pub mod tools;
pub mod turn_loop;
pub mod usage;
pub mod user_tool;
pub mod activity_view;
pub mod blob;