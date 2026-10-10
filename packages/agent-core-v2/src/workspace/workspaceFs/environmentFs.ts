import type { ServicesAccessor } from '#/_base/di/instantiation';
import { GitService } from '#/app/git/gitService';
import { IEnvironmentService, type EnvironmentResolver } from '#/app/environment/environment';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type {
  EnvironmentCapability,
  EnvironmentLease,
  EnvironmentWorkspaceRoots,
} from '#/environment/environment';
import type { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import type { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import { WorkspaceGitService } from '#/workspace/workspaceGit/workspaceGitService';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

import type { IWorkspaceFsService } from './fs';
import { WorkspaceFsService } from './fsService';

export interface EnvironmentFsScope {
  readonly fs: IWorkspaceFsService;
  readonly hostFs: IHostFileSystem;
  readonly lease: EnvironmentLease;
  readonly roots: { readonly workDir: string; readonly additionalDirs: readonly string[] };
}

export function createEnvironmentFs(
  accessor: ServicesAccessor,
  workspaceId: string,
  roots: EnvironmentWorkspaceRoots,
  environmentId: string,
  required: readonly EnvironmentCapability[],
): EnvironmentFsScope {
  const lease = accessor.get(IEnvironmentService).acquire({ environmentId }, required);
  try {
    const mapped = lease.environment.workspace!.mapRoots(roots);
    const workspace = {
      _serviceBrand: undefined,
      workspaceId,
      cwd: mapped.workDir,
      source: 'local',
      meta: {
        id: workspaceId,
        root: mapped.workDir,
        name: workspaceId,
        createdAt: 0,
        lastOpenedAt: 0,
      },
      persistenceScope: `sessions/${workspaceId}`,
    } satisfies IWorkspaceContext;
    const dirs: Pick<IWorkspaceDirs, 'additionalDirs'> = {
      additionalDirs: mapped.additionalDirs ?? [],
    };
    const resolver: EnvironmentResolver = {
      _serviceBrand: undefined,
      inspect: () => lease.environment,
      acquire: (_binding, capabilities = []) => {
        const missing = capabilities.filter((capability) => !lease.environment.capabilities.has(capability));
        if (missing.length > 0) throw new Error(`environment ${environmentId} missing capabilities: ${missing.join(', ')}`);
        return {
          environment: lease.environment,
          track: (resource) => lease.track(resource),
          dispose: () => {},
        };
      },
      acquireWhenReady(_binding, capabilities = []) {
        return Promise.resolve(this.acquire(_binding, capabilities));
      },
    };
    const git = new WorkspaceGitService(
      workspace,
      {
        current: new GitService(resolver, lease.environment.fs!),
        onDidChange: () => ({ dispose: () => {} }),
      },
    );
    return {
      fs: new WorkspaceFsService(
        workspace,
        dirs,
        lease.environment.fs!,
        resolver,
        accessor.get(ITelemetryService),
        git,
        environmentId,
      ),
      hostFs: lease.environment.fs!,
      lease,
      roots: { workDir: mapped.workDir, additionalDirs: mapped.additionalDirs ?? [] },
    };
  } catch (error) {
    lease.dispose();
    throw error;
  }
}
