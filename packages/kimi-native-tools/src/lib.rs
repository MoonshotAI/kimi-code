#![deny(clippy::all)]

mod bash;
mod compaction;
mod edit;

mod escape;
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
mod llm_stream;
mod mcp;
mod napi_bindings;
mod output_truncate;
mod path_access;
mod permission;
mod read;
mod translation;
mod tool_access;
mod tokens;
mod tool_naming;
mod web_search;
mod workspace_index;
mod write;

pub use napi_bindings::*;
