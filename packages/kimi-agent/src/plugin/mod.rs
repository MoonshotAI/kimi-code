//! Plugin module — lifecycle management for skills, MCP servers, and hooks
//! contributed by external plugins.
//!
//! Mirrors `packages/agent-core/src/plugin/` in the TS engine.
//!
//! A plugin is a directory (or GitHub repo) containing a `plugin.json`
//! manifest that declares skills, MCP server configurations, hooks,
//! and commands the plugin contributes to the agent.

pub mod injector;
pub mod install;
pub mod manifest;
pub mod store;
pub mod types;