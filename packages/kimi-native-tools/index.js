/// TypeScript bindings for kimi-native-tools.
///
/// This file provides the JavaScript/TypeScript API that wraps the native
/// Rust module. It handles loading the correct platform-specific .node file
/// and provides typed wrappers for each tool.

const fs = require('node:fs');
const path = require('node:path');

// Platform-specific native module loading.
const BINDING_NAME = 'kimi-native-tools';

function loadBinding() {
  // Try the newer napi-rs naming first (includes MSVC suffix).
  try {
    return require(`./${BINDING_NAME}.${process.platform}-${process.arch}-msvc.node`);
  } catch {
    // Fall through to legacy naming.
  }

  // Try the standard napi-rs loading (platform-specific naming).
  try {
    return require(`./${BINDING_NAME}.${process.platform}-${process.arch}.node`);
  } catch {
    // Fall through.
  }

  // Try universal binding.
  try {
    return require(`./${BINDING_NAME}.node`);
  } catch {
    // Fall through.
  }

  // Try from release build directory (cargo build --release).
  const ext = process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so';
  // Rust crate name is kimi_native_tools (underscores), JS package is kimi-native-tools (hyphens).
  const rustName = BINDING_NAME.replace(/-/g, '_');
  const releasePath = path.join(__dirname, 'target', 'release', `${rustName}.${ext}`);
  try {
    if (fs.existsSync(releasePath)) {
      return require(releasePath);
    }
  } catch {
    // Fall through.
  }

  // Try from debug build directory.
  const debugPath = path.join(__dirname, 'target', 'debug', `${rustName}.${ext}`);
  try {
    if (fs.existsSync(debugPath)) {
      return require(debugPath);
    }
  } catch {
    // Fall through.
  }

  throw new Error(
    `Failed to load kimi-native-tools binding for ${process.platform}-${process.arch}. ` +
    'Run `npm run build` or `cargo build --release` to compile the native module.'
  );
}

const binding = loadBinding();

// Re-export constants.
const READ_MAX_LINES = binding.READ_MAX_LINES;
const READ_MAX_LINE_LENGTH = binding.READ_MAX_LINE_LENGTH;
const READ_MAX_BYTES = binding.READ_MAX_BYTES;
const GLOB_MAX_MATCHES = binding.GLOB_MAX_MATCHES;
const GREP_DEFAULT_HEAD_LIMIT = binding.GREP_DEFAULT_HEAD_LIMIT;
const BASH_DEFAULT_TIMEOUT = binding.BASH_DEFAULT_TIMEOUT;
const BASH_MAX_TIMEOUT = binding.BASH_MAX_TIMEOUT;
const nativeIsSensitiveFileBytes = binding.nativeIsSensitiveFileBytes;

// ============================================================================
// Read tool
// ============================================================================

/**
 * Read a text file with line numbers.
 *
 * @param {string} path - Path to the file to read.
 * @param {object} [options] - Read options.
 * @param {number} [options.lineOffset] - Line to start from (1-indexed). Negative = tail.
 * @param {number} [options.nLines] - Number of lines to read. Capped at 1000.
 * @returns {Promise<{ content: string, lineCount: number, error?: string }>}
 */
async function nativeRead(path, options = {}) {
  return binding.nativeRead(
    path,
    options.lineOffset ?? null,
    options.nLines ?? null,
  );
}

// ============================================================================
// Batch Read — parallel multi-file read
// ============================================================================

/**
 * Read multiple files in parallel.
 *
 * @param {string[]} paths - Array of file paths to read.
 * @param {object} [options] - Read options.
 * @param {Array<number|null>} [options.lineOffsets] - Per-file line offsets.
 * @param {Array<number|null>} [options.nLinesArray] - Per-file line counts.
 * @returns {Promise<Array<{ content: string, lineCount: number, error?: string }>>}
 */
async function nativeBatchRead(paths, options = {}) {
  return binding.nativeBatchRead(
    paths,
    options.lineOffsets ?? null,
    options.nLinesArray ?? null,
  );
}

// ============================================================================
// Write tool
// ============================================================================

