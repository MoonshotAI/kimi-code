/// Read tool — reads a text file with line numbers, respecting MAX_LINES,
/// MAX_LINE_LENGTH, and MAX_BYTES limits. Supports forward reading and
/// tail reading (negative line_offset).
///
/// Mirrors `packages/agent-core/src/tools/builtin/file/read.ts`.
use crate::file_type::{detect_file_type, FileKind, MEDIA_SNIFF_BYTES};
use crate::line_endings::{make_carriage_returns_visible, strip_trailing_lf, LineEndingFlags, LineEndingStyle};
use napi_derive::napi;
use std::collections::VecDeque;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read};
use std::path::Path;

/// Maximum lines that can be read or tailed in one call.
pub const MAX_LINES: usize = 1000;
/// Individual lines longer than this are truncated with `...`.
pub const MAX_LINE_LENGTH: usize = 2000;
/// Output stops once rendered output exceeds this byte count (UTF-8).
pub const MAX_BYTES: usize = 100 * 1024;

/// Result of a read operation.
#[derive(Debug, Clone)]
#[napi(object)]
pub struct ReadResult {
    pub content: String,
    pub line_count: i32,
    pub error: Option<String>,
}

/// Configuration for a read operation.
pub struct ReadConfig {
    pub path: String,
    pub line_offset: Option<i64>,
    pub n_lines: Option<u32>,
}

/// Read a text file, returning formatted content with line numbers.
///
/// Behavior:
///   - `line_offset` positive: start from that line (1-indexed)
///   - `line_offset` negative: read from end of file (tail mode)
///   - `n_lines`: number of lines to read (capped at MAX_LINES)
///   - Lines longer than MAX_LINE_LENGTH are truncated
///   - Output stops at MAX_BYTES
pub fn read_file(config: &ReadConfig) -> ReadResult {
    let path = Path::new(&config.path);

    // Check file exists and is a regular file.
    match std::fs::metadata(path) {
        Ok(meta) => {
            if meta.is_dir() {
                return ReadResult {
                    content: String::new(),
                    line_count: 0,
                    error: Some(format!("\"{}\" is not a file.", config.path)),
                };
            }
            // Check POSIX file type via mode bits (cross-platform).
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = meta.permissions().mode();
                if (mode & 0o170000) != 0o100000 {
                    return ReadResult {
                        content: String::new(),
                        line_count: 0,
                        error: Some(format!("\"{}\" is not a file.", config.path)),
                    };
                }
            }
        }
        Err(e) => {
            if e.kind() == io::ErrorKind::NotFound {
                return ReadResult {
                    content: String::new(),
                    line_count: 0,
                    error: Some(format!("\"{}\" does not exist.", config.path)),
                };
            }
            return ReadResult {
                content: String::new(),
                line_count: 0,
                error: Some(e.to_string()),
            };
        }
    }

    // Sniff file type from header bytes.
    let header = match read_header_bytes(path, MEDIA_SNIFF_BYTES) {
        Ok(h) => h,
        Err(e) => {
            return ReadResult {
                content: String::new(),
                line_count: 0,
                error: Some(e.to_string()),
            };
        }
    };

    match detect_file_type(path, &header) {
        FileKind::Image => {
            return ReadResult {
                content: String::new(),
                line_count: 0,
                error: Some(format!(
                    "\"{}\" is an image file. Use ReadMediaFile to read image or video files.",
                    config.path
                )),
            };
        }
        FileKind::Video => {
            return ReadResult {
                content: String::new(),
                line_count: 0,
                error: Some(format!(
                    "\"{}\" is a video file. Use ReadMediaFile to read image or video files.",
                    config.path
                )),
            };
        }
        FileKind::Unknown => {
            return ReadResult {
                content: String::new(),
                line_count: 0,
                error: Some(not_readable_message(&config.path)),
            };
        }
        FileKind::Text => {}
    }

    let scan = match scan_text_file(path) {
        Ok(scan) => scan,
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("invalid") && msg.contains("utf") {
                return ReadResult {
                    content: String::new(),
                    line_count: 0,
                    error: Some(not_readable_message(&config.path)),
                };
            }
            return ReadResult {
                content: String::new(),
                line_count: 0,
                error: Some(msg),
            };
        }
    };

    if scan.has_nul {
        return ReadResult {
            content: String::new(),
            line_count: 0,
            error: Some(not_readable_message(&config.path)),
        };
    }

    if scan.total_lines == 0 {
        return ReadResult {
            content: String::new(),
            line_count: 0,
            error: None,
        };
    }

    let line_offset = config.line_offset.unwrap_or(1);

    if line_offset < 0 {
        let tail_count = (-line_offset) as usize;
        let tail_count = tail_count.min(MAX_LINES);
        // Single-pass: scan + tail read in one file traversal.
        scan_and_read_tail(path, tail_count, config.n_lines)
    } else {
        let start_line = line_offset as usize;
        let max_lines = config.n_lines.unwrap_or(MAX_LINES as u32) as usize;
        let max_lines = max_lines.min(MAX_LINES);
        // Single-pass: scan + read in one file traversal.
        scan_and_read_forward(path, start_line, max_lines)
    }
}

