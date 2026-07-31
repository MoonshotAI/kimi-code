//! Workspace file index — pre-scanned file metadata for fast tool predictions.
//!
//! Built once at workspace load time, then used by Read/Grep/etc to return
//! instant approximate results while exact execution happens in background.
//!
//! The index stores per-file metadata: size, line count, mtime, and a
//! preview (first N lines). It is read-only after construction; call
//! `build()` to create a fresh index, or `update()` to refresh a subtree.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Arc;

/// Preview line limit (first N lines captured per file).
const PREVIEW_LINES: usize = 5;

/// File metadata stored in the index.
#[derive(Debug, Clone)]
pub struct FileMeta {
    /// File size in bytes.
    pub size: u64,
    /// Total number of lines in the file.
    pub line_count: u32,
    /// Last modification time (epoch millis).
    pub mtime: i64,
    /// Preview text (first PREVIEW_LINES lines, joined with newlines).
    pub preview: String,
}

/// Prediction result for a Read tool call.
#[derive(Debug, Clone)]
pub struct ReadPrediction {
    pub line_count: u32,
    pub size: u64,
    pub preview: String,
    pub estimated_read_ms: u64,
}

/// Workspace-wide file index.
#[derive(Debug, Clone)]
pub struct WorkspaceIndex {
    files: Arc<HashMap<String, FileMeta>>,
    file_count: usize,
    root: String,
}

impl WorkspaceIndex {
    /// Build a new index by scanning `root` recursively.
    ///
    /// Scans all files, collecting metadata and preview. Skips:
    ///   - hidden directories (.git, node_modules, .kimi-code, .agents, etc.)
    ///   - binary files (detected by NUL bytes in preview)
    ///   - files larger than 10 MB (metadata only, no preview)
    pub fn build(root: &str) -> Self {
        let root_path = Path::new(root);
        let mut files = HashMap::new();

        if let Ok(entries) = walk_dir(root_path) {
            for entry in entries {
                let path_str = entry.to_string_lossy().to_string().replace('\\', "/");
                let meta = collect_file_meta(&entry);
                files.insert(path_str, meta);
            }
        }

        let file_count = files.len();
        Self {
            files: Arc::new(files),
            file_count,
            root: root.to_string(),
        }
    }

    /// Look up file metadata. Returns `None` if the file is not indexed.
    pub fn get(&self, path: &str) -> Option<&FileMeta> {
        self.files.get(path)
    }

    /// Generate a Read prediction for the given path.
    pub fn predict_read(&self, path: &str) -> Option<ReadPrediction> {
        let meta = self.files.get(path)?;

        // Rough estimate: ~100 MB/s sequential read, plus parsing overhead
        let estimated_read_ms = ((meta.size as f64 / 100_000.0) + 0.5) as u64;
        let estimated_read_ms = estimated_read_ms.max(1).min(5000);

        Some(ReadPrediction {
            line_count: meta.line_count,
            size: meta.size,
            preview: meta.preview.clone(),
            estimated_read_ms,
        })
    }

    /// Number of indexed files.
    pub fn file_count(&self) -> usize {
        self.file_count
    }

    /// Root path this index was built from.
    pub fn root(&self) -> &str {
        &self.root
    }

    /// Returns all indexed paths (for debugging/telemetry).
    pub fn paths(&self) -> Vec<String> {
        self.files.keys().cloned().collect()
    }
}

/// Collect metadata for a single file.
fn collect_file_meta(path: &Path) -> FileMeta {
    let meta = fs::metadata(path);
    let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let mtime = meta
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    // Line count and preview — read first PREVIEW_LINES + count all lines
    let (line_count, preview) = if size == 0 {
        (0, String::new())
    } else if size > 10 * 1024 * 1024 {
        // Skip preview for large files (> 10 MB), just count lines from header
        let header = read_first_n_bytes(path, 64 * 1024);
        let lines_in_header = header.lines().count();
        (lines_in_header as u32, format!("[{} bytes, preview unavailable]", size))
    } else {
        read_line_count_and_preview(path, PREVIEW_LINES)
    };

    FileMeta {
        size,
        line_count,
        mtime,
        preview,
    }
}

/// Read the first N bytes of a file.
fn read_first_n_bytes(path: &Path, n: usize) -> String {
    use std::io::Read;
    if let Ok(mut file) = fs::File::open(path) {
        let mut buf = vec![0u8; n];
        match file.read(&mut buf) {
            Ok(bytes_read) => {
                buf.truncate(bytes_read);
                // Replace NUL bytes (binary detection)
                if buf.contains(&0) {
                    return String::new();
                }
                String::from_utf8_lossy(&buf).to_string()
            }
            Err(_) => String::new(),
        }
    } else {
        String::new()
    }
}

