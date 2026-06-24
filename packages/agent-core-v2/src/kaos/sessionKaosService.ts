/**
 * `kaos` domain (L1) — `ISessionKaosService` (Session) implementation.
 *
 * Owns the session-level tool / persistence kaos and the `additionalDirs`
 * allow-list. The base `toolKaos` is provided by the session bootstrap via
 * `setToolKaos(...)` (kaos creation is async, so it happens outside the DI
 * constructor). `persistenceKaos` defaults to `toolKaos`; `systemContextKaos`
 * is a cwd-pinned view of `persistenceKaos`.
 */

import type { Kaos } from '@moonshot-ai/kaos';

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/log/log';

import { ISessionKaosService } from './kaos';

export class SessionKaosService extends Disposable implements ISessionKaosService {
  declare readonly _serviceBrand: undefined;
  private _toolKaos: Kaos | undefined;
  private _persistenceKaos: Kaos | undefined;
  private _additionalDirs: string[] = [];

  constructor(@ILogService _log: ILogService) {
    super();
  }

  get toolKaos(): Kaos {
    if (this._toolKaos === undefined) {
      throw new Error('SessionKaosService.toolKaos accessed before setToolKaos');
    }
    return this._toolKaos;
  }

  get persistenceKaos(): Kaos {
    return this._persistenceKaos ?? this.toolKaos;
  }

  get systemContextKaos(): Kaos {
    return this.persistenceKaos.withCwd(this.toolKaos.getcwd());
  }

  get additionalDirs(): readonly string[] {
    return this._additionalDirs;
  }

  setToolKaos(kaos: Kaos): void {
    this._toolKaos = kaos;
    if (this._persistenceKaos === undefined) {
      this._persistenceKaos = kaos;
    }
  }

  setPersistenceKaos(kaos: Kaos): void {
    this._persistenceKaos = kaos;
  }

  addAdditionalDir(dir: string): void {
    if (!this._additionalDirs.includes(dir)) {
      this._additionalDirs.push(dir);
    }
  }

  removeAdditionalDir(dir: string): void {
    this._additionalDirs = this._additionalDirs.filter((d) => d !== dir);
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionKaosService,
  SessionKaosService,
  InstantiationType.Delayed,
  'kaos',
);
