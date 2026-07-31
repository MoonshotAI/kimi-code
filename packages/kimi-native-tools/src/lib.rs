#![deny(clippy::all)]
// FFI crate: many `pub` items are cross-language API surface, test-only helpers,
// or implemented-but-not-yet-wired features whose use Rust's dead_code analysis
// cannot see from the JS side. Silence those reports without deleting the impls.
#![allow(dead_code)]

mod activity_view;
mod bash;
mod byte_lru_cache;
mod canonical_args;
mod compaction_handoff;
mod compaction;
mod context_transcript;
mod context_ops;
mod context_projector;
mod edit;

mod escape;
mod fault_injection;
mod fetch_url;
mod file_cache;
mod file_type;
mod glob;
mod github;
mod goal;
mod grep;
mod image_compress;
mod knowledge;
mod line_endings;
mod list_directory;
mod llm_requester;
mod llm_stream;
mod loop_event_fold;
mod mcp;
mod mcp_http;
mod mcp_registry;
mod mcp_sse;
mod napi_bindings;
mod output_truncate;
mod path_access;
mod permission;
mod permission_rules;
pub use kimi_shared::pkce;
mod prompt_metadata;
mod read;
mod render_prompt;
mod translation;
mod tool_access;
mod tool_dedup;
mod tool_naming;
mod tool_policy;
mod tokens;
mod usage;
mod web_search;
mod webp_animated;
mod workspace_index;
mod write;

pub use napi_bindings::*;
