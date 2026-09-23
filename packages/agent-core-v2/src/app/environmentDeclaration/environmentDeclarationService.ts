import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type { IDisposable } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import { EnvironmentSetBinding } from '#/agent/environmentBinding/environmentBindingOps';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { LifecycleScope } from '#/app/scopes';
import type { Environment, EnvironmentBinding } from '#/environment/environment';
import { ENVIRONMENTS_SECTION } from '#/environment/configSection';
import { resolveWorkspaceEnvironmentDeclarations } from '#/environment/environmentDeclarations';
import { EnvironmentError, environmentIsReady } from '#/environment/environmentRegistry';
import type { EnvironmentDeclarationSet } from '#/environment/remoteEnvironmentDeclaration';
import { Error2, ErrorCodes } from '#/errors';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import {
  agentScopeOf,
  sessionScopeOf,
  workspacePersistenceScope,
} from '#/workspace/sessionLifecycle/internal/addressing';
import { IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { AGENT_WIRE_RECORD_KEY, isWireRecord, type WireRecord } from '#/wire/record';
import { parseTree, restorableChain, type WireLine } from '#/wire/tree/index';

import { IEnvironmentDeclarationService, type DeclareEnvironmentInput } from './environmentDeclaration';

export class EnvironmentDeclarationService implements IEnvironmentDeclarationService {
  declare readonly _serviceBrand: undefined;
  private readonly reconcilers = new Map<string, () => Promise<void>>();

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IAppendLogStore private readonly appendLogStore: IAppendLogStore,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IWorkspaceInstanceManager private readonly workspaces: IWorkspaceInstanceManager,
    @ILogService private readonly log: ILogService,
  ) {}

  registerReconciler(workspaceId: string, reconcile: () => Promise<void>): IDisposable {
    if (this.reconcilers.has(workspaceId)) throw new Error(`workspace ${workspaceId} already has an environment reconciler`);
    this.reconcilers.set(workspaceId, reconcile);
    return { dispose: () => {
      if (this.reconcilers.get(workspaceId) === reconcile) this.reconcilers.delete(workspaceId);
    } };
  }

  async declare(input: DeclareEnvironmentInput): Promise<void> {
    const workspace = await this.workspaces.getOrCreate({ workspaceId: input.workspaceId });
    const reconcile = this.reconcilers.get(workspace.id);
    if (reconcile === undefined) {
      throw new EnvironmentError('environment.unavailable', `workspace ${workspace.id} has no remote environment provider`);
    }
    await this.config.ready;
    const declared = this.config.get<Record<string, unknown>>(ENVIRONMENTS_SECTION);
    if (declared?.[input.id] !== undefined) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, `Environment id "${input.id}" is already declared in ${this.bootstrap.configPath}.`);
    }
    const entry = Object.fromEntries(Object.entries(input.entry).filter(([, value]) => value !== undefined));
    await this.config.replaceSections(
      { [ENVIRONMENTS_SECTION]: { ...declared, [input.id]: entry } },
      undefined,
      { expectedValues: { [ENVIRONMENTS_SECTION]: declared ?? null } },
    );
    const results = await Promise.allSettled([...new Set([reconcile, ...this.reconcilers.values()])].map((refresh) => refresh()));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') {
      throw new EnvironmentError(
        'environment.unavailable',
        `Environment "${input.id}" was saved, but registration failed: ${failure.reason instanceof Error ? failure.reason.message : String(failure.reason)}`,
        { cause: failure.reason },
      );
    }
  }

  async declarations(): Promise<EnvironmentDeclarationSet | undefined> {
    try {
      return await resolveWorkspaceEnvironmentDeclarations(this.config);
    } catch (error) {
      this.log.warn('remote environment declaration resolution failed', { error });
      return undefined;
    }
  }

  async declaredDefaultCwd(environmentId: string): Promise<string | undefined> {
    const declarations = await this.declarations();
    return declarations?.entries.find((entry) => entry.id === environmentId)?.entry.defaultCwd;
  }

  async ensureConnected(workspaceId: string, environmentId: string): Promise<Environment | undefined> {
    const workspace = this.workspaces.get(workspaceId);
    const environment = workspace?.environments.current(environmentId);
    if (workspace === undefined || environment === undefined) return undefined;
    if (!environmentIsReady(environment)) {
      if (typeof environment.connect !== 'function') {
        throw new EnvironmentError('environment.unavailable', `environment ${environmentId} is ${environment.status}`);
      }
      try {
        await environment.connect();
      } catch (error) {
        throw new EnvironmentError(
          'environment.unavailable',
          `failed to connect environment ${environmentId}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
    return workspace.environments.current(environmentId);
  }

  async assertCwdUsable(workspaceId: string, environmentId: string, cwd: string): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace === undefined) {
      throw new EnvironmentError('environment.not_found', `workspace ${workspaceId} is not materialized`);
    }
    const lease = workspace.environments.acquire({ workspaceId, environmentId }, []);
    try {
      const fs = lease.environment.fs;
      if (fs === undefined) {
        throw new EnvironmentError('environment.capability_unavailable', `environment ${environmentId} does not provide fs`);
      }
      const stat = await fs.stat(cwd).catch((error: unknown) => {
        throw new EnvironmentError(
          'environment.invalid_cwd',
          `cwd ${cwd} is not readable on environment ${environmentId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      if (!stat.isDirectory) {
        throw new EnvironmentError('environment.invalid_cwd', `cwd ${cwd} is not a directory on environment ${environmentId}`);
      }
    } finally {
      lease.dispose();
    }
  }

  async readPersistedEnvironmentBinding(workspaceId: string, sessionId: string): Promise<EnvironmentBinding | undefined> {
    try {
      const scope = agentScopeOf(
        sessionScopeOf(workspacePersistenceScope(this.bootstrap.scope('sessions'), workspaceId), sessionId),
        MAIN_AGENT_ID,
      );
      const entries: WireLine[] = [];
      let line = 0;
      for await (const candidate of this.appendLogStore.read<WireRecord>(scope, AGENT_WIRE_RECORD_KEY)) {
        line += 1;
        if (!isWireRecord(candidate)) continue;
        entries.push({ record: candidate, line });
      }
      const tree = parseTree(entries, entries.at(-1)?.line ?? 0);
      let binding: EnvironmentBinding | undefined;
      for (const { record } of restorableChain(entries, tree)) {
        if (record.type === EnvironmentSetBinding.type && typeof record['environmentId'] === 'string') {
          binding = {
            workspaceId,
            environmentId: record['environmentId'],
            cwd: typeof record['cwd'] === 'string' ? record['cwd'] : undefined,
          };
        }
      }
      return binding;
    } catch {
      return undefined;
    }
  }
}

registerScopedService(LifecycleScope.App, IEnvironmentDeclarationService, EnvironmentDeclarationService, ScopeActivation.OnScopeCreated, 'environmentDeclaration');
