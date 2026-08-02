/**
 * Workspace registry — stage 3a of the kap-server Rust migration.
 *
 * Replaces the v2 `IWorkspaceService` for the web server's workspace list:
 * a plain JSON file (<home>/server/workspaces.json) holding the registered
 * roots, idempotent on root, with `wd_<slug>_<hash12>` ids matching the v1
 * wire shape. No agent-core-v2 dependency.
 */

import { mkdir, readFile, rename as fsRename, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export interface WorkspaceRecord {
  id: string;
  root: string;
  name: string;
  createdAt: string;
  lastOpenedAt: string;
}

function workspaceIdFor(root: string): string {
  const slug = basename(root).replaceAll(/[^a-z0-9._-]/gi, '').toLowerCase() || 'ws';
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 12);
  return `wd_${slug}_${hash}`;
}

export class WorkspaceRegistry {
  private readonly file: string;
  private cache: WorkspaceRecord[] | null = null;

  constructor(homeDir: string) {
    this.file = join(homeDir, 'server', 'workspaces.json');
  }

  private async load(): Promise<WorkspaceRecord[]> {
    if (this.cache !== null) return this.cache;
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as { workspaces?: WorkspaceRecord[] };
      this.cache = parsed.workspaces ?? [];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  private async save(records: WorkspaceRecord[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify({ workspaces: records }, null, 2), 'utf8');
    this.cache = records;
  }

  async list(): Promise<WorkspaceRecord[]> {
    return [...(await this.load())].toSorted((a, b) =>
      b.lastOpenedAt.localeCompare(a.lastOpenedAt),
    );
  }

  /** Register a root (idempotent: touching an existing root refreshes its
   *  last-opened time and returns the existing record). */
  async createOrTouch(root: string, name?: string): Promise<WorkspaceRecord> {
    const records = await this.load();
    const existing = records.find((r) => r.root === root);
    const now = new Date().toISOString();
    if (existing !== undefined) {
      const touched: WorkspaceRecord = {
        ...existing,
        name: name ?? existing.name,
        lastOpenedAt: now,
      };
      await this.save(records.map((r) => (r.id === existing.id ? touched : r)));
      return touched;
    }
    const record: WorkspaceRecord = {
      id: workspaceIdFor(root),
      root,
      name: name ?? basename(root),
      createdAt: now,
      lastOpenedAt: now,
    };
    records.push(record);
    await this.save(records);
    return record;
  }

  async get(id: string): Promise<WorkspaceRecord | undefined> {
    return (await this.load()).find((r) => r.id === id);
  }

  async rename(id: string, name: string): Promise<WorkspaceRecord> {
    const records = await this.load();
    const target = records.find((r) => r.id === id);
    if (target === undefined) throw new Error(`workspace ${id} does not exist`);
    const updated: WorkspaceRecord = { ...target, name };
    await this.save(records.map((r) => (r.id === id ? updated : r)));
    return updated;
  }

  async unregister(id: string): Promise<boolean> {
    const records = await this.load();
    const next = records.filter((r) => r.id !== id);
    if (next.length === records.length) return false;
    await this.save(next);
    return true;
  }
}

export async function workspaceRootExists(root: string): Promise<boolean> {
  try {
    const st = await stat(root);
    return st.isDirectory();
  } catch {
    return false;
  }
}

export { fsRename as renameFs, unlink as unlinkFs };
