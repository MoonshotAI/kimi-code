import type { IAgentScopeHandle } from '#/_base/di/scope';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { MachineEngineAttachBundle } from '#/agent/loop/machine/engine';
import type { AgentActorRef } from '#human/session/machine';

export class ManagedAgent {
  active = false;
  closing = false;
  ref?: AgentActorRef;
  bundle?: MachineEngineAttachBundle;

  constructor(
    readonly context: AgentContext,
    readonly handle: IAgentScopeHandle,
  ) {}
}
