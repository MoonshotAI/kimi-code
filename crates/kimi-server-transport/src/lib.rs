//! Kimi Code host protocol transports — layer 3.
//!
//! Each transport serves the same `MessageProcessor` over a different
//! byte stream, mirroring codex's `app-server-transport`: stdio (the engine's
//! current entry), unix socket, and websocket. The in-process path needs no
//! transport — `kimi_server::in_process` bridges the same envelope directly.

pub mod stdio;
