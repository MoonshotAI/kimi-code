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
 * (TUI, export) can discover sessions created by the v2 engine. Fork flushes
 * live agent logs and rejects non-empty logs without a protocol metadata
 * envelope instead of stamping legacy data as current.
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
import {
  missingWireMetadataError,
  WIRE_RECORD_FILENAME,
  wireRecordScope,
} from '#/agent/wireRecord/wireRecordService';
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
    const localWorkspaceDirs = await this.workspaceLocalConfig.readAdditionalDirs(opts.workDir);
    const callerAdditionalDirs = await this.workspaceLocalConfig.resolveAdditionalDirs(
      opts.workDir,
      opts.additionalDirs ?? [],
    );
    const additionalDirs = [...localWorkspaceDirs.additionalDirs, ...callerAdditionalDirs];
    await this.hostEnv.ready;
    const handle = createScopedChildHandle(
      this.instantiation,
      LifecycleScope.Session,
      opts.sessionId,
      {
        extra: [...sessionContextSeed(ctx)],
      },
    ) as ISessionScopeHandle;
    handle.accessor.get(ISessionActivityKernel);
    if (additionalDirs.length > 0) {
      handle.accessor.get(ISessionWorkspaceContext).setAdditionalDirs(additionalDirs);
    }
    this.sessions.set(opts.sessionId, handle);
    await handle.accessor.get(ISessionMetadata).ready;
    void handle.accessor.get(ISessionSkillCatalog).ready;
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
    this.telemetry.track2('session_started', { resumed: event.source === 'resume' });
    event.handle.accessor.get(ISessionActivityKernel).markActive();
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

    const sourceHandle = this.sessions.get(sourceId);
    const indexSummary = await this.index.get(sourceId);
    if (sourceHandle === undefined && indexSummary === undefined) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sourceId} does not exist`);
    }
    const workspaceId =
      sourceHandle !== undefined
        ? sourceHandle.accessor.get(ISessionContext).workspaceId
        : indexSummary!.workspaceId;

    const quiesce =
      sourceHandle !== undefined
        ? await sourceHandle.accessor.get(ISessionActivityKernel).quiesce('fork')
        : undefined;
    let targetId: string | undefined;
    let target: ISessionScopeHandle | undefined;
    let targetSessionDir: string | undefined;
    try {
      const workspace = await this.workspaceRegistry.get(workspaceId);
      if (workspace === undefined) {
        throw new Error2('workspace.not_found', `workspace ${workspaceId} does not exist`);
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

      target = await this.materializeSession({
        sessionId: targetId,
        workDir: workspace.root,
      });
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
        const sourceHomedir = sourceAgents[agentId]!.homedir;
        await this.copyAgentWire({
          sourceHandle,
          sourceHomedir,
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
      if (targetId !== undefined) {
        this.sessions.delete(targetId);
      }
      if (target !== undefined) {
        try {
          target.dispose();
        } catch {
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
    readonly sourceHomedir: string;
    readonly agentId: string;
    readonly targetWorkspaceId: string;
    readonly targetSessionId: string;
  }): Promise<void> {
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
    if (records.length === 0) {
      records.push(freshMetadataRecord());
    } else if (records[0]?.type !== 'metadata') {
      throw missingWireMetadataError();
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
      if (rel === 'state.json' || rel === 'logs' || entry.name === WIRE_RECORD_FILENAME) {
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
  InstantiationType.Delayed,
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
