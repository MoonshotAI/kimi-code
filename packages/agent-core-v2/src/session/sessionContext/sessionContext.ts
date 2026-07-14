/**
 * `sessionContext` domain (L6) — seeded per-session facts.
 *
 * Defines the `ISessionContext` carrying the session's identity, storage
 * addressing (`sessionId`, `workspaceId`, `sessionDir`, `metaScope`), the
 * session's initial working directory (`cwd`), and a `scope(subKey?)` helper
 * that returns the session's persistence scope (or a child under it, e.g.
 * `scope('agents/main/cron')`). Seeded into the Session scope by
 * `sessionLifecycle` when the session is created.
 *
 * `cwd` is the working directory frozen at session creation; it is the default
 * root the `process` runner spawns in and the seed `workspaceContext` derives
 * its mutable `workDir` from. The live, runtime-mutable "current cwd" (changed
 * via `chdir`) is owned by `profile` (Agent scope) and `workspaceContext`, not
 * here. Pure facts — no store, no IO. Session-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';

export interface ISessionContext {
  readonly _serviceBrand: undefined;

  readonly sessionId: string;
  readonly workspaceId: string;
  readonly sessionDir: string;
  readonly metaScope: string;
  readonly cwd: string;
  scope(subKey?: string): string;
}

export const ISessionContext: ServiceIdentifier<ISessionContext> =
  createDecorator<ISessionContext>('sessionContext');

export function sessionContextSeed(ctx: ISessionContext): ScopeSeed {
  return [[ISessionContext as ServiceIdentifier<unknown>, ctx]];
}

export function makeSessionContext(input: {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly sessionDir: string;
  readonly sessionScope: string;
  readonly cwd: string;
  readonly metaScope?: string;
}): ISessionContext {
  const { sessionScope } = input;
  return {
    _serviceBrand: undefined,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    sessionDir: input.sessionDir,
    metaScope: input.metaScope ?? sessionScope,
    cwd: input.cwd,
    scope: (subKey?: string): string =>
      subKey === undefined || subKey === '' ? sessionScope : `${sessionScope}/${subKey}`,
  };
}
