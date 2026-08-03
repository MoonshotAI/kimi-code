//! Tool definition types.
//! Mirrors `packages/kosong/src/tool.ts`.

use napi_derive::napi;

/// A tool definition passed to the LLM.
#[napi(object)]
pub struct Tool {
    pub name: String,
    pub description: Option<String>,
    /// JSON schema for the tool's parameters
    pub parameters: Option<String>,
    /// Whether this tool is deferred (not sent in top-level tools[])
    pub deferred: Option<bool>,
}