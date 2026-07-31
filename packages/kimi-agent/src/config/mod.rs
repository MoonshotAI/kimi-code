/// Config module for the kimi-agent Rust engine.
///
/// Provides core configuration types and parsing logic.
/// Ported from `packages/agent-core/src/config/`.
///
/// Scope: pure data types + TOML parsing + merge logic.
/// File I/O and Zod schema validation remain on the JS side.

pub mod env_model;
pub mod loader;
pub mod merge;
pub mod native_llm;
pub mod toml;
pub mod types;