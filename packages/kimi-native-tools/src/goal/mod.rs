//! Goal module — state machine, accounting, and steering prompt rendering.
//!
//! Exposed to TypeScript via napi-rs in `napi_bindings.rs`.
//! This module is a pure computational engine — it does not hold persistent
//! state across FFI calls. All state input/output is via JSON strings or
//! flat napi-compatible structs.

pub mod accounting;
pub mod state;
pub mod steering;
