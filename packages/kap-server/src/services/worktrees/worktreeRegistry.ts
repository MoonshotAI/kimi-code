import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

const registryEntrySchema = z.object({
  path: z.string().min(1),
  repo_root: z.string().min(1),
  workspace_id: z.string().min(1),
  branch: z.string().min(1).optional(),
  created_at: z.string().min(1),
});
export type WorktreeRegistryEntry = z.infer<typeof registryEntrySchema>;

const registryFileSchema = z.object({
  version: z.literal(1),
  worktrees: z.array(z.unknown()),
});

export class WorktreeRegistry {
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly worktreesHome: string) {}

  private get file(): string {
    return join(this.worktreesHome, 'registry.json');
  }

  private async load(): Promise<Map<string, WorktreeRegistryEntry>> {
    const entries = new Map<string, WorktreeRegistryEntry>();
    const raw = await readFile(this.file, 'utf-8').catch(() => undefined);
    if (raw !== undefined) {
      try {
        const parsed = registryFileSchema.safeParse(JSON.parse(raw));
        for (const candidate of parsed.success ? parsed.data.worktrees : []) {
          const entry = registryEntrySchema.safeParse(candidate);
          if (entry.success) entries.set(entry.data.path, entry.data);
        }
      } catch {
      }
    }
    return entries;
  }

  private async mutate(change: (entries: Map<string, WorktreeRegistryEntry>) => boolean): Promise<void> {
    const run = this.writes.then(async () => {
      const entries = await this.load();
      if (!change(entries)) return;
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      await writeFile(
        temp,
        `${JSON.stringify({ version: 1, worktrees: [...entries.values()] }, null, 2)}\n`,
        'utf-8',
      );
      await rename(temp, this.file);
    });
    this.writes = run.catch(() => undefined);
    return run;
  }

  async list(): Promise<readonly WorktreeRegistryEntry[]> {
    return [...(await this.load()).values()];
  }

  async get(path: string): Promise<WorktreeRegistryEntry | undefined> {
    return (await this.load()).get(path);
  }

  add(entry: WorktreeRegistryEntry): Promise<void> {
    return this.mutate((entries) => {
      entries.set(entry.path, entry);
      return true;
    });
  }

  setBranch(path: string, branch: string): Promise<void> {
    return this.mutate((entries) => {
      const entry = entries.get(path);
      if (entry === undefined || entry.branch === branch) return false;
      entries.set(path, { ...entry, branch });
      return true;
    });
  }

  remove(path: string): Promise<void> {
    return this.mutate((entries) => entries.delete(path));
  }
}
