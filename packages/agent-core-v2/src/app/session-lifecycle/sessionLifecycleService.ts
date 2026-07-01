/**
 * `session-lifecycle` domain (L6) — `ISessionLifecycleService` implementation.
 *
 * Owns the process-wide registry of open Session child scopes, creating them
 * through the DI scope tree and seeding each with its identity and storage
 * addressing. Materializes the session's initial metadata on creation by
 * resolving `session-metadata`. Bound at App scope. Persisted sessions are
 * the `session-index` read model.
 */

import { join, relative } from 'pathe';
import { randomUUID } from 'node:crypto';

import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import {
  createScopedChildHandle,
  type IScopeHandle,
  LifecycleScope,
  registerScopedService,
} from '#/_base/di/scope';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { IAgentLifecycleService } from '#/session/agent-lifecycle';
import { IBootstrapService } from '#/app/bootstrap';
import { IAgentContextMemoryService } from '#/agent/contextMemory';
import { ErrorCodes, KimiError } from '#/errors';
import { IHostEnvironment } from '#/app/hostEnvironment';
import { createExecContext, execContextSeed } from '#/session/execContext';
import { ISessionActivity } from '#/session/session-activity';
import { ISessionIndex } from '#/app/session-index';
import { IAtomicDocumentStore, IAppendLogStore } from '#/app/storage';
import { IWorkspaceRegistry } from '#/app/workspaceRegistry';
import { ISessionService } from '#/session/session';
import { ISessionContext, sessionContextSeed } from '#/session/session-context';
import { ISessionMetadata, type SessionMeta } from '#/session/session-metadata';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog';
import {
  AGENT_WIRE_PROTOCOL_VERSION,
  IAgentWireRecordService,
  wireRecordPersistKey,
  type PersistedWireRecord,
} from '#/agent/wireRecord';

import {
  type CreateSessionOptions,
  type ForkSessionOptions,
  type SessionArchivedEvent,
  type SessionClosedEvent,
  type SessionCreatedEvent,
  type SessionForkedEvent,
  ISessionLifecycleService,
} from './sessionLifecycle';

