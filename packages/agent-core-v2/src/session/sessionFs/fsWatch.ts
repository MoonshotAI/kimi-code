/**
 * `sessionFsWatch` domain (L2) — workspace-confined filesystem change feed.
 *
 * Defines the `ISessionFsWatchService` that turns the os `IHostFsWatchService`
 * raw events into a workspace-relative, debounced, `.gitignore`-aware change
 * feed (`FsChangeEvent`) for the session. Callers declare the set of
 * workspace-relative paths they care about; events outside that subtree are
 * dropped. Session-scoped — the scope itself is the session, so no
 * `sessionId` is threaded through.
 *
 * Beyond the change feed, every confined change entry is folded into a
 * per-session dirty state for optimistic-concurrency consumers
 * (`sessionFileLedger`): a monotonic `currentTick` incremented per processed
 * entry, immediate per-path dirty ticks independent of debounce delivery, and
 * per-root dirty ticks for truncated windows whose exact paths were dropped.
 * Client subscriptions (`setWatchedPaths`, replace semantics) and
 * optimistic-concurrency watch anchors (`ensureWatchedRoots`, additive,
 * absolute) are independent sets so neither side can clobber the other;
 * `watchedRoots` reports the union as absolute paths.
 *
 * Also owns the lexical key helpers shared with the ledger so both sides key
 * paths identically: `normalizeFsWatchKey` (lexical normalize only, no
 * `realpath`; case-folded on macOS/Windows) and `isFsWatchKeyWithin`
 * (separator-bounded prefix containment on normalized keys).
 */

import { normalize, sep } from 'node:path';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

export type FsChangeKind = 'file' | 'directory' | 'symlink';

export type FsChangeAction = 'created' | 'modified' | 'deleted';

export interface FsChangeEntry {
  path: string;
  change: FsChangeAction;
  kind: FsChangeKind;
  size_delta?: number | undefined;
  etag?: string | undefined;
}

export interface FsChangeEvent {
  changes: FsChangeEntry[];
  coalesced_window_ms: number;
  truncated?: boolean | undefined;
  count?: number | undefined;
}

const FS_WATCH_KEY_CASE_FOLD = process.platform === 'darwin' || process.platform === 'win32';

export function normalizeFsWatchKey(path: string): string {
  const normalized = normalize(path).split(sep).join('/');
  return FS_WATCH_KEY_CASE_FOLD ? normalized.toLowerCase() : normalized;
}

export function isFsWatchKeyWithin(key: string, rootKey: string): boolean {
  if (key === rootKey) return true;
  const prefix = rootKey.endsWith('/') ? rootKey : `${rootKey}/`;
  return key.startsWith(prefix);
}

export interface ISessionFsWatchService {
  readonly _serviceBrand: undefined;

  setWatchedPaths(paths: readonly string[]): void;

  readonly watchedPaths: readonly string[];

  ensureWatchedRoots(roots: readonly string[]): void;

  readonly watchedRoots: readonly string[];

  readonly currentTick: number;

  dirtyTickFor(path: string): number | undefined;

  rootDirtyTickFor(root: string): number | undefined;

  readonly onDidChangeFiles: Event<FsChangeEvent>;
}

export const ISessionFsWatchService: ServiceIdentifier<ISessionFsWatchService> =
  createDecorator<ISessionFsWatchService>('sessionFsWatchService');
