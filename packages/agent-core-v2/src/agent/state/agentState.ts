/**
 * `state` domain (L1) — Agent-scope keyed state container contract.
 *
 * Defines `IAgentStateService`, the Agent-scope state service: Agent-tier
 * services declare their plain-data state as typed keys (`defineState` from
 * `_base`) and read/write them through this container, so per-agent shared
 * state lives in one observable place and dies with the agent. Shares the
 * `IStateRegistry` method set with its App/Workspace/Session counterparts;
 * its `inspect()` cascade continues into the Session tier. Bound at Agent
 * scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IStateRegistry } from '#/_base/state/stateRegistry';

export interface IAgentStateService extends IStateRegistry {
  readonly _serviceBrand: undefined;
}

export const IAgentStateService: ServiceIdentifier<IAgentStateService> =
  createDecorator<IAgentStateService>('agentStateService');
