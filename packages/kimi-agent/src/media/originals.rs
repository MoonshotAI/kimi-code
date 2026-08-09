//! Image originals — content-addressed persistence of pre-compression images.
//!
//! When the agent compresses an image for the model, the original
//! pre-compression bytes are stored here so the model can re-read
//! them at full resolution later.
//!
//! Two layouts coexist:
//! - Legacy blobref layout: `<sessionDir>/media/originals/<sha256hex>`.
//! - Path-based layout, mirroring `packages/node-sdk/src/legacy/image/
//!   image-originals.ts`: `<sessionDir>/media-originals/<sha256-32hex>.<ext>`,
//!   used when the model must read the original back through a real path
//!   (e.g. `ReadMediaFile` on a pasted image).

use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Content-addressed store for original image bytes.
///
/// Legacy blobref layout: `<sessionDir>/media/originals/<contentHash>`.
/// Path-based layout: `<sessionDir>/media-originals/<contentHash32>.<ext>`.
/// The content hash is SHA-256 of the image bytes, hex-encoded.
pub struct OriginalImageStore {
    /// Base directory for all sessions' originals.
    base_dir: PathBuf,
}

impl OriginalImageStore {
    /// Create a new store rooted at the given base directory.
    pub fn new(base_dir: impl Into<PathBuf>) -> Self {
        Self {
            base_dir: base_dir.into(),
        }
    }

    /// Persist original image bytes and return a blobref that can be
    /// used to retrieve them later.
    ///
    /// The blobref format is `originals://<hash>`.
    pub fn persist(&self, session_id: &str, bytes: &[u8]) -> Result<String, String> {
        let hash = sha2_hex(bytes);
        let dir = self.session_media_originals_dir(session_id);
        let path = dir.join(&hash);

        if path.exists() {
            // Already stored — no-op
            return Ok(format!("originals://{hash}"));
        }

        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Cannot create originals dir {dir:?}: {e}"))?;

        std::fs::write(&path, bytes)
            .map_err(|e| format!("Cannot write original image {path:?}: {e}"))?;

        Ok(format!("originals://{hash}"))
    }

    /// Persist original image bytes with a file extension and return the
    /// on-disk path of the stored file.
    ///
    /// Mirrors the TS `persistOriginalImage`: the file lives at
    /// `<sessionDir>/media-originals/<sha256-32hex>.<ext>` — the short hash
    /// and the `media-originals` directory match the TS store, so the
    /// returned path can be handed to the model for `ReadMediaFile`.
    /// `ext` may be a plain extension (`"png"`, `".PNG"`) or a MIME type
    /// (`"image/png"`); anything unrecognized falls back to `"img"`.
    ///
    /// Idempotent for identical bytes; returns an error only when the
    /// file cannot be written.
    pub fn persist_with_extension(
        &self,
        session_id: &str,
        bytes: &[u8],
        ext: &str,
    ) -> Result<String, String> {
        let hash = &sha2_hex(bytes)[..32];
        let dir = self.path_based_session_dir(session_id);
        let file_name = format!("{hash}.{}", extension_from(ext));
        let path = dir.join(&file_name);

        if !path.exists() {
            std::fs::create_dir_all(&dir)
                .map_err(|e| format!("Cannot create originals dir {dir:?}: {e}"))?;
            std::fs::write(&path, bytes)
                .map_err(|e| format!("Cannot write original image {path:?}: {e}"))?;
        }

        Ok(path.to_string_lossy().into_owned())
    }

    /// Resolve a blobref to the original image bytes.
    ///
    /// Accepts both `originals://<hash>` and the extension-carrying
    /// `originals://<hash>.<ext>` form produced by `persist_with_extension`.
    ///
    /// Returns `None` when the blobref format is unknown or the
    /// original file does not exist on disk.
    pub fn resolve(&self, blobref: &str) -> Option<Vec<u8>> {
        let name = blobref.strip_prefix("originals://")?;
        if name.is_empty() {
            return None;
        }

        // Search all session directories (legacy and path-based layouts)
        let sessions_dir = self.base_dir.join("sessions");
        let sessions = std::fs::read_dir(&sessions_dir).ok()?;
        for entry in sessions.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            for sub in ["media/originals", "media-originals"] {
                if let Some(bytes) = resolve_in_dir(&path.join(sub), name) {
                    return Some(bytes);
                }
            }
        }

