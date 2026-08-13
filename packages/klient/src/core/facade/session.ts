/**
 * The session facade — one `klient.session(id)` handle aggregating the
 * session-scope services (metadata, activity, approvals, questions,
 * interactions) plus the app-scope lifecycle service for close/archive/
 * restore/delete/fork/createChild. `agents()` reads the metadata registry (agent
 * handles are not serializable, so no agent-lifecycle channel exists on the
 * wire).
 */

import type { AgentActivityState } from '@moonshot-ai/agent-core-v2/agent/activityView/activityView';
import type {
  ApprovalRequest,
  ApprovalResponse,
} from '@moonshot-ai/agent-core-v2/session/approval/approval';
import type {
  Interaction,
  InteractionKind,
} from '@moonshot-ai/agent-core-v2/session/interaction/interaction';
import type {
  QuestionRequest,
  QuestionResult,
} from '@moonshot-ai/agent-core-v2/session/question/question';
import type {
  AgentMeta,
  SessionMeta,
  SessionMetaPatch,
} from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';
import type { SkillSummary } from '@moonshot-ai/agent-core-v2/app/skillCatalog/types';

import type { ScopeRef } from '../channel.js';
import type { McpServerConfig } from '../../contract/mcp.js';
import { RPCError } from '../errors.js';
import type { ScopedCaller } from './global.js';

const NOT_FOUND = 40404;

export type { ScopedCaller } from './global.js';

/** What `sessionLifecycleService.create/fork/createChild` leaves on the wire. */
interface HandleWire {
  readonly id: string;
}

/**
 * Options for `SessionFacade.restore` — mirrors the engine's
 * `ResumeSessionOptions`. `mcpServers` injects ephemeral per-session MCP
 * servers when restore re-materializes a cold session (ignored when the
 * session is already live).
 */
export interface SessionRestoreOptions {
  readonly additionalDirs?: readonly string[];
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
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

export interface SessionSkillsFacade {
  /**
   * Every skill in the session-merged catalog as a plain summary (the
   * catalog's readiness is resolved engine-side). Subscribe to
   * `session.events` `'skills.changed'` for updates.
   */
  list(): Promise<readonly SkillSummary[]>;
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
  /**
   * Generate and apply a title from the main agent's first prompts via the
   * managed `chat_title` tool. `undefined` when generation is unavailable
   * (no managed OAuth login, no prompt yet, or a custom title is set).
   * `force` regenerates anyway, overwriting a generated or custom title.
   * `source` picks the conversation excerpt: `user_prompts` (default),
   * `first_turn` (opening prompt + first reply; strict), or `digest`
   * (head+tail of a multi-turn conversation).
   */
  generateTitle(opts?: {
    force?: boolean;
    source?: 'user_prompts' | 'first_turn' | 'digest';
  }): Promise<string | undefined>;
  update(patch: SessionMetaPatch): Promise<void>;
  setArchived(archived: boolean): Promise<void>;
  status(): Promise<SessionStatus>;
  close(): Promise<void>;
  archive(): Promise<void>;
  /** Re-materialize a closed session; `false` when it no longer exists. */
  restore(opts?: SessionRestoreOptions): Promise<boolean>;
  /** Permanently delete the session and its persisted data; throws when missing. */
  delete(): Promise<void>;
  fork(input?: { title?: string; metadata?: Record<string, unknown> }): Promise<SessionMeta>;
  createChild(input?: { title?: string; metadata?: Record<string, unknown> }): Promise<SessionMeta>;
  readonly approvals: SessionApprovalsFacade;
  readonly questions: SessionQuestionsFacade;
  readonly interactions: SessionInteractionsFacade;
  readonly skills: SessionSkillsFacade;
  /** Agent id → metadata for every agent registered in this session. */
  agents(): Promise<Readonly<Record<string, AgentMeta>>>;
}

export function createSessionFacade(call: ScopedCaller, sessionId: string): SessionFacade {
  const scope: ScopeRef = { sessionId };
  const read = (): Promise<SessionMeta> =>
    call(scope, 'sessionMetadata', 'read', []) as Promise<SessionMeta>;
  // Session lifecycle methods live on the session's workspace handler
  // (Workspace scope) — the index supplies the handler's workspaceId.
  const resolveWorkspaceId = async (): Promise<string | undefined> => {
    const summary = (await call({}, 'sessionIndex', 'get', [sessionId])) as
      | { workspaceId: string }
      | undefined;
    return summary?.workspaceId;
  };
  const spawn = async (
    method: 'fork' | 'createChild',
    input: { title?: string; metadata?: Record<string, unknown> } = {},
  ): Promise<SessionMeta> => {
    const workspaceId = await resolveWorkspaceId();
    if (workspaceId === undefined) {
      throw new RPCError(NOT_FOUND, `session not found: ${sessionId}`);
    }
    const handle = (await call({ workspaceId }, 'sessionLifecycleService', method, [
      { sourceSessionId: sessionId, title: input.title, metadata: input.metadata },
    ])) as HandleWire;
    return call({ sessionId: handle.id }, 'sessionMetadata', 'read', []) as Promise<SessionMeta>;
  };

  return {
    get: read,
    setTitle: (title) => call(scope, 'sessionMetadata', 'setTitle', [title]) as Promise<void>,
    generateTitle: (opts) =>
      call(scope, 'sessionTitleService', 'generateTitle', [opts]) as Promise<
        string | undefined
      >,
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
    close: async () => {
      const workspaceId = await resolveWorkspaceId();
      if (workspaceId === undefined) return;
      await call({ workspaceId }, 'sessionLifecycleService', 'close', [sessionId]);
    },
    archive: async () => {
      const workspaceId = await resolveWorkspaceId();
      if (workspaceId === undefined) return;
      await call({ workspaceId }, 'sessionLifecycleService', 'archive', [sessionId]);
    },
    restore: async (opts) => {
      const workspaceId = await resolveWorkspaceId();
      if (workspaceId === undefined) return false;
      const handle = (await call({ workspaceId }, 'sessionLifecycleService', 'restore', [
        sessionId,
        opts,
      ])) as HandleWire | null;
      // The engine reports "not found" with `undefined`, which JSON transports
      // may surface as `null` — reject both.
      return handle !== null && handle !== undefined;
    },
    delete: async () => {
      const workspaceId = await resolveWorkspaceId();
      if (workspaceId === undefined) {
        throw new RPCError(NOT_FOUND, `session not found: ${sessionId}`);
      }
      await call({ workspaceId }, 'sessionLifecycleService', 'delete', [sessionId]);
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

    skills: {
      list: () =>
        call(scope, 'sessionSkillCatalog', 'list', []) as Promise<readonly SkillSummary[]>,
    },

    agents: async () => {
      const meta = await read();
      return meta.agents ?? {};
    },
  };
}
