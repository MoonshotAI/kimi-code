/**
 * `modelFailover` domain (L4) — `IAgentModelFailoverService` contract.
 *
 * Marks the Agent-scoped runtime recovery policy that advances a subagent
 * through its configured model route. Bound at Agent scope.
 */

import { createDecorator } from '#/_base/di/instantiation';

export interface IAgentModelFailoverService {
  readonly _serviceBrand: undefined;
}

export const IAgentModelFailoverService = createDecorator<IAgentModelFailoverService>(
  'agentModelFailoverService',
);
