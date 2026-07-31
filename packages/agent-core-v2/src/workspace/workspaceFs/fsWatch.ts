/**
 * `workspaceFs` domain (L3) — workspace-confined filesystem change feed.
 *
 * Defines the `IWorkspaceFsWatchService` that turns the os
 * `IHostFsWatchService` raw events into a workspace-relative, debounced,
 * `.gitignore`-aware change feed (`FsChangeEvent`) for the whole handler.
 * One os watcher on the workspace root is shared by every subscriber —
 * subscribers are the sessions of this workspace (via the transport's
 * fs-watch bridge) and any Workspace-scope service that wants change
 * notifications. Each subscription declares the set of workspace-relative
 * paths it cares about; events outside that subtree are dropped, and every
 * subscription gets its own debounce window and truncation counters, so a
 * per-session feed through a subscription is indistinguishable from the old
 * per-session watch service. Workspace-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
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

export interface IWorkspaceFsWatchSubscription extends IDisposable {
  setWatchedPaths(paths: readonly string[]): void;

  readonly watchedPaths: readonly string[];

  readonly onDidChangeFiles: Event<FsChangeEvent>;
}

export interface IWorkspaceFsWatchService {
  readonly _serviceBrand: undefined;

  subscribe(): IWorkspaceFsWatchSubscription;
}

export const IWorkspaceFsWatchService: ServiceIdentifier<IWorkspaceFsWatchService> =
  createDecorator<IWorkspaceFsWatchService>('workspaceFsWatchService');
