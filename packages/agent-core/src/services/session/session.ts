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
  type SessionWarning,
  type SessionUpdate,
  type UndoSessionRequest,
  type UndoSessionResponse,
} from '@moonshot-ai/protocol';

export interface SessionListQuery extends CursorQuery {
  status?: import('@moonshot-ai/protocol').SessionStatus;
  workDir?: string;
  includeArchive?: boolean;
  /** When true, hide sessions the user has never interacted with (no prompt yet). */
  excludeEmpty?: boolean;
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

  getSessionWarnings(id: string): Promise<readonly SessionWarning[]>;

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
    last_prompt: summary.lastPrompt,
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
