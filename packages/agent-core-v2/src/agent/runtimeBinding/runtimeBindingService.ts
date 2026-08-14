import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import { Emitter } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import { IAgentStateService } from '#/agent/state/agentState';
import type { RuntimeBinding } from '#/runtime/runtime';
import { RuntimeError } from '#/runtime/runtimeRegistry';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IRuntimeResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { IWireService } from '#/wire/wire';

import { IAgentRuntimeBindingSeed, IAgentRuntimeBindingService } from './runtimeBinding';
import { RuntimeBindingModel, setRuntimeBinding } from './runtimeBindingOps';

export const agentRuntimeBindingKey = defineState<RuntimeBinding>('runtime.binding', () => ({ workspaceId: '', runtimeId: 'local' }));

export class AgentRuntimeBindingService implements IAgentRuntimeBindingService {
  declare readonly _serviceBrand: undefined;
  private readonly changeEmitter = new Emitter<RuntimeBinding>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    @IAgentStateService private readonly state: IAgentStateService,
    @IAgentRuntimeBindingSeed seed: IAgentRuntimeBindingSeed,
    @ISessionContext private readonly session: ISessionContext,
    @IRuntimeResolver private readonly resolver: IRuntimeResolver,
    @IWireService private readonly wire: IWireService,
  ) {
    this.state.register(agentRuntimeBindingKey);
    const restored = this.wire.getModel(RuntimeBindingModel);
    const initial = restored ?? seed.binding;
    if (initial.workspaceId !== this.session.workspaceId) {
      throw new RuntimeError(
        'runtime.not_found',
        `runtime binding workspace ${initial.workspaceId} does not match session workspace ${this.session.workspaceId}`,
      );
    }
    this.state.set(agentRuntimeBindingKey, initial);
    if (restored === undefined) this.wire.dispatch(setRuntimeBinding(initial));
  }

  get current(): RuntimeBinding {
    return this.state.get(agentRuntimeBindingKey);
  }

  get(): RuntimeBinding {
    return this.current;
  }

  set(binding: RuntimeBinding): RuntimeBinding {
    if (binding.workspaceId !== this.session.workspaceId) {
      throw new RuntimeError(
        'runtime.not_found',
        `runtime binding workspace ${binding.workspaceId} does not match session workspace ${this.session.workspaceId}`,
      );
    }
    const lease = this.resolver.acquire(binding, []);
    lease.dispose();
    if (binding.workspaceId === this.current.workspaceId && binding.runtimeId === this.current.runtimeId) {
      return this.current;
    }
    const next = { workspaceId: binding.workspaceId, runtimeId: binding.runtimeId };
    this.wire.dispatch(setRuntimeBinding(next));
    this.state.set(agentRuntimeBindingKey, next);
    this.changeEmitter.fire(next);
    return next;
  }

  switch(runtimeId: string): RuntimeBinding {
    return this.set({ workspaceId: this.session.workspaceId, runtimeId });
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

registerScopedService(LifecycleScope.Agent, IAgentRuntimeBindingService, AgentRuntimeBindingService, ScopeActivation.OnDemand, 'agentRuntimeBinding');
