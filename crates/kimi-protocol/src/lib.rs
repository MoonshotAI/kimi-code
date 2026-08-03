//! Kimi Code wire protocol — layer 1 of the Rust-first migration.
//!
//! Pure types (zero I/O) for the JSON-RPC contract, session events, and
//! config shapes. Everything here is `serde`-serializable and has no
//! dependency on the engine (`kimi-core`) or any host crate; the engine and
//! every interface layer consume these types. TS bindings are generated
//! (ts-rs / schemars) rather than hand-maintained.

pub mod context;
pub mod goal;
pub mod hooks;
pub mod methods;
pub mod plan;
pub mod rpc;
pub mod task;
pub mod usage;
pub mod wire_types;
