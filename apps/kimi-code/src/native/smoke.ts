import { getEmbeddedNativeAssetManifest, getNativePackageRoot } from './native-assets';

const smokePackages = ['@mariozechner/clipboard', 'koffi', '@napi-rs/keyring'];

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
    process.stdout.write(`Native asset smoke passed: ${manifest.target}\n`);
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Native asset smoke failed: ${message}\n`);
    process.exit(1);
  }
}