/**
 * Write content to a file.
 *
 * @param {string} path - Path to the file.
 * @param {string} content - Content to write.
 * @param {object} [options] - Write options.
 * @param {'overwrite'|'append'} [options.mode] - Write mode. Default 'overwrite'.
 * @returns {Promise<{ bytesWritten: number, error?: string }>}
 */
async function nativeWrite(path, content, options = {}) {
  return binding.nativeWrite(
    path,
    content,
    options.mode ?? null,
  );
}
// ============================================================================
// File cache
// ============================================================================

/**
 * Invalidate the file read cache entry for a path (call after write/edit).
 *
 * @param {string} path - Path to the file that was written or edited.
 */
function nativeFileCacheInvalidate(path) {
  return binding.nativeFileCacheInvalidate(path);
}

// ============================================================================
// Edit tool
// ============================================================================

/**
 * Edit a file by replacing exact string occurrences.
 *
 * @param {string} path - Path to the file.
 * @param {string} oldString - Exact content to replace. Must be non-empty.
 * @param {string} newString - Replacement text.
 * @param {object} [options] - Edit options.
 * @param {boolean} [options.replaceAll] - Replace all occurrences. Default false.
 * @returns {{ success: boolean, error?: string, replacements: number }}
 */
function nativeEdit(path, oldString, newString, options = {}) {
  return binding.nativeEdit(
    path,
    oldString,
    newString,
    options.replaceAll ?? null,
  );
}

// ============================================================================
// Grep tool
// ============================================================================

/**
 * Search for a pattern in files.
 *
 * @param {string} pattern - Regular expression to search for.
 * @param {object} [options] - Search options.
 * @param {string} [options.path] - File or directory to search.
 * @param {string} [options.glob] - Glob filter.
 * @param {string} [options.fileType] - File type filter ("ts", "py", "rust", ...).
 * @param {'content'|'files_with_matches'|'count_matches'} [options.outputMode] - Output mode.
 * @param {boolean} [options.caseInsensitive] - Case-insensitive search.
 * @param {boolean} [options.lineNumbers] - Show line numbers.
 * @param {number} [options.afterContext] - Lines after match.
 * @param {number} [options.beforeContext] - Lines before match.
 * @param {number} [options.context] - Lines before and after.
 * @param {number} [options.headLimit] - Max output lines. 0 = unlimited.
 * @param {number} [options.offset] - Skip first N entries.
 * @param {boolean} [options.multiline] - Multiline matching.
 * @param {boolean} [options.includeIgnored] - Search files excluded by .gitignore.
 * @param {number} [options.timeoutMs] - Wall-clock timeout in ms. 0 = unlimited.
 * @returns {{ content: string, error?: string, matchCount: number, fileCount: number, filteredSensitive: string[], timedOut: boolean }}
 */
function nativeGrep(pattern, options = {}) {
  return binding.nativeGrep(
    pattern,
    options.path ?? null,
    options.glob ?? null,
    options.fileType ?? null,
    options.outputMode ?? null,
    options.caseInsensitive ?? null,
    options.lineNumbers ?? null,
    options.afterContext ?? null,
    options.beforeContext ?? null,
    options.context ?? null,
    options.headLimit ?? null,
    options.offset ?? null,
    options.multiline ?? null,
    options.includeIgnored ?? null,
    options.timeoutMs ?? null,
  );
}

// ============================================================================
// Glob tool
// ============================================================================

/**
 * Find files matching a glob pattern.
 *
 * @param {string} pattern - Glob pattern (supports brace expansion).
 * @param {object} [options] - Glob options.
 * @param {string} [options.path] - Directory to search.
 * @param {boolean} [options.includeDirs] - Include directories. Default true.
 * @returns {{ files: string[], error?: string, truncated: boolean }}
 */
function nativeGlob(pattern, options = {}) {
  return binding.nativeGlob(
    pattern,
    options.path ?? null,
    options.includeDirs ?? null,
  );
}

/**
 * Check if a path matches any of the given glob patterns.
 *
 * Uses `globset::GlobSet` to batch-compile all patterns and test the path
 * in a single `is_match` call. Case-insensitive matching.
 *
 * @param {string[]} globs - Array of glob patterns.
 * @param {string} path - Relative path to test.
 * @returns {boolean} True if the path matches at least one pattern.
 */
