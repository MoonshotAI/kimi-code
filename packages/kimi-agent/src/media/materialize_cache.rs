/// Byte-bounded memo of downloaded `kimi://file/<id>` materialisation.
///
/// Kimi file URLs are content-addressed: `<id>` names an immutable host-side
/// artifact, so the same URL always yields the same bytes. `materialize_kimi_media`
/// runs on every turn, and without this cache a file referenced across turns is
/// downloaded over the network and base64-encoded once per turn. The cache keys
/// on `file_id` and stores the final `(mime, base64)` payload — the expensive
/// network + encode work is paid at most once per process per file.

use std::collections::{HashMap, VecDeque};

/// Cached materialisation: `(mime, base64)` — the exact value
/// `materialize_kimi_media` inserts into its projection map.
type Entry = (String, String);

/// A simple FIFO byte-bounded cache. FIFO (not LRU) is enough here: media
/// files are large and sessions typically reference a small working set, so
/// insertion-order eviction keeps the hot images resident without the book-
/// keeping of an LRU.
pub struct MaterializeCache {
    max_bytes: usize,
    current_bytes: usize,
    entries: HashMap<String, Entry>,
    order: VecDeque<String>,
}

impl MaterializeCache {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            max_bytes,
            current_bytes: 0,
            entries: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    /// Look up a file's cached materialisation.
    pub fn get(&mut self, file_id: &str) -> Option<&Entry> {
        self.entries.get(file_id)
    }

    /// Cache a materialisation, evicting oldest entries while over budget.
    /// A single payload larger than the whole budget is not cached.
    pub fn insert(&mut self, file_id: &str, mime: String, base64: String) {
        if base64.len() > self.max_bytes {
            return;
        }
        if let Some((old_mime, old_payload)) = self.entries.remove(file_id) {
            self.current_bytes = self.current_bytes.saturating_sub(old_mime.len() + old_payload.len());
            // Replace in place: keep the original insertion position. Re-pushing
            // would both grow `order` unboundedly and — on eviction — pop a key
            // that maps to the just-updated live entry, ejecting a hot file.
        } else {
            self.order.push_back(file_id.to_string());
        }
        self.entries.insert(file_id.to_string(), (mime.clone(), base64.clone()));
        self.current_bytes += mime.len() + base64.len();

        while self.current_bytes > self.max_bytes {
            let Some(oldest) = self.order.pop_front() else { break };
            if let Some((mime, payload)) = self.entries.remove(&oldest) {
                self.current_bytes = self.current_bytes.saturating_sub(mime.len() + payload.len());
            }
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

impl Default for MaterializeCache {
    fn default() -> Self {
        Self::new(50 * 1024 * 1024)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_round_trips_an_entry() {
        let mut cache = MaterializeCache::new(1024);
        cache.insert("img-1", "image/png".into(), "QUJD".into());
        assert_eq!(cache.get("img-1"), Some(&("image/png".into(), "QUJD".into())));
        assert_eq!(cache.get("missing"), None);
    }

    #[test]
    fn cache_evicts_oldest_when_over_budget() {
        let mut cache = MaterializeCache::new(200);
        // Two payloads of ~100 bytes each exceed the 200-byte budget together.
        cache.insert("a", "image/png".into(), "x".repeat(100));
        assert!(cache.get("a").is_some(), "first insert alone fits");
        // "b" pushed the total over budget → oldest ("a") is evicted.
        cache.insert("b", "image/png".into(), "y".repeat(100));
        assert_eq!(cache.get("b").map(|(_, p)| p.len()), Some(100));
        assert!(cache.get("a").is_none(), "oldest must be evicted first");
    }

    #[test]
    fn oversized_payload_is_not_cached() {
        let mut cache = MaterializeCache::new(100);
        cache.insert("big", "image/png".into(), "z".repeat(200));
        assert!(cache.get("big").is_none());
    }

    #[test]
    fn replacing_an_entry_does_not_double_count() {
        let mut cache = MaterializeCache::new(500);
        cache.insert("img", "image/png".into(), "a".repeat(100));
        cache.insert("img", "image/png".into(), "b".repeat(50));
        assert_eq!(cache.get("img").map(|(_, p)| p.len()), Some(50));
        cache.insert("other", "image/png".into(), "c".repeat(300));
        // 50 + 300 = 350 ≤ 500 → both stay.
        assert!(cache.get("img").is_some());
        assert!(cache.get("other").is_some());
    }
}
