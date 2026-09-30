import {
  AgentModelRef,
  MAIN_AGENT_ID,
  type AgentEmitted,
  type AgentHandle,
  type LlmErrorMessage,
  type SessionRecord,
  type TokenUsage,
  type TurnFailure,
} from "@moonshot-ai/agent-core";
import { watch } from "@moonshot-ai/agent-core/kernel/index";
import { PlanRef, TokenCountingRef } from "@moonshot-ai/harness-core";
import type { KimiSession } from "@moonshot-ai/kimi-code-sdk";

import type { Event } from "./event-adapter";
import { deriveToolDisplay } from "./tool-display";

export interface SessionEventSourceOptions {
  readonly session: KimiSession;
  readonly workDir: string;
  readonly maxContextTokens: () => number | undefined;
  readonly emit: (event: Event) => void;
  readonly onSessionMeta: (meta: SessionRecord) => void;
  readonly onMainRebound: (main: AgentHandle) => void;
  readonly log: (message: string, error?: unknown) => void;
}

export class SessionEventSource {
  private readonly session: KimiSession;
  private readonly workDir: string;
  private readonly maxContextTokens: () => number | undefined;
  private readonly emit: (event: Event) => void;
  private readonly onSessionMeta: (meta: SessionRecord) => void;
  private readonly onMainRebound: (main: AgentHandle) => void;
  private readonly log: (message: string, error?: unknown) => void;

  private main: AgentHandle;
  private offs: Array<() => void> = [];
  private mainOffs: Array<() => void> = [];
  private readonly childOffs = new Map<string, Array<() => void>>();
  private readonly turnUsage = new Map<string, TokenUsage>();
  private closed = false;

  constructor(options: SessionEventSourceOptions) {
    this.session = options.session;
    this.workDir = options.workDir;
    this.maxContextTokens = options.maxContextTokens;
    this.emit = options.emit;
    this.onSessionMeta = options.onSessionMeta;
    this.onMainRebound = options.onMainRebound;
    this.log = options.log;
    this.main = options.session.main;
  }

  start(): void {
    this.bindMain(this.main);
    const handle = this.session.handle;
    this.offs.push(
      handle.on("session.meta_updated", (event) => {
        if (this.closed) return;
        const patch = event["meta"];
        if (typeof patch !== "object" || patch === null) return;
        if (Object.keys(patch as Record<string, unknown>).every((key) => key === "lastTurn")) {
          return;
        }
        const meta = this.session.handle.stores.session.getState().sessionMeta.value as
          | SessionRecord
          | undefined;
        if (meta !== undefined) this.onSessionMeta(meta);
      }),
      handle.on("compaction.started", (event) => {
        if (this.closed) return;
        const agentId = typeof event["agentId"] === "string" ? event["agentId"] : MAIN_AGENT_ID;
        this.emit({
          type: "compaction.started",
          sessionId: this.session.id,
          agentId,
        });
      }),
      handle.on("compaction.completed", (event) => {
        if (this.closed) return;
        const agentId = typeof event["agentId"] === "string" ? event["agentId"] : MAIN_AGENT_ID;
        if (agentId === MAIN_AGENT_ID) void this.remountMain();
        this.emit({ type: "compaction.completed", sessionId: this.session.id, agentId });
      }),
      handle.on("compaction.cancelled", (event) => {
        if (this.closed) return;
        const agentId = typeof event["agentId"] === "string" ? event["agentId"] : MAIN_AGENT_ID;
        this.emit({ type: "compaction.cancelled", sessionId: this.session.id, agentId });
      }),
    );
    this.offs.push(
      handle.on("agent.opened", (event) => {
        if (this.closed) return;
        const agentId = event["agentId"];
        if (typeof agentId !== "string") return;
        if (agentId === MAIN_AGENT_ID) {
          if (event["reopened"] === true) this.rebindMain();
          return;
        }
        this.attachChild(agentId);
      }),
      handle.on("agent.closed", (event) => {
        const agentId = event["agentId"];
        if (typeof agentId !== "string") return;
        this.detachChild(agentId);
      }),
    );
    for (const agentId of this.knownChildAgentIds()) {
      const agent = handle.get(agentId);
      if (agent !== undefined) this.attachChild(agentId);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const off of this.mainOffs) off();
    this.mainOffs = [];
    for (const off of this.offs) off();
    this.offs = [];
    for (const offs of this.childOffs.values()) {
      for (const off of offs) off();
    }
    this.childOffs.clear();
  }

  private knownChildAgentIds(): string[] {
    const roster = this.session.handle.stores.session.getState().roster;
    return Object.keys(roster.agents).filter((agentId) => agentId !== MAIN_AGENT_ID);
  }

  private async remountMain(): Promise<void> {
    try {
      if (this.session.handle.get(MAIN_AGENT_ID) !== undefined) {
        await this.session.handle.close(MAIN_AGENT_ID);
      }
      await this.session.handle.create({ agentId: MAIN_AGENT_ID });
    } catch (error) {
      this.log("Failed to resume the main agent after compaction", error);
    }
  }

