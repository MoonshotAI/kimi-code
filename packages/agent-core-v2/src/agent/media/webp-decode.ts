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
