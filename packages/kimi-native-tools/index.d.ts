/// Type declarations for @moonshot-ai/kimi-native-tools.
///
/// Hand-written (the napi-generated.d.ts is empty even after a successful
/// build). This file is the authoritative source of types for the package.

// ── Read ───────────────────────────────────────────────────────────────────

export interface ReadResult {
  readonly content: string;
  readonly lineCount: number;
  readonly error?: string;
}

export function nativeRead(
  path: string,
  options?: { readonly lineOffset?: number; readonly nLines?: number },
): ReadResult;

// ── Write ──────────────────────────────────────────────────────────────────

export interface WriteResult {
  readonly bytesWritten: number;
  readonly error?: string;
}

export function nativeWrite(
  path: string,
  content: string,
  options?: { readonly mode?: 'overwrite' | 'append' },
): WriteResult;

// ── Edit ───────────────────────────────────────────────────────────────────

export interface EditResult {
  readonly success: boolean;
  readonly error?: string;
  readonly replacements: number;
}

export function nativeEdit(
  path: string,
  oldString: string,
  newString: string,
  options?: { readonly replaceAll?: boolean },
): EditResult;

// ── Grep ───────────────────────────────────────────────────────────────────

export interface GrepResult {
  readonly content: string;
  readonly error?: string;
  readonly matchCount: number;
  readonly fileCount: number;
  readonly filteredSensitive: string[];
  readonly timedOut: boolean;
}

export function nativeGrep(
  pattern: string,
  options?: {
    readonly path?: string;
    readonly glob?: string;
    readonly fileType?: string;
    readonly outputMode?: 'content' | 'files_with_matches' | 'count_matches';
    readonly caseInsensitive?: boolean;
    readonly lineNumbers?: boolean;
    readonly afterContext?: number;
    readonly beforeContext?: number;
    readonly context?: number;
    readonly headLimit?: number;
    readonly offset?: number;
    readonly multiline?: boolean;
    readonly includeIgnored?: boolean;
    readonly timeoutMs?: number;
  },
): Promise<GrepResult>;

// ── Glob ───────────────────────────────────────────────────────────────────

export interface GlobResult {
  readonly files: string[];
  readonly error?: string;
  readonly truncated: boolean;
}

export function nativeGlob(
  pattern: string,
  options?: { readonly path?: string; readonly includeDirs?: boolean },
): GlobResult;

export function nativeGlobMatchesAny(globs: string[], path: string): boolean;

// ── List Directory ─────────────────────────────────────────────────────────

export interface ListDirectoryResult {
  readonly output: string;
  readonly error?: string;
}

export function nativeListDirectory(
  options?: { readonly path?: string; readonly collapseHiddenDirs?: boolean },
): ListDirectoryResult;

// ── File Type ──────────────────────────────────────────────────────────────

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

export function nativeSniffImageDimensions(data: Uint8Array): ImageDimensions | null;
export function nativeIsSensitiveFile(path: string): boolean;

// ── Token estimation ───────────────────────────────────────────────────────

export function nativeEstimateTokens(text: string): number;
export function nativeEstimateTokensBatch(texts: string[]): number;
export function nativeTruncateTextToTokens(text: string, maxTokens: number): string;
export function nativeTruncateTextToTokensFromEnd(text: string, maxTokens: number): string;

// ── Bash ───────────────────────────────────────────────────────────────────

export interface BashResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly error?: string;
}

export function nativeBash(
  command: string,
  options?: {
    readonly cwd?: string;
    readonly timeout?: number;
    readonly env?: ReadonlyArray<readonly [string, string]>;
  },
): Promise<BashResult>;

// ── Compaction ─────────────────────────────────────────────────────────────

export interface CompactionMessageMeta {
  readonly role: string;
  readonly toolCallsCount: number;
  readonly tokens: number;
}

export interface CompactionConfigMeta {
  readonly maxSize: number;
  readonly maxRecentMessages: number;
  readonly maxRecentUserMessages: number;
  readonly maxRecentSizeRatio: number;
  readonly minOverflowReductionRatio: number;
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

// ── Tool access conflict ───────────────────────────────────────────────────

export interface ToolAccessMeta {
  readonly kind: string;
  readonly operation?: string;
  readonly path?: string;
  readonly recursive?: boolean;
}

export function nativeToolAccessesConflict(
  left: ToolAccessMeta[],
  right: ToolAccessMeta[],
): boolean;

// ── Image compression & cropping ───────────────────────────────────────────

export interface NativeCompressImageConfig {
  readonly maxEdge: number;
  readonly byteBudget: number;
  readonly fallbackEdges: number[];
  readonly jpegQualitySteps: number[];
}

export interface NativeCompressImageResult {
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly changed: boolean;
  readonly originalByteLength: number;
  readonly finalByteLength: number;
}

export function nativeCompressImage(
  data: Uint8Array,
  mimeType: string,
  config: NativeCompressImageConfig,
): Promise<NativeCompressImageResult | null>;

export interface NativeCropImageConfig {
  readonly maxEdge: number;
  readonly byteBudget: number;
  readonly skipResize: boolean;
  readonly fallbackEdges: number[];
  readonly jpegQualitySteps: number[];
}

export interface NativeCropImageOutcome {
  readonly ok: boolean;
  readonly error: string;
  readonly errorKind: string;
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly regionX: number;
  readonly regionY: number;
  readonly regionWidth: number;
  readonly regionHeight: number;
  readonly resized: boolean;
  readonly originalByteLength: number;
  readonly finalByteLength: number;
}

export function nativeCropImage(
  data: Uint8Array,
  mimeType: string,
  regionX: number,
  regionY: number,
  regionWidth: number,
  regionHeight: number,
  config: NativeCropImageConfig,
): Promise<NativeCropImageOutcome>;

// ── Structured grep ────────────────────────────────────────────────────────

export interface GrepStructuredMatch {
  readonly line: number;
  readonly col: number;
  readonly text: string;
  readonly before: string[];
  readonly after: string[];
}

export interface GrepStructuredFile {
  readonly path: string;
  readonly matches: GrepStructuredMatch[];
}

export interface GrepStructuredResult {
  readonly files: GrepStructuredFile[];
  readonly filesScanned: number;
  readonly truncated: boolean;
  readonly error?: string;
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
): Promise<GrepStructuredResult>;

// ── Constants ──────────────────────────────────────────────────────────────

export const READ_MAX_LINES: number;
export const READ_MAX_LINE_LENGTH: number;
export const READ_MAX_BYTES: number;
export const GLOB_MAX_MATCHES: number;
export const GREP_DEFAULT_HEAD_LIMIT: number;
export const BASH_DEFAULT_TIMEOUT: number;
export const BASH_MAX_TIMEOUT: number;
