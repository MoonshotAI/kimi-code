/**
 * Regenerate `src/agent/media/webp-dec-wasm.ts` from the installed
 * `@jsquash/webp` package.
 *
 * The WebP decoder wasm is committed as a base64 string module because the
 * published CLI bundles every dependency into a single file with no runtime
 * node_modules — a file-path lookup for the .wasm would break there, while a
 * string constant survives every packaging (vitest on sources, tsdown
 * bundling, nix builds) unchanged. Run this after bumping @jsquash/webp:
 *
 *   node scripts/generate-webp-dec-wasm.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const packageRoot = resolve(import.meta.dirname, '..');
const require = createRequire(resolve(packageRoot, 'package.json'));

const wasmPath = require.resolve('@jsquash/webp/codec/dec/webp_dec.wasm');
const version = require('@jsquash/webp/package.json').version;
const wasm = readFileSync(wasmPath);

const target = resolve(packageRoot, 'src/agent/media/webp-dec-wasm.ts');
writeFileSync(
  target,
  `// GENERATED FILE — do not edit by hand.
// WebP decoder wasm from @jsquash/webp@${version} (codec/dec/webp_dec.wasm),
// base64-encoded so the bundled CLI needs no on-disk wasm asset.
// Regenerate with: node scripts/generate-webp-dec-wasm.mjs

export const WEBP_DECODER_WASM_BASE64 =
  '${wasm.toString('base64')}';
`,
);
console.log(`Wrote ${target} (${wasm.length} bytes of wasm)`);
