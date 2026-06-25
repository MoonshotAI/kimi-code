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
  const releasePath = path.join(__dirname, 'target', 'release', `${BINDING_NAME}.${ext}`);
  try {
    if (fs.existsSync(releasePath)) {
      return require(releasePath);
    }
  } catch {
    // Fall through.
  }

  // Try from debug build directory.
  const debugPath = path.join(__dirname, 'target', 'debug', `${BINDING_NAME}.${ext}`);
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
 * @returns {{ content: string, lineCount: number, error?: string }}
 */
function nativeRead(path, options = {}) {
  return binding.nativeRead(
    path,
    options.lineOffset ?? null,
    options.nLines ?? null,
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
 * @returns {{ bytesWritten: number, error?: string }}
 */
function nativeWrite(path, content, options = {}) {
  return binding.nativeWrite(
    path,
    content,
    options.mode ?? null,
  );
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
// Exports
// ============================================================================

module.exports = {
  // Tools
  nativeRead,
  nativeWrite,
  nativeEdit,
  nativeGrep,
  nativeGlob,
  nativeListDirectory,
  nativeSniffImageDimensions,
  nativeBash,

  // Constants
  READ_MAX_LINES,
  READ_MAX_LINE_LENGTH,
  READ_MAX_BYTES,
  GLOB_MAX_MATCHES,
  GREP_DEFAULT_HEAD_LIMIT,
  BASH_DEFAULT_TIMEOUT,
  BASH_MAX_TIMEOUT,
};
