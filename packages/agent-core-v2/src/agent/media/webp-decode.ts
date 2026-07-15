/**
 * `media` domain (L4) — WebP decoding for the image-compression pipeline.
 *
 * The default jimp build ships no WebP codec, so WebP is decoded with
 * `@jsquash/webp`'s wasm decoder instead. The decoder wasm is compiled from a
 * base64 string committed to the repo (see `webp-dec-wasm.ts`): the published
 * CLI bundles every dependency into a single file with no runtime
 * node_modules, so a file-path or fetch lookup for the .wasm (what the
 * emscripten glue would do on its own) cannot work there — the module is
 * compiled and injected manually via the codec's `init()` hook. Only the
 * decoder is bundled: re-encoding runs through the existing PNG/JPEG ladder,
 * so the (larger) WebP encoder wasm is never needed.
 *
 * The repo's tsconfig carries no DOM lib, so the global `WebAssembly` and
 * `ImageData` names are unavailable at the type level — the wasm namespace is
 * reached through a structurally-typed `globalThis` and the decoder's RGBA
 * output is described by the local {@link DecodedWebp} shape.
 */

/** Decoded RGBA bitmap in the shape `Jimp.fromBitmap` accepts. */
export interface DecodedWebp {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

type WebpDecodeFn = (bytes: Uint8Array) => Promise<DecodedWebp>;

interface WasmGlobal {
  readonly WebAssembly: {
    compile(bytes: Uint8Array): Promise<object>;
  };
}

let decoderReady: Promise<WebpDecodeFn> | null = null;

async function loadDecoder(): Promise<WebpDecodeFn> {
  decoderReady ??= (async () => {
    const [decodeModule, { WEBP_DECODER_WASM_BASE64 }] = await Promise.all([
      import('@jsquash/webp/decode.js'),
      import('./webp-dec-wasm'),
    ]);
    const wasm = await (globalThis as unknown as WasmGlobal).WebAssembly.compile(
      Buffer.from(WEBP_DECODER_WASM_BASE64, 'base64'),
    );
    await decodeModule.init(wasm as never);
    const decode = decodeModule.default;
    return async (bytes: Uint8Array) => {
      const copy = new Uint8Array(bytes);
      return (await decode(copy.buffer)) as unknown as DecodedWebp;
    };
  })();
  return decoderReady;
}

export async function decodeWebp(bytes: Uint8Array): Promise<DecodedWebp> {
  const decode = await loadDecoder();
  return decode(bytes);
}

export function isAnimatedWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 21) return false;
  return (
    hasAscii(bytes, 'RIFF', 0) &&
    hasAscii(bytes, 'WEBP', 8) &&
    hasAscii(bytes, 'VP8X', 12) &&
    (bytes[20]! & 0x02) !== 0
  );
}

function hasAscii(bytes: Uint8Array, text: string, at: number): boolean {
  for (let i = 0; i < text.length; i++) {
    if (bytes[at + i] !== text.codePointAt(i)) return false;
  }
  return true;
}
