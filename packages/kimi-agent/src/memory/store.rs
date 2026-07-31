//! Memory store — markdown files on disk with an in-memory index.
//!
//! Port of `agent-core-v2/src/app/memory/memoryStore.ts` semantics: the
//! markdown files under `~/.kimi-code/memory/` are the source of truth (the
//! TS side writes them directly); the store keeps an in-memory index for
//! search and list.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::memory::paths::{
    MemoryEntry, MemorySearchResult, MemoryScope, build_snippet, extract_title,
    parse_memory_path, scope_dir,
};

/// The memory store: get/put/delete/list/search over memory markdown files.
#[derive(Debug, Clone, Default)]
pub struct MemoryStore {
    inner: std::sync::Arc<Mutex<StoreInner>>,
}

#[derive(Debug, Default)]
struct StoreInner {
    /// path → entry (loaded lazily).
    entries: HashMap<String, MemoryEntry>,
    loaded: bool,
    /// Base dir (`<home>/memory`).
    base: String,
}

impl MemoryStore {
    pub fn new(home_dir: &str) -> Self {
        Self {
            inner: std::sync::Arc::new(Mutex::new(StoreInner {
                base: crate::memory::paths::memory_dir(home_dir),
                ..Default::default()
            })),
        }
    }

    fn ensure_loaded(&self, inner: &mut StoreInner) {
        if inner.loaded {
            return;
        }
        inner.entries.clear();
        if let Ok(files) = walk_md_files(&inner.base) {
            for path in files {
                if let Some(entry) = load_entry(&path, &inner.base) {
                    inner.entries.insert(entry.path.clone(), entry);
                }
            }
        }
        inner.loaded = true;
    }

    /// Read a memory entry by relative path.
    pub fn get(&self, path: &str) -> Option<MemoryEntry> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        self.ensure_loaded(&mut inner);
        inner.entries.get(path).cloned()
    }

    /// Write an entry: the markdown file is the source of truth; the in-memory
    /// index is refreshed.
    pub fn put(&self, entry: &MemoryEntry) -> std::io::Result<()> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let dir = scope_dir(&inner.base, entry.scope, &entry.scope_id);
        std::fs::create_dir_all(&dir)?;
        let full = PathBuf::from(&dir).join(entry.path.rsplit('/').next().unwrap_or(&entry.path));
        std::fs::write(&full, entry.body.as_bytes())?;
        inner.entries.insert(entry.path.clone(), entry.clone());
        Ok(())
    }

    /// Delete an entry (file + index).
    pub fn delete(&self, path: &str) -> std::io::Result<bool> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        self.ensure_loaded(&mut inner);
        let Some(entry) = inner.entries.remove(path) else {
            return Ok(false);
        };
        let dir = scope_dir(&inner.base, entry.scope, &entry.scope_id);
        let full = PathBuf::from(&dir).join(entry.path.rsplit('/').next().unwrap_or(path));
        if full.exists() {
            std::fs::remove_file(&full)?;
        }
        Ok(true)
    }

    /// List all memory paths.
    pub fn list(&self) -> Vec<String> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        self.ensure_loaded(&mut inner);
        let mut keys: Vec<String> = inner.entries.keys().cloned().collect();
        keys.sort();
        keys
    }

    /// Substring search with a relative score (query-hit position weighted).
    /// Scores below `0.15` are dropped, matching the TS threshold.
    pub fn search(&self, query: &str, limit: usize) -> Vec<MemorySearchResult> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        self.ensure_loaded(&mut inner);
        let lower_query = query.to_lowercase();
        let mut results: Vec<MemorySearchResult> = Vec::new();
        for entry in inner.entries.values() {
            let lower_body = entry.body.to_lowercase();
            let Some(idx) = lower_body.find(&lower_query) else {
                continue;
            };
            // Normalized relevance: hits near the start and repeated hits
            // score higher, capped at 1.
            let position_factor = 1.0 - (idx as f64 / lower_body.len().max(1) as f64);
            let count = lower_body.matches(&lower_query).count() as f64;
            let score = (0.3 + position_factor * 0.5 + (count.min(5.0)) * 0.04).min(1.0);
            if score < 0.15 {
                continue;
            }
            let parsed = parse_memory_path(&entry.path);
            let (scope, scope_id) = parsed
                .map(|(s, id, _)| (s, id))
                .unwrap_or((MemoryScope::Global, String::new()));
            results.push(MemorySearchResult {
                path: entry.path.clone(),
                scope,
                scope_id,
                r#type: entry.r#type.clone(),
                title: entry.title.clone(),
                snippet: build_snippet(&entry.body, query, 200),
                score,
            });
        }
        results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        results.truncate(limit);
        results
    }
}

