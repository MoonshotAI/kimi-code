import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import type { IDisposable } from '#/_base/di/lifecycle';
import { ISessionEventBus } from '#/app/event/eventBus';
import { LifecycleScope } from '#/app/scopes';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { Runtime, RuntimeBinding, RuntimeCapability, RuntimeLease } from '#/runtime/runtime';
import { RuntimeError, runtimeStatusAllows, type RuntimeGenerationSnapshot } from '#/runtime/runtimeRegistry';
import {
  IRuntimeResolver,
  IWorkspaceInstanceManager,
} from '#/workspace/workspaceInstance/workspaceInstanceManager';

import { IAgentRuntimeBindingService } from './runtimeBinding';

export interface AgentRuntimeBindingSnapshot {
  readonly binding: RuntimeBinding;
  readonly available: boolean;
  readonly runtime?: RuntimeGenerationSnapshot;
}

export interface IAgentRuntimeService {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<void>;
  inspect(): Runtime;
  isAvailable(required?: readonly RuntimeCapability[]): boolean;
  acquire(required?: readonly RuntimeCapability[]): RuntimeLease;
}

export const IAgentRuntimeService: ServiceIdentifier<IAgentRuntimeService> =
  createDecorator<IAgentRuntimeService>('agentRuntimeService');

export function inspectAgentRuntime(service: IAgentRuntimeService): Runtime {
  return service.inspect();
}

export function snapshotAgentRuntimeBinding(
  bindingService: IAgentRuntimeBindingService,
  runtimeService: IAgentRuntimeService,
): AgentRuntimeBindingSnapshot {
  const binding = bindingService.current;
  try {
    const runtime = runtimeService.inspect();
    return {
      binding,
      available: runtimeService.isAvailable(),
      runtime: {
        runtimeId: runtime.identity.runtimeId,
        generation: runtime.identity.generation,
        status: runtime.status,
        capabilities: [...runtime.capabilities],
      },
    };
  } catch {
    return { binding, available: false };
  }
}

interface TurnRuntimeSnapshot {
  readonly binding: RuntimeBinding;
  readonly generation?: string;
}

export class AgentRuntimeService implements IAgentRuntimeService {
  declare readonly _serviceBrand: undefined;
  private readonly changeEmitter = new Emitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly bindingSubscription: IDisposable;
  private readonly workspaceSubscription: IDisposable;
  private readonly turnSubscriptions: readonly IDisposable[];
  private registrySubscription: IDisposable | undefined;
  private turnSnapshot: TurnRuntimeSnapshot | undefined;

  constructor(
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentRuntimeBindingService private readonly binding: IAgentRuntimeBindingService,
    @IRuntimeResolver private readonly resolver: IRuntimeResolver,
    @IWorkspaceInstanceManager private readonly workspaces: IWorkspaceInstanceManager,
    @ISessionEventBus private readonly eventBus: ISessionEventBus,
  ) {
    this.bindingSubscription = this.binding.onDidChange(() => this.rebind());
    this.workspaceSubscription = this.workspaces.onDidChange((change) => {
      if (change.workspaceId === this.binding.current.workspaceId) this.rebind();
    });
    this.turnSubscriptions = [
      this.eventBus.subscribe(TurnStarted, (event) => {
        if (event.agentId !== this.scopeContext.agentId) return;
        this.turnSnapshot = {
          binding: this.binding.current,
          generation: this.currentGeneration(this.binding.current),
        };
      }),
      this.eventBus.subscribe(TurnEnded, (event) => {
        if (event.agentId !== this.scopeContext.agentId) return;
        this.turnSnapshot = undefined;
      }),
    ];
    this.bindRegistry();
  }

  inspect(): Runtime {
    return this.resolver.inspect(this.binding.current);
  }

  isAvailable(required: readonly RuntimeCapability[] = []): boolean {
    try {
      const runtime = this.inspect();
      return runtimeStatusAllows(runtime, required) && required.every((capability) => runtime.capabilities.has(capability));
    } catch {
      return false;
    }
  }

  acquire(required: readonly RuntimeCapability[] = []): RuntimeLease {
    const snapshot = this.turnSnapshot;
    if (snapshot === undefined) {
      return this.resolver.acquire(this.binding.current, required);
    }
    if (this.currentGeneration(snapshot.binding) !== snapshot.generation) {
      throw new RuntimeError(
        'runtime.unavailable',
        `runtime ${snapshot.binding.runtimeId} generation changed during the active turn`,
      );
    }
    return this.resolver.acquire(snapshot.binding, required);
  }

  dispose(): void {
    for (const subscription of this.turnSubscriptions) subscription.dispose();
    this.registrySubscription?.dispose();
    this.workspaceSubscription.dispose();
    this.bindingSubscription.dispose();
    this.changeEmitter.dispose();
  }

  private currentGeneration(binding: RuntimeBinding): string | undefined {
    return this.workspaces.get(binding.workspaceId)?.runtimes.current(binding.runtimeId)?.identity.generation;
  }

  private rebind(): void {
    this.bindRegistry();
    this.changeEmitter.fire();
  }

  private bindRegistry(): void {
    this.registrySubscription?.dispose();
    const binding = this.binding.current;
    const workspace = this.workspaces.get(binding.workspaceId);
    this.registrySubscription = workspace?.runtimes.onDidChange((change) => {
      if (change.runtimeId !== this.binding.current.runtimeId) return;
      const current = workspace.runtimes.current(change.runtimeId);
      if (change.current !== undefined && change.current !== current) return;
      this.changeEmitter.fire();
    });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentRuntimeService,
  AgentRuntimeService,
  ScopeActivation.OnDemand,
  'agentRuntimeBinding',
);
