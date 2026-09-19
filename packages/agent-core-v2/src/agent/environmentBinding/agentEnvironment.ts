import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import type { IDisposable } from '#/_base/di/lifecycle';
import { ISessionEventBus } from '#/app/event/eventBus';
import { LifecycleScope } from '#/app/scopes';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { Environment, EnvironmentBinding, EnvironmentCapability, EnvironmentLease, EnvironmentWorkspaceRoots } from '#/environment/environment';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
import { EnvironmentError, environmentStatusAllows, type EnvironmentGenerationSnapshot, type EnvironmentRegistryChange } from '#/environment/environmentRegistry';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionStateService } from '#/session/state/sessionState';
import {
  workspaceContextAdditionalDirsKey,
} from '#/session/workspaceContext/workspaceContextService';
import {
  IEnvironmentResolver,
  IWorkspaceInstanceManager,
} from '#/workspace/workspaceInstance/workspaceInstanceManager';

import { IAgentEnvironmentBindingService } from './environmentBinding';
import { EnvironmentStatusChanged } from './environmentEvents';

export interface AgentEnvironmentBindingSnapshot {
  readonly binding: EnvironmentBinding;
  readonly available: boolean;
  readonly environment?: EnvironmentGenerationSnapshot;
}

export interface IAgentEnvironmentService {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<void>;
  inspect(): Environment;
  isAvailable(required?: readonly EnvironmentCapability[]): boolean;
  acquire(required?: readonly EnvironmentCapability[]): EnvironmentLease;
  acquireWhenReady(required?: readonly EnvironmentCapability[]): Promise<EnvironmentLease>;
  reconnect(): Promise<void>;
  workspaceRoots(): EnvironmentWorkspaceRoots;
}

export const IAgentEnvironmentService: ServiceIdentifier<IAgentEnvironmentService> =
  createDecorator<IAgentEnvironmentService>('agentEnvironmentService');

export function inspectAgentEnvironment(service: IAgentEnvironmentService): Environment {
  return service.inspect();
}

export function snapshotAgentEnvironmentBinding(
  bindingService: IAgentEnvironmentBindingService,
  environmentService: IAgentEnvironmentService,
): AgentEnvironmentBindingSnapshot {
  const binding = bindingService.current;
  try {
    const environment = environmentService.inspect();
    return {
      binding,
      available: environmentService.isAvailable(),
      environment: {
        environmentId: environment.identity.environmentId,
        generation: environment.identity.generation,
        status: environment.status,
        capabilities: [...environment.capabilities],
        connectError: environment.connectError,
      },
    };
  } catch {
    return { binding, available: false };
  }
}

interface TurnEnvironmentSnapshot {
  readonly binding: EnvironmentBinding;
  readonly generation?: string;
}

export class AgentEnvironmentService implements IAgentEnvironmentService {
  declare readonly _serviceBrand: undefined;
  private readonly changeEmitter = new Emitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly bindingSubscription: IDisposable;
  private readonly workspaceSubscription: IDisposable;
  private readonly turnSubscriptions: readonly IDisposable[];
  private registrySubscription: IDisposable | undefined;
  private turnSnapshot: TurnEnvironmentSnapshot | undefined;
  private turnLease: EnvironmentLease | undefined;

  constructor(
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentEnvironmentBindingService private readonly binding: IAgentEnvironmentBindingService,
    @IEnvironmentResolver private readonly resolver: IEnvironmentResolver,
    @IWorkspaceInstanceManager private readonly workspaces: IWorkspaceInstanceManager,
    @ISessionEventBus private readonly eventBus: ISessionEventBus,
    @ISessionContext private readonly session: ISessionContext,
    @ISessionStateService private readonly sessionState: ISessionStateService,
  ) {
    this.bindingSubscription = this.binding.onDidChange(() => this.rebind());
    this.workspaceSubscription = this.workspaces.onDidChange((change) => {
      if (change.workspaceId === this.binding.current.workspaceId) this.rebind();
    });
    this.turnSubscriptions = [
      this.eventBus.subscribe(TurnStarted, (event) => {
        if (event.agentId !== this.scopeContext.agentId) return;
        const binding = this.binding.current;
        this.turnSnapshot = {
          binding,
          generation: this.readyGeneration(binding),
        };
        this.holdTurnLease();
      }),
      this.eventBus.subscribe(TurnEnded, (event) => {
        if (event.agentId !== this.scopeContext.agentId) return;
        this.turnSnapshot = undefined;
        this.releaseTurnLease();
      }),
    ];
    this.bindRegistry();
  }

  inspect(): Environment {
    return this.resolver.inspect(this.binding.current);
  }

  async reconnect(): Promise<void> {
    const environment = this.resolver.inspect(this.binding.current);
    if (typeof environment.connect !== 'function') {
      throw new EnvironmentError(
        'environment.unavailable',
        `environment ${this.binding.current.environmentId} does not support reconnect`,
      );
    }
    await environment.connect();
  }

