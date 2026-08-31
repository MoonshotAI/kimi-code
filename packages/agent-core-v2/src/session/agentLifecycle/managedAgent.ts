import type { IAgentScopeHandle } from '#/_base/di/scope';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { AgentSpaceImpl } from '#/agent/agentContext/agentSpace';
import type { AgentRuntimeDefinitionRecord } from '#/agent/runtime/agentRuntime';
import { AgentRuntimeSet } from '#/agent/runtime/agentRuntimeSet';
import { IEventDispatcher } from '#/state/eventDispatcher';

export class ManagedAgent {
  active = false;
  closing = false;
  readonly runtimeSet: AgentRuntimeSet;

  constructor(
    readonly context: AgentContext,
    readonly handle: IAgentScopeHandle,
    records: readonly AgentRuntimeDefinitionRecord[],
  ) {
    this.runtimeSet = new AgentRuntimeSet(context, handle.accessor);
    for (const record of records) this.runtimeSet.apply(record);
  }

  attachDurableRuntimes(): void {
    this.runtimeSet.attachDurable(this.handle.accessor.get(IEventDispatcher));
  }

  killSpace(): void {
    const space = this.context.space;
    if (space instanceof AgentSpaceImpl) space._kill();
  }
}
