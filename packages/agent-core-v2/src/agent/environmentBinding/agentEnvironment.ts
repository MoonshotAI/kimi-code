import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import type { IDisposable } from '#/_base/di/lifecycle';
import { ISessionEventBus } from '#/app/event/eventBus';
import { IEnvironmentDeclarationService } from '#/app/environmentDeclaration/environmentDeclaration';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { Environment, EnvironmentAccess, EnvironmentBinding, EnvironmentCapability, EnvironmentHandle, EnvironmentLease, EnvironmentPath, EnvironmentTarget, EnvironmentWorkspaceRoots } from '#/environment/environment';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
import { normalizeRemoteCwd } from '#/environment/environmentDefaults';
import { EnvironmentError, environmentIsReady, type EnvironmentGenerationSnapshot, type EnvironmentRegistryChange } from '#/environment/environmentRegistry';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionStateService } from '#/session/state/sessionState';
import {
  workspaceContextAdditionalDirsKey,
} from '#/session/workspaceContext/workspaceContextService';
import { IEnvironmentService } from '#/app/environment/environment';

import { IAgentEnvironmentBindingService } from './environmentBinding';
import { EnvironmentStatusChanged } from './environmentEvents';
import { MULTI_ENVIRONMENT_FLAG_ID } from './flag';

export interface AgentEnvironmentBindingSnapshot {
  readonly binding: EnvironmentBinding;
  readonly available: boolean;
  readonly environment?: EnvironmentGenerationSnapshot;
}

export interface IAgentEnvironmentService extends EnvironmentAccess {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<void>;
  targets(): readonly EnvironmentTarget[];
  handle(target: EnvironmentTarget): EnvironmentHandle;
}

export const IAgentEnvironmentService: ServiceIdentifier<IAgentEnvironmentService> =
  createDecorator<IAgentEnvironmentService>('agentEnvironmentService');

export async function acquireOrWhenReady(
  environment: EnvironmentAccess,
  required: readonly EnvironmentCapability[] = [],
): Promise<EnvironmentLease> {
  if (environment.isAvailable(required)) return environment.acquire(required);
  return environment.acquireWhenReady(required);
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
  localTempDir?: string,
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
    const tempDir =
      environment.host?.tempDir ??
      (environment.identity.environmentId === LOCAL_ENVIRONMENT_ID ? localTempDir : undefined);
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
  private readonly registrySubscription: IDisposable;

  constructor(
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentEnvironmentBindingService private readonly binding: IAgentEnvironmentBindingService,
    @IEnvironmentService private readonly resolver: IEnvironmentService,
    @ISessionEventBus private readonly eventBus: ISessionEventBus,
    @ISessionContext private readonly session: ISessionContext,
    @ISessionStateService private readonly sessionState: ISessionStateService,
    @IFlagService private readonly flags?: IFlagService,
    @IEnvironmentDeclarationService private readonly declarations?: IEnvironmentDeclarationService,
  ) {
    this.bindingSubscription = this.binding.onDidChange(() => this.changeEmitter.fire());
    this.registrySubscription = this.resolver.onDidChange((change) => {
      if (change.environmentId !== this.binding.current.environmentId) return;
      if (change.current !== undefined && change.current !== this.resolver.current(change.environmentId)) return;
      this.changeEmitter.fire();
      this.publishEnvironmentStatus(change);
    });
  }

  targets(): readonly EnvironmentTarget[] {
    const current = this.binding.current;
    const primary: EnvironmentTarget = { environmentId: current.environmentId, primary: true, cwd: current.cwd };
    if (this.declarations === undefined || this.flags?.enabled(MULTI_ENVIRONMENT_FLAG_ID) !== true) return [primary];
    const declared = new Map(
      this.declarations.snapshot().entries.map((declaration) => [declaration.id, declaration.entry.defaultCwd]),
    );
    if (current.environmentId !== LOCAL_ENVIRONMENT_ID && !declared.has(current.environmentId)) return [primary];
    const secondary = [LOCAL_ENVIRONMENT_ID, ...declared.keys()]
      .filter((environmentId) => environmentId !== current.environmentId && this.resolver.current(environmentId) !== undefined)
      .toSorted((left, right) => left.localeCompare(right))
      .map((environmentId): EnvironmentTarget => ({
        environmentId,
        primary: false,
        cwd: environmentId === LOCAL_ENVIRONMENT_ID ? this.session.cwd : declared.get(environmentId),
      }));
    return [primary, ...secondary];
  }

  handle(target: EnvironmentTarget): EnvironmentHandle {
    const binding = (): EnvironmentBinding => ({
      environmentId: target.environmentId,
      cwd:
        target.primary || target.cwd === undefined || target.environmentId === LOCAL_ENVIRONMENT_ID
          ? target.cwd
          : normalizeRemoteCwd(target.cwd),
    });
    return {
      target,
      inspect: () => this.resolver.inspect(binding()),
      isAvailable: (required = []) => this.isReadyFor(binding, required),
      acquire: (required = []) => this.resolver.acquire(binding(), required),
      acquireWhenReady: async (required = []) => this.resolver.acquireWhenReady(binding(), required),
      workspaceRoots: () => this.rootsOf(binding(), target.primary),
    };
  }

  inspect(): Environment {
    return this.resolver.inspect(this.binding.current);
  }

  workspaceRoots(): EnvironmentWorkspaceRoots {
    return this.rootsOf(this.binding.current, true);
  }

  isAvailable(required: readonly EnvironmentCapability[] = []): boolean {
    return this.isReadyFor(() => this.binding.current, required);
  }

  acquire(required: readonly EnvironmentCapability[] = []): EnvironmentLease {
    return this.resolver.acquire(this.binding.current, required);
  }

  async acquireWhenReady(required: readonly EnvironmentCapability[] = []): Promise<EnvironmentLease> {
    return this.resolver.acquireWhenReady(this.binding.current, required);
  }

  private isReadyFor(binding: () => EnvironmentBinding, required: readonly EnvironmentCapability[]): boolean {
    try {
      const environment = this.resolver.inspect(binding());
      return environmentIsReady(environment) && required.every((capability) => environment.capabilities.has(capability));
    } catch {
      return false;
    }
  }

  private rootsOf(binding: EnvironmentBinding, primary: boolean): EnvironmentWorkspaceRoots {
    let workDir = binding.cwd;
    if (workDir === undefined && binding.environmentId !== LOCAL_ENVIRONMENT_ID) {
      try {
        const environment = this.resolver.inspect(binding);
        workDir = environment.host?.cwd ?? environment.host?.homeDir;
      } catch {
        workDir = undefined;
      }
    }
    if (!primary) {
      if (workDir === undefined) {
        throw new EnvironmentError('environment.unavailable', `environment ${binding.environmentId} has no working directory until it connects`);
      }
      return { workDir, additionalDirs: [] };
    }
    return {
      workDir: workDir ?? this.session.cwd,
      additionalDirs: this.sessionState.get(workspaceContextAdditionalDirsKey),
    };
  }

  dispose(): void {
    this.registrySubscription?.dispose();
    this.bindingSubscription.dispose();
    this.changeEmitter.dispose();
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