  workspaceRoots(): EnvironmentWorkspaceRoots {
    const binding = this.turnSnapshot?.binding ?? this.binding.current;
    return {
      workDir: binding.cwd ?? this.session.cwd,
      additionalDirs:
        binding.environmentId === LOCAL_ENVIRONMENT_ID
          ? this.sessionState.get(workspaceContextAdditionalDirsKey)
          : [],
    };
  }

  isAvailable(required: readonly EnvironmentCapability[] = []): boolean {
    try {
      const environment = this.inspect();
      return environmentStatusAllows(environment, required) && required.every((capability) => environment.capabilities.has(capability));
    } catch {
      return false;
    }
  }

  acquire(required: readonly EnvironmentCapability[] = []): EnvironmentLease {
    const snapshot = this.turnSnapshot;
    if (snapshot === undefined) {
      return this.resolver.acquire(this.binding.current, required);
    }
    this.assertPinnedGeneration(snapshot);
    const lease = this.resolver.acquire(snapshot.binding, required);
    if (snapshot.generation === undefined) {
      this.turnSnapshot = { binding: snapshot.binding, generation: this.currentGeneration(snapshot.binding) };
    }
    this.holdTurnLease();
    return lease;
  }

  async acquireWhenReady(required: readonly EnvironmentCapability[] = []): Promise<EnvironmentLease> {
    const snapshot = this.turnSnapshot;
    const binding = snapshot?.binding ?? this.binding.current;
    if (snapshot !== undefined) this.assertPinnedGeneration(snapshot);
    let connected = false;
    const environment = this.resolver.inspect(binding);
    if (!environmentStatusAllows(environment, required) && typeof environment.connect === 'function') {
      await environment.connect();
      connected = true;
    }
    const lease = await this.resolver.acquireWhenReady(binding, required);
    if (snapshot !== undefined && (snapshot.generation === undefined || connected)) {
      this.turnSnapshot = { binding, generation: this.currentGeneration(binding) };
    }
    this.holdTurnLease();
    return lease;
  }

  dispose(): void {
    for (const subscription of this.turnSubscriptions) subscription.dispose();
    this.registrySubscription?.dispose();
    this.workspaceSubscription.dispose();
    this.bindingSubscription.dispose();
    this.releaseTurnLease();
    this.changeEmitter.dispose();
  }

  private holdTurnLease(): void {
    const snapshot = this.turnSnapshot;
    if (snapshot === undefined || this.turnLease !== undefined) return;
    try {
      this.turnLease = this.resolver.acquire(snapshot.binding);
    } catch {
      this.turnLease = undefined;
    }
  }

  private releaseTurnLease(): void {
    this.turnLease?.dispose();
    this.turnLease = undefined;
  }

  private currentGeneration(binding: EnvironmentBinding): string | undefined {
    return this.workspaces.get(binding.workspaceId)?.environments.current(binding.environmentId)?.identity.generation;
  }

  private readyGeneration(binding: EnvironmentBinding): string | undefined {
    const environment = this.workspaces.get(binding.workspaceId)?.environments.current(binding.environmentId);
    if (environment === undefined || !environmentStatusAllows(environment, [])) return undefined;
    return environment.identity.generation;
  }

  private assertPinnedGeneration(snapshot: TurnEnvironmentSnapshot): void {
    if (snapshot.generation === undefined) return;
    if (this.currentGeneration(snapshot.binding) !== snapshot.generation) {
      throw new EnvironmentError(
        'environment.unavailable',
        `environment ${snapshot.binding.environmentId} generation changed during the active turn`,
      );
    }
  }

  private rebind(): void {
    this.bindRegistry();
    if (this.turnSnapshot !== undefined) {
      const binding = this.binding.current;
      this.turnSnapshot = { binding, generation: this.readyGeneration(binding) };
      this.releaseTurnLease();
      this.holdTurnLease();
    }
    this.changeEmitter.fire();
  }

  private bindRegistry(): void {
    this.registrySubscription?.dispose();
    const binding = this.binding.current;
    const workspace = this.workspaces.get(binding.workspaceId);
    this.registrySubscription = workspace?.environments.onDidChange((change) => {
      if (change.environmentId !== this.binding.current.environmentId) return;
      const current = workspace.environments.current(change.environmentId);
      if (change.current !== undefined && change.current !== current) return;
      this.changeEmitter.fire();
      this.publishEnvironmentStatus(change);
      this.holdTurnLease();
    });
  }

  private publishEnvironmentStatus(change: EnvironmentRegistryChange): void {
    const agent = this.scopeContext.agentContext;
    if (this.scopeContext.agentId !== MAIN_AGENT_ID || !this.eventBus.isAgentActive(agent)) return;
    this.eventBus.publish(
      new EnvironmentStatusChanged({ agentId: agent.agentId, environmentId: change.environmentId, status: change.status }),
      agent,
    );
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentEnvironmentService,
  AgentEnvironmentService,
  ScopeActivation.OnDemand,
  'agentEnvironmentBinding',
);