  private rebindMain(): void {
    if (this.closed) return;
    const next = this.session.handle.get(MAIN_AGENT_ID);
    if (next === undefined || next === this.main) return;
    for (const off of this.mainOffs) off();
    this.mainOffs = [];
    this.main = next;
    this.bindMain(next);
    this.onMainRebound(next);
  }

  private bindMain(agent: AgentHandle): void {
    this.bindAgentEvents(agent, this.mainOffs);
    this.mainOffs.push(...this.watchMainFacades(agent));
  }

  private attachChild(agentId: string): void {
    if (this.childOffs.has(agentId)) return;
    const agent = this.session.handle.get(agentId);
    if (agent === undefined) return;
    const offs: Array<() => void> = [];
    this.childOffs.set(agentId, offs);
    this.bindAgentEvents(agent, offs);
  }

  private detachChild(agentId: string): void {
    const offs = this.childOffs.get(agentId);
    if (offs === undefined) return;
    this.childOffs.delete(agentId);
    for (const off of offs) off();
  }

  private bindAgentEvents(agent: AgentHandle, offs: Array<() => void>): void {
    const agentId = agent.agentId;
    const sessionId = this.session.id;
    const use = (subscription: { unsubscribe(): void }): void => {
      offs.push(() => subscription.unsubscribe());
    };

    use(agent.on("turn.started", (event) => {
      this.turnUsage.delete(agentId);
      this.emit({
        type: "turn.started",
        sessionId,
        agentId,
        turnId: event.turnId,
        origin: event.entry?.meta?.origin,
      });
    }));

    use(agent.on("step.started", (event) => {
      this.emit({ type: "turn.step.started", sessionId, agentId, step: event.step });
    }));

    use(agent.on("llm.streaming.part", (event) => {
      const part = event.part;
      if (part.type === "text") {
        this.emit({ type: "assistant.delta", sessionId, agentId, delta: part.text });
        return;
      }
      if (part.type === "think") {
        this.emit({ type: "thinking.delta", sessionId, agentId, delta: part.think });
      }
    }));

    use(agent.on("llm.streaming.usage", (event) => {
      const accumulated = addUsage(this.turnUsage.get(agentId), event.usage);
      this.turnUsage.set(agentId, accumulated);
      this.emit({
        type: "agent.status.updated",
        sessionId,
        agentId,
        usage: { currentTurn: accumulated },
      });
    }));

    use(agent.on("llm.retrying", (event) => {
      if (event.reason !== "backoff") return;
      this.log(
        `Provider retry ${event.nextAttempt}/${event.maxAttempts} in ${event.delayMs}ms`,
        new Error(event.error.message),
      );
      this.emit({
        type: "turn.step.retrying",
        sessionId,
        agentId,
        nextAttempt: event.nextAttempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorMessage: event.error.message,
      });
    }));

    use(agent.on("turn.spawn_tools", (event) => {
      for (const call of event.toolCalls) {
        const args = parseToolArguments(call.arguments);
        this.emit({
          type: "tool.call.started",
          sessionId,
          agentId,
          toolCallId: call.id,
          name: call.name,
          args,
          display: deriveToolDisplay(call.name, args),
        });
        const denied = event.decisions?.[call.id];
        if (denied?.type === "denied") {
          this.emit({
            type: "tool.result",
            sessionId,
            agentId,
            toolCallId: call.id,
            output: denied.result.content,
            isError: true,
          });
        }
      }
    }));

    use(agent.on("tool.update", (event) => {
      if (event.update.key !== "subagent") return;
      const parentAgentId = agentId;
      const childAgentId = event.update.text;
      this.attachChild(childAgentId);
      this.emit({
        type: "subagent.spawned",
        sessionId,
        agentId: parentAgentId,
        subagentId: childAgentId,
        subagentName: this.subagentName(childAgentId) ?? childAgentId,
        parentToolCallId: event.toolCallId,
        parentAgentId,
        runInBackground: false,
      });
    }));

    use(agent.on("tool.done", (event) => {
      const outcome = event.outcome;
      if (outcome.type === "succeeded") {
        this.emit({
          type: "tool.result",
          sessionId,
          agentId,
          toolCallId: event.toolCallId,
          output: outcome.result.content,
          isError: outcome.result.isError === true ? true : undefined,
        });
        return;
      }
      this.emit({
        type: "tool.result",
        sessionId,
        agentId,
        toolCallId: event.toolCallId,
        output:
          outcome.type === "failed"
            ? errorText(outcome.error)
            : `[async tool aborted]${outcome.reason === undefined ? "" : ` ${errorText(outcome.reason)}`}`,
        isError: true,
      });
    }));

    use(agent.on("turn.done", (event) => {
      this.turnUsage.delete(agentId);
      this.emit({
        type: "turn.ended",
        sessionId,
        agentId,
        turnId: event.turnId,
        reason: turnEndReason(event.outcome),
        error: turnEndError(event.outcome),
      });
    }));

    use(agent.on("prompt.blocked", (event) => {
      this.emit({
        type: "error",
        sessionId,
        agentId,
        code: "turn.blocked",
        message:
          event.reason === "gate"
            ? "Turn stopped: the prompt was blocked."
            : `Turn failed before it started: ${errorText(event.error ?? "unknown error")}`,
        retryable: false,
      });
    }));

    use(agent.on("agent.failed", (event) => {
      const error = event.error;
      this.emit({
        type: "error",
        sessionId,
        agentId,
        code: isLlmErrorMessage(error) ? llmErrorCode(error) : "internal",
        message: isLlmErrorMessage(error) ? error.message : errorText(error),
        retryable: false,
      });
    }));
  }

