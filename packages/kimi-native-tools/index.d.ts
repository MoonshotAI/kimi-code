// Type declarations for @moonshot-ai/kimi-native-tools
//
// This file provides TypeScript types for all native Rust functions exposed
// via napi-rs. The actual implementations are in the platform-specific .node
// files loaded by index.js.

// ============================================================================
// Read tool
// ============================================================================

export interface ReadResult {
  content: string;
  lineCount: number;
  error?: string;
}

export interface ReadOptions {
  lineOffset?: number;
  nLines?: number;
}

export function nativeRead(path: string, options?: ReadOptions): Promise<ReadResult>;

// ============================================================================
// Batch Read
// ============================================================================

export interface BatchReadOptions {
  lineOffsets?: Array<number | null>;
  nLinesArray?: Array<number | null>;
}

export function nativeBatchRead(paths: string[], options?: BatchReadOptions): Promise<ReadResult[]>;

// ============================================================================
// File cache
// ============================================================================

export function nativeFileCacheInvalidate(path: string): void;

// ============================================================================
// Write tool
// ============================================================================

export type WriteMode = 'overwrite' | 'append';

export interface WriteResult {
  bytesWritten: number;
  error?: string;
}

export interface WriteOptions {
  mode?: WriteMode;
}

export function nativeWrite(
  path: string,
  content: string,
  options?: WriteOptions,
): Promise<WriteResult>;

// ============================================================================
// Edit tool
// ============================================================================

export interface EditResult {
  success: boolean;
  error?: string;
  replacements: number;
}

export interface EditOptions {
  replaceAll?: boolean;
}

export function nativeEdit(
  path: string,
  oldString: string,
  newString: string,
  options?: EditOptions,
): EditResult;

// ============================================================================
// Grep tool
// ============================================================================

export type GrepOutputMode = 'content' | 'files_with_matches' | 'count_matches';

export interface GrepResult {
  content: string;
  error?: string;
  matchCount: number;
  fileCount: number;
  filteredSensitive: string[];
  timedOut: boolean;
}

export interface GrepOptions {
  path?: string;
  glob?: string;
  fileType?: string;
  outputMode?: GrepOutputMode;
  caseInsensitive?: boolean;
  lineNumbers?: boolean;
  afterContext?: number;
  beforeContext?: number;
  context?: number;
  headLimit?: number;
  offset?: number;
  multiline?: boolean;
  includeIgnored?: boolean;
  timeoutMs?: number;
}

export function nativeGrep(pattern: string, options?: GrepOptions): GrepResult;

// ============================================================================
// Glob tool
// ============================================================================

export interface GlobResult {
  files: string[];
  error?: string;
  truncated: boolean;
}

export interface GlobOptions {
  path?: string;
  includeDirs?: boolean;
  /** Also match files excluded by .gitignore / .ignore / .rgignore.
   *  Sensitive files (e.g. `.env`) and VCS metadata directories
   *  (e.g. `.git`) remain filtered. Default false. */
  includeIgnored?: boolean;
}

export function nativeGlob(pattern: string, options?: GlobOptions): GlobResult;

export function nativeGlobMatchesAny(globs: string[], path: string): boolean;

// ============================================================================
// List Directory tool
// ============================================================================

export interface ListDirectoryResult {
  output: string;
  error?: string;
}

export interface ListDirectoryOptions {
  path?: string;
  collapseHiddenDirs?: boolean;
}

export function nativeListDirectory(options?: ListDirectoryOptions): ListDirectoryResult;

// ============================================================================
// File Type / Image tools
// ============================================================================

export interface ImageDimensions {
  width: number;
  height: number;
}

/** `Buffer` is accepted, being a `Uint8Array` subclass. */
export function nativeSniffImageDimensions(data: Uint8Array): ImageDimensions | null;

export function nativeIsSensitiveFile(path: string): boolean;

// ============================================================================
// Token estimation
// ============================================================================

export function nativeEstimateTokens(text: string): number;

export function nativeEstimateTokensBatch(texts: string[]): number;

export function nativeTruncateTextToTokens(text: string, maxTokens: number): string;

