/**
 * Lazy-loaded bindings to the Rust native tools (`@moonshot-ai/kimi-native-tools`).
 *
 * This mirrors the pattern in `@moonshot-ai/agent-core`
 * (`tools/builtin/native-tools.ts`) but is adapted for this package's ESM
 * context: instead of a top-level `require`, we derive a CommonJS `require`
 * via `module.createRequire` so the native module can be loaded
 * synchronously — the leaf helpers below (escape / tokens / name sanitize)
 * are intentionally synchronous to keep their call sites unchanged.
 *
 * Everything here is best-effort. If the native module is not built, fails to
 * load, or a native call throws, every wrapper returns `undefined` and the
 * caller's TypeScript fallback runs. No feature flag is required: an
 * absent or broken module simply degrades to the TS implementation.
 *
 * When the module IS built, napi-rs exposes the Rust `snake_case` functions
 * as `camelCase` JS identifiers (e.g. `native_escape_xml` → `nativeEscapeXml`).
 */
import { createRequire } from 'node:module';

const requireNative = createRequire(import.meta.url);

// Three-state cache: undefined = not tried, null = tried & failed, object = loaded.
let nativeModule: Record<string, unknown> | null | undefined;

function getNativeModule(): Record<string, unknown> | undefined {
  if (nativeModule === null) return undefined;
  if (nativeModule !== undefined) return nativeModule;
  try {
    nativeModule = requireNative('@moonshot-ai/kimi-native-tools') as Record<string, unknown>;
    return nativeModule ?? undefined;
  } catch {
    nativeModule = null;
    return undefined;
  }
}

function getNativeFn(name: string): ((...args: unknown[]) => unknown) | undefined {
  const mod = getNativeModule();
  if (!mod) return undefined;
  const fn = mod[name];
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown) : undefined;
}