/// Walk the memory base dir collecting `.md` files.
fn walk_md_files(base: &str) -> std::io::Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    let root = PathBuf::from(base);
    if !root.exists() {
        return Ok(out);
    }
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "md") {
                out.push(path);
            }
        }
    }
    Ok(out)
}

/// Load one memory file into an entry (relative path keyed).
fn load_entry(path: &PathBuf, base: &str) -> Option<MemoryEntry> {
    let body = std::fs::read_to_string(path).ok()?;
    let rel = path.strip_prefix(base).ok()?.to_string_lossy().replace('\\', "/");
    let rel = rel.trim_start_matches('/').to_string();
    let parsed = parse_memory_path(&rel)?;
    let (scope, scope_id, file_name) = parsed;
    let meta = std::fs::metadata(path).ok()?;
    let updated_at = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some(MemoryEntry {
        path: rel,
        scope,
        scope_id,
        r#type: crate::memory::paths::detect_type(&body),
        title: extract_title(&body, &file_name),
        body,
        fingerprint: format!("{}-{}", meta.len(), updated_at),
        updated_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::paths::build_rel_path;

    #[test]
    fn put_get_delete_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::new(dir.path().to_str().unwrap());
        let entry = MemoryEntry {
            path: build_rel_path(MemoryScope::Global, "", "auth.md"),
            scope: MemoryScope::Global,
            scope_id: String::new(),
            r#type: "note".into(),
            title: "Auth".into(),
            body: "# Auth\nUse bearer tokens.\n".into(),
            fingerprint: String::new(),
            updated_at: 0,
        };
        store.put(&entry).unwrap();
        let got = store.get("global/auth.md").unwrap();
        assert_eq!(got.title, "Auth");
        assert_eq!(store.list(), vec!["global/auth.md".to_string()]);
        assert!(store.delete("global/auth.md").unwrap());
        assert!(store.get("global/auth.md").is_none());
    }

    #[test]
    fn search_finds_and_scores() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::new(dir.path().to_str().unwrap());
        store
            .put(&MemoryEntry {
                path: "global/token.md".into(),
                scope: MemoryScope::Global,
                scope_id: String::new(),
                r#type: "pattern".into(),
                title: "Token".into(),
                body: "# Token\nAlways rotate the API token weekly.\n".into(),
                fingerprint: String::new(),
                updated_at: 0,
            })
            .unwrap();
        let results = store.search("token", 10);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Token");
        assert!(results[0].score >= 0.15);
        assert!(results[0].snippet.to_lowercase().contains("token"));

        assert!(store.search("nothing-matches", 10).is_empty());
    }

    #[test]
    fn reloads_files_on_first_access() {
        let dir = tempfile::tempdir().unwrap();
        let base = crate::memory::paths::memory_dir(dir.path().to_str().unwrap());
        std::fs::create_dir_all(format!("{base}/global")).unwrap();
        std::fs::write(format!("{base}/global/seed.md"), "# Seed\nbody").unwrap();

        let store = MemoryStore::new(dir.path().to_str().unwrap());
        assert!(store.get("global/seed.md").is_some());
    }
}
