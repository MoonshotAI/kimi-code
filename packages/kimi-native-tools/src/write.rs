/// Write tool — overwrite or append to a file.
///
/// Creates parent directories automatically.
/// Mirrors `packages/agent-core/src/tools/builtin/file/write.ts`.
use napi_derive::napi;
use std::fs;
use std::io::Write;
use std::path::Path;

/// POSIX stat mode bits.
#[cfg(unix)]
const S_IFMT: u32 = 0o170000;
#[cfg(unix)]
const S_IFDIR: u32 = 0o040000;

/// Result of a write operation.
#[derive(Debug, Clone)]
#[napi(object)]
pub struct WriteResult {
    pub bytes_written: i32,
    pub error: Option<String>,
}

/// Write mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteMode {
    Overwrite,
    Append,
}

/// Write content to a file.
///
/// Behavior:
///   - Creates the file if it does not exist.
///   - Creates missing parent directories automatically.
///   - `mode`: 'overwrite' (default) or 'append'.
///   - Returns the number of UTF-8 bytes written.
pub fn write_file(path: &str, content: &str, mode: WriteMode) -> WriteResult {
    let file_path = Path::new(path);

    // Ensure parent directory exists.
    if let Some(parent) = file_path.parent() {
        if !parent.as_os_str().is_empty() {
            match ensure_parent_directory(parent) {
                Ok(()) => {}
                Err(e) => {
                    return WriteResult {
                        bytes_written: 0,
                        error: Some(e),
                    };
                }
            }
        }
    }

    // Open file with appropriate mode. `truncate` is deliberately applied
    // *after* the post-open descriptor validation below, so a path whose
    // component was swapped for a symlink fails closed before any existing
    // content is destroyed.
    let file = match mode {
        WriteMode::Overwrite => fs::OpenOptions::new()
            .write(true)
            .create(true)
            .open(file_path),
        WriteMode::Append => fs::OpenOptions::new()
            
            .create(true)
            .append(true)
            .open(file_path),
    };

    let mut file = match file {
        Ok(f) => f,
        Err(e) => {
            let msg = e.to_string();
            if e.kind() == std::io::ErrorKind::NotFound {
                return WriteResult {
                    bytes_written: 0,
                    error: Some(format!(
                        "Failed to write {}: parent directory does not exist.",
                        path
                    )),
                };
            }
            return WriteResult {
                bytes_written: 0,
                error: Some(msg),
            };
        }
    };

    // Post-open TOCTOU check: on Unix, verify the descriptor refers to the
    // canonical form of `path` (the caller already containment-checked it).
    // On platforms without descriptor identity the check is compiled out —
    // see `path_access::validate_opened_file`.
    #[cfg(unix)]
    {
        if let Err(e) = crate::path_access::validate_opened_file(path, &file) {
            return WriteResult {
                bytes_written: 0,
                error: Some(e),
            };
        }
    }

    // Overwrite mode: truncate only after the descriptor passed validation.
    if mode == WriteMode::Overwrite {
        if let Err(e) = file.set_len(0) {
            return WriteResult {
                bytes_written: 0,
                error: Some(e.to_string()),
            };
        }
    }

    match file.write_all(content.as_bytes()) {
        Ok(()) => {
            let bytes = content.len();
            WriteResult {
                bytes_written: bytes as i32,
                error: None,
            }
        }
        Err(e) => WriteResult {
            bytes_written: 0,
            error: Some(e.to_string()),
        },
    }
}

fn ensure_parent_directory(parent: &Path) -> Result<(), String> {
    match fs::metadata(parent) {
        Ok(meta) => {
            // Check if it's a directory.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = meta.permissions().mode();
                if (mode & S_IFMT) != S_IFDIR {
                    return Err(format!(
                        "Parent path is not a directory: {}",
                        parent.display()
                    ));
                }
            }
            #[cfg(windows)]
            {
                if !meta.is_dir() {
                    return Err(format!(
                        "Parent path is not a directory: {}",
                        parent.display()
                    ));
                }
            }
            Ok(())
        }
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                // Create parent directories recursively.
                fs::create_dir_all(parent).map_err(|e| e.to_string())
            } else {
                // Other errors — skip the check and let the write surface the error.
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use tempfile::TempDir;

    #[test]
    fn test_write_new_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.txt");
        let result = write_file(path.to_str().unwrap(), "hello world", WriteMode::Overwrite);
        assert!(result.error.is_none());
        assert_eq!(result.bytes_written, 11);

        let mut content = String::new();
        fs::File::open(&path)
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert_eq!(content, "hello world");
    }

    #[test]
    fn test_write_append() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.txt");

        write_file(path.to_str().unwrap(), "hello ", WriteMode::Overwrite);
        let result = write_file(path.to_str().unwrap(), "world", WriteMode::Append);
        assert!(result.error.is_none());
        assert_eq!(result.bytes_written, 5);

        let mut content = String::new();
        fs::File::open(&path)
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert_eq!(content, "hello world");
    }

    #[test]
    fn test_write_creates_parent_dirs() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("a").join("b").join("c").join("test.txt");
        let result = write_file(path.to_str().unwrap(), "nested", WriteMode::Overwrite);
        assert!(result.error.is_none());
        assert_eq!(result.bytes_written, 6);

        let mut content = String::new();
        fs::File::open(&path)
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert_eq!(content, "nested");
    }

    #[test]
    fn test_write_overwrite_truncates() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.txt");

        write_file(path.to_str().unwrap(), "long content here", WriteMode::Overwrite);
        let result = write_file(path.to_str().unwrap(), "short", WriteMode::Overwrite);
        assert!(result.error.is_none());

        let mut content = String::new();
        fs::File::open(&path)
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert_eq!(content, "short");
    }

    #[test]
    fn test_write_utf8_bytes() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.txt");
        // "你好" is 6 bytes in UTF-8.
        let result = write_file(path.to_str().unwrap(), "你好", WriteMode::Overwrite);
        assert!(result.error.is_none());
        assert_eq!(result.bytes_written, 6);
    }
}
