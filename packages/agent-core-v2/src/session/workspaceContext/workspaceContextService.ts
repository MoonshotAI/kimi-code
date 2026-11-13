import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionStateService } from '#/session/state/sessionState';
import { ISessionWorkspaceInfo } from '#/session/workspaceInfo/workspaceInfo';
import { ISessionWorkdir } from '#/session/workdir/workdir';

import { ISessionWorkspaceContext, type PathAccessOperation } from './workspaceContext';
import { resolveEffectiveWorkspaceRoots } from './workspaceRoots';
import {
  assertWorkspaceAllowed,
  hostWorkspacePathSemantics,
  isWithinWorkspace,
  resolveWorkspacePath,
} from './workspacePaths';

export const workspaceContextWorkDirKey = defineState<string>('workspaceContext.workDir', () => '');
export const workspaceContextAdditionalDirsKey = defineState<string[]>(
  'workspaceContext.additionalDirs',
  () => [],
);

export class SessionWorkspaceContextService extends Service implements ISessionWorkspaceContext {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionStateService private readonly states: ISessionStateService,
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionWorkspaceInfo private readonly workspaceInfo: ISessionWorkspaceInfo,
    @ISessionWorkdir private readonly workdir: ISessionWorkdir,
  ) {
    super();
    this.states.contributeState(workspaceContextWorkDirKey);
    this.states.contributeState(workspaceContextAdditionalDirsKey);
    this.syncRoots();
    this._register(this.workspaceInfo.onDidChange(() => this.syncRoots()));
  }

  private syncRoots(): void {
    const roots = resolveEffectiveWorkspaceRoots(
      this.ctx,
      { environmentId: this.workdir.environmentId, cwd: this.workdir.cwd },
      this.workspaceInfo,
    );
    this.states.set(workspaceContextWorkDirKey, roots.workDir);
    this.states.set(workspaceContextAdditionalDirsKey, [...roots.additionalDirs]);
  }

  private get _workDir(): string {
    return this.states.get(workspaceContextWorkDirKey);
  }

  private get _additionalDirs(): string[] {
    return this.states.get(workspaceContextAdditionalDirsKey);
  }

  get workDir(): string {
    return this._workDir;
  }

  get additionalDirs(): readonly string[] {
    return this._additionalDirs;
  }

  setWorkDir(workDir: string): void {
    this.states.set(workspaceContextWorkDirKey, workDir);
  }

  resolve(rel: string): string {
    return resolveWorkspacePath(hostWorkspacePathSemantics, this._workDir, rel);
  }

  isWithin(absPath: string): boolean {
    return isWithinWorkspace(hostWorkspacePathSemantics, this._workDir, this._additionalDirs, absPath);
  }

  assertAllowed(absPath: string, op: PathAccessOperation): string {
    return assertWorkspaceAllowed(hostWorkspacePathSemantics, this._workDir, this._additionalDirs, absPath, op);
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionWorkspaceContext,
  SessionWorkspaceContextService,
  ScopeActivation.OnScopeCreated,
  'workspaceContext',
);
