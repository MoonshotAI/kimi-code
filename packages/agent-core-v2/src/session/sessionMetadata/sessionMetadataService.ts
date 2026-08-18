import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { defineState } from '#/state/state';
import { ISessionIndexMirror } from '#/app/sessionIndex/sessionIndex';
import { buildSessionSummary } from '#/app/sessionIndex/sessionIndexSource';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionStateService } from '#/session/state/sessionState';

import {
  ISessionMetadata,
  SESSION_META_VERSION,
  type AgentMeta,
  type SessionMeta,
  type SessionMetadataChangedEvent,
  type SessionMetaPatch,
  type SessionTitleKind,
} from './sessionMetadata';

const META_KEY = 'state.json';

const pendingWrites = new Set<Promise<void>>();

export async function drainSessionMetadataWrites(): Promise<void> {
  await Promise.all(pendingWrites);
}

export const sessionMetadataDataKey = defineState<SessionMeta | undefined>(
  'sessionMetadata.data',
  () => undefined,
);

export class SessionMetadata extends Service implements ISessionMetadata {
  declare readonly _serviceBrand: undefined;

  private disposed = false;
  readonly ready: Promise<void>;
  readonly onDidChangeMetadata: Event<SessionMetadataChangedEvent>;

  private readonly _onDidChangeMetadata = this._register(
    new Emitter<SessionMetadataChangedEvent>(),
  );
  private readonly scope: string;
  private updateQueue: Promise<void> = Promise.resolve();

  constructor(
    @ISessionStateService private readonly states: ISessionStateService,
    @ISessionContext private readonly ctx: ISessionContext,
    @IAtomicDocumentStore private readonly store: IAtomicDocumentStore,
    @ILogService private readonly log: ILogService,
    @ISessionIndexMirror private readonly mirror: ISessionIndexMirror,
  ) {
    super();
    this._register({
      dispose: () => {
        this.disposed = true;
      },
    });
    this.states.contributeState(sessionMetadataDataKey);
    this.scope = ctx.metaScope;
    this.onDidChangeMetadata = this._onDidChangeMetadata.event;
    this.ready = this.load();
  }

  private get data(): SessionMeta {
    return this.states.get(sessionMetadataDataKey) as SessionMeta;
  }

  private set data(value: SessionMeta) {
    this.states.set(sessionMetadataDataKey, value);
  }

  async read(): Promise<SessionMeta> {
    await this.ready;
    return this.data;
  }

  async update(
    patch: SessionMetaPatch,
    opts?: { readonly touchUpdatedAt?: boolean },
  ): Promise<void> {
    return this.enqueueUpdate(async () => {
      await this.applyUpdate(patch, opts);
    });
  }

  private async applyUpdate(
    patch: SessionMetaPatch,
    opts?: { readonly touchUpdatedAt?: boolean },
  ): Promise<boolean> {
    await this.ready;
    if (this.disposed) return false;
    const updatedAt =
      patch.updatedAt ?? (opts?.touchUpdatedAt === false ? this.data.updatedAt : Date.now());
    this.data = { ...this.data, ...patch, updatedAt };
    await this.store.set(this.scope, META_KEY, encodeSessionMeta(this.data));
    if (this.disposed) return false;
    this.mirrorToReadModel();
    this._onDidChangeMetadata.fire({
      changed: Object.keys(patch) as (keyof SessionMeta)[],
    });
    return true;
  }

  async setTitle(title: string): Promise<void> {
    await this.update({ title, titleKind: 'custom' }, { touchUpdatedAt: false });
  }

  async setGeneratedTitleIfUncustomized(
    title: string,
    opts?: { force?: boolean },
  ): Promise<boolean> {
    return this.enqueueUpdate(async () => {
      await this.ready;
      if (opts?.force !== true && this.data.titleKind === 'custom') return false;
      return this.applyUpdate({ title, titleKind: 'generated' }, { touchUpdatedAt: false });
    });
  }

  async setArchived(archived: boolean): Promise<void> {
    await this.update(
      archived ? { archived: true, archivedAt: Date.now() } : { archived: false, archivedAt: undefined },
      { touchUpdatedAt: false },
    );
  }

  async registerAgent(agentId: string, meta: AgentMeta): Promise<void> {
    return this.enqueueUpdate(async () => {
      await this.ready;
      const existing = this.data.agents?.[agentId];
      if (existing !== undefined && agentMetaEquals(existing, meta)) return;
      const agents = { ...this.data.agents, [agentId]: meta };
      await this.applyUpdate({ agents }, { touchUpdatedAt: false });
    });
  }

  private enqueueUpdate<T>(work: () => Promise<T>): Promise<T> {
    const run = this.updateQueue.then(work, work);
    const tracked: Promise<void> = run.then(
      () => undefined,
      () => undefined,
    );
    this.updateQueue = tracked;
    pendingWrites.add(tracked);
    void tracked.finally(() => pendingWrites.delete(tracked));
    return run;
  }

