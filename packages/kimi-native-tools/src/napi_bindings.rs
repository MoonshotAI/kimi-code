/// NAPI bindings — exposes all native tools to Node.js.
///
/// This module defines the `#[napi]` functions that TypeScript calls.
/// Each function wraps the corresponding Rust implementation.
use crate::bash::{self, BashConfig, BashResult, DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S};
use crate::edit::{self, EditResult};
use crate::glob::{self, GlobConfig, GlobResult, MAX_MATCHES};
use crate::grep::{self, GrepConfig, GrepResult, OutputMode, DEFAULT_HEAD_LIMIT};
use crate::list_directory::{self, ListDirectoryConfig, ListDirectoryResult};
use crate::read::{self, ReadConfig, ReadResult, MAX_BYTES, MAX_LINE_LENGTH, MAX_LINES};
use crate::write::{self, WriteMode, WriteResult};
use napi_derive::napi;

// ============================================================================
// Read tool
// ============================================================================

/// Read a text file with line numbers.
///
/// @param path - Path to the file to read.
/// @param line_offset - Line number to start from (1-indexed). Negative = tail from end.
/// @param n_lines - Number of lines to read. Capped at 1000.
/// @returns ReadResult with content (line-numbered), lineCount, and optional error.
#[napi]
pub fn native_read(
    path: String,
    line_offset: Option<i64>,
    n_lines: Option<u32>,
) -> ReadResult {
    read::read_file(&ReadConfig {
        path,
        line_offset,
        n_lines,
    })
}

// ============================================================================
// Write tool
// ============================================================================

/// Write content to a file.
///
/// @param path - Path to the file to create or overwrite.
/// @param content - Raw content to write.
/// @param mode - "overwrite" or "append". Defaults to "overwrite".
/// @returns WriteResult with bytesWritten and optional error.
#[napi]
pub fn native_write(
    path: String,
    content: String,
    mode: Option<String>,
) -> WriteResult {
    let write_mode = match mode.as_deref() {
        Some("append") => WriteMode::Append,
        _ => WriteMode::Overwrite,
    };
    write::write_file(&path, &content, write_mode)
}

// ============================================================================
// Edit tool
// ============================================================================

/// Edit a file by replacing exact string occurrences.
///
/// @param path - Path to the file to edit.
/// @param old_string - Exact content to replace. Must be non-empty.
/// @param new_string - Replacement text.
/// @param replace_all - If true, replace all occurrences. Default false.
/// @returns EditResult with success, error, and replacements count.
#[napi]
pub fn native_edit(
    path: String,
    old_string: String,
    new_string: String,
    replace_all: Option<bool>,
) -> EditResult {
    edit::edit_file(&path, &old_string, &new_string, replace_all.unwrap_or(false))
}

// ============================================================================
// Grep tool
// ============================================================================

/// Search for a pattern in files.
///
/// @param pattern - Regular expression to search for.
/// @param path - File or directory to search. Defaults to current directory.
/// @param glob - Optional glob filter.
/// @param file_type - Optional file type filter ("ts", "py", "rust", ...).
/// @param output_mode - "content", "files_with_matches", or "count_matches". Default "files_with_matches".
/// @param case_insensitive - Case-insensitive search. Default false.
/// @param line_numbers - Show line numbers in content mode. Default true.
/// @param after_context - Lines after match. Default 0.
/// @param before_context - Lines before match. Default 0.
/// @param context - Lines before and after match. Overrides after/before.
/// @param head_limit - Max output lines. Default 250. 0 = unlimited.
/// @param offset - Skip first N entries. Default 0.
/// @param multiline - Enable multiline matching. Default false.
/// @param include_ignored - Also search files excluded by .gitignore. Default false.
/// @param timeout_ms - Wall-clock timeout in milliseconds. Default 20000. 0 = unlimited.
/// @returns GrepResult with content, error, matchCount, fileCount, filteredSensitive, timedOut.
#[napi]
#[allow(clippy::too_many_arguments)]
pub fn native_grep(
    pattern: String,
    path: Option<String>,
    glob: Option<String>,
    file_type: Option<String>,
    output_mode: Option<String>,
    case_insensitive: Option<bool>,
    line_numbers: Option<bool>,
    after_context: Option<u32>,
    before_context: Option<u32>,
    context: Option<u32>,
    head_limit: Option<u32>,
    offset: Option<u32>,
    multiline: Option<bool>,
    include_ignored: Option<bool>,
    timeout_ms: Option<u32>,
) -> GrepResult {
    let mode = match output_mode.as_deref() {
        Some("content") => OutputMode::Content,
        Some("count_matches") => OutputMode::CountMatches,
        _ => OutputMode::FilesWithMatches,
    };

    let effective_before = context.unwrap_or(before_context.unwrap_or(0)) as usize;
    let effective_after = context.unwrap_or(after_context.unwrap_or(0)) as usize;

    let timeout = match timeout_ms {
        Some(0) => None,
        Some(ms) => Some(ms as u64),
        None => Some(grep::DEFAULT_TIMEOUT_MS),
    };

    grep::grep_search(&GrepConfig {
        pattern,
        path,
        glob,
        file_type,
        output_mode: mode,
        case_insensitive: case_insensitive.unwrap_or(false),
        line_numbers: line_numbers.unwrap_or(true),
        after_context: effective_after,
        before_context: effective_before,
        context: context.unwrap_or(0) as usize,
        head_limit: head_limit
            .map(|h| if h == 0 { usize::MAX } else { h as usize })
            .unwrap_or(DEFAULT_HEAD_LIMIT),
        offset: offset.unwrap_or(0) as usize,
        multiline: multiline.unwrap_or(false),
        include_ignored: include_ignored.unwrap_or(false),
        timeout_ms: timeout,
    })
}

