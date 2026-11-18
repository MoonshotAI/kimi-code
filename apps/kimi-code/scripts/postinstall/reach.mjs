import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

import { executableCandidates, pathFlavor } from './platform.mjs';

const LEGACY_BIN = 'kimi';
const IS_WINDOWS = process.platform === 'win32';

export function detectPackageManager() {
  const ua = process.env['npm_config_user_agent'] ?? '';
  if (ua.startsWith('pnpm/')) return 'pnpm';
  if (ua.startsWith('yarn/')) return 'yarn';
  return 'npm';
}

export function pmGlobalBinCommand(pm) {
  switch (pm) {
    case 'pnpm':
      return 'pnpm bin -g';
    case 'yarn':
      return 'yarn global bin';
    case 'npm':
    default:
      return 'npm prefix -g';
  }
}

export function pmGlobalInstallCommand(pm, pkg) {
  switch (pm) {
    case 'pnpm':
      return `pnpm add -g ${pkg}`;
    case 'yarn':
      return `yarn global add ${pkg}`;
    case 'npm':
    default:
      return `npm install -g ${pkg}`;
  }
}

export function isGlobalInstall() {
  return (
    process.env['npm_config_global'] === 'true' ||
    process.env['pnpm_config_global'] === 'true' ||
    process.env['npm_config_location'] === 'global' ||
    isYarnClassicGlobalAdd()
  );
}

function isYarnClassicGlobalAdd() {
  const ua = process.env['npm_config_user_agent'] ?? '';
  if (!ua.startsWith('yarn/1.')) return false;
  const raw = process.env['npm_config_argv'];
  if (!raw) return false;
  let argv;
  try {
    argv = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!Array.isArray(argv?.original)) return false;
  const globalIdx = argv.original.indexOf('global');
  if (globalIdx === -1) return false;
  const next = argv.original[globalIdx + 1];
  return typeof next === 'string' && YARN_GLOBAL_SUBCOMMANDS.has(next);
}

const YARN_GLOBAL_SUBCOMMANDS = new Set([
  'add',
  'remove',
  'upgrade',
  'upgrade-interactive',
  'list',
  'bin',
  'dir',
]);

export async function ownPackageRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    try {
      await fs.access(join(dir, 'package.json'));
      try {
        return await fs.realpath(dir);
      } catch {
        return dir;
      }
    } catch {}
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
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

const PACKAGE_NAME_MARKERS = ['@moonshot-ai/kimi-code', '@moonshot-ai\\kimi-code'];

async function shimReferencesOwnPackage(shimPath) {
  try {
    const handle = await fs.open(shimPath, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buf, 0, 4096, 0);
      const text = buf.subarray(0, bytesRead).toString('latin1');
      return PACKAGE_NAME_MARKERS.some((m) => text.includes(m));
    } finally {
      await handle.close().catch(() => {});
    }
  } catch {
    return false;
  }
}

async function classifyShim(shim, ownRoot, ownPrefix) {
  let real;
  try {
    real = await fs.realpath(shim);
  } catch {
    return 'unreadable';
  }
  if (real === ownRoot || real.startsWith(ownPrefix)) return 'own';
  if (await shimReferencesOwnPackage(shim)) return 'own';
  return 'other';
}

export async function findFirstResolvableKimi(
  ownRoot,
  pathString,
  actionableShimPaths,
  allDetectedShimPaths,
  platform = process.platform,
) {
  if (!ownRoot || !pathString) return { kind: 'none' };
  const { delimiter: flavorDelimiter, join: flavorJoin, sep: flavorSep } = pathFlavor(platform);
  const ownPrefix = ownRoot + flavorSep;
  const candidates = executableCandidates(LEGACY_BIN, platform);
  const skipSet = new Set(actionableShimPaths ?? []);
  const knownLegacySet = new Set(allDetectedShimPaths ?? []);
  const seenDirs = new Set();
  for (const dir of pathString.split(flavorDelimiter)) {
    if (!dir || seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    for (const name of candidates) {
      const shim = flavorJoin(dir, name);
      if (skipSet.has(shim)) continue;
      if (!(await isExecutableFile(shim, platform))) continue;
      const kind = await classifyShim(shim, ownRoot, ownPrefix);
      if (kind === 'unreadable') continue;
      if (kind === 'own') return { kind: 'own' };
      if (knownLegacySet.has(shim)) {
        return { kind: 'blocked-legacy', shim };
      }
      return { kind: 'foreign', path: shim };
    }
  }
  return { kind: 'none' };
}

export async function userShellPath() {
  if (IS_WINDOWS) return { kind: 'unknown', reason: 'windows skip' };

  const shell = process.env['SHELL'];
  if (!shell) return { kind: 'unknown', reason: 'no SHELL env var' };

  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let stdout = '';
    const probe =
      'printf "<<<KIMI_PATH_BEGIN>>>%s<<<KIMI_PATH_END>>>\\n" "$PATH"';
    const child = spawn(shell, ['-l', '-c', probe], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf-8');
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle({ kind: 'unknown', reason: 'shell spawn timed out' });
    }, 5000);

    child.on('close', (code) => {
      clearTimeout(timer);
      const match = stdout.match(
        /<<<KIMI_PATH_BEGIN>>>([\s\S]*?)<<<KIMI_PATH_END>>>/,
      );
      if (match && match[1].length > 0) {
        settle({ kind: 'ok', path: match[1] });
        return;
      }
      settle({ kind: 'unknown', reason: `no PATH printed (exit ${code})` });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      settle({ kind: 'unknown', reason: `spawn error: ${err.message}` });
    });
  });
}

export async function postinstallPaths() {
  const shellResult = await userShellPath();
  const processPath = process.env['PATH'] ?? '';
  const shellPathStr = shellResult.kind === 'ok' ? shellResult.path : null;
  const reachability = shellPathStr ?? processPath;
  const detection = unionPaths(shellPathStr, processPath);
  return { detection, reachability };
}

function unionPaths(...paths) {
  const seen = new Set();
  const out = [];
  for (const p of paths) {
    if (!p) continue;
    for (const entry of p.split(delimiter)) {
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      out.push(entry);
    }
  }
  return out.join(delimiter);
}

