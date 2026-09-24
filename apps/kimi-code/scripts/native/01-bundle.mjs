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
  // Generate the embedded `kimi vis` web asset before bundling. The native
  // tsdown run here never goes through the npm `prebuild` lifecycle, so the
  // generated module must be produced explicitly first or the bundle would
  // miss it (npm builds get it via the `prebuild` script).
  await run(process.execPath, [buildVisAssetPath]);
  await run(process.execPath, [tsdownCliPath, '--config', 'tsdown.native.config.ts']);
  // Bundle the off-main-thread workers (the minidb text-build worker and
  // the kap-server global-search worker) into self-contained ESM files so
  // they can ride the SEA blob as assets (02-sea-blob.mjs) and be spawned
  // from disk at runtime — bundled binaries otherwise lack the worker
  // entries and heavy index work degrades to inline main-thread cores.
  // Runs after the main bundle with clean:false so all verified files remain.
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
