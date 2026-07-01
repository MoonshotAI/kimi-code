/**
 * `kaos` domain (L1) — `IAgentKaos` implementation.
 *
 * Exposes the agent's active `Kaos` instance and working directory, and
 * switches the working directory on `chdir`. Bound at Agent scope.
 */

import type { Kaos } from '@moonshot-ai/kaos';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { IAgentKaos, ISessionKaosService } from './kaos';

export class AgentKaos implements IAgentKaos {
  declare readonly _serviceBrand: undefined;
  private _kaos: Kaos;

  constructor(@ISessionKaosService sessionKaos: ISessionKaosService) {
    this._kaos = sessionKaos.toolKaos;
  }

  get kaos(): Kaos {
    return this._kaos;
  }

  get cwd(): string {
    return this._kaos.getcwd();
  }

  chdir(cwd: string): Promise<void> {
    this._kaos = this._kaos.withCwd(cwd);
    return Promise.resolve();
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentKaos,
  AgentKaos,
  InstantiationType.Delayed,
  'kaos',
);
