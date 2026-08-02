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

import type {
  LlmChatRequest,
  LlmChatResponse,
  SessionClient,
} from '@moonshot-ai/kimi-agent/rust-loop';

/** Fire-and-forget engine event (Rust → host, `host/event`). */
interface EngineEvent {
  type: string;
  session_id?: string;
  [key: string]: unknown;
}

/** Stringify an engine event field for wire projection (unknown → ''). */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The rust-loop session surface this service consumes (structural). */
export interface RustLoopSessionApi {
  createSessionClient(options: {
    sessionId?: string;
    homedir?: string;
    systemPrompt?: string;
    model?: string;
    nativeLlm?: unknown;
    llmStep?: (req: LlmChatRequest) => Promise<LlmChatResponse>;
    onEvent?: (event: EngineEvent) => void;
  }): Promise<SessionClient | null>;
  sessionApprovalList(sessionId?: string): Promise<unknown>;
  sessionApprovalResolve(
    sessionId: string,
    input: { id: string; decision: 'allow' | 'deny'; reason?: string },
  ): Promise<unknown>;
  /** Engine's parsed global config (stage 2a). */
  configGet?(): Promise<unknown>;
  /** Merge a camelCase KimiConfig patch into the on-disk config (stage 2e). */
  configSet?(patch: Record<string, unknown>): Promise<unknown>;
  /** Session zip export (stage 2c); base64-encoded zip. */
  sessionExport?(sessionId: string, homedir?: string, webLog?: string): Promise<unknown>;
  /** Read-class fs action (stage 2d). */
  sessionFs?(input: {
    session_id: string;
    action: 'read' | 'list' | 'search';
    homedir?: string;
    path?: string;
    line_offset?: number;
    n_lines?: number;
    query?: string;
    limit?: number;
  }): Promise<unknown>;
  /** Native tool definitions for the session workspace (stage 3d). */
  sessionListTools?(sessionId: string, homedir?: string): Promise<unknown>;
}

/** One live web session bound to an engine session. */
export interface RustWebSession {
  /** The web-facing session id (also the engine session id). */
  readonly id: string;
  readonly workDir: string;
  /** Web-facing title (mirrors the v1 session summary). */
  title: string;
  /** Created/updated timestamps (v1 session summary). */
  createdAt: string;
  updatedAt: string;
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
  /**
   * Host-proxy LLM step handler (tests). When set, engine turns run through
   * the host callback (`createSessionClient` `llmStep`) instead of a native
   * HTTP LLM transport; without either, engine prompts hang waiting for a
   * provider.
   */
  llmStep?: (req: LlmChatRequest) => Promise<LlmChatResponse>;
}

/** One accumulated wire message (stage 1d: engine events → message history).
 *  Content parts mirror the v1 `MessageContent` union (text/tool_use/
 *  tool_result), built from the projected turn/tool events. */
