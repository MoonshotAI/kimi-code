import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { EnvironmentSetBinding } from '#/agent/environmentBinding/environmentBindingOps';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { LifecycleScope } from '#/app/scopes';
import type { Environment, EnvironmentBinding } from '#/environment/environment';
import { resolveWorkspaceEnvironmentDeclarations } from '#/environment/environmentDeclarations';
import { EnvironmentError, environmentStatusAllows } from '#/environment/environmentRegistry';
import type { EnvironmentDeclarationSet } from '#/environment/remoteEnvironmentDeclaration';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import {
  agentScopeOf,
  sessionScopeOf,
  workspacePersistenceScope,
} from '#/workspace/sessionLifecycle/internal/addressing';
import { IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { AGENT_WIRE_RECORD_KEY, isWireRecord, type WireRecord } from '#/wire/record';
import { parseTree, restorableChain, type WireLine } from '#/wire/tree/index';

import { IEnvironmentDeclarationService } from './environmentDeclaration';

export class EnvironmentDeclarationService implements IEnvironmentDeclarationService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @IAppendLogStore private readonly appendLogStore: IAppendLogStore,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IWorkspaceInstanceManager private readonly workspaces: IWorkspaceInstanceManager,
    @ILogService private readonly log: ILogService,
  ) {}

  async declarations(root: string): Promise<EnvironmentDeclarationSet | undefined> {
    try {
      const declarations = await resolveWorkspaceEnvironmentDeclarations({
        config: this.config,
        fs: this.fs,
        docs: this.docs,
        root,
      });
      if (declarations.projectError !== undefined) {
        this.log.warn('project remote environment declarations failed to load', { error: declarations.projectError });
      }
      return declarations;
    } catch (error) {
      this.log.warn('remote environment declaration resolution failed', { error });
      return undefined;
    }
  }

  async declaredDefaultCwd(root: string, environmentId: string): Promise<string | undefined> {
    const declarations = await this.declarations(root);
    return declarations?.entries.find((entry) => entry.id === environmentId)?.entry.defaultCwd;
  }

  async ensureConnected(workspaceId: string, environmentId: string): Promise<Environment | undefined> {
    const workspace = this.workspaces.get(workspaceId);
    const environment = workspace?.environments.current(environmentId);
    if (workspace === undefined || environment === undefined) return undefined;
    if (!environmentStatusAllows(environment, ['fs', 'process'])) {
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
