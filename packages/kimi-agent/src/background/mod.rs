/// Background tasks module for the kimi-agent Rust engine.
///
/// This module provides background task management, ported from
/// `packages/agent-core/src/agent/background/`.
///
/// ## Module structure
///
/// - `types` — Core type definitions (BackgroundTaskStatus, BackgroundTaskInfo, etc.)
/// - `ring_buffer` — Ring buffer for output capture
/// - `managed_task` — ManagedTask internal state tracking
/// - `manager` — BackgroundManager (register, lifecycle, timeout)
/// - `persist` — Persistence interface for task info and output logs
/// - `callbacks` — Process management callback trait (delegates to JS host)

pub mod callbacks;
pub mod managed_task;
pub mod manager;
pub mod persist;
pub mod ring_buffer;
pub mod types;