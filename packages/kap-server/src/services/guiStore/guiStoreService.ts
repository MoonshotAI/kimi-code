/**
 * `GuiStoreService` — persistent TOML-backed implementation of `IGuiStoreService`.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import { IGuiStoreService } from './guiStore';

function emptyStore(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

export class GuiStoreService implements IGuiStoreService {
  readonly _serviceBrand: undefined;

  private readonly filePath: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(homeDir: string) {
    this.filePath = join(homeDir, 'gui.toml');
  }

  async getItem(key: string): Promise<string | null> {
    const all = await this.readAll();
    if (!Object.prototype.hasOwnProperty.call(all, key)) return null;
    return all[key] ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    await this.withLock(async () => {
      const all = await this.readAll();
      all[key] = value;
      await this.writeAll(all);
    });
  }

  async removeItem(key: string): Promise<void> {
    await this.withLock(async () => {
      const all = await this.readAll();
      if (Object.prototype.hasOwnProperty.call(all, key)) {
        delete all[key];
        await this.writeAll(all);
      }
    });
  }

  async clear(): Promise<void> {
    await this.withLock(() => this.writeAll(emptyStore()));
  }

  async length(): Promise<number> {
    const all = await this.readAll();
    return Object.keys(all).length;
  }

  private withLock(fn: () => Promise<void>): Promise<void> {
    const run = this.queue.then(fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readAll(): Promise<Record<string, string>> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
      throw error;
    }
    if (text.trim().length === 0) return emptyStore();
    try {
      const parsed = parseToml(text) as Record<string, unknown>;
      const out = emptyStore();
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    } catch {
      return emptyStore();
    }
  }

  private async writeAll(obj: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const plain: Record<string, string> = { ...obj };
    const text = Object.keys(plain).length === 0 ? '' : stringifyToml(plain);
    const tmp = `${this.filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
    await writeFile(tmp, text, { encoding: 'utf-8', mode: 0o600 });
    await rename(tmp, this.filePath);
  }
}
