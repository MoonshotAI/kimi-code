//! `kimi-shared` — pure logic shared between `kimi-native-tools` (napi bridge)
//! and `kimi-agent` (main engine), extracted to a napi-free common crate.
//!
//! Both consumers depend on this crate instead of each other; neither the
//! napi-rs toolchain nor any other `kimi-*` crate may appear here.

pub mod line_endings;
pub mod pkce;
pub mod sensitive;
pub mod tokens;