struct TextScanResult {
    total_lines: usize,
    has_nul: bool,
}

fn scan_text_file(path: &Path) -> io::Result<TextScanResult> {
    let mut file = File::open(path)?;
    let mut buf = [0u8; 64 * 1024];
    let mut total_lines = 0usize;
    let mut has_nul = false;
    let mut saw_any = false;
    let mut last_byte = None;
    let mut flags = LineEndingFlags::default();
    let mut pending_cr = false;

    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        saw_any = true;
        for &byte in &buf[..n] {
            if byte == 0 {
                has_nul = true;
            }
            if byte == b'\n' {
                total_lines += 1;
            }
            if pending_cr {
                if byte == b'\n' {
                    flags.feed_crlf();
                    pending_cr = false;
                    last_byte = Some(byte);
                    continue;
                }
                flags.feed(b'\r');
                pending_cr = false;
            }
            if byte == b'\r' {
                pending_cr = true;
            } else {
                flags.feed(byte);
            }
            last_byte = Some(byte);
        }
    }

    if pending_cr {
        flags.feed(b'\r');
    }

    if saw_any && last_byte != Some(b'\n') {
        total_lines += 1;
    }

    Ok(TextScanResult {
        total_lines,
        has_nul,
    })
}

/// Single-pass scan + read: reads the file once, detecting line endings and
/// NUL bytes while simultaneously collecting the requested line range.
/// Returns the ReadResult directly, avoiding a second file traversal.
fn scan_and_read_forward(
    path: &Path,
    start_line: usize,
    max_lines: usize,
) -> ReadResult {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(e) => {
            return ReadResult {
                content: String::new(),
                line_count: 0,
                error: Some(e.to_string()),
            };
        }
    };

    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut line_no = 0usize;
    let mut total_lines = 0usize;
    let mut has_nul = false;
    let mut flags = LineEndingFlags::default();
    let mut rendered = Vec::new();
    let mut total_bytes = 0usize;
    let mut truncated_line_numbers = Vec::new();
    let mut max_lines_reached = false;

    loop {
        line.clear();
        let bytes_read = match reader.read_line(&mut line) {
            Ok(n) => n,
            Err(e) => {
                return ReadResult {
                    content: String::new(),
                    line_count: total_lines as i32,
                    error: Some(e.to_string()),
                };
            }
        };
        if bytes_read == 0 {
            break;
        }

        // Check for NUL bytes.
        if line.as_bytes().contains(&0) {
            has_nul = true;
        }

        // Track line endings.
        let stripped_for_scan = line.strip_suffix("\r\n").or_else(|| line.strip_suffix('\n')).unwrap_or(&line);
        for ch in stripped_for_scan.bytes() {
            if ch == b'\r' {
                flags.feed(ch);
            } else if ch == b'\n' {
                flags.feed(ch);
            } else {
                flags.feed(ch);
            }
        }
        // Correct CRLF detection: if line ends with \r\n, mark as CRLF.
        if line.ends_with("\r\n") {
            flags.feed_crlf();
        }

        total_lines += 1;
        line_no += 1;

        // Skip lines before start_line.
        if line_no < start_line {
            continue;
        }

        // Stop if we've collected enough lines.
        if rendered.len() >= max_lines {
            max_lines_reached = max_lines >= MAX_LINES;
            continue; // keep counting total_lines
        }

        let stripped = strip_trailing_lf(&line);
        let (rendered_line, was_truncated) = render_line(stripped, line_no, flags.style());
        if was_truncated {
            truncated_line_numbers.push(line_no);
        }
        let line_bytes = rendered_line.len() + 1;
        if total_bytes + line_bytes > MAX_BYTES && !rendered.is_empty() {
            break;
        }
        total_bytes += line_bytes;
        rendered.push(rendered_line);
    }

    if has_nul {
        return ReadResult {
            content: String::new(),
            line_count: 0,
            error: Some(not_readable_message(&path.to_string_lossy())),
        };
    }

    if total_lines == 0 {
        return ReadResult {
            content: String::new(),
            line_count: 0,
            error: None,
        };
    }

    if start_line > total_lines {
        let message = format!(
            "Line {} exceeds the total number of lines ({}).",
            start_line, total_lines
        );
        return ReadResult {
            content: finish_output(&[], &message),
            line_count: total_lines as i32,
            error: None,
        };
    }

    let message = finish_message(
        rendered.len(),
        start_line,
        total_lines,
        max_lines_reached,
        total_bytes >= MAX_BYTES,
        &truncated_line_numbers,
        flags.style(),
        max_lines,
    );
    let content = finish_output(&rendered, &message);

    ReadResult {
        content,
        line_count: total_lines as i32,
        error: None,
    }
}

