/**
 * `workspaceLifecycle` domain — workspace handler lifecycle contract.
 *
 * Defines the `IWorkspaceLifecycleService`, the App-scope owner of the live
 * workspace handler registry: one `IWorkspaceScopeHandle` per workspaceId,
 * materialized on demand through `handlerFor` (create-or-get with an
 * in-flight join, so concurrent sessions of one workspace never duplicate a
 * handler) and never closed afterwards — handlers die with the App scope.
 * A handler is addressed by `workspaceId` or by `root` (folded through the
 * `workspace` catalog, which is also the local runtime's metadata source);
 * the remote-runtime keying (`osBackendId` × `persistenceBackendId`) rides
 * on the handler's `workspaceContext` seed as an internal abstraction only.
 * Read side: `handlers.list()` and `sessions.list(workspaceId)`, plus
 * `onDidMaterializeHandler` for App-scope observers that must follow every
 * handler's per-handler services. There is deliberately NO App-scope
 * session lifecycle entry point — session create/resume/fork lives on the
 * handler's `ISessionLifecycleService`; callers compose `sessionIndex` →
 * `handlerFor` → handler.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IWorkspaceScopeHandle } from '#/_base/di/scope';
import type { Event } from '#/_base/event';

export type WorkspaceRef =
  | { readonly workspaceId: string; readonly root?: string }
  | { readonly root: string };

export interface WorkspaceHandlerRegistry {
  list(): readonly IWorkspaceScopeHandle[];
}

export interface WorkspaceSessionRegistry {
  list(workspaceId: string): readonly string[];
}

export interface IWorkspaceLifecycleService {
  readonly _serviceBrand: undefined;

  readonly onDidMaterializeHandler: Event<IWorkspaceScopeHandle>;
  handlerFor(ref: WorkspaceRef): Promise<IWorkspaceScopeHandle>;
  readonly handlers: WorkspaceHandlerRegistry;
  readonly sessions: WorkspaceSessionRegistry;
}

export const IWorkspaceLifecycleService: ServiceIdentifier<IWorkspaceLifecycleService> =
  createDecorator<IWorkspaceLifecycleService>('workspaceLifecycleService');
