import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
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
} from './workspacePaths';

export class AgentWorkspaceContextService implements ISessionWorkspaceContext {
  declare readonly _serviceBrand: undefined;

  constructor(@ISessionStateService private readonly states: ISessionStateService) {}

  get workDir(): string {
    return this.states.get(workspaceContextWorkDirKey);
  }

  get additionalDirs(): readonly string[] {
    return this.states.get(workspaceContextAdditionalDirsKey);
  }

  setWorkDir(workDir: string): void {
    this.states.set(workspaceContextWorkDirKey, workDir);
  }

  resolve(rel: string): string {
    return resolveWorkspacePath(hostWorkspacePathSemantics, this.workDir, rel);
  }

  isWithin(absPath: string): boolean {
    return isWithinWorkspace(hostWorkspacePathSemantics, this.workDir, this.additionalDirs, absPath);
  }

  assertAllowed(absPath: string, op: PathAccessOperation): string {
    return assertWorkspaceAllowed(hostWorkspacePathSemantics, this.workDir, this.additionalDirs, absPath, op);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  ISessionWorkspaceContext,
  AgentWorkspaceContextService,
  ScopeActivation.OnDemand,
  'workspaceContext',
);
