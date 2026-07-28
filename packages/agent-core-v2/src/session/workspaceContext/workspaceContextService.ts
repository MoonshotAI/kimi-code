/**
 * `workspaceContext` domain (L1) — `ISessionWorkspaceContext` implementation.
 *
 * Holds the session work directory and additional dirs, resolves relative
 * paths, and checks whether a path falls within the workspace. The plain-data
 * state (`workDir`, `additionalDirs`) is registered into `sessionState`
 * (`ISessionStateService`) and read/written through it. Bound at Session
 * scope.
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
    this.setWorkDir(ctx.cwd);
  }

  private get _workDir(): string {
    return this.states.get(workspaceContextWorkDirKey);
  }

  private set _workDir(value: string) {
    this.states.set(workspaceContextWorkDirKey, value);
  }

  private get _additionalDirs(): string[] {
    return this.states.get(workspaceContextAdditionalDirsKey);
  }

  private set _additionalDirs(value: string[]) {
    this.states.set(workspaceContextAdditionalDirsKey, value);
  }

  get workDir(): string {
    return this._workDir;
  }

  get additionalDirs(): readonly string[] {
    return this._additionalDirs;
  }

  setWorkDir(workDir: string): void {
    this._workDir = resolve(workDir);
  }

  setAdditionalDirs(dirs: readonly string[]): void {
    this._additionalDirs = [...new Set(dirs.map((d) => resolve(d)))];
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

  addAdditionalDir(dir: string): void {
    const d = resolve(dir);
    if (!this._additionalDirs.includes(d)) this._additionalDirs.push(d);
  }

  removeAdditionalDir(dir: string): void {
    const d = resolve(dir);
    this._additionalDirs = this._additionalDirs.filter((x) => x !== d);
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionWorkspaceContext,
  SessionWorkspaceContextService,
  ScopeActivation.OnScopeCreated,
  'workspaceContext',
);
