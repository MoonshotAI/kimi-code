/**
 * `workspaceLifecycle` domain — `IWorkspaceLifecycleService` implementation.
 *
 * Holds the live handler registry (`Map<workspaceId, IWorkspaceScopeHandle>`)
 * and materializes handlers through the DI scope tree, seeding each
 * Workspace scope with its `workspaceContext` (identity, catalog metadata,
 * the `sessions/{wd_id}` persistence scope, and the local runtime keying
 * pair). `handlerFor` is create-or-get with an in-flight join keyed by
 * workspaceId, so concurrent materializations of one workspace — by id or
 * by any alias spelling of its root — converge on a single handler; a
 * failed materialization only drops its own in-flight entry and never
 * disturbs live handlers. Materialization refreshes the catalog record
 * through `workspace.createOrTouch` (the same write the old per-session
 * materialization performed, now once per handler) — only local workspaces
 * are ever written to `workspaces.json`. Handlers are never closed: they
 * die with the App scope's disposal cascade. Bound at App scope.
 */

import { IInstantiationService } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import {
  createScopedChildHandle,
  type IWorkspaceScopeHandle,
  ScopeActivation,
  registerScopedService,
} from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IWorkspaceService, type Workspace } from '#/app/workspace/workspace';
import { ErrorCodes, Error2 } from '#/errors';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import {
  LOCAL_OS_BACKEND_ID,
  LOCAL_PERSISTENCE_BACKEND_ID,
  workspaceContextSeed,
  type IWorkspaceContext,
} from '#/workspace/workspaceContext/workspaceContext';
import { ISessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycle';
import { workspacePersistenceScope } from '#/workspace/sessionLifecycle/internal/addressing';

import {
  IWorkspaceLifecycleService,
  type WorkspaceHandlerRegistry,
  type WorkspaceRef,
  type WorkspaceSessionRegistry,
} from './workspaceLifecycle';

export class WorkspaceLifecycleService extends Service implements IWorkspaceLifecycleService {
  declare readonly _serviceBrand: undefined;
  private readonly live = new Map<string, IWorkspaceScopeHandle>();
  private readonly materializing = new Map<string, Promise<IWorkspaceScopeHandle>>();
  private readonly _onDidMaterializeHandler = this._register(
    new Emitter<IWorkspaceScopeHandle>(),
  );
  readonly onDidMaterializeHandler: Event<IWorkspaceScopeHandle> =
    this._onDidMaterializeHandler.event;

  readonly handlers: WorkspaceHandlerRegistry = {
    list: () => [...this.live.values()],
  };

  readonly sessions: WorkspaceSessionRegistry = {
    list: (workspaceId: string) => {
      const handler = this.live.get(workspaceId);
      if (handler === undefined) return [];
      return handler.accessor
        .get(ISessionLifecycleService)
        .list()
        .map((session) => session.id);
    },
  };

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IWorkspaceService private readonly workspaces: IWorkspaceService,
    @IHostEnvironment private readonly hostEnv: IHostEnvironment,
  ) {
    super();
  }

  async handlerFor(ref: WorkspaceRef): Promise<IWorkspaceScopeHandle> {
    if ('workspaceId' in ref) {
      const existing = this.live.get(ref.workspaceId);
      if (existing !== undefined) return existing;
      const root = ref.root ?? (await this.workspaces.get(ref.workspaceId))?.root;
      if (root === undefined) {
        throw new Error2(
          ErrorCodes.WORKSPACE_NOT_FOUND,
          `workspace ${ref.workspaceId} does not exist`,
        );
      }
      return this.joinMaterialization(ref.workspaceId, root);
    }
    const workspace = await this.workspaces.createOrTouch(ref.root);
    const existing = this.live.get(workspace.id);
    if (existing !== undefined) return existing;
    return this.joinMaterialization(workspace.id, workspace.root, workspace);
  }

  private joinMaterialization(
    workspaceId: string,
    root: string,
    known?: Workspace,
  ): Promise<IWorkspaceScopeHandle> {
    const inflight = this.materializing.get(workspaceId);
    if (inflight !== undefined) return inflight;
    const promise = this.doMaterialize(workspaceId, root, known).finally(() =>
      this.materializing.delete(workspaceId),
    );
    this.materializing.set(workspaceId, promise);
    return promise;
  }

  private async doMaterialize(
    workspaceId: string,
    root: string,
    known?: Workspace,
  ): Promise<IWorkspaceScopeHandle> {
    const workspace = known ?? (await this.workspaces.createOrTouch(root));
    const ctx: IWorkspaceContext = {
      _serviceBrand: undefined,
      workspaceId,
      cwd: workspace.root,
      source: 'local',
      meta: workspace,
      persistenceScope: workspacePersistenceScope(this.bootstrap.scope('sessions'), workspaceId),
      osBackendId: LOCAL_OS_BACKEND_ID,
      persistenceBackendId: LOCAL_PERSISTENCE_BACKEND_ID,
    };
    await this.hostEnv.ready;
    const handle = createScopedChildHandle(
      this.instantiation,
      LifecycleScope.Workspace,
      workspaceId,
      { seeds: workspaceContextSeed(ctx) },
    ) as IWorkspaceScopeHandle;
    this.live.set(workspaceId, handle);
    this._onDidMaterializeHandler.fire(handle);
    return handle;
  }
}

registerScopedService(
  LifecycleScope.App,
  IWorkspaceLifecycleService,
  WorkspaceLifecycleService,
  ScopeActivation.OnScopeCreated,
  'workspaceLifecycle',
);
