import type { ServicesAccessor } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager, type ISessionManager as SessionManager } from '#/app/sessionManager/sessionManager';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ErrorCodes, isError2 } from '#/errors';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ResumeSessionOptions } from '#/workspace/sessionLifecycle/sessionLifecycle';
import { IWorkspaceInstanceManager, type WorkspaceInstanceLease } from '#/workspace/workspaceInstance/workspaceInstanceManager';

export async function programForSession(
  accessor: ServicesAccessor,
  sessionId: string,
): Promise<WorkspaceInstanceLease | undefined> {
  const manager = accessor.get(ISessionManager);
  const live = manager.get(sessionId);
  if (live !== undefined) {
    const context = live.accessor.get(ISessionContext);
    return accessor.get(IWorkspaceInstanceManager).acquire({
      workspaceId: context.workspaceId,
      root: context.cwd,
    });
  }
  const summary = await accessor.get(ISessionIndex).get(sessionId);
  if (summary === undefined) return undefined;
  return accessor.get(IWorkspaceInstanceManager).acquire({
    workspaceId: summary.workspaceId,
    root: summary.cwd,
  });
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
      .withContext({ session_id: sessionId })
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

export interface StaleReloadOptions {
  readonly retry?: boolean;
  readonly onReloaded?: (session: ISessionScopeHandle) => Promise<void>;
}

const pendingStaleReloads = new WeakMap<
  SessionManager,
  Map<string, Promise<ISessionScopeHandle | undefined>>
>();

function reloadSessionSingleFlight(
  accessor: ServicesAccessor,
  sessionId: string,
): Promise<ISessionScopeHandle | undefined> {
  const manager = accessor.get(ISessionManager);
  let active = pendingStaleReloads.get(manager);
  if (active === undefined) {
    active = new Map();
    pendingStaleReloads.set(manager, active);
  }
  const existing = active.get(sessionId);
  if (existing !== undefined) return existing;
  const runReload = async (): Promise<ISessionScopeHandle | undefined> => {
    try {
      await closeSessionById(accessor, sessionId);
      return await resumeSessionById(accessor, sessionId);
    } finally {
      if (active.get(sessionId) === pending) active.delete(sessionId);
    }
  };
  const pending = runReload();
  active.set(sessionId, pending);
  return pending;
}

export async function reloadOnStale<T>(
  accessor: ServicesAccessor,
  sessionId: string,
  run: () => Promise<T>,
  options?: StaleReloadOptions,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isError2(error) || error.code !== ErrorCodes.SESSION_STALE) throw error;
    const session = await reloadSessionSingleFlight(accessor, sessionId);
    if (session === undefined) throw error;
    await options?.onReloaded?.(session);
    if (options?.retry === false) throw error;
  }
  return run();
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
