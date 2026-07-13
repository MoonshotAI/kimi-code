/**
 * `sessionLifecycle` domain (L6) — `ISessionLifecycleService` implementation.
 *
 * Owns the process-wide registry of open Session child scopes, creating them
 * through the DI scope tree and seeding each with its identity and storage
 * addressing, running lifecycle hook slots, and tearing them down on
 * close/archive — archiving flags the session's `sessionMetadata`, removes
 * its `agentLifecycle` agents, restoring clears the archived flag, and
 * broadcasts through `event`; session start and resume failures are reported
 * through `telemetry`. Materializes the session's initial metadata on
 * creation by resolving `sessionMetadata`. Bound at App scope. Persisted
 * sessions are discovered through the `sessionIndex` read model, and workspace
 * roots are remembered through `workspaceRegistry`. On create / fork the
 * session is also appended to the shared `session_index.jsonl` so v1 clients
 * (TUI, export) can discover sessions created by the v2 engine.
 */

import { randomUUID } from 'node:crypto';

import { join } from 'pathe';
import { ulid } from 'ulid';

import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import {
  createScopedChildHandle,
  type ISessionScopeHandle,
  LifecycleScope,
  registerScopedService,
} from '#/_base/di/scope';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { Emitter, type Event } from '#/_base/event';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { ISessionActivityKernel } from '#/activity/activity';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { DEFAULT_PLAN_MODE_SECTION } from '#/agent/plan/configSection';
import { IAgentPlanService } from '#/agent/plan/plan';
import {
  AGENT_WIRE_PROTOCOL_VERSION,
  IAgentWireRecordService,
  type PersistedWireRecord,
} from '#/agent/wireRecord/wireRecord';
import { WIRE_RECORD_FILENAME, wireRecordScope } from '#/agent/wireRecord/wireRecordService';
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
import { IWorkspaceLocalConfigService } from '#/app/workspaceLocalConfig/workspaceLocalConfig';
import { IWorkspaceRegistry } from '#/app/workspaceRegistry/workspaceRegistry';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ErrorCodes, Error2, isError2 } from '#/errors';
import { createHooks } from '#/hooks';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem, type HostDirEntry } from '#/os/interface/hostFileSystem';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ensureMainAgent, MAIN_AGENT_ID } from '#/session/agentLifecycle/mainAgent';
import { labelsFromAgentMeta } from '#/session/agentLifecycle/subagentMetadata';
import { ISessionExternalHooksService } from '#/session/externalHooks/externalHooks';
import { ISessionContext, sessionContextSeed } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata, type SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IAgentWireService } from '#/wire/tokens';
import type { PersistedRecord } from '#/wire/wireService';

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

