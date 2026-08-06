/**
 * Electron runtime management for the pet overlay.
 *
 * Electron is deliberately NOT an npm dependency of the CLI — a ~100 MB
 * per-platform binary should not be paid by users who never run `kimi pet`.
 * It is downloaded lazily on first use into `<dataDir>/pet/electron/` and
 * reused afterwards.
 */

import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { getPetDir } from './dirs';

/** Pinned Electron build used to run the pet overlay. */
export const PET_ELECTRON_VERSION = '33.2.0';

function electronBinaryRelativePath(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'darwin':
      return join('Electron.app', 'Contents', 'MacOS', 'Electron');
    case 'win32':
      return 'electron.exe';
    default:
      return 'electron';
  }
}

export function electronBinaryPath(
  cacheRoot: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return join(
    electronPackageDir(cacheRoot, platform, arch),
    electronBinaryRelativePath(platform),
  );
}

function electronPackageDir(cacheRoot: string, platform: NodeJS.Platform, arch: string): string {
  return join(cacheRoot, `electron-v${PET_ELECTRON_VERSION}-${platform}-${arch}`);
}

/**
 * Ensure the Electron binary is available, downloading and extracting it on
 * first use. Returns the path to the executable. Honors the standard
 * `ELECTRON_MIRROR` env var for users behind a mirror.
 */
export async function ensureElectronBinary(
  cacheRoot: string = join(getPetDir(), 'electron'),
): Promise<string> {
  const binary = electronBinaryPath(cacheRoot);
  if (existsSync(binary)) return binary;

  const { downloadArtifact } = await import('@electron/get');
  const zipPath = await downloadArtifact({
    version: PET_ELECTRON_VERSION,
    platform: process.platform,
    arch: process.arch,
    artifactName: 'electron',
    cacheRoot: join(cacheRoot, 'zips'),
  });

  const { default: extract } = await import('extract-zip');
  const finalDir = electronPackageDir(cacheRoot, process.platform, process.arch);
  const tmpDir = `${finalDir}.tmp-${process.pid}`;
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  try {
    await extract(zipPath, { dir: tmpDir });
    rmSync(finalDir, { recursive: true, force: true });
    renameSync(tmpDir, finalDir);
  } catch (error) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw error;
  }
  if (!existsSync(binary)) {
    throw new Error(`Electron archive extracted but binary is missing at ${binary}`);
  }
  return binary;
}

/**
 * Locate the bundled overlay entry (`pet-overlay.mjs`). In the packaged CLI it
 * sits next to `main.mjs` in `dist/`; from a source checkout it is produced by
 * `pnpm build` into the app `dist/`.
 */
export function resolvePetOverlayEntry(): string {
  const here = import.meta.dirname;
  const bundled = join(here, 'pet-overlay.mjs');
  if (existsSync(bundled)) return bundled;
  return resolve(here, '..', '..', 'dist', 'pet-overlay.mjs');
}