function nativeGlobMatchesAny(globs, path) {
  return binding.nativeGlobMatchesAny(globs, path);
}

// ============================================================================
// List Directory tool
// ============================================================================

/**
 * Generate a compact 2-level directory tree listing.
 *
 * @param {object} [options] - List directory options.
 * @param {string} [options.path] - Directory to list. Defaults to current directory.
 * @param {boolean} [options.collapseHiddenDirs] - If true, skip listing children of hidden directories.
 * @returns {{ output: string, error?: string }}
 */
function nativeListDirectory(options = {}) {
  return binding.nativeListDirectory(
    options.path ?? null,
    options.collapseHiddenDirs ?? null,
  );
}

// ============================================================================
// File Type tool
// ============================================================================

/**
 * Best-effort pixel-dimension reader for common raster formats.
 *
 * @param {Buffer|Uint8Array} data - Raw file bytes (at least the first few hundred bytes).
 * @returns {{ width: number, height: number } | null} Image dimensions or null if unknown.
 */
function nativeSniffImageDimensions(data) {
  return binding.nativeSniffImageDimensions(data);
}

/**
 * Detect file type from path and header bytes.
 *
 * Uses file extension first, then falls back to magic-byte sniffing.
 *
 * @param {string} path - File path (used for extension-based detection).
 * @param {Buffer|Uint8Array} header - First bytes of the file content (up to 512 bytes).
 * @returns {{ kind: string, mimeType: string }}
 */
function nativeDetectFileType(path, header) {
  const r = binding.nativeDetectFileType(path, new Uint8Array(header));
  // napi-rs: struct fields arrive as snake_case; normalize to camelCase.
  return r ? { kind: r.kind, mimeType: r.mime_type ?? r.mimeType } : { kind: 'unknown', mimeType: '' };
}

/**
 * Check if a path points to a credentials-bearing file.
 *
 * Converts the JS string to a Latin1 byte buffer via `Buffer.from(path,
 * 'latin1')` — a V8 C++ intrinsic (~31ns for typical paths) — before calling
 * the Rust binding. This avoids the UTF-16→UTF-8 string conversion that a
 * `String` napi parameter would trigger (~170ns). For ASCII paths the Latin1
 * bytes are identical to UTF-8.
 *
 * @param {string} path - File path to check.
 * @returns {boolean} True if the file is sensitive (credentials, keys, .env).
 */
function nativeIsSensitiveFile(path) {
  return binding.nativeIsSensitiveFileBytes(Buffer.from(path, 'latin1'));
}

// ============================================================================
// Token estimation
// ============================================================================

/**
 * Estimate token count from text (ASCII ~4 chars/token, non-ASCII ~1 char/token).
 *
 * @param {string} text - Text to estimate.
 * @returns {number} Estimated token count.
 */
function nativeEstimateTokens(text) {
  return binding.nativeEstimateTokens(text);
}

/**
 * Batch token estimation — sums token counts across multiple strings
 * in a single napi call (one boundary crossing instead of N).
 *
 * @param {string[]} texts - Array of text strings to estimate.
 * @returns {number} Total estimated token count across all strings.
 */
function nativeEstimateTokensBatch(texts) {
  return binding.nativeEstimateTokensBatch(texts);
}

/**
 * Truncate text to fit within a token budget, keeping the BEGINNING.
 *
 * @param {string} text - Text to truncate.
 * @param {number} maxTokens - Maximum token budget.
 * @returns {string} Truncated text (prefix).
 */
function nativeTruncateTextToTokens(text, maxTokens) {
  return binding.nativeTruncateTextToTokens(text, maxTokens);
}

/**
 * Truncate text to fit within a token budget, keeping the END.
 *
 * @param {string} text - Text to truncate.
 * @param {number} maxTokens - Maximum token budget.
 * @returns {string} Truncated text (suffix).
 */
function nativeTruncateTextToTokensFromEnd(text, maxTokens) {
  return binding.nativeTruncateTextToTokensFromEnd(text, maxTokens);
}

// ============================================================================
// Bash tool
// ============================================================================

