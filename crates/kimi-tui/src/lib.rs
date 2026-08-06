//! Kimi Code interactive TUI — stage D skeleton. A ratatui app driven through
//! `kimi-sdk::Harness`: engine events render into the transcript panel while
//! the user types prompts in the bottom pane. Minimal-but-real: raw-mode
//! terminal, event loop (keyboard + engine events), and a scrollable chat
//! view. The full chatwidget/bottom-pane surface lands incrementally.

pub mod app;
pub mod bottom_pane;
pub mod chatwidget;
pub mod markdown;
pub mod picker;
pub mod theme;

pub use app::App;
