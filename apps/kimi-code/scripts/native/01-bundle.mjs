import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { run } from './exec.mjs';

const requireFromScript = createRequire(import.meta.url);
const tsdownCliPath = requireFromScript.resolve('tsdown/run');
const checkBundlePath = resolve(import.meta.dirname, 'check-bundle.mjs');
const buildVisAssetPath = resolve(import.meta.dirname, '..', 'build-vis-asset.mjs');

export async function runBundleStep() {
  // Generate the embedded `kimi vis` web asset before bundling. The native
  // tsdown run here never goes through the npm `prebuild` lifecycle, so the
  // generated module must be produced explicitly first or the bundle would
  // miss it (npm builds get it via the `prebuild` script).
  await run(process.execPath, [buildVisAssetPath]);
  await run(process.execPath, [tsdownCliPath, '--config', 'tsdown.native.config.ts']);
  await run(process.execPath, [checkBundlePath]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runBundleStep();
}