/**
 * Execute a shell command.
 *
 * @param {string} command - Command to execute.
 * @param {object} [options] - Bash options.
 * @param {string} [options.cwd] - Working directory.
 * @param {number} [options.timeout] - Timeout in seconds. Default 60.
 * @param {[string, string][]} [options.env] - Environment variables.
 * @returns {{ exitCode: number, stdout: string, stderr: string, timedOut: boolean, error?: string }}
 */
function nativeBash(command, options = {}) {
  const envPairs = options.env
    ? options.env.map(([k, v]) => [k, v])
    : null;

  return binding.nativeBash(
    command,
    options.cwd ?? null,
    options.timeout ?? null,
    envPairs,
  );
}

// ============================================================================
// Compaction strategy
// ============================================================================

/**
 * Decide how many leading messages to compact.
 *
 * @param {Array<{role: string, toolCallsCount: number, tokens: number}>} messages - Message metadata.
 * @param {{maxSize: number, maxRecentMessages: number, maxRecentUserMessages: number, maxRecentSizeRatio: number, minOverflowReductionRatio: number}} config - Compaction config.
 * @param {boolean} isManual - Whether this is a manual (user-requested) compaction.
 * @returns {number} Number of messages to compact (0 = no compaction possible).
 */
function nativeComputeCompactCount(messages, config, isManual) {
  return binding.nativeComputeCompactCount(messages, config, isManual);
}

/**
 * Find a split point when the LLM throws a context overflow error.
 *
 * @param {Array<{role: string, toolCallsCount: number, tokens: number}>} messages - Message metadata.
 * @param {{maxSize: number, maxRecentMessages: number, maxRecentUserMessages: number, maxRecentSizeRatio: number, minOverflowReductionRatio: number}} config - Compaction config.
 * @returns {number} Split index (number of messages to keep in the tail).
 */
function nativeReduceCompactOnOverflow(messages, config) {
  return binding.nativeReduceCompactOnOverflow(messages, config);
}

// ============================================================================
// Tool access conflict detection
// ============================================================================

/**
 * Check whether any access in `left` conflicts with any access in `right`.
 *
 * @param {Array<{kind: string, operation?: string, path?: string, recursive?: boolean}>} left
 * @param {Array<{kind: string, operation?: string, path?: string, recursive?: boolean}>} right
 * @returns {boolean} True if any pair conflicts.
 */
function nativeToolAccessesConflict(left, right) {
  return binding.nativeToolAccessesConflict(left, right);
}

// ============================================================================
// Image compression & cropping
// ============================================================================

/**
 * Compress (resize + re-encode) `data` to fit the pixel + byte budget.
 *
 * Runs decode/resize/encode on a blocking thread. Returns `null` when the
 * format is unsupported or decode/encode fails (caller passes through the
 * original bytes). Returns `{ changed: false }` when the re-encode didn't
 * help. Returns `{ changed: true }` when the result is smaller.
 *
 * @param {Uint8Array} data - Raw image bytes (PNG or JPEG).
 * @param {string} mimeType - MIME type ("image/png" or "image/jpeg").
 * @param {{maxEdge: number, byteBudget: number, fallbackEdges: number[], jpegQualitySteps: number[]}} config
 * @returns {Promise<{data: Uint8Array, mimeType: string, width: number, height: number, originalWidth: number, originalHeight: number, changed: boolean, originalByteLength: number, finalByteLength: number} | null>}
 */
function nativeCompressImage(data, mimeType, config) {
  return binding.nativeCompressImage(data, mimeType, config);
}

/**
 * Crop `region` out of `data` and encode it for the model.
 *
 * Returns an outcome object (never throws): `ok: false` carries an `error`
 * message; `ok: true` carries the encoded crop.
 *
 * @param {Uint8Array} data - Raw image bytes (PNG or JPEG).
 * @param {string} mimeType - MIME type ("image/png" or "image/jpeg").
 * @param {number} regionX - Crop origin X (original-image pixel coordinates).
 * @param {number} regionY - Crop origin Y.
 * @param {number} regionWidth - Crop width.
 * @param {number} regionHeight - Crop height.
 * @param {{maxEdge: number, byteBudget: number, skipResize: boolean, fallbackEdges: number[], jpegQualitySteps: number[]}} config
 * @returns {Promise<{ok: boolean, error: string, errorKind: string, data: Uint8Array, mimeType: string, width: number, height: number, originalWidth: number, originalHeight: number, regionX: number, regionY: number, regionWidth: number, regionHeight: number, resized: boolean, originalByteLength: number, finalByteLength: number}>}
 */
