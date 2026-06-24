/**
 * `swarm` domain (L4) — `ISwarmService` implementation.
 *
 * Tracks swarm-mode state. Sub-agent orchestration is wired via
 * `IAgentLifecycleService` in a later step.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentLifecycleService } from '#/agent-lifecycle/agentLifecycle';
import { IPermissionService } from '#/permission/permission';
import { IAgentRecords } from '#/records/records';

import { ISwarmService } from './swarm';

export class SwarmService extends Disposable implements ISwarmService {
  declare readonly _serviceBrand: undefined;
  private isActive = false;

  constructor(
    @IAgentRecords _records: IAgentRecords,
    @IAgentLifecycleService _agentLifecycle: IAgentLifecycleService,
    @IPermissionService _permission: IPermissionService,
  ) {
    super();
  }

  get active(): boolean {
    return this.isActive;
  }

  enter(): Promise<void> {
    this.isActive = true;
    return Promise.resolve();
  }
  exit(): void {
    this.isActive = false;
  }
}

registerScopedService(LifecycleScope.Agent, ISwarmService, SwarmService, InstantiationType.Delayed, 'swarm');
