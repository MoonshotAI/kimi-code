// apps/vis/server/src/lib/zip-import.ts
//
// Safe extraction of a user-supplied debug zip into a destination directory.
//
// The zip comes from someone else's machine via `/export-debug-zip`, so it is
// untrusted input: every entry path is validated against path traversal
// ("zip slip"), and total entry-count / uncompressed-size caps guard against
// zip bombs. Only regular files are written; directories are created lazily.

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { fromBuffer, type Entry, type ZipFile } from 'yauzl';

export interface ExtractOptions {
  /** Reject once this many entries have been seen. */
  readonly maxEntries?: number;
  /** Reject once the summed uncompressed size exceeds this many bytes. */
  readonly maxTotalBytes?: number;
}

const DEFAULT_MAX_ENTRIES = 50_000;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

export class ZipImportError extends Error {}

/**
 * Resolve a zip entry name to an absolute path under `root`, or return null
 * when the entry would escape it (zip slip). Exposed for direct testing of
 * the path-traversal guard, which is otherwise hard to exercise because zip
 * writers refuse to emit `..` entries.
 */
export function resolveSafeTarget(root: string, entryName: string): string | null {
  const absRoot = resolve(root);
  const rootPrefix = absRoot + sep;
  const rel = entryName.replaceAll('\\', '/');
  const target = resolve(absRoot, rel);
  if (target !== absRoot && !target.startsWith(rootPrefix)) return null;
  return target;
}

/**
 * Extract every file entry of `zipBuffer` under `destDir`, returning the list
 * of written zip-relative paths (forward-slashed). `destDir` must already be a
 * safe, caller-owned directory; this function never writes outside it.
 */
export async function extractZip(
  zipBuffer: Buffer,
  destDir: string,
  options: ExtractOptions = {},
): Promise<string[]> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const root = resolve(destDir);

  const zip = await openZip(zipBuffer);
  const written: string[] = [];
  let entryCount = 0;
  let totalBytes = 0;

  return new Promise<string[]>((resolvePromise, reject) => {
    const fail = (message: string): void => {
      zip.close();
      reject(new ZipImportError(message));
    };

    zip.readEntry();
    zip.on('entry', (entry: Entry) => {
      entryCount += 1;
      if (entryCount > maxEntries) {
        fail(`zip has too many entries (> ${maxEntries})`);
        return;
      }
      totalBytes += entry.uncompressedSize;
      if (totalBytes > maxTotalBytes) {
        fail(`zip uncompressed size exceeds ${maxTotalBytes} bytes`);
        return;
      }

      // Directory entries end with '/'. Files inside still create their dirs.
      if (entry.fileName.endsWith('/')) {
        zip.readEntry();
        return;
      }

      const rel = entry.fileName.replaceAll('\\', '/');
      const target = resolveSafeTarget(root, rel);
      if (target === null) {
        fail(`zip entry escapes the import directory: "${entry.fileName}"`);
        return;
      }

      zip.openReadStream(entry, (err, readStream) => {
        if (err !== null || readStream === undefined) {
          fail(`failed to read zip entry "${entry.fileName}": ${err?.message ?? 'unknown'}`);
          return;
        }
        void mkdir(dirname(target), { recursive: true })
          .then(() => pipeline(readStream, createWriteStream(target)))
          .then(() => {
            written.push(rel);
            zip.readEntry();
          })
          .catch((error: unknown) => {
            fail(`failed to write "${rel}": ${(error as Error).message}`);
          });
      });
    });
    zip.on('end', () => {
      resolvePromise(written);
    });
    zip.on('error', (err: Error) => {
      reject(new ZipImportError(`corrupt zip: ${err.message}`));
    });
  });
}

function openZip(buffer: Buffer): Promise<ZipFile> {
  return new Promise<ZipFile>((resolvePromise, reject) => {
    fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err !== null || zipfile === undefined) {
        reject(new ZipImportError(`not a valid zip file: ${err?.message ?? 'unknown'}`));
        return;
      }
      resolvePromise(zipfile);
    });
  });
}