export class SessionLifecycleService extends Disposable implements ISessionLifecycleService {
  declare readonly _serviceBrand: undefined;
  private readonly sessions = new Map<string, ISessionScopeHandle>();
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
  ]);
  /** In-flight `resume` promises, keyed by session id. De-dupes concurrent cold
   *  loads so a hot read path (e.g. snapshot retry) cannot materialize the same
   *  session twice and leak a handle — and doubles as the visibility gate for
   *  `get` / `list`: while an id is present here its materialized handle is
   *  half-initialized (main agent not yet restored + replayed) and must not be
   *  observable. */
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
    @IWorkspaceRegistry private readonly workspaceRegistry: IWorkspaceRegistry,
    @IWorkspaceLocalConfigService
    private readonly workspaceLocalConfig: IWorkspaceLocalConfigService,
    @IEventService private readonly event: IEventService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    super();
  }

  async create(opts: CreateSessionOptions): Promise<ISessionScopeHandle> {
    const sessionId = opts.sessionId ?? createSessionId();
    const handle = await this.materializeSession({ ...opts, sessionId });
    await this.appendSessionIndexEntry(sessionId, opts.workDir);
    if (this.config.get<boolean>(DEFAULT_PLAN_MODE_SECTION) === true) {
      const main = await ensureMainAgent(handle);
      await main.accessor.get(IAgentPlanService).enter();
    }
    await this.announceCreated({ sessionId, handle, source: 'startup' });
    return handle;
  }

  private async materializeSession(opts: MaterializeSessionOptions): Promise<ISessionScopeHandle> {
    const workspace = await this.workspaceRegistry.createOrTouch(opts.workDir);
    const workspaceId = opts.workspaceId ?? workspace.id;
    const sessionScope = this.bootstrap.sessionScope(workspaceId, opts.sessionId);
    const sessionDir = this.bootstrap.sessionDir(workspaceId, opts.sessionId);
    // Metadata lives at `<sessionDir>/state.json` (shared with v1's layout; the
    // v2 document is tagged with `version: 2`). `metaScope` is therefore the
    // session directory itself, homeDir-relative.
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
    // Merge the project-local `.kimi-code/local.toml` additional dirs with the
    // caller-supplied ones (relative paths resolve against workDir), mirroring
    // v1's createSession/resumeSession. A broken local.toml fails the create
    // loudly with CONFIG_INVALID, same as v1.
    const localWorkspaceDirs = await this.workspaceLocalConfig.readAdditionalDirs(opts.workDir);
    const callerAdditionalDirs = await this.workspaceLocalConfig.resolveAdditionalDirs(
      opts.workDir,
      opts.additionalDirs ?? [],
    );
    const additionalDirs = [...localWorkspaceDirs.additionalDirs, ...callerAdditionalDirs];
    // Wait for the host-environment probe to complete before creating any
    // Session scope — Session/Agent-scope services (bash, permission policies,
    // path-access) read `IHostEnvironment.osKind` / `pathClass` / `homeDir`
    // synchronously in their constructors, so the probe must have landed by
    // the time the first Session-scoped service is resolved.
    await this.hostEnv.ready;
    const handle = createScopedChildHandle(
      this.instantiation,
      LifecycleScope.Session,
      opts.sessionId,
      {
        extra: [...sessionContextSeed(ctx)],
      },
    ) as ISessionScopeHandle;
    // Construct the Session activity kernel eagerly so its lane is `restoring`
    // for the whole materialize / replay window — edge commands that arrive
    // before `markActive()` are rejected with `activity.session_rejected`.
    handle.accessor.get(ISessionActivityKernel);
    if (additionalDirs.length > 0) {
      // De-duplication happens inside setAdditionalDirs (resolve + Set),
      // matching v1's normalizeAdditionalDirs.
      handle.accessor.get(ISessionWorkspaceContext).setAdditionalDirs(additionalDirs);
    }
    this.sessions.set(opts.sessionId, handle);
    await handle.accessor.get(ISessionMetadata).ready;
    void handle.accessor.get(ISessionSkillCatalog).ready;
    // First `ensureMcpReady` call for the session — it starts the initial MCP
    // load, so the caller-supplied servers must ride on it (later calls, e.g.
    // from agent creation, only await the in-flight load).
    await handle.accessor.get(IAgentLifecycleService).ensureMcpReady(opts.mcpServers);
    handle.accessor.get(ISessionExternalHooksService);
    return handle;
  }

  private async appendSessionIndexEntry(sessionId: string, workDir: string): Promise<void> {
    const workspaceId = encodeWorkDirKey(workDir);
    const sessionDir = this.bootstrap.sessionDir(workspaceId, sessionId);
    this.appendLogStore.append('', 'session_index.jsonl', {
      sessionId,
      sessionDir,
      workDir,
    });
    await this.appendLogStore.flush();
  }

  private async announceCreated(event: SessionCreatedEvent): Promise<void> {
    await this.hooks.onDidCreateSession.run(event);
    this._onDidCreateSession.fire(event);
    // Deliberately broader than v1: resumes also emit, with `resumed: true` —
    // the flag exists precisely to distinguish them (v1's resume path never
    // emitted despite the schema having the flag).
    this.telemetry.track2('session_started', { resumed: event.source === 'resume' });
    event.handle.accessor.get(ISessionActivityKernel).markActive();
  }

  get(sessionId: string): ISessionScopeHandle | undefined {
    // A session mid-resume is already materialized in `this.sessions` (so
    // close/archive can still find it) but its main agent has not finished
    // restore + replay — exposing it would hand callers a half-initialized
    // handle. Hide it until `resume` settles; callers that need the handle
    // should `await resume(sessionId)`.
    if (this.resuming.has(sessionId)) return undefined;
    return this.sessions.get(sessionId);
  }

  resume(sessionId: string): Promise<ISessionScopeHandle | undefined> {
    // Check in-flight resumes FIRST: `materializeSession` adds the session to
    // `this.sessions` before `doResume` finishes restore/replay, so a concurrent
    // caller that checks `sessions` first would get a half-initialized handle
    // whose main agent has no context. Checking `resuming` first ensures
    // concurrent callers wait for the full resume (including restore + replay)
    // to complete.
    const inflight = this.resuming.get(sessionId);
    if (inflight !== undefined) return inflight;
    const live = this.sessions.get(sessionId);
    if (live !== undefined) return Promise.resolve(live);
    const promise = this.doResume(sessionId)
      .catch((error: unknown) => {
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
    // Re-check after the serialized entry: a prior `resume` for the same id may
    // have already materialized the session while this call was queued.
    const live = this.sessions.get(sessionId);
    if (live !== undefined) return live;

    const summary = await this.index.get(sessionId);
    if (summary === undefined) return undefined;
    const workspace =
      summary.cwd === undefined ? await this.workspaceRegistry.get(summary.workspaceId) : undefined;
    const workDir = summary.cwd ?? workspace?.root;
    if (workDir === undefined) return undefined;

    const handle = await this.materializeSession({
      sessionId,
      workDir,
      workspaceId: summary.workspaceId,
    });
    const agents = handle.accessor.get(IAgentLifecycleService);
    if (agents.getHandle(MAIN_AGENT_ID) === undefined) {
      const main = await ensureMainAgent(handle);
      // Resolve context memory BEFORE restoring so its reducers are registered;
      // otherwise the wire replay applies context records into a void and the
      // restored transcript never lands in context memory.
      main.accessor.get(IAgentContextMemoryService);
      const mainWireRecord = main.accessor.get(IAgentWireRecordService);
      await mainWireRecord.restore();
      const records = mainWireRecord.getRecords() as readonly PersistedRecord[];
      await main.accessor.get(IAgentWireService).replay(...records);
    }
    await this.announceCreated({ sessionId, handle, source: 'resume' });
    return handle;
  }

  list(): readonly ISessionScopeHandle[] {
    // Exclude sessions still mid-resume for the same reason as `get`: the handle
    // exists but is not yet restored, so it must not be observable.
    const ready: ISessionScopeHandle[] = [];
    for (const [id, handle] of this.sessions) {
      if (!this.resuming.has(id)) ready.push(handle);
    }
    return ready;
  }

  async close(sessionId: string): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (handle === undefined) return;
    await this.announceWillClose({ sessionId, handle, reason: 'exit' });
    this.sessions.delete(sessionId);
    handle.accessor.get(ISessionActivityKernel).beginClosing();
    await this.drainAgents(handle);
    handle.dispose();
    this._onDidCloseSession.fire({ sessionId });
  }

  async archive(sessionId: string): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (handle === undefined) return;
    const meta = handle.accessor.get(ISessionMetadata);
    await meta.setArchived(true);
    handle.accessor.get(ISessionActivityKernel).beginClosing();
    await this.drainAgents(handle);
    this.event.publish({
      type: 'event.session.archived',
      payload: { sessionId },
    });
    await this.announceWillClose({ sessionId, handle, reason: 'exit' });
    this.sessions.delete(sessionId);
    handle.dispose();
    this._onDidArchiveSession.fire({ sessionId });
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

    // 1. Resolve the source: prefer a live handle, otherwise fall back to the
    // persisted index (so a closed session can still be forked, like v1).
    const sourceHandle = this.sessions.get(sourceId);
    const indexSummary = await this.index.get(sourceId);
    if (sourceHandle === undefined && indexSummary === undefined) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sourceId} does not exist`);
    }
    const workspaceId =
      sourceHandle !== undefined
        ? sourceHandle.accessor.get(ISessionContext).workspaceId
        : indexSummary!.workspaceId;

    // 2. Quiesce the live source so no new turn begins while the fork copies
    // its wire logs — this closes the check-then-act window (矛盾 k) that the
    // old `status() !== 'idle'` check suffered from. A closed source has no
    // kernel to quiesce.
    const quiesce =
      sourceHandle !== undefined
        ? await sourceHandle.accessor.get(ISessionActivityKernel).quiesce('fork')
        : undefined;
    let targetId: string | undefined;
    let target: ISessionScopeHandle | undefined;
    let targetSessionDir: string | undefined;
    try {
      // 3. Resolve the work dir the fork inherits (same workspace as the source).
      const workspace = await this.workspaceRegistry.get(workspaceId);
      if (workspace === undefined) {
        throw new Error2('workspace.not_found', `workspace ${workspaceId} does not exist`);
      }

      // 4. Read the source metadata (live handle or disk).
      const sourceMeta =
        sourceHandle !== undefined
          ? await sourceHandle.accessor.get(ISessionMetadata).read()
          : await this.readMetaFromDisk(workspaceId, sourceId);

      // 5. Mint the target id and reject collisions.
      targetId = opts.newSessionId ?? createSessionId();
      if (this.sessions.has(targetId) || (await this.index.get(targetId)) !== undefined) {
        throw new Error2(
          ErrorCodes.SESSION_ALREADY_EXISTS,
          `Session "${targetId}" already exists`,
        );
      }

      // 6. Materialize the target session scope (fresh metadata + storage).
      target = await this.materializeSession({
        sessionId: targetId,
        workDir: workspace.root,
      });
      const targetCtx = target.accessor.get(ISessionContext);
      targetSessionDir = targetCtx.sessionDir;
      const targetMeta = target.accessor.get(ISessionMetadata);

      // 7. Copy the source session's on-disk state into the target — per-agent
      // `blobs/` and `plans/`, background-task output, and media originals.
      // v1 achieved this with `cp -r` of the whole session dir; the wire logs
      // (step 8) and `state.json` (step 9) are rewritten by the fork flow
      // itself, and `logs/` is the source's debug log, so those are excluded.
      await this.copySessionFiles(
        this.bootstrap.sessionDir(workspaceId, sourceId),
        targetCtx.sessionDir,
      );

      // 8. Copy every source agent's wire log into the target's per-agent log
      // (BEFORE the target agents are created, so the logs are in place when
      // their AgentWireRecordService restores them in step 11).
      const sourceAgents = sourceMeta?.agents ?? {};
      const agentIds = Object.keys(sourceAgents);
      for (const agentId of agentIds) {
        const sourceHomedir = sourceAgents[agentId]!.homedir;
        await this.copyAgentWire({
          sourceHandle,
          sourceHomedir,
          agentId,
          targetWorkspaceId: targetCtx.workspaceId,
          targetSessionId: targetCtx.sessionId,
        });
      }

      // 9. Rewrite the target metadata to reflect fork provenance.
      const title = opts.title ?? `Fork: ${sourceMeta?.title || sourceId}`;
      await targetMeta.update({
        title,
        isCustomTitle: opts.title !== undefined ? true : sourceMeta?.isCustomTitle === true,
        forkedFrom: sourceId,
        archived: false,
        lastPrompt: sourceMeta?.lastPrompt,
        custom: forkCustomMetadata(sourceMeta?.custom, opts.metadata),
      });

      // 10. Clone the source session's cron tasks for the target. v1 kept cron
      // records inside the session dir so `cp -r` carried them; v2 persists
      // them at workspace level tagged with the owning session id.
      await this.duplicateCronTasks(workspaceId, sourceId, targetId);

      // 11. Create the target agents (same ids) and restore each from its copied
      // log. Creating them registers fresh agent entries with TARGET homedirs.
      for (const agentId of agentIds) {
        const sourceAgent = sourceAgents[agentId]!;
        const agentHandle = await target.accessor.get(IAgentLifecycleService).create({
          agentId,
          forkedFrom: sourceAgent.forkedFrom,
          labels: labelsFromAgentMeta(sourceAgent),
        });
        const forkWireRecord = agentHandle.accessor.get(IAgentWireRecordService);
        await forkWireRecord.restore();
        const forkRecords = forkWireRecord.getRecords() as readonly PersistedRecord[];
        await agentHandle.accessor.get(IAgentWireService).replay(...forkRecords);
      }

      await this.appendSessionIndexEntry(targetId, workspace.root);
      this._onDidForkSession.fire({
        sourceSessionId: sourceId,
        sessionId: targetId,
        handle: target,
      });
      await this.announceCreated({ sessionId: targetId, handle: target, source: 'fork' });
      return target;
    } catch (error) {
      // Roll back the half-fork, mirroring v1's `rm -rf` of the target dir:
      // drop the materialized handle from the live registry (otherwise a
      // retry with the same id trips SESSION_ALREADY_EXISTS on the in-memory
      // check) and delete whatever was copied to disk.
      if (targetId !== undefined) {
        this.sessions.delete(targetId);
      }
      if (target !== undefined) {
        try {
          target.dispose();
        } catch {
          // best effort — the session dir is removed below regardless
        }
      }
      if (targetSessionDir !== undefined) {
        await this.hostFs.remove(targetSessionDir).catch(() => {});
      }
      throw error;
    } finally {
      quiesce?.dispose();
    }
  }

  async createChild(opts: CreateChildSessionOptions): Promise<ISessionScopeHandle> {
    const title =
      opts.title ??
      `Child: ${(await this.resolveSourceTitle(opts.sourceSessionId)) ?? opts.sourceSessionId}`;
    // The child markers win over any caller-supplied values so a forged
    // `parent_session_id` / `child_session_kind` cannot reparent a session.
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

  /**
   * Best-effort source title for the default `Child: <title>` name. Reads the
   * live handle first, then the persisted index. A missing source yields
   * `undefined`; `fork` still throws `session.not_found` for the real
   * existence check.
   */
  private async resolveSourceTitle(sourceId: string): Promise<string | undefined> {
    const live = this.sessions.get(sourceId);
    if (live !== undefined) {
      return (await live.accessor.get(ISessionMetadata).read()).title;
    }
    return (await this.index.get(sourceId))?.title;
  }

  /**
   * Copy one agent's wire log from the source into the target session's
   * per-agent log, appending a `forked` boundary record. Works for both live
   * sources (flush then read) and closed sources (read the persisted log).
   */
  private async copyAgentWire(args: {
    readonly sourceHandle: ISessionScopeHandle | undefined;
    readonly sourceHomedir: string;
    readonly agentId: string;
    readonly targetWorkspaceId: string;
    readonly targetSessionId: string;
  }): Promise<void> {
    // Flush the live agent so its persisted log is current before reading.
    if (args.sourceHandle !== undefined) {
      const agentHandle = args.sourceHandle.accessor
        .get(IAgentLifecycleService)
        .getHandle(args.agentId);
      if (agentHandle !== undefined) {
        await agentHandle.accessor.get(IAgentWireRecordService).flush();
      }
    }

    const records = await collect(
      this.appendLogStore.read<PersistedWireRecord>(
        wireRecordScope(args.sourceHomedir, this.bootstrap.homeDir),
        WIRE_RECORD_FILENAME,
      ),
    );
    // Ensure the log starts with a metadata envelope (restore() requires it).
    if (records.length === 0) {
      records.push(freshMetadataRecord());
    } else if (records[0]?.type !== 'metadata') {
      records.unshift(freshMetadataRecord());
    }
    records.push(forkedRecord());

    const targetHomedir = this.bootstrap.agentHomedir(
      args.targetWorkspaceId,
      args.targetSessionId,
      args.agentId,
    );
    await this.appendLogStore.rewrite(
      wireRecordScope(targetHomedir, this.bootstrap.homeDir),
      WIRE_RECORD_FILENAME,
      records,
    );
  }

  /**
   * Copy the source session's on-disk state into the target session dir —
   * everything the fork flow does not regenerate itself: per-agent `blobs/`
   * and `plans/`, background-task output, and session media originals. v1
   * achieved this with `cp -r` of the whole session dir; these live under
   * the v2 session dir too (per-agent scopes and hostFs paths), so the fork
   * must carry them explicitly or the target's blob refs resolve to
   * `[media missing]` and its active plan file is gone.
   *
   * A missing source dir means there is nothing on disk to carry over (the
   * wire logs are read through the append-log store, not this walk).
   */
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
      // `state.json` is rewritten with fork provenance, the per-agent wire
      // logs are copied by `copyAgentWire` (with a fork boundary record), and
      // `logs/` is the source's debug log — the fork writes its own.
      if (rel === 'state.json' || rel === 'logs' || entry.name === WIRE_RECORD_FILENAME) {
        continue;
      }
      // Never follow symlinks out of the session dir.
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

  /**
   * Clone the source session's cron tasks for the fork. v1 kept cron records
   * inside the session dir, so its `cp -r` fork carried them; v2 persists
   * cron at workspace level keyed by a session-id tag, so fork duplicates
   * the source's tasks with fresh ids pointing at the target. Fired
   * one-shot tasks are already gone from the store (removed on delivery),
   * so everything cloned here is still live.
   */
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
  InstantiationType.Delayed,
  'sessionLifecycle',
);

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

/** hostFs wraps raw errnos in `HostFsError`; classify the unwrapped cause. */
function isMissingFileError(error: unknown): boolean {
  const unwrapped = unwrapErrorCause(error);
  if (unwrapped === null || typeof unwrapped !== 'object') return false;
  const code = (unwrapped as { readonly code?: unknown }).code;
  return code === 'ENOENT';
}

/**
 * Mint a session id in the canonical `session_<lowercase-uuid>` form, matching
 * v1's `createSessionId` (`packages/agent-core/src/rpc/core-impl.ts`).
 * `randomUUID` already returns lowercase hex, so the result is lowercase by
 * construction. Used as the default for both `create` and `fork` when the
 * caller does not supply an id, so every session id shares one format and the
 * edge layers never mint their own.
 */
function createSessionId(): string {
  return `session_${randomUUID()}`;
}

function freshMetadataRecord(): PersistedWireRecord {
  return {
    type: 'metadata',
    protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
    created_at: Date.now(),
  };
}

function forkedRecord(): PersistedWireRecord {
  return { type: 'forked', time: Date.now() } as PersistedWireRecord;
}

/**
 * Merge the source session's custom metadata with the caller-supplied metadata,
 * dropping the reserved `goal` key from both (matches v1's `forkCustomMetadata`).
 */
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
