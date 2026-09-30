import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

export interface DecodedWebp {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

type WebpDecode = (bytes: Uint8Array) => Promise<DecodedWebp>;

interface WasmGlobal {
  readonly WebAssembly: {
    compile(bytes: Uint8Array): Promise<object>;
  };
}

let decoderReady: Promise<WebpDecode> | undefined;

function loadDecoder(): Promise<WebpDecode> {
  decoderReady ??= (async () => {
    const decodeModule = await import('@jsquash/webp/decode.js');
    const wasmPath = createRequire(import.meta.url).resolve('@jsquash/webp/codec/dec/webp_dec.wasm');
    const wasm = await (globalThis as unknown as WasmGlobal).WebAssembly.compile(await readFile(wasmPath));
    await decodeModule.init(wasm as never);
    return async (bytes) => {
      const copy = new Uint8Array(bytes);
      return (await decodeModule.default(copy.buffer)) as unknown as DecodedWebp;
    };
  })();
  return decoderReady;
}

export async function decodeWebp(bytes: Uint8Array): Promise<DecodedWebp> {
  return (await loadDecoder())(bytes);
}

function hasAscii(bytes: Uint8Array, text: string, at: number): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[at + i] !== text.codePointAt(i)) return false;
  }
  return true;
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
