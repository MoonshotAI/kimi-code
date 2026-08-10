/**
 * Local `Session` implementation — thin typed RPC over `EngineRpcClient`,
 * replacing the node-sdk `Session` (G-1 vscode localization). Events are
 * filtered by session id (side-question `btw-` turns map back onto the
 * parent); `session.approval.requested` events route to the registered
 * approval handler and auto-resolve via `session/approval_resolve` (same
 * event-driven model as the Rust kimi-sdk).
 */

import type { EngineRpcClient } from "./rpc-client";
import { METHODS } from "./rpc-client";
import type {
  AgentReplayRecord,
  ApprovalRequest,
  ContextMessage,
  EngineEvent,
  PromptInput,
  QuestionRequest,
  ResumedSessionState,
  SessionStatus,
  SessionSummary,
} from "./types";

/** Approval handler (node-sdk `ApprovalHandler` parity). */
export type ApprovalHandler = (
  request: ApprovalRequest,
) => Promise<{ decision: string; feedback?: string }>;

/** Question handler — kept for API parity; the engine's AskUserQuestion
 *  tool stops the turn and the answer arrives as the next user message, so
 *  no reverse request ever reaches this handler. */
export type QuestionHandler = (request: QuestionRequest) => Promise<unknown>;

export type EventListener = (event: EngineEvent) => void;

/** Resume-state shape the replay adapter reads (`agents.main.replay`). */
export type LocalResumeState = ResumedSessionState;

/** Map an engine context message onto the SDK replay shape (snake_case →
 *  camelCase top-level keys; content parts pass through). */
function mapContextMessage(raw: Record<string, unknown>): Record<string, unknown> {
  const toolCalls = Array.isArray(raw["tool_calls"])
    ? (raw["tool_calls"] as unknown[]).map((call) => {
        const c = (call ?? {}) as Record<string, unknown>;
        return {
          id: typeof c["id"] === "string" ? c["id"] : "",
          name: typeof c["name"] === "string" ? c["name"] : "",
          arguments: typeof c["arguments"] === "string" ? c["arguments"] : undefined,
        };
      })
    : [];
  return {
    role: typeof raw["role"] === "string" ? raw["role"] : "user",
    content: Array.isArray(raw["content"]) ? raw["content"] : [],
    toolCalls,
    ...(typeof raw["tool_call_id"] === "string" ? { toolCallId: raw["tool_call_id"] } : {}),
    ...(raw["origin"] !== undefined ? { origin: raw["origin"] } : {}),
    ...(typeof raw["is_error"] === "boolean" ? { isError: raw["is_error"] } : {}),
    ...(typeof raw["partial"] === "boolean" ? { partial: raw["partial"] } : {}),
    ...(typeof raw["name"] === "string" ? { name: raw["name"] } : {}),
  };
}

/** Build SDK replay records from an engine context snapshot. */
export function replayFromContext(raw: unknown): readonly unknown[] {
  if (typeof raw !== "object" || raw === null) return [];
  const history = (raw as Record<string, unknown>)["history"];
  if (!Array.isArray(history)) return [];
  const records: unknown[] = [];
  for (const value of history) {
    if (typeof value !== "object" || value === null) continue;
    const message = value as Record<string, unknown>;
    const role = message["role"];
    if (role !== "user" && role !== "assistant" && role !== "tool") continue;
    records.push({ type: "message", message: mapContextMessage(message) });
  }
  return records;
}

/** The session surface hosts consume (implemented by `LocalSession`;
 *  declared as an interface so test fakes can satisfy it structurally). */
