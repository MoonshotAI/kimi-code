/**
 * Per-live-session event/interaction wiring for the v2 client.
 *
 * One wiring instance per live session scope, created by `SDKRpcClientV2`
 * when a session materializes (create / resume / fork / reload) and disposed
 * when it closes. Two responsibilities:
 *
 * 1. Event forwarding: subscribe every live agent's `IEventBus` (the agents
 *   present at wiring time plus every later `onDidCreate`, so subagents that
 *   appear mid-turn are covered) and push each event through
 *   {@link translateDomainEvent} into the client's `receiveEvent` — the same
 *   synchronous, in-emission-order delivery v1's push model has (both engines
 *   dispatch to listeners inside the emitter's call stack).
 * 2. The approval / question / user-tool bridge: v1's engine calls the
 *   client's `requestApproval` / `requestQuestion` / `toolCall` callbacks
 *   (push), where v2 parks a pending interaction in the session's interaction
 *   kernel and waits for a response (pull). The bridge watches
 *   `onDidChangePending`, feeds each new pending interaction to the client
 *   callback — the base class's own public method, so the v1 semantics (the
 *   no-handler cancellation, the handler-failure error event) are inherited
 *   verbatim — and writes the outcome back through the typed session
 *   services. The kernel's `respond` no-ops on an id that is no longer
 *   pending, so a late answer after a turn cancellation is safe.
 */
import type {
  ApprovalRequest,
  ApprovalResponse,
  Event,
  QuestionRequest,
  QuestionResult,
  ToolCallRequest,
  ToolCallResponse,
  ToolInputDisplay,
} from '@moonshot-ai/agent-core';
import {
  IAgentLifecycleService,
  IAgentProfileService,
  IAgentTokenCountingService,
  IAgentUsageService,
  IEventBus,
  ISessionApprovalService,
  ISessionInteractionService,
  ISessionQuestionService,
  MAIN_AGENT_ID,
  type Event2,
  type IAgentScopeHandle,
  type IDisposable,
  type Interaction,
  type ISessionScopeHandle,
} from '@moonshot-ai/agent-core-v2';

import { translateDomainEvent } from '#/v2/event-mapper';

/**
 * The client surface the wiring drives — the base class's own public methods,
 * so the v1 handler semantics are reused rather than re-implemented.
 */
export interface SessionEventSink {
  receiveEvent(event: Event): void;
  requestApproval(
    request: ApprovalRequest & { sessionId: string; agentId: string },
  ): Promise<ApprovalResponse>;
  requestQuestion(
    request: QuestionRequest & { sessionId: string; agentId: string },
  ): Promise<QuestionResult>;
  toolCall(request: ToolCallRequest): Promise<ToolCallResponse>;
}

/**
 * The v2 approval payload (`agent-core-v2/src/session/approval/approval.ts` —
 * the package index exports only the service identifier, not the model). A
 * superset of v1's `ApprovalRequest`: the extra id/sessionId/agentId fields
 * are stripped when the handler is fed.
 */
interface ApprovalInteractionPayload {
  readonly id?: string;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly turnId?: number;
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly action: string;
  readonly display: ToolInputDisplay;
}

/** The v2 question payload (`agent-core-v2/src/session/question/question.ts`). */
interface QuestionInteractionPayload {
  readonly id?: string;
  readonly turnId?: number;
  readonly toolCallId?: string;
  readonly questions: QuestionRequest['questions'];
}

/** The v2 user-tool execution payload (`agent-core-v2/src/agent/userTool/userToolService.ts`). */
interface UserToolInteractionPayload {
  readonly turnId: number;
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
}

export class SessionEventWiring {
  private readonly disposables: IDisposable[] = [];
  private readonly agentSubscriptions = new Map<string, IDisposable>();
  /** Pending interactions already handed to the sink (the kernel re-fires the full pending set on every change). */
  private readonly bridgedInteractionIds = new Set<string>();
  private disposed = false;