// ============================================================================
// Glob tool
// ============================================================================

/// Find files matching a glob pattern.
///
/// @param pattern - Glob pattern (supports brace expansion).
/// @param path - Directory to search in. Defaults to current directory.
/// @param include_dirs - Include directories in results. Default true.
/// @returns GlobResult with files (sorted by mtime), error, and truncated flag.
#[napi]
pub fn native_glob(
    pattern: String,
    path: Option<String>,
    include_dirs: Option<bool>,
) -> GlobResult {
    glob::glob_search(&GlobConfig {
        pattern,
        path,
        include_dirs: include_dirs.unwrap_or(true),
    })
}

// ============================================================================
// Bash tool
// ============================================================================

/// Execute a shell command.
///
/// @param command - The command to execute.
/// @param cwd - Working directory. Defaults to process cwd.
/// @param timeout - Timeout in seconds. Default 60, max 300.
/// @param env - Environment variables as array of [key, value] pairs.
/// @returns BashResult with exitCode, stdout, stderr, timedOut, error.
#[napi]
pub fn native_bash(
    command: String,
    cwd: Option<String>,
    timeout: Option<u32>,
    env: Option<Vec<Vec<String>>>,
) -> BashResult {
    let env_pairs = env.map(|pairs| {
        pairs
            .into_iter()
            .filter_map(|pair| {
                if pair.len() >= 2 {
                    Some((pair[0].clone(), pair[1].clone()))
                } else {
                    None
                }
            })
            .collect()
    });

    bash::bash_exec(&BashConfig {
        command,
        cwd,
        timeout: timeout.map(|t| t as u64),
        env: env_pairs,
    })
}

// ============================================================================
// Constants (exported to JS)
// ============================================================================

/// Maximum lines for read operations.
#[napi]
pub const READ_MAX_LINES: u32 = MAX_LINES as u32;

/// Maximum line length before truncation.
#[napi]
pub const READ_MAX_LINE_LENGTH: u32 = MAX_LINE_LENGTH as u32;

/// Maximum output bytes for read operations.
#[napi]
pub const READ_MAX_BYTES: u32 = MAX_BYTES as u32;

/// Maximum matches for glob operations.
#[napi]
pub const GLOB_MAX_MATCHES: u32 = MAX_MATCHES as u32;

/// Default head limit for grep operations.
#[napi]
pub const GREP_DEFAULT_HEAD_LIMIT: u32 = DEFAULT_HEAD_LIMIT as u32;

/// Default timeout for bash commands (seconds).
#[napi]
pub const BASH_DEFAULT_TIMEOUT: u32 = DEFAULT_TIMEOUT_S as u32;

/// Maximum timeout for bash commands (seconds).
#[napi]
pub const BASH_MAX_TIMEOUT: u32 = MAX_TIMEOUT_S as u32;

// ============================================================================
// List Directory tool
// ============================================================================

/// Generate a compact 2-level directory tree listing.
///
/// @param path - Directory to list. Defaults to current directory.
/// @param collapse_hidden_dirs - If true, skip listing children of hidden directories.
/// @returns ListDirectoryResult with output string and optional error.
#[napi]
pub fn native_list_directory(
    path: Option<String>,
    collapse_hidden_dirs: Option<bool>,
) -> ListDirectoryResult {
    list_directory::list_directory(&ListDirectoryConfig {
        path,
        collapse_hidden_dirs: collapse_hidden_dirs.unwrap_or(false),
    })
}

// ============================================================================
// File Type tool
// ============================================================================

use crate::file_type::{self, ImageDimensions};

/// Best-effort pixel-dimension reader for common raster formats.
///
/// @param data - Raw file bytes (at least the first few hundred bytes).
/// @returns ImageDimensions { width: number, height: number } or null if unknown.
#[napi]
pub fn native_sniff_image_dimensions(data: Vec<u8>) -> Option<ImageDimensions> {
    file_type::sniff_image_dimensions(&data)
}
