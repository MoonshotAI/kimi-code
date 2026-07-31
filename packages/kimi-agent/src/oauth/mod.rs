//! OAuth primitives owned by the kimi-agent engine.
//!
//! Currently hosts the PKCE (RFC 7636) verifier/challenge derivation and the
//! loopback callback server, ported from `kimi-native-tools/src/pkce.rs`.
//! These are the building blocks of the MCP OAuth flow that today lives
//! entirely in `packages/agent-core/src/mcp/oauth/`.

pub mod pkce;

pub use pkce::{CallbackParams, LoopbackServer, derive_challenge, generate_verifier};
