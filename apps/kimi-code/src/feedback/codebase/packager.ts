import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { ZipFile } from 'yazl';

import type { FeedbackArchive } from '../archive';
import type { FeedbackCodebaseScanResult } from './types';

interface PackageEntry {
  readonly absolutePath: string;
  readonly archivePath: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * Pack the scanned codebase into a zip, with files placed at the zip root.
 */
export async function packageCodebase(
  scan: FeedbackCodebaseScanResult,
  archivePath: string,
): Promise<FeedbackArchive> {
  const entries: PackageEntry[] = scan.files.map((file) => ({
    absolutePath: file.absolutePath,
    archivePath: file.path,
    size: file.size,
    mtimeMs: file.mtimeMs,
  }));
  return packageEntries(entries, archivePath);
}

async function packageEntries(
  entries: readonly PackageEntry[],
  archivePath: string,
): Promise<FeedbackArchive> {
  if (entries.length === 0) {
    throw new Error('Cannot package an empty feedback archive.');
  }
  await mkdir(dirname(archivePath), { recursive: true });

  const zip = new ZipFile();
  const hash = createHash('sha256');
  const output = createWriteStream(archivePath);

  try {
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
  } catch (error) {
    // A failed zip (e.g. a source file vanished or became unreadable between
    // scan and packaging) would otherwise leave a partial archive behind in
    // the cache dir. Destroy the stream so the handle is released before we
    // remove the file, then best-effort delete it.
    output.destroy();
    await rm(archivePath, { force: true }).catch(() => {});
    throw error;
  }
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
