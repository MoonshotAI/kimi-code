/// Sensitive-path detection for the permission layer.
///
/// Thin re-export of the shared implementation in `kimi-shared::sensitive`
/// (the single source of truth, extracted 2026-07-31 from
/// `kimi-native-tools::path_access::is_sensitive_file` — which itself mirrors
/// `packages/agent-core/src/tools/policies/sensitive.ts`). This module was
/// previously a "faithful mirror" duplicated here to keep `kimi-agent` free
/// of a `kimi-native-tools` dependency during the Phase 6 decoupling; now the
/// shared crate provides that isolation without duplication.
///
/// The public name here is `is_sensitive_path` (as before); it is an alias
/// for the canonical `kimi_shared::sensitive::is_sensitive_file`.
///
/// Semantics for the permission layer: a false positive only causes an extra
/// approval prompt, while a false negative silently exposes a secret. The
/// shared copy matches the canonical `path_access.rs` behavior.

pub use kimi_shared::sensitive::is_sensitive_file as is_sensitive_path;
