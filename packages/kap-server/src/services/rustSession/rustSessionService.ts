/**
 * RustSessionService — the Rust engine as the kap-server session backend.
 *
 * Every web session is an engine-owned session (rust-loop `createSessionClient`):
 * the ENGINE owns the loop, context, goal driving, tools, approval, and
 * persistence; this service only translates between the engine's session RPC
 * surface and the v1 wire shapes the web UI consumes. The v2 engine
 * (agent-core-v2) is NOT involved in session turns.
 *
 * Responsibilities:
 *  - Session lifecycle: create / close / list (engine `session/*` RPC).
 *  - Turn driving: prompt / cancel / steer / goal / plan / undo / compact /
 *    context (engine RPC, wire shapes kept snake_case).
 *  - Approval surface: `session/approval_list` + `session/approval_resolve`
 *    feed web approval cards; `session.approval.requested` events notify live.
 *  - Events: engine events are projected onto the v1 WS frame shapes the web
 *    UI already renders (see `rustEventProjector`).
 *
 * Host services (model catalog, auth, plugin, workspace registry) remain in
 * their v2-free host layer; this service deliberately does not import
 * `@moonshot-ai/agent-core-v2`.
 */

import type { SessionClient } from '@moonshot-ai/kimi-agent/rust-loop';

/** Fire-and-forget engine event (Rust → host, `host/event`). */
interface EngineEvent {
  type: string;
  session_id?: string;
  [key: string]: unknown;
}

/** The rust-loop session surface this service consumes (structural). */
export interface RustLoopSessionApi {
  createSessionClient(options: {
    sessionId?: string;
    homedir?: string;
    systemPrompt?: string;
    model?: string;
    nativeLlm?: unknown;
    onEvent?: (event: EngineEvent) => void;
  }): Promise<SessionClient | null>;
  sessionApprovalList(sessionId?: string): Promise<unknown>;
  sessionApprovalResolve(
    sessionId: string,
    input: { id: string; decision: 'allow' | 'deny'; reason?: string },
  ): Promise<unknown>;
}

/** One live web session bound to an engine session. */
export interface RustWebSession {
  /** The web-facing session id (also the engine session id). */
  readonly id: string;
  readonly workDir: string;
  /** The engine client handle (prompt/cancel/save/load/close). */
  readonly client: SessionClient;
  /** The engine's last-known status snapshot (model/permission/tokens). */
  status: unknown;
  /** Turn state projected from events (busy / last outcome). */
  busy: boolean;
  lastTurnReason?: 'completed' | 'cancelled' | 'failed';
}

export interface RustSessionServiceOptions {
  /** Called for every projected v1 frame (WS broadcaster hook). */
  onFrame?: (sessionId: string, frame: Record<string, unknown>) => void;
}

/**
 * Project one engine event onto the v1 frame shapes the web UI renders.
 * `session.turn.ended` → `agent.turn.ended`, `llm.delta` → `assistant.delta`,
 * approval events → `approval.requested`, and so on. Unknown events are
 * dropped (the engine's coarse event set maps 1:1 onto the v1 surface).
 */
export function projectRustEvent(event: EngineEvent): Record<string, unknown> | null {
  switch (event.type) {
    case 'session.turn.started':
      return { type: 'agent.turn.started', agent_id: 'main', turn_id: event['turn_id'] };
    case 'session.turn.ended':
      return {
        type: 'agent.turn.ended',
        agent_id: 'main',
        turn_id: event['turn_id'],
        stop_reason: event['stop_reason'],
        steps: event['steps'],
      };
    case 'llm.delta': {
      const part = event['part'] as { type?: string; text?: string; think?: string } | undefined;
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
        return { type: 'assistant.delta', agent_id: 'main', delta: part.text };
      }
      if (part?.type === 'think' && typeof part.think === 'string' && part.think.length > 0) {
        return { type: 'thinking.delta', agent_id: 'main', delta: part.think };
      }
      return null;
    }
    case 'session.tool.started':
      return {
        type: 'tool.call.started',
        agent_id: 'main',
        tool_call_id: event['tool_call_id'],
        tool_name: event['tool_name'],
        arguments: event['arguments'],
      };
    case 'session.tool.settled':
      return {
        type: 'tool.call.settled',
        agent_id: 'main',
        tool_call_id: event['tool_call_id'],
        tool_name: event['tool_name'],
        content: event['content'],
        is_error: event['is_error'],
      };
    case 'session.approval.requested':
      return {
        type: 'approval.requested',
        agent_id: 'main',
        approval_id: event['approval_id'],
        tool_call_id: event['tool_call_id'],
        tool_name: event['tool_name'],
        arguments: event['arguments'],
        approval_rule: event['approval_rule'],
      };
    case 'session.task.started':
      return {
        type: 'task.started',
        agent_id: 'main',
        task_id: event['task_id'],
        description: event['description'],
        kind: event['kind'],
      };
    case 'session.task.terminated':
      return {
        type: 'task.terminated',
        agent_id: 'main',
        task_id: event['task_id'],
        status: event['status'],
        description: event['description'],
      };
    case 'session.usage.updated':
      return {
        type: 'usage.updated',
        agent_id: 'main',
        input_tokens: event['input_tokens'],
        output_tokens: event['output_tokens'],
        total_tokens: event['total_tokens'],
      };
    case 'session.compaction.started':
      return { type: 'compaction.started', agent_id: 'main', source: event['source'] };
    case 'session.compaction.completed':
      return {
        type: 'compaction.completed',
        agent_id: 'main',
        tokens_before: event['tokens_before'],
        tokens_after: event['tokens_after'],
      };
    default:
      return null;
  }
}

