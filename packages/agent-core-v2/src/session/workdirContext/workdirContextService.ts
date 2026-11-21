import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionStateService } from '#/session/state/sessionState';
import { ISessionProjectInfo } from '#/session/projectInfo/projectInfo';
import { ISessionWorkdir } from '#/session/workdir/workdir';

import { ISessionWorkdirContext, type PathAccessOperation } from './workdirContext';
import { resolveEffectiveWorkdirRoots } from './workdirRoots';
import {
  assertWorkdirAllowed,
  hostWorkdirPathSemantics,
  isWithinWorkdir,
  resolveWorkdirPath,
} from './workdirPaths';

export const workdirContextWorkDirKey = defineState<string>('workspaceContext.workDir', () => '');
export const workdirContextAdditionalDirsKey = defineState<string[]>(
  'workspaceContext.additionalDirs',
  () => [],
);

export class SessionWorkdirContextService extends Service implements ISessionWorkdirContext {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionStateService private readonly states: ISessionStateService,
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionProjectInfo private readonly projectInfo: ISessionProjectInfo,
    @ISessionWorkdir private readonly workdir: ISessionWorkdir,
  ) {
    super();
    this.states.contributeState(workdirContextWorkDirKey);
    this.states.contributeState(workdirContextAdditionalDirsKey);
    this.syncRoots();
    this._register(this.projectInfo.onDidChange(() => this.syncRoots()));
  }

  private syncRoots(): void {
    const roots = resolveEffectiveWorkdirRoots(
      this.ctx,
      { environmentId: this.workdir.environmentId, cwd: this.workdir.cwd },
      this.projectInfo,
    );
    this.states.set(workdirContextWorkDirKey, roots.workDir);
    this.states.set(workdirContextAdditionalDirsKey, [...roots.additionalDirs]);
  }

  private get _workDir(): string {
    return this.states.get(workdirContextWorkDirKey);
  }

  private get _additionalDirs(): string[] {
    return this.states.get(workdirContextAdditionalDirsKey);
  }

  get workDir(): string {
    return this._workDir;
  }

  get additionalDirs(): readonly string[] {
    return this._additionalDirs;
  }

  setWorkDir(workDir: string): void {
    this.states.set(workdirContextWorkDirKey, workDir);
  }

  resolve(rel: string): string {
    return resolveWorkdirPath(hostWorkdirPathSemantics, this._workDir, rel);
  }

  isWithin(absPath: string): boolean {
    return isWithinWorkdir(hostWorkdirPathSemantics, this._workDir, this._additionalDirs, absPath);
  }

  assertAllowed(absPath: string, op: PathAccessOperation): string {
    return assertWorkdirAllowed(hostWorkdirPathSemantics, this._workDir, this._additionalDirs, absPath, op);
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionWorkdirContext,
  SessionWorkdirContextService,
  ScopeActivation.OnScopeCreated,
  'workspaceContext',
);
