import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import type { IDisposable } from '#/_base/di/lifecycle';
import { ISessionEventBus } from '#/app/event/eventBus';
import { LifecycleScope } from '#/app/scopes';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { Environment, EnvironmentBinding, EnvironmentCapability, EnvironmentLease, EnvironmentPath, EnvironmentWorkspaceRoots } from '#/environment/environment';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
import { EnvironmentError, environmentIsReady, type EnvironmentGenerationSnapshot, type EnvironmentRegistryChange } from '#/environment/environmentRegistry';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
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

export async function acquireOrWhenReady(
  service: IAgentEnvironmentService,
  required: readonly EnvironmentCapability[] = [],
): Promise<EnvironmentLease> {
  if (service.isAvailable(required)) return service.acquire(required);
  return service.acquireWhenReady(required);
}

export function pinnedGeneration(environment: Environment): string | undefined {
  return environmentIsReady(environment) ? environment.identity.generation : undefined;
}

export interface EnvironmentTempTarget {
  readonly fs: IHostFileSystem;
  readonly path: EnvironmentPath;
  readonly dir: string;
}

export function environmentTempTarget(
  service: IAgentEnvironmentService,
  subdir: string,
): EnvironmentTempTarget | undefined {
  let lease: EnvironmentLease;
  try {
    lease = service.acquire();
  } catch {
    return undefined;
  }
  try {
    const environment = lease.environment;
    const fs = environment.fs;
    const path = environment.path;
    const tempDir = environment.host?.tempDir;
    if (fs === undefined || path === undefined || tempDir === undefined) return undefined;
    return { fs, path, dir: path.join(tempDir, 'kimi-code', subdir) };
  } finally {
    lease.dispose();
  }
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

export class AgentEnvironmentService implements IAgentEnvironmentService {
  declare readonly _serviceBrand: undefined;
  private readonly changeEmitter = new Emitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly bindingSubscription: IDisposable;
  private readonly workspaceSubscription: IDisposable;
  private registrySubscription: IDisposable | undefined;

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
    const binding = this.binding.current;
    let workDir = binding.cwd;
    if (workDir === undefined && binding.environmentId !== LOCAL_ENVIRONMENT_ID) {
      try {
        const environment = this.resolver.inspect(binding);
        workDir = environment.host?.cwd ?? environment.host?.homeDir;
      } catch {
        workDir = undefined;
      }
    }
    return {
      workDir: workDir ?? this.session.cwd,
      additionalDirs: this.sessionState.get(workspaceContextAdditionalDirsKey),
    };
  }

  isAvailable(required: readonly EnvironmentCapability[] = []): boolean {
    try {
      const environment = this.inspect();
      return environmentIsReady(environment) && required.every((capability) => environment.capabilities.has(capability));
    } catch {
      return false;
    }
  }

  acquire(required: readonly EnvironmentCapability[] = []): EnvironmentLease {
    return this.resolver.acquire(this.binding.current, required);
  }

  async acquireWhenReady(required: readonly EnvironmentCapability[] = []): Promise<EnvironmentLease> {
    const binding = this.binding.current;
    const environment = this.resolver.inspect(binding);
    if (!environmentIsReady(environment) && typeof environment.connect === 'function') {
      await environment.connect();
    }
    return this.resolver.acquireWhenReady(binding, required);
  }

  dispose(): void {
    this.registrySubscription?.dispose();
    this.workspaceSubscription.dispose();
    this.bindingSubscription.dispose();
    this.changeEmitter.dispose();
  }

  private rebind(): void {
    this.bindRegistry();
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
