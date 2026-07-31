/// Provider-agnostic tool definition.
///
/// Corresponds to `kosong/contract/tool.ts`.
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A tool that the model may invoke during generation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Tool {
    pub name: String,
    pub description: String,
    /// JSON Schema object for the tool's parameters.
    #[serde(default)]
    pub parameters: Value,
    /// When true, this tool is deferred and won't be sent to the provider
    /// (it's handled locally by the runtime).
    #[serde(default, skip_serializing_if = "is_false")]
    pub deferred: bool,
}

fn is_false(b: &bool) -> bool {
    !b
}

impl Tool {
    pub fn new(name: &str, description: &str, parameters: Value) -> Self {
        Self {
            name: name.to_string(),
            description: description.to_string(),
            parameters,
            deferred: false,
        }
    }
}