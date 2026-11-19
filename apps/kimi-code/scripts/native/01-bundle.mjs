import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { run } from './exec.mjs';
import { nativeIntermediatesDir, nativeJsBundlePath } from './paths.mjs';

const requireFromScript = createRequire(import.meta.url);
const tsdownCliPath = requireFromScript.resolve('tsdown/run');
const checkBundlePath = resolve(import.meta.dirname, 'check-bundle.mjs');
const asciiBundlePath = resolve(import.meta.dirname, '..', 'ascii-bundle.mjs');
const buildVisAssetPath = resolve(import.meta.dirname, '..', 'build-vis-asset.mjs');

export async function runBundleStep() {
  await run(process.execPath, [buildVisAssetPath]);
  await run(process.execPath, [tsdownCliPath, '--config', 'tsdown.native.config.ts']);
  await run(process.execPath, [tsdownCliPath, '--config', 'tsdown.worker.config.ts']);
  // Escape the few non-ASCII characters so V8 can keep each bundle's source
  // as a one-byte string (half the resident memory of the two-byte form the
  // SEA otherwise pays for the whole 17 MB main bundle). check-bundle.mjs
  // enforces the result.
  await run(process.execPath, [
    asciiBundlePath,
    nativeJsBundlePath(),
    resolve(nativeIntermediatesDir(), 'text-build-worker.mjs'),
    resolve(nativeIntermediatesDir(), 'search-worker.mjs'),
  ]);
  await run(process.execPath, [checkBundlePath]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runBundleStep();
}
