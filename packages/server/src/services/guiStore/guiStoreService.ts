import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { IEnvironmentService } from '@moonshot-ai/agent-core';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import { IGuiStoreService } from './guiStore';

/**
 * Null-prototype record so keys present on `Object.prototype` (`toString`,
 * `constructor`, `hasOwnProperty`, `__proto__`, …) never resolve to inherited
 * members — they are legal localStorage keys and must behave like any other key.
 */
function emptyStore(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

export class GuiStoreService implements IGuiStoreService {
  readonly _serviceBrand: undefined;

  private readonly filePath: string;
  /** Serializes read-modify-write cycles so concurrent writers cannot clobber each other. */
  private queue: Promise<void> = Promise.resolve();

  constructor(@IEnvironmentService env: IEnvironmentService) {
    this.filePath = join(env.homeDir, 'gui.toml');
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
    // Keep the chain alive regardless of outcome; the rejection is still
    // surfaced to the caller of this specific operation via `run`.
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
      // A corrupt or partially-written file must not take down the store;
      // treat it as empty. The next write replaces it with valid TOML.
      return emptyStore();
    }
  }

  private async writeAll(obj: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    // Spread into a plain object so smol-toml never touches a null-prototype object.
    const plain: Record<string, string> = { ...obj };
    const text = Object.keys(plain).length === 0 ? '' : stringifyToml(plain);
    // Atomic replace via temp file + rename (POSIX-atomic), so readers never
    // observe a half-written file.
    const tmp = `${this.filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
    // 0600: the store can hold unsent drafts / input history; keep it private
    // to the owning user on multi-user hosts.
    await writeFile(tmp, text, { encoding: 'utf-8', mode: 0o600 });
    await rename(tmp, this.filePath);
  }
}
