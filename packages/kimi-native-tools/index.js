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

  // Try the GNU suffix (Linux artifacts: x86_64-unknown-linux-gnu, ...).
  try {
    return require(`./${BINDING_NAME}.${process.platform}-${process.arch}-gnu.node`);
  } catch {
    // Fall through.
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
  const rustName = BINDING_NAME.replaceAll('-', '_');
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
      'Run `npm run build` or `cargo build --release` to compile the native module.',
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

// Translation (i18n) — direct pass-throughs to the Rust engine.
const nativeTranslate = binding.nativeTranslate;
const nativeTranslateCached = binding.nativeTranslateCached;
const nativeTranslateClearCache = binding.nativeTranslateClearCache;
const nativeTranslateBatch = binding.nativeTranslateBatch;
const nativeTranslateBatchCached = binding.nativeTranslateBatchCached;

// GitHub REST transport — authenticated request core (auth/headers/pagination in Rust).
const nativeGithubRequest = binding.nativeGithubRequest;

// ============================================================================
// FetchUrl — HTTP fetch with SSRF protection and HTML extraction
// ============================================================================

/**
 * Fetch a URL with SSRF protection, redirect handling, and HTML content extraction.
 *
 * Runs entirely on a Rust blocking thread — the Node event loop stays responsive.
 *
 * @param {string} url - The URL to fetch.
 * @param {object} [options] - Fetch options.
 * @param {string} [options.userAgent] - Custom User-Agent header.
 * @param {number} [options.maxBytes] - Maximum response body size in bytes.
 * @param {boolean} [options.allowPrivate] - Allow fetching private/loopback addresses.
 * @param {number} [options.timeoutMs] - Request timeout in milliseconds.
 * @returns {Promise<{content: string, kind: string, status: number, error?: string}>}
 */
async function nativeFetchUrl(url, options = {}) {
  return binding.nativeFetchUrl(
    url,
    options.userAgent ?? null,
    options.maxBytes ?? null,
    options.allowPrivate ?? null,
    options.timeoutMs ?? null,
  );
}

// ============================================================================
// WebSearch — DuckDuckGo HTML scraping
// ============================================================================

/**
 * Search DuckDuckGo and return structured results.
 *
 * Runs entirely on a Rust blocking thread — the Node event loop stays responsive.
 *
 * @param {string} query - The search query.
 * @param {object} [options] - Search options.
 * @param {number} [options.timeoutMs] - Request timeout in milliseconds.
 * @param {number} [options.maxResults] - Maximum number of results.
 * @returns {Promise<{results: Array<{title: string, url: string, snippet: string, siteName?: string}>, error?: string}>}
 */
async function nativeWebSearch(query, options = {}) {
  return binding.nativeWebSearch(query, options.timeoutMs ?? null, options.maxResults ?? null);
}

// ============================================================================
// LLM Stream — HTTP SSE streaming with provider-specific event decoding
// ============================================================================

/**
 * Execute an LLM streaming request via Rust.
 *
 * Handles HTTP POST, SSE parsing, and provider-specific event decoding entirely
 * in Rust. Returns all decoded parts + metadata after the stream completes.
 *
 * @param {object} config - Stream configuration.
 * @param {string} config.provider - Provider name ("openai-responses" | "openai-legacy" | "anthropic" | "google-genai").
 * @param {string} config.url - API endpoint URL.
 * @param {string} config.apiKey - API key / bearer token.
 * @param {string} config.model - Model name.
 * @param {string} config.requestBody - JSON request body string.
 * @param {number} [config.timeoutMs] - Request timeout in milliseconds.
 * @param {Array<{key: string, value: string}>} [config.extraHeaders] - Additional headers.
 * @returns {Promise<{parts: Array, metadata: object, error?: string}>}
 */
async function nativeLlmStream(config) {
  return binding.nativeLlmStream({
    provider: config.provider,
    url: config.url,
    apiKey: config.apiKey,
    model: config.model,
    requestBody: config.requestBody,
    // napi v3 rejects `null` for Option<Vec<...>> ("Given napi value is not
    // an array"); absent optionals must be passed as `undefined`.
    timeoutMs: config.timeoutMs ?? undefined,
    extraHeaders: config.extraHeaders ?? undefined,
  });
}

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
  return binding.nativeRead(path, options.lineOffset ?? null, options.nLines ?? null);
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
  return binding.nativeBatchRead(paths, options.lineOffsets ?? null, options.nLinesArray ?? null);
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
  return binding.nativeWrite(path, content, options.mode ?? null);
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
  return binding.nativeEdit(path, oldString, newString, options.replaceAll ?? null);
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
 * @param {boolean} [options.includeIgnored] - Also match files excluded by
 *   .gitignore and friends. Sensitive files and VCS metadata directories
 *   remain filtered. Default false.
 * @returns {{ files: string[], error?: string, truncated: boolean }}
 */
function nativeGlob(pattern, options = {}) {
  return binding.nativeGlob(
    pattern,
    options.path ?? null,
    options.includeDirs ?? null,
    options.includeIgnored ?? null,
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
  return binding.nativeListDirectory(options.path ?? null, options.collapseHiddenDirs ?? null);
}

// ============================================================================
// File Type tool
// ============================================================================

/**
 * Best-effort pixel-dimension reader for common raster formats.
 *
 * @param {Uint8Array} data - Raw file bytes (at least the first few hundred bytes). `Buffer` is accepted, being a `Uint8Array` subclass.
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
 * @param {Uint8Array} header - First bytes of the file content (up to 512 bytes). `Buffer` is accepted, being a `Uint8Array` subclass.
 * @returns {{ kind: string, mimeType: string }}
 */
function nativeDetectFileType(path, header) {
  const r = binding.nativeDetectFileType(path, new Uint8Array(header));
  // napi-rs: struct fields arrive as snake_case; normalize to camelCase.
  return r
    ? { kind: r.kind, mimeType: r.mime_type ?? r.mimeType }
    : { kind: 'unknown', mimeType: '' };
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
  const envPairs = options.env ? options.env.map(([k, v]) => [k, v]) : null;

  return binding.nativeBash(command, options.cwd ?? null, options.timeout ?? null, envPairs);
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
// Compaction — split safety + user message selection
// ============================================================================

/**
 * Check whether a compaction split is safe after messages[index].
 * @param {Array<{role: string, toolCallsCount: number, tokens: number}>} messages
 * @param {number} index
 * @returns {boolean}
 */
function nativeCanSplitAfter(messages, index) {
  return binding.nativeCanSplitAfter(messages, index);
}

/**
 * Select user messages compaction keeps verbatim, with head/tail split.
 * @param {Array<{role: string, text: string, tokens: number}>} messages
 * @param {number} maxTokens
 * @param {number} headTokens
 * @returns {{headIndices: number[], tailIndices: number[], headTruncateChars: number|null, tailTruncateChars: number|null, elided: boolean, omittedTokens: number}}
 */
function nativeSelectCompactionUserMessages(messages, maxTokens, headTokens) {
  return binding.nativeSelectCompactionUserMessages(messages, maxTokens, headTokens);
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
function nativeWriteToolOutputChunk(
  text,
  currentNchars,
  maxChars,
  maxLineLength,
  alreadyTruncated,
) {
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
// MCP — HTTP transport (Streamable HTTP, Phase 7.1)
// ============================================================================

/**
 * POST a JSON-RPC envelope to a Streamable-HTTP MCP endpoint.
 *
 * @param {string} url - MCP endpoint.
 * @param {object} body - JSON-RPC 2.0 request envelope.
 * @param {string} [sessionId] - Mcp-Session-Id from a prior response.
 * @param {object} [extraHeaders] - Additional request headers.
 * @param {number} [timeoutMs] - Total timeout (default 30000).
 * @returns {Promise<{status: number, sessionId?: string, contentType?: string, jsonBody?: unknown, rawBody: string}>}
 */
function nativeMcpHttpPost(url, body, sessionId, extraHeaders, timeoutMs) {
  return binding.nativeMcpHttpPost(
    url,
    body,
    sessionId ?? null,
    extraHeaders ?? null,
    timeoutMs ?? null,
  );
}

// ============================================================================
// MCP — SSE transport (Phase 7.2)
// ============================================================================

/** HTTP method selector for SSE: `Get` (listener) or `Post` (request/reply). */
const NativeMcpSseMethod = binding.NativeMcpSseMethod;

/**
 * Open an SSE stream against an MCP endpoint and collect every event.
 *
 * @param {string} url - MCP endpoint.
 * @param {number} method - `NativeMcpSseMethod.Get` or `.Post`.
 * @param {object} [body] - JSON-RPC envelope (POST only).
 * @param {string} [sessionId] - Mcp-Session-Id.
 * @param {object} [extraHeaders] - Additional request headers.
 * @param {number} [timeoutMs] - Total timeout (default 30000).
 * @returns {Promise<Array<{event: string, data: string, id?: string}>>}
 */
function nativeMcpSseCollect(url, method, body, sessionId, extraHeaders, timeoutMs) {
  return binding.nativeMcpSseCollect(
    url,
    method,
    body ?? null,
    sessionId ?? null,
    extraHeaders ?? null,
    timeoutMs ?? null,
  );
}

// ============================================================================
// MCP — Connection registry (Phase 7.4)
// ============================================================================

/** Transport kind enum: `Stdio` | `Http` | `Sse`. */
const NativeMcpTransportKind = binding.NativeMcpTransportKind;
/** Connection status enum: `Connecting` | `Connected` | `Disconnected` | `Failed`. */
const NativeMcpConnectionStatus = binding.NativeMcpConnectionStatus;

const nativeMcpRegistryAdd = binding.nativeMcpRegistryAdd;
const nativeMcpRegistryGet = binding.nativeMcpRegistryGet;
const nativeMcpRegistryGetByName = binding.nativeMcpRegistryGetByName;
const nativeMcpRegistryList = binding.nativeMcpRegistryList;
const nativeMcpRegistryLen = binding.nativeMcpRegistryLen;
const nativeMcpRegistryRemove = binding.nativeMcpRegistryRemove;
const nativeMcpRegistrySetCapabilities = binding.nativeMcpRegistrySetCapabilities;

/**
 * Update a connection's status.
 *
 * @param {number} handle
 * @param {number} status - `NativeMcpConnectionStatus` value.
 * @param {string} [error] - Error detail (for the `Failed` status).
 * @returns {boolean} true if the handle existed.
 */
function nativeMcpRegistrySetStatus(handle, status, error) {
  return binding.nativeMcpRegistrySetStatus(handle, status, error ?? null);
}

// ============================================================================
// OAuth PKCE (Phase 7.3) — S256 verifier/challenge + loopback redirect server
// ============================================================================

/** Loopback callback server handle returned by `pkceStartLoopback`. */
const LoopbackHandle = binding.LoopbackHandle;

const pkceGenerateVerifier = binding.pkceGenerateVerifier;
const pkceDeriveChallenge = binding.pkceDeriveChallenge;
const pkceStartLoopback = binding.pkceStartLoopback;
const pkceAwaitCallback = binding.pkceAwaitCallback;

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
function nativeGoalComputeTokenDelta(
  prevInput,
  prevCached,
  prevOutput,
  currInput,
  currCached,
  currOutput,
) {
  return binding.nativeGoalComputeTokenDelta(
    prevInput,
    prevCached,
    prevOutput,
    currInput,
    currCached,
    currOutput,
  );
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
// Path access
// ============================================================================

/** Normalize a user path (Win32/Cygwin drive conversion). */
function nativePathNormalizeUserPath(path, pathClass) {
  return binding.nativePathNormalizeUserPath(path, pathClass);
}

/** Expand `~` → home directory. */
function nativePathExpandUserPath(path, homeDir, pathClass) {
  return binding.nativePathExpandUserPath(path, homeDir, pathClass);
}

/** Lexical canonicalization (relative → absolute → normalize). Returns "ERROR: ..." on failure. */
function nativePathCanonicalize(path, cwd, pathClass) {
  return binding.nativePathCanonicalize(path, cwd, pathClass);
}

/** Component-boundary prefix check (true if candidate is base or its descendant). */
function nativePathIsWithinDirectory(candidate, base, pathClass) {
  return binding.nativePathIsWithinDirectory(candidate, base, pathClass);
}

/** Multi-root workspace containment check. */
function nativePathIsWithinWorkspace(candidate, roots, pathClass) {
  return binding.nativePathIsWithinWorkspace(candidate, roots, pathClass);
}

/**
 * Glob-aware canonicalization: normalizes prefix before glob, leaves glob suffix.
 * @returns {string} Canonicalized path or 'ERROR: ...'
 */
function nativePathCanonicalizeForGlob(path, cwd, pathClass) {
  return binding.nativePathCanonicalizeForGlob(path, cwd, pathClass);
}

// ============================================================================
// Workspace Index — file metadata index for tool predictions
// ============================================================================

/**
 * Build the workspace index by scanning `root` recursively.
 *
 * This is a blocking operation. For large workspaces, it may take
 * 100ms–2s. Call once at workspace load time.
 *
 * @param {string} root - Absolute path to the workspace root directory.
 * @returns {number} Number of files indexed.
 */
function nativeBuildWorkspaceIndex(root) {
  return binding.nativeBuildWorkspaceIndex(root);
}

/**
 * Get a Read prediction from the workspace index.
 *
 * Returns `null` if:
 *   - No index has been built (call `nativeBuildWorkspaceIndex` first)
 *   - The file is not in the index
 *
 * @param {string} path - Absolute path to the file.
 * @returns {{ lineCount: number, size: number, preview: string, estimatedReadMs: number } | null} Prediction or null.
 */
function nativeWorkspaceIndexPredictRead(path) {
  return binding.nativeWorkspaceIndexPredictRead(path);
}

// ============================================================================
// Permission — DSL pattern parsing
// ============================================================================

/**
 * Parse a permission rule DSL pattern.
 * @param {string} pattern - e.g. "Read(/etc/**)"
 * @returns {string} JSON '{"toolName":"...","argPattern":...}' or 'ERROR: ...'
 */
function nativeParsePermissionPattern(pattern) {
  return binding.nativeParsePermissionPattern(pattern);
}

// ============================================================================
// GoalEngine — decision core (stateless, JSON-in/JSON-out)
// ============================================================================

/**
 * Validate and normalize a goal creation input.
 * @param {string} json - {"objective": string, "completionCriterion?": string}
 * @returns {string} JSON '{ok:true,objective,completionCriterion?}' or '{ok:false,error}'
 */
function nativeGoalEngineValidateCreateInput(json) {
  return binding.nativeGoalEngineValidateCreateInput(json);
}

/**
 * Validate a budget input into a limits patch.
 * @param {string} json - {"value": number, "unit": string}
 * @returns {string} JSON '{ok:true,budgetLimits:{...}}' or '{ok:false,error}'
 */
function nativeGoalEngineValidateBudgetInput(json) {
  return binding.nativeGoalEngineValidateBudgetInput(json);
}

/**
 * Compute the full budget report.
 * @param {string} json - {"goal": GoalStateJSON, "nowMs": number}
 * @returns {string} JSON budget report
 */
function nativeGoalEngineComputeBudgetReport(json) {
  return binding.nativeGoalEngineComputeBudgetReport(json);
}

/**
 * Apply token + turn deltas to a goal.
 * @param {string} json - {"goal": GoalStateJSON, "tokenDelta": number, "turnDelta": number, "nowMs": number}
 * @returns {string} JSON '{goal: GoalStateJSON, overBudget: boolean}'
 */
function nativeGoalEngineApplyUsage(json) {
  return binding.nativeGoalEngineApplyUsage(json);
}

/**
 * Decide whether the goal driver should continue.
 * @param {string} json - {"goal": GoalStateJSON, "nowMs": number}
 * @returns {string} JSON '{action:"continue",steeringPrompt}' | '{action:"stop_budget",reason,steeringPrompt}' | '{action:"stop_inactive"}'
 */
function nativeGoalEngineDecideContinuation(json) {
  return binding.nativeGoalEngineDecideContinuation(json);
}

/**
 * Apply the 3-turn blocked audit.
 * @param {string} json - {"goal": GoalStateJSON}
 * @returns {string} JSON '{action:"record_attempt",streak,attemptsNeeded,message}' | '{action:"mark_blocked",streak}'
 */
function nativeGoalEngineDecideBlockedAudit(json) {
  return binding.nativeGoalEngineDecideBlockedAudit(json);
}

/**
 * Attempt a status transition.
 * @param {string} json - {"goal": GoalStateJSON, "targetStatus": string, "expectedGoalId?": string}
 * @returns {string} JSON '{ok:true,goal:GoalStateJSON}' or '{ok:false,error}'
 */
function nativeGoalEngineDecideStatusTransition(json) {
  return binding.nativeGoalEngineDecideStatusTransition(json);
}

/**
 * Render the full active-goal reminder.
 * @param {string} json - {"goal": GoalStateJSON, "nowMs": number}
 * @returns {string} rendered prompt
 */
function nativeGoalEngineRenderGoalReminder(json) {
  return binding.nativeGoalEngineRenderGoalReminder(json);
}

/**
 * Render a light blocked note.
 * @param {string} json - {"goal": GoalStateJSON}
 * @returns {string} rendered prompt
 */
function nativeGoalEngineRenderBlockedNote(json) {
  return binding.nativeGoalEngineRenderBlockedNote(json);
}

/**
 * Render a light paused note.
 * @param {string} json - {"goal": GoalStateJSON}
 * @returns {string} rendered prompt
 */
function nativeGoalEngineRenderPausedNote(json) {
  return binding.nativeGoalEngineRenderPausedNote(json);
}

// ============================================================================
// Knowledge Base — SQLite + FTS5 local coding standards database
// ============================================================================

/**
 * Open (or create) a knowledge database at the given path.
 * @param {string} dbPath - Path to the SQLite database file.
 */
function knowledgeOpen(dbPath) {
  return binding.knowledgeOpen(dbPath);
}

/**
 * Close and remove a DB connection from the pool. Releases file handles.
 * @param {string|null|undefined} [dbPath] - Path of DB to close. If null/omitted, closes the active DB.
 */
function knowledgeClose(dbPath) {
  return binding.knowledgeClose(dbPath ?? null);
}

/**
 * Add a knowledge entry. Returns JSON string of the created entry.
 * @param {string} title
 * @param {string} category - 'coding-style' | 'pitfall' | 'architecture' | 'workflow'
 * @param {string} content
 * @param {string} tags - Comma-separated tag list.
 * @param {string|null} scope - Optional scope path (e.g., project root).
 * @param {string} source - 'human' | 'ai-learned' | 'ai-confirmed'
 * @param {number} confidence - 0.0 - 1.0
 * @param {string} status - 'pending' | 'confirmed' | 'rejected'
 * @returns {string} JSON string of the created KnowledgeEntry.
 */
function knowledgeAdd(title, category, content, tags, scope, source, confidence, status) {
  return binding.knowledgeAdd(
    title,
    category,
    content,
    tags,
    scope ?? null,
    source,
    confidence,
    status,
  );
}

/**
 * Search the knowledge base. Returns JSON string of KnowledgeSearchResult[].
 * @param {string} query - FTS5 query (use '*' for all).
 * @param {string|null} scopePath - Scope filter (path boundary aware).
 * @param {string|null} tags - Comma-separated tag filter.
 * @param {number} limit - Max results.
 * @param {number} minConfidence - Minimum confidence threshold (0.0-1.0).
 * @returns {string} JSON string of KnowledgeSearchResult[].
 */
function knowledgeSearch(query, scopePath, tags, limit, minConfidence) {
  return binding.knowledgeSearch(query, scopePath ?? null, tags ?? null, limit, minConfidence);
}

/**
 * Hard-remove an entry by id.
 * @param {string} id
 * @returns {boolean}
 */
function knowledgeRemove(id) {
  return binding.knowledgeRemove(id);
}

/**
 * Confirm a pending AI-learned entry. Sets status='confirmed', confidence=1.0, source='ai-confirmed'.
 * @param {string} id
 * @returns {boolean}
 */
function knowledgeConfirm(id) {
  return binding.knowledgeConfirm(id);
}

/**
 * Reject (soft-delete) an entry. Sets status='rejected'.
 * @param {string} id
 * @returns {boolean}
 */
function knowledgeReject(id) {
  return binding.knowledgeReject(id);
}

/**
 * Return database statistics as JSON.
 * @returns {string} JSON string of KnowledgeStats.
 */
function knowledgeStats() {
  return binding.knowledgeStats();
}

/**
 * Bulk-import entries from markdown (--- separated blocks).
 * @param {string} markdown
 * @returns {string} JSON string of import result.
 */
function knowledgeImport(markdown) {
  return binding.knowledgeImport(markdown);
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
  nativeCanSplitAfter,
  nativeSelectCompactionUserMessages,

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
  nativeMcpHttpPost,
  NativeMcpSseMethod,
  nativeMcpSseCollect,
  NativeMcpTransportKind,
  NativeMcpConnectionStatus,
  nativeMcpRegistryAdd,
  nativeMcpRegistrySetStatus,
  nativeMcpRegistrySetCapabilities,
  nativeMcpRegistryRemove,
  nativeMcpRegistryGetByName,
  nativeMcpRegistryGet,
  nativeMcpRegistryList,
  nativeMcpRegistryLen,

  // OAuth PKCE
  pkceGenerateVerifier,
  pkceDeriveChallenge,
  pkceStartLoopback,
  pkceAwaitCallback,
  LoopbackHandle,

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

  // GoalEngine
  nativeGoalEngineValidateCreateInput,
  nativeGoalEngineValidateBudgetInput,
  nativeGoalEngineComputeBudgetReport,
  nativeGoalEngineApplyUsage,
  nativeGoalEngineDecideContinuation,
  nativeGoalEngineDecideBlockedAudit,
  nativeGoalEngineDecideStatusTransition,
  nativeGoalEngineRenderGoalReminder,
  nativeGoalEngineRenderBlockedNote,
  nativeGoalEngineRenderPausedNote,

  // Path access
  nativePathNormalizeUserPath,
  nativePathExpandUserPath,
  nativePathCanonicalize,
  nativePathIsWithinDirectory,
  nativePathIsWithinWorkspace,
  nativePathCanonicalizeForGlob,

  // Workspace Index
  nativeBuildWorkspaceIndex,
  nativeWorkspaceIndexPredictRead,

  // Permission
  nativeParsePermissionPattern,

  // Translation (i18n)
  nativeTranslate,
  nativeTranslateCached,
  nativeTranslateClearCache,
  nativeTranslateBatch,
  nativeTranslateBatchCached,

  // GitHub
  nativeGithubRequest,

  // FetchUrl
  nativeFetchUrl,

  // WebSearch
  nativeWebSearch,

  // LLM Stream
  nativeLlmStream,

  // Knowledge Base
  knowledgeOpen,
  knowledgeClose,
  knowledgeAdd,
  knowledgeSearch,
  knowledgeRemove,
  knowledgeConfirm,
  knowledgeReject,
  knowledgeStats,
  knowledgeImport,
};