        // Also check shared cache
        resolve_in_dir(&self.original_image_cache_dir(), name)
    }

    /// Get the per-session directory for originals.
    pub fn session_media_originals_dir(&self, session_id: &str) -> PathBuf {
        self.base_dir
            .join("sessions")
            .join(session_id)
            .join("media")
            .join("originals")
    }

    /// Get the path-based per-session directory, matching the TS
    /// `sessionMediaOriginalsDir`: `<sessionDir>/media-originals`.
    fn path_based_session_dir(&self, session_id: &str) -> PathBuf {
        self.base_dir
            .join("sessions")
            .join(session_id)
            .join("media-originals")
    }

    /// All directories that may hold originals: per-session dirs in both
    /// layouts plus the shared cache.
    fn all_originals_dirs(&self) -> Vec<PathBuf> {
        let mut dirs = Vec::new();
        if let Ok(sessions) = std::fs::read_dir(self.base_dir.join("sessions")) {
            for entry in sessions.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                dirs.push(path.join("media").join("originals"));
                dirs.push(path.join("media-originals"));
            }
        }
        dirs.push(self.original_image_cache_dir());
        dirs
    }

    /// Get the shared cache directory for originals.
    pub fn original_image_cache_dir(&self) -> PathBuf {
        self.base_dir.join("cache").join("media").join("originals")
    }

    /// Get the base directory.
    pub fn base_dir(&self) -> &Path {
        &self.base_dir
    }

    /// Evict oldest files (by mtime) across all originals directories
    /// until the store fits `max_bytes`, mirroring the TS sweep.
    ///
    /// Returns the number of files removed. Best-effort: files that fail
    /// to unlink are still counted as gone so a locked file cannot block
    /// eviction.
    pub fn sweep_old(&self, max_bytes: u64) -> usize {
        let mut entries: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
        let mut total: u64 = 0;
        for dir in self.all_originals_dirs() {
            let Ok(items) = std::fs::read_dir(&dir) else {
                continue;
            };
            for item in items.flatten() {
                let Ok(meta) = item.metadata() else {
                    continue;
                };
                if !meta.is_file() {
                    continue;
                }
                let size = meta.len();
                let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                total += size;
                entries.push((item.path(), size, mtime));
            }
        }

        if total <= max_bytes {
            return 0;
        }

        // Oldest first (by mtime), mirroring the TS sweep order.
        entries.sort_by_key(|(_, _, mtime)| *mtime);
        let mut removed = 0;
        for (path, size, _) in entries {
            if total <= max_bytes {
                break;
            }
            if std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
            total = total.saturating_sub(size);
        }
        removed
    }
}

/// Compute the SHA-256 hex digest of a byte slice.
fn sha2_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Normalize a caller-provided extension or MIME type into the file
/// extension used by `persist_with_extension`, mirroring the TS
/// `MIME_EXTENSION` fallback of `"img"`.
fn extension_from(ext: &str) -> String {
    if ext.contains('/') {
        return extension_for_mime(ext);
    }
    let ext = ext.trim().trim_start_matches('.').to_lowercase();
    if ext.is_empty() {
        "img".to_string()
    } else {
        ext
    }
}

/// Map a MIME type to the extension used for persisted originals,
/// mirroring the TS `MIME_EXTENSION` table; unknown types get `"img"`.
pub fn extension_for_mime(mime: &str) -> String {
    match mime.trim().to_lowercase().as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/tiff" => "tif",
        _ => "img",
    }
    .to_string()
}

