pub mod anthropic;
pub mod google_genai;
pub mod http;
pub mod multi;
pub mod openai;
pub mod proxy;
pub mod request_logger;
pub mod request_recorder;
pub mod wire;

/// A streaming delta produced by a provider accumulator, tagged with its
/// channel. Text deltas become assistant content; thinking deltas carry the
/// model's chain-of-thought, which is forwarded to the host for the
/// `thinking.delta` UI stream but never enters the context transcript.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamDelta {
    /// Visible assistant text (`content` / `text_delta`).
    Text(String),
    /// Model reasoning (`reasoning_content` / `thinking_delta` / `thought`).
    Thinking(String),
    /// A tool call whose arguments are streaming in: `args` is the
    /// **accumulated** partial JSON so far (each event carries the full
    /// running value, not a fragment — hosts replace, not append). Surfaced
    /// to the host as `llm.delta` with `part.type == "tool_call"` so the TUI
    /// can preview arguments while the call is still forming.
    ToolCall {
        id: String,
        name: String,
        args: String,
    },
}