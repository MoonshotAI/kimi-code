/**
 * `sessionLifecycle` domain (L6) — `ISessionLifecycleService` implementation.
 *
 * Owns the process-wide registry of live Session child scopes and implements
 * create, resume, fork, close, archive, restore, and failed-resume rollback.
 * It seeds session identity and storage context, prepares session catalogs and
 * MCP policy, runs lifecycle hooks and cron startup, and tears down Agents and
 * scopes. `bootstrap`, `workspace`, and `sessionIndex` provide persisted-session
 * addressing and discovery; successful create/fork operations are mirrored to
 * the v1 session index. Fresh startup persistence is removed only while it is
 * still discardable, while resumed or retained sessions remain recoverable.
 * Lifecycle events are published through `event` and `telemetry`. Bound at App
 * scope.
 */

import { randomUUID } from 'node:crypto';

import { join } from 'pathe';
import { ulid } from 'ulid';

import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import {
  createScopedChildHandle,
  type ISessionScopeHandle,
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
} from '#/_base/di/scope';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { Emitter, type Event } from '#/_base/event';
import { DEFAULT_PLAN_MODE_SECTION } from '#/agent/plan/configSection';
import { IAgentPlanService } from '#/agent/plan/plan';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { CRON_SESSION_TAG, type CronTask } from '#/app/cron/cronTask';
import { ICronTaskPersistence } from '#/app/cron/cronTaskPersistence';
import { IConfigService } from '#/app/config/config';
import { IEventService } from '#/app/event/event';
import {
  CHILD_SESSION_KIND,
  CHILD_SESSION_KIND_KEY,
  ISessionIndex,
  PARENT_SESSION_ID_KEY,
} from '#/app/sessionIndex/sessionIndex';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import { IWorkspaceService } from '#/app/workspace/workspace';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ErrorCodes, Error2, isError2 } from '#/errors';
import { createHooks, type HookSlot } from '#/hooks';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem, type HostDirEntry } from '#/os/interface/hostFileSystem';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import { ISessionCronService } from '#/session/cron/sessionCronService';
import { ISessionMcpService } from '#/session/mcp/sessionMcp';
import { labelsFromAgentMeta } from '#/session/agentLifecycle/subagentMetadata';
import { ISessionContext, sessionContextSeed } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata, type SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IWireService } from '#/wire/wire';
import {
  AGENT_WIRE_RECORD_KEY,
  createWireMetadataRecord,
  type WireRecord,
} from '#/wire/record';

import {
  type CreateChildSessionOptions,
  type CreateSessionOptions,
  type ForkSessionOptions,
  type SessionArchivedEvent,
  type SessionClosedEvent,
  type SessionCreatedEvent,
  type SessionForkedEvent,
  type SessionLifecycleHooks,
  type SessionWillCloseEvent,
  ISessionLifecycleService,
} from './sessionLifecycle';

type MaterializeSessionOptions = Omit<CreateSessionOptions, 'sessionId'> & {
  readonly sessionId: string;
  readonly workspaceId?: string;
};

interface MaterializedSession {
  readonly handle: ISessionScopeHandle;
  readonly node: SessionMaterializationNode;
  readonly context: ISessionContext;
}

interface MaterializeSessionPolicy {
  readonly cleanupFreshOnFailure: boolean;
  readonly requireFreshPath?: boolean;
  readonly prepare?: (context: ISessionContext) => Promise<void>;
}

interface AnnounceCreatedOptions {
  readonly prepare?: () => Promise<void>;
  readonly commit?: () => Promise<void>;
  readonly validate?: () => void;
  readonly beforePublish?: () => void;
}

interface SessionMaterializationNode {
  readonly handle: ISessionScopeHandle;
  readonly context: ISessionContext;
  readonly state: SessionPathState;
  globalPrev: SessionMaterializationNode | undefined;
  globalNext: SessionMaterializationNode | undefined;
  pathPrev: SessionMaterializationNode | undefined;
  pathNext: SessionMaterializationNode | undefined;
  retired: boolean;
}

interface SessionPathState {
  cleanupOnFailure: boolean;
}

