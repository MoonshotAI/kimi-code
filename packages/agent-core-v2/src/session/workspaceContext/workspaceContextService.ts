/**
 * `workspaceContext` domain (L1) — `ISessionWorkspaceContext` implementation.
 *
 * Holds the session work directory and additional dirs, resolves relative
 * paths, and checks whether a path falls within the workspace. Bound at
 * Session scope.
 */

import { isAbsolute, relative, resolve } from 'node:path';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IExecContext } from '#/session/execContext';

import { ISessionWorkspaceContext, type PathAccessOperation } from './workspaceContext';

export class SessionWorkspaceContextService implements ISessionWorkspaceContext {
  declare readonly _serviceBrand: undefined;
  private _workDir: string;
  private _additionalDirs: string[] = [];

  constructor(@IExecContext ctx: IExecContext) {
    this._workDir = resolve(ctx.cwd);
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
  InstantiationType.Delayed,
  'workspaceContext',
);
