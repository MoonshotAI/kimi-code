/**
 * `sessionContext` domain (L6) — seeded per-session facts.
 *
 * Defines the `ISessionContext` carrying the session's identity, storage
 * addressing (`sessionId`, `workspaceId`, `sessionDir`, `metaScope`), the
 * session's working directory (`cwd`) — frozen at session creation — the
 * materialization-time snapshot of the handler's additional workspace
 * directories (`additionalDirs`), and a `scope(subKey?)`
 * helper that returns the session's persistence scope (or a child under it,
 * e.g. `scope('agents/main/cron')`). Seeded into the Session scope by
 * `workspaceHandler` when the session is created.
 *
 * `cwd` is the default root the `process` runner spawns in and the seed the
 * `workspaceContext` derives its read-only `workDir` / `additionalDirs` from.
 * Pure facts — no store, no IO. Session-scoped.
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
  /**
   * Extra directories beyond `cwd` the session may touch — a snapshot of the
   * handler-shared set (`workspaceDirs`: project-local `.kimi-code/local.toml`
   * ∪ caller-provided dirs) taken at materialization. Live updates reach
   * consumers through the `ISessionWorkspaceInfo` seed; this field stays the
   * creation-time snapshot.
   */
  readonly additionalDirs?: readonly string[];
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
  readonly additionalDirs?: readonly string[];
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
    additionalDirs: input.additionalDirs,
    scope: (subKey?: string): string =>
      subKey === undefined || subKey === '' ? sessionScope : `${sessionScope}/${subKey}`,
  };
}
