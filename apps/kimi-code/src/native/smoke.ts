import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { getEmbeddedNativeAssetManifest, getNativePackageRoot } from './native-assets';
import { loadNativePackage } from './native-require';

const smokePackages = ['@mariozechner/clipboard', '@moonshot-ai/pi-tui', 'fs-ext-extra-prebuilt'];

// Verify pi-tui's native helper can actually be loaded through the module hook.
// pi-tui computes native helper paths from process.execPath and require()s them;
// those paths do not exist next to the SEA binary, so this only succeeds when
// installNativeModuleHook() redirects the require into the native-asset cache.
function smokePiTuiNativeLoad(): void {
  const platform = process.platform;
  const arch = process.arch;
  let rel: string | undefined;
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) {
    rel = join('native', 'darwin', 'prebuilds', `darwin-${arch}`, 'darwin-modifiers.node');
  } else if (platform === 'win32' && (arch === 'x64' || arch === 'arm64')) {
    rel = join('native', 'win32', 'prebuilds', `win32-${arch}`, 'win32-console-mode.node');
  }
  if (rel === undefined) return; // Linux: no native helper, nothing to load.

  const req = createRequire(import.meta.url);
  const bogusPath = join(dirname(process.execPath), rel);
  const helper = req(bogusPath) as {
    isModifierPressed?: unknown;
    enableVirtualTerminalInput?: unknown;
  };
  const ok =
    typeof helper.isModifierPressed === 'function' ||
    typeof helper.enableVirtualTerminalInput === 'function';
  if (!ok) {
    throw new Error(`pi-tui native helper loaded but exports are unexpected: ${rel}`);
  }
}

function smokeKernelFileLockNativeLoad(): void {
  const binding = loadNativePackage<{ flockSync?: unknown }>('fs-ext-extra-prebuilt');
  if (binding === null || typeof binding.flockSync !== 'function') {
    throw new Error('fs-ext-extra-prebuilt loaded but flockSync is unavailable.');
  }
}

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
    smokePiTuiNativeLoad();
    smokeKernelFileLockNativeLoad();
    process.stdout.write(`Native asset smoke passed: ${manifest.target}\n`);
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Native asset smoke failed: ${message}\n`);
    process.exit(1);
  }
}