export function nativeTruncateTextToTokensFromEnd(text: string, maxTokens: number): string;

// ============================================================================
// Bash tool
// ============================================================================

export interface BashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

export interface BashOptions {
  cwd?: string;
  timeout?: number;
  env?: Array<[string, string]>;
}

export function nativeBash(command: string, options?: BashOptions): BashResult;

// ============================================================================
// Compaction
// ============================================================================

export interface CompactionMessageMeta {
  role: string;
  toolCallsCount: number;
  tokens: number;
}

export interface CompactionConfigMeta {
  maxSize: number;
  maxRecentMessages: number;
  maxRecentUserMessages: number;
  maxRecentSizeRatio: number;
  minOverflowReductionRatio: number;
}

export function nativeComputeCompactCount(
  messages: CompactionMessageMeta[],
  config: CompactionConfigMeta,
  isManual: boolean,
): number;

export function nativeReduceCompactOnOverflow(
  messages: CompactionMessageMeta[],
  config: CompactionConfigMeta,
): number;

export function nativeResolveCompactionMaxCompletionTokens(
  maxContextTokens: number,
  maxOutputSize: number | null,
): number | null;

// ============================================================================
// Tool access conflict detection
// ============================================================================

export interface ToolAccessMeta {
  kind: string;
  operation?: string;
  path?: string;
  recursive?: boolean;
}

export function nativeToolAccessesConflict(
  left: ToolAccessMeta[],
  right: ToolAccessMeta[],
): boolean;

// ============================================================================
// Image compression & cropping
// ============================================================================

export interface ImageCompressConfig {
  maxEdge: number;
  byteBudget: number;
  fallbackEdges: number[];
  jpegQualitySteps: number[];
}

export interface ImageCompressResult {
  data: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  changed: boolean;
  originalByteLength: number;
  finalByteLength: number;
}

export function nativeCompressImage(
  data: Uint8Array,
  mimeType: string,
  config: ImageCompressConfig,
): Promise<ImageCompressResult | null>;

export interface ImageCropConfig extends ImageCompressConfig {
  skipResize: boolean;
}

export interface ImageCropResult {
  ok: boolean;
  error: string;
  errorKind: string;
  data: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  regionX: number;
  regionY: number;
  regionWidth: number;
  regionHeight: number;
  resized: boolean;
  originalByteLength: number;
  finalByteLength: number;
}

export function nativeCropImage(
  data: Uint8Array,
  mimeType: string,
  regionX: number,
  regionY: number,
  regionWidth: number,
  regionHeight: number,
  config: ImageCropConfig,
): Promise<ImageCropResult>;

// ============================================================================
// Tool output truncation
// ============================================================================

export interface ToolOutputChunkResult {
  output: string;
  charsWritten: number;
  newNchars: number;
  truncated: boolean;
}

export function nativeWriteToolOutputChunk(
  text: string,
  currentNchars: number,
  maxChars: number,
  maxLineLength: number | null,
  alreadyTruncated: boolean,
): ToolOutputChunkResult;

// ============================================================================
// Structured grep
// ============================================================================

export interface GrepStructuredMatch {
  line: number;
  col: number;
  text: string;
  before: string[];
  after: string[];
}

export interface GrepStructuredFile {
  path: string;
  matches: GrepStructuredMatch[];
}

export interface GrepStructuredResult {
  files: GrepStructuredFile[];
  filesScanned: number;
  truncated: boolean;
  error?: string;
}

export function nativeGrepStructured(
  pattern: string,
  path: string,
  literal: boolean,
  caseInsensitive: boolean,
  includeGlobs: string[],
  excludeGlobs: string[],
  contextLines: number,
  maxFiles: number,
  maxMatchesPerFile: number,
  maxTotalMatches: number,
  timeoutMs: number,
  followGitignore: boolean,
): GrepStructuredResult;

// ============================================================================
// MCP — Config loading
// ============================================================================

export function nativeMcpLoadConfig(
  cwd: string,
  homeDir?: string | null,
): Promise<Record<string, unknown>>;

// ============================================================================
// MCP — Stdio client
// ============================================================================

