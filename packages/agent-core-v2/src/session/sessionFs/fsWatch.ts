/**
 * `sessionFsWatch` domain (L2) — workspace-confined filesystem change feed.
 *
 * Defines the `ISessionFsWatchService` that turns the os `IHostFsWatchService`
 * raw events into a workspace-relative, debounced, `.gitignore`-aware change
 * feed (`FsChangeEvent`) for the session. Callers declare the set of
 * workspace-relative paths they care about; events outside that subtree are
 * dropped. Session-scoped — the scope itself is the session, so no
 * `sessionId` is threaded through.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { FsChangeEvent } from '@moonshot-ai/protocol';

export interface ISessionFsWatchService {
  readonly _serviceBrand: undefined;

  /**
   * Replace the set of workspace-relative paths to observe. `'.'` watches the
   * whole workspace. Passing an empty array stops the underlying watcher.
   * Paths are confined to the workspace; absolute / `..` / escaping inputs
   * throw `FS_PATH_ESCAPES`.
   */
  setWatchedPaths(paths: readonly string[]): void;

  /** Currently observed workspace-relative paths (posix). */
  readonly watchedPaths: readonly string[];

  /**
   * Coalesced change feed. Each event carries the changes for one debounce
   * window; when the window overflows, `changes` is emptied and `truncated`
   * (with `count`) is set so consumers can fall back to a full refresh.
   */
  readonly onDidChangeFiles: Event<FsChangeEvent>;
}

export const ISessionFsWatchService: ServiceIdentifier<ISessionFsWatchService> =
  createDecorator<ISessionFsWatchService>('sessionFsWatchService');
