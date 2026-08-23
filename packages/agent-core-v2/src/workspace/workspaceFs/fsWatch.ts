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