/// Single-pass scan + tail read: reads the file once, keeping the last N lines
/// in a ring buffer while simultaneously detecting line endings and NUL bytes.
fn scan_and_read_tail(
    path: &Path,
    tail_count: usize,
    n_lines: Option<u32>,
) -> ReadResult {
    let effective_limit = n_lines
        .map(|n| (n as usize).min(MAX_LINES))
        .unwrap_or(tail_count.min(MAX_LINES));
    let keep = tail_count.min(MAX_LINES).max(effective_limit);

    let file = match File::open(path) {
        Ok(f) => f,
        Err(e) => {
            return ReadResult {
                content: String::new(),
                line_count: 0,
                error: Some(e.to_string()),
            };
        }
    };

    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut total_lines = 0usize;
    let mut has_nul = false;
    let mut flags = LineEndingFlags::default();
    let mut ring: VecDeque<(usize, String)> = VecDeque::new();

    loop {
        line.clear();
        let bytes_read = match reader.read_line(&mut line) {
            Ok(n) => n,
            Err(e) => {
                return ReadResult {
                    content: String::new(),
                    line_count: total_lines as i32,
                    error: Some(e.to_string()),
                };
            }
        };
        if bytes_read == 0 {
            break;
        }

        if line.as_bytes().contains(&0) {
            has_nul = true;
        }

        // Track line endings.
        if line.ends_with("\r\n") {
            flags.feed_crlf();
        } else if line.ends_with('\n') {
            flags.feed(b'\n');
        } else if line.ends_with('\r') {
            flags.feed(b'\r');
        }

        total_lines += 1;
        let raw = strip_trailing_lf(&line).to_string();
        ring.push_back((total_lines, raw));
        while ring.len() > keep {
            ring.pop_front();
        }
    }

    if has_nul {
        return ReadResult {
            content: String::new(),
            line_count: 0,
            error: Some(not_readable_message(&path.to_string_lossy())),
        };
    }

    if total_lines == 0 {
        return ReadResult {
            content: String::new(),
            line_count: 0,
            error: None,
        };
    }

    let mut entries: Vec<(usize, String)> = ring.into_iter().collect();
    if entries.len() > effective_limit {
        let skip = entries.len() - effective_limit;
        entries = entries.into_iter().skip(skip).collect();
    }

    let line_ending_style = flags.style();
    let mut rendered = Vec::new();
    let mut total_bytes = 0usize;
    let mut truncated_line_numbers = Vec::new();
    for (line_no, raw_line) in entries.iter().rev() {
        let (rendered_line, was_truncated) = render_line(raw_line, *line_no, line_ending_style);
        if was_truncated {
            truncated_line_numbers.push(*line_no);
        }
        let line_bytes = rendered_line.len() + 1;
        if total_bytes + line_bytes > MAX_BYTES && !rendered.is_empty() {
            break;
        }
        total_bytes += line_bytes;
        rendered.push(rendered_line);
    }
    rendered.reverse();

    let start_line = entries.first().map(|(line_no, _)| *line_no).unwrap_or(1);
    let requested_lines = n_lines.unwrap_or(MAX_LINES as u32) as usize;
    let message = finish_message(
        rendered.len(),
        start_line,
        total_lines,
        false,
        total_bytes >= MAX_BYTES,
        &truncated_line_numbers,
        line_ending_style,
        requested_lines,
    );
    let content = finish_output(&rendered, &message);

    ReadResult {
        content,
        line_count: total_lines as i32,
        error: None,
    }
}

