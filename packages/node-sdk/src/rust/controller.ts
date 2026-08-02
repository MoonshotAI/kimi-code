/**
 * Rust engine session controller — the reusable core that drives a
 * session-owned engine and renders through a host's event/approval sinks.
 *
 * This is the integration seam a thin-client host (the TUI, a headless
 * runner) plugs into: it owns the engine `SessionClient` (from
 * `@moonshot-ai/kimi-agent/rust-loop`), translates the engine's wire events
 * onto the SDK `Event` union via {@link SessionEventTranslator}, and bridges
 * the engine's tool-approval gate onto a host-supplied yes/no prompt. The
 * host stays ignorant of the engine wire protocol — it supplies two sinks
 * (emit an SDK event, ask for approval) and calls `prompt` / `cancel`.
 *
 * Dependency-injected on purpose: the `createClient` factory is the real
 * `rustLoop.createSessionClient` in production and a fake in tests, so the
 * whole control/event/approval flow is verifiable without a live engine.
 *
 * Promoted from `apps/kimi-code/src/cli/session-engine-controller.ts` so the
 * SDK owns the engine-facing layer (2026-08-02).
 */
import type { Event } from '#/events';

import { SessionEventTranslator } from './event-translate';

/** The engine tool-approval request the host is asked to decide on. */
export interface ToolApprovalRequest {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly args: unknown;
}

/** Engine tool-lifecycle authorize response (subset the controller emits). */
interface AuthorizeToolDecision {
  block: boolean;
  reason?: string;
  resolved: boolean;
}

/** Options passed to the injected client factory. */
export interface SessionClientFactoryOptions {
  sessionId?: string;
  systemPrompt?: string;
  model?: string;
  goalEnabled?: boolean;
  homedir?: string;
  nativeLlm?: unknown;
  /** Native permission mode for the session gate ('manual' | 'auto' | 'yolo'). */
  permissionMode?: 'manual' | 'auto' | 'yolo';
  onEvent?: (event: unknown) => void;
  lifecycle?: {
    authorizeTool?: (req: unknown) => Promise<AuthorizeToolDecision>;
  };
}

/** The engine session handle the factory returns (structural subset). */
export interface SessionClientHandle {
  readonly sessionId: string;
  prompt(
    text: string,
    agentId?: string,
  ): Promise<{ stop_reason: string; steps: number; usage: { total_tokens: number } } | null>;
  cancel(): Promise<boolean>;
  save(): Promise<boolean>;
  load(): Promise<boolean>;
  startBtw?(): Promise<string | null>;
  endBtw?(): Promise<boolean>;
}

export type SessionClientFactory = (
  options: SessionClientFactoryOptions,
) => Promise<SessionClientHandle | null>;

export interface SessionEngineControllerOptions {
  /** Real: `rustLoop.createSessionClient`. */
  readonly createClient: SessionClientFactory;
  /** Push a translated SDK event into the host renderer. */
  readonly emitEvent: (event: Event) => void;
  /**
   * Optional tap on the raw engine wire event, fired before translation for
   * every event (including ones the translator drops, e.g.
   * `session.goal.updated`). Lets a host observe engine-only signals the SDK
   * `Event` union does not model yet.
   */
  readonly onRawEvent?: (event: unknown) => void;
  /**
   * Ask the host to approve a tool call. Resolves true to allow, false to
   * deny. When omitted, tools are auto-allowed (permission `auto`).
   */
  readonly requestApproval?: (request: ToolApprovalRequest) => Promise<boolean>;
  readonly agentId?: string;
}

export interface SessionEngineStartOptions {
  readonly sessionId: string;
  readonly systemPrompt?: string;
  readonly model?: string;
  readonly goalEnabled?: boolean;
  readonly homedir?: string;
  readonly nativeLlm?: unknown;
  /**
   * Native permission mode for the session gate. `auto`/`yolo` approve gated
   * tools locally (no host authorize round-trip); `manual` keeps interactive
   * approval on the host via `requestApproval`.
   */
  readonly permissionMode?: 'manual' | 'auto' | 'yolo';
}

