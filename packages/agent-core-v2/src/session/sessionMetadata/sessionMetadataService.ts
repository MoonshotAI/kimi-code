/**
 * `sessionMetadata` domain (L6) — `ISessionMetadata` implementation.
 *
 * Persists the session metadata document (`state.json`) through the `storage`
 * access-pattern store (`IAtomicDocumentStore`), rooted at the `metaScope`
 * namespace from `sessionContext`. Loads the existing document on
 * construction (creating it on first run), and logs through `log`. Bound at
 * Session scope.
 *
 * Read-model mirroring (flag `persistence_minidb_readmodel`): after a metadata
 * update is persisted, the fresh summary is mirrored into the `IQueryStore`
 * derived read model so `FileSessionIndex` can serve listings without
 * re-reading `state.json`. Mirroring is best-effort (a failure is logged, not
 * thrown) and is a no-op when the flag is off. Initial creation in `load()` is
 * intentionally not mirrored — a not-yet-mirrored session is simply a cold
 * read-model miss that `FileSessionIndex` backfills on first read.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IFlagService } from '#/app/flag/flag';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IQueryStore } from '#/persistence/interface/queryStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import {
  ISessionMetadata,
  SESSION_META_VERSION,
  type AgentMeta,
  type SessionMeta,
  type SessionMetadataChangedEvent,
  type SessionMetaPatch,
} from './sessionMetadata';

const META_KEY = 'state.json';
const SESSION_COLLECTION = 'session';
const READ_MODEL_FLAG = 'persistence_minidb_readmodel';

export class SessionMetadata extends Disposable implements ISessionMetadata {
  declare readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  readonly onDidChangeMetadata: Event<SessionMetadataChangedEvent>;

  private readonly _onDidChangeMetadata = this._register(
    new Emitter<SessionMetadataChangedEvent>(),
  );
  private readonly scope: string;
  private updateQueue: Promise<void> = Promise.resolve();
  private data!: SessionMeta;

  constructor(
    @ISessionContext private readonly ctx: ISessionContext,
    @IAtomicDocumentStore private readonly store: IAtomicDocumentStore,
    @ILogService private readonly log: ILogService,
    @IQueryStore private readonly queryStore: IQueryStore,
    @IFlagService private readonly flags: IFlagService,
  ) {
    super();
    this.scope = ctx.metaScope;
    this.onDidChangeMetadata = this._onDidChangeMetadata.event;
    this.ready = this.load();
  }

  async read(): Promise<SessionMeta> {
    await this.ready;
    return this.data;
  }

  async update(patch: SessionMetaPatch): Promise<void> {
    return this.enqueueUpdate(() => this.applyUpdate(patch));
  }

  private async applyUpdate(patch: SessionMetaPatch): Promise<void> {
    await this.ready;
    this.data = { ...this.data, ...patch, updatedAt: Date.now() };
    await this.store.set(this.scope, META_KEY, this.data);
    await this.mirrorToReadModel();
    this._onDidChangeMetadata.fire({
      changed: Object.keys(patch) as (keyof SessionMeta)[],
    });
  }

  async setTitle(title: string): Promise<void> {
    await this.update({ title, isCustomTitle: true });
  }

  async setArchived(archived: boolean): Promise<void> {
    await this.update({ archived });
  }

  async registerAgent(agentId: string, meta: AgentMeta): Promise<void> {
    return this.enqueueUpdate(async () => {
      await this.ready;
      const agents = { ...this.data.agents, [agentId]: meta };
      await this.applyUpdate({ agents });
    });
  }

  private enqueueUpdate(work: () => Promise<void>): Promise<void> {
    const run = this.updateQueue.then(work, work);
    this.updateQueue = run.catch(() => {});
    return run;
  }

  private async mirrorToReadModel(): Promise<void> {
    if (!this.flags.enabled(READ_MODEL_FLAG)) return;
    try {
      await this.queryStore.put(SESSION_COLLECTION, this.ctx.sessionId, {
        id: this.data.id,
        workspaceId: this.ctx.workspaceId,
        cwd: this.ctx.cwd,
        title: this.data.title,
        lastPrompt: this.data.lastPrompt,
        createdAt: this.data.createdAt,
        updatedAt: this.data.updatedAt,
        archived: this.data.archived,
        custom: this.data.custom,
      });
    } catch (error) {
      this.log.warn('failed to mirror session metadata to read model', {
        sessionId: this.ctx.sessionId,
        error: String(error),
      });
    }
  }

  private async load(): Promise<void> {
    const existing = await this.store.get<SessionMeta>(this.scope, META_KEY);
    if (existing !== undefined) {
      this.data = normalizeSessionMeta(existing, this.ctx.sessionId);
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
    };
    await this.store.set(this.scope, META_KEY, this.data);
    this.log.debug('session metadata created', { sessionId: this.ctx.sessionId });
  }
}

export function normalizeSessionMeta(raw: SessionMeta, sessionId: string): SessionMeta {
  const legacy = raw as unknown as {
    createdAt?: unknown;
    updatedAt?: unknown;
    workDir?: unknown;
  };
  const cwd =
    raw.cwd ?? (typeof legacy.workDir === 'string' && legacy.workDir.length > 0
      ? legacy.workDir
      : undefined);
  if (raw.version === SESSION_META_VERSION) {
    return cwd === raw.cwd ? raw : { ...raw, cwd };
  }
  return {
    ...raw,
    id: sessionId,
    version: SESSION_META_VERSION,
    cwd,
    createdAt: toEpochMs(legacy.createdAt),
    updatedAt: toEpochMs(legacy.updatedAt),
  };
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
  InstantiationType.Delayed,
  'sessionMetadata',
);
