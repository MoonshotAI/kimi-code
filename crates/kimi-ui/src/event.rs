//! Unified engine event source — the future TUI (and the CLI today) consume
//! the same stream whether the engine is embedded (in-process EventBus) or a
//! separate process (Remote stderr fan-out). Both yield `serde_json::Value`
//! events; render helpers turn them into UI lines.

use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader, Lines};

/// A line stream that carries the server's stderr (raw `[event] {json}` lines
/// plus diagnostics). Type-erased so tests can feed `Cursor` buffers and the
/// CLI can feed the spawned server's `ChildStderr`.
pub type EventLines = Lines<BufReader<Box<dyn AsyncRead + Unpin + Send>>>;

/// Where engine events come from.
pub enum EventSource {
    /// In-process: the server's broadcast event bus.
    Bus(tokio::sync::broadcast::Receiver<serde_json::Value>),
    /// Remote: lines from the spawned server's stderr (`[event] {json}`).
    Lines(EventLines),
}

impl EventSource {
    /// Wrap a broadcast receiver (embedded engine).
    pub fn from_bus(rx: tokio::sync::broadcast::Receiver<serde_json::Value>) -> Self {
        Self::Bus(rx)
    }

    /// Wrap an async byte reader (remote server stderr).
    pub fn from_lines<R: AsyncRead + Unpin + Send + 'static>(reader: R) -> Self {
        let boxed: Box<dyn AsyncRead + Unpin + Send> = Box::new(reader);
        Self::Lines(BufReader::new(boxed).lines())
    }

    /// The next parsed event, from either source. `None` when the source
    /// closes. Non-event stderr lines (diagnostics) are skipped.
    pub async fn next(&mut self) -> Option<serde_json::Value> {
        match self {
            EventSource::Bus(rx) => loop {
                match rx.recv().await {
                    Ok(event) => return Some(event),
                    // A lagging consumer re-syncs instead of terminating.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => return None,
                }
            },
            EventSource::Lines(lines) => loop {
                let line = lines.next_line().await.ok().flatten()?;
                // Non-event stderr lines (diagnostics) are skipped, not fatal.
                let Some(json) = line.strip_prefix("[event] ") else {
                    continue;
                };
                if let Ok(event) = serde_json::from_str::<serde_json::Value>(json) {
                    return Some(event);
                }
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn bus_source_yields_events() {
        let (tx, rx) = tokio::sync::broadcast::channel(8);
        let mut source = EventSource::from_bus(rx);
        tx.send(serde_json::json!({ "type": "session.turn.started" })).unwrap();
        let event = source.next().await.expect("event");
        assert_eq!(event["type"], "session.turn.started");
    }

    #[tokio::test]
    async fn lines_source_parses_event_lines_and_skips_diagnostics() {
        let bytes = b"[event] {\"type\":\"session.tool.started\",\"tool_name\":\"Read\"}\n[background] restore failed\n[event] {\"type\":\"session.turn.ended\"}\n";
        let source = EventSource::from_lines(std::io::Cursor::new(bytes.to_vec()));
        let mut source = source;
        let first = source.next().await.expect("first event");
        assert_eq!(first["type"], "session.tool.started");
        // The diagnostics line is skipped; the second event still arrives.
        let second = source.next().await.expect("second event");
        assert_eq!(second["type"], "session.turn.ended");
        assert!(source.next().await.is_none(), "source exhausted");
    }
}