export interface SessionPromptOutcome {
  readonly stopReason: string;
  readonly steps: number;
  readonly totalTokens: number;
}

export class SessionEngineController {
  private client: SessionClientHandle | null = null;
  private translator: SessionEventTranslator | undefined;

  constructor(private readonly options: SessionEngineControllerOptions) {}

  /**
   * Create the engine session and wire the event/approval sinks. Returns
   * false when the engine is unavailable (the factory returned null); the
   * host then falls back to its normal path.
   */
  async start(init: SessionEngineStartOptions): Promise<boolean> {
    const translator = new SessionEventTranslator(init.sessionId, this.options.agentId ?? 'main');
    this.translator = translator;
    this.client = await this.options.createClient({
      sessionId: init.sessionId,
      systemPrompt: init.systemPrompt,
      model: init.model,
      goalEnabled: init.goalEnabled,
      homedir: init.homedir,
      nativeLlm: init.nativeLlm,
      permissionMode: init.permissionMode,
      onEvent: (raw) => {
        this.options.onRawEvent?.(raw);
        const translated = translator.translate(raw);
        if (translated !== null) this.options.emitEvent(translated);
      },
      lifecycle: {
        authorizeTool: (raw) => this.authorize(raw),
      },
    });
    return this.client !== null;
  }

  private async authorize(raw: unknown): Promise<AuthorizeToolDecision> {
    // No host approver → permission `auto`: the decision is final (resolved),
    // so the engine gate does not fall back to host execution.
    if (this.options.requestApproval === undefined) {
      return { block: false, resolved: true };
    }
    const req = raw as { tool_name?: string; tool_call_id?: string; arguments?: unknown };
    // Fail closed: a throwing/cancelled approval prompt must deny, never
    // propagate into the engine's lifecycle RPC (which would hang or abort the
    // turn). This keeps the interactive seam safe when the host approver errors.
    let allowed: boolean;
    try {
      allowed = await this.options.requestApproval({
        toolName: req.tool_name ?? '',
        toolCallId: req.tool_call_id ?? '',
        args: req.arguments,
      });
    } catch {
      return { block: true, reason: 'Approval was cancelled', resolved: true };
    }
    return allowed
      ? { block: false, resolved: true }
      : { block: true, reason: 'Denied by the user', resolved: true };
  }

  get sessionId(): string | undefined {
    return this.client?.sessionId;
  }

  get isStarted(): boolean {
    return this.client !== null;
  }

  /** Run one prompt; goal continuations run inside the engine. */
  async prompt(text: string, agentId?: string): Promise<SessionPromptOutcome | null> {
    if (this.client === null) return null;
    // Events for a side-agent turn arrive in-band during its prompt RPC but
    // carry no agent id on the wire; stamp them with the driving agent id
    // for the duration of the call, then restore the main-agent stamp.
    let previousAgentId: string | undefined;
    if (this.translator !== undefined && agentId !== undefined) {
      previousAgentId = this.translator.setAgentId(agentId);
    }
    try {
      const result = await this.client.prompt(text, agentId);
      if (result === null) return null;
      return {
        stopReason: result.stop_reason,
        steps: result.steps,
        totalTokens: result.usage.total_tokens,
      };
    } finally {
      if (previousAgentId !== undefined) {
        this.translator?.setAgentId(previousAgentId);
      }
    }
  }

  /** Spawn a side-question ("between turns") subagent; returns its id. */
  async startBtw(): Promise<string | null> {
    return (await this.client?.startBtw?.()) ?? null;
  }

  /** Destroy the active side-question subagent. */
  async endBtw(): Promise<boolean> {
    return (await this.client?.endBtw?.()) ?? false;
  }

  /** Stop the running prompt at the next step boundary. */
  async cancel(): Promise<boolean> {
    return (await this.client?.cancel()) ?? false;
  }

  /** Persist context + goal. */
  async save(): Promise<boolean> {
    return (await this.client?.save()) ?? false;
  }

  /** Restore persisted context + goal (an active goal comes back paused). */
  async load(): Promise<boolean> {
    return (await this.client?.load()) ?? false;
  }
}
