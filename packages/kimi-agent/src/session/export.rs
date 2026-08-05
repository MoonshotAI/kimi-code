//! Session export — package a session directory into a zip archive with
//! manifest and wire log scan.
//!
//! Mirrors `packages/agent-core/src/session/export/`.

use std::io::{Read, Seek, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::persistence::record_store::RecordStore;

/// Web log size cap (bytes, UTF-8), matching the upstream `sessionExport`
/// route's 256 KiB rejection.
pub const MAX_WEB_LOG_BYTES: usize = 256 * 1024;

/// Export manifest — metadata about the exported session. Field names are
/// camelCase to match the v1 export manifest wire shape (`sessionId`,
/// `webLogPath`, …).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportManifest {
    pub version: u32,
    pub created_at: String,
    pub session_id: String,
    pub protocol_version: u32,
    pub turn_count: u32,
    pub os: String,
    pub kimi_version: String,
    /// Archive-relative path of the web log entry, when one was supplied.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_log_path: Option<String>,
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
        web_log_path: None,
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
    export_session_with_web_log(session_id, session_dir, record_store, None)
}

/// Export with an optional client-supplied web JSONL log (`web_log`), archived
/// as `logs/kimi-web.jsonl` with a matching manifest `webLogPath` entry.
///
/// The log is size-bounded: the upstream `sessionExport` route rejects logs
/// larger than 256 KiB (UTF-8 bytes), and the engine enforces the same cap so
/// a rogue payload cannot bloat the archive or the response envelope.
pub fn export_session_with_web_log(
    session_id: &str,
    session_dir: &Path,
    record_store: &RecordStore,
    web_log: Option<&str>,
) -> Result<Vec<u8>, String> {
    if let Some(log) = web_log {
        if log.len() > MAX_WEB_LOG_BYTES {
            return Err(format!(
                "web_log exceeds the {MAX_WEB_LOG_BYTES}-byte cap ({} bytes)",
                log.len()
            ));
        }
    }
    let zip_buf = std::io::Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(zip_buf);

    let options = zip::write::FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    // 1. Add manifest
    let scan = wire_scan(record_store, session_id);
    let mut manifest = build_manifest(session_id, scan.record_count as u32);
    if web_log.is_some() {
        manifest.web_log_path = Some("logs/kimi-web.jsonl".to_string());
    }
    let manifest_json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    zip.start_file("manifest.json", options).map_err(|e| e.to_string())?;
    zip.write_all(manifest_json.as_bytes()).map_err(|e| e.to_string())?;

    // 2. Add wire records
    let records = record_store.get_records(session_id, None, 1_000_000).unwrap_or_default();
    let records_json = serde_json::to_string_pretty(&records).map_err(|e| e.to_string())?;
    zip.start_file("wire.json", options).map_err(|e| e.to_string())?;
    zip.write_all(records_json.as_bytes()).map_err(|e| e.to_string())?;

    // 2b. Add the client-supplied web log (when present)
    if let Some(log) = web_log {
        zip.start_file("logs/kimi-web.jsonl", options).map_err(|e| e.to_string())?;
        zip.write_all(log.as_bytes()).map_err(|e| e.to_string())?;
    }

    // 3. Add session files from the session directory
    if session_dir.exists() {
        add_dir_to_zip(&mut zip, session_dir, session_dir, &options)?;
    }

    let cursor = zip.finish().map_err(|e| e.to_string())?;
    Ok(cursor.into_inner())
}

/// Recursively add a directory's contents to a zip archive.
///
/// Bounded: skips heavy/generated subtrees (`node_modules`, `.git`, `target`)
/// and caps per-file size so a large workspace cannot stall the export RPC or
/// blow the response envelope.
fn add_dir_to_zip<W: Write + Seek>(
    zip: &mut zip::ZipWriter<W>,
    base: &Path,
    dir: &Path,
    options: &zip::write::FileOptions,
) -> Result<(), String> {
    // Per-file cap (64 MiB) protects against vendored binaries dominating the
    // archive; the record/context payloads are already bounded upstream.
    const MAX_EXPORT_FILE_BYTES: u64 = 64 * 1024 * 1024;
    let entries = std::fs::read_dir(dir).map_err(|e| format!("read dir {dir:?}: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let relative = path
            .strip_prefix(base)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string();

        // Skip heavy/generated subtrees that dominate repo archives without
        // contributing session state.
        let name = entry.file_name().to_string_lossy().to_string();
        if matches!(name.as_str(), "node_modules" | ".git" | "target" | "dist" | ".next") {
            continue;
        }

        if path.is_dir() {
            zip.add_directory(&format!("{relative}/"), *options)
                .map_err(|e| e.to_string())?;
            add_dir_to_zip(zip, base, &path, options)?;
        } else if path.is_file() {
            let meta = std::fs::metadata(&path).map_err(|e| format!("stat {path:?}: {e}"))?;
            if meta.len() > MAX_EXPORT_FILE_BYTES {
                continue;
            }
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

    #[test]
    fn test_export_with_web_log_injects_manifest_and_archive_entry() {
        let dir = tempfile::tempdir().unwrap();
        let store = SqliteStore::in_memory().unwrap();
        let record_store = RecordStore::new(store);
        let session_dir = dir.path().join("sessions").join("test-session");
        std::fs::create_dir_all(&session_dir).unwrap();

        let log = r#"{"type":"user.message","text":"hi"}
{"type":"assistant.message","text":"hello"}
"#;
        let result = export_session_with_web_log(
            "test-session",
            &session_dir,
            &record_store,
            Some(log),
        );
        assert!(result.is_ok(), "export failed: {:?}", result.err());
        let zip_data = result.unwrap();

        // The archive carries the log at logs/kimi-web.jsonl and the manifest
        // advertises it via webLogPath.
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(&zip_data)).expect("read zip");
        let manifest: ExportManifest = {
            let mut file = archive.by_name("manifest.json").expect("manifest entry");
            let mut text = String::new();
            std::io::Read::read_to_string(&mut file, &mut text).expect("read manifest");
            serde_json::from_str(&text).expect("parse manifest")
        };
        assert_eq!(
            manifest.web_log_path.as_deref(),
            Some("logs/kimi-web.jsonl"),
            "webLogPath: {manifest:?}"
        );
        let mut file = archive.by_name("logs/kimi-web.jsonl").expect("web log entry");
        let mut text = String::new();
        std::io::Read::read_to_string(&mut file, &mut text).expect("read web log");
        assert_eq!(text, log, "archived web log matches the input");
    }

    #[test]
    fn test_export_rejects_oversized_web_log() {
        let dir = tempfile::tempdir().unwrap();
        let store = SqliteStore::in_memory().unwrap();
        let record_store = RecordStore::new(store);
        let session_dir = dir.path().join("sessions").join("test-session");
        std::fs::create_dir_all(&session_dir).unwrap();

        // 87_382 CJK chars ≈ 262_146 bytes > 256 KiB, mirroring the upstream
        // route's rejection fixture.
        let oversized = "你".repeat(87_382);
        assert!(oversized.len() > MAX_WEB_LOG_BYTES, "fixture must exceed the cap");
        let result = export_session_with_web_log(
            "test-session",
            &session_dir,
            &record_store,
            Some(&oversized),
        );
        let err = result.expect_err("oversized web log must be rejected");
        assert!(err.contains("web_log"), "error mentions web_log: {err}");
        assert!(err.contains("262144"), "error mentions the cap: {err}");
    }
}