export class SessionLifecycleService extends Disposable implements ISessionLifecycleService {
  declare readonly _serviceBrand: undefined;
  private readonly sessions = new Map<string, ISessionScopeHandle>();
  private readonly sessionTails = new Map<string, SessionMaterializationNode>();
  private readonly pathMutationTails = new Map<string, Promise<void>>();
  private readonly pathTails = new Map<string, SessionMaterializationNode>();
  private readonly handleNodes = new WeakMap<
    ISessionScopeHandle,
    SessionMaterializationNode
  >();
  private readonly _onDidCreateSession = this._register(new Emitter<SessionCreatedEvent>());
  readonly onDidCreateSession: Event<SessionCreatedEvent> = this._onDidCreateSession.event;
  private readonly _onDidCloseSession = this._register(new Emitter<SessionClosedEvent>());
  readonly onDidCloseSession: Event<SessionClosedEvent> = this._onDidCloseSession.event;
  private readonly _onDidArchiveSession = this._register(new Emitter<SessionArchivedEvent>());
  readonly onDidArchiveSession: Event<SessionArchivedEvent> = this._onDidArchiveSession.event;
  private readonly _onDidForkSession = this._register(new Emitter<SessionForkedEvent>());
  readonly onDidForkSession: Event<SessionForkedEvent> = this._onDidForkSession.event;
  private readonly lifecycleHooks = createHooks<
    SessionLifecycleHooks,
    keyof SessionLifecycleHooks
  >([
    'onDidCreateSession',
    'onWillCloseSession',
  ]);
  readonly hooks = {
    onDidCreateSession: withHandledDetachedNext(
      this.lifecycleHooks.onDidCreateSession,
    ),
    onWillCloseSession: this.lifecycleHooks.onWillCloseSession,
  };
  private readonly resuming = new Map<string, Promise<ISessionScopeHandle | undefined>>();

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @IHostEnvironment private readonly hostEnv: IHostEnvironment,
    @ISessionIndex private readonly index: ISessionIndex,
    @IAppendLogStore private readonly appendLogStore: IAppendLogStore,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @ICronTaskPersistence private readonly cronStore: ICronTaskPersistence,
    @IWorkspaceService private readonly workspaces: IWorkspaceService,
    @IProjectLocalConfigService
    private readonly projectLocalConfig: IProjectLocalConfigService,
    @IEventService private readonly event: IEventService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    super();
  }

  async create(opts: CreateSessionOptions): Promise<ISessionScopeHandle> {
    const sessionId = opts.sessionId ?? createSessionId();
    const materialized = await this.materializeSession(
      { ...opts, sessionId },
      { cleanupFreshOnFailure: true },
    );
    const { handle } = materialized;
    try {
      const main =
        opts.mainAgentBinding === undefined
          ? undefined
          : await handle.accessor.get(IAgentLifecycleService).create({
              agentId: MAIN_AGENT_ID,
              binding: opts.mainAgentBinding,
            });
      if (this.config.get<boolean>(DEFAULT_PLAN_MODE_SECTION) === true) {
        const planAgent = main ?? (await ensureMainAgent(handle));
        await planAgent.accessor.get(IAgentPlanService).enter();
      }
      // Index the session under the workspace id the registry actually resolved
      // (the same one seeding the session's storage scope), not a recomputed
      // `encodeWorkDirKey` — with root folding the two can diverge.
      await this.announceCreated(
        { sessionId, handle, source: 'startup' },
        {
          commit: async () => {
            this.assertCurrentMaterialization(materialized);
            await this.commitSessionPersistence(materialized);
            this.assertCurrentMaterialization(materialized);
            await this.appendSessionIndexEntry(
              sessionId,
              opts.workDir,
              handle.accessor.get(ISessionContext).workspaceId,
            );
          },
          validate: () => {
            this.assertCurrentMaterialization(materialized);
          },
        },
      );
      this.assertCurrentMaterialization(materialized);
      return handle;
    } catch (error) {
      await this.rollbackCreatedSession(materialized, true);
      throw error;
    }
  }

  private async materializeSession(
    opts: MaterializeSessionOptions,
    policy: MaterializeSessionPolicy,
  ): Promise<MaterializedSession> {
    const workspace = await this.workspaces.createOrTouch(opts.workDir);
    const workspaceId = opts.workspaceId ?? workspace.id;
    const sessionScope = this.bootstrap.sessionScope(workspaceId, opts.sessionId);
    const sessionDir = this.bootstrap.sessionDir(workspaceId, opts.sessionId);
    const metaScope = sessionScope;
    const ctx: ISessionContext = {
      _serviceBrand: undefined,
      sessionId: opts.sessionId,
      workspaceId,
      sessionDir,
      metaScope,
      cwd: opts.workDir,
      scope: (subKey?: string): string =>
        subKey === undefined || subKey === '' ? sessionScope : `${sessionScope}/${subKey}`,
    };
    const localWorkspaceDirs = await this.projectLocalConfig.readAdditionalDirs(opts.workDir);
    const callerAdditionalDirs = await this.projectLocalConfig.resolveAdditionalDirs(
      opts.workDir,
      opts.additionalDirs ?? [],
    );
    const additionalDirs = [...localWorkspaceDirs.additionalDirs, ...callerAdditionalDirs];
    await this.hostEnv.ready;
    return this.withPathMutation(sessionDir, async () => {
      const pathTailAtStart = this.pathTails.get(sessionDir);
      const sessionDirExists = await this.sessionDirExists(sessionDir);
      const sessionDirExisted = pathTailAtStart !== undefined || sessionDirExists;
      const initialPathState: SessionPathState = policy.cleanupFreshOnFailure
        ? pathTailAtStart?.state ?? { cleanupOnFailure: !sessionDirExisted }
        : { cleanupOnFailure: false };
      let handle: ISessionScopeHandle | undefined;
      try {
        if (policy.requireFreshPath === true && sessionDirExisted) {
          throw new Error2(
            ErrorCodes.SESSION_ALREADY_EXISTS,
            `Session "${opts.sessionId}" already exists`,
          );
        }
        await policy.prepare?.(ctx);
        handle = createScopedChildHandle(
          this.instantiation,
          LifecycleScope.Session,
          opts.sessionId,
          {
            extra: [
              ...sessionContextSeed(ctx),
              [ITelemetryService, this.telemetry.withContext({ sessionId: opts.sessionId })],
            ],
          },
        ) as ISessionScopeHandle;
        if (additionalDirs.length > 0) {
          handle.accessor.get(ISessionWorkspaceContext).setAdditionalDirs(additionalDirs);
        }
        await handle.accessor.get(ISessionMetadata).ready;
        await handle.accessor.get(ISessionToolPolicy).ready;
        void handle.accessor.get(ISessionSkillCatalog).ready;
        await handle.accessor.get(ISessionAgentProfileCatalog).ready;
        await handle.accessor.get(ISessionMcpService).ensureMcpReady(opts.mcpServers);

        const globalPrev = this.sessionTails.get(opts.sessionId);
        const pathPrev = this.pathTails.get(sessionDir);
        const pathState = pathPrev?.state ?? initialPathState;
        if (!policy.cleanupFreshOnFailure) pathState.cleanupOnFailure = false;
        const node: SessionMaterializationNode = {
          handle,
          context: ctx,
          state: pathState,
          globalPrev,
          globalNext: undefined,
          pathPrev,
          pathNext: undefined,
          retired: false,
        };
        if (globalPrev !== undefined) globalPrev.globalNext = node;
        if (pathPrev !== undefined) pathPrev.pathNext = node;
        this.sessions.set(opts.sessionId, handle);
        this.sessionTails.set(opts.sessionId, node);
        this.pathTails.set(sessionDir, node);
        this.handleNodes.set(handle, node);
        const disposeScope = handle.dispose.bind(handle);
        handle.dispose = () => {
          this.retireNode(node);
          disposeScope();
        };
        return {
          handle,
          node,
          context: ctx,
        };
      } catch (error) {
        if (handle !== undefined) {
          try {
            handle.dispose();
          } catch {}
        }
        if (
          policy.cleanupFreshOnFailure &&
          initialPathState.cleanupOnFailure &&
          this.pathTails.get(sessionDir) === undefined
        ) {
          await this.removeSessionPersistence(ctx);
        }
        throw error;
      }
    });
  }

  /**
   * Append one entry to the v1-compatible `session_index.jsonl`. `workspaceId`
   * must be the SAME id the session was materialized with (registry-resolved,
   * possibly folded from an alias spelling) — recomputing
   * `encodeWorkDirKey(workDir)` here could mint a different bucket and orphan
   * the session for v1 readers.
   */
  private async appendSessionIndexEntry(
    sessionId: string,
    workDir: string,
    workspaceId: string,
  ): Promise<void> {
    const sessionDir = this.bootstrap.sessionDir(workspaceId, sessionId);
    this.appendLogStore.append('', 'session_index.jsonl', {
      sessionId,
      sessionDir,
      workDir,
    });
    await this.appendLogStore.flush();
  }

  private async announceCreated(
    event: SessionCreatedEvent,
    options: AnnounceCreatedOptions = {},
  ): Promise<void> {
    let terminal: Promise<void> | undefined;
    let terminalOpen = true;
    let hookFailed = false;
    let hookError: unknown;
    try {
      await this.hooks.onDidCreateSession.run(
        event,
        () => {
          if (!terminalOpen && terminal === undefined) {
            const rejected = Promise.reject(
              new Error('Session creation hook terminal is already closed'),
            );
            void rejected.catch(() => {});
            return rejected;
          }
          return (terminal ??= (async () => {
            await options.prepare?.();
            await event.handle.accessor.get(ISessionCronService).start();
            await options.commit?.();
          })());
        },
      );
    } catch (error) {
      hookFailed = true;
      hookError = error;
    }
    terminalOpen = false;
    if (terminal === undefined) {
      if (hookFailed) throw hookError;
      throw new Error('Session creation hooks did not reach the lifecycle terminal');
    }
    let terminalFailed = false;
    let terminalError: unknown;
    try {
      await terminal;
    } catch (error) {
      terminalFailed = true;
      terminalError = error;
    }
    if (hookFailed) throw hookError;
    if (terminalFailed) throw terminalError;
    options.validate?.();
    options.beforePublish?.();
    options.validate?.();
    const sessionTelemetry = event.handle.accessor.get(ITelemetryService);
    this._onDidCreateSession.fire(event);
    options.validate?.();
    sessionTelemetry.track2('session_started', { resumed: event.source === 'resume' });
  }

  private async rollbackCreatedSession(
    materialized: MaterializedSession,
    removePersistence: boolean,
  ): Promise<boolean> {
    const { handle, node, context } = materialized;
    return this.withPathMutation(context.sessionDir, async () => {
      const ownedSession = this.sessionTails.get(handle.id) === node;
      const retired = this.retireNode(node);
      if (retired) {
        await this.drainAgents(handle).catch(() => {});
        try {
          handle.dispose();
        } catch {}
      }

      if (
        removePersistence &&
        node.state.cleanupOnFailure &&
        this.pathTails.get(context.sessionDir) === undefined
      ) {
        await this.removeSessionPersistence(context);
      }
      return ownedSession && retired;
    });
  }

  private async withPathMutation<T>(
    sessionDir: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const predecessor = this.pathMutationTails.get(sessionDir);
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pathMutationTails.set(sessionDir, tail);
    if (predecessor !== undefined) await predecessor;
    try {
      return await operation();
    } finally {
      release();
      if (this.pathMutationTails.get(sessionDir) === tail) {
        this.pathMutationTails.delete(sessionDir);
      }
    }
  }

  private async sessionDirExists(sessionDir: string): Promise<boolean> {
    try {
      await this.hostFs.stat(sessionDir);
      return true;
    } catch (error) {
      if (
        error instanceof HostFsError &&
        error.code === OsFsErrors.codes.OS_FS_NOT_FOUND
      ) {
        return false;
      }
      throw error;
    }
  }

  private async removeSessionPersistence(context: ISessionContext): Promise<void> {
    try {
      await this.hostFs.remove(context.sessionDir);
    } catch {
      return;
    }
    await this.index.invalidate(context.sessionId, context.workspaceId).catch(() => {});
  }

  private async commitSessionPersistence(
    materialized: MaterializedSession,
  ): Promise<void> {
    const { node, context } = materialized;
    node.state.cleanupOnFailure = false;
    await this.withPathMutation(context.sessionDir, async () => {});
  }

  private assertCurrentMaterialization(materialized: MaterializedSession): void {
    const { handle, node, context } = materialized;
    if (
      node.retired ||
      this.sessionTails.get(handle.id) !== node ||
      this.pathTails.get(context.sessionDir) !== node
    ) {
      throw new Error2(
        ErrorCodes.SESSION_NOT_FOUND,
        `Session "${handle.id}" is no longer current`,
      );
    }
  }

  private retireNode(node: SessionMaterializationNode): boolean {
    if (node.retired) return false;
    node.retired = true;

    const { globalPrev, globalNext, pathPrev, pathNext } = node;
    if (globalPrev !== undefined) globalPrev.globalNext = globalNext;
    if (globalNext !== undefined) globalNext.globalPrev = globalPrev;
    if (this.sessionTails.get(node.handle.id) === node) {
      if (globalPrev === undefined) {
        this.sessionTails.delete(node.handle.id);
        this.sessions.delete(node.handle.id);
      } else {
        this.sessionTails.set(node.handle.id, globalPrev);
        this.sessions.set(node.handle.id, globalPrev.handle);
      }
    }

    const sessionDir = node.context.sessionDir;
    if (pathPrev !== undefined) pathPrev.pathNext = pathNext;
    if (pathNext !== undefined) pathNext.pathPrev = pathPrev;
    if (this.pathTails.get(sessionDir) === node) {
      if (pathPrev === undefined) {
        this.pathTails.delete(sessionDir);
      } else {
        this.pathTails.set(sessionDir, pathPrev);
      }
    }

    this.handleNodes.delete(node.handle);
    node.globalPrev = undefined;
    node.globalNext = undefined;
    node.pathPrev = undefined;
    node.pathNext = undefined;
    return true;
  }

  private terminalCut(handle: ISessionScopeHandle): SessionMaterializationNode[] {
    const node = this.handleNodes.get(handle);
    if (node === undefined || node.retired) return [];
    const cut: SessionMaterializationNode[] = [];
    let candidate: SessionMaterializationNode | undefined = node;
    while (candidate !== undefined) {
      cut.push(candidate);
      candidate = candidate.globalPrev;
    }
    for (const item of cut) {
      item.state.cleanupOnFailure = false;
      this.retireNode(item);
    }
    return cut;
  }

  private async disposeNodes(
    nodes: readonly SessionMaterializationNode[],
  ): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const node of nodes) {
      try {
        await this.drainAgents(node.handle);
      } catch (error) {
        errors.push(error);
      }
      try {
        node.handle.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  get(sessionId: string): ISessionScopeHandle | undefined {
    if (this.resuming.has(sessionId)) return undefined;
    return this.sessions.get(sessionId);
  }

  resume(sessionId: string): Promise<ISessionScopeHandle | undefined> {
    const inflight = this.resuming.get(sessionId);
    if (inflight !== undefined) return inflight;
    const live = this.sessions.get(sessionId);
    if (live !== undefined) return Promise.resolve(live);
    const promise = this.doResume(sessionId)
      .catch((error: unknown) => {
        this.telemetry
          .withContext({ sessionId })
          .track2('session_load_failed', {
            reason: isError2(error) ? error.code : error instanceof Error ? error.name : 'unknown',
          });
        throw error;
      })
      .finally(() => this.resuming.delete(sessionId));
    this.resuming.set(sessionId, promise);
    return promise;
  }

  private async doResume(sessionId: string): Promise<ISessionScopeHandle | undefined> {
    const live = this.sessions.get(sessionId);
    if (live !== undefined) return live;

    const summary = await this.index.get(sessionId);
    if (summary === undefined) return undefined;
    const workspace =
      summary.cwd === undefined ? await this.workspaces.get(summary.workspaceId) : undefined;
    const workDir = summary.cwd ?? workspace?.root;
    if (workDir === undefined) return undefined;

    const materialized = await this.materializeSession(
      {
        sessionId,
        workDir,
        workspaceId: summary.workspaceId,
      },
      { cleanupFreshOnFailure: false },
    );
    const { handle } = materialized;
    try {
      const agents = handle.accessor.get(IAgentLifecycleService);
      await this.announceCreated(
        { sessionId, handle, source: 'resume' },
        {
          prepare: async () => {
            if (agents.get(MAIN_AGENT_ID) === undefined) {
              await agents.create({ agentId: MAIN_AGENT_ID });
            }
          },
          validate: () => {
            this.assertCurrentMaterialization(materialized);
          },
        },
      );
      this.assertCurrentMaterialization(materialized);
      return handle;
    } catch (error) {
      await this.rollbackCreatedSession(materialized, false);
      throw error;
    }
  }

  list(): readonly ISessionScopeHandle[] {
    const ready: ISessionScopeHandle[] = [];
    for (const [id, handle] of this.sessions) {
      if (!this.resuming.has(id)) ready.push(handle);
    }
    return ready;
  }

  rollbackResume(handle: ISessionScopeHandle): void {
    const node = this.handleNodes.get(handle);
    if (node === undefined || node.retired) return;
    const removed = this.sessionTails.get(handle.id) === node;
    const restored = removed && node.globalPrev !== undefined;
    this.retireNode(node);
    try {
      handle.dispose();
    } finally {
      if (removed && !restored && this.sessions.get(handle.id) === undefined) {
        this._onDidCloseSession.fire({ sessionId: handle.id });
      }
    }
  }

  async close(sessionId: string): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (handle === undefined) return;
    await this.announceWillClose({ sessionId, handle, reason: 'exit' });
    const cut = this.terminalCut(handle);
    const errors = await this.disposeNodes(cut);
    if (cut.length > 0 && this.sessions.get(sessionId) === undefined) {
      this._onDidCloseSession.fire({ sessionId });
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, `Failed to close session "${sessionId}"`);
    }
  }

  async archive(sessionId: string): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (handle === undefined) return;
    const node = this.handleNodes.get(handle);
    if (node === undefined) return;
    const meta = handle.accessor.get(ISessionMetadata);
    await this.announceWillClose({ sessionId, handle, reason: 'exit' });
    const { cut, archived } = await this.withPathMutation(
      node.context.sessionDir,
      async () => {
        if (node.retired) return { cut: [], archived: false };
        let archived = false;
        if (this.pathTails.get(node.context.sessionDir) === node) {
          await meta.setArchived(true);
          archived =
            !node.retired && this.pathTails.get(node.context.sessionDir) === node;
        }
        return { cut: this.terminalCut(handle), archived };
      },
    );
    const errors = await this.disposeNodes(cut);
    if (archived && cut.length > 0 && this.sessions.get(sessionId) === undefined) {
      this.event.publish({
        type: 'event.session.archived',
        payload: { sessionId },
      });
      this._onDidArchiveSession.fire({ sessionId });
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, `Failed to archive session "${sessionId}"`);
    }
  }

  async restore(sessionId: string): Promise<ISessionScopeHandle | undefined> {
    const handle = await this.resume(sessionId);
    if (handle === undefined) return undefined;
    await handle.accessor.get(ISessionMetadata).setArchived(false);
    return handle;
  }

  private async announceWillClose(event: SessionWillCloseEvent): Promise<void> {
    await this.hooks.onWillCloseSession.run(event);
  }

  private async drainAgents(handle: ISessionScopeHandle): Promise<void> {
    const agentLifecycle = handle.accessor.get(IAgentLifecycleService);
    for (const agent of agentLifecycle.list()) {
      await agentLifecycle.remove(agent.id);
    }
  }

  async fork(opts: ForkSessionOptions): Promise<ISessionScopeHandle> {
    const sourceId = opts.sourceSessionId;

    const sourceHandle = this.sessions.get(sourceId);
    const indexSummary = await this.index.get(sourceId);
    if (sourceHandle === undefined && indexSummary === undefined) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sourceId} does not exist`);
    }
    const workspaceId =
      sourceHandle !== undefined
        ? sourceHandle.accessor.get(ISessionContext).workspaceId
        : indexSummary!.workspaceId;

    // Fork is unconditional — it never rejects on the source being busy.
    // Copying a live journal yields a torn prefix (a turn cut mid-flight),
    // which is exactly the state a crash leaves behind, and replay already
    // normalizes that on every restore. The source keeps running untouched;
    // the fork simply continues from the copy point. No admission gate, no
    // quiesce: the only requirement is a durable copy point, which
    // `copyAgentWire`'s flush provides.
    let targetId: string | undefined;
    let materializedTarget: MaterializedSession | undefined;
    try {
      const workspace = await this.workspaces.get(workspaceId);
      if (workspace === undefined) {
        throw new Error2(ErrorCodes.WORKSPACE_NOT_FOUND, `workspace ${workspaceId} does not exist`);
      }

      const sourceMeta =
        sourceHandle !== undefined
          ? await sourceHandle.accessor.get(ISessionMetadata).read()
          : await this.readMetaFromDisk(workspaceId, sourceId);

      targetId = opts.newSessionId ?? createSessionId();
      if (this.sessions.has(targetId) || (await this.index.get(targetId)) !== undefined) {
        throw new Error2(
          ErrorCodes.SESSION_ALREADY_EXISTS,
          `Session "${targetId}" already exists`,
        );
      }

      const createdTargetId = targetId;
      const materialized = await this.materializeSession(
        {
          sessionId: createdTargetId,
          workDir: workspace.root,
          workspaceId,
        },
        {
          cleanupFreshOnFailure: true,
          requireFreshPath: true,
          prepare: (context) =>
            this.copySessionFiles(
              this.bootstrap.sessionDir(workspaceId, sourceId),
              context.sessionDir,
            ),
        },
      );
      materializedTarget = materialized;
      const target = materialized.handle;
      const targetCtx = target.accessor.get(ISessionContext);
      const targetMeta = target.accessor.get(ISessionMetadata);

      const sourceAgents = sourceMeta?.agents ?? {};
      const agentIds = Object.keys(sourceAgents);
      for (const agentId of agentIds) {
        await this.copyAgentWire({
          sourceHandle,
          sourceWorkspaceId: workspaceId,
          sourceSessionId: sourceId,
          agentId,
          targetWorkspaceId: targetCtx.workspaceId,
          targetSessionId: targetCtx.sessionId,
        });
      }

      const title = opts.title ?? `Fork: ${sourceMeta?.title || sourceId}`;
      await targetMeta.update({
        title,
        isCustomTitle: opts.title !== undefined ? true : sourceMeta?.isCustomTitle === true,
        forkedFrom: sourceId,
        archived: false,
        lastPrompt: sourceMeta?.lastPrompt,
        custom: forkCustomMetadata(sourceMeta?.custom, opts.metadata),
      });

      await this.duplicateCronTasks(workspaceId, sourceId, targetId);

      for (const agentId of agentIds) {
        const sourceAgent = sourceAgents[agentId]!;
        await target.accessor.get(IAgentLifecycleService).create({
          agentId,
          forkedFrom: sourceAgent.forkedFrom,
          labels: labelsFromAgentMeta(sourceAgent),
        });
      }

      await this.announceCreated(
        { sessionId: targetId, handle: target, source: 'fork' },
        {
          commit: async () => {
            this.assertCurrentMaterialization(materialized);
            await this.commitSessionPersistence(materialized);
            this.assertCurrentMaterialization(materialized);
            await this.appendSessionIndexEntry(
              createdTargetId,
              workspace.root,
              targetCtx.workspaceId,
            );
          },
          validate: () => {
            this.assertCurrentMaterialization(materialized);
          },
          beforePublish: () => {
            this._onDidForkSession.fire({
              sourceSessionId: sourceId,
              sessionId: createdTargetId,
              handle: target,
            });
          },
        },
      );
      this.assertCurrentMaterialization(materialized);
      return target;
    } catch (error) {
      if (materializedTarget !== undefined) {
        await this.rollbackCreatedSession(materializedTarget, true);
      }
      throw error;
    }
  }

  async createChild(opts: CreateChildSessionOptions): Promise<ISessionScopeHandle> {
    const title =
      opts.title ??
      `Child: ${(await this.resolveSourceTitle(opts.sourceSessionId)) ?? opts.sourceSessionId}`;
    const metadata = {
      ...opts.metadata,
      [PARENT_SESSION_ID_KEY]: opts.sourceSessionId,
      [CHILD_SESSION_KIND_KEY]: CHILD_SESSION_KIND,
    };
    return this.fork({
      sourceSessionId: opts.sourceSessionId,
      newSessionId: opts.newSessionId,
      title,
      metadata,
    });
  }

  private async resolveSourceTitle(sourceId: string): Promise<string | undefined> {
    const live = this.sessions.get(sourceId);
    if (live !== undefined) {
      return (await live.accessor.get(ISessionMetadata).read()).title;
    }
    return (await this.index.get(sourceId))?.title;
  }

  private async copyAgentWire(args: {
    readonly sourceHandle: ISessionScopeHandle | undefined;
    readonly sourceWorkspaceId: string;
    readonly sourceSessionId: string;
    readonly agentId: string;
    readonly targetWorkspaceId: string;
    readonly targetSessionId: string;
  }): Promise<void> {
    if (args.sourceHandle !== undefined) {
      const agentHandle = args.sourceHandle.accessor
        .get(IAgentLifecycleService)
        .get(args.agentId);
      if (agentHandle !== undefined) {
        await agentHandle.accessor.get(IWireService).flush();
      }
    }

    const records = await collect(
      this.appendLogStore.read<WireRecord>(
        this.bootstrap.agentScope(
          args.sourceWorkspaceId,
          args.sourceSessionId,
          args.agentId,
        ),
        AGENT_WIRE_RECORD_KEY,
      ),
    );
    if (records.length === 0) {
      records.push(createWireMetadataRecord());
    } else if (records[0]?.type !== 'metadata') {
      records.unshift(createWireMetadataRecord());
    }
    records.push(forkedRecord());

    await this.appendLogStore.rewrite(
      this.bootstrap.agentScope(
        args.targetWorkspaceId,
        args.targetSessionId,
        args.agentId,
      ),
      AGENT_WIRE_RECORD_KEY,
      records,
    );
  }

  private async copySessionFiles(sourceDir: string, targetDir: string): Promise<void> {
    let entries: readonly HostDirEntry[];
    try {
      entries = await this.hostFs.readdir(sourceDir);
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }
    await this.copySessionDirEntries(sourceDir, targetDir, entries, '');
  }

  private async copySessionDirEntries(
    sourceDir: string,
    targetDir: string,
    entries: readonly HostDirEntry[],
    relBase: string,
  ): Promise<void> {
    for (const entry of entries) {
      const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`;
      if (rel === 'state.json' || rel === 'logs' || entry.name === AGENT_WIRE_RECORD_KEY) {
        continue;
      }
      if (entry.isSymbolicLink === true) continue;
      const sourcePath = join(sourceDir, entry.name);
      const targetPath = join(targetDir, entry.name);
      if (entry.isDirectory) {
        let children: readonly HostDirEntry[];
        try {
          children = await this.hostFs.readdir(sourcePath);
        } catch (error) {
          if (isMissingFileError(error)) continue;
          throw error;
        }
        await this.hostFs.mkdir(targetPath, { recursive: true });
        await this.copySessionDirEntries(sourcePath, targetPath, children, rel);
      } else if (entry.isFile) {
        const data = await this.hostFs.readBytes(sourcePath);
        await this.hostFs.mkdir(targetDir, { recursive: true });
        await this.hostFs.writeBytes(targetPath, data);
      }
    }
  }

  private async duplicateCronTasks(
    workspaceId: string,
    sourceId: string,
    targetId: string,
  ): Promise<void> {
    const tasks = await this.cronStore.list({ workspaceId });
    for (const task of tasks) {
      if (task.tags?.[CRON_SESSION_TAG] !== sourceId) continue;
      const clone: CronTask = {
        ...task,
        id: ulid(),
        tags: { ...task.tags, [CRON_SESSION_TAG]: targetId },
      };
      await this.cronStore.save(workspaceId, clone);
    }
  }

  private async readMetaFromDisk(
    workspaceId: string,
    sessionId: string,
  ): Promise<SessionMeta | undefined> {
    return this.docs.get<SessionMeta>(
      this.bootstrap.sessionScope(workspaceId, sessionId),
      'state.json',
    );
  }
}

