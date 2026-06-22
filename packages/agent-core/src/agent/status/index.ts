import type { UsageStatus } from '#/rpc';

import { createDecorator } from '../../_base/di';
import type { IDomainEventBus } from '../../event/event-bus';
import type { IAgentConfigService } from '../config';
import type { IContextService } from '../context';
import type { IPermissionService } from '../permission';
import type { IPlanService } from '../plan';
import type { IRecordsService } from '../records';
import type { ISwarmService } from '../swarm';
import type { IUsageService } from '../usage';

/**
 * Narrow read-only view of the agent that {@link AgentStatusService} needs in
 * order to build the `agent.status.updated` payload. `Agent` satisfies this
 * structurally, but the service depends only on this interface — never on the
 * concrete `Agent` class — so tests can drive it with a plain stub.
 *
 * All fields are read lazily inside `notifyStatusChanged()` (after the agent
 * has finished constructing), which is why this host can be handed to the
 * service before the underlying services have been resolved.
 */
export interface AgentStatusHost {
  readonly records: IRecordsService;
  readonly config: IAgentConfigService;
  readonly context: IContextService;
  readonly usage: IUsageService;
  readonly planMode: IPlanService;
  readonly swarmMode: ISwarmService;
  readonly permission: IPermissionService;
  readonly eventBus: IDomainEventBus;
}

export interface IAgentStatusService {
  readonly _serviceBrand: undefined;

  /**
   * Recompute and publish the `agent.status.updated` event. Callers (plan /
   * swarm / usage / context / config / permission) invoke this after mutating
   * status-driving state; the event payload and the conditions under which it
   * fires are identical to the former `Agent.emitStatusUpdated()`.
   */
  notifyStatusChanged(): void;
}

export const IAgentStatusService = createDecorator<IAgentStatusService>('agentStatusService');

export class AgentStatusService implements IAgentStatusService {
  readonly _serviceBrand: undefined;

  constructor(private readonly host: AgentStatusHost) {}

  notifyStatusChanged(): void {
    const { records, config, context, usage, planMode, swarmMode, permission, eventBus } = this.host;
    if (records.restoring) return;
    if (!config.hasModel) return;

    const contextTokens = context.tokenCount;
    const maxContextTokens = config.modelCapabilities.max_context_tokens;
    const contextUsage =
      maxContextTokens !== undefined && maxContextTokens > 0
        ? contextTokens / maxContextTokens
        : undefined;
    const usageStatus: UsageStatus | undefined = usage.status();
    const model = config.model;

    eventBus.publish({
      type: 'agent.status.updated',
      model,
      contextTokens,
      maxContextTokens,
      contextUsage,
      planMode: planMode.isActive,
      swarmMode: swarmMode.isActive,
      permission: permission.mode,
      usage: usageStatus,
    });
  }
}
