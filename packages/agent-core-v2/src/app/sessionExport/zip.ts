/**
 * `sessionExport` domain (L6) — export zip writer.
 *
 * Collects the session directory's regular files and writes a diagnostic zip
 * archive with a generated manifest plus optional extra entries. This module
 * owns the byte packaging detail; callers provide already-resolved paths.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { dirname, join, relative } from 'pathe';
import { ZipFile } from 'yazl';

import type { ExportSessionManifest } from './sessionExport';

export async function collectFilesRecursive(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .toSorted((a, b) => a.localeCompare(b));
  } catch (error) {
    if (!isMissingPath(error)) throw error;
    return [];
  }
}

export type ExtraZipEntry =
  | {
      readonly source: string;
      readonly target: string;
    }
  | {
      readonly data: Buffer;
      readonly target: string;
    };

export async function writeExportZip(args: {
  readonly outputPath: string;
  readonly manifest: ExportSessionManifest;
  readonly sessionDir: string;
  readonly sessionFiles: readonly string[];
  readonly extraEntries?: readonly ExtraZipEntry[];
}): Promise<readonly string[]> {
  await mkdir(dirname(args.outputPath), { recursive: true });

  const entries: string[] = ['manifest.json'];
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(args.manifest, null, 2), 'utf-8'), 'manifest.json');

  for (const abs of args.sessionFiles) {
    const rel = relative(args.sessionDir, abs).split(/[\\/]/).join('/');
    const data = await readFile(abs);
    zip.addBuffer(data, rel);
    entries.push(rel);
  }

  for (const extra of args.extraEntries ?? []) {
    try {
      const data = 'data' in extra ? extra.data : await readFile(extra.source);
      zip.addBuffer(data, extra.target);
      entries.push(extra.target);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
  }

  zip.end();
  await pipeline(zip.outputStream as unknown as Readable, createWriteStream(args.outputPath));
  return entries;
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
