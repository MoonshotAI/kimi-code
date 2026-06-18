import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import {
  WEB_ASSET_MANIFEST_VERSION,
  buildWebAssetKey,
  buildWebManifestKey,
} from './manifest.mjs';

export { WEB_ASSET_MANIFEST_VERSION };

const WEB_ASSETS_DIR = 'dist-web';

function toPosixPath(path) {
  return path.split('\\').join('/');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function listFiles(root) {
  const files = [];

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (entry.isFile()) {
        files.push(path);
      }
    }
  }

  await walk(root);
  return files;
}

async function assertBuiltAssetRoot({ assetRoot, requiredFile, message }) {
  const requiredPath = join(assetRoot, requiredFile);
  try {
    const info = await stat(requiredPath);
    if (!info.isFile()) {
      throw new Error(`${requiredFile} is not a file`);
    }
  } catch {
    throw new Error(message);
  }
}

export function webAssetManifestKey(target) {
  return buildWebManifestKey(target);
}

export function webAssetKey(target, relativePath) {
  return buildWebAssetKey(target, relativePath);
}

async function collectAssetRoot({
  appRoot,
  target,
  root,
  requiredFile,
  missingMessage,
  assetKey,
}) {
  const assetRoot = resolve(appRoot, ...root.split('/'));
  await assertBuiltAssetRoot({ assetRoot, requiredFile, message: missingMessage });

  const files = (await listFiles(assetRoot)).sort((a, b) => a.localeCompare(b));
  const manifestFiles = [];
  const assets = {};

  for (const file of files) {
    if (!existsSync(file)) continue;
    const bytes = await readFile(file);
    const relativePath = toPosixPath(relative(assetRoot, file));
    const key = assetKey(target, relativePath);
    manifestFiles.push({
      assetKey: key,
      relativePath,
      sha256: sha256(bytes),
    });
    assets[key] = file;
  }

  const manifest = {
    version: WEB_ASSET_MANIFEST_VERSION,
    target,
    root,
    files: manifestFiles,
  };

  return {
    manifest,
    manifestJson: `${JSON.stringify(manifest, null, 2)}\n`,
    assets,
  };
}

export async function collectWebAssets({ appRoot, target }) {
  const buildCommand =
    'pnpm --filter @moonshot-ai/kimi-web run build && pnpm --filter @moonshot-ai/kimi-code run build';
  return collectAssetRoot({
    appRoot,
    target,
    root: WEB_ASSETS_DIR,
    requiredFile: 'index.html',
    missingMessage: `Kimi web build output was not found at ${resolve(appRoot, WEB_ASSETS_DIR)}. Run \`${buildCommand}\` before building native SEA assets. App root: ${appRoot}`,
    assetKey: webAssetKey,
  });
}
