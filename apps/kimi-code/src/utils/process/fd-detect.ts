import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { KIMI_CODE_CDN_BASE } from '#/constant/app';
import { getBinDir } from '#/utils/paths';

const CANDIDATES = ['fd', 'fdfind'];
const FD_BASE_URL = `${KIMI_CODE_CDN_BASE}/fd`;
const DOWNLOAD_TIMEOUT_MS = 120_000;

const FD_ARCHIVE_SHA256: Record<string, string> = {
  'fd-v10.4.2-aarch64-apple-darwin.tar.gz':
    '623dc0afc81b92e4d4606b380d7bc91916ba7b97814263e554d50923a39e480a',
  'fd-v10.3.0-x86_64-apple-darwin.tar.gz':
    '50d30f13fe3d5914b14c4fff5abcbd4d0cdab4b855970a6956f4f006c17117a3',
  'fd-v10.4.2-aarch64-unknown-linux-gnu.tar.gz':
    '6c51f7c5446b3338b1e401ff15dc194c590bb2fa64fd43ff3278300f073adec5',
  'fd-v10.4.2-x86_64-unknown-linux-musl.tar.gz':
    'e3257d48e29a6be965187dbd24ce9af564e0fe67b3e73c9bdcd180f4ec11bdde',
  'fd-v10.4.2-aarch64-pc-windows-msvc.zip':
    '4f9110c2d5b33a7f760bfa5510f4c113d828109f7277d421b1053a9943c0fc92',
  'fd-v10.4.2-x86_64-pc-windows-msvc.zip':
    'b2816e506390a89941c63c9187d58a3cc10e9a55f2ef0685f9ea0eccaf7c98c8',
};

export function detectFdPath(): string | null {
  const managed = getManagedFdPath();
  if (managed !== null) return managed;
  return detectSystemFdPath();
}

export async function ensureFdPath(): Promise<string | null> {
  const existing = detectFdPath();
  if (existing !== null) return existing;

  try {
    return await downloadFd();
  } catch {
    return null;
  }
}

function detectSystemFdPath(): string | null {
  for (const name of CANDIDATES) {
    try {
      const result = spawnSync(name, ['--version'], { stdio: 'ignore' });
      if (result.status === 0) return name;
    } catch {
      // ENOENT, EACCES, etc. — try next candidate.
    }
  }
  return null;
}

function getManagedFdPath(): string | null {
  const binaryPath = getManagedFdBinaryPath();
  if (!existsSync(binaryPath)) return null;
  try {
    const result = spawnSync(binaryPath, ['--version'], { stdio: 'ignore' });
    return result.status === 0 ? binaryPath : null;
  } catch {
    return null;
  }
}

function getManagedFdBinaryPath(): string {
  return join(getBinDir(), platform() === 'win32' ? 'fd.exe' : 'fd');
}

export function getFdAssetName(plat = platform(), architecture = arch()): string | null {
  if (plat === 'darwin') {
    if (architecture === 'arm64') return 'fd-v10.4.2-aarch64-apple-darwin.tar.gz';
    if (architecture === 'x64') return 'fd-v10.3.0-x86_64-apple-darwin.tar.gz';
    return null;
  }
  if (plat === 'linux') {
    if (architecture === 'arm64') return 'fd-v10.4.2-aarch64-unknown-linux-gnu.tar.gz';
    if (architecture === 'x64') return 'fd-v10.4.2-x86_64-unknown-linux-musl.tar.gz';
    return null;
  }
  if (plat === 'win32') {
    if (architecture === 'arm64') return 'fd-v10.4.2-aarch64-pc-windows-msvc.zip';
    if (architecture === 'x64') return 'fd-v10.4.2-x86_64-pc-windows-msvc.zip';
    return null;
  }
  return null;
}

async function downloadFd(): Promise<string | null> {
  const assetName = getFdAssetName();
  if (assetName === null) return null;
  const expectedSha256 = FD_ARCHIVE_SHA256[assetName];
  if (expectedSha256 === undefined) return null;

  const binDir = getBinDir();
  mkdirSync(binDir, { recursive: true });

  const binaryPath = getManagedFdBinaryPath();
  const extractDir = join(
    binDir,
    `fd_extract_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
  );
  mkdirSync(extractDir, { recursive: true });
  const archivePath = join(extractDir, assetName);

  try {
    const downloadUrl = `${FD_BASE_URL}/${assetName}`;
    await downloadFile(downloadUrl, archivePath);
    verifyArchive(archivePath, expectedSha256);
    extractArchive(archivePath, extractDir, assetName);

    const binaryName = platform() === 'win32' ? 'fd.exe' : 'fd';
    const extractedBinary = findBinaryRecursively(extractDir, binaryName);
    if (extractedBinary === null) return null;

    rmSync(binaryPath, { force: true });
    renameSync(extractedBinary, binaryPath);
    if (platform() !== 'win32') {
      chmodSync(binaryPath, 0o755);
    }
    return binaryPath;
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

function verifyArchive(path: string, expectedSha256: string): void {
  const actualSha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new Error(`fd archive checksum mismatch: ${actualSha256} !== ${expectedSha256}`);
  }
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`Failed to download fd: ${response.status}`);
  }
  if (response.body === null) {
    throw new Error('Failed to download fd: empty response body');
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
}

function extractArchive(archivePath: string, extractDir: string, assetName: string): void {
  if (assetName.endsWith('.tar.gz')) {
    runExtractionCommand('tar', ['xzf', archivePath, '-C', extractDir]);
    return;
  }
  if (assetName.endsWith('.zip')) {
    if (platform() === 'win32') {
      runExtractionCommand(getWindowsTarCommand(), ['xf', archivePath, '-C', extractDir]);
      return;
    }
    runExtractionCommand('unzip', ['-q', archivePath, '-d', extractDir]);
    return;
  }
  throw new Error(`Unsupported fd archive format: ${assetName}`);
}

function runExtractionCommand(command: string, args: readonly string[]): void {
  const result = spawnSync(command, [...args], { stdio: 'pipe' });
  if (!result.error && result.status === 0) return;
  const stderr = result.stderr.toString().trim();
  const detail =
    result.error?.message ?? (stderr.length > 0 ? stderr : `exit status ${String(result.status)}`);
  throw new Error(`Failed to extract fd with ${command}: ${detail}`);
}

function getWindowsTarCommand(): string {
  const systemRoot = process.env['SystemRoot'] ?? process.env['WINDIR'];
  if (systemRoot !== undefined) {
    const systemTar = join(systemRoot, 'System32', 'tar.exe');
    if (existsSync(systemTar)) return systemTar;
  }
  return 'tar.exe';
}

function findBinaryRecursively(rootDir: string, binaryName: string): string | null {
  const stack = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (currentDir === undefined) continue;
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isFile() && entry.name === binaryName) return fullPath;
      if (entry.isDirectory()) stack.push(fullPath);
    }
  }
  return null;
}
