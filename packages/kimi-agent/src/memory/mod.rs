//! `memory` domain — persistent memory search and management.
//!
//! Port of `agent-core-v2/src/app/memory/`: markdown memory files organized
//! by scope (global / project / session) under `~/.kimi-code/memory/`, plus
//! the model-facing `Memory` tool (search/read/write/list/delete).

pub mod paths;
pub mod store;
pub mod tool;

pub use paths::*;
pub use store::MemoryStore;
