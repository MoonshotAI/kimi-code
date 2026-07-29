/**
 * `workspaceContext` domain (L1) — `ISessionWorkspaceContext` implementation.
 *
 * Holds the session work directory and additional dirs, resolves relative
 * paths, and checks whether a path falls within the workspace. Both are frozen
 * at construction from the `sessionContext` seed (`cwd` / `additionalDirs`) —
 * the context is read-only for the session's lifetime. The plain-data state
 * (`workDir`, `additionalDirs`) is registered into `sessionState`
 * (`ISessionStateService`) and read through it. Bound at Session scope.
 */

import { isAbsolute, relative, resolve } from 'node:path';

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionStateService } from '#/session/state/sessionState';

import { ISessionWorkspaceContext, type PathAccessOperation } from './workspaceContext';

export const workspaceContextWorkDirKey = defineState<string>('workspaceContext.workDir', () => '');
export const workspaceContextAdditionalDirsKey = defineState<string[]>(
  'workspaceContext.additionalDirs',
  () => [],
);

export class SessionWorkspaceContextService implements ISessionWorkspaceContext {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionStateService private readonly states: ISessionStateService,
    @ISessionContext ctx: ISessionContext,
  ) {
    this.states.register(workspaceContextWorkDirKey);
    this.states.register(workspaceContextAdditionalDirsKey);
    this.states.set(workspaceContextWorkDirKey, resolve(ctx.cwd));
    this.states.set(workspaceContextAdditionalDirsKey, [
      ...new Set((ctx.additionalDirs ?? []).map((d) => resolve(d))),
    ]);
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
      throw new Error(`Path outside workspace (${op}): ${target}`);
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
