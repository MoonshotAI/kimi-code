/**
 * `sessionMetadata` domain (L6) — `ISessionMetadata` implementation.
 *
 * Persists the session metadata document (`state.json`) through the `storage`
 * access-pattern store (`IAtomicDocumentStore`), rooted at the `metaScope`
 * namespace from `sessionContext`. Loads the existing document on
 * construction (creating it on first run), and logs through `log`. Bound at
 * Session scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { ILogService } from '#/_base/log';
import { ISessionContext } from '#/session/sessionContext';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

import {
  ISessionMetadata,
  SESSION_META_VERSION,
  type AgentMeta,
  type SessionMeta,
  type SessionMetadataChangedEvent,
  type SessionMetaPatch,
} from './sessionMetadata';

const META_KEY = 'state.json';

export class SessionMetadata extends Disposable implements ISessionMetadata {
  declare readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  readonly onDidChangeMetadata: Event<SessionMetadataChangedEvent>;

  private readonly _onDidChangeMetadata = this._register(
    new Emitter<SessionMetadataChangedEvent>(),
  );
  private readonly scope: string;
  private data!: SessionMeta;

  constructor(
    @ISessionContext private readonly ctx: ISessionContext,
    @IAtomicDocumentStore private readonly store: IAtomicDocumentStore,
    @ILogService private readonly log: ILogService,
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
    await this.ready;
    this.data = { ...this.data, ...patch, updatedAt: Date.now() };
    await this.store.set(this.scope, META_KEY, this.data);
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
    await this.ready;
    const agents = { ...(this.data.agents ?? {}), [agentId]: meta };
    await this.update({ agents });
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
      createdAt: now,
      updatedAt: now,
      archived: false,
    };
    await this.store.set(this.scope, META_KEY, this.data);
    this.log.debug('session metadata created', { sessionId: this.ctx.sessionId });
  }
}

/**
 * Normalize a persisted `state.json` document into the v2 `SessionMeta` shape.
 *
 * Documents tagged `version: 2` are already v2-shaped and returned as-is.
 * Legacy v1 documents (no `version`) store `createdAt`/`updatedAt` as ISO
 * strings and omit the `id` field; we coerce the timestamps to epoch ms and
 * backfill `id` from the session identity so every reader sees a consistent
 * v2-shaped object. Normalization is in-memory only — the on-disk document is
 * left untouched until an explicit write, so a read-only snapshot of a v1
 * session does not migrate it.
 */
function normalizeSessionMeta(raw: SessionMeta, sessionId: string): SessionMeta {
  if (raw.version === SESSION_META_VERSION) return raw;
  const legacy = raw as unknown as { createdAt?: unknown; updatedAt?: unknown };
  return {
    ...raw,
    id: sessionId,
    version: SESSION_META_VERSION,
    createdAt: toEpochMs(legacy.createdAt),
    updatedAt: toEpochMs(legacy.updatedAt),
  };
}

/** Coerce a persisted timestamp (v2 epoch-ms number or v1 ISO string) to epoch ms. */
function toEpochMs(value: unknown): number {
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
