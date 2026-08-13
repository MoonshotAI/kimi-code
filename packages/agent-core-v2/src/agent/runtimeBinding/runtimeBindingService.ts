import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import type { IDisposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import { IAgentStateService } from '#/agent/state/agentState';
import type { RuntimeBinding } from '#/runtime/runtime';
import { RuntimeError } from '#/runtime/runtimeRegistry';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IRuntimeResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';

import { IAgentRuntimeBindingSeed, IAgentRuntimeBindingService } from './runtimeBinding';
import { RuntimeSetBinding, runtimeBindingKey } from './runtimeBindingOps';

export const agentRuntimeBindingKey = defineState<RuntimeBinding>('runtime.binding', () => ({ workspaceId: '', runtimeId: 'local' }));

export class AgentRuntimeBindingService implements IAgentRuntimeBindingService {
  declare readonly _serviceBrand: undefined;
  private readonly changeEmitter = new Emitter<RuntimeBinding>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly restoreHook: IDisposable;

  constructor(
    @IAgentStateService private readonly state: IAgentStateService,
    @IAgentRuntimeBindingSeed seed: IAgentRuntimeBindingSeed,
    @ISessionContext private readonly session: ISessionContext,
    @IRuntimeResolver private readonly resolver: IRuntimeResolver,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
  ) {
    this.state.contributeState(agentRuntimeBindingKey);
    this.state.contributeState(runtimeBindingKey);
    const initial = this.state.get(runtimeBindingKey) ?? seed.binding;
    this.assertSessionWorkspace(initial);
    this.state.set(agentRuntimeBindingKey, initial);
    this.restoreHook = dispatcher.hooks.onDidRestore.register('agent-runtime-binding', async (_ctx, next) => {
      const replayed = this.state.get(runtimeBindingKey);
      if (replayed === undefined) {
        void this.dispatcher.dispatch(new RuntimeSetBinding(this.current));
      } else {
        this.assertSessionWorkspace(replayed);
        this.state.set(agentRuntimeBindingKey, replayed);
      }
      await next();
    });
  }

  private assertSessionWorkspace(binding: RuntimeBinding): void {
    if (binding.workspaceId !== this.session.workspaceId) {
      throw new RuntimeError(
        'runtime.not_found',
        `runtime binding workspace ${binding.workspaceId} does not match session workspace ${this.session.workspaceId}`,
      );
    }
  }

  get current(): RuntimeBinding {
    return this.state.get(agentRuntimeBindingKey);
  }

  get(): RuntimeBinding {
    return this.current;
  }

  set(binding: RuntimeBinding): RuntimeBinding {
    this.assertSessionWorkspace(binding);
    const lease = this.resolver.acquire(binding, []);
    lease.dispose();
    if (binding.workspaceId === this.current.workspaceId && binding.runtimeId === this.current.runtimeId) {
      return this.current;
    }
    const next = { workspaceId: binding.workspaceId, runtimeId: binding.runtimeId };
    void this.dispatcher.dispatch(new RuntimeSetBinding(next));
    this.state.set(agentRuntimeBindingKey, next);
    this.changeEmitter.fire(next);
    return next;
  }

  switch(runtimeId: string): RuntimeBinding {
    return this.set({ workspaceId: this.session.workspaceId, runtimeId });
  }

  dispose(): void {
    this.restoreHook.dispose();
    this.changeEmitter.dispose();
  }
}

registerScopedService(LifecycleScope.Agent, IAgentRuntimeBindingService, AgentRuntimeBindingService, ScopeActivation.OnScopeCreated, 'agentRuntimeBinding');