/// Look up `name` in `dir`, falling back to the extension-stripped file
/// name so `originals://<hash>.<ext>` can also resolve the legacy
/// extension-less layout.
fn resolve_in_dir(dir: &Path, name: &str) -> Option<Vec<u8>> {
    let direct = dir.join(name);
    if direct.is_file() {
        return std::fs::read(&direct).ok();
    }
    let stem = strip_extension(name)?;
    let legacy = dir.join(stem);
    if legacy.is_file() {
        return std::fs::read(&legacy).ok();
    }
    None
}

/// Split `<hash>.<ext>` into `<hash>` when the extension is a plain
/// alphanumeric suffix; returns `None` for bare hashes.
fn strip_extension(name: &str) -> Option<&str> {
    let (stem, ext) = name.rsplit_once('.')?;
    if stem.is_empty() || ext.is_empty() || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(stem)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_persist_and_resolve() {
        let dir = tempfile::tempdir().unwrap();
        let store = OriginalImageStore::new(dir.path());

        let data = b"hello world, this is an image";
        let blobref = store.persist("sess-1", data).unwrap();
        assert!(blobref.starts_with("originals://"));

        let resolved = store.resolve(&blobref).unwrap();
        assert_eq!(resolved, data);
    }

    #[test]
    fn test_persist_twice_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let store = OriginalImageStore::new(dir.path());

        let data = b"same image data";
        let ref1 = store.persist("sess-1", data).unwrap();
        let ref2 = store.persist("sess-1", data).unwrap();
        assert_eq!(ref1, ref2);
    }

    #[test]
    fn test_resolve_nonexistent() {
        let dir = tempfile::tempdir().unwrap();
        let store = OriginalImageStore::new(dir.path());

        let result = store.resolve("originals://nonexistent");
        assert!(result.is_none());
    }

    #[test]
    fn test_resolve_invalid_blobref() {
        let dir = tempfile::tempdir().unwrap();
        let store = OriginalImageStore::new(dir.path());

        assert!(store.resolve("invalid").is_none());
        assert!(store.resolve("originals://").is_none());
    }

    #[test]
    fn test_session_media_originals_dir() {
        let dir = tempfile::tempdir().unwrap();
        let store = OriginalImageStore::new(dir.path());

        let session_dir = store.session_media_originals_dir("sess-1");
        assert!(session_dir.to_string_lossy().contains("sess-1"));
        assert!(session_dir.to_string_lossy().contains("media"));
        assert!(session_dir.to_string_lossy().contains("originals"));
    }

    #[test]
    fn test_sha2_hex_is_consistent() {
        let h1 = sha2_hex(b"test data");
        let h2 = sha2_hex(b"test data");
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64); // SHA-256 hex is 64 chars
    }

    #[test]
    fn test_different_inputs_different_hashes() {
        let h1 = sha2_hex(b"data1");
        let h2 = sha2_hex(b"data2");
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_persist_with_extension_writes_ts_path() {
        let dir = tempfile::tempdir().unwrap();
        let store = OriginalImageStore::new(dir.path());

        let data = b"pasted image bytes";
        let path = store.persist_with_extension("sess-1", data, "png").unwrap();

        let hash: String = sha2_hex(data).chars().take(32).collect();
        let expected = dir
            .path()
            .join("sessions")
            .join("sess-1")
            .join("media-originals")
            .join(format!("{hash}.png"));
        assert_eq!(Path::new(&path), expected);
        assert_eq!(std::fs::read(&path).unwrap(), data);
    }

    #[test]
    fn test_persist_with_extension_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let store = OriginalImageStore::new(dir.path());

        let data = b"same bytes twice";
        let p1 = store.persist_with_extension("sess-1", data, "png").unwrap();
        let p2 = store.persist_with_extension("sess-1", data, "png").unwrap();
        assert_eq!(p1, p2);
    }

    #[test]
    fn test_persist_with_extension_accepts_mime_and_dotted_ext() {
        let dir = tempfile::tempdir().unwrap();
        let store = OriginalImageStore::new(dir.path());

        let data = b"some original";
        let via_mime = store
            .persist_with_extension("sess-1", data, "image/jpeg")
            .unwrap();
        let via_dot = store
            .persist_with_extension("sess-1", data, ".PNG")
            .unwrap();
        assert!(via_mime.ends_with(".jpg"), "{via_mime}");
        assert!(via_dot.ends_with(".png"), "{via_dot}");
        // Same bytes → same short-hash stem; content-addressed
        let stem = |p: &str| Path::new(p).file_stem().unwrap().to_string_lossy().into_owned();
        assert_eq!(stem(&via_mime), stem(&via_dot));
    }

    #[test]
    fn test_resolve_with_extension() {
        let dir = tempfile::tempdir().unwrap();
        let store = OriginalImageStore::new(dir.path());

        let data = b"read back via blobref";
        let path = store
            .persist_with_extension("sess-1", data, "webp")
            .unwrap();
        let file_name = Path::new(&path).file_name().unwrap().to_string_lossy();
        let resolved = store
            .resolve(&format!("originals://{file_name}"))
            .unwrap();
        assert_eq!(resolved, data);

        // Legacy blobrefs keep resolving after the new layout was added
        let legacy = store.persist("sess-1", data).unwrap();
        assert_eq!(store.resolve(&legacy).unwrap(), data);
    }

    #[test]
    fn test_resolve_unknown_extension_blobref() {
        let dir = tempfile::tempdir().unwrap();
        let store = OriginalImageStore::new(dir.path());

        assert!(store.resolve("originals://0000deadbeef.png").is_none());
    }

    #[test]
    fn test_sweep_old_removes_oldest_first() {
        let dir = tempfile::tempdir().unwrap();
        let store = OriginalImageStore::new(dir.path());

        let old_path = store
            .persist_with_extension("sess-1", &vec![b'x'; 100], "png")
            .unwrap();
        let new_path = store
            .persist_with_extension("sess-1", &vec![b'y'; 100], "png")
            .unwrap();

        // Rewind the first file's mtime so the eviction order is deterministic
        let past = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        std::fs::File::options()
            .write(true)
            .open(&old_path)
            .unwrap()
            .set_modified(past)
            .unwrap();

        // 200 bytes total vs a 150-byte cap → evict exactly the oldest file
        let removed = store.sweep_old(150);
        assert_eq!(removed, 1);
        assert!(!Path::new(&old_path).exists());
        assert!(Path::new(&new_path).exists());
    }

    #[test]
    fn test_sweep_old_under_limit_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        let store = OriginalImageStore::new(dir.path());

        let path = store.persist_with_extension("sess-1", b"small", "png").unwrap();
        assert_eq!(store.sweep_old(1024), 0);
        assert!(Path::new(&path).exists());
    }

    #[test]
    fn test_sweep_old_spans_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let store = OriginalImageStore::new(dir.path());

        let old_path = store
            .persist_with_extension("sess-1", &vec![b'a'; 60], "png")
            .unwrap();
        let new_path = store
            .persist_with_extension("sess-2", &vec![b'b'; 60], "png")
            .unwrap();
        let past = std::time::SystemTime::now() - std::time::Duration::from_secs(7200);
        std::fs::File::options()
            .write(true)
            .open(&old_path)
            .unwrap()
            .set_modified(past)
            .unwrap();

        assert_eq!(store.sweep_old(100), 1);
        assert!(!Path::new(&old_path).exists());
        assert!(Path::new(&new_path).exists());
    }

    #[test]
    fn test_extension_for_mime() {
        assert_eq!(extension_for_mime("image/png"), "png");
        assert_eq!(extension_for_mime("image/jpeg"), "jpg");
        assert_eq!(extension_for_mime("image/tiff"), "tif");
        assert_eq!(extension_for_mime(" image/PNG "), "png");
        assert_eq!(extension_for_mime("application/octet-stream"), "img");
        assert_eq!(extension_from("webp"), "webp");
        assert_eq!(extension_from(".GIF"), "gif");
        assert_eq!(extension_from(""), "img");
    }
}