/**
 * Session export zip writer — local port of the retired
 * `agent-core/session/export/zip.ts`.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'pathe';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as zlib from 'node:zlib';

import type { ExportSessionManifest } from '../wire-types';
import { ZipFile } from 'yazl';

/**
 * Parse a zip buffer into `entry name → data`. Supports the two compression
 * methods the exporters produce (stored + deflate). Used to read the Rust
 * engine's `session/export` archive so the host can re-assemble it in the SDK
 * layout (see `RustRpcClient.exportSession`).
 */
export function readZipEntries(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('zip eocd not found');
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  let pos = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('bad central-directory entry');
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const fnameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const lfhOffset = buf.readUInt32LE(pos + 42);
    const filename = buf.toString('utf8', pos + 46, pos + 46 + fnameLen);
    if (buf.readUInt32LE(lfhOffset) !== 0x04034b50) throw new Error('bad local-file-header');
    const lfhFnameLen = buf.readUInt16LE(lfhOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(lfhOffset + 28);
    const dataStart = lfhOffset + 30 + lfhFnameLen + lfhExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? compressed : method === 8 ? zlib.inflateRawSync(compressed) : null;
    if (data === null) throw new Error(`unsupported compression method: ${String(method)}`);
    entries.set(filename, data);
    pos += 46 + fnameLen + extraLen + commentLen;
  }
  return entries;
}

export async function collectFilesRecursive(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .toSorted((a, b) => a.localeCompare(b));
  } catch {
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
    } catch {
      // missing source is not fatal — caller decided it should be opt-in;
      // do not abort the whole export.
    }
  }

  zip.end();
  await pipeline(zip.outputStream as unknown as Readable, createWriteStream(args.outputPath));
  return entries;
}
