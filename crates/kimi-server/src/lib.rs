//! Kimi Code host protocol layer — layer 3 of the Rust-first migration.
//!
//! Mirrors codex's `app-server`: the engine (`kimi-core`) is wrapped behind a
//! `MessageProcessor` that dispatches JSON-RPC requests to method-family
//! processors (`request_processors/*`). Every interface (TUI / exec / web /
//! SDK) consumes this protocol — in-process via a bounded channel, or across
//! a transport (stdio / unix socket / websocket, added in stage B3+).

pub mod callbacks;
pub mod in_process;
pub mod processor;
pub mod request_processors;

pub use callbacks::{EventBus, ServerHostCallbacks};
pub use processor::{JsonRpcHandler, MessageProcessor};
