import { join } from 'node:path';

import { app } from 'electron';

// The bundled backend targets the same 6 platform/arch pairs the kimi-code
// native SEA build supports (apps/kimi-code/scripts/native/native-deps.mjs).
const SUPPORTED_TARGETS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
]);

/** `<platform>-<arch>` triple for the current process, validated against the SEA targets. */
export function currentTarget(): string {
  const target = `${process.platform}-${process.arch}`;
  if (!SUPPORTED_TARGETS.has(target)) {
    throw new Error(`No bundled Kimi server for this platform: ${target}`);
  }
  return target;
}

function executableName(): string {
  return process.platform === 'win32' ? 'kimi.exe' : 'kimi';
}

/**
 * Absolute path to the bundled SEA backend executable.
 *
 * Resolution order:
 * 1. `KIMI_SEA_PATH` env override (escape hatch for dev / custom layouts).
 * 2. packaged: `<resources>/bin/<target>/kimi[.exe]` (electron-builder extraResources).
 * 3. dev: `<code-app>/kimi-code/apps/kimi-code/dist-native/bin/<target>/kimi[.exe]`.
 *    kimi-code is a submodule at the repo root; in dev `app.getAppPath()` is
 *    `code-app/apps/desktop`, so we walk up two levels to the repo root.
 */
export function resolveSeaPath(): string {
  const override = process.env['KIMI_SEA_PATH'];
  if (override) {
    return override;
  }
  const target = currentTarget();
  const exe = executableName();
  if (app.isPackaged) {
    return join(process.resourcesPath, 'bin', target, exe);
  }
  return join(app.getAppPath(), '..', '..', 'kimi-code', 'apps', 'kimi-code', 'dist-native', 'bin', target, exe);
}
