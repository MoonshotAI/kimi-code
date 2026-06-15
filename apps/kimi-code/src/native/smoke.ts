import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { resolveExecutableFileRelatives } from '../../scripts/native/native-deps.mjs';
import { getEmbeddedNativeAssetManifest, getNativePackageRoot } from './native-assets';

const smokePackages = ['@mariozechner/clipboard'];

export function runNativeAssetSmokeIfRequested(): boolean {
  if (process.env['KIMI_CODE_NATIVE_ASSET_SMOKE'] !== '1') return false;

  try {
    const manifest = getEmbeddedNativeAssetManifest();
    if (manifest === null) {
      throw new Error('Native asset manifest is not available.');
    }
    for (const packageName of smokePackages) {
      const packageRoot = getNativePackageRoot(packageName, { manifest });
      if (packageRoot === null) {
        throw new Error(`Native package is not available: ${packageName}`);
      }
    }
    const executableNativeFiles = resolveExecutableFileRelatives(
      manifest.target,
    ) as readonly string[];
    for (const file of executableNativeFiles) {
      const path = join(dirname(process.execPath), file);
      if (!existsSync(path)) {
        throw new Error(`Native executable helper is not available: ${file}`);
      }
    }
    process.stdout.write(`Native asset smoke passed: ${manifest.target}\n`);
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Native asset smoke failed: ${message}\n`);
    process.exit(1);
  }
}
