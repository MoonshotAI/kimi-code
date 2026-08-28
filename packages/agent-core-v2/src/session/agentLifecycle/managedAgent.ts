import type { ServicesAccessor } from '#/_base/di/instantiation';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { AgentHost } from '#/agent/host/agentHost';
import type { AgentRuntimeDefinitionRecord } from '#/agent/runtime/agentRuntime';
import { AgentRuntimeSet } from '#/agent/runtime/agentRuntimeSet';

export class ManagedAgent {
  active = false;
  closing = false;
  readonly runtimeSet: AgentRuntimeSet;

  constructor(
    readonly context: AgentContext,
    readonly host: AgentHost,
    accessor: ServicesAccessor,
    records: readonly AgentRuntimeDefinitionRecord[],
  ) {
    this.runtimeSet = new AgentRuntimeSet(context, accessor, () => host.dispatcher);
    for (const record of records) this.runtimeSet.apply(record);
  }

  attachDurableRuntimes(): void {
    this.runtimeSet.attachDurable(this.host.dispatcher);
  }
}