export interface McpStdioSpawnConfig {
  command: string;
  args?: string[] | null;
  env?: Record<string, string> | null;
  cwd?: string | null;
}

export interface McpStdioSpawnResult {
  handle: number;
  pid: number;
}

export function nativeMcpStdioSpawn(config: McpStdioSpawnConfig): Promise<McpStdioSpawnResult>;

export function nativeMcpStdioInitialize(
  handle: number,
  clientName: string,
  clientVersion: string,
  timeoutMs?: number | null,
): Promise<string>;

export function nativeMcpStdioListTools(handle: number): Promise<Record<string, unknown>[]>;

export function nativeMcpStdioCallTool(
  handle: number,
  name: string,
  argsJson: string,
  timeoutMs?: number | null,
): Promise<string>;

export function nativeMcpStdioClose(handle: number): Promise<void>;

export function nativeMcpStdioStderrSnapshot(handle: number): Promise<string>;

export function nativeMcpStdioIsAlive(handle: number): Promise<boolean>;

// ============================================================================
// MCP — HTTP transport (Streamable HTTP)
// ============================================================================

export interface NativeMcpHttpResult {
  status: number;
  sessionId?: string;
  contentType?: string;
  /** Present when the response body parsed as JSON. Absent/null indicates a
   *  transport-level failure the caller should treat as an error. */
  jsonBody?: unknown;
  rawBody: string;
}

export function nativeMcpHttpPost(
  url: string,
  body: unknown,
  sessionId?: string | null,
  extraHeaders?: Record<string, string> | null,
  timeoutMs?: number | null,
): Promise<NativeMcpHttpResult>;

// ============================================================================
// MCP — SSE transport
// ============================================================================

export const NativeMcpSseMethod: { readonly Get: number; readonly Post: number };
export type NativeMcpSseMethod = number;

export interface NativeMcpSseEvent {
  /** SSE `event:` field (usually `"message"`). */
  event: string;
  /** SSE `data:` field — a JSON-RPC 2.0 payload for MCP. */
  data: string;
  /** Optional SSE `id:` field, for resumability. */
  id?: string;
}

export function nativeMcpSseCollect(
  url: string,
  method: NativeMcpSseMethod,
  body?: unknown,
  sessionId?: string | null,
  extraHeaders?: Record<string, string> | null,
  timeoutMs?: number | null,
): Promise<NativeMcpSseEvent[]>;

// ============================================================================
// MCP — Connection registry
// ============================================================================

export const NativeMcpTransportKind: {
  readonly Stdio: number;
  readonly Http: number;
  readonly Sse: number;
};
export type NativeMcpTransportKind = number;

export const NativeMcpConnectionStatus: {
  readonly Connecting: number;
  readonly Connected: number;
  readonly Disconnected: number;
  readonly Failed: number;
};
export type NativeMcpConnectionStatus = number;

export interface NativeMcpConnectionInfo {
  serverName: string;
  transport: NativeMcpTransportKind;
  status: NativeMcpConnectionStatus;
  handle: number;
  lastError?: string;
  capabilities?: unknown;
}

export interface NativeMcpAddResult {
  handle: number;
  /** Handle of the same-named connection this one replaced, if any. */
  replaced?: number;
}

export function nativeMcpRegistryAdd(
  serverName: string,
  transport: NativeMcpTransportKind,
): NativeMcpAddResult;
export function nativeMcpRegistrySetStatus(
  handle: number,
  status: NativeMcpConnectionStatus,
  error?: string | null,
): boolean;
export function nativeMcpRegistrySetCapabilities(handle: number, capabilities: unknown): boolean;
export function nativeMcpRegistryRemove(handle: number): string | null;
export function nativeMcpRegistryGetByName(serverName: string): NativeMcpConnectionInfo | null;
export function nativeMcpRegistryGet(handle: number): NativeMcpConnectionInfo | null;
export function nativeMcpRegistryList(): NativeMcpConnectionInfo[];
export function nativeMcpRegistryLen(): number;

// ============================================================================
// OAuth PKCE (S256) + loopback redirect server
// ============================================================================

