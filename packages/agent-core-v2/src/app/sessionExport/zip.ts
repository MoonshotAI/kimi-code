/**
 * `sessionExport` domain (L6) — export zip writer.
 *
 * Collects the session directory's regular files and writes a diagnostic zip
 * archive with a generated manifest plus optional extra entries. This module
 * owns the byte packaging detail; callers provide already-resolved paths.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
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
      /** Absolute path on disk. */
      readonly source: string;
      /** zip-relative target path. */
      readonly target: string;
    }
  | {
      readonly data: Buffer;
      /** zip-relative target path. */
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
  const output = zip.outputStream as unknown as Readable;
  const writing = pipeline(output, createWriteStream(args.outputPath));

  try {
    zip.addBuffer(Buffer.from(JSON.stringify(args.manifest, null, 2), 'utf-8'), 'manifest.json');

    for (const abs of args.sessionFiles) {
      const rel = relative(args.sessionDir, abs).split(/[\\/]/).join('/');
      zip.addFile(abs, rel);
      entries.push(rel);
    }

    for (const extra of args.extraEntries ?? []) {
      if ('data' in extra) zip.addBuffer(extra.data, extra.target);
      else zip.addFile(extra.source, extra.target);
      entries.push(extra.target);
    }

    zip.end();
    await writing;
  } catch (error) {
    output.destroy(error instanceof Error ? error : new Error(String(error)));
    await writing.catch(() => undefined);
    throw error;
  }
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
