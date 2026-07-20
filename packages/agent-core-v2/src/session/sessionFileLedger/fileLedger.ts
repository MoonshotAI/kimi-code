/**
 * `sessionFileLedger` domain (L2) — per-session optimistic-concurrency ledger.
 *
 * Defines the `ISessionFileLedger` that remembers, per normalized absolute
 * path, the on-disk stat tuple (`ino`, `mtimeMs`, `size`, existence) this
 * session last successfully read or wrote, together with the
 * `sessionFsWatch` tick captured when that revision is recorded. Before every Write/Edit,
 * `compare` stats the target again and compares the tuple directly; live dirty
 * signals classify watcher echoes and truncated windows but are never the
 * correctness gate. This avoids both debounce latency and delayed watcher
 * delivery turning into a stale-write allowance.
 *
 * The verdict drives the write-path policy: `clean` lets the call through,
 * `stale` means the file diverged since the baseline (or a path-level dirty
 * signal hit with no baseline at all), and `no-baseline` means the target
 * exists on disk but this session never read or wrote it (the read-first
 * case). New-file creation is always `clean`.
 *
 * The ledger is in-memory only: never persisted, never journaled, never part
 * of diagnostics. `resume` and `fork` therefore start from an empty ledger
 * and conservatively require a fresh read before editing existing files.
 * Baselines refresh only on successful Read/Write/Edit executions, and only
 * full reads of the target file count. Keys are lexical
 * `normalizeFsWatchKey`s — no `realpath`, so symlink aliases to the same
 * inode are an accepted residual gap. Session-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type FileStatTuple =
  | { readonly exists: false }
  | {
      readonly exists: true;
      readonly ino?: number;
      readonly mtimeMs?: number;
      readonly size: number;
    };

export function fileStatTuplesEqual(a: FileStatTuple, b: FileStatTuple): boolean {
  if (a.exists !== b.exists) return false;
  if (!a.exists || !b.exists) return true;
  return a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

export type FileLedgerVerdict = 'clean' | 'stale' | 'no-baseline';

export interface ISessionFileLedger {
  readonly _serviceBrand: undefined;

  recordBaseline(path: string, revision: FileStatTuple): void;

  compare(path: string): Promise<FileLedgerVerdict>;
}

export const ISessionFileLedger: ServiceIdentifier<ISessionFileLedger> =
  createDecorator<ISessionFileLedger>('sessionFileLedger');