/** Generate a high-entropy PKCE `code_verifier` (RFC 7636). */
export function pkceGenerateVerifier(): string;
/** Derive the S256 `code_challenge` for a given verifier. */
export function pkceDeriveChallenge(verifier: string): string;

/** One-shot loopback callback server bound on `127.0.0.1:0`. */
export class LoopbackHandle {
  readonly port: number;
  readonly redirectUri: string;
}

export function pkceStartLoopback(): Promise<LoopbackHandle>;

export interface CallbackPayload {
  code: string;
  state: string;
  error?: string;
  errorDescription?: string;
}

export function pkceAwaitCallback(handle: LoopbackHandle): Promise<CallbackPayload>;

// ============================================================================
// Constants
// ============================================================================

export const READ_MAX_LINES: number;
export const READ_MAX_LINE_LENGTH: number;
export const READ_MAX_BYTES: number;
export const GLOB_MAX_MATCHES: number;
export const GREP_DEFAULT_HEAD_LIMIT: number;
export const BASH_DEFAULT_TIMEOUT: number;
export const BASH_MAX_TIMEOUT: number;

// ============================================================================
// Goal — state machine, accounting, steering
// ============================================================================

export function nativeGoalValidateObjective(objective: string): string;
export function nativeGoalValidateBudget(value: string): string;
export function nativeGoalApplyUpdate(goalJson: string, updateJson: string): string;
export function nativeGoalComputeTokenDelta(
  prevInput: number,
  prevCached: number,
  prevOutput: number,
  currInput: number,
  currCached: number,
  currOutput: number,
): number;
export function nativeGoalRenderContinuation(
  objective: string,
  tokensUsed: number,
  tokenBudget: number,
): string;
export function nativeGoalRenderBudgetLimit(
  objective: string,
  tokensUsed: number,
  tokenBudget: number,
  timeUsedSeconds: number,
): string;
export function nativeGoalRenderObjectiveUpdated(
  objective: string,
  tokensUsed: number,
  tokenBudget: number,
): string;

// ============================================================================
// i18n Translation engine
// ============================================================================

/**
 * Resolve a dot-separated translation key against locale JSON, with
 * `{{param}}` interpolation.
 *
 * Resolution order:
 * 1. Try `localeJson` (current language).
 * 2. Try `fallbackJson` (defaults to English).
 * 3. Return the `key` itself as last resort.
 */
export function nativeTranslate(
  localeJson: string,
  fallbackJson: string,
  key: string,
  params?: Record<string, string> | null,
): string;

/** Result of a single translation in a batch call. */
export interface NativeBatchTranslateResult {
  /** The translation key that was resolved. */
  key: string;
  /** The resolved and interpolated message. */
  message: string;
}

/**
 * Batch translation — resolves multiple keys against the same locale data
 * in a single call, parsing the JSON only once.
 */
export function nativeTranslateBatch(
  localeJson: string,
  fallbackJson: string,
  keys: string[],
  params?: Record<string, string> | null,
): NativeBatchTranslateResult[];

/**
 * Cached translation — uses a process-wide cached translator that caches
 * parsed JSON across calls. After the first call with a given locale pair,
 * subsequent calls skip JSON parsing entirely.
 *
 * Identical semantics to `nativeTranslate` but much faster for repeated calls
 * with the same locale data. Use in long-running processes (TUI, servers).
 */
export function nativeTranslateCached(
  localeJson: string,
  fallbackJson: string,
  key: string,
  params?: Record<string, string> | null,
): string;

/**
 * Clear the parsed-JSON cache of the global cached translator.
 *
 * Call this when locale data has been reloaded so stale parsed JSON is evicted.
 */
export function nativeTranslateClearCache(): void;

/**
 * Cached batch translation — resolves multiple keys using the process-wide
 * cached translator. After the first call with a given locale pair, subsequent
 * batch calls skip JSON parsing entirely.
 */
export function nativeTranslateBatchCached(
  localeJson: string,
  fallbackJson: string,
  keys: string[],
  params?: Record<string, string> | null,
): NativeBatchTranslateResult[];
