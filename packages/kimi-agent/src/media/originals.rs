//! Image originals — content-addressed persistence of pre-compression images.
//!
//! When the agent compresses an image for the model, the original
//! pre-compression bytes are stored here so the model can re-read
//! them at full resolution later.
//!
//! Mirrors `packages/agent-core/src/tools/support/image-originals.ts`.

use std::path::{Path, PathBuf};

/// Content-addressed store for original image bytes.
///
/// Images are stored at `<sessionDir>/media/originals/<contentHash>`.
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

    /// Resolve a blobref to the original image bytes.
    ///
    /// Returns `None` when the blobref format is unknown or the
    /// original file does not exist on disk.
    pub fn resolve(&self, blobref: &str) -> Option<Vec<u8>> {
        let hash = blobref.strip_prefix("originals://")?;
        if hash.is_empty() {
            return None;
        }

        // Search all session directories
        let sessions_dir = self.base_dir.join("sessions");
        let sessions = std::fs::read_dir(&sessions_dir).ok()?;
        for entry in sessions.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let candidate = path.join("media").join("originals").join(hash);
            if candidate.exists() {
                return std::fs::read(&candidate).ok();
            }
        }

        // Also check shared cache
        let cache_path = self.original_image_cache_dir().join(hash);
        if cache_path.exists() {
            return std::fs::read(&cache_path).ok();
        }

        None
    }

    /// Get the per-session directory for originals.
    pub fn session_media_originals_dir(&self, session_id: &str) -> PathBuf {
        self.base_dir
            .join("sessions")
            .join(session_id)
            .join("media")
            .join("originals")
    }

    /// Get the shared cache directory for originals.
    pub fn original_image_cache_dir(&self) -> PathBuf {
        self.base_dir.join("cache").join("media").join("originals")
    }

    /// Get the base directory.
    pub fn base_dir(&self) -> &Path {
        &self.base_dir
    }
}

/// Compute the SHA-256 hex digest of a byte slice.
fn sha2_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
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
}