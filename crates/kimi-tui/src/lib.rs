//! Kimi Code interactive TUI — stage D skeleton. A ratatui app driven through
//! `kimi-sdk::Harness`: engine events render into the transcript panel while
//! the user types prompts in the bottom pane. Minimal-but-real: raw-mode
//! terminal, event loop (keyboard + engine events), and a scrollable chat
//! view. The full chatwidget/bottom-pane surface lands incrementally.

pub mod approval;
pub mod app;
pub mod bottom_pane;
pub mod chatwidget;
pub mod clipboard;
pub mod diff;
pub mod editor;
pub mod footer;
pub mod goal_queue;
pub mod history;
pub mod i18n;
pub mod markdown;
pub mod media;
pub mod modal;
pub mod panel;
pub mod picker;
pub mod question;
pub mod reports;
pub mod streaming;
pub mod theme;
pub mod util;

pub use app::App;
