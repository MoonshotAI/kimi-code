/// L0 contract: provider-agnostic wire protocol types.
///
/// Pure types and pure functions only — no I/O, no SDKs, no other domains.
/// Corresponds to `packages/agent-core-v2/src/kosong/contract/`.
pub mod capability;
pub mod errors;
pub mod generate;
pub mod inspection;
pub mod message;
pub mod provider;
pub mod request_trace;
pub mod tokens;
pub mod tool;
pub mod usage;