registerScopedService(
  LifecycleScope.App,
  ISessionLifecycleService,
  SessionLifecycleService,
  ScopeActivation.OnScopeCreated,
  'sessionLifecycle',
);

function withHandledDetachedNext<TContext>(slot: HookSlot<TContext>): HookSlot<TContext> {
  return {
    register: (id, handler, options) =>
      slot.register(
        id,
        (context, next) =>
          handler(context, (override) => {
            const result = next(override);
            void result.catch(() => {});
            return result;
          }),
        options,
      ),
    delete: (id) => slot.delete(id),
    run: (context, terminal) => slot.run(context, terminal),
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

function isMissingFileError(error: unknown): boolean {
  const unwrapped = unwrapErrorCause(error);
  if (unwrapped === null || typeof unwrapped !== 'object') return false;
  const code = (unwrapped as { readonly code?: unknown }).code;
  return code === 'ENOENT';
}

function createSessionId(): string {
  return `session_${randomUUID()}`;
}

function forkedRecord(): WireRecord {
  return { type: 'forked', time: Date.now() };
}

function forkCustomMetadata(
  source: Record<string, unknown> | undefined,
  input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const merged = { ...withoutGoal(source), ...withoutGoal(input) };
  return Object.keys(merged).length === 0 ? undefined : merged;
}

function withoutGoal(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (value === undefined) return {};
  const { goal: _drop, ...rest } = value as { goal?: unknown; [key: string]: unknown };
  return rest;
}