  constructor(
    private readonly session: ISessionScopeHandle,
    private readonly sink: SessionEventSink,
  ) {
    const interactions = session.accessor.get(ISessionInteractionService);
    this.disposables.push(
      interactions.onDidChangePending(() => {
        this.bridgeNewPendingInteractions();
      }),
    );
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    this.disposables.push(
      lifecycle.onDidCreate((agent) => {
        this.attachAgent(agent);
      }),
      lifecycle.onDidDispose((agentId) => {
        this.detachAgent(agentId);
      }),
    );
    for (const agent of lifecycle.list()) {
      this.attachAgent(agent);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    for (const subscription of this.agentSubscriptions.values()) {
      subscription.dispose();
    }
    this.agentSubscriptions.clear();
  }

  private attachAgent(agent: IAgentScopeHandle): void {
    if (this.disposed || this.agentSubscriptions.has(agent.id)) return;
    const sessionId = this.session.id;
    const agentId = agent.id;
    this.agentSubscriptions.set(
      agentId,
      agent.accessor.get(IEventBus).subscribe((event) => {
        const enriched =
          event.type === 'agent.status.updated' ? withStatusSnapshot(agent, event) : event;
        const translated = translateDomainEvent(enriched, sessionId, agentId);
        if (translated !== undefined) this.sink.receiveEvent(translated);
      }),
    );
  }

  private detachAgent(agentId: string): void {
    const subscription = this.agentSubscriptions.get(agentId);
    if (subscription === undefined) return;
    this.agentSubscriptions.delete(agentId);
    subscription.dispose();
  }

  private bridgeNewPendingInteractions(): void {
    if (this.disposed) return;
    const pending = this.session.accessor.get(ISessionInteractionService).listPending();
    for (const interaction of pending) {
      if (this.bridgedInteractionIds.has(interaction.id)) continue;
      this.bridgedInteractionIds.add(interaction.id);
      switch (interaction.kind) {
        case 'approval':
          void this.bridgeApproval(interaction);
          break;
        case 'question':
          void this.bridgeQuestion(interaction);
          break;
        case 'user_tool':
          void this.bridgeUserTool(interaction);
          break;
      }
    }
  }

  /**
   * Feed a pending approval to the client's approval handler (through the
   * base-class `requestApproval`, which owns the no-handler cancellation and
   * the handler-failure error event) and decide the kernel request with the
   * outcome. The kernel notification fires synchronously at park time, so the
   * handler is invoked at the same relative moment as v1's push.
   */
  private async bridgeApproval(interaction: Interaction): Promise<void> {
    const payload = interaction.payload as ApprovalInteractionPayload;
    try {
      const response = await this.sink.requestApproval({
        turnId: payload.turnId,
        toolCallId: payload.toolCallId ?? interaction.id,
        toolName: payload.toolName,
        action: payload.action,
        display: payload.display,
        sessionId: this.session.id,
        agentId: payload.agentId ?? interaction.origin.agentId ?? MAIN_AGENT_ID,
      });
      this.session.accessor.get(ISessionApprovalService).decide(interaction.id, response);
    } catch {
      // The session scope died mid-bridge (close/reload): the parked engine
      // request died with it, and `respond` no-ops on an unknown id anyway.
    }
  }

  /**
   * Same bridge for a pending question: the base-class `requestQuestion`
   * answers `null` when no handler is registered or the handler failed —
   * mapped onto the kernel's dismiss, which is how both engines' ask-user
   * tool reads an unanswered question.
   */
  private async bridgeQuestion(interaction: Interaction): Promise<void> {
    const payload = interaction.payload as QuestionInteractionPayload;
    try {
      const result = await this.sink.requestQuestion({
        turnId: payload.turnId,
        toolCallId: payload.toolCallId,
        questions: payload.questions,
        sessionId: this.session.id,
        agentId: interaction.origin.agentId ?? MAIN_AGENT_ID,
      });
      const questions = this.session.accessor.get(ISessionQuestionService);
      if (result === null) {
        questions.dismiss(interaction.id);
      } else {
        questions.answer(interaction.id, result);
      }
    } catch {
      // See bridgeApproval.
    }
  }

  /**
   * Same bridge for a user-tool execution: v1 routes custom tool calls to the
   * client's `toolCall` callback (the base class answers "not supported" with
   * an error output); without this the v2 tool would wait forever.
   */
  private async bridgeUserTool(interaction: Interaction): Promise<void> {
    const payload = interaction.payload as UserToolInteractionPayload;
    try {
      const result = await this.sink.toolCall({
        turnId: payload.turnId,
        toolCallId: payload.toolCallId,
        args: payload.args,
      });
      this.session.accessor.get(ISessionInteractionService).respond(interaction.id, result);
    } catch {
      // See bridgeApproval.
    }
  }
}

/**
 * v2 emits agent status in independent slices (see `agent/usage/usageOps.ts`
 * in agent-core-v2), and the model slice rides only the bind-time emission —
 * for a subagent that reaches the client before `subagent.spawned` and is
 * dropped there, so subagent cards never learn the model. Fold a consistent
 * usage + context + model snapshot into every status event at this edge,
 * restoring the v1 combined-payload contract regardless of slice timing.
 * Mirrors kap-server's `readLegacyStatus` bridge; the v1 edge lives in the
 * two client-facing packages so the core engine stays free of v1
 * wire-compatibility concerns.
 */
function withStatusSnapshot(agent: IAgentScopeHandle, event: Event2<any>): Event2<any> {
  const profile = agent.accessor.get(IAgentProfileService) as IAgentProfileService | undefined;
  const usageService = agent.accessor.get(IAgentUsageService) as IAgentUsageService | undefined;
  const tokenCounting = agent.accessor.get(IAgentTokenCountingService) as
    | IAgentTokenCountingService
    | undefined;
  if (profile === undefined || usageService === undefined || tokenCounting === undefined) {
    return event;
  }
  // Externally reported context size, resolved by the `[token_counting]`
  // strategy inside the service (`IAgentTokenCountingService.statusSize`).
  const contextTokens = tokenCounting.statusSize();
  const capabilities = profile.getModelCapabilities();
  const maxContextTokens = capabilities.max_input_tokens ?? capabilities.max_context_tokens;
  return Object.assign({}, event, {
    usage: usageService.status(),
    contextTokens,
    maxContextTokens,
    model: profile.getModel(),
  }) as unknown as Event2<any>;
}
