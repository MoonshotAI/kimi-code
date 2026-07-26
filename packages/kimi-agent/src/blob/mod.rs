/// BlobService — blob storage with automatic data URI offloading and LRU caching.
///
/// Corresponds to `packages/agent-core-v2/src/agent/blob/`.
///
/// Offloads large inline media payloads into content-addressed blob storage
/// and loads them back on read. Includes a byte-bounded LRU cache for
/// frequently accessed blobs.
///
/// # Features
/// - Byte-bounded LRU cache (50 MB default, per-agent scope)
/// - base64 data-URI detection and parsing
/// - Media container URL offloading for ImageUrl/AudioUrl/VideoUrl parts
/// - Content-based SHA-256 hashing for blob references
/// - Storage scope integration via BlobStore

use std::cell::RefCell;
use std::collections::HashMap;

use sha2::{Digest, Sha256};

use crate::context::types::{ContentPart, MediaContainer};
use crate::records::BlobStore;

/// Maximum inline data size before offloading to blob storage (4 KB).
const DEFAULT_THRESHOLD: usize = 4096;

/// Default maximum cache size in bytes (50 MB).
const DEFAULT_MAX_CACHE_SIZE: usize = 50 * 1024 * 1024;

/// Blob reference protocol prefix.
const BLOBREF_PROTOCOL: &str = "blobref:";

/// Placeholder text for missing media.
const MISSING_MEDIA_PLACEHOLDER: &str = "[media missing]";

// ── ByteLruCache ────────────────────────────────────────────────────────────

/// A byte-bounded LRU cache.
///
/// Capacity is measured in **bytes** rather than entries. Hits promote an entry
/// to most-recently-used; inserts evict the least-recently-used entries until
/// the payload fits. A single payload larger than `max_bytes` is never cached.
struct ByteLruCache {
    entries: HashMap<String, ByteLruEntry>,
    head: Option<String>,
    tail: Option<String>,
    current_bytes: usize,
    max_bytes: usize,
}

struct ByteLruEntry {
    data: Vec<u8>,
    prev: Option<String>,
    next: Option<String>,
}

impl ByteLruCache {
    fn new(max_bytes: usize) -> Self {
        Self {
            entries: HashMap::new(),
            head: None,
            tail: None,
            current_bytes: 0,
            max_bytes,
        }
    }

    /// Get a cached entry by key, promoting it to most-recently-used.
    fn get(&mut self, key: &str) -> Option<Vec<u8>> {
        if !self.entries.contains_key(key) {
            return None;
        }
        // Promote to MRU: detach + re-attach at head
        self.detach(key);
        if let Some(k) = self.head.clone() {
            self.attach_head(k);
        }
        Some(self.entries[key].data.clone())
    }

    fn set(&mut self, key: String, value: Vec<u8>) {
        let size = value.len();
        if size > self.max_bytes {
            if self.entries.contains_key(&key) {
                self.remove(&key);
            }
            return;
        }

        if self.entries.contains_key(&key) {
            self.current_bytes -= self.entries[&key].data.len();
            self.detach(&key);
        } else {
            while !self.entries.is_empty() && self.current_bytes + size > self.max_bytes {
                self.evict_oldest();
            }
        }

        self.current_bytes += size;
        let entry = ByteLruEntry {
            data: value,
            prev: None,
            next: None,
        };
        self.entries.insert(key.clone(), entry);
        self.attach_head(key);
    }

    fn remove(&mut self, key: &str) {
        if let Some(old) = self.entries.get(key) {
            self.current_bytes -= old.data.len();
        }
        self.detach(key);
        self.entries.remove(key);
    }

    fn detach(&mut self, key: &str) {
        let Some(entry) = self.entries.get(key) else { return };
        let prev = entry.prev.clone();
        let next = entry.next.clone();

        match (&prev, &next) {
            (Some(p), Some(n)) => {
                if let Some(prev_entry) = self.entries.get_mut(p) {
                    prev_entry.next = Some(n.clone());
                }
                if let Some(next_entry) = self.entries.get_mut(n) {
                    next_entry.prev = Some(p.clone());
                }
            }
            (Some(p), None) => {
                if let Some(prev_entry) = self.entries.get_mut(p) {
                    prev_entry.next = None;
                }
                self.tail = Some(p.clone());
            }
            (None, Some(n)) => {
                if let Some(next_entry) = self.entries.get_mut(n) {
                    next_entry.prev = None;
                }
                self.head = Some(n.clone());
            }
            (None, None) => {
                self.head = None;
                self.tail = None;
            }
        }
    }

