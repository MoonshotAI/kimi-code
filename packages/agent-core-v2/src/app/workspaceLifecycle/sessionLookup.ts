/**
 * `workspaceLifecycle` domain (L6) — pure session-lookup helpers over the handler chain.
 *
 * The explicit `sessionIndex` → `IWorkspaceLifecycleService.handlerFor` →
 * handler `IWorkspaceHandlerService` composition, shared by every caller
 * that addresses a session by id from outside the Workspace scope (edge
 * routes, in-process SDKs). These are plain functions over a STABLE
 * accessor (a `Scope` / scope-handle `accessor`, never a transient
 * `invokeFunction` one) — they are not an App-scope session lifecycle
 * facade: the live registry and every lifecycle method stay on the
 * handler's own service. Own no scoped state.
 */

import type { ServicesAccessor } from '#/_base/di/instantiation';
import { DisposableStore, type IDisposable } from '#/_base/di/lifecycle';
import type { ISessionScopeHandle, IWorkspaceScopeHandle } from '#/_base/di/scope';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ErrorCodes, isError2 } from '#/errors';
import {
  IWorkspaceHandlerService,
  type ResumeSessionOptions,
} from '#/workspace/workspaceHandler/workspaceHandler';

import { IWorkspaceLifecycleService } from './workspaceLifecycle';

/**
 * The handler of one session, resolved through the persisted index and
 * materialized on demand. Returns `undefined` when the session is unknown
 * (or its workspace cannot be resolved to a root — the old resume path's
 * `undefined` outcome).
 */
export async function handlerForSession(
  accessor: ServicesAccessor,
  sessionId: string,
): Promise<IWorkspaceScopeHandle | undefined> {
  const summary = await accessor.get(ISessionIndex).get(sessionId);
  if (summary === undefined) return undefined;
  try {
    return await accessor
      .get(IWorkspaceLifecycleService)
      .handlerFor({ workspaceId: summary.workspaceId, root: summary.cwd });
  } catch (error) {
    if (isError2(error) && error.code === ErrorCodes.WORKSPACE_NOT_FOUND) return undefined;
    throw error;
  }
}

/**
 * Resume a session by id through its handler; `undefined` when unknown.
 * Failures in the routing leg (index read, handler materialization) report
 * the same `session_load_failed` telemetry the handler reports for its own
 * resume failures — the old App-scope resume covered both from one call.
 */
export async function resumeSessionById(
  accessor: ServicesAccessor,
  sessionId: string,
  opts?: ResumeSessionOptions,
): Promise<ISessionScopeHandle | undefined> {
  let handler: IWorkspaceScopeHandle | undefined;
  try {
    handler = await handlerForSession(accessor, sessionId);
  } catch (error) {
    accessor
      .get(ITelemetryService)
      .withContext({ sessionId })
      .track2('session_load_failed', {
        reason: isError2(error) ? error.code : error instanceof Error ? error.name : 'unknown',
      });
    throw error;
  }
  if (handler === undefined) return undefined;
  return handler.accessor.get(IWorkspaceHandlerService).resume(sessionId, opts);
}

/** The live handler holding `sessionId`, without materializing anything. */
export function liveHandlerForSession(
  accessor: ServicesAccessor,
  sessionId: string,
): IWorkspaceScopeHandle | undefined {
  for (const handler of accessor.get(IWorkspaceLifecycleService).handlers.list()) {
    if (handler.accessor.get(IWorkspaceHandlerService).get(sessionId) !== undefined) {
      return handler;
    }
  }
  return undefined;
}

/** The live session handle for `sessionId`, without materializing anything. */
export function getLiveSessionById(
  accessor: ServicesAccessor,
  sessionId: string,
): ISessionScopeHandle | undefined {
  return liveHandlerForSession(accessor, sessionId)?.accessor
    .get(IWorkspaceHandlerService)
    .get(sessionId);
}

/** Close a live session through its handler; a no-op when the session is not live. */
export async function closeSessionById(
  accessor: ServicesAccessor,
  sessionId: string,
): Promise<void> {
  const handler = liveHandlerForSession(accessor, sessionId);
  if (handler === undefined) return;
  await handler.accessor.get(IWorkspaceHandlerService).close(sessionId);
}

/**
 * Subscribe `follow` to the `IWorkspaceHandlerService` of every handler —
 * present and future (handlers are never closed, so subscriptions stay
 * valid for the App lifetime). For App-scope observers of per-handler
 * events (e.g. `onDidCloseSession`).
 */
export function followWorkspaceHandlers(
  accessor: ServicesAccessor,
  follow: (service: IWorkspaceHandlerService) => IDisposable,
): IDisposable {
  const lifecycle = accessor.get(IWorkspaceLifecycleService);
  const store = new DisposableStore();
  for (const handler of lifecycle.handlers.list()) {
    store.add(follow(handler.accessor.get(IWorkspaceHandlerService)));
  }
  store.add(
    lifecycle.onDidMaterializeHandler((handler) => {
      if (!store.isDisposed) {
        store.add(follow(handler.accessor.get(IWorkspaceHandlerService)));
      }
    }),
  );
  return store;
}
