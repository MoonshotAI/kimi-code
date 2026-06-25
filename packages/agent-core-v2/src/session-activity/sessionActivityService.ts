/**
 * `session-activity` domain (L6) — `ISessionActivity` implementation.
 *
 * Derives session idleness by checking each agent's turn; drives agent
 * lifecycle through `agent-lifecycle` and observes turns through `turn`. Bound
 * at Session scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentLifecycleService } from '#/agent-lifecycle/agentLifecycle';
import { ITurnService } from '#/turn/turn';

import { ISessionActivity } from './sessionActivity';

export class SessionActivity implements ISessionActivity {
  declare readonly _serviceBrand: undefined;

  constructor(@IAgentLifecycleService private readonly agents: IAgentLifecycleService) {}

  isIdle(): boolean {
    for (const handle of this.agents.list()) {
      const turn = handle.accessor.get(ITurnService);
      if (turn.hasActiveTurn) return false;
    }
    return true;
  }
}

registerScopedService(LifecycleScope.Session, ISessionActivity, SessionActivity, InstantiationType.Delayed, 'session-activity');
