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

// ── Image compression (NOT yet wired — see note) ───────────────────
// These wrappers exist and are correct, but `image-compress.ts` deliberately
// keeps the jimp pipeline as primary. The Rust codec in `kimi-native-tools`
// (`image_compress.rs`) does NOT apply EXIF orientation, whereas jimp does —
// so native reports raw (unrotated) dimensions and would crop in the wrong
// coordinate space for EXIF images. Wire these in only after the crate gains
// orientation handling (or after the caller pre-rotates). Keeping the wrappers
// ready makes that a one-line change.
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