export class RustSessionService {
  private readonly sessions = new Map<string, RustWebSession>();
  private readonly options: RustSessionServiceOptions;

  constructor(
    private readonly rustLoop: RustLoopSessionApi,
    options: RustSessionServiceOptions = {},
  ) {
    this.options = options;
  }

  /** Create an engine session for `workDir`. Returns null when the engine is
   *  unavailable (no stdio binary). */
  async createSession(input: {
    sessionId: string;
    workDir: string;
    systemPrompt?: string;
    model?: string;
    nativeLlm?: unknown;
  }): Promise<RustWebSession | null> {
    const existing = this.sessions.get(input.sessionId);
    if (existing !== undefined) return existing;

    const client = await this.rustLoop.createSessionClient({
      sessionId: input.sessionId,
      homedir: input.workDir,
      systemPrompt: input.systemPrompt,
      model: input.model,
      nativeLlm: input.nativeLlm,
      onEvent: (event) => this.handleEvent(input.sessionId, event),
    });
    if (client === null) return null;

    const web: RustWebSession = {
      id: input.sessionId,
      workDir: input.workDir,
      client,
      status: null,
      busy: false,
    };
    this.sessions.set(input.sessionId, web);
    return web;
  }

  getSession(sessionId: string): RustWebSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): RustWebSession[] {
    return [...this.sessions.values()];
  }

  async closeSession(sessionId: string): Promise<void> {
    const web = this.sessions.get(sessionId);
    if (web === undefined) return;
    try {
      await web.client.save();
    } catch {
      // best-effort persist before teardown
    }
    web.client.close?.();
    this.sessions.delete(sessionId);
  }

  /** Run one prompt (goal continuations run inside the engine). */
  async prompt(sessionId: string, text: string): Promise<unknown> {
    const web = this.requireSession(sessionId);
    web.busy = true;
    try {
      const result = await web.client.prompt(text);
      return result;
    } finally {
      web.busy = false;
    }
  }

  async cancel(sessionId: string): Promise<boolean> {
    return this.requireSession(sessionId).client.cancel();
  }

  /** Pending approvals for the session (web approval cards). */
  async approvalList(sessionId: string): Promise<unknown> {
    return this.rustLoop.sessionApprovalList(sessionId);
  }

  /** Resolve a pending approval (allow/deny). */
  async approvalResolve(
    sessionId: string,
    input: { id: string; decision: 'allow' | 'deny'; reason?: string },
  ): Promise<unknown> {
    return this.rustLoop.sessionApprovalResolve(sessionId, input);
  }

  private requireSession(sessionId: string): RustWebSession {
    const web = this.sessions.get(sessionId);
    if (web === undefined) {
      throw new Error(`no session: ${sessionId}`);
    }
    return web;
  }

  private handleEvent(sessionId: string, event: EngineEvent): void {
    // Turn outcomes drive the wire `busy` facts.
    if (event.type === 'session.turn.ended') {
      const web = this.sessions.get(sessionId);
      if (web !== undefined) {
        web.lastTurnReason =
          event['stop_reason'] === 'Aborted' ? 'cancelled' : 'completed';
      }
    }
    const frame = projectRustEvent(event);
    if (frame !== null) {
      this.options.onFrame?.(sessionId, frame);
    }
  }
}
