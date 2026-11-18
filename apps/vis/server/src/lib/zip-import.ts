import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { fromBuffer, type Entry, type ZipFile } from 'yauzl';

export interface ExtractOptions {
  readonly maxEntries?: number;
  readonly maxTotalBytes?: number;
}

const DEFAULT_MAX_ENTRIES = 50_000;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

export class ZipImportError extends Error {}

export function resolveSafeTarget(root: string, entryName: string): string | null {
  const absRoot = resolve(root);
  const rootPrefix = absRoot + sep;
  const rel = entryName.replaceAll('\\', '/');
  const target = resolve(absRoot, rel);
  if (target !== absRoot && !target.startsWith(rootPrefix)) return null;
  return target;
}

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
