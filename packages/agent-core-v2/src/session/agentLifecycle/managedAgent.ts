import type { IAgentScopeHandle } from '#/_base/di/scope';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { AgentSpaceImpl } from '#/agent/agentContext/agentSpace';

export class ManagedAgent {
  active = false;
  closing = false;

  constructor(
    readonly context: AgentContext,
    readonly handle: IAgentScopeHandle,
  ) {}

  killSpace(): void {
    const space = this.context.space;
    if (space instanceof AgentSpaceImpl) space._kill();
  }
}