export interface RustWireMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: Array<{
    type: string;
    text?: string;
    tool_call_id?: string;
    tool_name?: string;
    input?: unknown;
    content?: string;
    is_error?: boolean;
  }>;
  created_at: string;
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

  /** Per-session accumulated wire messages (stage 1d). */
  private readonly messages = new Map<string, RustWireMessage[]>();

  /** Create an engine session for `workDir`. Returns null when the engine is
   *  unavailable (no stdio binary). */
  async createSession(input: {
    sessionId: string;
    workDir: string;
    title?: string;
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
      llmStep: this.options.llmStep,
      onEvent: (event) => this.handleEvent(input.sessionId, event),
    });
    if (client === null) return null;

    const now = new Date().toISOString();
    const web: RustWebSession = {
      id: input.sessionId,
      workDir: input.workDir,
      title: input.title ?? '',
      createdAt: now,
      updatedAt: now,
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
    // Stage 1d: record the user message so the message history route has the
    // prompt even before the first delta arrives.
    this.accumulate(sessionId, {
      id: `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      role: 'user',
      content: [{ type: 'text', text }],
      created_at: new Date().toISOString(),
    });
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

  // ── Session detail proxies (engine RPC → v1 wire) ────────────────────────
  // Stage 1a of the kap-server Rust migration: surface the engine's
  // status/usage/warnings/goal/MCP/skills snapshots to the web UI so the
  // Rust-mode session detail routes have data (previously skipped → empty).

  /** Engine session status (model/permission/tokens). */
  async getStatus(sessionId: string): Promise<unknown> {
    return this.requireSession(sessionId).client.getStatus?.() ?? null;
  }

  /** Cumulative usage snapshot. */
  async getUsage(sessionId: string): Promise<unknown> {
    return this.requireSession(sessionId).client.getUsage?.() ?? null;
  }

  /** Session warnings (failed MCP servers etc.). */
  async getWarnings(sessionId: string): Promise<unknown> {
    return this.requireSession(sessionId).client.getWarnings?.() ?? null;
  }

  /** Active goal snapshot, if any. */
  async goalGet(sessionId: string): Promise<unknown> {
    return this.requireSession(sessionId).client.goalGet?.() ?? null;
  }

  /** Global background-task roster (engine `task/list`; not per-session). */
  async taskList(sessionId: string): Promise<unknown> {
    return this.requireSession(sessionId).client.taskList?.() ?? [];
  }

  /** Per-server MCP views. */
  async listMcpServers(sessionId: string): Promise<unknown> {
    return this.requireSession(sessionId).client.listMcpServers?.() ?? null;
  }

  /** Registered skills for the session. */
  async listSkills(sessionId: string): Promise<unknown> {
    return this.requireSession(sessionId).client.listSkills?.() ?? null;
  }

  /** Engine's parsed global config (stage 2a); secrets NOT redacted. */
  async configGet(): Promise<unknown> {
    return this.rustLoop.configGet?.() ?? null;
  }

  /** Merge a camelCase KimiConfig patch into the on-disk config (stage 2e). */
  async configSet(patch: Record<string, unknown>): Promise<unknown> {
    return this.rustLoop.configSet?.(patch) ?? null;
  }

  /** Session zip export (stage 2c); base64-encoded zip. */
  async sessionExport(sessionId: string, homedir?: string, webLog?: string): Promise<unknown> {
    return this.rustLoop.sessionExport?.(sessionId, homedir, webLog) ?? null;
  }

  /** Read-class fs action (stage 2d): read/list/search against the session root. */
  async fsAction(
    sessionId: string,
    input: {
      action: 'read' | 'list' | 'search';
      path?: string;
      line_offset?: number;
      n_lines?: number;
      query?: string;
      limit?: number;
    },
  ): Promise<unknown> {
    const web = this.sessions.get(sessionId);
    if (web === undefined) return null;
    return this.rustLoop.sessionFs?.({
      session_id: sessionId,
      action: input.action,
      homedir: web.workDir,
      path: input.path,
      line_offset: input.line_offset,
      n_lines: input.n_lines,
      query: input.query,
      limit: input.limit,
    }) ?? null;
  }

  /** Native tool definitions for the session workspace (stage 3d). */
  async listTools(sessionId: string): Promise<unknown> {
    const web = this.sessions.get(sessionId);
    if (web === undefined) return null;
    return this.rustLoop.sessionListTools?.(sessionId, web.workDir) ?? null;
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
    // Stage 1d: accumulate assistant text and tool calls into the message
    // history from the raw engine events (before projection).
    if (event.type === 'llm.delta') {
      const part = event['part'] as { type?: string; text?: string } | undefined;
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
        this.appendAssistantText(sessionId, part.text);
      }
    } else if (event.type === 'session.tool.started') {
      this.accumulate(sessionId, {
        id: `tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        role: 'tool',
        content: [
          {
            type: 'tool_use',
            tool_call_id: asString(event['tool_call_id']),
            tool_name: asString(event['tool_name']),
            input: event['arguments'],
          },
        ],
        created_at: new Date().toISOString(),
      });
    } else if (event.type === 'session.tool.settled') {
      const list = this.messages.get(sessionId) ?? [];
      const last = list.at(-1);
      if (last !== undefined && last.role === 'tool') {
        last.content.push({
          type: 'tool_result',
          tool_call_id: asString(event['tool_call_id']),
          content: typeof event['content'] === 'string' ? event['content'] : '',
          is_error: event['is_error'] === true,
        });
      }
    }
    const frame = projectRustEvent(event);
    if (frame !== null) {
      this.options.onFrame?.(sessionId, frame);
    }
  }

  /** Append a text delta to the trailing assistant message, or start one. */
  private appendAssistantText(sessionId: string, text: string): void {
    const list = this.messages.get(sessionId) ?? [];
    const last = list.at(-1);
    if (last !== undefined && last.role === 'assistant') {
      const textPart = last.content.find((c) => c.type === 'text');
      if (textPart !== undefined) {
        textPart.text = (textPart.text ?? '') + text;
      } else {
        last.content.push({ type: 'text', text });
      }
    } else {
      list.push({
        id: `assistant-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        role: 'assistant',
        content: [{ type: 'text', text }],
        created_at: new Date().toISOString(),
      });
    }
    this.messages.set(sessionId, list);
  }

  private accumulate(sessionId: string, message: RustWireMessage): void {
    const list = this.messages.get(sessionId) ?? [];
    list.push(message);
    this.messages.set(sessionId, list);
  }

  /** Accumulated wire messages for a session (stage 1d, message-history route). */
  getMessages(sessionId: string): RustWireMessage[] {
    return this.messages.get(sessionId) ?? [];
  }
}
