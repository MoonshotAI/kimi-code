import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import { ZipFile } from 'yazl';

import type {
  FeedbackCodebaseArchive,
  FeedbackCodebaseFile,
  FeedbackCodebaseScanResult,
} from './types';

interface PackageEntry {
  readonly absolutePath: string;
  readonly archivePath: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface PackageBundleInput {
  /** Codebase files are placed under the `codebase/` prefix in the zip. */
  readonly codebase?: FeedbackCodebaseScanResult;
  /** Session directory files are placed under the `session/` prefix in the zip. */
  readonly sessionDir?: string;
}

/**
 * Pack the scanned codebase into a zip, with files placed at the zip root.
 */
export async function packageCodebase(
  scan: FeedbackCodebaseScanResult,
  archivePath: string,
): Promise<FeedbackCodebaseArchive> {
  const entries: PackageEntry[] = scan.files.map((file) => ({
    absolutePath: file.absolutePath,
    archivePath: file.path,
    size: file.size,
    mtimeMs: file.mtimeMs,
  }));
  return packageEntries(entries, archivePath);
}

/**
 * Pack the current session directory (state.json, agents/<id>/wire.jsonl,
 * logs/kimi-code.log) into a zip, with files placed at the zip root.
 */
export async function packageSessionFiles(
  sessionDir: string,
  archivePath: string,
): Promise<FeedbackCodebaseArchive> {
  const files = await collectDirFiles(sessionDir);
  const entries: PackageEntry[] = files.map((file) => ({
    absolutePath: file.absolutePath,
    archivePath: file.path,
    size: file.size,
    mtimeMs: file.mtimeMs,
  }));
  return packageEntries(entries, archivePath);
}

/**
 * Pack a merged bundle: codebase under `codebase/` and session files under
 * `session/`. Used when the user opts to upload both logs and codebase.
 */
export async function packageBundle(
  input: PackageBundleInput,
  archivePath: string,
): Promise<FeedbackCodebaseArchive> {
  const codebaseEntries: PackageEntry[] =
    input.codebase === undefined
      ? []
      : input.codebase.files.map((file) => ({
          absolutePath: file.absolutePath,
          archivePath: `codebase/${file.path}`,
          size: file.size,
          mtimeMs: file.mtimeMs,
        }));
  const sessionEntries: PackageEntry[] =
    input.sessionDir === undefined
      ? []
      : (await collectDirFiles(input.sessionDir)).map((file) => ({
          absolutePath: file.absolutePath,
          archivePath: `session/${file.path}`,
          size: file.size,
          mtimeMs: file.mtimeMs,
        }));
  const entries = [...codebaseEntries, ...sessionEntries];
  if (entries.length === 0) {
    throw new Error('Cannot package an empty feedback bundle.');
  }
  return packageEntries(entries, archivePath);
}

async function packageEntries(
  entries: readonly PackageEntry[],
  archivePath: string,
): Promise<FeedbackCodebaseArchive> {
  await mkdir(dirname(archivePath), { recursive: true });

  const zip = new ZipFile();
  const hash = createHash('sha256');
  const output = createWriteStream(archivePath);

  const done = new Promise<void>((resolvePromise, rejectPromise) => {
    output.on('finish', resolvePromise);
    output.on('error', rejectPromise);
    zip.outputStream.on('error', rejectPromise);
  });

  zip.outputStream.on('data', (chunk: Buffer) => {
    hash.update(chunk);
  });
  zip.outputStream.pipe(output);

  for (const entry of entries) {
    zip.addFile(entry.absolutePath, entry.archivePath, {
      mtime: new Date(entry.mtimeMs),
      mode: 0o100644,
    });
  }
  zip.end();
  await done;

  const archiveStat = await stat(archivePath);
  return {
    path: archivePath,
    size: archiveStat.size,
    sha256: hash.digest('hex'),
    fingerprint: fingerprintEntries(entries),
    fileCount: entries.length,
  };
}

async function collectDirFiles(dir: string): Promise<FeedbackCodebaseFile[]> {
  const results: FeedbackCodebaseFile[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const fileStat = await lstat(absolutePath).catch(() => null);
      if (fileStat === null || !fileStat.isFile()) continue;
      results.push({
        path: toPosixPath(relative(dir, absolutePath)),
        absolutePath,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
      });
    }
  }

  await walk(dir);
  return results.toSorted((a, b) => a.path.localeCompare(b.path));
}

function fingerprintEntries(entries: readonly PackageEntry[]): string {
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(entry.archivePath);
    hash.update('\0');
    hash.update(String(entry.size));
    hash.update('\0');
    hash.update(String(Math.trunc(entry.mtimeMs)));
    hash.update('\n');
  }
  return hash.digest('hex');
}

function toPosixPath(value: string): string {
  return value.split('\\').join('/');
}
