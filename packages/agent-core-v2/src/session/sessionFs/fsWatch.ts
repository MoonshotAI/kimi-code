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

  setWatchedPaths(paths: readonly string[]): void;

  readonly watchedPaths: readonly string[];

  readonly onDidChangeFiles: Event<FsChangeEvent>;
}

export const ISessionFsWatchService: ServiceIdentifier<ISessionFsWatchService> =
  createDecorator<ISessionFsWatchService>('sessionFsWatchService');
