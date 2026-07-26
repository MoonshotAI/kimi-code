/// Context module — message history management, projection, and token estimation.
///
/// Corresponds to `packages/agent-core/src/agent/context/` in the TS codebase.

pub mod compaction_handoff;
pub mod context_memory;
pub mod context_ops;
pub mod dynamic_tools;
pub mod loop_event_fold;
pub mod notification_xml;
pub mod projector;
pub mod scope;
pub mod size;
pub mod tokenizer;
pub mod tool_result_render;
pub mod types;
pub mod vacuous_content;