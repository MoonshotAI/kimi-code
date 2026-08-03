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
  readonly path: string;
  readonly action: HostFsChangeAction;
  readonly kind: HostFsChangeKind;
}

export interface HostFsWatchOptions {
  readonly recursive?: boolean;
  readonly ignored?: (path: string) => boolean;
}

export interface IHostFsWatchHandle extends IDisposable {
  readonly onDidChange: Event<HostFsChange>;
}

export interface IHostFsWatchService {
  readonly _serviceBrand: undefined;

  watch(path: string, options?: HostFsWatchOptions): IHostFsWatchHandle;
}

export const IHostFsWatchService: ServiceIdentifier<IHostFsWatchService> =
  createDecorator<IHostFsWatchService>('hostFsWatchService');
