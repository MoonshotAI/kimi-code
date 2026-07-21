/**
 * `sessionLifecycle` domain (L6) — `ISessionLifecycleService` implementation.
 *
 * Owns the process-wide registry of open Session child scopes, creating them
 * through the DI scope tree and seeding each with its identity and storage
 * addressing, running lifecycle hook slots, and tearing them down on
 * close/archive — archiving flags the session's `sessionMetadata`, removes
 * its `agentLifecycle` agents, restoring clears the archived flag, and
 * broadcasts through `event`; session start and resume failures are reported
 * through `telemetry`. Because hosts bind their telemetry context only after
 * create()/resume() returns, the created-session announcement binds the
 * session id into telemetry context before emitting `session_started`, and the
 * resume-failure path does the same before `session_load_failed`.
 * Materializes the session's initial metadata on
 * creation by resolving `sessionMetadata`. Bound at App scope. Persisted
 * sessions are discovered through the `sessionIndex` read model, and workspace
 * roots are remembered through `workspace`. On create / fork the
 * session is also appended to the shared `session_index.jsonl` so v1 clients
 * (TUI, export) can discover sessions created by the v2 engine; the entry is
 * indexed under the registry-resolved workspace id — the same id seeding the
 * session's storage scope — so an alias spelling of the workDir cannot split
 * the session into a bucket v1 readers never look in. Fork flushes
 * live Agent wire journals, normalizes a missing protocol envelope, and
 * appends the fork boundary before restoring the target Agent. On
 * materialize, the session's metadata, tool policy, and agent-profile catalog
 * are awaited before the handle is published — agent-file discovery is local-
 * fs and cheap, and a resumed session's first turn must see file-defined
 * agent types in the `Agent` tool description; the catalog's `ready` only
 * rejects for a fatal explicit-source error, exactly the case that should
 * fail fast, and on that failure the half-materialized handle is disposed
 * instead of poisoning the session cache (the skill catalog, by contrast, is
 * kicked fire-and-forget). The session-level eager services whose
 * subscriptions must exist before the first agent / turn (external hooks,
 * cron) are force-instantiated at the same point.
 *
 * Every materialization (create/resume/fork-target) first takes the session's
 * cross-process write lease under `session-leases/` and registers its
 * `ISessionWriteAuthority` with the `writeAuthorityRegistry`, so the
 * journal/state fencing gates have exactly one authority per live session.
 * A preparing scope is private until metadata, MCP, caller-specific setup and
 * lifecycle hooks finish. Close/archive move the entry through a draining
 * phase, dispose producers, durably flush only that session's append-log tail,
 * and release authority only after the barrier succeeds. A failed barrier
 * keeps the lease registered for a safe retry; lease loss takes the explicit
 * dirty-abort path without claiming a clean handoff.
 */

import { randomUUID } from 'node:crypto';

import { join } from 'pathe';
import { ulid } from 'ulid';

import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import {
  createScopedChildHandle,
  type ISessionScopeHandle,
  LifecycleScope,
  registerScopedService,
} from '#/_base/di/scope';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { Emitter, type Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
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
import { createHooks } from '#/hooks';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem, type HostDirEntry } from '#/os/interface/hostFileSystem';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IWriteAuthorityRegistry } from '#/persistence/interface/writeAuthority';
import {
  type CrossProcessLockInspection,
  ICrossProcessLockService,
  OsLockErrors,
} from '#/os/interface/crossProcessLock';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentTaskService } from '#/agent/task/task';
import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import { ISessionMcpService } from '#/session/mcp/sessionMcp';
import { labelsFromAgentMeta } from '#/session/agentLifecycle/subagentMetadata';
import { ISessionExternalHooksService } from '#/session/externalHooks/externalHooks';
import { ISessionContext, sessionContextSeed } from '#/session/sessionContext/sessionContext';
import { ISessionCronService } from '#/session/cron/sessionCronService';
import {
  type HeldByPeerDetails,
  heldByPeerDetailsFromInspection,
  LEASE_CREATING_RETRY_AFTER_MS,
  SessionLease,
  sessionLeasePath,
  sessionLeaseSeed,
} from '#/session/sessionLease/sessionLease';
import { ISessionLeaseContactProvider } from '#/session/sessionLease/sessionLeaseContactProvider';
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
  type SessionWillReleaseEvent,
  ISessionLifecycleService,
} from './sessionLifecycle';

