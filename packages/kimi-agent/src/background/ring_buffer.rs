/// Ring buffer for background task output capture.
///
/// Maintains an in-memory circular buffer of output bytes with a configurable
/// maximum capacity. When the cap is exceeded, the oldest data is dropped.
///
/// The ring buffer is intended for the `/tasks` UI and terminal notifications
/// only — it deliberately discards old output to cap memory. The complete,
/// never-truncated log lives on disk at `<sessionDir>/tasks/<id>/output.log`.

use std::collections::VecDeque;

/// Default maximum bytes kept in the in-memory ring buffer per task.
const DEFAULT_MAX_OUTPUT_BYTES: usize = 1024 * 1024; // 1 MiB

/// The ring buffer.
#[derive(Debug, Clone)]
pub struct OutputRingBuffer {
    /// Backing store: the raw bytes currently in the buffer.
    buffer: VecDeque<u8>,
    /// Maximum capacity in bytes.
    capacity: usize,
    /// Total bytes seen (including dropped ones).
    total_bytes_seen: u64,
}

impl OutputRingBuffer {
    /// Create a new ring buffer with the default capacity (1 MiB).
    pub fn new() -> Self {
        Self::with_capacity(DEFAULT_MAX_OUTPUT_BYTES)
    }

    /// Create a new ring buffer with a specific capacity.
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            buffer: VecDeque::with_capacity(capacity.min(4096)),
            capacity,
            total_bytes_seen: 0,
        }
    }

    /// Append a chunk of output to the ring buffer.
    /// If the buffer would exceed capacity, the oldest bytes are dropped.
    pub fn append(&mut self, chunk: &str) {
        let bytes = chunk.as_bytes();
        self.total_bytes_seen = self.total_bytes_seen.wrapping_add(bytes.len() as u64);

        // If the chunk alone is larger than capacity, only keep the tail
        if bytes.len() > self.capacity {
            // Reset buffer with just the tail
            let tail = &bytes[bytes.len() - self.capacity..];
            self.buffer.clear();
            self.buffer.extend(tail);
            return;
        }

        // Drop oldest bytes to make room
        while self.buffer.len() + bytes.len() > self.capacity {
            self.buffer.pop_front();
        }

        self.buffer.extend(bytes);
    }

    /// Get the current content as a string.
    pub fn snapshot(&self) -> String {
        String::from_utf8_lossy(&self.buffer.iter().copied().collect::<Vec<_>>()).to_string()
    }

    /// Get a preview of the first N bytes.
    pub fn preview(&self, max_bytes: usize) -> String {
        let len = self.buffer.len().min(max_bytes);
        let bytes: Vec<u8> = self.buffer.iter().take(len).copied().collect();
        String::from_utf8_lossy(&bytes).to_string()
    }

    /// Current number of bytes in the buffer.
    pub fn len(&self) -> usize {
        self.buffer.len()
    }

    /// Returns true if the buffer is empty.
    pub fn is_empty(&self) -> bool {
        self.buffer.is_empty()
    }

    /// Total bytes seen (including dropped ones).
    pub fn total_bytes_seen(&self) -> u64 {
        self.total_bytes_seen
    }

    /// Clear the buffer.
    pub fn clear(&mut self) {
        self.buffer.clear();
    }

    /// Maximum capacity of this buffer.
    pub fn capacity(&self) -> usize {
        self.capacity
    }
}

impl Default for OutputRingBuffer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty() {
        let buf = OutputRingBuffer::new();
        assert!(buf.is_empty());
        assert_eq!(buf.len(), 0);
        assert_eq!(buf.snapshot(), "");
    }

    #[test]
    fn test_append_small() {
        let mut buf = OutputRingBuffer::new();
        buf.append("hello");
        assert_eq!(buf.len(), 5);
        assert_eq!(buf.snapshot(), "hello");
    }

    #[test]
    fn test_append_multiple() {
        let mut buf = OutputRingBuffer::new();
        buf.append("hello ");
        buf.append("world");
        assert_eq!(buf.snapshot(), "hello world");
    }

    #[test]
    fn test_capacity_enforced() {
        let mut buf = OutputRingBuffer::with_capacity(10);
        buf.append("hello ");
        assert_eq!(buf.len(), 6);
        buf.append("world!!!");
        // "hello " + "world!!!" = 14 bytes, capacity is 10, so oldest 4 dropped
        assert_eq!(buf.len(), 10);
        let snap = buf.snapshot();
        assert!(snap.contains("world!!!"));
        // "hello " should be trimmed
        assert!(!snap.contains("hello"));
    }

    #[test]
    fn test_chunk_larger_than_capacity() {
        let mut buf = OutputRingBuffer::with_capacity(10);
        buf.append("this is a very long string that exceeds capacity");
        assert_eq!(buf.len(), 10);
        // Should be the last 10 bytes
        assert_eq!(buf.snapshot(), "s capacity");
    }

    #[test]
    fn test_total_bytes_seen() {
        let mut buf = OutputRingBuffer::with_capacity(10);
        buf.append("hello");
        assert_eq!(buf.total_bytes_seen(), 5);
        buf.append("worldmore");
        assert_eq!(buf.total_bytes_seen(), 14);
    }

    #[test]
    fn test_preview() {
        let mut buf = OutputRingBuffer::with_capacity(100);
        buf.append("hello world this is a test");
        let preview = buf.preview(11);
        assert_eq!(preview, "hello world");
    }

    #[test]
    fn test_clear() {
        let mut buf = OutputRingBuffer::new();
        buf.append("hello");
        assert!(!buf.is_empty());
        buf.clear();
        assert!(buf.is_empty());
    }
}