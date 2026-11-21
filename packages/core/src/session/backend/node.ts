import { readdir, rm, stat } from 'node:fs/promises';

import { join } from 'pathe';

import { FileStorageService } from '#/store/backend/node';

import {
  type SessionRecord,
  type SessionSpace,
  type SessionSpaceBackend,
} from '../model';
import { createSessionSpace } from '../space';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

class NodeSessionSpaceBackend<T extends SessionRecord> implements SessionSpaceBackend<T> {
  private readonly storage: FileStorageService;

  constructor(private readonly root: string) {
    this.storage = new FileStorageService(root);
  }

  async list(prefix?: string): Promise<readonly string[]> {
    const keys: string[] = [];
    await this.walk(this.root, '', keys);
    return keys.filter((key) => prefix === undefined || key.startsWith(prefix));
  }

  async read(key: string): Promise<T | undefined> {
    const bytes =
      (await this.storage.read(key, 'state.json')) ??
      (await this.storage.read(`${key}/session-meta`, 'state.json'));
    return bytes === undefined ? undefined : JSON.parse(decoder.decode(bytes)) as T;
  }

  async write(key: string, record: T): Promise<void> {
    await this.storage.write(key, 'state.json', encoder.encode(JSON.stringify(record)), { atomic: true });
  }

  async delete(key: string): Promise<boolean> {
    const dir = join(this.root, key);
    try {
      await stat(dir);
    } catch (error) {
      if (isEnoent(error)) return false;
      throw error;
    }
    await rm(dir, { recursive: true, force: true });
    return true;
  }

  private async walk(dir: string, key: string, keys: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
    if (key !== '' && entries.some((entry) => entry.isFile() && entry.name === 'state.json')) {
      keys.push(key);
      return;
    }
    const legacy = entries.find((entry) => entry.isDirectory() && entry.name === 'session-meta');
    if (key !== '' && legacy !== undefined) {
      const children = await readdir(join(dir, legacy.name), { withFileTypes: true });
      if (children.some((entry) => entry.isFile() && entry.name === 'state.json')) {
        keys.push(key);
        return;
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === 'session-meta') continue;
      await this.walk(join(dir, entry.name), key === '' ? entry.name : `${key}/${entry.name}`, keys);
    }
  }
}

export function nodeSessionSpace<T extends SessionRecord = SessionRecord>(
  root: string,
  now?: () => number,
): SessionSpace<T> {
  return createSessionSpace(new NodeSessionSpaceBackend<T>(root), now);
}
