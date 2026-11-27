import { constants as fsConstants, promises as fs } from 'node:fs';

import { executableCandidates, pathFlavor } from './platform.mjs';

const LEGACY_BIN = 'kimi';
const LEGACY_RENAME = 'kimi-legacy';
const PYTHON_MARKER = 'kimi_cli';

const SHIM_SNIFF_BYTES_POSIX = 4096;
const SHIM_SNIFF_BYTES_WINDOWS_MAX = 256 * 1024;

function pathEntries(pathString, platform) {
  const { delimiter } = pathFlavor(platform);
  if (!pathString) return [];
  const seen = new Set();
  const out = [];
  for (const entry of pathString.split(delimiter)) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

async function isExecutableFile(filePath, platform) {
  try {
    const info = await fs.stat(filePath);
    if (!info.isFile()) return false;
    if (platform === 'win32') return true;
    return (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

async function readShimHead(filePath, platform) {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const stat = await handle.stat();
    const limit =
      platform === 'win32' ? SHIM_SNIFF_BYTES_WINDOWS_MAX : SHIM_SNIFF_BYTES_POSIX;
    const target = Math.min(stat.size, limit);
    const buffer = Buffer.alloc(target);
    const { bytesRead } = await handle.read(buffer, 0, target, 0);
    return buffer.subarray(0, bytesRead).toString('latin1');
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

export async function detectLegacyShims(ownRoot, pathString, platform = process.platform) {
  const { sep, join } = pathFlavor(platform);
  const ownRootPrefix = ownRoot ? ownRoot + sep : null;
  const candidates = executableCandidates(LEGACY_BIN, platform);
  const results = [];
  const seenShims = new Set();

  for (const dir of pathEntries(pathString, platform)) {
    for (const name of candidates) {
      const shimPath = join(dir, name);
      if (seenShims.has(shimPath)) continue;
      if (!(await isExecutableFile(shimPath, platform))) continue;

      let realPath;
      try {
        realPath = await fs.realpath(shimPath);
      } catch {
        continue;
      }

      if (
        ownRootPrefix !== null &&
        (realPath === ownRoot || realPath.startsWith(ownRootPrefix))
      ) {
        continue;
      }

      const head = await readShimHead(realPath, platform);
      if (!head || !head.includes(PYTHON_MARKER)) continue;

      seenShims.add(shimPath);
      results.push({ shimPath, realPath });
    }
  }
  return results;
}

export async function isLegacyShim(p, platform = process.platform) {
  let real;
  try {
    real = await fs.realpath(p);
  } catch {
    return false;
  }
  const head = await readShimHead(real, platform);
  return Boolean(head && head.includes(PYTHON_MARKER));
}

async function pathExists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

export function renameTargetFor(shimPath, platform = process.platform) {
  const { dirname, extname, join } = pathFlavor(platform);
  const ext = extname(shimPath);
  return join(dirname(shimPath), LEGACY_RENAME + ext);
}

export async function isSystemOwnedDir(shimPath, platform = process.platform) {
  const { dirname } = pathFlavor(platform);
  if (platform === 'win32') {
    const dir = dirname(shimPath).toLowerCase();
    const systemRoots = [
      'c:\\program files',
      'c:\\program files (x86)',
      'c:\\programdata',
      'c:\\windows',
    ];
    return systemRoots.some(
      (root) => dir === root || dir.startsWith(root + '\\'),
    );
  }
  try {
    const info = await fs.stat(dirname(shimPath));
    return info.uid === 0;
  } catch {
    return false;
  }
}

async function canWriteDir(dir) {
  try {
    await fs.access(dir, fsConstants.W_OK | fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function classifyShim(shimPath, platform = process.platform) {
  const { dirname } = pathFlavor(platform);
  const target = renameTargetFor(shimPath, platform);
  const dir = dirname(shimPath);

  if (!(await canWriteDir(dir))) {
    return {
      kind: 'blocked',
      shimPath,
      target,
      isSystemPath: await isSystemOwnedDir(shimPath, platform),
    };
  }

  if (await pathExists(target)) {
    if (await isLegacyShim(target, platform)) {
      return { kind: 'consolidate', shimPath, target };
    }
    return { kind: 'delete-only', shimPath, target };
  }

  return { kind: 'renameable', shimPath, target };
}

export async function renameInPlace(shimPath, target) {
  try {
    await fs.rename(shimPath, target);
    return { success: true };
  } catch (err) {
    const code = err && typeof err === 'object' ? err.code : undefined;
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, code, message };
  }
}

export async function deleteShim(shimPath) {
  try {
    await fs.unlink(shimPath);
    return { success: true };
  } catch (err) {
    const code = err && typeof err === 'object' ? err.code : undefined;
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, code, message };
  }
}
