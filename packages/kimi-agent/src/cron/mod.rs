/// Cron module for the kimi-agent Rust engine.
///
/// This module provides a complete cron scheduling system, ported from the
/// TypeScript implementation in `packages/agent-core/src/tools/cron/` and
/// `packages/agent-core/src/agent/cron/`.
///
/// ## Module structure
///
/// - `types` — Core type definitions (CronTask, ParsedCronExpression, JitterConfig)
/// - `clock` — Clock abstraction (wall clock, injectable test clocks)
/// - `expr` — 5-field cron expression parser and next-fire computation
/// - `jitter` — Anti-herd jitter for distributing cron fire times
/// - `scheduler` — Core scheduling engine (tick loop, coalesced counting)
/// - `store` — In-memory task store
/// - `persist` — Persistence interface and implementations
/// - `manager` — Agent-facing facade (CronManager)
///
/// The module follows the same layering as the TS original:
/// scheduler is the low-level engine, manager is the agent-facing layer
/// that handles persistence, telemetry, and event emission.

pub mod clock;
pub mod expr;
pub mod jitter;
pub mod manager;
pub mod persist;
pub mod scheduler;
pub mod store;
pub mod types;