/** Call a synchronous native function; returns `undefined` on any failure. */
function callNativeSync<T>(name: string, ...args: unknown[]): T | undefined {
  const fn = getNativeFn(name);
  if (fn === undefined) return undefined;
  try {
    const result = fn(...args);
    return (result as T) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Call an async native function (returns a Promise); `undefined` on failure. */
async function callNativeAsync<T>(name: string, ...args: unknown[]): Promise<T | undefined> {
  const fn = getNativeFn(name);
  if (fn === undefined) return undefined;
  try {
    const result = await (fn(...args) as Promise<T> | T);
    return result ?? undefined;
  } catch {
    return undefined;
  }
}

// ── XML / HTML escaping ─────────────────────────────────────────────
export function tryNativeEscapeXml(input: string): string | undefined {
  return callNativeSync<string>('nativeEscapeXml', input);
}
export function tryNativeEscapeXmlAttr(input: string): string | undefined {
  return callNativeSync<string>('nativeEscapeXmlAttr', input);
}
export function tryNativeEscapeXmlTags(input: string): string | undefined {
  return callNativeSync<string>('nativeEscapeXmlTags', input);
}

// ── Token estimation / truncation ───────────────────────────────────
export function tryNativeEstimateTokens(text: string): number | undefined {
  return callNativeSync<number>('nativeEstimateTokens', text);
}
export function tryNativeEstimateTokensBatch(texts: readonly string[]): number | undefined {
  return callNativeSync<number>('nativeEstimateTokensBatch', [...texts]);
}
export function tryNativeTruncateTextToTokens(text: string, maxTokens: number): string | undefined {
  return callNativeSync<string>('nativeTruncateTextToTokens', text, maxTokens);
}

// ── MCP tool-name sanitization ──────────────────────────────────────
export function tryNativeSanitizeMcpNamePart(part: string): string | undefined {
  return callNativeSync<string>('nativeSanitizeMcpNamePart', part);
}
export function tryNativeQualifyMcpToolName(
  serverName: string,
  toolName: string,
): string | undefined {
  return callNativeSync<string>('nativeQualifyMcpToolName', serverName, toolName);
}

// ── Image compression (async; available, NOT wired) ─────────────────
// The Rust codec in `kimi-native-tools` (`image_compress.rs`) now applies EXIF
// orientation on decode (see `decode_with_orientation`), so its reported
// dimensions and crop regions live in the same display (EXIF-rotated) space as
// jimp. However it is intentionally NOT wired into `image-compress.ts`: the
// `image` crate's JPEG encoder emits different bytes than jimp's mozjpeg, and it
// does not mirror jimp's PNG-ladder / alpha-drop-as-last-resort strategy, so
// swapping encoders would change the actual quality/bytes sent to the model.
// These wrappers are kept available for callers that do not need jimp parity.
// See rust-migration-analysis.md §6.5.
export interface NativeCompressImageConfig {
  readonly maxEdge: number;
  readonly byteBudget: number;
  readonly fallbackEdges: readonly number[];
  readonly jpegQualitySteps: readonly number[];
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

/**
 * Try the Rust native image compression codec. Returns `undefined` when the
 * native module is unavailable, the call fails, or the result is `null`
 * (unsupported format / passthrough). The caller falls back to the jimp
 * pipeline.
 */
export async function tryNativeCompressImage(
  data: Uint8Array,
  mimeType: string,
  config: NativeCompressImageConfig,
): Promise<NativeCompressImageResult | undefined> {
  const result = await callNativeAsync<NativeCompressImageResult | null>(
    'nativeCompressImage',
    data,
    mimeType,
    {
      maxEdge: config.maxEdge,
      byteBudget: config.byteBudget,
      fallbackEdges: [...config.fallbackEdges],
      jpegQualitySteps: [...config.jpegQualitySteps],
    },
  );
  return result ?? undefined;
}

// ── Glob matching (sync; reused by sessionFs fsSearch) ────────────
/**
 * Try the Rust native glob-set matcher. Returns `undefined` when the native
 * module is unavailable or the call fails, so the caller's `globToRegExp`
 * fallback runs. Case-sensitive, matching the TS `matchesAnyGlob` fallback
 * (no `i` flag).
 */
export function tryNativeGlobMatchesAny(
  globs: readonly string[],
  path: string,
): boolean | undefined {
  return callNativeSync<boolean>('nativeGlobMatchesAny', [...globs], path);
}

// ── Compaction (sync; wired into strategy.ts) ───────────────────────
// The Rust `compaction.rs` is a line-for-line port of the TS
// `DefaultCompactionStrategy.computeCompactCount` /
// `reduceCompactOnOverflow`. Both sides use the same token estimator
// (`nativeEstimateTokens`, wired above), and the split-safety guards
// (`canSplitAfter` / `prefixEndsWithOpenToolExchange`) are identical.
//
// napi-rs serialises Rust struct fields as camelCase (e.g.
// `tool_calls_count` → `toolCallsCount`, `max_size` → `maxSize`).

/** Lightweight projection of a Message for the compaction algorithm. */
export interface NativeCompactionMessageMeta {
  readonly role: string;
  /** napi-rs: `tool_calls_count` → camelCase */
  readonly toolCallsCount: number;
  readonly tokens: number;
}

/** Knobs for the compaction algorithm (mirrors CompactionConfig). */
export interface NativeCompactionConfigMeta {
  /** napi-rs: `max_size` → camelCase */
  readonly maxSize: number;
  /** napi-rs: `max_recent_messages` → camelCase */
  readonly maxRecentMessages: number;
  /** napi-rs: `max_recent_user_messages` → camelCase */
  readonly maxRecentUserMessages: number;
  /** napi-rs: `max_recent_size_ratio` */
  readonly maxRecentSizeRatio: number;
  /** napi-rs: `min_overflow_reduction_ratio` */
  readonly minOverflowReductionRatio: number;
}

/**
 * Try the Rust native compaction count. Returns `undefined` when the
 * native module is unavailable or the call fails; the caller falls back
 * to the TS implementation.
 *
 * Returns N where `messages[0..N]` is compacted and `messages[N..]` is
 * preserved. 0 means no compaction possible (no valid split point).
 */
export function tryNativeComputeCompactCount(
  messages: readonly NativeCompactionMessageMeta[],
  config: NativeCompactionConfigMeta,
  isManual: boolean,
): number | undefined {
  return callNativeSync<number>('nativeComputeCompactCount', [...messages], config, isManual);
}

/**
 * Try the Rust native overflow reduction. Returns `undefined` when the
 * native module is unavailable or the call fails; the caller falls back
 * to the TS implementation.
 *
 * Returns a split index — the number of messages to keep in the tail
 * after reducing the compacted prefix.
 */
export function tryNativeReduceCompactOnOverflow(
  messages: readonly NativeCompactionMessageMeta[],
  config: NativeCompactionConfigMeta,
): number | undefined {
  return callNativeSync<number>('nativeReduceCompactOnOverflow', [...messages], config);
}

// ── Image cropping (async; reused by image-compress.ts) ─────────────
export interface NativeCropImageConfig {
  readonly maxEdge: number;
  readonly byteBudget: number;
  readonly skipResize: boolean;
  readonly fallbackEdges: readonly number[];
  readonly jpegQualitySteps: readonly number[];
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

/**
 * Try the Rust native image-crop codec. Returns `undefined` when the native
 * module is unavailable or the call fails; the caller falls back to the jimp
 * pipeline. When present, napi-rs exposes the Rust struct fields as
 * `camelCase` (e.g. `region_x` → `regionX`).
 */
export async function tryNativeCropImage(
  data: Uint8Array,
  mimeType: string,
  region: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  config: NativeCropImageConfig,
): Promise<NativeCropImageOutcome | undefined> {
  const result = await callNativeAsync<NativeCropImageOutcome | null>(
    'nativeCropImage',
    data,
    mimeType,
    region.x,
    region.y,
    region.width,
    region.height,
    {
      maxEdge: config.maxEdge,
      byteBudget: config.byteBudget,
      skipResize: config.skipResize,
      fallbackEdges: [...config.fallbackEdges],
      jpegQualitySteps: [...config.jpegQualitySteps],
    },
  );
  return result ?? undefined;
}

export interface NativeImageDimensions {
  readonly width: number;
  readonly height: number;
  readonly transposed: boolean;
}

export function tryNativeSniffImageDimensions(data: Uint8Array): NativeImageDimensions | undefined {
  const m = getNativeModule();
  if (m) {
    try {
      return (m as any).nativeSniffImageDimensions(new Uint8Array(data)) ?? undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface NativeFileTypeResult {
  readonly kind: 'text' | 'image' | 'video' | 'unknown';
  readonly mimeType: string;
}

export function tryNativeDetectFileType(path: string, header: Uint8Array): NativeFileTypeResult | undefined {
  const m = getNativeModule();
  if (m && (m as any).nativeDetectFileType) {
    try {
      const r = (m as any).nativeDetectFileType(path, new Uint8Array(header));
      return r ? { kind: r.kind, mimeType: r.mimeType ?? r.mime_type } : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// ============================================================================
// Goal — state machine, accounting, steering
// ============================================================================

/** Validate a goal objective. Returns error message on failure, or empty string on success. */
export function tryNativeGoalValidateObjective(objective: string): string | undefined {
  return callNativeSync<string>('nativeGoalValidateObjective', objective);
}

/** Apply a goal state update. Returns updated goal object or error. */
export function tryNativeGoalApplyUpdate(
  goalJson: string,
  updateJson: string,
): { ok: boolean; goal?: Record<string, unknown>; error?: string } | undefined {
  return callNativeSync('nativeGoalApplyUpdate', goalJson, updateJson);
}

/** Compute the chargeable token delta between two usage snapshots. */
export function tryNativeGoalComputeTokenDelta(
  prevInput: number, prevCached: number, prevOutput: number,
  currInput: number, currCached: number, currOutput: number,
): number | undefined {
  return callNativeSync<number>('nativeGoalComputeTokenDelta', prevInput, prevCached, prevOutput, currInput, currCached, currOutput);
}

/** Render the continuation steering prompt. */
export function tryNativeGoalRenderContinuation(
  objective: string, tokensUsed: number, tokenBudget: number | null,
): string | undefined {
  return callNativeSync<string>('nativeGoalRenderContinuation', objective, tokensUsed, tokenBudget);
}

/** Render the budget-limit wrap-up prompt. */
export function tryNativeGoalRenderBudgetLimit(
  objective: string, tokensUsed: number, tokenBudget: number | null, timeUsedSeconds: number,
): string | undefined {
  return callNativeSync<string>('nativeGoalRenderBudgetLimit', objective, tokensUsed, tokenBudget, timeUsedSeconds);
}

/** Render the objective-updated prompt. */
export function tryNativeGoalRenderObjectiveUpdated(
  objective: string, tokensUsed: number, tokenBudget: number | null,
): string | undefined {
  return callNativeSync<string>('nativeGoalRenderObjectiveUpdated', objective, tokensUsed, tokenBudget);
}
