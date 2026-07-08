/**
 * `sessionLifecycle` domain (L6) — `ISessionLifecycleService` implementation.
 *
 * Owns the process-wide registry of open Session child scopes, creating them
 * through the DI scope tree and seeding each with its identity and storage
 * addressing, running lifecycle hook slots, and tearing them down on
 * close/archive — archiving flags the session's `sessionMetadata`, removes
 * its `agentLifecycle` agents, and
 * broadcasts through `event`. Materializes the session's initial metadata on
 * creation by resolving `sessionMetadata`. Bound at App scope. Persisted
 * sessions are the `sessionIndex` read model.
 */

import { randomUUID } from 'node:crypto';

import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import {
  createScopedChildHandle,
  type ISessionScopeHandle,
  LifecycleScope,
  registerScopedService,
} from '#/_base/di/scope';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ensureMainAgent, MAIN_AGENT_ID } from '#/session/agentLifecycle/mainAgent';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventService } from '#/app/event/event';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { ErrorCodes, KimiError } from '#/errors';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { ISessionActivity } from '#/session/sessionActivity/sessionActivity';
import { labelsFromAgentMeta } from '#/session/agentLifecycle/subagentMetadata';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IWorkspaceRegistry } from '#/app/workspaceRegistry/workspaceRegistry';
import { ISessionExternalHooksService } from '#/session/externalHooks/externalHooks';
import { ISessionContext, sessionContextSeed } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata, type SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IWorkspaceLocalConfigService } from '#/app/workspaceLocalConfig/workspaceLocalConfig';
import { createHooks } from '#/hooks';
import {
  AGENT_WIRE_PROTOCOL_VERSION,
  IAgentWireRecordService,
  type PersistedWireRecord,
} from '#/agent/wireRecord/wireRecord';
import { WIRE_RECORD_FILENAME, wireRecordScope } from '#/agent/wireRecord/wireRecordService';
import { IAgentWireService } from '#/wire/tokens';
import type { PersistedRecord } from '#/wire/wireService';