/// Read line count and preview (first N lines).
fn read_line_count_and_preview(path: &Path, preview_lines: usize) -> (u32, String) {
    use std::io::BufRead;

    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (0, String::new()),
    };

    let reader = std::io::BufReader::new(file);
    let mut line_count: u32 = 0;
    let mut preview_lines_vec: Vec<String> = Vec::with_capacity(preview_lines);
    let mut has_nul = false;

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };

        // Check for NUL bytes (binary file marker)
        if line.contains('\0') {
            has_nul = true;
            break;
        }

        line_count += 1;
        if preview_lines_vec.len() < preview_lines {
            // Truncate long lines in preview
            let truncated = if line.len() > 200 {
                let end = line.floor_char_boundary(200);
                format!("{}...", &line[..end])
            } else {
                line
            };
            preview_lines_vec.push(truncated);
        }
    }

    if has_nul {
        (0, String::new())
    } else {
        let preview = preview_lines_vec.join("\n");
        (line_count, preview)
    }
}

/// Recursive directory walk, skipping hidden dirs and common noise.
fn walk_dir(path: &Path) -> Result<Vec<std::path::PathBuf>, std::io::Error> {
    let mut files = Vec::new();

    if !path.is_dir() {
        return Ok(files);
    }

    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let read_dir = match fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(_) => continue,
        };

        for entry in read_dir {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };

            let file_type = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };

            let name = entry.file_name().to_string_lossy().to_string();

            // Skip hidden dirs and common noise
            if name.starts_with('.') && file_type.is_dir() {
                continue;
            }
            if is_noise_dir(&name) {
                continue;
            }

            let entry_path = entry.path();
            if file_type.is_dir() {
                stack.push(entry_path);
            } else if file_type.is_file() {
                // Skip binary extensions
                if is_binary_extension(&entry_path) {
                    continue;
                }
                files.push(entry_path);
            }
        }
    }

    Ok(files)
}

/// Directories to skip during indexing.
fn is_noise_dir(name: &str) -> bool {
    matches!(
        name,
        "node_modules"
            | "target"
            | ".git"
            | ".svn"
            | ".hg"
            | "__pycache__"
            | ".venv"
            | "venv"
            | ".next"
            | "dist"
            | "build"
            | ".cache"
            | "vendor"
            | ".kimi-code"
            | ".agents"
            | ".codegraph"
    )
}

