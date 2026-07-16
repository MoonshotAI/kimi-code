/**
 * MemoryStore — MiniDb-backed persistent memory with full-text search.
 *
 * Stores memory entries as JSON documents in a MiniDb instance at
 * `~/.kimi-code/store/memory`. A text index on the `body` field enables
 * TF-IDF search with CJK tokenization (unigram + bigram).
 *
 * The store is the derived index — the source of truth is the markdown
 * files on disk under `~/.kimi-code/memory/`. The reconcile step
 * syncs disk → index.
 */

import { join } from 'pathe';
import { MiniDb } from '@moonshot-ai/minidb';

import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { createDecorator } from '#/_base/di/instantiation';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ILogService } from '#/_base/log/log';
import type { MemoryEntry, MemorySearchResult } from './memoryPaths';
import { buildSnippet, detectType, extractTitle, parseMemoryPath } from './memoryPaths';

const TEXT_INDEX_NAME = 'memory_body';
const STORE_SUBDIR = 'memory';

export interface IMemoryStore {
  readonly _serviceBrand: undefined;
  /** Get a memory entry by its relative path. */
  get(path: string): Promise<MemoryEntry | undefined>;
  /** Put or update a memory entry. */
  put(entry: MemoryEntry): Promise<void>;
  /** Delete a memory entry by path. */
  delete(path: string): Promise<void>;
  /** List all memory entry paths. */
  list(): Promise<readonly string[]>;
  /** Full-text search over memory entries. */
  search(query: string, limit?: number): Promise<readonly MemorySearchResult[]>;
  /** Sync disk files into the index. */
  reconcile(): Promise<void>;
}

export const IMemoryStore = createDecorator<IMemoryStore>('memoryStore');

export class MemoryStore extends Disposable implements IMemoryStore {
  declare readonly _serviceBrand: undefined;

  private dbPromise: Promise<MiniDb> | undefined;
  private readonly dir: string;
  private readonly memoryBaseDir: string;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.dir = join(this.bootstrap.storeDir, STORE_SUBDIR);
    this.memoryBaseDir = join(this.bootstrap.homeDir, 'memory');
    this._register(toDisposable(() => { void this.close(); }));
  }

  private async openDb(): Promise<MiniDb> {
    if (this.dbPromise !== undefined) return this.dbPromise;
    this.dbPromise = MiniDb.openOrRebuild(
      {
        dir: this.dir,
        valueCodec: 'json',
        valueMode: 'memory',
        fsyncPolicy: 'everysec',
      },
      {
        onRebuild: (err) => {
          this.log.warn('memory.store.rebuilt', { dir: this.dir, err });
        },
      },
    ).catch((error) => {
      this.log.error('memory.store.open.failed', { dir: this.dir, error });
      throw error;
    });
    // Ensure text index exists.
    const db = await this.dbPromise;
    try {
      await db.createTextIndex(TEXT_INDEX_NAME, { fields: ['body'] });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('already exists')) {
        this.log.warn('memory.store.textIndex.create.failed', { error });
      }
    }
    return db;
  }

  async get(path: string): Promise<MemoryEntry | undefined> {
    const db = await this.openDb();
    const raw = db.get(path);
    return raw as MemoryEntry | undefined;
  }

  async put(entry: MemoryEntry): Promise<void> {
    const db = await this.openDb();
    await db.set(entry.path, entry);
  }

  async delete(path: string): Promise<void> {
    const db = await this.openDb();
    await db.del(path);
  }

  async list(): Promise<readonly string[]> {
    const db = await this.openDb();
    const entries = db.query({});
    return entries.map((e) => e.key);
  }

  async search(query: string, limit = 10): Promise<readonly MemorySearchResult[]> {
    const db = await this.openDb();
    const overFetch = Math.min(limit * 3, 50);
    const hits = db.search(TEXT_INDEX_NAME, query, { op: 'OR', limit: overFetch });

    const results: MemorySearchResult[] = [];
    for (const hit of hits) {
      const entry = db.get(hit.key) as MemoryEntry | undefined;
      if (entry === undefined) continue;
      const parsed = parseMemoryPath(entry.path);
      if (parsed === undefined) continue;

      // Normalize TF-IDF score: higher = better. Apply relative threshold.
      const normalizedScore = hit.score;
      if (normalizedScore < 0.15) continue;

      results.push({
        path: entry.path,
        scope: entry.scope,
        scopeId: entry.scopeId,
        type: entry.type,
        title: entry.title,
        snippet: buildSnippet(entry.body, query),
        score: normalizedScore,
      });
    }

    return results.slice(0, limit);
  }

  async reconcile(): Promise<void> {
    const { readdir, stat } = await import('node:fs/promises');
    const { join: joinPath } = await import('pathe');

    const db = await this.openDb();
    const diskFiles = await this.walkDir(this.memoryBaseDir, '');

    // Get current index entries.
    const indexedKeys = new Set<string>();
    for (const entry of db.query({})) {
      indexedKeys.add(entry.key);
    }

    // Add or update changed files.
    for (const [relPath, fingerprint] of diskFiles) {
      const existing = db.get(relPath) as MemoryEntry | undefined;
      if (existing !== undefined && existing.fingerprint === fingerprint) {
        indexedKeys.delete(relPath);
        continue;
      }

      const parsed = parseMemoryPath(relPath);
      if (parsed === undefined) continue;

      const fullPath = joinPath(this.memoryBaseDir, relPath);
      const body = await readFile(fullPath);
      const statInfo = await stat(fullPath);

      const entry: MemoryEntry = {
        path: relPath,
        scope: parsed.scope,
        scopeId: parsed.scopeId,
        type: detectType(body),
        title: extractTitle(body, parsed.fileName),
        body,
        fingerprint,
        updatedAt: statInfo.mtimeMs,
      };
      await db.set(relPath, entry);
      indexedKeys.delete(relPath);
    }

    // Remove deleted files from index.
    for (const staleKey of indexedKeys) {
      await db.del(staleKey);
    }

    this.log.debug('memory.store.reconciled', {
      total: diskFiles.size,
      removed: indexedKeys.size,
    });
  }

  private async walkDir(
    base: string,
    relPrefix: string,
  ): Promise<Map<string, string>> {
    const { readdir, stat } = await import('node:fs/promises');
    const { join: joinPath } = await import('pathe');
    const result = new Map<string, string>();

    let entries: string[];
    try {
      entries = await readdir(joinPath(base, relPrefix));
    } catch {
      return result;
    }

    for (const name of entries) {
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      const full = joinPath(base, rel);
      const s = await stat(full);
      if (s.isDirectory()) {
        const sub = await this.walkDir(base, rel);
        for (const [k, v] of sub) result.set(k, v);
      } else if (s.isFile() && name.endsWith('.md')) {
        result.set(rel, `${s.size}-${s.mtimeMs}`);
      }
    }

    return result;
  }

  async close(): Promise<void> {
    const db = await this.dbPromise?.catch(() => undefined);
    await db?.close();
  }
}

async function readFile(path: string): Promise<string> {
  const { readFile: fsReadFile } = await import('node:fs/promises');
  return fsReadFile(path, 'utf-8');
}

registerScopedService(
  LifecycleScope.App,
  IMemoryStore,
  MemoryStore,
  InstantiationType.Eager,
  'memory',
);
