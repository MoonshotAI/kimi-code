/**
 * `kaos` domain (L1) — `IAgentKaos` (Agent) implementation.
 *
 * Per-agent cwd-scoped kaos view. Starts at the session tool kaos's cwd and
 * re-pins to a new `Kaos` on `chdir` (kaos instances are immutable; `withCwd`
 * returns a new instance). Switching cwd here never mutates the session kaos.
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