fn render_line(raw: &str, line_no: usize, style: LineEndingStyle) -> (String, bool) {
    let mut line = raw.to_string();
    let mut was_truncated = false;

    // For pure CRLF files, strip trailing \r.
    if style == LineEndingStyle::CrLf
        && line.ends_with('\r') {
            line.pop();
        }

    // For mixed files, make CR visible.
    if style == LineEndingStyle::Mixed {
        line = make_carriage_returns_visible(&line);
    }

    // Truncate to MAX_LINE_LENGTH.
    if line.len() > MAX_LINE_LENGTH {
        line.truncate(MAX_LINE_LENGTH);
        line.push_str("...");
        was_truncated = true;
    }

    (format!("{}\t{}", line_no, line), was_truncated)
}

fn finish_output(rendered: &[String], message: &str) -> String {
    if rendered.is_empty() {
        return format!("<system>{}</system>", message);
    }
    let mut result = rendered.join("\n");
    result.push_str("\n<system>");
    result.push_str(message);
    result.push_str("</system>");
    result
}

fn finish_message(
    rendered_count: usize,
    start_line: usize,
    total_lines: usize,
    max_lines_reached: bool,
    max_bytes_reached: bool,
    truncated_line_numbers: &[usize],
    line_ending_style: LineEndingStyle,
    requested_lines: usize,
) -> String {
    let mut parts = Vec::new();

    let line_word = if rendered_count == 1 { "line" } else { "lines" };
    if rendered_count > 0 {
        parts.push(format!(
            "{} {} read from file starting from line {}.",
            rendered_count, line_word, start_line
        ));
    } else {
        parts.push("No lines read from file.".to_string());
    }

    parts.push(format!("Total lines in file: {}.", total_lines));

    if max_lines_reached {
        parts.push(format!("Max {} lines reached.", MAX_LINES));
    } else if max_bytes_reached {
        parts.push(format!("Max {} bytes reached.", MAX_BYTES));
    } else if rendered_count < requested_lines {
        parts.push("End of file reached.".to_string());
    }

    if !truncated_line_numbers.is_empty() {
        parts.push(format!(
            "Lines [{}] were truncated.",
            truncated_line_numbers
                .iter()
                .map(|n| n.to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    if line_ending_style == LineEndingStyle::Mixed {
        parts.push(
            "Mixed or lone carriage-return line endings are shown as \\r. Use exact \\r\\n or \\r escapes in Edit.old_string for those lines.".to_string()
        );
    }

    parts.join(" ")
}

fn read_header_bytes(path: &Path, n: usize) -> io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    let mut buf = vec![0u8; n];
    let bytes_read = file.read(&mut buf)?;
    buf.truncate(bytes_read);
    Ok(buf)
}

fn not_readable_message(path: &str) -> String {
    format!(
        "\"{}\" is not readable as UTF-8 text. If it is an image or video, use ReadMediaFile. For other binary formats, use Bash or an MCP tool if available.",
        path
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn write_temp(content: &[u8]) -> NamedTempFile {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(content).unwrap();
        f.flush().unwrap();
        f
    }

    #[test]
    fn test_read_forward_basic() {
        let f = write_temp(b"line1\nline2\nline3\n");
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: None,
            n_lines: None,
        });
        assert!(result.error.is_none());
        assert!(result.content.contains("1\tline1"));
        assert!(result.content.contains("2\tline2"));
        assert!(result.content.contains("3\tline3"));
    }

    #[test]
    fn test_read_forward_with_offset() {
        let f = write_temp(b"line1\nline2\nline3\n");
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: Some(2),
            n_lines: Some(1),
        });
        assert!(result.error.is_none());
        assert!(result.content.contains("2\tline2"));
        assert!(!result.content.contains("1\tline1"));
    }

    #[test]
    fn test_read_tail() {
        let f = write_temp(b"line1\nline2\nline3\nline4\nline5\n");
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: Some(-3),
            n_lines: None,
        });
        assert!(result.error.is_none());
        assert!(result.content.contains("3\tline3"));
        assert!(result.content.contains("4\tline4"));
        assert!(result.content.contains("5\tline5"));
    }

    #[test]
    fn test_read_nonexistent() {
        let result = read_file(&ReadConfig {
            path: "/nonexistent/path/file.txt".to_string(),
            line_offset: None,
            n_lines: None,
        });
        assert!(result.error.unwrap().contains("does not exist"));
    }

    #[test]
    fn test_read_directory() {
        let dir = tempfile::tempdir().unwrap();
        let result = read_file(&ReadConfig {
            path: dir.path().to_str().unwrap().to_string(),
            line_offset: None,
            n_lines: None,
        });
        assert!(result.error.unwrap().contains("is not a file"));
    }

    #[test]
    fn test_read_binary_file() {
        let f = write_temp(&[0x00, 0x01, 0x02, 0x03]);
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: None,
            n_lines: None,
        });
        // Binary files with NUL bytes should be detected.
        assert!(result.error.unwrap().contains("not readable"));
    }

    #[test]
    fn test_read_line_truncation() {
        let long_line = "a".repeat(3000);
        let content = format!("{}\nshort\n", long_line);
        let f = write_temp(content.as_bytes());
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: None,
            n_lines: None,
        });
        assert!(result.error.is_none());
        // The long line should be truncated.
        assert!(result.content.contains("..."));
    }

    #[test]
    fn test_read_max_lines_cap() {
        let mut content = String::new();
        for i in 1..=1500 {
            content.push_str(&format!("line{}\n", i));
        }
        let f = write_temp(content.as_bytes());
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: None,
            n_lines: None,
        });
        assert!(result.error.is_none());
        // Should be capped at MAX_LINES.
        assert!(result.content.contains("Max") && result.content.contains("lines reached"));
    }

    #[test]
    fn test_read_no_trailing_newline() {
        let f = write_temp(b"line1\nline2\nline3");
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: None,
            n_lines: None,
        });
        assert!(result.error.is_none());
        assert!(result.content.contains("3\tline3"));
    }

    #[test]
    fn test_read_empty_file() {
        let f = write_temp(b"");
        let result = read_file(&ReadConfig {
            path: f.path().to_str().unwrap().to_string(),
            line_offset: None,
            n_lines: None,
        });
        assert!(result.error.is_none());
        assert_eq!(result.line_count, 0);
    }
}