export class SessionLifecycleService extends Disposable implements ISessionLifecycleService {
  declare readonly _serviceBrand: undefined;
  private readonly sessions = new Map<string, IScopeHandle>();
  private readonly _onDidCreateSession = this._register(new Emitter<SessionCreatedEvent>());
  readonly onDidCreateSession: Event<SessionCreatedEvent> = this._onDidCreateSession.event;
  private readonly _onDidCloseSession = this._register(new Emitter<SessionClosedEvent>());
  readonly onDidCloseSession: Event<SessionClosedEvent> = this._onDidCloseSession.event;
  private readonly _onDidArchiveSession = this._register(new Emitter<SessionArchivedEvent>());
  readonly onDidArchiveSession: Event<SessionArchivedEvent> = this._onDidArchiveSession.event;
  private readonly _onDidForkSession = this._register(new Emitter<SessionForkedEvent>());
  readonly onDidForkSession: Event<SessionForkedEvent> = this._onDidForkSession.event;
  /** In-flight `resume` promises, keyed by session id — de-dupes concurrent
   *  cold loads so a hot read path (e.g. snapshot retry) cannot materialize
   *  the same session twice and leak a handle. */
  private readonly resuming = new Map<string, Promise<IScopeHandle | undefined>>();

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostEnvironment private readonly hostEnv: IHostEnvironment,
    @ISessionIndex private readonly index: ISessionIndex,
    @IAppendLogStore private readonly appendLogStore: IAppendLogStore,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @IWorkspaceRegistry private readonly workspaceRegistry: IWorkspaceRegistry,
  ) {
    super();
  }

  async create(opts: CreateSessionOptions): Promise<IScopeHandle> {
    const workspaceId = encodeWorkDirKey(opts.workDir);
    const sessionDir = join(this.bootstrap.sessionsDir, workspaceId, opts.sessionId);
    // Metadata lives at `<sessionDir>/state.json` (shared with v1's layout; the
    // v2 document is tagged with `version: 2`). `metaScope` is therefore the
    // session directory itself, homeDir-relative.
    const metaScope = relative(this.bootstrap.homeDir, sessionDir);
    const ctx: ISessionContext = {
      _serviceBrand: undefined,
      sessionId: opts.sessionId,
      workspaceId,
      sessionDir,
      metaScope,
    };
    // Wait for the host-environment probe to complete before creating any
    // Session scope — Session/Agent-scope services (bash, permission policies,
    // path-access) read `IHostEnvironment.osKind` / `pathClass` / `homeDir`
    // synchronously in their constructors, so the probe must have landed by
    // the time the first Session-scoped service is resolved.
    await this.hostEnv.ready;
    const execCtx = createExecContext(opts.workDir);
    const handle = createScopedChildHandle(
      this.instantiation,
      LifecycleScope.Session,
      opts.sessionId,
      {
        extra: [
          ...sessionContextSeed(ctx),
          ...execContextSeed(execCtx),
        ],
      },
    );
    this.sessions.set(opts.sessionId, handle);
    await handle.accessor.get(ISessionMetadata).ready;
    void handle.accessor.get(ISessionSkillCatalog).load();
    this._onDidCreateSession.fire({ sessionId: opts.sessionId, handle });
    return handle;
  }

  get(sessionId: string): IScopeHandle | undefined {
    return this.sessions.get(sessionId);
  }

  resume(sessionId: string): Promise<IScopeHandle | undefined> {
    const live = this.sessions.get(sessionId);
    if (live !== undefined) return Promise.resolve(live);
    const inflight = this.resuming.get(sessionId);
    if (inflight !== undefined) return inflight;
    const promise = this.doResume(sessionId).finally(() => this.resuming.delete(sessionId));
    this.resuming.set(sessionId, promise);
    return promise;
  }

  private async doResume(sessionId: string): Promise<IScopeHandle | undefined> {
    // Re-check after the serialized entry: a prior `resume` for the same id may
    // have already materialized the session while this call was queued.
    const live = this.sessions.get(sessionId);
    if (live !== undefined) return live;

    const summary = await this.index.get(sessionId);
    if (summary === undefined) return undefined;
    const workspace = await this.workspaceRegistry.get(summary.workspaceId);
    if (workspace === undefined) return undefined;

    const handle = await this.create({ sessionId, workDir: workspace.root });
    const agents = handle.accessor.get(IAgentLifecycleService);
    if (agents.getHandle('main') === undefined) {
      const main = await agents.createMain();
      // Resolve context memory BEFORE restoring so its `context.splice` resumer
      // is registered; otherwise the wire replay applies splices into a void and
      // the restored transcript never lands in context memory.
      main.accessor.get(IAgentContextMemoryService);
      await main.accessor.get(IAgentWireRecordService).restore();
    }
    return handle;
  }

  list(): readonly IScopeHandle[] {
    return [...this.sessions.values()];
  }

  async close(sessionId: string): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (handle === undefined) return;
    this.sessions.delete(sessionId);
    handle.dispose();
    this._onDidCloseSession.fire({ sessionId });
  }

  async archive(sessionId: string): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (handle === undefined) return;
    await handle.accessor.get(ISessionService).archive();
    this.sessions.delete(sessionId);
    handle.dispose();
    this._onDidArchiveSession.fire({ sessionId });
  }

  async fork(opts: ForkSessionOptions): Promise<IScopeHandle> {
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

    // 2. Reject forking a live session with an active turn (v1 parity). Any
    // phase other than idle/aborted implies a turn is still in progress
    // (including turns paused on an approval/question).
    if (sourceHandle !== undefined) {
      const status = sourceHandle.accessor.get(ISessionActivity).status();
      if (status !== 'idle' && status !== 'aborted') {
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
    const target = await this.create({ sessionId: targetId, workDir: workspace.root });
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
        targetSessionDir: targetCtx.sessionDir,
      });
    }

    // 8. Rewrite the target metadata to reflect fork provenance.
    const title = opts.title ?? `Fork: ${sourceMeta?.title || sourceId}`;
    await targetMeta.update({
      title,
      isCustomTitle: opts.title !== undefined ? true : sourceMeta?.isCustomTitle === true,
      forkedFrom: sourceId,
      archived: false,
      custom: forkCustomMetadata(sourceMeta?.custom, opts.metadata),
    });

    // 9. Create the target agents (same ids) and restore each from its copied
    // log. Creating them registers fresh agent entries with TARGET homedirs.
    for (const agentId of agentIds) {
      const sourceAgent = sourceAgents[agentId]!;
      const agentHandle = await target.accessor.get(IAgentLifecycleService).create({
        agentId,
        type: sourceAgent.type,
        parentAgentId: sourceAgent.parentAgentId,
        swarmItem: sourceAgent.swarmItem,
      });
      await agentHandle.accessor.get(IAgentWireRecordService).restore();
    }

    this._onDidForkSession.fire({
      sourceSessionId: sourceId,
      sessionId: targetId,
      handle: target,
    });
    return target;
  }

  /**
   * Copy one agent's wire log from the source into the target session's
   * per-agent log, appending a `forked` boundary record. Works for both live
   * sources (flush then read) and closed sources (read the persisted log).
   */
  private async copyAgentWire(args: {
    readonly sourceHandle: IScopeHandle | undefined;
    readonly sourceHomedir: string;
    readonly agentId: string;
    readonly targetSessionDir: string;
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

    const sourceKey = wireRecordPersistKey(args.sourceHomedir);
    const records = await collect(this.appendLogStore.read<PersistedWireRecord>('wire', sourceKey));
    // Ensure the log starts with a metadata envelope (restore() requires it).
    if (records.length === 0) {
      records.push(freshMetadataRecord());
    } else if (records[0]?.type !== 'metadata') {
      records.unshift(freshMetadataRecord());
    }
    records.push(forkedRecord());

    const targetHomedir = join(args.targetSessionDir, 'agents', args.agentId);
    const targetKey = wireRecordPersistKey(targetHomedir);
    await this.appendLogStore.rewrite('wire', targetKey, records);
  }

  private async readMetaFromDisk(
    workspaceId: string,
    sessionId: string,
  ): Promise<SessionMeta | undefined> {
    const sessionsScope = relative(this.bootstrap.homeDir, this.bootstrap.sessionsDir);
    const scope = `${sessionsScope}/${workspaceId}/${sessionId}`;
    return this.docs.get<SessionMeta>(scope, 'state.json');
  }
}

registerScopedService(
  LifecycleScope.App,
  ISessionLifecycleService,
  SessionLifecycleService,
  InstantiationType.Delayed,
  'session-lifecycle',
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