export interface SessionLike {
  readonly id: string;
  readonly workDir: string;
  readonly summary?: SessionSummary;
  getResumeState(): LocalResumeState | undefined;
  onEvent(listener: EventListener): () => void;
  setApprovalHandler(handler: ApprovalHandler | undefined): void;
  setQuestionHandler(handler: QuestionHandler | undefined): void;
  prompt(input: string | PromptInput): Promise<void>;
  steer(input: string | PromptInput): Promise<void>;
  cancel(): Promise<unknown>;
  compact(options?: { instruction?: string }): Promise<unknown>;
  cancelCompaction(): Promise<void>;
  getStatus(): Promise<SessionStatus>;
  updateMetadata(metadata: Record<string, unknown>): Promise<void>;
  setPermission(mode: string): Promise<void>;
  setModel(model: string): Promise<void>;
  setThinking(effort: string): Promise<void>;
  setPlanMode(enabled: boolean): Promise<void>;
  activateSkill(name: string, args: string | undefined): Promise<{ status: string }>;
  init(): Promise<void>;
  clearContext(): Promise<boolean>;
  getPlan(): Promise<{ content?: string; path?: string } | undefined>;
  clearPlan(): Promise<void>;
  importContext(content: string, source: string): Promise<void>;
  addAdditionalDir(path: string, options?: { persist?: boolean }): Promise<{ additionalDirs: readonly string[] }>;
  getContext(): Promise<{ history: readonly ContextMessage[]; tokenCount?: number }>;
  close(): Promise<void>;
}

/** One session handle; every method is a thin typed RPC. */
export class LocalSession implements SessionLike {
  readonly summary?: SessionSummary;
  /** The session's workspace (from the summary record). */
  get workDir(): string {
    return this.summary?.workDir ?? "";
  }

  private readonly listeners = new Set<EventListener>();  private approvalHandler: ApprovalHandler | undefined;
  private questionHandler: QuestionHandler | undefined;
  private readonly unsubscribe: () => void;
  private resumeState: LocalResumeState | undefined;
  private closed = false;
  /** Host-side summary updates (additional-dir mirror, node-sdk parity —
   *  the engine does not persist `additional_dirs`). */
  private readonly onSummaryUpdate: ((summary: SessionSummary) => void) | undefined;