type MaterializeSessionOptions = Omit<CreateSessionOptions, 'sessionId'> & {
  readonly sessionId: string;
  readonly workspaceId?: string;
};

type SessionEntryPhase = 'preparing' | 'active' | 'draining' | 'flush-failed';
type SessionCloseKind = 'close' | 'archive';

interface SessionEntry {
  phase: SessionEntryPhase;
  readonly handle: ISessionScopeHandle;
  readonly lease: SessionLease;
  readonly registration: IDisposable;
  readonly scope: string;
  disposed: boolean;
  closeKind?: SessionCloseKind;
  closeStep: number;
  closePromise?: Promise<void>;
  dirtyAbortPromise?: Promise<void>;
}

export class SessionLifecycleService extends Disposable implements ISessionLifecycleService {
  declare readonly _serviceBrand: undefined;
  private readonly entries = new Map<string, SessionEntry>();
  private readonly _onDidCreateSession = this._register(new Emitter<SessionCreatedEvent>());
  readonly onDidCreateSession: Event<SessionCreatedEvent> = this._onDidCreateSession.event;
  private readonly _onDidCloseSession = this._register(new Emitter<SessionClosedEvent>());
  readonly onDidCloseSession: Event<SessionClosedEvent> = this._onDidCloseSession.event;
  private readonly _onDidArchiveSession = this._register(new Emitter<SessionArchivedEvent>());
  readonly onDidArchiveSession: Event<SessionArchivedEvent> = this._onDidArchiveSession.event;
  private readonly _onDidForkSession = this._register(new Emitter<SessionForkedEvent>());
  readonly onDidForkSession: Event<SessionForkedEvent> = this._onDidForkSession.event;
  readonly hooks = createHooks<SessionLifecycleHooks, keyof SessionLifecycleHooks>([
    'onDidCreateSession',
    'onWillCloseSession',
    'onWillReleaseSession',
  ]);
  private readonly resuming = new Map<string, Promise<ISessionScopeHandle | undefined>>();
  private readonly inFlightOperations = new Set<Promise<unknown>>();
  private closing = false;

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
    @ILogService private readonly log: ILogService,
    @ICrossProcessLockService private readonly locks: ICrossProcessLockService,
    @IWriteAuthorityRegistry private readonly authorityRegistry: IWriteAuthorityRegistry,
    @ISessionLeaseContactProvider
    private readonly leaseContact: ISessionLeaseContactProvider,
  ) {
    super();
  }

  beginClose(): Promise<void> {
    this.closing = true;
    return Promise.allSettled([...this.inFlightOperations, ...this.resuming.values()]).then(() => undefined);
  }

  async create(opts: CreateSessionOptions): Promise<ISessionScopeHandle> {
    this.assertOpen();
    return this.trackOperation(this.doCreate(opts));
  }

  private async doCreate(opts: CreateSessionOptions): Promise<ISessionScopeHandle> {
    const sessionId = opts.sessionId ?? createSessionId();
    const entry = await this.materializeSession({ ...opts, sessionId });
    const handle = entry.handle;
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
      await this.appendSessionIndexEntry(
        sessionId,
        opts.workDir,
        handle.accessor.get(ISessionContext).workspaceId,
      );
      this.activateSession(entry);
      await this.announceCreated({ sessionId, handle, source: 'startup' });
      return handle;
    } catch (error) {
      const sessionDir = handle.accessor.get(ISessionContext).sessionDir;
      await this.drainAgents(handle).catch(() => {});
      this.rollbackSession(entry);
      await this.hostFs.remove(sessionDir).catch(() => {});
      throw error;
    }
  }

  private async materializeSession(opts: MaterializeSessionOptions): Promise<SessionEntry> {
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
    const lease = await this.acquireSessionLease(opts.sessionId);
    let registration: IDisposable;
    try {
      registration = this.authorityRegistry.register(lease);
    } catch (error) {
      lease.release();
      throw error;
    }
    let entry: SessionEntry | undefined;
    try {
      const handle = createScopedChildHandle(
        this.instantiation,
        LifecycleScope.Session,
        opts.sessionId,
        {
          extra: [...sessionContextSeed(ctx), ...sessionLeaseSeed(lease)],
        },
      ) as ISessionScopeHandle;
      if (additionalDirs.length > 0) {
        handle.accessor.get(ISessionWorkspaceContext).setAdditionalDirs(additionalDirs);
      }
      entry = {
        phase: 'preparing',
        handle,
        lease,
        registration,
        scope: sessionScope,
        disposed: false,
        closeStep: 0,
      };
      this.entries.set(opts.sessionId, entry);
      handle.accessor.get(ISessionExternalHooksService);
      handle.accessor.get(ISessionCronService);
      await handle.accessor.get(ISessionMetadata).ready;
      await handle.accessor.get(ISessionToolPolicy).ready;
      void handle.accessor.get(ISessionSkillCatalog).ready;
      await handle.accessor.get(ISessionAgentProfileCatalog).ready;
      await handle.accessor.get(ISessionMcpService).ensureMcpReady(opts.mcpServers);
      return entry;
    } catch (error) {
      if (entry !== undefined) {
        this.rollbackSession(entry);
      } else {
        registration.dispose();
        lease.release();
      }
      throw error;
    }
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
    await this.appendLogStore.flush('');
  }

  private async announceCreated(event: SessionCreatedEvent): Promise<void> {
    await this.hooks.onDidCreateSession.run(event);
    this._onDidCreateSession.fire(event);
    this.telemetry.setContext({ sessionId: event.sessionId });
    this.telemetry.track2('session_started', { resumed: event.source === 'resume' });
  }

  get(sessionId: string): ISessionScopeHandle | undefined {
    const entry = this.entries.get(sessionId);
    return entry?.phase === 'active' ? entry.handle : undefined;
  }

  resume(sessionId: string): Promise<ISessionScopeHandle | undefined> {
    if (this.closing) return Promise.reject(this.lifecycleClosingError());
    const inflight = this.resuming.get(sessionId);
    if (inflight !== undefined) return inflight;
    const live = this.get(sessionId);
    if (live !== undefined) return Promise.resolve(live);
    const promise = this.doResume(sessionId)
      .catch((error: unknown) => {
        this.telemetry.setContext({ sessionId });
        this.telemetry.track2('session_load_failed', {
          reason: isError2(error) ? error.code : error instanceof Error ? error.name : 'unknown',
        });
        throw error;
      })
      .finally(() => this.resuming.delete(sessionId));
    this.resuming.set(sessionId, promise);
    return promise;
  }

  private async doResume(sessionId: string): Promise<ISessionScopeHandle | undefined> {
    const live = this.get(sessionId);
    if (live !== undefined) return live;

    const summary = await this.index.get(sessionId);
    if (summary === undefined) return undefined;
    const workspace =
      summary.cwd === undefined ? await this.workspaces.get(summary.workspaceId) : undefined;
    const workDir = summary.cwd ?? workspace?.root;
    if (workDir === undefined) return undefined;

    const entry = await this.materializeSession({
      sessionId,
      workDir,
      workspaceId: summary.workspaceId,
    });
    const handle = entry.handle;
    try {
      const agents = handle.accessor.get(IAgentLifecycleService);
      if (agents.get(MAIN_AGENT_ID) === undefined) {
        await agents.create({ agentId: MAIN_AGENT_ID });
      }
      this.activateSession(entry);
      await this.announceCreated({ sessionId, handle, source: 'resume' });
      return handle;
    } catch (error) {
      this.rollbackSession(entry);
      throw error;
    }
  }

  list(): readonly ISessionScopeHandle[] {
    const ready: ISessionScopeHandle[] = [];
    for (const entry of this.entries.values()) {
      if (entry.phase === 'active') ready.push(entry.handle);
    }
    return ready;
  }

  async close(sessionId: string): Promise<void> {
    await this.closeSession(sessionId, 'close');
  }

  async closeAll(): Promise<void> {
    await this.beginClose();
    const failures: unknown[] = [];
    for (const [sessionId, entry] of this.entries) {
      try {
        if (entry.phase === 'flush-failed') {
          await this.forceAbort(sessionId);
          continue;
        }
        try {
          await this.close(sessionId);
        } catch (error) {
          if (this.entries.get(sessionId)?.phase !== 'flush-failed') throw error;
          await this.forceAbort(sessionId);
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'failed to close all sessions');
  }

  async forceAbort(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) return;
    if (entry.phase !== 'flush-failed') {
      throw new Error2(
        ErrorCodes.SESSION_DURABILITY_FAILED,
        `session ${sessionId} can only be force-aborted after a durability barrier failure`,
        { details: { sessionId, phase: entry.phase } },
      );
    }

    entry.lease.assertWritable();
    await this.docs.update<SessionMeta>(entry.scope, 'state.json', (current) => {
      if (current === undefined) {
        throw new Error2(
          ErrorCodes.SESSION_DURABILITY_FAILED,
          `session ${sessionId} metadata is missing during force-abort`,
          { details: { sessionId } },
        );
      }
      return {
        ...current,
        custom: {
          ...current.custom,
          dirtyAbort: { reason: 'flush-failed', at: Date.now() },
        },
      };
    });
    this.telemetry.track2('session_dirty_abort', { session_id: sessionId, reason: 'flush-failed' });
    this.log.warn('force-aborting session after an ambiguous durability failure', { sessionId });
    await this.dirtyAbortSession(entry);
  }

  async archive(sessionId: string): Promise<void> {
    await this.closeSession(sessionId, 'archive');
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

  private async announceWillRelease(
    event: SessionWillReleaseEvent,
    entry: SessionEntry,
  ): Promise<void> {
    try {
      await this.hooks.onWillReleaseSession.run(event);
    } catch (error) {
      entry.phase = 'flush-failed';
      throw error;
    }
  }

  private async drainAgents(handle: ISessionScopeHandle): Promise<void> {
    const agentLifecycle = handle.accessor.get(IAgentLifecycleService);
    for (const agent of agentLifecycle.list()) {
      await agentLifecycle.remove(agent.id);
    }
  }

  private async closeSession(sessionId: string, kind: SessionCloseKind): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) return;
    if (entry.phase === 'preparing') {
      this.rollbackSession(entry);
      return;
    }
    if (entry.phase === 'active') {
      entry.phase = 'draining';
      entry.closeKind = kind;
      entry.closeStep = 0;
    }
    if (entry.closePromise !== undefined) {
      await entry.closePromise;
      return;
    }
    const closePromise = this.runSessionClose(sessionId, entry);
    entry.closePromise = closePromise;
    try {
      await closePromise;
    } finally {
      if (this.entries.get(sessionId) === entry && entry.closePromise === closePromise) {
        entry.closePromise = undefined;
      }
    }
  }

  private async runSessionClose(sessionId: string, entry: SessionEntry): Promise<void> {
    const kind = entry.closeKind ?? 'close';
    const stepCount = kind === 'close' ? 4 : 6;
    while (entry.closeStep < stepCount) {
      if (kind === 'close') {
        await this.runCloseStep(sessionId, entry);
      } else {
        await this.runArchiveStep(sessionId, entry);
      }
      entry.closeStep++;
    }
    try {
      await this.flushSessionTail(sessionId, entry.scope);
    } catch (error) {
      entry.phase = 'flush-failed';
      throw error;
    }
    entry.registration.dispose();
    entry.lease.release();
    if (this.entries.get(sessionId) === entry) this.entries.delete(sessionId);
    if (kind === 'archive') {
      this._onDidArchiveSession.fire({ sessionId });
    } else {
      this._onDidCloseSession.fire({ sessionId });
    }
  }

  private async runCloseStep(sessionId: string, entry: SessionEntry): Promise<void> {
    switch (entry.closeStep) {
      case 0:
        await this.announceWillClose({ sessionId, handle: entry.handle, reason: 'exit' });
        return;
      case 1:
        await this.drainAgents(entry.handle);
        return;
      case 2:
        this.disposeSessionHandle(entry);
        return;
      case 3:
        await this.announceWillRelease({ sessionId, reason: 'close' }, entry);
        return;
    }
  }

  private async runArchiveStep(sessionId: string, entry: SessionEntry): Promise<void> {
    switch (entry.closeStep) {
      case 0:
        await entry.handle.accessor.get(ISessionMetadata).setArchived(true);
        return;
      case 1:
        await this.drainAgents(entry.handle);
        return;
      case 2:
        this.event.publish({
          type: 'event.session.archived',
          payload: { sessionId },
        });
        return;
      case 3:
        await this.announceWillClose({ sessionId, handle: entry.handle, reason: 'exit' });
        return;
      case 4:
        this.disposeSessionHandle(entry);
        return;
      case 5:
        await this.announceWillRelease({ sessionId, reason: 'archive' }, entry);
        return;
    }
  }

  private activateSession(entry: SessionEntry): void {
    if (this.entries.get(entry.handle.id) !== entry || entry.phase !== 'preparing') {
      throw new Error2(
        ErrorCodes.SESSION_LEASE_LOST,
        `session ${entry.handle.id} was torn down before activation`,
        { details: { sessionId: entry.handle.id } },
      );
    }
    entry.lease.assertWritable();
    entry.phase = 'active';
  }

  private rollbackSession(entry: SessionEntry): void {
    if (this.entries.get(entry.handle.id) === entry) this.entries.delete(entry.handle.id);
    try {
      this.disposeSessionHandle(entry);
    } catch {
    }
    try {
      entry.registration.dispose();
    } catch {
    }
    entry.lease.release();
  }

  private disposeSessionHandle(entry: SessionEntry): void {
    if (entry.disposed) return;
    entry.handle.dispose();
    entry.disposed = true;
  }

  async fork(opts: ForkSessionOptions): Promise<ISessionScopeHandle> {
    this.assertOpen();
    return this.trackOperation(this.doFork(opts));
  }

  private async doFork(opts: ForkSessionOptions): Promise<ISessionScopeHandle> {
    const sourceId = opts.sourceSessionId;

    const sourceHandle = this.get(sourceId);
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
    let targetEntry: SessionEntry | undefined;
    let target: ISessionScopeHandle | undefined;
    let targetSessionDir: string | undefined;
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
      if (this.entries.has(targetId) || (await this.index.get(targetId)) !== undefined) {
        throw new Error2(
          ErrorCodes.SESSION_ALREADY_EXISTS,
          `Session "${targetId}" already exists`,
        );
      }

      targetEntry = await this.materializeSession({
        sessionId: targetId,
        workDir: workspace.root,
      });
      target = targetEntry.handle;
      const targetCtx = target.accessor.get(ISessionContext);
      targetSessionDir = targetCtx.sessionDir;
      const targetMeta = target.accessor.get(ISessionMetadata);

      await this.copySessionFiles(
        this.bootstrap.sessionDir(workspaceId, sourceId),
        targetCtx.sessionDir,
      );

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

      await this.appendSessionIndexEntry(targetId, workspace.root, targetCtx.workspaceId);
      this.activateSession(targetEntry);
      this._onDidForkSession.fire({
        sourceSessionId: sourceId,
        sessionId: targetId,
        handle: target,
      });
      await this.announceCreated({ sessionId: targetId, handle: target, source: 'fork' });
      return target;
    } catch (error) {
      if (targetEntry !== undefined) this.rollbackSession(targetEntry);
      if (targetSessionDir !== undefined) {
        await this.hostFs.remove(targetSessionDir).catch(() => {});
      }
      throw error;
    }
  }

  async createChild(opts: CreateChildSessionOptions): Promise<ISessionScopeHandle> {
    this.assertOpen();
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
    const live = this.get(sourceId);
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

  override dispose(): void {
    this.closing = true;
    for (const entry of this.entries.values()) void this.dirtyAbortSession(entry);
    super.dispose();
  }

  private assertOpen(): void {
    if (this.closing) throw this.lifecycleClosingError();
  }

  private lifecycleClosingError(): Error2 {
    return new Error2(ErrorCodes.SESSION_CLOSED, 'session lifecycle is closing');
  }

  private trackOperation<T>(promise: Promise<T>): Promise<T> {
    this.inFlightOperations.add(promise);
    const remove = (): void => {
      this.inFlightOperations.delete(promise);
    };
    promise.then(remove, remove);
    return promise;
  }

  private onLeaseLost(sessionId: string): void {
    this.log.error('session lease lost; tearing the session down', { sessionId });
    const entry = this.entries.get(sessionId);
    if (entry !== undefined) void this.dirtyAbortSession(entry);
  }

  private async acquireSessionLease(sessionId: string): Promise<SessionLease> {
    const leasePath = sessionLeasePath(this.bootstrap.homeDir, sessionId);
    const contact = this.leaseContact.contact();
    try {
      const handle = await this.locks.acquire(leasePath, {
        address: contact.type === 'address' ? contact.address : undefined,
      });
      const lease = new SessionLease(sessionId, handle, (id) => {
        this.onLeaseLost(id);
      });
      this.telemetry.track2('session_lease_acquired', { session_id: sessionId });
      return lease;
    } catch (error) {
      if (
        isError2(error) &&
        (error.code === OsLockErrors.codes.OS_LOCK_HELD ||
          error.code === OsLockErrors.codes.OS_LOCK_WAIT_TIMEOUT)
      ) {
        this.throwHeldByPeer(sessionId, error);
      }
      throw error;
    }
  }

  private throwHeldByPeer(sessionId: string, cause: unknown): never {
    const inspection = this.locks.inspect(sessionLeasePath(this.bootstrap.homeDir, sessionId));
    const details = this.heldByPeerDetails(inspection);
    this.telemetry.track2('session_held_by_peer_returned', {
      session_id: sessionId,
      phase: details.phase,
    });
    throw new Error2(
      ErrorCodes.SESSION_HELD_BY_PEER,
      `session ${sessionId} is held by another instance (${details.phase})`,
      { details, cause },
    );
  }

  private heldByPeerDetails(inspection: CrossProcessLockInspection): HeldByPeerDetails {
    // A free lease here means the holder vanished between the failed acquire
    // and this probe; that race converges by retrying, same as 'creating'.
    return (
      heldByPeerDetailsFromInspection(inspection) ?? {
        kind: 'held-by-peer',
        phase: 'creating',
        retry_after_ms: LEASE_CREATING_RETRY_AFTER_MS,
      }
    );
  }

  private async flushSessionTail(sessionId: string, scope: string): Promise<void> {
    try {
      await this.appendLogStore.flush(scope);
    } catch (error) {
      this.log.warn('final journal flush failed while closing session', {
        sessionId,
        error: String(error),
      });
      throw error;
    }
  }

  private dirtyAbortSession(entry: SessionEntry): Promise<void> {
    if (entry.dirtyAbortPromise !== undefined) return entry.dirtyAbortPromise;
    if (this.entries.get(entry.handle.id) === entry) this.entries.delete(entry.handle.id);

    let taskServices: IAgentTaskService[] = [];
    try {
      taskServices = entry.handle
        .accessor.get(IAgentLifecycleService)
        .list()
        .map((agent) => agent.accessor.get(IAgentTaskService));
    } catch {
    }
    try {
      this.disposeSessionHandle(entry);
    } catch {
    }
    const dirtyAbortPromise = (async (): Promise<void> => {
      try {
        await this.hooks.onWillReleaseSession.run({
          sessionId: entry.handle.id,
          reason: 'dirty-abort',
        });
      } catch (error) {
        this.log.warn('session release hook failed during dirty abort', {
          sessionId: entry.handle.id,
          error: String(error),
        });
      }
      await Promise.allSettled(taskServices.map((tasks) => tasks.flushPersistence()));
      try {
        entry.registration.dispose();
      } catch {
      }
      entry.lease.release();
    })();
    entry.dirtyAbortPromise = dirtyAbortPromise;
    void dirtyAbortPromise.catch(() => {});
    return dirtyAbortPromise;
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
  InstantiationType.Eager,
  'sessionLifecycle',
);

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
