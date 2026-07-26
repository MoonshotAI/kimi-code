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

pub mod manager;
pub mod matches_rule;
pub mod policies;
pub mod types;