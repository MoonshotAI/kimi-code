export type MemoryScope = 'user' | 'project';
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export interface MemoryRecord {
  readonly name: string;
  readonly description: string;
  readonly type: MemoryType;
}

export interface MemoryEntry {
  readonly record: MemoryRecord;
  readonly body: string;
  readonly scope: MemoryScope;
  readonly path: string;
}

export interface MemoryIndex {
  readonly rendered: string;
  readonly entries: readonly MemoryEntry[];
  readonly droppedSlugs: readonly string[];
}

export interface MemoryStore {
  list(scope: MemoryScope): Promise<readonly MemoryEntry[]>;
  read(scope: MemoryScope, slug: string): Promise<MemoryEntry | undefined>;
  write(scope: MemoryScope, record: MemoryRecord, body: string): Promise<MemoryEntry>;
  update(
    scope: MemoryScope,
    slug: string,
    patch: {
      readonly record?: Partial<MemoryRecord>;
      readonly body?: string;
    },
  ): Promise<MemoryEntry>;
  delete(scope: MemoryScope, slug: string): Promise<boolean>;
  rootFor(scope: MemoryScope): string;
}