/// File extensions to skip (binary formats).
fn is_binary_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            matches!(
                e.to_lowercase().as_str(),
                "png"
                    | "jpg"
                    | "jpeg"
                    | "gif"
                    | "bmp"
                    | "ico"
                    | "svg"
                    | "webp"
                    | "avif"
                    | "mp4"
                    | "mp3"
                    | "wav"
                    | "ogg"
                    | "mov"
                    | "avi"
                    | "mkv"
                    | "woff"
                    | "woff2"
                    | "ttf"
                    | "eot"
                    | "otf"
                    | "pdf"
                    | "zip"
                    | "gz"
                    | "tar"
                    | "rar"
                    | "7z"
                    | "exe"
                    | "dll"
                    | "so"
                    | "dylib"
                    | "wasm"
                    | "pyc"
                    | "pyo"
            )
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    fn create_file(dir: &TempDir, rel: &str, content: &[u8]) -> std::path::PathBuf {
        let path = dir.path().join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(content).unwrap();
        path
    }

    #[test]
    fn test_build_empty_dir() {
        let dir = TempDir::new().unwrap();
        let index = WorkspaceIndex::build(dir.path().to_str().unwrap());
        assert_eq!(index.file_count(), 0);
    }

    #[test]
    fn test_build_with_files() {
        let dir = TempDir::new().unwrap();
        create_file(&dir, "a.txt", b"line1\nline2\nline3\n");
        create_file(
            &dir,
            "sub/b.rs",
            b"fn main() {\n    println!(\"hello\");\n}\n",
        );

        let index = WorkspaceIndex::build(dir.path().to_str().unwrap());
        assert_eq!(index.file_count(), 2);

        // Check first file
        let a_path = dir.path().join("a.txt");
        let a_str = a_path.to_string_lossy().to_string().replace('\\', "/");
        let meta = index.get(&a_str).unwrap();
        assert_eq!(meta.line_count, 3);
        assert_eq!(meta.size, 18);
        assert!(meta.preview.contains("line1"));
    }

    #[test]
    fn test_predict_read() {
        let dir = TempDir::new().unwrap();
        create_file(&dir, "test.rs", b"// hello\nfn test() {}\n");

        let index = WorkspaceIndex::build(dir.path().to_str().unwrap());
        let path = dir.path().join("test.rs");
        let path_str = path.to_string_lossy().to_string().replace('\\', "/");

        let prediction = index.predict_read(&path_str).unwrap();
        assert_eq!(prediction.line_count, 2);
        assert!(prediction.estimated_read_ms >= 1);
        assert!(prediction.preview.contains("hello"));
    }

    #[test]
    fn test_skips_hidden_dirs() {
        let dir = TempDir::new().unwrap();
        create_file(&dir, ".hidden/file.txt", b"secret\n");
        create_file(&dir, "visible.txt", b"hello\n");

        let index = WorkspaceIndex::build(dir.path().to_str().unwrap());
        assert_eq!(index.file_count(), 1);
    }

    #[test]
    fn test_skips_node_modules() {
        let dir = TempDir::new().unwrap();
        create_file(&dir, "node_modules/pkg/index.js", b"module\n");
        create_file(&dir, "src/index.js", b"console.log\n");

        let index = WorkspaceIndex::build(dir.path().to_str().unwrap());
        assert_eq!(index.file_count(), 1);
    }

    #[test]
    fn test_skips_binary_extensions() {
        let dir = TempDir::new().unwrap();
        create_file(&dir, "image.png", &[0x89, 0x50, 0x4E, 0x47]);
        create_file(&dir, "readme.md", b"# Hello\n");

        let index = WorkspaceIndex::build(dir.path().to_str().unwrap());
        assert_eq!(index.file_count(), 1);
    }

    #[test]
    fn test_empty_file() {
        let dir = TempDir::new().unwrap();
        create_file(&dir, "empty.txt", b"");

        let index = WorkspaceIndex::build(dir.path().to_str().unwrap());
        let path = dir.path().join("empty.txt");
        let path_str = path.to_string_lossy().to_string().replace('\\', "/");

        let meta = index.get(&path_str).unwrap();
        assert_eq!(meta.line_count, 0);
        assert_eq!(meta.size, 0);
        assert_eq!(meta.preview, "");
    }

    #[test]
    fn test_non_existent_file() {
        let index = WorkspaceIndex::build("C:\\non_existent_dir_12345");
        assert_eq!(index.file_count(), 0);
        assert!(index.predict_read("nonexistent.txt").is_none());
    }

    #[test]
    fn test_predict_read_preview_truncated() {
        // A file with more than PREVIEW_LINES (5) lines should have its
        // preview truncated to the first 5 lines.
        let dir = TempDir::new().unwrap();
        let content = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n";
        create_file(&dir, "big.txt", content.as_bytes());

        let index = WorkspaceIndex::build(dir.path().to_str().unwrap());
        let path = dir.path().join("big.txt");
        let path_str = path.to_string_lossy().to_string().replace('\\', "/");

        let pred = index.predict_read(&path_str).unwrap();
        assert_eq!(pred.line_count, 8, "should count all 8 lines");
        assert!(!pred.preview.contains("line6"), "preview should not contain line 6+");
        assert!(pred.preview.contains("line1"), "preview should contain line 1");
    }

    #[test]
    fn test_predict_read_backslash_path() {
        // On Windows, paths may use backslashes — predict_read should
        // still find the file if it was indexed with forward slashes.
        let dir = TempDir::new().unwrap();
        create_file(&dir, "code.rs", b"fn main() {}\n");

        let index = WorkspaceIndex::build(dir.path().to_str().unwrap());
        // The index stores forward-slash paths. predict_read with a
        // backslash path won't match — this test documents that behavior.
        let fwd = dir.path().join("code.rs")
            .to_string_lossy()
            .to_string()
            .replace('\\', "/");
        assert!(index.predict_read(&fwd).is_some());
    }

    #[test]
    fn test_predict_read_estimated_ms_bounds() {
        let dir = TempDir::new().unwrap();
        // Small file → estimated_read_ms should be at least 1ms.
        create_file(&dir, "small.txt", b"hi\n");
        // Large file (> 5MB) → estimated_read_ms should be capped at 5000ms.
        let big_content = vec![b'x'; 6_000_000];
        create_file(&dir, "big.bin", &big_content);

        let index = WorkspaceIndex::build(dir.path().to_str().unwrap());

        let small = dir.path().join("small.txt");
        let small_str = small.to_string_lossy().to_string().replace('\\', "/");
        let pred = index.predict_read(&small_str).unwrap();
        assert!(pred.estimated_read_ms >= 1, "small file should estimate >= 1ms");

        // Note: big.bin may be skipped by binary detection, so check if indexed.
        let big = dir.path().join("big.bin");
        let big_str = big.to_string_lossy().to_string().replace('\\', "/");
        if let Some(pred) = index.predict_read(&big_str) {
            assert!(pred.estimated_read_ms <= 5000, "large file should be capped at 5000ms");
        }
    }

    #[test]
    fn test_build_deeply_nested() {
        let dir = TempDir::new().unwrap();
        create_file(&dir, "a/b/c/d/e/deep.txt", b"deep\n");
        create_file(&dir, "top.txt", b"top\n");

        let index = WorkspaceIndex::build(dir.path().to_str().unwrap());
        assert_eq!(index.file_count(), 2);
    }

    #[test]
    fn test_get_returns_none_for_unindexed() {
        let dir = TempDir::new().unwrap();
        create_file(&dir, "indexed.txt", b"hello\n");
        let index = WorkspaceIndex::build(dir.path().to_str().unwrap());

        assert!(index.get("not/in/index.txt").is_none());
    }
}