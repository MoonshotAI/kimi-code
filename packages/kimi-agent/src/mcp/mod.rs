/// MCP (Model Context Protocol) module for the kimi-agent Rust engine.
///
/// Provides core protocol types, HTTP/stdio transports, connection management,
/// and tool naming. Ported from `packages/agent-core/src/mcp/`.

pub mod config;
pub mod connection_manager;
pub mod output;
pub mod tool_naming;
pub mod transport_http;
pub mod transport_stdio;
pub mod types;