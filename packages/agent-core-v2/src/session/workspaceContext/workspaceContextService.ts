/**
 * `workspaceContext` domain — `ISessionWorkspaceContext` implementation.
 *
 * Holds the session work directory and additional dirs, resolves relative
 * paths, and checks whether a path falls within the workspace. `workDir` is
 * frozen at construction (`cwd`); the
 * additional dirs are a live read view over the handler-shared set, refreshed
 * through the seed's change event. The plain-data state (`workDir`,
 * `additionalDirs`) is registered into the session-state container and read
 * through it. Bound at Session scope.
 */

import { isAbsolute, relative, resolve } from 'node:path';

import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { ErrorCodes, Error2 } from '#/errors';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionStateService } from '#/session/state/sessionState';
import { ISessionWorkspaceInfo } from '#/session/workspaceInfo/workspaceInfo';

import { ISessionWorkspaceContext, type PathAccessOperation } from './workspaceContext';

export const workspaceContextWorkDirKey = defineState<string>('workspaceContext.workDir', () => '');
export const workspaceContextAdditionalDirsKey = defineState<string[]>(
  'workspaceContext.additionalDirs',
  () => [],
);

export class SessionWorkspaceContextService extends Service implements ISessionWorkspaceContext {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionStateService private readonly states: ISessionStateService,
    @ISessionContext ctx: ISessionContext,
    @ISessionWorkspaceInfo workspaceInfo: ISessionWorkspaceInfo,
  ) {
    super();
    this.states.contributeState(workspaceContextWorkDirKey);
    this.states.contributeState(workspaceContextAdditionalDirsKey);
    this.states.set(workspaceContextWorkDirKey, resolve(ctx.cwd));
    this.states.set(workspaceContextAdditionalDirsKey, [
      ...new Set(workspaceInfo.additionalDirs.map((d) => resolve(d))),
    ]);
    this._register(
      workspaceInfo.onDidChange(() => {
        this.states.set(workspaceContextAdditionalDirsKey, [
          ...new Set(workspaceInfo.additionalDirs.map((d) => resolve(d))),
        ]);
      }),
    );
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

  resolve(rel: string): string {
    return isAbsolute(rel) ? resolve(rel) : resolve(this._workDir, rel);
  }

  isWithin(absPath: string): boolean {
    const target = resolve(absPath);
    if (target === this._workDir) return true;
    const rel = relative(this._workDir, target);
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return true;
    return this._additionalDirs.some((dir) => {
      const r = relative(dir, target);
      return r === '' || (!r.startsWith('..') && !isAbsolute(r));
    });
  }

  assertAllowed(absPath: string, op: PathAccessOperation): string {
    const target = this.resolve(absPath);
    if (!this.isWithin(target)) {
      throw new Error2(ErrorCodes.FS_PATH_ESCAPES, `Path outside workspace (${op}): ${target}`, {
        details: { op, path: target },
      });
    }
    return target;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionWorkspaceContext,
  SessionWorkspaceContextService,
  ScopeActivation.OnScopeCreated,
  'workspaceContext',
);
