import type { ServicesAccessor } from '#/_base/di/instantiation';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { AgentHost } from '#/agent/host/agentHost';
import type { AgentRuntimeDefinitionRecord } from '#/actor/agentRuntime';
import { AgentRuntimeHost, type AgentRuntimeHostCloseHandlers } from '#/actor/internal/agentRuntimeHost';

export class ManagedAgent {
  active = false;
  closing = false;
  readonly runtimeHost: AgentRuntimeHost;

  get runtimeSet() {
    return this.runtimeHost.runtimeSet;
  }

  get host() {
    return this.runtimeHost.host;
  }

  constructor(
    readonly context: AgentContext,
    host: AgentHost,
    accessor: ServicesAccessor,
    records: readonly AgentRuntimeDefinitionRecord[],
    handlers: AgentRuntimeHostCloseHandlers = { onWillClose: () => {}, onDidClose: () => {} },
  ) {
    this.runtimeHost = AgentRuntimeHost.create(context, host, accessor, records, handlers);
  }

  attachDurableRuntimes(): void {
    this.runtimeSet.attachDurable(this.host.dispatcher);
  }
}