function nativeCropImage(data, mimeType, regionX, regionY, regionWidth, regionHeight, config) {
  return binding.nativeCropImage(
    data,
    mimeType,
    regionX,
    regionY,
    regionWidth,
    regionHeight,
    config,
  );
}

// ============================================================================
// Structured grep
// ============================================================================

/**
 * Structured grep — returns typed match data instead of formatted strings.
 *
 * Used by fsSearchService when rg is not available on PATH. Walks the
 * directory tree, applies include/exclude globs, reads each file, and
 * collects matches with context lines.
 *
 * @param {string} pattern - Pattern to search for.
 * @param {string} path - Directory to search in.
 * @param {boolean} literal - If true, treat pattern as literal (not regex).
 * @param {boolean} caseInsensitive - Case-insensitive search.
 * @param {string[]} includeGlobs - Only scan files matching these globs.
 * @param {string[]} excludeGlobs - Skip files matching these globs.
 * @param {number} contextLines - Number of context lines before/after each match.
 * @param {number} maxFiles - Max files to scan.
 * @param {number} maxMatchesPerFile - Max matches per file.
 * @param {number} maxTotalMatches - Max total matches across all files.
 * @param {number} timeoutMs - Timeout in milliseconds.
 * @param {boolean} followGitignore - Whether to respect .gitignore rules.
 * @returns {{ files: Array<{path: string, matches: Array<{line: number, col: number, text: string, before: string[], after: string[]}>}>, filesScanned: number, truncated: boolean, error?: string }}
 */
function nativeGrepStructured(
  pattern,
  path,
  literal,
  caseInsensitive,
  includeGlobs,
  excludeGlobs,
  contextLines,
  maxFiles,
  maxMatchesPerFile,
  maxTotalMatches,
  timeoutMs,
  followGitignore,
) {
  return binding.nativeGrepStructured(
    pattern,
    path,
    literal,
    caseInsensitive,
    includeGlobs ?? [],
    excludeGlobs ?? [],
    contextLines,
    maxFiles,
    maxMatchesPerFile,
    maxTotalMatches,
    timeoutMs,
    followGitignore,
  );
}

// ============================================================================
// Tool output truncation (ToolResultBuilder.write)
// ============================================================================

/**
 * Process one chunk of streaming tool output, applying line-length and
 * total-character budgets. Mirrors `ToolResultBuilder.write()` in
 * `result-builder.ts`.
 *
 * @param {string} text - The raw text chunk to process.
 * @param {number} currentNchars - Total UTF-16 code units already in the buffer.
 * @param {number} maxChars - Maximum total UTF-16 code units allowed.
 * @param {number|null} maxLineLength - Per-line maximum, or null for no limit.
 * @param {boolean} alreadyTruncated - Whether truncation already occurred.
 * @returns {{output: string, charsWritten: number, newNchars: number, truncated: boolean}}
 */
function nativeWriteToolOutputChunk(text, currentNchars, maxChars, maxLineLength, alreadyTruncated) {
  return binding.nativeWriteToolOutputChunk(
    text,
    currentNchars,
    maxChars,
    maxLineLength,
    alreadyTruncated,
  );
}

// ============================================================================
// MCP — Config loading
// ============================================================================

/**
 * Load and merge MCP server configs from the three-tier file hierarchy.
 *
 * @param {string} cwd - Current working directory.
 * @param {string} [homeDir] - Home directory override.
 * @returns {Promise<object>} Merged config result.
 */
function nativeMcpLoadConfig(cwd, homeDir) {
  return binding.nativeMcpLoadConfig(cwd, homeDir ?? null);
}

// ============================================================================
// MCP — Stdio client
// ============================================================================

/**
 * Spawn a stdio MCP server child process.
 *
 * @param {object} config - Spawn config (command, args, env, cwd).
 * @returns {Promise<{handle: number, pid: number}>}
 */
