import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type { IDisposable } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import { EnvironmentSetBinding } from '#/agent/environmentBinding/environmentBindingOps';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { LifecycleScope } from '#/app/scopes';
import type { Environment, EnvironmentBinding } from '#/environment/environment';
import { resolveWorkspaceEnvironmentDeclarations } from '#/environment/environmentDeclarations';
import { EnvironmentError, environmentIsReady } from '#/environment/environmentRegistry';
import type { EnvironmentDeclarationSet } from '#/environment/remoteEnvironmentDeclaration';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import {
  agentScopeOf,
  sessionScopeOf,
  workspacePersistenceScope,
} from '#/workspace/sessionLifecycle/internal/addressing';
import { IEnvironmentService } from '#/app/environment/environment';
import { AGENT_WIRE_RECORD_KEY, isWireRecord, type WireRecord } from '#/wire/record';
import { parseTree, restorableChain, type WireLine } from '#/wire/tree/index';

import { IEnvironmentDeclarationService } from './environmentDeclaration';

export class EnvironmentDeclarationService implements IEnvironmentDeclarationService {
  declare readonly _serviceBrand: undefined;
  private reconcile: (() => Promise<void>) | undefined;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IAppendLogStore private readonly appendLogStore: IAppendLogStore,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IEnvironmentService private readonly environments: IEnvironmentService,
    @ILogService private readonly log: ILogService,
  ) {}

  registerReconciler(reconcile: () => Promise<void>): IDisposable {
    if (this.reconcile !== undefined) throw new Error('remote environment provider is already registered');
    this.reconcile = reconcile;
    return { dispose: () => {
      if (this.reconcile === reconcile) this.reconcile = undefined;
    } };
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

  async ensureConnected(environmentId: string): Promise<Environment | undefined> {
    await this.environments.ready;
    const environment = this.environments.current(environmentId);
    if (environment === undefined) return undefined;
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
    return this.environments.current(environmentId);
  }

  async assertCwdUsable(environmentId: string, cwd: string): Promise<void> {
    const lease = this.environments.acquire({ environmentId }, []);
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
