import { mkdir, open, readFile, readdir, truncate, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';

import { errorCode } from '#/utils/error';

import type { Journal } from '../writer';

const lockFile = 'writer.lock';
const extension = '.jsonl';

export class JournalLockedError extends Error {
  constructor(readonly dir: string, readonly pid: number) {
    super(`Journal '${dir}' is already open by process ${pid}`);
    this.name = 'JournalLockedError';
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

async function acquireLock(dir: string): Promise<() => Promise<void>> {
  const path = join(dir, lockFile);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(path, String(process.pid), { flag: 'wx' });
      return () => unlink(path).catch(() => undefined);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      const pid = Number(await readFile(path, 'utf8').catch(() => ''));
      if (Number.isSafeInteger(pid) && pid > 0 && isAlive(pid)) throw new JournalLockedError(dir, pid);
      await unlink(path).catch(() => undefined);
    }
  }
  throw new JournalLockedError(dir, 0);
}

export async function nodeJournal(dir: string, options: { fsync?: boolean } = {}): Promise<Journal> {
  await mkdir(dir, { recursive: true });
  const release = await acquireLock(dir);
  const handles = new Map<string, Promise<FileHandle>>();
  const pathOf = (log: string): string => `${join(dir, ...log.split('/'))}${extension}`;
  const handleOf = (log: string): Promise<FileHandle> => {
    let handle = handles.get(log);
    if (handle === undefined) {
      const path = pathOf(log);
      const opening = mkdir(dirname(path), { recursive: true }).then(() => open(path, 'a'));
      opening.catch(() => {
        if (handles.get(log) === opening) handles.delete(log);
      });
      handles.set(log, opening);
      handle = opening;
    }
    return handle;
  };
  return {
    names: async (prefix) =>
      (await readdir(dir, { recursive: true }))
        .filter((file) => file.endsWith(extension))
        .map((file) => file.slice(0, -extension.length).split(sep).join('/'))
        .filter((name) => name.startsWith(prefix))
        .sort(),
    async *lines(log) {
      const path = pathOf(log);
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return;
        throw error;
      }
      const end = text.lastIndexOf('\n') + 1;
      if (end < text.length) await truncate(path, Buffer.byteLength(text.slice(0, end)));
      if (end > 0) yield* text.slice(0, end - 1).split('\n');
    },
    append: async (log, _seq, line) => {
      const handle = await handleOf(log);
      await handle.appendFile(`${line}\n`, 'utf8');
      if (options.fsync === true) await handle.datasync();
    },
    close: async () => {
      await Promise.allSettled(Array.from(handles.values(), async (handle) => (await handle).close()));
      handles.clear();
      await release();
    },
  };
}
