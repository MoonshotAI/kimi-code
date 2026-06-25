#![deny(clippy::all)]

mod bash;
mod edit;
mod file_type;
mod glob;
mod grep;
mod line_endings;
mod list_directory;
mod napi_bindings;
mod read;
mod tokens;
mod write;

pub use napi_bindings::*;
