/// In-memory file content cache keyed by (abs_path, mtime, size).
///
/// Eliminates redundant disk reads in read-then-edit workflows:
///   Read(A) => cache miss => read disk + cache
///   Edit(A) => write => invalidate cache entry for A
///   Read(A) => cache hit => return cached content instantly
use std::collections::HashMap;
use std::fs;
use std::sync::LazyLock;
use std::time::{Instant, SystemTime};

/// Maximum number of cached file entries.
const MAX_CACHE_ENTRIES: usize = 32;

/// Cached file content with invalidation metadata.
#[derive(Clone)]
struct CacheEntry {
    content: String,
    line_count: i32,
    mtime: SystemTime,
    size: u64,
    last_access: Instant,
}

/// Thread-safe file content cache using std::sync::Mutex.
pub struct FileReadCache {
    cache: std::sync::Mutex<HashMap<String, CacheEntry>>,
    capacity: usize,
}

impl FileReadCache {
    pub fn new() -> Self {
        Self::with_capacity(MAX_CACHE_ENTRIES)
    }

    fn with_capacity(capacity: usize) -> Self {
        Self {
            cache: std::sync::Mutex::new(HashMap::new()),
            capacity,
        }
    }

    /// Look up a cached read result. Returns None on miss or staleness.
    pub fn get(&self, path: &str) -> Option<(String, i32)> {
        let meta = fs::metadata(path).ok()?;
        let mut cache = self.cache.lock().ok()?;
        let entry = cache.get_mut(path)?;
        if entry.mtime == meta.modified().ok()? && entry.size == meta.len() {
            entry.last_access = Instant::now();
            return Some((entry.content.clone(), entry.line_count));
        }
        None
    }

    /// Store a read result in the cache.
    pub fn put(&self, path: String, content: String, line_count: i32) {
        let meta = match fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => return,
        };
        let mtime = match meta.modified() {
            Ok(t) => t,
            Err(_) => return,
        };
        let mut cache = match self.cache.lock() {
            Ok(c) => c,
            Err(_) => return,
        };
        // Evict the least-recently used entry if at capacity.
        if cache.len() >= self.capacity && !cache.contains_key(&path) {
            if let Some(oldest_key) = cache
                .iter()
                .min_by_key(|(_, entry)| entry.last_access)
                .map(|(key, _)| key.clone())
            {
                cache.remove(&oldest_key);
            }
        }
        cache.insert(
            path,
            CacheEntry {
                content,
                line_count,
                mtime,
                size: meta.len(),
                last_access: Instant::now(),
            },
        );
    }

    /// Invalidate a cache entry (called after file write/edit).
    pub fn invalidate(&self, path: &str) {
        if let Ok(mut cache) = self.cache.lock() {
            cache.remove(path);
        }
    }
}

/// Global file read cache instance.
pub static FILE_CACHE: LazyLock<FileReadCache> = LazyLock::new(FileReadCache::new);

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_file(name: &str, content: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "kimi_file_cache_test_{}_{}",
            std::process::id(),
            name
        ));
        fs::write(&path, content).unwrap();
        path
    }

    fn path_key(path: &PathBuf) -> String {
        path.to_string_lossy().to_string()
    }

    #[test]
    fn test_put_and_get_hit() {
        let cache = FileReadCache::with_capacity(2);
        let path = temp_file("hit", "hello");
        let key = path_key(&path);
        cache.put(key.clone(), "hello".to_string(), 1);
        let (content, lines) = cache.get(&key).unwrap();
        assert_eq!(content, "hello");
        assert_eq!(lines, 1);
        fs::remove_file(&path).ok();
    }

    #[test]
    fn test_get_returns_none_when_size_changes() {
        let cache = FileReadCache::with_capacity(2);
        let path = temp_file("stale", "v1");
        let key = path_key(&path);
        cache.put(key.clone(), "v1".to_string(), 1);
        // Use a different byte length so the test is reliable even on
        // filesystems with low-resolution modification timestamps.
        fs::write(&path, "v2-longer").unwrap();
        assert!(cache.get(&key).is_none());
        fs::remove_file(&path).ok();
    }

    #[test]
    fn test_lru_eviction() {
        let cache = FileReadCache::with_capacity(2);
        let a = temp_file("a", "a");
        let b = temp_file("b", "b");
        let c = temp_file("c", "c");

        let key_a = path_key(&a);
        let key_b = path_key(&b);
        let key_c = path_key(&c);

        cache.put(key_a.clone(), "a".to_string(), 1);
        cache.put(key_b.clone(), "b".to_string(), 1);
        // Access a so it becomes most recently used.
        cache.get(&key_a).unwrap();
        // Adding c should evict b (the least recently used entry).
        cache.put(key_c.clone(), "c".to_string(), 1);
        assert!(cache.get(&key_a).is_some());
        assert!(cache.get(&key_b).is_none());
        assert!(cache.get(&key_c).is_some());

        fs::remove_file(&a).ok();
        fs::remove_file(&b).ok();
        fs::remove_file(&c).ok();
    }
}