  private watchMainFacades(agent: AgentHandle): Array<() => void> {
    const offs: Array<() => void> = [];
    const sessionId = this.session.id;
    const model = agent.resolve(AgentModelRef);
    if (model !== undefined) {
      offs.push(
        watch(model.current, (current) => {
          this.emit({
            type: "agent.status.updated",
            sessionId,
            agentId: MAIN_AGENT_ID,
            model: current.alias ?? undefined,
            thinkingEffort: current.thinking ?? undefined,
          });
        }),
      );
    }
    const plan = agent.resolve(PlanRef);
    if (plan !== undefined) {
      offs.push(
        watch(plan.state, (state) => {
          this.emit({
            type: "agent.status.updated",
            sessionId,
            agentId: MAIN_AGENT_ID,
            planMode: state.active,
          });
        }),
      );
    }
    const tokenCounting = agent.resolve(TokenCountingRef);
    if (tokenCounting !== undefined) {
      offs.push(
        watch(tokenCounting.status, (status) => {
          this.emit({
            type: "agent.status.updated",
            sessionId,
            agentId: MAIN_AGENT_ID,
            contextTokens: status,
            maxContextTokens: this.maxContextTokens(),
          });
        }),
      );
    }
    return offs;
  }

  private subagentName(agentId: string): string | undefined {
    const source = this.session.handle.stores.session.getState().roster.agents[agentId]?.source;
    if (source === undefined) return undefined;
    if (source === "session-init") return "coder";
    const match = /^spawn:[^:]+:(.+)$/.exec(source);
    return match?.[1];
  }
}

function parseToolArguments(raw: string | null): unknown {
  if (raw === null || raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

function addUsage(current: TokenUsage | undefined, usage: Partial<TokenUsage>): TokenUsage {
  return {
    inputOther: (current?.inputOther ?? 0) + (usage.inputOther ?? 0),
    output: (current?.output ?? 0) + (usage.output ?? 0),
    inputCacheRead: (current?.inputCacheRead ?? 0) + (usage.inputCacheRead ?? 0),
    inputCacheCreation: (current?.inputCacheCreation ?? 0) + (usage.inputCacheCreation ?? 0),
  };
}

function turnEndReason(outcome: { type: string }): "completed" | "cancelled" | "failed" {
  if (outcome.type === "done") return "completed";
  if (outcome.type === "aborted") return "cancelled";
  return "failed";
}

function turnEndError(
  outcome: Extract<AgentEmitted, { type: "turn.done" }>["outcome"],
): { code: string; message: string; retryable: boolean } | undefined {
  if (outcome.type !== "failed") return undefined;
  const failure: TurnFailure = outcome.failure;
  if (failure.reason === "max_steps") {
    return { code: "turn.max_steps", message: failure.message, retryable: false };
  }
  const error = failure.error;
  if (isLlmErrorMessage(error)) {
    return { code: llmErrorCode(error), message: error.message, retryable: isRetryable(error) };
  }
  return { code: "internal", message: errorText(error ?? "unknown error"), retryable: false };
}

function isLlmErrorMessage(error: unknown): error is LlmErrorMessage {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { kind?: unknown; message?: unknown };
  return typeof record.kind === "string" && typeof record.message === "string";
}

function llmErrorCode(error: LlmErrorMessage): string {
  switch (error.kind) {
    case "connection":
    case "timeout":
      return "provider.connection_error";
    case "auth":
      return "provider.auth_error";
    case "rate_limit":
    case "quota_exhausted":
    case "overloaded":
      return "provider.rate_limit";
    case "status":
    case "provider":
    case "context_overflow":
    case "request_too_large":
    case "request_structure":
    case "image_format":
    case "empty_response":
      return "provider.api_error";
    default:
      return "internal";
  }
}

function isRetryable(error: LlmErrorMessage): boolean {
  return (
    error.kind === "rate_limit" ||
    error.kind === "overloaded" ||
    error.kind === "timeout" ||
    error.kind === "connection"
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
