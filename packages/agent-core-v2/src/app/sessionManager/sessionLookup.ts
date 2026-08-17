/**
 * `workspaceLifecycle` domain — pure session-lookup helpers over the handler chain.
 *
 * The explicit `sessionIndex` → `IWorkspaceLifecycleService.handlerFor` →
 * handler `ISessionLifecycleService` composition, shared by every caller
 * that addresses a session by id from outside the Workspace scope (edge
 * routes, in-process SDKs). These are plain functions over a STABLE
 * accessor (a `Scope` / scope-handle `accessor`, never a transient
 * `invokeFunction` one) — they are not an App-scope session lifecycle
 * facade: the live registry and every lifecycle method stay on the
 * handler's own service. Own no scoped state.
 */

import type { ServicesAccessor } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager, type ISessionManager as SessionManager } from '#/app/sessionManager/sessionManager';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { isError2 } from '#/errors';
import type { Program } from '#/program/program';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ResumeSessionOptions } from '#/workspace/sessionLifecycle/sessionLifecycle';
import { IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';

export async function programForSession(
  accessor: ServicesAccessor,
  sessionId: string,
): Promise<Program | undefined> {
  const manager = accessor.get(ISessionManager);
  const live = manager.get(sessionId);
  if (live !== undefined) {
    const workspaceId = live.accessor.get(ISessionContext).workspaceId;
    return accessor.get(IWorkspaceInstanceManager).get(workspaceId)?.program;
  }
  const summary = await accessor.get(ISessionIndex).get(sessionId);
  if (summary === undefined) return undefined;
  const workspace = await accessor.get(IWorkspaceInstanceManager).getOrCreate({
    workspaceId: summary.workspaceId,
    root: summary.cwd,
  });
  return workspace.program;
}

export async function resumeSessionById(
  accessor: ServicesAccessor,
  sessionId: string,
  opts?: ResumeSessionOptions,
): Promise<ISessionScopeHandle | undefined> {
  try {
    return await accessor.get(ISessionManager).resume(sessionId, opts);
  } catch (error) {
    accessor
      .get(ITelemetryService)
      .withContext({ sessionId })
      .track2('session_load_failed', {
        reason: isError2(error) ? error.code : error instanceof Error ? error.name : 'unknown',
      });
    throw error;
  }
}

export function getLiveSessionById(
  accessor: ServicesAccessor,
  sessionId: string,
): ISessionScopeHandle | undefined {
  return accessor.get(ISessionManager).get(sessionId);
}

export async function closeSessionById(
  accessor: ServicesAccessor,
  sessionId: string,
): Promise<void> {
  await accessor.get(ISessionManager).close(sessionId);
}

type SessionLifecycleEvents = Required<
  Pick<SessionManager, 'onDidCloseSession' | 'onDidArchiveSession'>
>;

export function followSessionLifecycles(
  accessor: ServicesAccessor,
  follow: (service: SessionLifecycleEvents) => IDisposable,
): IDisposable {
  const manager = accessor.get(ISessionManager);
  if (manager.onDidCloseSession === undefined || manager.onDidArchiveSession === undefined) {
    return { dispose: () => {} };
  }
  return follow(manager as SessionLifecycleEvents);
}
