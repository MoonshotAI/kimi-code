import { createDecorator } from '../../di';
import { encodeWorkDirKey } from '../../session/store';
import type { Event } from '../../base/common/event';
import type { SessionSummary } from '../../rpc';
import type { SessionMeta } from '../../session';
import {
  emptySessionUsage,
  type CompactSessionRequest,
  type CompactSessionResponse,
  type CursorQuery,
  type PageResponse,
  type Session,
  type SessionChildCreate,
  type SessionCreate,
  type SessionFork,
  type SessionStatusResponse,
  type SessionUpdate,
  type UndoSessionRequest,
  type UndoSessionResponse,
} from '@moonshot-ai/protocol';

export interface SessionListQuery extends CursorQuery {
  status?: import('@moonshot-ai/protocol').SessionStatus;
  workDir?: string;
  includeArchive?: boolean;
}

export interface SessionClientTelemetry {
  id?: string;
  name?: string;
  version?: string;
  uiMode?: string;
}

export interface SessionCreateOptions {
  client?: SessionClientTelemetry;
}

/**
 * Single-entity persistence contract for one session's `state.json`.
 *
 * Per `services/AGENTS.md` (M0.5) a repository is the aggregate's source of
 * truth: it owns create / get / update and the archive / restore / delete
 * atomic operations, sits *below* the application service layer, and is NOT
 * registered as a top-level `*Service` singleton.
 *
 * `ISessionRepository` is therefore a **per-session** object: one instance is
 * bound to exactly one session `homedir` (its `state.json`), not to the
 * aggregate as a whole. The owner (the runtime `Session`, once wired up) holds
 * the instance and drives it; cross-session orchestration stays in
 * `ISessionService`.
 *
 * Scope of M1.1: only the read / write / flush operations that already exist
 * on the runtime `Session` are modeled here, because they are the only ones
 * with a byte-for-byte mirrorable persistence implementation today. The
 * archive / restore / purge atomic operations are intentionally deferred to
 * M1.5: `archive`'s file IO currently lives in
 * `src/session/store/session-store.ts` (outside this step's allowlist), and
 * `restore` / `purge` have no existing implementation to mirror without
 * inventing new semantics.
 */
export interface ISessionRepository {
  /** Read and parse the session's `state.json`. Throws if it does not exist. */
  read(): Promise<SessionMeta>;

  /**
   * Serialize `meta` to `state.json`. Concurrent calls are ordered: each write
   * is chained onto the previous one so no write is lost or reordered.
   */
  write(meta: SessionMeta): Promise<void>;

  /** Resolve once every previously-submitted `write` has completed. */
  flush(): Promise<void>;
}

export interface ISessionService {
  readonly _serviceBrand: undefined;

  create(input: SessionCreate, options?: SessionCreateOptions): Promise<Session>;

  list(query: SessionListQuery): Promise<PageResponse<Session>>;

  get(id: string): Promise<Session>;

  update(id: string, input: SessionUpdate): Promise<Session>;

  fork(id: string, input: SessionFork): Promise<Session>;

  listChildren(id: string, query: SessionListQuery): Promise<PageResponse<Session>>;

  createChild(id: string, input: SessionChildCreate): Promise<Session>;

  getStatus(id: string): Promise<SessionStatusResponse>;

  compact(id: string, input: CompactSessionRequest): Promise<CompactSessionResponse>;

  undo(id: string, input: UndoSessionRequest): Promise<UndoSessionResponse>;

  archive(id: string): Promise<{ archived: true }>;

  readonly onDidCreate: Event<{ session: Session }>;

  readonly onDidClose: Event<{ sessionId: string }>;
}

export const ISessionService = createDecorator<ISessionService>('sessionService');

export class SessionUndoUnavailableError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string, message = 'Nothing to undo in the active context.') {
    super(message);
    this.name = 'SessionUndoUnavailableError';
    this.sessionId = sessionId;
  }
}

export class SessionNotFoundError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`session ${sessionId} does not exist`);
    this.name = 'SessionNotFoundError';
    this.sessionId = sessionId;
  }
}

export function toProtocolSession(
  summary: SessionSummary,
  meta?: SessionMeta | undefined,
): Session {
  const summaryMetadata = (summary.metadata ?? {}) as Record<string, unknown>;
  const customMetadata = (meta?.custom ?? {}) as Record<string, unknown>;
  const cwd =
    (typeof customMetadata['cwd'] === 'string' && customMetadata['cwd']) ||
    (typeof summaryMetadata['cwd'] === 'string' && summaryMetadata['cwd']) ||
    summary.workDir;

  const { goal: _dropSummaryGoal, ...summaryWithoutGoal } = summaryMetadata;
  const { goal: _dropCustomGoal, ...customWithoutGoal } = customMetadata;

  const mergedMetadata: Session['metadata'] = {
    ...summaryWithoutGoal,
    ...customWithoutGoal,
    cwd,
  };

  const title = meta?.title ?? summary.title ?? '';
  const workspaceId = encodeWorkDirKey(summary.workDir);

  return {
    id: summary.id,
    workspace_id: workspaceId,
    title,
    created_at: new Date(summary.createdAt).toISOString(),
    updated_at: new Date(summary.updatedAt).toISOString(),
    status: 'idle',
    archived: summary.archived === true,
    metadata: mergedMetadata,
    agent_config: {
      model: '',
    },
    usage: emptySessionUsage(),
    permission_rules: [],
    message_count: 0,
    last_seq: 0,
  };
}
