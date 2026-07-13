/**
 * `hostFsWatch` domain (L1) — local real-filesystem change notifications.
 *
 * Defines the `IHostFsWatchService`, a thin primitive over the host OS file
 * watcher. It reports raw create/modify/delete events under an absolute path
 * and knows nothing about sessions, connections, workspaces or wire frames.
 * App-scoped — one shared instance. Higher layers (e.g. `sessionFsWatch`)
 * subscribe, confine events to a workspace, debounce/coalesce and re-expose
 * them as domain events.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { IDisposable } from '#/_base/di/lifecycle';

export type HostFsChangeKind = 'file' | 'directory';
export type HostFsChangeAction = 'created' | 'modified' | 'deleted';

export interface HostFsChange {
  /** Absolute path that changed. */
  readonly path: string;
  readonly action: HostFsChangeAction;
  readonly kind: HostFsChangeKind;
}

export interface HostFsWatchOptions {
  /** Watch recursively into subdirectories. Defaults to `true`. */
  readonly recursive?: boolean;
  /**
   * Predicate returning `true` for paths the watcher should ignore. Defaults
   * to a filter that suppresses `.git` directories. Replaces the default when
   * provided.
   */
  readonly ignored?: (path: string) => boolean;
}

/** A live watch subscription. Dispose to stop receiving events. */
export interface IHostFsWatchHandle extends IDisposable {
  readonly onDidChange: Event<HostFsChange>;
}

export interface IHostFsWatchService {
  readonly _serviceBrand: undefined;

  /**
   * Watch `path` (absolute, file or directory) and return a handle that fires
   * for changes beneath it. Synchronous — the underlying watcher is armed
   * immediately; dispose the handle to stop.
   */
  watch(path: string, options?: HostFsWatchOptions): IHostFsWatchHandle;
}

export const IHostFsWatchService: ServiceIdentifier<IHostFsWatchService> =
  createDecorator<IHostFsWatchService>('hostFsWatchService');
