/// Discussion module — Multi-agent discussion and debate orchestration.
///
/// Corresponds to `packages/agent-core/src/agent/discussion/`.
///
/// This module provides:
/// - `DiscussionContext`: transcript + position tracking + cross-reference detection
/// - `SwarmDiscussionCoordinator`: roundtable discussion orchestration
/// - `StructuredDebateCoordinator`: multi-phase structured debate orchestration
///
/// Both coordinators are stubbed — they define the data model and coordinator
/// interfaces. The actual sub-agent spawning and turn execution is delegated
/// to host-side callbacks (Rust cannot manage TypeScript subagent sessions directly).
///
/// # Architecture
/// - `DiscussionContext`: pure data — zero dependencies
/// - Coordinators: define the orchestration protocol; host provides execution callbacks
/// - Delegate trait: `DiscussionHostDelegate` bridges to the JS subagent host

mod context;
pub mod coordinator;
pub mod debate;

pub use context::*;
pub use coordinator::*;
pub use debate::*;