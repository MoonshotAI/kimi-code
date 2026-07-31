/// Permission module for the kimi-agent Rust engine.
///
/// This module provides a permission policy engine, ported from
/// `packages/agent-core/src/agent/permission/`.
///
/// ## Module structure
///
/// - `types` — Core type definitions (PermissionRule, PermissionMode, Policy trait)
/// - `matches_rule` — DSL parser and rule matching
/// - `policies` — 20 permission policies organized by category
/// - `manager` — PermissionManager (policy chain evaluation)
/// - `state` — Shared interior-mutable state (rules, approvals, mode)
/// - `gate` — Cloneable front-end for the tool execution path
/// - `sensitive_path` — Sensitive-file detection for the file-access policy

pub mod gate;
pub mod manager;
pub mod matches_rule;
pub mod policies;
pub mod sensitive_path;
pub mod state;
pub mod types;