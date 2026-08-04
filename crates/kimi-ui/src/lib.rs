//! Kimi Code UI primitives — render helpers shared by every interface layer
//! (CLI today, TUI next). Pure functions over the wire shapes, so they are
//! unit-testable without a running engine.

pub mod event;
pub mod render;

pub use event::EventSource;
pub use render::{last_assistant_text, render_event, stream_delta};
