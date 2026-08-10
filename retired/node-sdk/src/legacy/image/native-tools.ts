/**
 * Native image helpers — the Rust `@moonshot-ai/kimi-native-tools` codec
 * subset used by the image-compression pipeline. Extracted from the retired
 * `agent-core/tools/builtin/native-tools` (image functions only).
 *
 * All functions are OPTIONAL: the native module is lazy-loaded; when it is
 * unavailable or a call fails, callers fall back to the TS implementation
 * (compression degrades to a passthrough, dimension sniffing to a JS
 * fallback).
 */

// Lazy-load the native module to avoid a hard dependency.
// Three-state cache (undefined = not tried, null = tried and failed,
// object = loaded).
let nativeModule: Record<string, unknown> | null | undefined;

function getNativeModule(): Record<string, unknown> | undefined {
  if (nativeModule === null) return undefined;
  if (nativeModule !== undefined) return nativeModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    nativeModule = require('@moonshot-ai/kimi-native-tools');
    return nativeModule ?? undefined;
  } catch {
    nativeModule = null;
    return undefined;
  }
}

async function callNative<T>(fnName: string, ...args: unknown[]): Promise<T | undefined> {
  const mod = getNativeModule();
  if (!mod) return undefined;
  const fn = mod[fnName];
  if (typeof fn !== 'function') return undefined;
  try {
    return await (fn(...args) as T);
  } catch {
    // Native function threw at runtime — return undefined so callers can
    // fall back to the TS implementation.
    return undefined;
  }
}

export interface NativeCompressConfig {
  readonly maxEdge: number;
  readonly byteBudget: number;
  readonly fallbackEdges: readonly number[];
  readonly jpegQualitySteps: readonly number[];
}

export interface NativeCompressResult {
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

export interface NativeCropConfig {
  readonly maxEdge: number;
  readonly byteBudget: number;
  readonly skipResize: boolean;
  readonly fallbackEdges: readonly number[];
  readonly jpegQualitySteps: readonly number[];
}

export interface NativeCropOutcome {
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
 * Try the Rust native image compression codec. Returns undefined when the
 * native module is unavailable, the call fails, or the result is null
 * (unsupported format / passthrough). The caller falls back to its own
 * pipeline.
 */
export async function tryNativeCompressImage(
  data: Uint8Array,
  mimeType: string,
  config: NativeCompressConfig,
): Promise<NativeCompressResult | undefined> {
  const result = await callNative<NativeCompressResult | null>('nativeCompressImage', data, mimeType, {
    maxEdge: config.maxEdge,
    byteBudget: config.byteBudget,
    fallbackEdges: [...config.fallbackEdges],
    jpegQualitySteps: [...config.jpegQualitySteps],
  });
  return result ?? undefined;
}

/**
 * Try the Rust native image crop codec. Returns undefined when the native
 * module is unavailable or the call fails.
 */
export async function tryNativeCropImage(
  data: Uint8Array,
  mimeType: string,
  regionX: number,
  regionY: number,
  regionWidth: number,
  regionHeight: number,
  config: NativeCropConfig,
): Promise<NativeCropOutcome | undefined> {
  return callNative<NativeCropOutcome>('nativeCropImage', data, mimeType, regionX, regionY, regionWidth, regionHeight, {
    maxEdge: config.maxEdge,
    byteBudget: config.byteBudget,
    skipResize: config.skipResize,
    fallbackEdges: [...config.fallbackEdges],
    jpegQualitySteps: [...config.jpegQualitySteps],
  });
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
      return (m as unknown as { nativeSniffImageDimensions(d: Uint8Array): NativeImageDimensions | undefined }).nativeSniffImageDimensions(
        new Uint8Array(data),
      ) ?? undefined;
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
  if (m && (m as unknown as { nativeDetectFileType?: unknown }).nativeDetectFileType) {
    try {
      const r = (m as unknown as {
        nativeDetectFileType(path: string, header: Uint8Array): { kind: string; mimeType?: string; mime_type?: string };
      }).nativeDetectFileType(path, new Uint8Array(header));
      return r ? { kind: r.kind as NativeFileTypeResult['kind'], mimeType: r.mimeType ?? r.mime_type ?? '' } : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