function nativeMcpStdioSpawn(config) {
  return binding.nativeMcpStdioSpawn({
    command: config.command,
    args: config.args ?? null,
    env: config.env ?? null,
    cwd: config.cwd ?? null,
  });
}

/**
 * Send the JSON-RPC initialize request.
 *
 * @param {number} handle - Handle from nativeMcpStdioSpawn.
 * @param {string} clientName - Client name.
 * @param {string} clientVersion - Client version.
 * @param {number} [timeoutMs] - Timeout in ms.
 * @returns {Promise<string>} JSON string of the server's initialize result.
 */
function nativeMcpStdioInitialize(handle, clientName, clientVersion, timeoutMs) {
  return binding.nativeMcpStdioInitialize(handle, clientName, clientVersion, timeoutMs ?? null);
}

/**
 * Call tools/list on the MCP server.
 *
 * @param {number} handle - Handle from nativeMcpStdioSpawn.
 * @returns {Promise<object[]>} Array of tool definitions.
 */
function nativeMcpStdioListTools(handle) {
  return binding.nativeMcpStdioListTools(handle);
}

/**
 * Call tools/call on the MCP server.
 *
 * @param {number} handle - Handle from nativeMcpStdioSpawn.
 * @param {string} name - Tool name.
 * @param {string} argsJson - Tool arguments as JSON string.
 * @param {number} [timeoutMs] - Timeout in ms.
 * @returns {Promise<string>} JSON string of the tool call result.
 */
function nativeMcpStdioCallTool(handle, name, argsJson, timeoutMs) {
  return binding.nativeMcpStdioCallTool(handle, name, argsJson, timeoutMs ?? null);
}

/**
 * Close a stdio MCP connection.
 *
 * @param {number} handle - Handle from nativeMcpStdioSpawn.
 * @returns {Promise<void>}
 */
function nativeMcpStdioClose(handle) {
  return binding.nativeMcpStdioClose(handle);
}

/**
 * Get stderr snapshot from the child process.
 *
 * @param {number} handle - Handle from nativeMcpStdioSpawn.
 * @returns {Promise<string>} Stderr tail (last ~4KB).
 */
function nativeMcpStdioStderrSnapshot(handle) {
  return binding.nativeMcpStdioStderrSnapshot(handle);
}

/**
 * Check if the child process is still alive.
 *
 * @param {number} handle - Handle from nativeMcpStdioSpawn.
 * @returns {Promise<boolean>}
 */
function nativeMcpStdioIsAlive(handle) {
  return binding.nativeMcpStdioIsAlive(handle);
}

// ============================================================================
// XML / HTML escaping
// ============================================================================

/**
 * Escape all XML-significant characters: & < > "
 * @param {string} text - Input text to escape.
 * @returns {string} Escaped text.
 */
function nativeEscapeXml(text) {
  return binding.nativeEscapeXml(text);
}

/**
 * Escape XML attribute boundary characters only: & "
 * @param {string} text - Input text to escape.
 * @returns {string} Escaped text.
 */
function nativeEscapeXmlAttr(text) {
  return binding.nativeEscapeXmlAttr(text);
}

/**
 * Escape tag delimiters only: < > (Markdown-safe, preserves & and ")
 * @param {string} text - Input text to escape.
 * @returns {string} Escaped text.
 */
function nativeEscapeXmlTags(text) {
  return binding.nativeEscapeXmlTags(text);
}

// ============================================================================
// MCP tool name sanitization
// ============================================================================

/**
 * Sanitize a string for use as part of an MCP tool name.
 * Replaces non-safe characters with `_` and collapses runs of `_`.
 * @param {string} part - String to sanitize.
 * @returns {string} Sanitized string.
 */
function nativeSanitizeMcpNamePart(part) {
  return binding.nativeSanitizeMcpNamePart(part);
}

/**
 * Check if a tool name starts with the MCP prefix (`mcp__`).
 * @param {string} name - Tool name to check.
 * @returns {boolean}
 */
function nativeIsMcpToolName(name) {
  return binding.nativeIsMcpToolName(name);
}

/**
 * Produce the qualified MCP tool name: `mcp__<server>__<tool>`.
 * Truncates with a deterministic 8-char FNV-1a hash suffix if > 64 chars.
 * @param {string} serverName - Server name.
 * @param {string} toolName - Tool name.
 * @returns {string} Qualified tool name.
 */
