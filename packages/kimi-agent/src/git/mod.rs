//! `git` domain — git integration for a repository on the local disk.
//!
//! Port of `agent-core-v2/src/app/git/`: status / diff against a repository
//! identified by an absolute `cwd`, spawning `git` / `gh` directly.

pub mod context;
pub mod parsers;
pub mod service;

pub use context::collect_git_context;
pub use parsers::*;
pub use service::{GitError, GitService, absolutize};
