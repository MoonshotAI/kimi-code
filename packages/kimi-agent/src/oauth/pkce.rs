//! PKCE (Proof Key for Code Exchange, RFC 7636) + loopback OAuth callback server.
//!
//! Thin re-export of the shared implementation in `kimi-shared::pkce` (the
//! single source of truth, extracted 2026-07-31 from
//! `kimi-native-tools/src/pkce.rs`; this module was previously a verbatim
//! copy of it). Kept as a module path so existing callers of
//! `crate::oauth::pkce` / `oauth::pkce::*` keep compiling unchanged.

pub use kimi_shared::pkce::*;