function nativeQualifyMcpToolName(serverName, toolName) {
  return binding.nativeQualifyMcpToolName(serverName, toolName);
}

// ============================================================================
// Goal — state machine, accounting, steering
// ============================================================================

/** Validate a goal objective. Returns error message or empty string. */
function nativeGoalValidateObjective(objective) {
  return binding.nativeGoalValidateObjective(objective);
}

/** Validate a goal token budget. Returns error message or empty string. */
function nativeGoalValidateBudget(value) {
  return binding.nativeGoalValidateBudget(value);
}

/** Apply a goal state update (JSON in, JSON out). */
function nativeGoalApplyUpdate(goalJson, updateJson) {
  return binding.nativeGoalApplyUpdate(goalJson, updateJson);
}

/** Compute chargeable token delta between two usage snapshots. */
function nativeGoalComputeTokenDelta(prevInput, prevCached, prevOutput, currInput, currCached, currOutput) {
  return binding.nativeGoalComputeTokenDelta(prevInput, prevCached, prevOutput, currInput, currCached, currOutput);
}

/** Render the continuation steering prompt. */
function nativeGoalRenderContinuation(objective, tokensUsed, tokenBudget) {
  return binding.nativeGoalRenderContinuation(objective, tokensUsed, tokenBudget);
}

/** Render the budget-limit wrap-up prompt. */
function nativeGoalRenderBudgetLimit(objective, tokensUsed, tokenBudget, timeUsedSeconds) {
  return binding.nativeGoalRenderBudgetLimit(objective, tokensUsed, tokenBudget, timeUsedSeconds);
}

/** Render the objective-updated prompt. */
function nativeGoalRenderObjectiveUpdated(objective, tokensUsed, tokenBudget) {
  return binding.nativeGoalRenderObjectiveUpdated(objective, tokensUsed, tokenBudget);
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  // Tools
  nativeRead,
  nativeBatchRead,
  nativeFileCacheInvalidate,
  nativeWrite,
  nativeEdit,
  nativeGrep,
  nativeGlob,
  nativeGlobMatchesAny,
  nativeListDirectory,
  nativeSniffImageDimensions,
  nativeDetectFileType,
  nativeIsSensitiveFile,
  nativeIsSensitiveFileBytes,
  nativeEstimateTokens,
  nativeEstimateTokensBatch,
  nativeTruncateTextToTokens,
  nativeTruncateTextToTokensFromEnd,
  nativeBash,

  // Compaction
  nativeComputeCompactCount,
  nativeReduceCompactOnOverflow,

  // Tool access conflict
  nativeToolAccessesConflict,

  // Image compression & cropping
  nativeCompressImage,
  nativeCropImage,

  // Tool output truncation
  nativeWriteToolOutputChunk,

  // Structured grep
  nativeGrepStructured,

  // MCP
  nativeMcpLoadConfig,
  nativeMcpStdioSpawn,
  nativeMcpStdioInitialize,
  nativeMcpStdioListTools,
  nativeMcpStdioCallTool,
  nativeMcpStdioClose,
  nativeMcpStdioStderrSnapshot,
  nativeMcpStdioIsAlive,

  // XML / HTML escaping
  nativeEscapeXml,
  nativeEscapeXmlAttr,
  nativeEscapeXmlTags,

  // MCP tool name sanitization
  nativeSanitizeMcpNamePart,
  nativeIsMcpToolName,
  nativeQualifyMcpToolName,

  // Constants
  READ_MAX_LINES,
  READ_MAX_LINE_LENGTH,
  READ_MAX_BYTES,
  GLOB_MAX_MATCHES,
  GREP_DEFAULT_HEAD_LIMIT,
  BASH_DEFAULT_TIMEOUT,
  BASH_MAX_TIMEOUT,

  // Goal
  nativeGoalValidateObjective,
  nativeGoalValidateBudget,
  nativeGoalApplyUpdate,
  nativeGoalComputeTokenDelta,
  nativeGoalRenderContinuation,
  nativeGoalRenderBudgetLimit,
  nativeGoalRenderObjectiveUpdated,
};
