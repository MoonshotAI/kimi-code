/// NAPI bindings — exposes all native tools to Node.js.
///
/// This module defines the `#[napi]` functions that TypeScript calls.
/// Each function wraps the corresponding Rust implementation.
use crate::bash::{self, BashConfig, BashResult, DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S};
use crate::compaction::{self, CompactionConfigMeta, CompactionMessageMeta};
use crate::edit::{self, EditResult};
use crate::glob::{self, GlobConfig, GlobResult, MAX_MATCHES};
use crate::grep::{self, GrepConfig, GrepResult, GrepStructuredConfig, GrepStructuredResult, OutputMode, DEFAULT_HEAD_LIMIT};
use crate::image_compress;
use crate::list_directory::{self, ListDirectoryConfig, ListDirectoryResult};
use crate::read::{self, ReadConfig, ReadResult, MAX_BYTES, MAX_LINE_LENGTH, MAX_LINES};
use crate::tool_access::{self, ToolAccessMeta};
use crate::write::{self, WriteMode, WriteResult};
use napi::bindgen_prelude::Uint8Array;
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
            .filter_map(|pair| {
                if pair.len() >= 2 {
                    Some((pair[0].clone(), pair[1].clone()))
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
pub fn native_sniff_image_dimensions(data: Vec<u8>) -> Option<ImageDimensions> {
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
