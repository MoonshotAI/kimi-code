import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { ACTIVITY_LOG } from '#/features/tower/protocol/paths';

export interface TowerLogSlice {
  readonly offset: number;
  readonly lines: readonly string[];
}

const NEWLINE = 0x0a;

function decodeLines(buffer: Buffer, dropTrailingNewline: boolean): string[] {
  const text = buffer.toString('utf8');
  if (text.length === 0) return [];
  return (dropTrailingNewline && text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

async function openLog(file: string): Promise<FileHandle | undefined> {
  try {
    return await open(file, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readRange(handle: FileHandle, start: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, start + read);
    if (bytesRead === 0) break;
    read += bytesRead;
  }
  return buffer.subarray(0, read);
}

export async function readTowerLogFrom(repoRoot: string, offset: number): Promise<TowerLogSlice> {
  const handle = await openLog(join(repoRoot, ACTIVITY_LOG));
  if (handle === undefined) return { offset: 0, lines: [] };
  try {
    const { size } = await handle.stat();
    const start = size < offset ? 0 : offset;
    const length = size - start;
    if (length <= 0) return { offset: size, lines: [] };
    const content = await readRange(handle, start, length);
    const lastNewline = content.lastIndexOf(NEWLINE);
    if (lastNewline < 0) return { offset: start, lines: [] };
    return {
      offset: start + lastNewline + 1,
      lines: decodeLines(content.subarray(0, lastNewline), false),
    };
  } finally {
    await handle.close();
  }
}

export async function readTowerLogTail(repoRoot: string, maxBytes: number): Promise<TowerLogSlice> {
  const handle = await openLog(join(repoRoot, ACTIVITY_LOG));
  if (handle === undefined) return { offset: 0, lines: [] };
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - Math.max(0, maxBytes));
    const length = size - start;
    if (length <= 0) return { offset: size, lines: [] };
    const chunk = await readRange(handle, start, length);
    let content = chunk;
    if (start > 0) {
      const firstNewline = content.indexOf(NEWLINE);
      if (firstNewline < 0) return { offset: size, lines: [] };
      content = content.subarray(firstNewline + 1);
    }
    return { offset: size, lines: decodeLines(content, true) };
  } finally {
    await handle.close();
  }
}