  private mirrorToReadModel(): void {
    try {
      this.mirror.record(
        buildSessionSummary({
          id: this.data.id,
          workspaceId: this.ctx.workspaceId,
          cwd: this.ctx.cwd,
          title: this.data.title,
          lastPrompt: this.data.lastPrompt,
          createdAt: this.data.createdAt,
          updatedAt: this.data.updatedAt,
          archived: this.data.archived === true,
          archivedAt: this.data.archivedAt,
          custom: this.data.custom,
          lastTurnReason: this.data.lastTurnReason,
        }),
      );
    } catch (error) {
      this.log.warn('session index mirror record failed; the read model heals by reconciliation', {
        sessionId: this.ctx.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async load(): Promise<void> {
    const existing = await this.store.get<SessionMeta>(this.scope, META_KEY);
    if (existing !== undefined) {
      this.data = normalizeSessionMeta(existing, this.ctx.sessionId);
      if (
        this.data.agents === undefined ||
        this.data.custom === undefined ||
        sessionMetaTitleNeedsMigration(existing, this.data)
      ) {
        this.data = {
          ...this.data,
          agents: this.data.agents ?? {},
          custom: this.data.custom ?? {},
        };
        await this.store.set(this.scope, META_KEY, encodeSessionMeta(this.data));
      }
      return;
    }
    const now = Date.now();
    this.data = {
      id: this.ctx.sessionId,
      version: SESSION_META_VERSION,
      cwd: this.ctx.cwd,
      createdAt: now,
      updatedAt: now,
      archived: false,
      agents: {},
      custom: {},
    };
    await this.store.set(this.scope, META_KEY, encodeSessionMeta(this.data));
    this.mirrorToReadModel();
    this.log.debug('session metadata created', { sessionId: this.ctx.sessionId });
  }
}

function agentMetaEquals(a: AgentMeta, b: AgentMeta): boolean {
  return (
    a.homedir === b.homedir &&
    a.type === b.type &&
    (a.parentAgentId ?? null) === (b.parentAgentId ?? null) &&
    a.forkedFrom === b.forkedFrom &&
    a.swarmItem === b.swarmItem &&
    recordEquals(a.labels, b.labels)
  );
}

function recordEquals(a: AgentMeta['labels'], b: AgentMeta['labels']): boolean {
  const entriesA = Object.entries(a ?? {});
  const entriesB = Object.entries(b ?? {});
  return (
    entriesA.length === entriesB.length && entriesA.every(([key, value]) => b?.[key] === value)
  );
}

export function normalizeSessionMeta(raw: SessionMeta, sessionId: string): SessionMeta {
  const legacy = raw as unknown as LegacySessionMeta;
  const normalizedTitle = normalizeSessionTitle(legacy);
  const {
    createdAt: legacyCreatedAt,
    updatedAt: legacyUpdatedAt,
    workDir: legacyWorkDir,
    titleSource: _legacyTitleSource,
    isCustomTitle: _legacyIsCustomTitle,
    customTitle: _legacyCustomTitle,
    ...clean
  } = legacy;
  const cwd =
    clean.cwd ?? (typeof legacyWorkDir === 'string' && legacyWorkDir.length > 0
      ? legacyWorkDir
      : undefined);
  const { title, titleKind } = normalizedTitle;
  return {
    ...clean,
    id: clean.version === SESSION_META_VERSION ? clean.id : sessionId,
    version: SESSION_META_VERSION,
    cwd,
    title,
    titleKind,
    createdAt: toEpochMs(legacyCreatedAt),
    updatedAt: toEpochMs(legacyUpdatedAt),
    archived: clean.archived === true,
  };
}

type LegacySessionMeta = Omit<SessionMeta, 'createdAt' | 'updatedAt'> & {
  readonly createdAt?: unknown;
  readonly updatedAt?: unknown;
  readonly workDir?: unknown;
  readonly titleSource?: unknown;
  readonly isCustomTitle?: unknown;
  readonly customTitle?: unknown;
};

function normalizeSessionTitle(
  raw: LegacySessionMeta,
): Pick<SessionMeta, 'title' | 'titleKind'> {
  const title = typeof raw.title === 'string' ? raw.title : undefined;
  if (title !== undefined && raw.isCustomTitle === true) {
    return { title, titleKind: 'custom' };
  }
  if (title !== undefined && isSessionTitleKind(raw.titleKind)) {
    return { title, titleKind: raw.titleKind };
  }
  if (title !== undefined && raw.isCustomTitle === false) {
    return { title, titleKind: 'replaceable' };
  }
  if (typeof raw.customTitle === 'string') {
    return { title: raw.customTitle, titleKind: 'custom' };
  }
  return title === undefined ? {} : { title, titleKind: 'replaceable' };
}

function isSessionTitleKind(value: unknown): value is SessionTitleKind {
  return value === 'replaceable' || value === 'generated' || value === 'custom';
}

type PersistedSessionMeta = SessionMeta & { readonly isCustomTitle: boolean };

function encodeSessionMeta(meta: SessionMeta): PersistedSessionMeta {
  return { ...meta, isCustomTitle: meta.titleKind === 'custom' };
}

function sessionMetaTitleNeedsMigration(raw: SessionMeta, normalized: SessionMeta): boolean {
  const record = raw as unknown as Record<string, unknown>;
  return (
    raw.title !== normalized.title ||
    raw.titleKind !== normalized.titleKind ||
    record['isCustomTitle'] !== (normalized.titleKind === 'custom') ||
    Object.hasOwn(record, 'titleSource') ||
    Object.hasOwn(record, 'customTitle')
  );
}

export function toEpochMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

registerScopedService(
  LifecycleScope.Session,
  ISessionMetadata,
  SessionMetadata,
  ScopeActivation.OnScopeCreated,
  'sessionMetadata',
);
