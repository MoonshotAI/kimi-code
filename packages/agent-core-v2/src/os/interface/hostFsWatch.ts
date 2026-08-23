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