    fn attach_head(&mut self, key: String) {
        if let Some(entry) = self.entries.get_mut(&key) {
            entry.prev = None;
            entry.next = self.head.clone();
        }
        if let Some(ref old_head) = self.head {
            if let Some(old_entry) = self.entries.get_mut(old_head) {
                old_entry.prev = Some(key.clone());
            }
        }
        self.head = Some(key.clone());
        if self.tail.is_none() {
            self.tail = Some(key);
        }
    }

    fn evict_oldest(&mut self) {
        if let Some(tail_key) = self.tail.clone() {
            self.remove(&tail_key);
        }
    }
}

// ── BlobService ─────────────────────────────────────────────────────────────

/// Service for offloading large inline media to blob storage with caching.
pub struct BlobService {
    store: BlobStore,
    cache: RefCell<ByteLruCache>,
    storage_scope: String,
}

impl BlobService {
    /// Create a new BlobService backed by the given BlobStore.
    ///
    /// `storage_scope` is the agent's scoped storage path (e.g., "agent-<id>/blobs").
    pub fn new(store: BlobStore, storage_scope: impl Into<String>) -> Self {
        Self {
            store,
            cache: RefCell::new(ByteLruCache::new(DEFAULT_MAX_CACHE_SIZE)),
            storage_scope: storage_scope.into(),
        }
    }

    /// Check if a URL string is a blob reference.
    pub fn is_blobref(url: &str) -> bool {
        url.starts_with(BLOBREF_PROTOCOL)
    }

    /// Offload large inline data parts to blob storage.
    ///
    /// Replaces base64 data URIs >4KB with blobref references. Also handles
    /// media container parts (ImageUrl, AudioUrl, VideoUrl) that have
    /// embedded data URIs in their `url` field.
    pub fn offload_parts(&self, parts: &[ContentPart]) -> Vec<ContentPart> {
        let mut changed = false;
        let mut out = Vec::with_capacity(parts.len());
        for part in parts {
            let next = self.offload_content_part(part);
            if !std::ptr::eq(part, &next) {
                changed = true;
            }
            out.push(next);
        }
        if changed { out } else { parts.to_vec() }
    }

    /// Load parts back from blob references.
    pub fn load_parts(&self, parts: &[ContentPart]) -> Vec<ContentPart> {
        let mut changed = false;
        let mut out = Vec::with_capacity(parts.len());
        for part in parts {
            let next = self.load_content_part(part);
            if !std::ptr::eq(part, &next) {
                changed = true;
            }
            out.push(next);
        }
        if changed { out } else { parts.to_vec() }
    }

    // ── Private helpers ──

    fn offload_content_part(&self, part: &ContentPart) -> ContentPart {
        self.rewrite_media_urls(part, &|url| self.maybe_offload_string(url))
    }

    fn load_content_part(&self, part: &ContentPart) -> ContentPart {
        self.rewrite_media_urls(part, &|url| {
            if Self::is_blobref(url) {
                self.load_blobref_url(url).unwrap_or_else(|| MISSING_MEDIA_PLACEHOLDER.to_string())
            } else {
                url.to_string()
            }
        })
    }