  constructor(
    readonly id: string,
    private readonly rpc: EngineRpcClient,
    summary?: SessionSummary,
    onSummaryUpdate?: (summary: SessionSummary) => void,
  ) {
    this.summary = summary;
    this.onSummaryUpdate = onSummaryUpdate;
    this.unsubscribe = rpc.onEvent((raw) => this.dispatch(raw));
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setApprovalHandler(handler: ApprovalHandler | undefined): void {
    this.approvalHandler = handler;
  }

  setQuestionHandler(handler: QuestionHandler | undefined): void {
    // Kept for API parity; see the type doc — the engine's AskUserQuestion
    // stops the turn instead of issuing a reverse request.
    this.questionHandler = handler;
  }

  async prompt(input: string | PromptInput): Promise<void> {
    await this.rpc.call(METHODS.SESSION_PROMPT, {
      session_id: this.id,
      input: typeof input === "string" ? [{ type: "text", text: input }] : input,
    });
  }

  async steer(input: string | PromptInput): Promise<void> {
    await this.rpc.call(METHODS.SESSION_STEER, {
      session_id: this.id,
      input: typeof input === "string" ? [{ type: "text", text: input }] : input,
    });
  }

  async cancel(): Promise<unknown> {
    return this.rpc.call(METHODS.SESSION_CANCEL, { session_id: this.id });
  }

  async compact(options?: { instruction?: string }): Promise<unknown> {
    const params: Record<string, unknown> = { session_id: this.id };
    if (options?.instruction !== undefined) params["instruction"] = options.instruction;
    return this.rpc.call(METHODS.SESSION_COMPACT, params);
  }

  async cancelCompaction(): Promise<void> {
    await this.rpc.call(METHODS.SESSION_CANCEL_COMPACT, { session_id: this.id });
  }

  async getStatus(): Promise<SessionStatus> {
    const raw = (await this.rpc.call(METHODS.SESSION_GET_STATUS, {
      session_id: this.id,
    })) as Record<string, unknown>;
    // Engine wire is snake_case; the SDK surface is camelCase (node-sdk
    // `SessionStatus` parity).
    return {
      ...(typeof raw["model"] === "string" ? { model: raw["model"] } : {}),
      ...(typeof raw["thinking_effort"] === "string"
        ? { thinkingEffort: raw["thinking_effort"] }
        : {}),
      ...(typeof raw["permission"] === "string" ? { permission: raw["permission"] } : {}),
      ...(typeof raw["plan_mode"] === "boolean" ? { planMode: raw["plan_mode"] } : {}),
      ...(typeof raw["swarm_mode"] === "boolean" ? { swarmMode: raw["swarm_mode"] } : {}),
      ...(typeof raw["goal_enabled"] === "boolean" ? { goalEnabled: raw["goal_enabled"] } : {}),
      ...(typeof raw["context_tokens"] === "number"
        ? { contextTokens: raw["context_tokens"] }
        : {}),
      ...(typeof raw["max_context_tokens"] === "number"
        ? { maxContextTokens: raw["max_context_tokens"] }
        : {}),
      ...(typeof raw["context_usage"] === "number"
        ? { contextUsage: raw["context_usage"] }
        : {}),
      ...(raw["usage"] !== undefined && raw["usage"] !== null
        ? { usage: raw["usage"] as Record<string, unknown> }
        : {}),
    } as SessionStatus;
  }

  async setModel(model: string): Promise<void> {
    await this.rpc.call(METHODS.SESSION_SET_MODEL, { session_id: this.id, model });
  }

  async setThinking(effort: string): Promise<void> {
    await this.rpc.call(METHODS.SESSION_SET_THINKING, {
      session_id: this.id,
      effort,
    });
  }

  async setPlanMode(enabled: boolean): Promise<void> {
    await this.rpc.call(METHODS.SESSION_SET_PLAN_MODE, { session_id: this.id, enabled });
  }

  async activateSkill(
    name: string,
    args: string | undefined,
  ): Promise<{ status: string }> {
    return (await this.rpc.call(METHODS.SESSION_ACTIVATE_SKILL, {
      session_id: this.id,
      name,
      ...(args === undefined ? {} : { args }),
    })) as { status: string };
  }

  async init(): Promise<void> {
    await this.rpc.call(METHODS.SESSION_INIT, { session_id: this.id });
  }

  async clearContext(): Promise<boolean> {
    const result = (await this.rpc.call(METHODS.SESSION_CLEAR_CONTEXT, {
      session_id: this.id,
    })) as { cleared?: boolean };
    return result.cleared === true;
  }

  async getPlan(): Promise<{ content?: string; path?: string } | undefined> {
    const result = (await this.rpc.call(METHODS.SESSION_GET_PLAN, {
      session_id: this.id,
    })) as { content?: string; path?: string } | null;
    return result === null || result === undefined ? undefined : result;
  }

  async clearPlan(): Promise<void> {
    await this.rpc.call(METHODS.SESSION_CLEAR_PLAN, { session_id: this.id });
  }

  async importContext(content: string, source: string): Promise<void> {
    await this.rpc.call(METHODS.SESSION_IMPORT_CONTEXT, {
      session_id: this.id,
      content,
      source,
    });
  }

  async addAdditionalDir(
    path: string,
    options?: { persist?: boolean },
  ): Promise<{ additionalDirs: readonly string[] }> {
    await this.rpc.call(METHODS.SESSION_ADD_DIR, {
      session_id: this.id,
      path,
      ...(options?.persist === undefined ? {} : { persist: options.persist }),
    });
    // Mirror into the host summary (node-sdk parity): the engine persists
    // the dir list on the agent but not on the `session/list` record, and
    // its canonical form may differ from what the caller added (Windows
    // 8.3 short names) — the host surface keeps the caller's verbatim path.
    const current = this.summary?.additionalDirs ?? [];
    const additionalDirs = current.includes(path) ? current : [...current, path];
    if (this.onSummaryUpdate !== undefined) {
      this.onSummaryUpdate(
        this.summary === undefined
          ? {
              id: this.id,
              workDir: "",
              createdAt: 0,
              updatedAt: 0,
              additionalDirs,
            }
          : { ...this.summary, additionalDirs },
      );
    }
    return { additionalDirs };
  }

  async getContext(): Promise<{ history: readonly ContextMessage[]; tokenCount?: number }> {
    const raw = (await this.rpc.call(METHODS.SESSION_GET_CONTEXT, {
      session_id: this.id,
    })) as Record<string, unknown> | null;
    if (raw === null || typeof raw !== "object") return { history: [], tokenCount: 0 };
    const history = Array.isArray(raw["history"])
      ? (raw["history"] as Record<string, unknown>[]).map(
          (entry) => mapContextMessage(entry) as unknown as ContextMessage,
        )
      : [];
    return {
      history,
      tokenCount: typeof raw["token_count"] === "number" ? raw["token_count"] : 0,
      ...(raw["additionalDirs"] !== undefined
        ? { additionalDirs: raw["additionalDirs"] as readonly string[] }
        : {}),
    };
  }

  async updateMetadata(metadata: Record<string, unknown>): Promise<void> {
    await this.rpc.call(METHODS.SESSION_UPDATE_METADATA, {
      session_id: this.id,
      metadata,
    });
  }

  async setPermission(mode: string): Promise<void> {
    await this.rpc.call(METHODS.PERMISSION_SET_MODE, { mode });
  }

  getResumeState(): LocalResumeState | undefined {
    return this.resumeState;
  }

  /** Attach the resume snapshot (harness resume path). */
  setResumeState(state: LocalResumeState): void {
    this.resumeState = state;
  }

  /** Build the resume state for a context snapshot (harness helper). */
  static resumeStateFromContext(
    sessionId: string,
    workDir: string | undefined,
    context: unknown,
    status: Record<string, unknown>,
  ): LocalResumeState {
    const replay = replayFromContext(context) as readonly AgentReplayRecord[];
    return {
      agents: {
        main: {
          ...(replay.length > 0 ? { replay } : {}),
          config: {
            ...(typeof status["model"] === "string" ? { modelAlias: status["model"] } : {}),
            ...(typeof status["thinking_effort"] === "string"
              ? { thinkingEffort: status["thinking_effort"] }
              : {}),
          },
          plan: null,
        },
      },
      sessionMetadata: {
        createdAt: String(Date.now()),
        updatedAt: String(Date.now()),
        title: sessionId,
        isCustomTitle: false,
        ...(workDir === undefined ? {} : { workDir }),
        custom: {},
        agents: { main: {} },
      },
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.listeners.clear();
  }

  private dispatch(raw: Record<string, unknown>): void {
    if (this.closed) return;
    const rawSessionId = typeof raw["session_id"] === "string" ? raw["session_id"] : "";
    if (rawSessionId.length === 0) return;
    const sessionId = rawSessionId.startsWith("btw-")
      ? rawSessionId.slice("btw-".length)
      : rawSessionId;
    if (sessionId !== this.id) return;
    const { session_id: _drop, ...payload } = raw;
    const event = { ...payload, sessionId, agentId: "main" } as unknown as EngineEvent;
    if (event.type === "session.approval.requested") {
      void this.handleApproval(event);
    }
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private async handleApproval(event: EngineEvent): Promise<void> {
    const handler = this.approvalHandler;
    if (handler === undefined) return;
    let decision: { decision: string; feedback?: string };
    try {
      decision = await handler(event as unknown as ApprovalRequest);
    } catch {
      decision = { decision: "cancelled", feedback: "Approval handler failed." };
    }
    const id = typeof event["approval_id"] === "string" ? event["approval_id"] : "";
    if (id.length === 0) return;
    const allow = decision.decision === "approved";
    const params: Record<string, unknown> = { id, decision: allow ? "allow" : "deny" };
    if (!allow && decision.feedback !== undefined) params["reason"] = decision.feedback;
    await this.rpc.call(METHODS.SESSION_APPROVAL_RESOLVE, params).catch(() => {
      // Best-effort: the engine store may have already resolved the entry.
    });
  }
}
