/**
 * `sessionMetaStore` domain (L2) — `ISessionMetaStore` implementation.
 *
 * Persists session metadata as a single atomic document through the program
 * side `storage` (`IConfigStore`). Bound at Session scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/log';
import { IConfigStore } from '#/storage';

import { ISessionMetaStore } from './sessionMetaStore';

const SCOPE = 'session-meta';

export class SessionMetaStore extends Disposable implements ISessionMetaStore {
  declare readonly _serviceBrand: undefined;
  private data: Record<string, unknown> = {};
  private readonly key: string;

  constructor(
    @IConfigStore private readonly configStore: IConfigStore,
    @ILogService _log: ILogService,
    key: string = 'state.json',
  ) {
    super();
    this.key = key;
  }

  async read(): Promise<Record<string, unknown>> {
    this.data =
      (await this.configStore.get<Record<string, unknown>>(SCOPE, this.key)) ?? {};
    return this.data;
  }

  async write(patch: Record<string, unknown>): Promise<void> {
    this.data = { ...this.data, ...patch };
    await this.flush();
  }

  async flush(): Promise<void> {
    await this.configStore.set(SCOPE, this.key, this.data);
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionMetaStore,
  SessionMetaStore,
  InstantiationType.Delayed,
  'records',
);