    fn rewrite_media_urls(
        &self,
        part: &ContentPart,
        transform: &dyn Fn(&str) -> String,
    ) -> ContentPart {
        let rewrite_inner = |parts: &[ContentPart]| -> Vec<ContentPart> {
            let mut changed = false;
            let result: Vec<ContentPart> = parts
                .iter()
                .map(|p| {
                    let next = self.rewrite_media_urls(p, transform);
                    if !std::ptr::eq(p, &next) { changed = true; }
                    next
                })
                .collect();
            if changed { result } else { parts.to_vec() }
        };

        match part {
            ContentPart::Text { text } => {
                let new_text = transform(text);
                if new_text == *text {
                    part.clone()
                } else {
                    ContentPart::Text { text: new_text }
                }
            }
            ContentPart::ImageUrl { image_url } => {
                let new_url = transform(&image_url.url);
                if new_url == image_url.url {
                    part.clone()
                } else {
                    ContentPart::ImageUrl {
                        image_url: MediaContainer {
                            url: new_url,
                            id: image_url.id.clone(),
                        },
                    }
                }
            }
            ContentPart::AudioUrl { audio_url } => {
                let new_url = transform(&audio_url.url);
                if new_url == audio_url.url {
                    part.clone()
                } else {
                    ContentPart::AudioUrl {
                        audio_url: MediaContainer {
                            url: new_url,
                            id: audio_url.id.clone(),
                        },
                    }
                }
            }
            ContentPart::VideoUrl { video_url } => {
                let new_url = transform(&video_url.url);
                if new_url == video_url.url {
                    part.clone()
                } else {
                    ContentPart::VideoUrl {
                        video_url: MediaContainer {
                            url: new_url,
                            id: video_url.id.clone(),
                        },
                    }
                }
            }
            ContentPart::ToolResult { tool_use_id, content, is_error } => {
                let new_content = rewrite_inner(content);
                if content.iter().zip(&new_content).any(|(a, b)| !std::ptr::eq(a, b)) {
                    ContentPart::ToolResult {
                        tool_use_id: tool_use_id.clone(),
                        content: new_content,
                        is_error: *is_error,
                    }
                } else {
                    part.clone()
                }
            }
            other => other.clone(),
        }
    }

    fn maybe_offload_string(&self, value: &str) -> String {
        if Self::is_blobref(value) {
            return value.to_string();
        }
        let (mime_type, base64_payload) = match parse_data_uri(value) {
            Some(v) => v,
            None => return value.to_string(),
        };
        let decoded_len = (base64_payload.len() * 3) / 4;
        if decoded_len < DEFAULT_THRESHOLD {
            return value.to_string();
        }
        self.write_blob(mime_type, base64_payload).unwrap_or_else(|_| value.to_string())
    }

    fn write_blob(&self, mime_type: &str, base64_payload: &str) -> Result<String, String> {
        use base64::Engine;
        let binary = base64::engine::general_purpose::STANDARD
            .decode(base64_payload)
            .map_err(|e| format!("Failed to decode base64: {e}"))?;
        let hash = Sha256::digest(&binary);
        let hash_hex = format!("{:x}", hash);
        let blobref = format_blobref(mime_type, &hash_hex);
        let blob_key = format!("{}/{}", self.storage_scope, &hash_hex);
        self.store.store(&blob_key, &binary);
        let mut cache = self.cache.borrow_mut();
        cache.set(hash_hex.clone(), binary);
        Ok(blobref)
    }

    fn load_blobref_url(&self, url: &str) -> Option<String> {
        let (mime_type, hash) = parse_blobref(url)?;
        {
            let mut cache = self.cache.borrow_mut();
            if let Some(cached) = cache.get(&hash) {
                return Some(format_data_uri(&mime_type, &cached));
            }
        }
        let blob_key = format!("{}/{}", self.storage_scope, &hash);
        let payload = self.store.read(&blob_key).ok()?;
        let data_uri = format_data_uri(&mime_type, &payload);
        self.cache.borrow_mut().set(hash, payload);
        Some(data_uri)
    }
}

// ── Free functions ──

fn format_blobref(mime_type: &str, hash: &str) -> String {
    format!("{BLOBREF_PROTOCOL}{mime_type};{hash}")
}

fn parse_blobref(url: &str) -> Option<(String, String)> {
    if !url.starts_with(BLOBREF_PROTOCOL) { return None; }
    let rest = &url[BLOBREF_PROTOCOL.len()..];
    let semi = rest.find(';')?;
    let mime_type = rest[..semi].to_string();
    let hash = rest[semi + 1..].to_string();
    if mime_type.is_empty() || hash.is_empty() { return None; }
    Some((mime_type, hash))
}

