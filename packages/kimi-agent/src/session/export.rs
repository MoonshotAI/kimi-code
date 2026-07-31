//! Session export — package a session directory into a zip archive with
//! manifest and wire log scan.
//!
//! Mirrors `packages/agent-core/src/session/export/`.

use std::io::{Read, Seek, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::persistence::record_store::RecordStore;

/// Export manifest — metadata about the exported session.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ExportManifest {
    pub version: u32,
    pub created_at: String,
    pub session_id: String,
    pub protocol_version: u32,
    pub turn_count: u32,
    pub os: String,
    pub kimi_version: String,
}

/// Build an export manifest for the given session.
pub fn build_manifest(session_id: &str, turn_count: u32) -> ExportManifest {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    ExportManifest {
        version: 1,
        created_at: now.to_string(),
        session_id: session_id.to_string(),
        protocol_version: 1,
        turn_count,
        os: std::env::consts::OS.to_string(),
        kimi_version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

/// Scan wire records in a session's record store to determine the protocol
/// version and activity range.
pub struct WireScan {
    pub protocol_version: u32,
    pub min_seq: u64,
    pub max_seq: u64,
    pub record_count: u64,
}

/// Scan wire records.
pub fn wire_scan(store: &RecordStore, session_id: &str) -> WireScan {
    let records = store.get_records(session_id, None, 1_000_000).unwrap_or_default();
    let count = records.len() as u64;
    let min_seq = records.first().map(|r| r.id as u64).unwrap_or(0);
    let max_seq = records.last().map(|r| r.id as u64).unwrap_or(0);
    WireScan {
        protocol_version: 1,
        min_seq,
        max_seq,
        record_count: count,
    }
}

/// Export a session to a zip byte buffer.
/// Collects session files, wire records, and builds a manifest.
pub fn export_session(
    session_id: &str,
    session_dir: &Path,
    record_store: &RecordStore,
) -> Result<Vec<u8>, String> {
    let zip_buf = std::io::Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(zip_buf);

    let options = zip::write::FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    // 1. Add manifest
    let scan = wire_scan(record_store, session_id);
    let manifest = build_manifest(session_id, scan.record_count as u32);
    let manifest_json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    zip.start_file("manifest.json", options).map_err(|e| e.to_string())?;
    zip.write_all(manifest_json.as_bytes()).map_err(|e| e.to_string())?;

    // 2. Add wire records
    let records = record_store.get_records(session_id, None, 1_000_000).unwrap_or_default();
    let records_json = serde_json::to_string_pretty(&records).map_err(|e| e.to_string())?;
    zip.start_file("wire.json", options).map_err(|e| e.to_string())?;
    zip.write_all(records_json.as_bytes()).map_err(|e| e.to_string())?;

    // 3. Add session files from the session directory
    if session_dir.exists() {
        add_dir_to_zip(&mut zip, session_dir, session_dir, &options)?;
    }

    let cursor = zip.finish().map_err(|e| e.to_string())?;
    Ok(cursor.into_inner())
}

/// Recursively add a directory's contents to a zip archive.
fn add_dir_to_zip<W: Write + Seek>(
    zip: &mut zip::ZipWriter<W>,
    base: &Path,
    dir: &Path,
    options: &zip::write::FileOptions,
) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("read dir {dir:?}: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let relative = path
            .strip_prefix(base)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string();

        if path.is_dir() {
            zip.add_directory(&format!("{relative}/"), *options)
                .map_err(|e| e.to_string())?;
            add_dir_to_zip(zip, base, &path, options)?;
        } else if path.is_file() {
            zip.start_file(&relative, *options)
                .map_err(|e| e.to_string())?;
            let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
            let mut buf = Vec::new();
            file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            zip.write_all(&buf).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::store::SqliteStore;

    #[test]
    fn test_build_manifest() {
        let m = build_manifest("test-session", 5);
        assert_eq!(m.session_id, "test-session");
        assert_eq!(m.turn_count, 5);
        assert_eq!(m.version, 1);
        assert!(!m.created_at.is_empty());
    }

    #[test]
    fn test_export_empty_session() {
        let dir = tempfile::tempdir().unwrap();
        let store = SqliteStore::in_memory().unwrap();
        let record_store = RecordStore::new(store);
        let session_dir = dir.path().join("sessions").join("test-session");
        std::fs::create_dir_all(&session_dir).unwrap();

        let result = export_session(
            "test-session",
            &session_dir,
            &record_store,
        );

        // The export should succeed and produce a valid zip
        assert!(result.is_ok(), "export failed: {:?}", result.err());
        let zip_data = result.unwrap();
        assert!(!zip_data.is_empty(), "zip should not be empty");
    }
}