/**
 * `hostFsWatch` domain — local real-filesystem change notifications.
 *
 * Defines the `IHostFsWatchService`, a thin primitive over the host OS file
 * watcher. It reports raw create/modify/delete events under an absolute path
 * and knows nothing about sessions, connections, workspaces or wire frames.
 * `HostFsWatchOptions.signal` marks callers that consume events as a mere
 * "something changed" signal (ignoring action/kind); the backend may then
 * pick a cheaper implementation (one native recursive watch instead of
 * per-node watchers). Signal events may use the watched root as their path
 * and report coarse action/kind values. A handle's `ready` promise resolves
 * after its backend has installed the initial subscription and rejects when
 * initialization fails. App-scoped — one shared instance.
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
  readonly signal?: boolean;
}

export interface IHostFsWatchHandle extends IDisposable {
  readonly ready: Promise<void>;
  readonly onDidChange: Event<HostFsChange>;
}

export interface IHostFsWatchService {
  readonly _serviceBrand: undefined;

  watch(path: string, options?: HostFsWatchOptions): IHostFsWatchHandle;
}

export const IHostFsWatchService: ServiceIdentifier<IHostFsWatchService> =
  createDecorator<IHostFsWatchService>('hostFsWatchService');
