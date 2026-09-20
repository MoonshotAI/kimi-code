import { ref, type LiveRef } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import type { EnvironmentWorkspaceRoots } from '#/environment/environment';
import { ISessionStateService } from '#/session/state/sessionState';

import { ISessionWorkspaceContext, type PathAccessOperation } from './workspaceContext';
import {
  workspaceContextAdditionalDirsKey,
  workspaceContextWorkDirKey,
} from './workspaceContextService';
import {
  assertWorkspaceAllowed,
  hostWorkspacePathSemantics,
  isWithinWorkspace,
  resolveWorkspacePath,
  type WorkspacePathSemantics,
} from './workspacePaths';

export class AgentWorkspaceContextService implements ISessionWorkspaceContext {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionStateService private readonly states: ISessionStateService,
    @ref(IAgentEnvironmentService) private readonly environment: LiveRef<IAgentEnvironmentService>,
  ) {}

  private roots(): EnvironmentWorkspaceRoots {
    const environment = this.environment.current;
    if (environment === undefined) {
      return {
        workDir: this.states.get(workspaceContextWorkDirKey),
        additionalDirs: this.states.get(workspaceContextAdditionalDirsKey),
      };
    }
    return environment.workspaceRoots();
  }

  private pathSemantics(): WorkspacePathSemantics {
    const environment = this.environment.current;
    if (environment !== undefined) {
      try {
        return environment.inspect().path;
      } catch {
        return hostWorkspacePathSemantics;
      }
    }
    return hostWorkspacePathSemantics;
  }

  get workDir(): string {
    return this.roots().workDir;
  }

  get additionalDirs(): readonly string[] {
    return this.roots().additionalDirs ?? [];
  }

  setWorkDir(workDir: string): void {
    this.states.set(workspaceContextWorkDirKey, workDir);
  }

  resolve(rel: string): string {
    return resolveWorkspacePath(this.pathSemantics(), this.workDir, rel);
  }

  isWithin(absPath: string): boolean {
    return isWithinWorkspace(this.pathSemantics(), this.workDir, this.additionalDirs, absPath);
  }

  assertAllowed(absPath: string, op: PathAccessOperation): string {
    return assertWorkspaceAllowed(this.pathSemantics(), this.workDir, this.additionalDirs, absPath, op);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  ISessionWorkspaceContext,
  AgentWorkspaceContextService,
  ScopeActivation.OnDemand,
  'workspaceContext',
);
