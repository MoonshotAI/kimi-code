/**
 * The session facade — one `klient.session(id)` handle aggregating the
 * session-scope services (metadata, activity, approvals, questions,
 * interactions) plus the app-scope lifecycle service for close/archive/
 * restore/fork/createChild. `agents()` reads the metadata registry (agent
 * handles are not serializable, so no agent-lifecycle channel exists on the
 * wire).
 */

import type { AgentActivityState } from '@moonshot-ai/agent-core-v2/agent/activityView/activityView';
import type {
  AgentMeta,
  SessionMeta,
  SessionMetaPatch,
} from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';
import type {
  ApprovalRequest,
  ApprovalResponse,
} from '@moonshot-ai/agent-core-v2/session/approval/approval';
import type {
  QuestionRequest,
  QuestionResult,
} from '@moonshot-ai/agent-core-v2/session/question/question';
import type {
  Interaction,
  InteractionKind,
} from '@moonshot-ai/agent-core-v2/session/interaction/interaction';

import type { ScopeRef } from '../channel.js';
import type { ScopedCaller } from './global.js';

export type { ScopedCaller } from './global.js';

/** What `sessionLifecycleService.create/fork/createChild` leaves on the wire. */
interface HandleWire {
  readonly id: string;
}

export interface SessionApprovalsFacade {
  list(): Promise<readonly ApprovalRequest[]>;
  decide(id: string, response: ApprovalResponse): Promise<void>;
}

export interface SessionQuestionsFacade {
  list(): Promise<readonly QuestionRequest[]>;
  answer(id: string, result: QuestionResult): Promise<void>;
  dismiss(id: string): Promise<void>;
}

export interface SessionInteractionsFacade {
  list(kind?: InteractionKind): Promise<readonly Interaction[]>;
  respond(id: string, response: unknown): Promise<void>;
}

/**
 * Derived session lifecycle phase. The engine retired its `sessionActivity`
 * service (#1751) — busy is now derived from agent activity views — so the
 * facade composes the phase from the pending interaction lists and each
 * agent's `agentActivityView`, keeping the retired service's precedence.
 */
export type SessionStatus = 'running' | 'idle' | 'awaiting_approval' | 'awaiting_question';

export interface SessionFacade {
  get(): Promise<SessionMeta>;
  setTitle(title: string): Promise<void>;
  update(patch: SessionMetaPatch): Promise<void>;
  setArchived(archived: boolean): Promise<void>;
  status(): Promise<SessionStatus>;
  close(): Promise<void>;
  archive(): Promise<void>;
  /** Re-materialize a closed session; `false` when it no longer exists. */
  restore(): Promise<boolean>;
  fork(input?: { title?: string; metadata?: Record<string, unknown> }): Promise<SessionMeta>;
  createChild(input?: {
    title?: string;
    metadata?: Record<string, unknown>;
  }): Promise<SessionMeta>;
  readonly approvals: SessionApprovalsFacade;
  readonly questions: SessionQuestionsFacade;
  readonly interactions: SessionInteractionsFacade;
  /** Agent id → metadata for every agent registered in this session. */
  agents(): Promise<Readonly<Record<string, AgentMeta>>>;
}

export function createSessionFacade(call: ScopedCaller, sessionId: string): SessionFacade {
  const scope: ScopeRef = { sessionId };
  const read = (): Promise<SessionMeta> =>
    call(scope, 'sessionMetadata', 'read', []) as Promise<SessionMeta>;
  const spawn = async (
    method: 'fork' | 'createChild',
    input: { title?: string; metadata?: Record<string, unknown> } = {},
  ): Promise<SessionMeta> => {
    const handle = (await call({}, 'sessionLifecycleService', method, [
      { sourceSessionId: sessionId, title: input.title, metadata: input.metadata },
    ])) as HandleWire;
    return call({ sessionId: handle.id }, 'sessionMetadata', 'read', []) as Promise<SessionMeta>;
  };

  return {
    get: read,
    setTitle: (title) => call(scope, 'sessionMetadata', 'setTitle', [title]) as Promise<void>,
    update: (patch) => call(scope, 'sessionMetadata', 'update', [patch]) as Promise<void>,
    setArchived: (archived) =>
      call(scope, 'sessionMetadata', 'setArchived', [archived]) as Promise<void>,
    status: async () => {
      const pending = (kind: 'approval' | 'question') =>
        call(scope, 'sessionInteractionService', 'listPending', [kind]) as Promise<
          readonly unknown[]
        >;
      if ((await pending('approval')).length > 0) return 'awaiting_approval';
      if ((await pending('question')).length > 0) return 'awaiting_question';
      const meta = await read();
      for (const agentId of Object.keys(meta.agents ?? {})) {
        try {
          const state = (await call(
            { sessionId, agentId },
            'agentActivityView',
            'state',
            [],
          )) as AgentActivityState;
          if (state.turn !== undefined || state.background.length > 0) return 'running';
        } catch {
          // Agents stay registered after their live handle is gone; the scope
          // probe fails for a dead agent, so treat it as not active — the same
          // view the retired service had from iterating live handles only.
        }
      }
      return 'idle';
    },
    close: () => call({}, 'sessionLifecycleService', 'close', [sessionId]) as Promise<void>,
    archive: () => call({}, 'sessionLifecycleService', 'archive', [sessionId]) as Promise<void>,
    restore: async () => {
      const handle = (await call({}, 'sessionLifecycleService', 'restore', [
        sessionId,
      ])) as HandleWire | null;
      return handle !== null;
    },
    fork: (input) => spawn('fork', input),
    createChild: (input) => spawn('createChild', input),

    approvals: {
      list: () =>
        call(scope, 'sessionApprovalService', 'listPending', []) as Promise<
          readonly ApprovalRequest[]
        >,
      decide: (id, response) =>
        call(scope, 'sessionApprovalService', 'decide', [id, response]) as Promise<void>,
    },

    questions: {
      list: () =>
        call(scope, 'sessionQuestionService', 'listPending', []) as Promise<
          readonly QuestionRequest[]
        >,
      answer: (id, result) =>
        call(scope, 'sessionQuestionService', 'answer', [id, result]) as Promise<void>,
      dismiss: (id) => call(scope, 'sessionQuestionService', 'dismiss', [id]) as Promise<void>,
    },

    interactions: {
      list: (kind) =>
        call(scope, 'sessionInteractionService', 'listPending', [kind]) as Promise<
          readonly Interaction[]
        >,
      respond: (id, response) =>
        call(scope, 'sessionInteractionService', 'respond', [id, response]) as Promise<void>,
    },

    agents: async () => {
      const meta = await read();
      return meta.agents ?? {};
    },
  };
}
