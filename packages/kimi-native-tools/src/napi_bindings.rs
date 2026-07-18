/// NAPI bindings — exposes all native tools to Node.js.
///
/// This module defines the `#[napi]` functions that TypeScript calls.
/// Each function wraps the corresponding Rust implementation.
use crate::bash::{self, BashConfig, BashResult, DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S};
use crate::compaction::{self, CompactionConfigMeta, CompactionMessageMeta, HandoffMessageMeta, CompactionUserSelection};
use crate::edit::{self, EditResult};
use crate::escape;
use crate::glob::{self, GlobConfig, GlobResult, MAX_MATCHES};
use crate::grep::{self, GrepConfig, GrepResult, GrepStructuredConfig, GrepStructuredResult, OutputMode, DEFAULT_HEAD_LIMIT};
use crate::image_compress;
use crate::list_directory::{self, ListDirectoryConfig, ListDirectoryResult};
use crate::output_truncate;
use crate::permission;
use crate::read::{self, ReadConfig, ReadResult, MAX_BYTES, MAX_LINE_LENGTH, MAX_LINES};
use crate::tool_access::{self, ToolAccessMeta};
use crate::tool_naming;
use crate::write::{self, WriteMode, WriteResult};
use napi::bindgen_prelude::Uint8Array;
use napi_derive::napi;
use std::collections::HashMap;

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
pub async fn native_read(
    path: String,
    line_offset: Option<i64>,
    n_lines: Option<u32>,
) -> ReadResult {
    // Only cache full-file reads (no offset/limit)
    if line_offset.is_none() && n_lines.is_none() {
        if let Some((content, line_count)) = crate::file_cache::FILE_CACHE.get(&path) {
            return ReadResult {
                content,
                line_count,
                error: None,
            };
        }
    }

    let path_clone = path.clone();
    let ol = line_offset;
    let nl = n_lines;
    let result = tokio::task::spawn_blocking(move || {
        read::read_file(&ReadConfig {
            path: path_clone,
            line_offset: ol,
            n_lines: nl,
        })
    })
    .await
    .unwrap_or_else(|e| ReadResult {
        content: String::new(),
        line_count: 0,
        error: Some(format!("read panicked: {e}")),
    });

    // Cache full-file reads
    if result.error.is_none() && line_offset.is_none() && n_lines.is_none() {
        crate::file_cache::FILE_CACHE.put(path, result.content.clone(), result.line_count);
    }

    result
}

// ============================================================================
// Batch Read — parallel multi-file read via tokio
// ============================================================================

/// Read multiple files in parallel using tokio's blocking thread pool.
///
/// Each file is read independently; results are returned in the same order as
/// the input paths. This is more efficient than N sequential `native_read`
/// calls because file I/O operations run concurrently.
///
/// @param paths - Array of file paths to read.
/// @param line_offsets - Optional per-file line offsets (defaults to 1 for each).
/// @param n_lines - Optional per-file line counts (defaults to MAX_LINES).
/// @returns Array of ReadResult, one per input path, in input order.
#[napi]
pub async fn native_batch_read(
    paths: Vec<String>,
    line_offsets: Option<Vec<Option<i64>>>,
    n_lines_array: Option<Vec<Option<u32>>>,
) -> Vec<ReadResult> {
    let offsets = line_offsets.unwrap_or_else(|| vec![None; paths.len()]);
    let lines = n_lines_array.unwrap_or_else(|| vec![None; paths.len()]);

    let tasks: Vec<_> = paths
        .into_iter()
        .zip(offsets.into_iter())
        .zip(lines.into_iter())
        .map(|((path, line_offset), n_lines)| {
            tokio::task::spawn_blocking(move || {
                read::read_file(&ReadConfig {
                    path,
                    line_offset,
                    n_lines,
                })
            })
        })
        .collect();

    let mut results = Vec::with_capacity(tasks.len());
    for task in tasks {
        results.push(
            task.await.unwrap_or_else(|e| ReadResult {
                content: String::new(),
                line_count: 0,
                error: Some(format!("read panicked: {e}")),
            }),
        );
    }
    results
}

// ============================================================================
// File cache — invalidation
// ============================================================================

