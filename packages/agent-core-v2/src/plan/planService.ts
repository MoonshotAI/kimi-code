/**
 * `plan` domain (L4) — `IPlanService` implementation.
 *
 * Tracks plan-mode activation; reads configuration through `config`, enqueues
 * follow-up through `injection`, runs processes through `kaos`, persists
 * records through `records`, and observes turns through `turn`. Bound at Agent
 * scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentConfigService } from '#/config/config';
import { IInjectionService } from '#/injection/injection';
import { IAgentKaos } from '#/kaos/kaos';
import { IAgentRecords } from '#/records/records';
import { ITurnService } from '#/turn/turn';

import { IPlanService } from './plan';

export class PlanService extends Disposable implements IPlanService {
  declare readonly _serviceBrand: undefined;
  private isActive = false;

  constructor(
    @IAgentRecords _records: IAgentRecords,
    @IAgentKaos _agentKaos: IAgentKaos,
    @IAgentConfigService _agentConfig: IAgentConfigService,
    @IInjectionService private readonly injection: IInjectionService,
    @ITurnService turn: ITurnService,
  ) {
    super();
    this._register(turn.onDidEndTurn(() => { this.isActive = false; }));
  }

  get active(): boolean {
    return this.isActive;
  }

  enter(): Promise<void> {
    this.isActive = true;
    this.injection.push({ kind: 'plan', content: 'Plan mode active — propose a plan before acting.' });
    return Promise.resolve();
  }
  cancel(): void {
    this.isActive = false;
  }
  exit(): Promise<void> {
    this.isActive = false;
    return Promise.resolve();
  }
  clear(): void {
    this.isActive = false;
  }
}

registerScopedService(LifecycleScope.Agent, IPlanService, PlanService, InstantiationType.Delayed, 'plan');