fn parse_data_uri(value: &str) -> Option<(&str, &str)> {
    if !value.starts_with("data:") { return None; }
    let after_data = &value["data:".len()..];
    let semi = after_data.find(';')?;
    let mime_type = &after_data[..semi];
    let rest = &after_data[semi + 1..];
    if !rest.starts_with("base64,") { return None; }
    let payload = &rest["base64,".len()..];
    if payload.is_empty() { return None; }
    Some((mime_type, payload))
}

fn format_data_uri(mime_type: &str, payload: &[u8]) -> String {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(payload);
    format!("data:{mime_type};base64,{b64}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_service() -> (BlobService, TempDir) {
        let dir = TempDir::new().unwrap();
        let store = BlobStore::new(dir.path().to_str().unwrap());
        let svc = BlobService::new(store, "agent-test/blobs");
        (svc, dir)
    }

    // ── ByteLruCache tests ──

    #[test]
    fn test_cache_get_and_set() {
        let mut cache = ByteLruCache::new(1024);
        cache.set("a".into(), vec![1, 2, 3]);
        assert_eq!(cache.get("a"), Some(vec![1, 2, 3]));
        assert_eq!(cache.get("b"), None);
    }

    #[test]
    fn test_cache_promotes_on_get() {
        let mut cache = ByteLruCache::new(1024);
        cache.set("a".into(), vec![1; 500]);
        cache.set("b".into(), vec![2; 500]);
        assert_eq!(cache.current_bytes, 1000);

        cache.get("a");

        cache.set("c".into(), vec![3; 500]);
        assert_eq!(cache.current_bytes, 1000);
        assert!(cache.get("a").is_some());
        assert!(cache.get("b").is_none());
        assert!(cache.get("c").is_some());
    }

    #[test]
    fn test_cache_too_large_value_not_cached() {
        let mut cache = ByteLruCache::new(100);
        cache.set("big".into(), vec![0; 200]);
        assert_eq!(cache.current_bytes, 0);
        assert!(cache.get("big").is_none());
    }

    #[test]
    fn test_cache_update_existing() {
        let mut cache = ByteLruCache::new(100);
        cache.set("key".into(), vec![0; 50]);
        assert_eq!(cache.current_bytes, 50);
        cache.set("key".into(), vec![0; 30]);
        assert_eq!(cache.current_bytes, 30);
    }

    #[test]
    fn test_cache_eviction_order() {
        let mut cache = ByteLruCache::new(300);
        cache.set("a".into(), vec![1; 100]);
        cache.set("b".into(), vec![2; 100]);
        cache.set("c".into(), vec![3; 100]);
        assert_eq!(cache.current_bytes, 300);

        cache.set("d".into(), vec![4; 100]);
        assert_eq!(cache.current_bytes, 300);
        assert!(cache.get("a").is_none());
        assert!(cache.get("b").is_some());
        assert!(cache.get("c").is_some());
        assert!(cache.get("d").is_some());
    }

    // ── BlobService tests ──

    #[test]
    fn test_is_blobref() {
        assert!(BlobService::is_blobref("blobref:text/plain;abc123"));
        assert!(BlobService::is_blobref("blobref:image/png;deadbeef"));
        assert!(!BlobService::is_blobref("hello"));
        assert!(!BlobService::is_blobref("data:image/png;base64,abc"));
    }

    #[test]
    fn test_format_and_parse_blobref() {
        let original = format_blobref("image/png", "deadbeef");
        assert_eq!(original, "blobref:image/png;deadbeef");
        let parsed = parse_blobref(&original);
        assert_eq!(parsed, Some(("image/png".into(), "deadbeef".into())));
    }

    #[test]
    fn test_parse_blobref_invalid() {
        assert_eq!(parse_blobref("not-a-blobref"), None);
        assert_eq!(parse_blobref("blobref:;hash"), None);
        assert_eq!(parse_blobref("blobref:type;"), None);
    }

    #[test]
    fn test_parse_data_uri() {
        let result = parse_data_uri("data:image/png;base64,iVBORw0KGgo");
        assert_eq!(result, Some(("image/png", "iVBORw0KGgo")));
        assert_eq!(parse_data_uri("not-a-data-uri"), None);
        assert_eq!(parse_data_uri("data:image/png;notbase64,abc"), None);
    }

    #[test]
    fn test_small_text_stays_inline() {
        let (svc, _dir) = make_service();
        let parts = vec![ContentPart::Text { text: "hello world".to_string() }];
        let result = svc.offload_parts(&parts);
        assert_eq!(result.len(), 1);
        match &result[0] {
            ContentPart::Text { text } => assert_eq!(text, "hello world"),
            _ => panic!("expected text"),
        }
    }

    #[test]
    fn test_offload_and_load_base64_data_uri() {
        let (svc, _dir) = make_service();
        let payload = "A".repeat(5000);
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(payload.as_bytes());
        let data_uri = format!("data:text/plain;base64,{}", b64);
        let parts = vec![ContentPart::Text { text: data_uri.clone() }];
        let offloaded = svc.offload_parts(&parts);
        assert_eq!(offloaded.len(), 1);
        match &offloaded[0] {
            ContentPart::Text { text } => assert!(text.starts_with("blobref:")),
            _ => panic!("expected text"),
        }
        let loaded = svc.load_parts(&offloaded);
        match &loaded[0] {
            ContentPart::Text { text } => assert_eq!(text, &data_uri),
            _ => panic!("expected text"),
        }
    }

    #[test]
    fn test_offload_media_container() {
        let (svc, _dir) = make_service();
        let payload = "B".repeat(5000);
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(payload.as_bytes());
        let data_uri = format!("data:image/png;base64,{}", b64);
        let parts = vec![ContentPart::ImageUrl {
            image_url: MediaContainer { url: data_uri.clone(), id: Some("img-1".into()) },
        }];
        let offloaded = svc.offload_parts(&parts);
        assert_eq!(offloaded.len(), 1);
        match &offloaded[0] {
            ContentPart::ImageUrl { image_url } => {
                assert!(image_url.url.starts_with("blobref:"));
                assert_eq!(image_url.id, Some("img-1".into()));
            }
            _ => panic!("expected image_url"),
        }
        let loaded = svc.load_parts(&offloaded);
        match &loaded[0] {
            ContentPart::ImageUrl { image_url } => assert_eq!(image_url.url, data_uri),
            _ => panic!("expected image_url"),
        }
    }

    #[test]
    fn test_load_missing_blob_returns_placeholder() {
        let (svc, _dir) = make_service();
        let parts = vec![ContentPart::Text {
            text: "blobref:text/plain;nonexistent".to_string(),
        }];
        let loaded = svc.load_parts(&parts);
        match &loaded[0] {
            ContentPart::Text { text } => assert_eq!(text, MISSING_MEDIA_PLACEHOLDER),
            _ => panic!("expected text"),
        }
    }

    #[test]
    fn test_offload_small_base64_not_offloaded() {
        let (svc, _dir) = make_service();
        let b64 = "SGVsbG8=";
        let data_uri = format!("data:text/plain;base64,{}", b64);
        let parts = vec![ContentPart::Text { text: data_uri.clone() }];
        let result = svc.offload_parts(&parts);
        match &result[0] {
            ContentPart::Text { text } => assert_eq!(text, &data_uri),
            _ => panic!("expected text"),
        }
    }

    #[test]
    fn test_nested_tool_result_offload() {
        let (svc, _dir) = make_service();
        let payload = "C".repeat(5000);
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(payload.as_bytes());
        let data_uri = format!("data:text/html;base64,{}", b64);
        let parts = vec![ContentPart::ToolResult {
            tool_use_id: "tool-1".into(),
            content: vec![ContentPart::Text { text: data_uri.clone() }],
            is_error: Some(false),
        }];
        let offloaded = svc.offload_parts(&parts);
        match &offloaded[0] {
            ContentPart::ToolResult { content, .. } => {
                match &content[0] {
                    ContentPart::Text { text } => assert!(text.starts_with("blobref:")),
                    _ => panic!("expected nested text"),
                }
            }
            _ => panic!("expected tool_result"),
        }
    }

    #[test]
    fn test_already_blobref_not_modified() {
        let (svc, _dir) = make_service();
        let existing = "blobref:image/png;abc123".to_string();
        let parts = vec![ContentPart::Text { text: existing.clone() }];
        let result = svc.offload_parts(&parts);
        match &result[0] {
            ContentPart::Text { text } => assert_eq!(text, &existing),
            _ => panic!("expected text"),
        }
    }
}