/// Invalidate the file read cache entry for a path (call after write/edit).
#[napi]
pub fn native_file_cache_invalidate(path: String) {
    crate::file_cache::FILE_CACHE.invalidate(&path);
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
pub async fn native_write(
    path: String,
    content: String,
    mode: Option<String>,
) -> WriteResult {
    let write_mode = match mode.as_deref() {
        Some("append") => WriteMode::Append,
        _ => WriteMode::Overwrite,
    };
    let path_clone = path.clone();
    let result = tokio::task::spawn_blocking(move || {
        write::write_file(&path_clone, &content, write_mode)
    })
    .await
    .unwrap_or_else(|e| WriteResult {
        bytes_written: 0,
        error: Some(format!("write panicked: {e}")),
    });

    if result.error.is_none() {
        crate::file_cache::FILE_CACHE.invalidate(&path);
    }
    result
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
pub async fn native_edit(
    path: String,
    old_string: String,
    new_string: String,
    replace_all: Option<bool>,
) -> EditResult {
    let path_clone = path.clone();
    let result = tokio::task::spawn_blocking(move || {
        edit::edit_file(&path_clone, &old_string, &new_string, replace_all.unwrap_or(false))
    })
    .await
    .unwrap_or_else(|e| EditResult {
        success: false,
        replacements: 0,
        error: Some(format!("edit panicked: {e}")),
    });
    if result.error.is_none() {
        crate::file_cache::FILE_CACHE.invalidate(&path);
    }
    result
}

// ============================================================================
// Grep tool
// ============================================================================

/// Search for a pattern in files.
///
/// Async: runs the directory walk on tokio's blocking thread pool so the
/// Node event loop stays responsive during large searches.
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
pub async fn native_grep(
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
) -> Result<GrepResult, napi::Error> {
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

    let config = GrepConfig {
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
    };

    tokio::task::spawn_blocking(move || grep::grep_search(&config))
        .await
        .map_err(|e| napi::Error::from_reason(format!("grep task failed: {}", e)))
}

/// Structured grep — returns typed match data instead of formatted strings.
///
/// Async: runs the directory walk on tokio's blocking thread pool so the
/// Node event loop stays responsive during large searches.
///
/// Used by fsSearchService when rg is not available on PATH. Walks the
/// directory tree, applies include/exclude globs, reads each file, and
/// collects matches with context lines.
///
/// @param pattern - Pattern to search for.
/// @param path - Directory to search in.
/// @param literal - If true, treat pattern as literal (not regex).
/// @param case_insensitive - Case-insensitive search.
/// @param include_globs - Only scan files matching these globs.
/// @param exclude_globs - Skip files matching these globs.
/// @param context_lines - Number of context lines before/after each match.
/// @param max_files - Max files to scan.
/// @param max_matches_per_file - Max matches per file.
/// @param max_total_matches - Max total matches across all files.
/// @param timeout_ms - Timeout in milliseconds.
/// @param follow_gitignore - Whether to respect .gitignore rules.
/// @returns GrepStructuredResult with files, matches, and metadata.
#[allow(clippy::too_many_arguments)]
#[napi]
pub async fn native_grep_structured(
    pattern: String,
    path: String,
    literal: bool,
    case_insensitive: bool,
    include_globs: Vec<String>,
    exclude_globs: Vec<String>,
    context_lines: u32,
    max_files: u32,
    max_matches_per_file: u32,
    max_total_matches: u32,
    timeout_ms: u32,
    follow_gitignore: bool,
) -> Result<GrepStructuredResult, napi::Error> {
    let config = GrepStructuredConfig {
        pattern,
        path,
        literal,
        case_insensitive,
        include_globs,
        exclude_globs,
        context_lines,
        max_files,
        max_matches_per_file,
        max_total_matches,
        timeout_ms: timeout_ms.into(),
        follow_gitignore,
    };

    tokio::task::spawn_blocking(move || grep::grep_search_structured(&config))
        .await
        .map_err(|e| napi::Error::from_reason(format!("grep_structured task failed: {}", e)))
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

/// Check if a path matches any of the given glob patterns.
///
/// Uses `globset::GlobSet` to batch-compile all patterns and test the path
/// in a single `is_match` call. Matching is case-sensitive (consistent with
/// `globToRegExp` in the TS fallback).
///
/// @param globs - Array of glob patterns.
/// @param path - Relative path to test.
/// @returns True if the path matches at least one pattern.
#[napi]
pub fn native_glob_matches_any(globs: Vec<String>, path: String) -> bool {
    glob::glob_matches_any(&globs, &path)
}

// ============================================================================
// Bash tool
// ============================================================================

/// Execute a shell command.
///
/// Async: runs the subprocess on tokio's blocking thread pool so the Node
/// event loop stays responsive while a long-running command is awaited.
///
/// @param command - The command to execute.
/// @param cwd - Working directory. Defaults to process cwd.
/// @param timeout - Timeout in seconds. Default 60, max 300.
/// @param env - Environment variables as array of [key, value] pairs.
/// @returns BashResult with exitCode, stdout, stderr, timedOut, error.
#[napi]
pub async fn native_bash(
    command: String,
    cwd: Option<String>,
    timeout: Option<u32>,
    env: Option<Vec<Vec<String>>>,
) -> Result<BashResult, napi::Error> {
    let env_pairs = env.map(|pairs| {
        pairs
            .into_iter()
            .filter_map(|mut pair| {
                if pair.len() >= 2 {
                    let val = pair.remove(1);
                    let key = pair.remove(0);
                    Some((key, val))
                } else {
                    None
                }
            })
            .collect()
    });

    let config = BashConfig {
        command,
        cwd,
        timeout: timeout.map(|t| t as u64),
        env: env_pairs,
    };

    tokio::task::spawn_blocking(move || bash::bash_exec(&config))
        .await
        .map_err(|e| napi::Error::from_reason(format!("bash task failed: {}", e)))
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
pub fn native_sniff_image_dimensions(data: Uint8Array) -> Option<ImageDimensions> {
    file_type::sniff_image_dimensions(&data)
}

/// Check if a path points to a credentials-bearing file.
///
/// Case-insensitive matching: `.env.local` is flagged but `.env.example`
/// is exempted, `id_rsa.bak` is flagged while `id_rsafoo` is not.
#[napi]
pub fn native_is_sensitive_file(path: String) -> bool {
    file_type::is_sensitive_file(&path)
}

/// Same as `native_is_sensitive_file` but accepts a `Uint8Array` produced
/// by `Buffer.from(path, 'latin1')` in JS. This avoids the UTF-16→UTF-8
/// string conversion that napi's `String` parameter triggers (~170ns for
/// typical paths). `Buffer.from(path, 'latin1')` is a V8 C++ intrinsic
/// (~31ns) that copies each UTF-16 code unit's low byte directly; for ASCII
/// paths the result is identical to UTF-8.
#[napi]
pub fn native_is_sensitive_file_bytes(path: Uint8Array) -> bool {
    file_type::is_sensitive_file_bytes(&path)
}

/// Result of `native_detect_file_type`.
#[napi(object)]
pub struct FileTypeResult {
    pub kind: String,
    pub mime_type: String,
}

/// Detect file type from path and header bytes.
///
/// Uses file extension first, then falls back to magic-byte sniffing.
/// @param path - File path (used for extension-based detection).
/// @param header - First bytes of the file content (up to 512 bytes).
#[napi]
pub fn native_detect_file_type(path: String, header: Uint8Array) -> FileTypeResult {
    let kind = file_type::detect_file_type(std::path::Path::new(&path), &header);
    let kind_str = match kind {
        file_type::FileKind::Text => "text",
        file_type::FileKind::Image => "image",
        file_type::FileKind::Video => "video",
        file_type::FileKind::Unknown => "unknown",
    };
    let mime = file_type::resolve_mime(std::path::Path::new(&path), &header);
    FileTypeResult { kind: kind_str.to_string(), mime_type: mime }
}

// ============================================================================
// Token estimation
// ============================================================================

use crate::tokens;

// ============================================================================
// Compaction strategy
// ============================================================================

/// Decide how many leading messages to compact.
///
/// Returns N where `messages[0..N]` is compacted and `messages[N..]` is
/// preserved. 0 means no compaction possible (no valid split point).
///
/// @param messages - Lightweight message metadata (role, tool_calls_count, tokens).
/// @param config - Compaction algorithm knobs.
/// @param is_manual - Whether this is a manual (user-requested) compaction.
/// @returns Number of messages to compact (0 = no compaction possible).
#[napi]
pub fn native_compute_compact_count(
    messages: Vec<CompactionMessageMeta>,
    config: CompactionConfigMeta,
    is_manual: bool,
) -> u32 {
    compaction::compute_compact_count(&messages, &config, is_manual)
}

/// Find a split point when the LLM throws a context overflow error.
///
/// Walks backward from the tail accumulating tokens until the reduced
/// size reaches `min_overflow_reduction_ratio * max_size`, returning the
/// first valid split point that satisfies the threshold.
///
/// @param messages - Lightweight message metadata.
/// @param config - Compaction algorithm knobs.
/// @returns Split index (number of messages to keep in the tail).
#[napi]
pub fn native_reduce_compact_on_overflow(
    messages: Vec<CompactionMessageMeta>,
    config: CompactionConfigMeta,
) -> u32 {
    compaction::reduce_compact_on_overflow(&messages, &config)
}

/// Check whether a compaction split is safe after `messages[index]`.
#[napi]
pub fn native_can_split_after(messages: Vec<CompactionMessageMeta>, index: u32) -> bool {
    compaction::can_split_after(&messages, index as usize)
}

/// Select user messages compaction keeps verbatim, with head/tail split.
///
/// Input: lightweight projection of user messages (role + text + tokens).
/// Output: indices into the input + truncation info for TS to rebuild.
#[napi]
pub fn native_select_compaction_user_messages(
    messages: Vec<compaction::HandoffMessageMeta>,
    max_tokens: u32,
    head_tokens: u32,
) -> compaction::CompactionUserSelection {
    compaction::select_compaction_user_messages(&messages, max_tokens, head_tokens)
}

/// Estimate token count from text using a character-based heuristic.
///
/// ASCII: ~4 chars per token. Non-ASCII (CJK, emoji): ~1 char per token.
/// Matches the TS `estimateTokens` in `utils/tokens.ts`.
///
/// Uses byte-level UTF-8 scanning — counts start bytes of multi-byte
/// sequences instead of decoding code points, giving identical results
/// with SIMD-friendly byte comparisons.
#[napi]
pub fn native_estimate_tokens(text: String) -> u32 {
    tokens::estimate_tokens(&text) as u32
}

/// Batch token estimation — sums token counts across multiple strings
/// in a single napi call. Equivalent to calling `native_estimate_tokens`
/// per string and summing, but with one boundary crossing instead of N.
///
/// Use this when estimating tokens for a full message (role + content
/// parts + tool calls) or a set of tools (names + descriptions + schemas).
#[napi]
pub fn native_estimate_tokens_batch(texts: Vec<String>) -> u32 {
    let refs: Vec<&str> = texts.iter().map(|s| s.as_str()).collect();
    tokens::estimate_tokens_batch(&refs) as u32
}

/// Truncate text to fit within a token budget, keeping the BEGINNING.
///
/// Walks bytes forward using the same ASCII/non-ASCII heuristic as
/// `native_estimate_tokens` and stops at the first code point that would
/// push the running total over the budget. Mirrors `truncateTextToTokens`
/// in `compaction/handoff.ts`.
#[napi]
pub fn native_truncate_text_to_tokens(text: String, max_tokens: u32) -> String {
    tokens::truncate_text_to_tokens(&text, max_tokens as usize)
}

/// Truncate text to fit within a token budget, keeping the END.
///
/// Walks bytes backward, skipping UTF-8 continuation bytes to consume
/// multi-byte sequences whole. Mirrors `truncateTextToTokensFromEnd`
/// in `compaction/handoff.ts`.
#[napi]
pub fn native_truncate_text_to_tokens_from_end(text: String, max_tokens: u32) -> String {
    tokens::truncate_text_to_tokens_from_end(&text, max_tokens as usize)
}

// ============================================================================
// Tool access conflict detection
// ============================================================================

/// Check whether any access in `left` conflicts with any access in `right`.
///
/// Two accesses conflict when they touch overlapping file paths and at
/// least one side writes. Read-only accesses (read, search) never conflict
/// with each other. `kind: "all"` conflicts with everything.
///
/// @param left - Array of tool access metadata.
/// @param right - Array of tool access metadata.
/// @returns True if any pair conflicts.
#[napi]
pub fn native_tool_accesses_conflict(
    left: Vec<ToolAccessMeta>,
    right: Vec<ToolAccessMeta>,
) -> bool {
    tool_access::conflict(&left, &right)
}

// ============================================================================
// Image compression & cropping
// ============================================================================

/// Configuration for `native_compress_image`. All fields are required because
/// the caller (TS wrapper) owns the fast-path checks and passes the resolved
/// budgets here.
#[napi(object)]
pub struct NativeCompressImageConfig {
    /// Longest-edge ceiling in pixels.
    pub max_edge: u32,
    /// Raw-byte budget for the encoded result.
    pub byte_budget: u32,
    /// Longest-edge step-downs tried when the budget cannot be met at the
    /// fitted size (e.g. [2000, 1000]).
    pub fallback_edges: Vec<u32>,
    /// JPEG quality steps tried in descending order (e.g. [80, 60, 40, 20]).
    pub jpeg_quality_steps: Vec<u32>,
}

/// Result of `native_compress_image`. When `changed` is false the caller
/// should send the original bytes; when true, `data` holds the re-encoded
/// image. `None` (the outer `Option`) means decode/encode failed entirely.
#[napi(object)]
pub struct NativeCompressImageResult {
    pub data: Uint8Array,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub original_width: u32,
    pub original_height: u32,
    pub changed: bool,
    pub original_byte_length: u32,
    pub final_byte_length: u32,
}

/// Configuration for `native_crop_image`.
#[napi(object)]
pub struct NativeCropImageConfig {
    pub max_edge: u32,
    pub byte_budget: u32,
    /// Keep the crop at native resolution (no edge-fit downscale). The byte
    /// budget still applies.
    pub skip_resize: bool,
    pub fallback_edges: Vec<u32>,
    pub jpeg_quality_steps: Vec<u32>,
}

/// Outcome of `native_crop_image`. A single struct (rather than a Result) so
/// the napi boundary never throws — `ok` discriminates success vs. failure,
/// matching the TS `CropImageOutcome` union.
#[napi(object)]
pub struct NativeCropImageOutcome {
    pub ok: bool,
    /// Error message when `ok` is false; empty string on success.
    pub error: String,
    /// Stable error kind for telemetry (e.g. "out_of_bounds", "budget",
    /// "decode_failed"). Empty string on success. Matches TS `CropErrorKind`.
    pub error_kind: String,
    pub data: Uint8Array,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub original_width: u32,
    pub original_height: u32,
    pub region_x: u32,
    pub region_y: u32,
    pub region_width: u32,
    pub region_height: u32,
    pub resized: bool,
    pub original_byte_length: u32,
    pub final_byte_length: u32,
}

/// Compress (resize + re-encode) `data` to fit the pixel + byte budget.
///
/// Async: decode/resize/encode runs on tokio's blocking thread pool so the
/// Node event loop stays responsive during large image work.
///
/// Returns `null` when the format is unsupported or decode/encode fails
/// (caller passes through the original bytes). Returns a result with
/// `changed: false` when the re-encode didn't help (caller still sends the
/// original). Returns `changed: true` when the result is smaller — use `data`.
#[napi]
pub async fn native_compress_image(
    data: Uint8Array,
    mime_type: String,
    config: NativeCompressImageConfig,
) -> Result<Option<NativeCompressImageResult>, napi::Error> {
    let bytes = data.to_vec();
    let cfg = image_compress::CompressConfig {
        max_edge: config.max_edge,
        byte_budget: config.byte_budget as usize,
        fallback_edges: config.fallback_edges,
        jpeg_quality_steps: config
            .jpeg_quality_steps
            .into_iter()
            .map(|q| q as u8)
            .collect(),
    };
    let result = tokio::task::spawn_blocking(move || {
        image_compress::compress_image(&bytes, &mime_type, &cfg)
    })
    .await
    .map_err(|e| napi::Error::from_reason(format!("compress_image task failed: {}", e)))?;
    Ok(result.map(|r| NativeCompressImageResult {
        data: Uint8Array::from(r.data.as_slice()),
        mime_type: r.mime_type,
        width: r.width,
        height: r.height,
        original_width: r.original_width,
        original_height: r.original_height,
        changed: r.changed,
        original_byte_length: r.original_byte_length as u32,
        final_byte_length: r.final_byte_length as u32,
    }))
}

/// Crop `region` out of `data` and encode it for the model.
///
/// Async: runs on tokio's blocking thread pool. Returns an outcome struct
/// (never throws): `ok: false` carries an `error` message safe to surface
/// to the model; `ok: true` carries the encoded crop.
#[napi]
pub async fn native_crop_image(
    data: Uint8Array,
    mime_type: String,
    region_x: f64,
    region_y: f64,
    region_width: f64,
    region_height: f64,
    config: NativeCropImageConfig,
) -> Result<NativeCropImageOutcome, napi::Error> {
    let bytes = data.to_vec();
    let cfg = image_compress::CropConfig {
        max_edge: config.max_edge,
        byte_budget: config.byte_budget as usize,
        skip_resize: config.skip_resize,
        fallback_edges: config.fallback_edges,
        jpeg_quality_steps: config
            .jpeg_quality_steps
            .into_iter()
            .map(|q| q as u8)
            .collect(),
    };
    let result = tokio::task::spawn_blocking(move || {
        image_compress::crop_image(
            &bytes,
            &mime_type,
            region_x,
            region_y,
            region_width,
            region_height,
            &cfg,
        )
    })
    .await
    .map_err(|e| napi::Error::from_reason(format!("crop_image task failed: {}", e)))?;

    Ok(match result {
        Ok(r) => NativeCropImageOutcome {
            ok: true,
            error: String::new(),
            error_kind: String::new(),
            data: Uint8Array::from(r.data.as_slice()),
            mime_type: r.mime_type,
            width: r.width,
            height: r.height,
            original_width: r.original_width,
            original_height: r.original_height,
            region_x: r.region_x,
            region_y: r.region_y,
            region_width: r.region_width,
            region_height: r.region_height,
            resized: r.resized,
            original_byte_length: r.original_byte_length as u32,
            final_byte_length: r.final_byte_length as u32,
        },
        Err(err) => {
            let kind = err.kind().to_string();
            NativeCropImageOutcome {
                ok: false,
                error: err.error_message(),
                error_kind: kind,
                data: Uint8Array::from(&[]),
                mime_type: String::new(),
                width: 0,
                height: 0,
                original_width: 0,
                original_height: 0,
                region_x: 0,
                region_y: 0,
                region_width: 0,
                region_height: 0,
                resized: false,
                original_byte_length: 0,
                final_byte_length: 0,
            }
        }
    })
}

// ============================================================================
// Tool output truncation (ToolResultBuilder.write)
// ============================================================================

/// Result of `native_write_tool_output_chunk`. The caller appends `output`
/// to its JS buffer, updates its `nChars` to `newNchars`, and sets
/// `truncated` to the returned flag.
#[napi(object)]
pub struct NativeWriteChunkResult {
    /// Processed text (truncated lines + optional marker) to append to the
    /// caller's buffer.
    pub output: String,
    /// UTF-16 code units written this call.
    pub chars_written: u32,
    /// Updated total UTF-16 code units.
    pub new_nchars: u32,
    /// Whether truncation has occurred (cumulative).
    pub truncated: bool,
}

/// Process one chunk of streaming tool output, applying line-length and
/// total-character budgets. Mirrors `ToolResultBuilder.write()` in
/// `result-builder.ts`. The TS caller holds the running state and calls
/// this function for each incoming text chunk.
///
/// @param text - The raw text chunk to process.
/// @param currentNchars - Total UTF-16 code units already in the buffer.
/// @param maxChars - Maximum total UTF-16 code units allowed.
/// @param maxLineLength - Per-line maximum, or `null` for no per-line limit.
///   Caller guarantees > 14 (marker length) when non-null.
/// @param alreadyTruncated - Whether truncation already occurred previously.
#[napi]
pub fn native_write_tool_output_chunk(
    text: String,
    current_nchars: u32,
    max_chars: u32,
    max_line_length: Option<u32>,
    already_truncated: bool,
) -> NativeWriteChunkResult {
    let result = output_truncate::write_chunk(
        &text,
        current_nchars as usize,
        max_chars as usize,
        max_line_length.map(|v| v as usize),
        already_truncated,
    );
    NativeWriteChunkResult {
        output: result.output,
        chars_written: result.chars_written as u32,
        new_nchars: result.new_nchars as u32,
        truncated: result.truncated,
    }
}

// ============================================================================
// MCP — Config loading
// ============================================================================

use crate::mcp;

/// A single MCP server configuration entry returned by `nativeMcpLoadConfig`.
#[napi(object)]
pub struct NativeMcpServerConfig {
    /// Transport type: "stdio", "http", or "sse".
    pub transport: String,
    /// Command to execute (stdio only).
    pub command: Option<String>,
    /// Command arguments (stdio only).
    pub args: Option<Vec<String>>,
    /// Environment variables (stdio only).
    pub env: Option<HashMap<String, String>>,
    /// Working directory (stdio only).
    pub cwd: Option<String>,
    /// Server URL (http/sse only).
    pub url: Option<String>,
    /// HTTP headers (http/sse only).
    pub headers: Option<HashMap<String, String>>,
    /// Environment variable name containing the bearer token (http/sse only).
    pub bearer_token_env_var: Option<String>,
    /// Whether the server is enabled. Defaults to true.
    pub enabled: Option<bool>,
    /// Startup timeout in milliseconds.
    pub startup_timeout_ms: Option<u32>,
    /// Tool call timeout in milliseconds.
    pub tool_timeout_ms: Option<u32>,
    /// Allowlist of tool names.
    pub enabled_tools: Option<Vec<String>>,
    /// Blocklist of tool names.
    pub disabled_tools: Option<Vec<String>>,
}

/// A named server entry in the config result.
#[napi(object)]
pub struct NativeMcpServerEntry {
    /// Server name (key in mcpServers object).
    pub name: String,
    /// Server configuration.
    pub config: NativeMcpServerConfig,
}

/// Result of `nativeMcpLoadConfig`.
#[napi(object)]
pub struct NativeMcpConfigLoadResult {
    /// Merged server entries from all config files.
    pub servers: Vec<NativeMcpServerEntry>,
    /// Path to the user-global mcp.json.
    pub user_path: String,
    /// Path to the project-root .mcp.json.
    pub project_root_path: String,
    /// Path to the project-local .kimi-code/mcp.json.
    pub project_path: String,
    /// Error message if loading failed partially.
    pub error: Option<String>,
}

/// Load and merge MCP server configs from the three-tier file hierarchy.
///
/// Reads from:
///   1. `~/.kimi-code/mcp.json` (user-global)
///   2. `<project-root>/.mcp.json` (project-root)
///   3. `<cwd>/.kimi-code/mcp.json` (project-local)
///
/// Later files override earlier entries with the same key.
///
/// @param cwd - Current working directory (used to find project root).
/// @param homeDir - Optional home directory override. Falls back to USERPROFILE (Windows) or HOME (Unix).
/// @returns Merged config with resolved paths.
#[napi]
pub async fn native_mcp_load_config(
    cwd: String,
    home_dir: Option<String>,
) -> Result<NativeMcpConfigLoadResult, napi::Error> {
    let input = mcp::McpConfigLoadInput { cwd, home_dir };
    let result = mcp::load_mcp_config(&input).await;

    let servers = result
        .servers
        .into_iter()
        .map(|(name, config)| NativeMcpServerEntry {
            name,
            config: NativeMcpServerConfig {
                transport: config.transport,
                command: config.command,
                args: config.args,
                env: config.env,
                cwd: config.cwd,
                url: config.url,
                headers: config.headers,
                bearer_token_env_var: config.bearer_token_env_var,
                enabled: config.enabled,
                startup_timeout_ms: config.startup_timeout_ms,
                tool_timeout_ms: config.tool_timeout_ms,
                enabled_tools: config.enabled_tools,
                disabled_tools: config.disabled_tools,
            },
        })
        .collect();

    Ok(NativeMcpConfigLoadResult {
        servers,
        user_path: result.user_path,
        project_root_path: result.project_root_path,
        project_path: result.project_path,
        error: result.error,
    })
}

// ============================================================================
// MCP — Stdio client
// ============================================================================

/// Configuration for `nativeMcpStdioSpawn`.
#[napi(object)]
pub struct NativeMcpStdioSpawnConfig {
    pub command: String,
    pub args: Option<Vec<String>>,
    pub env: Option<HashMap<String, String>>,
    pub cwd: Option<String>,
}

/// Result of `nativeMcpStdioSpawn`.
#[napi(object)]
pub struct NativeMcpStdioSpawnResult {
    pub handle: i64,
    pub pid: u32,
}

/// A tool definition returned by `tools/list`.
#[napi(object)]
pub struct NativeMcpToolDef {
    pub name: String,
    pub description: String,
    pub input_schema: String,
}

#[napi]
pub async fn native_mcp_stdio_spawn(
    config: NativeMcpStdioSpawnConfig,
) -> Result<NativeMcpStdioSpawnResult, napi::Error> {
    let spawn_config = mcp::StdioSpawnConfig {
        command: config.command,
        args: config.args.unwrap_or_default(),
        env: config.env.unwrap_or_default(),
        cwd: config.cwd,
    };
    let result = mcp::stdio_spawn(&spawn_config)
        .await
        .map_err(|e| napi::Error::from_reason(e))?;
    Ok(NativeMcpStdioSpawnResult {
        handle: result.handle as i64,
        pid: result.pid,
    })
}

#[napi]
pub async fn native_mcp_stdio_initialize(
    handle: i64,
    client_name: String,
    client_version: String,
    timeout_ms: Option<u32>,
) -> Result<String, napi::Error> {
    let result = mcp::stdio_initialize(handle as u64, &client_name, &client_version, timeout_ms)
        .await
        .map_err(|e| napi::Error::from_reason(e))?;
    serde_json::to_string(&result)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize result: {}", e)))
}

#[napi]
pub async fn native_mcp_stdio_list_tools(
    handle: i64,
) -> Result<Vec<NativeMcpToolDef>, napi::Error> {
    let tools = mcp::stdio_list_tools(handle as u64)
        .await
        .map_err(|e| napi::Error::from_reason(e))?;
    Ok(tools
        .into_iter()
        .map(|tool| NativeMcpToolDef {
            name: tool.name,
            description: tool.description,
            input_schema: serde_json::to_string(&tool.input_schema).unwrap_or_default(),
        })
        .collect())
}

#[napi]
pub async fn native_mcp_stdio_call_tool(
    handle: i64,
    name: String,
    args_json: String,
    timeout_ms: Option<u32>,
) -> Result<String, napi::Error> {
    let args: serde_json::Value = serde_json::from_str(&args_json)
        .map_err(|e| napi::Error::from_reason(format!("Invalid args JSON: {}", e)))?;
    let result = mcp::stdio_call_tool(handle as u64, &name, &args, timeout_ms)
        .await
        .map_err(|e| napi::Error::from_reason(e))?;
    serde_json::to_string(&result)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize result: {}", e)))
}

#[napi]
pub async fn native_mcp_stdio_close(handle: i64) -> Result<(), napi::Error> {
    mcp::stdio_close(handle as u64)
        .await
        .map_err(|e| napi::Error::from_reason(e))
}

#[napi]
pub async fn native_mcp_stdio_stderr_snapshot(handle: i64) -> String {
    mcp::stdio_stderr_snapshot(handle as u64).await
}

#[napi]
pub async fn native_mcp_stdio_is_alive(handle: i64) -> bool {
    mcp::stdio_is_alive(handle as u64).await
}

// ============================================================================
// XML/HTML escaping
// ============================================================================

/// Escape all XML-significant characters: & < > "
#[napi]
pub fn native_escape_xml(text: String) -> String {
    escape::escape_xml(&text)
}

/// Escape XML attribute boundary characters only: & "
#[napi]
pub fn native_escape_xml_attr(text: String) -> String {
    escape::escape_xml_attr(&text)
}

/// Escape tag delimiters only: < > (Markdown-safe)
#[napi]
pub fn native_escape_xml_tags(text: String) -> String {
    escape::escape_xml_tags(&text)
}

// ============================================================================
// MCP tool name sanitization
// ============================================================================

/// Sanitize a string for use as part of an MCP tool name.
/// Replaces non-safe characters with `_` and collapses runs of `_`.
#[napi]
pub fn native_sanitize_mcp_name_part(part: String) -> String {
    tool_naming::sanitize_mcp_name_part(&part)
}

/// Check if a tool name starts with the MCP prefix (`mcp__`).
#[napi]
pub fn native_is_mcp_tool_name(name: String) -> bool {
    tool_naming::is_mcp_tool_name(&name)
}

/// Produce the qualified MCP tool name: `mcp__<server>__<tool>`.
/// Truncates with a deterministic 8-char FNV-1a hash suffix if > 64 chars.
#[napi]
pub fn native_qualify_mcp_tool_name(server_name: String, tool_name: String) -> String {
    tool_naming::qualify_mcp_tool_name(&server_name, &tool_name)
}

// ============================================================================
// Goal — state machine, accounting, steering
// ============================================================================

use crate::goal::{accounting, state, steering};

/// Validate a goal objective. Returns an error message, or empty string on success.
#[napi]
pub fn native_goal_validate_objective(objective: String) -> String {
    match state::validate_goal_objective(&objective) {
        Ok(_) => String::new(),
        Err(err) => err,
    }
}

/// Validate a goal token budget. Returns an error message, or empty string on success.
/// A value of `null` or `undefined` means no budget (valid).
#[napi]
pub fn native_goal_validate_budget(value: Option<i64>) -> String {
    match state::validate_goal_budget(value) {
        Ok(_) => String::new(),
        Err(err) => err,
    }
}

/// Apply a goal state update. Takes JSON of the current goal and the update,
/// returns JSON of the new goal (or an error object).
///
/// Goal JSON: `{ goalId, objective, status, tokenBudget, tokensUsed, timeUsedSeconds, blockedStreak, terminalReason? }`
/// Update JSON: `{ objective?, status?, tokenBudget?, tokensUsed?, timeUsedSeconds?, blockedStreak?, terminalReason?, expectedGoalId? }`
/// Returns: `{ ok: true, goal: {...} }` or `{ ok: false, error: "..." }`
#[napi]
pub fn native_goal_apply_update(goal_json: String, update_json: String) -> String {
    let result = (|| -> Result<String, String> {
        let goal: serde_json::Value =
            serde_json::from_str(&goal_json).map_err(|e| format!("invalid goal JSON: {e}"))?;
        let update: serde_json::Value =
            serde_json::from_str(&update_json).map_err(|e| format!("invalid update JSON: {e}"))?;

        let g = parse_goal(&goal)?;
        let u = parse_update(&update)?;

        match g.apply_update(u) {
            state::GoalUpdateOutcome::Updated(new_goal) => {
                Ok(json!({ "ok": true, "goal": serialize_goal(&new_goal) }).to_string())
            }
            state::GoalUpdateOutcome::Unchanged => {
                Ok(json!({ "ok": true, "goal": goal }).to_string())
            }
            state::GoalUpdateOutcome::GoalIdMismatch { current, expected } => {
                Ok(json!({
                    "ok": false,
                    "error": format!("goal_id mismatch: current={current}, expected={expected}"),
                })
                .to_string())
            }
            state::GoalUpdateOutcome::InvalidTransition { current, target } => {
                Err(format!(
                    "invalid transition: cannot go from {current} to {target}",
                ))
            }
        }
    })();

    match result {
        Ok(r) => r,
        Err(e) => json!({ "ok": false, "error": e }).to_string(),
    }
}

/// Compute the chargeable token delta between two usage snapshots.
#[napi]
pub fn native_goal_compute_token_delta(
    prev_input: i64,
    prev_cached: i64,
    prev_output: i64,
    curr_input: i64,
    curr_cached: i64,
    curr_output: i64,
) -> i64 {
    let prev = accounting::TokenUsage {
        input_tokens: prev_input,
        cached_input_tokens: prev_cached,
        output_tokens: prev_output,
        reasoning_output_tokens: 0,
        total_tokens: prev_input + prev_output,
    };
    let curr = accounting::TokenUsage {
        input_tokens: curr_input,
        cached_input_tokens: curr_cached,
        output_tokens: curr_output,
        reasoning_output_tokens: 0,
        total_tokens: curr_input + curr_output,
    };
    accounting::goal_token_delta(&prev, &curr)
}

/// Render the continuation steering prompt.
#[napi]
pub fn native_goal_render_continuation(
    objective: String,
    tokens_used: i64,
    token_budget: Option<i64>,
) -> String {
    steering::render_continuation(&objective, tokens_used, token_budget)
}

/// Render the budget-limit wrap-up prompt.
#[napi]
pub fn native_goal_render_budget_limit(
    objective: String,
    tokens_used: i64,
    token_budget: Option<i64>,
    time_used_seconds: i64,
) -> String {
    steering::render_budget_limit(&objective, tokens_used, token_budget, time_used_seconds)
}

/// Render the objective-updated prompt.
#[napi]
pub fn native_goal_render_objective_updated(
    objective: String,
    tokens_used: i64,
    token_budget: Option<i64>,
) -> String {
    steering::render_objective_updated(&objective, tokens_used, token_budget)
}

// ---------------------------------------------------------------------------
// GoalEngine — decision core (stateless, JSON-in/JSON-out)
// ---------------------------------------------------------------------------

/// Validate and normalize a goal creation input.
/// Input: `{ objective: string, completionCriterion?: string }`
/// Output: `{ ok: true, objective: string, completionCriterion?: string }`
///      or `{ ok: false, error: string }`
#[napi]
pub fn native_goal_engine_validate_create_input(json: String) -> String {
    let result = (|| -> Result<serde_json::Value, String> {
        let v: serde_json::Value = serde_json::from_str(&json).map_err(|e| format!("invalid JSON: {e}"))?;
        let objective = get_str(&v, "objective")?.to_string();
        let criterion = v.get("completionCriterion").and_then(|x| x.as_str());
        let (obj, crit) = crate::goal::engine::validate_create_input(&objective, criterion)?;
        Ok(json!({ "ok": true, "objective": obj, "completionCriterion": crit }))
    })();
    match result {
        Ok(r) => r.to_string(),
        Err(e) => json!({ "ok": false, "error": e }).to_string(),
    }
}

/// Validate a budget input into a limits patch.
/// Input: `{ value: number, unit: 'turns'|'tokens'|'milliseconds'|'seconds'|'minutes'|'hours' }`
/// Output: `{ ok: true, budgetLimits: { tokenBudget?, turnBudget?, wallClockBudgetMs? } }`
///      or `{ ok: false, error: string }`
#[napi]
pub fn native_goal_engine_validate_budget_input(json: String) -> String {
    let result = (|| -> Result<serde_json::Value, String> {
        let v: serde_json::Value = serde_json::from_str(&json).map_err(|e| format!("invalid JSON: {e}"))?;
        let value = v.get("value").and_then(|x| x.as_f64()).ok_or("missing value")?;
        let unit = get_str(&v, "unit")?;
        let patch = crate::goal::engine::validate_budget_input_json(value, unit)?;
        Ok(json!({
            "ok": true,
            "budgetLimits": {
                "tokenBudget": patch.token_budget.flatten(),
                "turnBudget": patch.turn_budget.flatten(),
                "wallClockBudgetMs": patch.wall_clock_budget_ms.flatten(),
            }
        }))
    })();
    match result {
        Ok(r) => r.to_string(),
        Err(e) => json!({ "ok": false, "error": e }).to_string(),
    }
}

/// Compute the full budget report.
/// Input: `{ goal: GoalStateJSON, nowMs: number }`
/// Output: `{ tokenBudget, turnBudget, wallClockBudgetMs, remainingTokens, remainingTurns, remainingWallClockMs, tokenBudgetReached, turnBudgetReached, wallClockBudgetReached, overBudget }`
#[napi]
pub fn native_goal_engine_compute_budget_report(json: String) -> String {
    let result = (|| -> Result<serde_json::Value, String> {
        let v: serde_json::Value = serde_json::from_str(&json).map_err(|e| format!("invalid JSON: {e}"))?;
        let goal = parse_goal(v.get("goal").ok_or("missing goal")?)?;
        let now_ms = v.get("nowMs").and_then(|x| x.as_i64()).unwrap_or(0);
        let report = crate::goal::engine::compute_budget_report(&goal, now_ms);
        Ok(json!({
            "tokenBudget": report.token_budget,
            "turnBudget": report.turn_budget,
            "wallClockBudgetMs": report.wall_clock_budget_ms,
            "remainingTokens": report.remaining_tokens,
            "remainingTurns": report.remaining_turns,
            "remainingWallClockMs": report.remaining_wall_clock_ms,
            "tokenBudgetReached": report.token_budget_reached,
            "turnBudgetReached": report.turn_budget_reached,
            "wallClockBudgetReached": report.wall_clock_budget_reached,
            "overBudget": report.over_budget,
        }))
    })();
    match result {
        Ok(r) => r.to_string(),
        Err(e) => json!({ "ok": false, "error": e }).to_string(),
    }
}

/// Apply token + turn deltas to a goal.
/// Input: `{ goal: GoalStateJSON, tokenDelta: number, turnDelta: number, nowMs: number }`
/// Output: `{ goal: GoalStateJSON, overBudget: boolean }`
#[napi]
pub fn native_goal_engine_apply_usage(json: String) -> String {
    let result = (|| -> Result<serde_json::Value, String> {
        let v: serde_json::Value = serde_json::from_str(&json).map_err(|e| format!("invalid JSON: {e}"))?;
        let mut goal = parse_goal(v.get("goal").ok_or("missing goal")?)?;
        let token_delta = v.get("tokenDelta").and_then(|x| x.as_i64()).unwrap_or(0);
        let turn_delta = v.get("turnDelta").and_then(|x| x.as_i64()).unwrap_or(0);
        let now_ms = v.get("nowMs").and_then(|x| x.as_i64()).unwrap_or(0);
        let over = crate::goal::engine::apply_usage(&mut goal, token_delta, turn_delta, now_ms);
        Ok(json!({ "goal": serialize_goal(&goal), "overBudget": over }))
    })();
    match result {
        Ok(r) => r.to_string(),
        Err(e) => json!({ "ok": false, "error": e }).to_string(),
    }
}

/// Decide whether the goal driver should continue.
/// Input: `{ goal: GoalStateJSON, nowMs: number }`
/// Output: `{ action: 'continue', steeringPrompt: string }`
///      or `{ action: 'stop_budget', reason: string, steeringPrompt: string }`
///      or `{ action: 'stop_inactive' }`
#[napi]
pub fn native_goal_engine_decide_continuation(json: String) -> String {
    let result = (|| -> Result<serde_json::Value, String> {
        let v: serde_json::Value = serde_json::from_str(&json).map_err(|e| format!("invalid JSON: {e}"))?;
        let goal = parse_goal(v.get("goal").ok_or("missing goal")?)?;
        let now_ms = v.get("nowMs").and_then(|x| x.as_i64()).unwrap_or(0);
        let decision = crate::goal::engine::decide_continuation(&goal, now_ms);
        match decision {
            crate::goal::engine::ContinuationAction::Continue { steering_prompt } => {
                Ok(json!({ "action": "continue", "steeringPrompt": steering_prompt }))
            }
            crate::goal::engine::ContinuationAction::StopBudget { reason, steering_prompt } => {
                Ok(json!({ "action": "stop_budget", "reason": reason, "steeringPrompt": steering_prompt }))
            }
            crate::goal::engine::ContinuationAction::StopInactive => {
                Ok(json!({ "action": "stop_inactive" }))
            }
        }
    })();
    match result {
        Ok(r) => r.to_string(),
        Err(e) => json!({ "ok": false, "error": e }).to_string(),
    }
}

/// Apply the 3-turn blocked audit.
/// Input: `{ goal: GoalStateJSON }`
/// Output: `{ action: 'record_attempt', streak: number, attemptsNeeded: number, message: string }`
///      or `{ action: 'mark_blocked', streak: number }`
#[napi]
pub fn native_goal_engine_decide_blocked_audit(json: String) -> String {
    let result = (|| -> Result<serde_json::Value, String> {
        let v: serde_json::Value = serde_json::from_str(&json).map_err(|e| format!("invalid JSON: {e}"))?;
        let goal = parse_goal(v.get("goal").ok_or("missing goal")?)?;
        let decision = crate::goal::engine::decide_blocked_audit(&goal);
        match decision {
            state::BlockedAuditDecision::RecordAttempt { streak, attempts_needed, message } => {
                Ok(json!({ "action": "record_attempt", "streak": streak, "attemptsNeeded": attempts_needed, "message": message }))
            }
            state::BlockedAuditDecision::MarkBlocked { streak } => {
                Ok(json!({ "action": "mark_blocked", "streak": streak }))
            }
        }
    })();
    match result {
        Ok(r) => r.to_string(),
        Err(e) => json!({ "ok": false, "error": e }).to_string(),
    }
}

/// Attempt a status transition.
/// Input: `{ goal: GoalStateJSON, targetStatus: string, expectedGoalId?: string }`
/// Output: `{ ok: true, goal: GoalStateJSON }` or `{ ok: false, error: string }`
#[napi]
pub fn native_goal_engine_decide_status_transition(json: String) -> String {
    let result = (|| -> Result<serde_json::Value, String> {
        let v: serde_json::Value = serde_json::from_str(&json).map_err(|e| format!("invalid JSON: {e}"))?;
        let goal = parse_goal(v.get("goal").ok_or("missing goal")?)?;
        let target_str = v.get("targetStatus").and_then(|x| x.as_str()).ok_or("missing targetStatus")?;
        let target = state::GoalStatus::from_str(target_str)
            .ok_or_else(|| format!("invalid status: {target_str}"))?;
        let expected = v.get("expectedGoalId").and_then(|x| x.as_str());
        let new_goal = crate::goal::engine::decide_status_transition(goal, target, expected)?;
        Ok(json!({ "ok": true, "goal": serialize_goal(&new_goal) }))
    })();
    match result {
        Ok(r) => r.to_string(),
        Err(e) => json!({ "ok": false, "error": e }).to_string(),
    }
}

/// Render the full active-goal reminder (injected at turn boundary).
/// Input: `{ goal: GoalStateJSON, nowMs: number }`
/// Output: rendered prompt string
#[napi]
pub fn native_goal_engine_render_goal_reminder(json: String) -> String {
    let result = (|| -> Result<String, String> {
        let v: serde_json::Value = serde_json::from_str(&json).map_err(|e| format!("invalid JSON: {e}"))?;
        let goal = parse_goal(v.get("goal").ok_or("missing goal")?)?;
        let now_ms = v.get("nowMs").and_then(|x| x.as_i64()).unwrap_or(0);
        Ok(steering::render_goal_reminder(&goal, now_ms))
    })();
    match result {
        Ok(r) => r,
        Err(e) => format!("ERROR: {e}"),
    }
}

/// Render a light blocked note.
/// Input: `{ goal: GoalStateJSON }`
/// Output: rendered prompt string
#[napi]
pub fn native_goal_engine_render_blocked_note(json: String) -> String {
    let result = (|| -> Result<String, String> {
        let v: serde_json::Value = serde_json::from_str(&json).map_err(|e| format!("invalid JSON: {e}"))?;
        let goal = parse_goal(v.get("goal").ok_or("missing goal")?)?;
        Ok(steering::render_blocked_note(&goal))
    })();
    match result {
        Ok(r) => r,
        Err(e) => format!("ERROR: {e}"),
    }
}

/// Render a light paused note.
/// Input: `{ goal: GoalStateJSON }`
/// Output: rendered prompt string
#[napi]
pub fn native_goal_engine_render_paused_note(json: String) -> String {
    let result = (|| -> Result<String, String> {
        let v: serde_json::Value = serde_json::from_str(&json).map_err(|e| format!("invalid JSON: {e}"))?;
        let goal = parse_goal(v.get("goal").ok_or("missing goal")?)?;
        Ok(steering::render_paused_note(&goal))
    })();
    match result {
        Ok(r) => r,
        Err(e) => format!("ERROR: {e}"),
    }
}

// ---------------------------------------------------------------------------
// Internal JSON helpers
// ---------------------------------------------------------------------------

use serde_json::json;

fn parse_goal(v: &serde_json::Value) -> Result<state::GoalState, String> {
    let status_str = get_str(v, "status")?;
    Ok(state::GoalState {
        goal_id: get_str(v, "goalId")?.to_string(),
        objective: get_str(v, "objective")?.to_string(),
        completion_criterion: v
            .get("completionCriterion")
            .and_then(|x| x.as_str().map(|s| s.to_string())),
        status: state::GoalStatus::from_str(status_str)
            .ok_or_else(|| format!("invalid status: {status_str}"))?,
        token_budget: v.get("tokenBudget").and_then(|x| x.as_i64()),
        turn_budget: v.get("turnBudget").and_then(|x| x.as_i64()),
        wall_clock_budget_ms: v.get("wallClockBudgetMs").and_then(|x| x.as_i64()),
        tokens_used: get_i64(v, "tokensUsed")?,
        turns_used: v.get("turnsUsed").and_then(|x| x.as_i64()).unwrap_or(0),
        wall_clock_ms: v.get("wallClockMs").and_then(|x| x.as_i64()).unwrap_or(0),
        blocked_streak: v
            .get("blockedStreak")
            .and_then(|x| x.as_u64())
            .unwrap_or(0) as u32,
        wall_clock_resumed_at: v.get("wallClockResumedAt").and_then(|x| x.as_i64()),
        terminal_reason: v
            .get("terminalReason")
            .and_then(|x| x.as_str().map(|s| s.to_string())),
        created_at: v.get("createdAt").and_then(|x| x.as_i64()).unwrap_or(0),
        updated_at: v.get("updatedAt").and_then(|x| x.as_i64()).unwrap_or(0),
    })
}

fn parse_update(v: &serde_json::Value) -> Result<state::GoalUpdate, String> {
    Ok(state::GoalUpdate {
        objective: v.get("objective").and_then(|x| x.as_str().map(|s| s.to_string())),
        completion_criterion: match v.get("completionCriterion") {
            Some(val) if val.is_null() => Some(None),
            Some(val) => Some(val.as_str().map(|s| s.to_string())),
            None => None,
        },
        status: v
            .get("status")
            .and_then(|x| x.as_str())
            .and_then(state::GoalStatus::from_str),
        token_budget: match v.get("tokenBudget") {
            Some(val) if val.is_null() => Some(None),
            Some(val) => Some(val.as_i64()),
            None => None,
        },
        turn_budget: match v.get("turnBudget") {
            Some(val) if val.is_null() => Some(None),
            Some(val) => Some(val.as_i64()),
            None => None,
        },
        wall_clock_budget_ms: match v.get("wallClockBudgetMs") {
            Some(val) if val.is_null() => Some(None),
            Some(val) => Some(val.as_i64()),
            None => None,
        },
        tokens_used: v.get("tokensUsed").and_then(|x| x.as_i64()),
        turns_used: v.get("turnsUsed").and_then(|x| x.as_i64()),
        wall_clock_ms: v.get("wallClockMs").and_then(|x| x.as_i64()),
        blocked_streak: v.get("blockedStreak").and_then(|x| x.as_u64().map(|x| x as u32)),
        wall_clock_resumed_at: match v.get("wallClockResumedAt") {
            Some(val) if val.is_null() => Some(None),
            Some(val) => Some(val.as_i64()),
            None => None,
        },
        terminal_reason: match v.get("terminalReason") {
            Some(val) if val.is_null() => Some(None),
            Some(val) => Some(val.as_str().map(|s| s.to_string())),
            None => None,
        },
        expected_goal_id: v
            .get("expectedGoalId")
            .and_then(|x| x.as_str().map(|s| s.to_string())),
    })
}

fn serialize_goal(g: &state::GoalState) -> serde_json::Value {
    json!({
        "goalId": g.goal_id,
        "objective": g.objective,
        "completionCriterion": g.completion_criterion,
        "status": g.status.as_str(),
        "tokenBudget": g.token_budget,
        "turnBudget": g.turn_budget,
        "wallClockBudgetMs": g.wall_clock_budget_ms,
        "tokensUsed": g.tokens_used,
        "turnsUsed": g.turns_used,
        "wallClockMs": g.wall_clock_ms,
        "blockedStreak": g.blocked_streak,
        "wallClockResumedAt": g.wall_clock_resumed_at,
        "terminalReason": g.terminal_reason,
        "createdAt": g.created_at,
        "updatedAt": g.updated_at,
    })
}

fn get_str<'a>(v: &'a serde_json::Value, key: &str) -> Result<&'a str, String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .ok_or_else(|| format!("missing or non-string field: {key}"))
}

fn get_i64(v: &serde_json::Value, key: &str) -> Result<i64, String> {
    v.get(key)
        .and_then(|x| x.as_i64())
        .ok_or_else(|| format!("missing or non-integer field: {key}"))
}

// ============================================================================
// Path access — canonicalization and containment
// ============================================================================

use crate::path_access;

/// Normalize a user path (Win32/Cygwin drive conversion).
#[napi]
pub fn native_path_normalize_user_path(path: String, path_class: String) -> String {
    let class = path_access::PathClass::from_str(&path_class).unwrap_or(path_access::PathClass::Posix);
    path_access::normalize_user_path(&path, class)
}

/// Expand `~` → home directory.
#[napi]
pub fn native_path_expand_user_path(path: String, home_dir: Option<String>, path_class: String) -> String {
    let class = path_access::PathClass::from_str(&path_class).unwrap_or(path_access::PathClass::Posix);
    path_access::expand_user_path(&path, home_dir.as_deref(), class)
}

/// Lexical canonicalization: relative → absolute → normalize.
/// Returns "ERROR: <code>: <message>" on failure (mirrors TS PathSecurityError).
#[napi]
pub fn native_path_canonicalize(path: String, cwd: String, path_class: String) -> String {
    let class = path_access::PathClass::from_str(&path_class).unwrap_or(path_access::PathClass::Posix);
    match path_access::canonicalize_path(&path, &cwd, class) {
        Ok(p) => p,
        Err(e) => format!("ERROR: {e}"),
    }
}

/// Component-boundary prefix check.
#[napi]
pub fn native_path_is_within_directory(candidate: String, base: String, path_class: String) -> bool {
    let class = path_access::PathClass::from_str(&path_class).unwrap_or(path_access::PathClass::Posix);
    path_access::is_within_directory(&candidate, &base, class)
}

/// Multi-root workspace containment.
#[napi]
pub fn native_path_is_within_workspace(candidate: String, roots: Vec<String>, path_class: String) -> bool {
    let class = path_access::PathClass::from_str(&path_class).unwrap_or(path_access::PathClass::Posix);
    path_access::is_within_workspace(&candidate, &roots, class)
}

// ============================================================================
// Permission — DSL pattern parsing
// ============================================================================

/// Parse a permission rule DSL pattern.
/// Returns JSON `{"toolName":"...","argPattern":...}` or `"ERROR: ..."` on failure.
#[napi]
pub fn native_parse_permission_pattern(pattern: String) -> String {
    permission::native_parse_permission_pattern(pattern)
}

/// Glob-aware canonicalization: normalizes the path prefix before the first
/// glob-containing component, leaving the glob suffix untouched. Returns
/// "ERROR: ..." on failure.
#[napi]
pub fn native_path_canonicalize_for_glob(path: String, cwd: String, path_class: String) -> String {
    let class = path_access::PathClass::from_str(&path_class).unwrap_or(path_access::PathClass::Posix);
    match path_access::canonicalize_path_for_glob(&path, &cwd, class) {
        Ok(p) => p,
        Err(e) => format!("ERROR: {e}"),
    }
}