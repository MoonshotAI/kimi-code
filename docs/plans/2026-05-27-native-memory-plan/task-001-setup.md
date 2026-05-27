# Task 001 — Setup foundation: find-project-root helper + memory module skeleton

**Subject**: Setup shared `findProjectRoot` helper and memory module skeleton (types, slug, format, store interface, loader signature).
**Type**: setup
**Depends-on**: []

## Why this task exists

The memory subsystem needs a shared `findProjectRoot` helper (currently duplicated between `profile/context.ts` and `skill/scanner.ts`) and a skeleton of empty type/interface/signature files so the test tasks (002t–010t) can import a real module surface to test against. This task creates the surfaces — no logic.

No direct BDD scenario maps to this task (it is pure infrastructure). All downstream tasks consume the module surfaces created here.

## Files to create

- `packages/agent-core/src/memory/find-project-root.ts` — shared `findProjectRoot(kaos, workDir)` helper, extracted from the two duplicated copies.
- `packages/agent-core/src/memory/types.ts` — type definitions (no bodies).
- `packages/agent-core/src/memory/slug.ts` — slug regex and validator signature.
- `packages/agent-core/src/memory/format.ts` — `parseMemoryFile` and `renderMemoryFile` signatures.
- `packages/agent-core/src/memory/store.ts` — `MemoryStore` interface + empty `FileMemoryStore` class shell implementing the interface (each method body throws `new Error('not implemented')`).
- `packages/agent-core/src/memory/loader.ts` — `loadMemory(kaos, workDir): Promise<string>` and `renderIndex(entries, budget): string` signatures.
- `packages/agent-core/src/memory/index.ts` — `export * from './types'; export * from './slug'; ...`

## Files to modify

- `packages/agent-core/src/profile/context.ts` — replace inline `findProjectRoot` (lines 77–87) with `import { findProjectRoot } from '#/memory/find-project-root'`.
- `packages/agent-core/src/skill/scanner.ts` — replace inline `findProjectRoot` (lines 338–347) with the same import.

## Interface contracts (signatures only — NO function bodies)

```ts
// packages/agent-core/src/memory/types.ts

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
```

```ts
// packages/agent-core/src/memory/slug.ts
export const SLUG_PATTERN: RegExp;
export function isValidSlug(slug: string): boolean;
```

```ts
// packages/agent-core/src/memory/format.ts
export function parseMemoryFile(scope: MemoryScope, path: string, text: string): MemoryEntry | undefined;
export function renderMemoryFile(record: MemoryRecord, body: string): string;
```

```ts
// packages/agent-core/src/memory/loader.ts
export const MEMORY_INDEX_MAX_BYTES = 8 * 1024;
export const MEMORY_BODY_MAX_BYTES  = 4 * 1024;
export function loadMemory(kaos: Kaos, workDir: string): Promise<string>;
export function renderIndex(entries: readonly MemoryEntry[], budget: number): MemoryIndex;
```

```ts
// packages/agent-core/src/memory/find-project-root.ts
export function findProjectRoot(kaos: Kaos, workDir: string): Promise<string>;
```

## Verification

- `pnpm typecheck` passes (no broken signatures across the workspace).
- `pnpm test packages/agent-core/test/profile/context.test.ts` still passes (existing AGENTS.md tests unaffected by the shared `findProjectRoot` extraction).
- `pnpm test packages/agent-core/test/skill` still passes (skill scanner unaffected).
- `grep -rn "findProjectRoot" packages/agent-core/src/` shows the helper imported from one location only.
