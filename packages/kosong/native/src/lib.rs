//! kosong-native — Rust LLM provider layer for Kimi Code.
//!
//! Replaces the TypeScript kosong package with native Rust implementations
//! to reduce JS ↔ Rust serialization overhead and improve LLM request throughput.

#![deny(clippy::all)]

pub mod anthropic;
pub mod errors;
pub mod generate;
pub mod google_genai;
pub mod http;
pub mod merge_user_messages;
pub mod message;
pub mod openai;
pub mod provider;
pub mod tool;
pub mod tool_call_id;
pub mod usage;

use napi_derive::napi;

/// Initialize the native module. Called once at JS import time.
#[napi]
pub fn init() -> napi::Result<()> {
    Ok(())
}

/// Get the native library version.
#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

// Re-export key types at the crate root for convenient JS imports.
pub use message::*;
pub use provider::*;
pub use tool::*;