import {
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
  /** In-flight `resume` promises, keyed by session id — de-dupes concurrent
   *  cold loads so a hot read path (e.g. snapshot retry) cannot materialize
   *  the same session twice and leak a handle. */
  private readonly resuming = new Map<string, Promise<ISessionScopeHandle | undefined>>();

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostEnvironment private readonly hostEnv: IHostEnvironment,
    @ISessionIndex private readonly index: ISessionIndex,
    @IAppendLogStore private readonly appendLogStore: IAppendLogStore,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @IWorkspaceRegistry private readonly workspaceRegistry: IWorkspaceRegistry,
    @IWorkspaceLocalConfigService
    private readonly workspaceLocalConfig: IWorkspaceLocalConfigService,
    @IEventService private readonly event: IEventService,
  ) {
    super();
  }

  async create(opts: CreateSessionOptions): Promise<ISessionScopeHandle> {
    const handle = await this.materializeSession(opts);
    await this.announceCreated({ sessionId: opts.sessionId, handle, source: 'startup' });
    return handle;
  }

  private async materializeSession(opts: CreateSessionOptions): Promise<ISessionScopeHandle> {
    const workspaceId = encodeWorkDirKey(opts.workDir);
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
    if (additionalDirs.length > 0) {
      // De-duplication happens inside setAdditionalDirs (resolve + Set),
      // matching v1's normalizeAdditionalDirs.
      handle.accessor.get(ISessionWorkspaceContext).setAdditionalDirs(additionalDirs);
    }
    this.sessions.set(opts.sessionId, handle);
    await handle.accessor.get(ISessionMetadata).ready;
    void handle.accessor.get(ISessionSkillCatalog).ready;
    await handle.accessor.get(IAgentLifecycleService).ensureMcpReady();
    handle.accessor.get(ISessionExternalHooksService);
    return handle;
  }

  private async announceCreated(event: SessionCreatedEvent): Promise<void> {
    await this.hooks.onDidCreateSession.run(event);
    this._onDidCreateSession.fire(event);
  }

  get(sessionId: string): ISessionScopeHandle | undefined {
    return this.sessions.get(sessionId);
  }

  resume(sessionId: string): Promise<ISessionScopeHandle | undefined> {
    const live = this.sessions.get(sessionId);
    if (live !== undefined) return Promise.resolve(live);
    const inflight = this.resuming.get(sessionId);
    if (inflight !== undefined) return inflight;
    const promise = this.doResume(sessionId).finally(() => this.resuming.delete(sessionId));
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
    const workspace = await this.workspaceRegistry.get(summary.workspaceId);
    if (workspace === undefined) return undefined;

    const handle = await this.materializeSession({ sessionId, workDir: workspace.root });
    const agents = handle.accessor.get(IAgentLifecycleService);
    if (agents.getHandle(MAIN_AGENT_ID) === undefined) {
      const main = await ensureMainAgent(handle);
      // Resolve context memory BEFORE restoring so its `context.splice` resumer
      // is registered; otherwise the wire replay applies splices into a void and
      // the restored transcript never lands in context memory.
      main.accessor.get(IAgentContextMemoryService);
      const mainWireRecord = main.accessor.get(IAgentWireRecordService);
      await mainWireRecord.restore();
      await main
        .accessor.get(IAgentWireService)
        .replay(...(mainWireRecord.getRecords() as readonly PersistedRecord[]));
    }
    await this.announceCreated({ sessionId, handle, source: 'resume' });
    return handle;
  }

  list(): readonly ISessionScopeHandle[] {
    return [...this.sessions.values()];
  }

  async close(sessionId: string): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (handle === undefined) return;
    await this.announceWillClose({ sessionId, handle, reason: 'exit' });
    this.sessions.delete(sessionId);
    handle.dispose();
    this._onDidCloseSession.fire({ sessionId });
  }

  async archive(sessionId: string): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (handle === undefined) return;
    const meta = handle.accessor.get(ISessionMetadata);
    const agentLifecycle = handle.accessor.get(IAgentLifecycleService);
    await meta.setArchived(true);
    for (const agent of agentLifecycle.list()) {
      await agentLifecycle.remove(agent.id);
    }
    this.event.publish({
      type: 'event.session.archived',
      payload: { sessionId },
    });
    await this.announceWillClose({ sessionId, handle, reason: 'exit' });
    this.sessions.delete(sessionId);
    handle.dispose();
    this._onDidArchiveSession.fire({ sessionId });
  }

  private async announceWillClose(event: SessionWillCloseEvent): Promise<void> {
    await this.hooks.onWillCloseSession.run(event);
  }

  async fork(opts: ForkSessionOptions): Promise<ISessionScopeHandle> {
    const sourceId = opts.sourceSessionId;

    // 1. Resolve the source: prefer a live handle, otherwise fall back to the
    // persisted index (so a closed session can still be forked, like v1).
    const sourceHandle = this.sessions.get(sourceId);
    const indexSummary = await this.index.get(sourceId);
    if (sourceHandle === undefined && indexSummary === undefined) {
      throw new KimiError(ErrorCodes.SESSION_NOT_FOUND, `session ${sourceId} does not exist`);
    }
    const workspaceId =
      sourceHandle !== undefined
        ? sourceHandle.accessor.get(ISessionContext).workspaceId
        : indexSummary!.workspaceId;

    // 2. Reject forking a live session with an active turn or a pending
    // interaction.
    if (sourceHandle !== undefined) {
      const status = sourceHandle.accessor.get(ISessionActivity).status();
      if (status !== 'idle') {
        throw new KimiError(
          ErrorCodes.SESSION_FORK_ACTIVE_TURN,
          `Session "${sourceId}" cannot be forked while a turn is running`,
          { details: { sessionId: sourceId } },
        );
      }
    }

    // 3. Resolve the work dir the fork inherits (same workspace as the source).
    const workspace = await this.workspaceRegistry.get(workspaceId);
    if (workspace === undefined) {
      throw new KimiError('workspace.not_found', `workspace ${workspaceId} does not exist`);
    }

    // 4. Read the source metadata (live handle or disk).
    const sourceMeta =
      sourceHandle !== undefined
        ? await sourceHandle.accessor.get(ISessionMetadata).read()
        : await this.readMetaFromDisk(workspaceId, sourceId);

    // 5. Mint the target id and reject collisions.
    const targetId = opts.newSessionId ?? randomUUID();
    if (this.sessions.has(targetId) || (await this.index.get(targetId)) !== undefined) {
      throw new KimiError(ErrorCodes.SESSION_ALREADY_EXISTS, `Session "${targetId}" already exists`);
    }

    // 6. Materialize the target session scope (fresh metadata + storage).
    const target = await this.materializeSession({ sessionId: targetId, workDir: workspace.root });
    const targetCtx = target.accessor.get(ISessionContext);
    const targetMeta = target.accessor.get(ISessionMetadata);

    // 7. Copy every source agent's wire log into the target's per-agent log
    // (BEFORE the target agents are created, so the logs are in place when
    // their AgentWireRecordService restores them in step 9).
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

    // 8. Rewrite the target metadata to reflect fork provenance.
    const title = opts.title ?? `Fork: ${sourceMeta?.title || sourceId}`;
    await targetMeta.update({
      title,
      isCustomTitle: opts.title !== undefined ? true : sourceMeta?.isCustomTitle === true,
      forkedFrom: sourceId,
      archived: false,
      lastPrompt: sourceMeta?.lastPrompt,
      custom: forkCustomMetadata(sourceMeta?.custom, opts.metadata),
    });

    // 9. Create the target agents (same ids) and restore each from its copied
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
      await agentHandle
        .accessor.get(IAgentWireService)
        .replay(...(forkWireRecord.getRecords() as readonly PersistedRecord[]));
    }

    this._onDidForkSession.fire({
      sourceSessionId: sourceId,
      sessionId: targetId,
      handle: target,
    });
    await this.announceCreated({ sessionId: targetId, handle: target, source: 'fork' });
    return target;
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
      const agentHandle = args.sourceHandle
        .accessor.get(IAgentLifecycleService)
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
