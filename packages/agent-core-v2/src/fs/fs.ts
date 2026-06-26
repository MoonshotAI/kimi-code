/**
 * `fs` domain (cross-cutting) — session-scope filesystem services.
 *
 * Defines the public contracts of filesystem access: the `IFsService`,
 * `IFsSearchService`, `IFsGitService`, and `IFsWatcher` used by tools to read
 * and write files, search, inspect git state, and watch paths. Session-scoped
 * — one set of services per session.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IFsService {
  readonly _serviceBrand: undefined;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  stat(path: string): Promise<unknown>;
  mkdir(path: string): Promise<void>;
}

export const IFsService: ServiceIdentifier<IFsService> =
  createDecorator<IFsService>('fsService');

export interface IFsSearchService {
  readonly _serviceBrand: undefined;
  grep(pattern: string, path: string): Promise<readonly unknown[]>;
  glob(pattern: string): Promise<readonly string[]>;
}

export const IFsSearchService: ServiceIdentifier<IFsSearchService> =
  createDecorator<IFsSearchService>('fsSearchService');

export interface IFsGitService {
  readonly _serviceBrand: undefined;
  status(cwd: string): Promise<string>;
  diff(cwd: string): Promise<string>;
  log(cwd: string): Promise<readonly string[]>;
}

export const IFsGitService: ServiceIdentifier<IFsGitService> =
  createDecorator<IFsGitService>('fsGitService');

export interface IFsWatcher {
  readonly _serviceBrand: undefined;
  watch(path: string): void;
  unwatch(path: string): void;
}

export const IFsWatcher: ServiceIdentifier<IFsWatcher> =
  createDecorator<IFsWatcher>('fsWatcher');
