import { Disposable, IInstantiationService, InstantiationType, registerSingleton } from '../../_base/di';
import { Emitter } from '../../_base/event';
import type { Event, SessionStatus, SessionStatusResponse } from '@moonshot-ai/protocol';
import type { CoreRPC } from '../../rpc';

import { IApprovalService } from '#/approval';
import { ICoreRuntime } from '../coreProcess/coreProcess';
import { IEventService } from '../event/event';
import { IPromptService } from '../prompt/prompt';
import { IQuestionService } from '../question/question';
import {
  ISessionRuntimeService,
  SessionNotFoundError,
  type SessionLiveState,
  type SessionStatusChanged,
} from './session';
import { applySessionTurnEvent, computeSessionStatus } from './sessionStatus';

/**
 * Narrow in-process CoreAPI accessor supplied by the concrete
 * `CoreProcessService` (the sole production `ICoreRuntime`). Routed
 * through a structural cast so the public `ICoreRuntime` facade — and
 * the many test doubles that implement it across the suite — stay unchanged.
 * The daemon-side adapter always provides `getCoreApi()`; see
 * `CoreProcessService.getCoreApi` for the zero-serialization rationale.
 */
type InProcessCoreApi = { getCoreApi(): CoreRPC };

/**
 * Runtime facade for sessions (runtime role).
 *
 * Owns the live status projection: it subscribes to the global
 * `IEventService` stream (the same bus `SessionService` and
 * `SessionQueryService` consume) to keep per-session turn-tracking sets, and
 * recomputes status via the shared `computeSessionStatus` helper. Status is a
 * projection, not truth — nothing here is written back to the store.
 *
 * `event.session.status_changed` is still published on every real status
 * transition with the same type, payload, and timing as before, so downstream
 * consumers (the WS broadcast, the SDK) are unaffected.
 */
export class SessionRuntimeService extends Disposable implements ISessionRuntimeService {
  readonly _serviceBrand: undefined;

  private readonly _onDidChangeStatus = this._register(new Emitter<SessionStatusChanged>());
  readonly onDidChangeStatus = this._onDidChangeStatus.event;

  private readonly _statusBySession = new Map<string, SessionStatus>();
  private readonly _activeTurns = new Set<string>();
  private readonly _abortedTurns = new Set<string>();
  private _promptService: IPromptService | undefined;

  constructor(
    @ICoreRuntime private readonly core: ICoreRuntime,
    @IEventService private readonly eventService: IEventService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IApprovalService private readonly approvalService: IApprovalService,
    @IQuestionService private readonly questionService: IQuestionService,
  ) {
    super();
    this._register(
      this.eventService.onDidPublish((event) => {
        this.handleBusEvent(event);
      }),
    );
  }

  private get promptService(): IPromptService {
    return (this._promptService ??= this.instantiation.invokeFunction((a) => a.get(IPromptService)));
  }

  /**
   * In-process CoreAPI handle — the same methods as `this.core.rpc` but
   * dispatched directly on the in-process `KimiCore`, skipping the
   * `createRPC` JSON serialize/deserialize hop. Method signatures and return
   * shapes are identical to the `rpc` proxy; only the serialization is
   * removed. The cast is localized here so every call site below reads
   * `this.coreApi().<method>(...)`.
   */
  private coreApi(): CoreRPC {
    return (this.core as unknown as InProcessCoreApi).getCoreApi();
  }

  private computeStatus(sessionId: string): SessionStatus {
    return computeSessionStatus({
      awaitingApproval: this.approvalService.listPending(sessionId).length > 0,
      awaitingQuestion: this.questionService.listPending(sessionId).length > 0,
      hasActivePrompt: this.promptService.getCurrentPromptId(sessionId) !== undefined,
      hasActiveTurn: this._activeTurns.has(sessionId),
      wasAborted: this._abortedTurns.has(sessionId),
    });
  }

  private emitStatusChanged(sessionId: string): void {
    const previous = this._statusBySession.get(sessionId) ?? 'idle';
    const next = this.computeStatus(sessionId);
    if (previous === next) return;

    this._statusBySession.set(sessionId, next);
    const currentPromptId = this.promptService.getCurrentPromptId(sessionId);
    this._onDidChangeStatus.fire({
      sessionId,
      status: next,
      previousStatus: previous,
      ...(currentPromptId !== undefined ? { currentPromptId } : {}),
    });
    this.eventService.publish({
      type: 'event.session.status_changed',
      agentId: 'main',
      sessionId,
      status: next,
      previous_status: previous,
      current_prompt_id: currentPromptId,
    } as unknown as Event);
  }

  private handleBusEvent(event: Event): void {
    const type = (event as { type?: string }).type;
    const sessionId = (event as { sessionId?: string }).sessionId;
    if (sessionId === undefined || sessionId === '' || type === undefined) return;

    applySessionTurnEvent(
      { activeTurns: this._activeTurns, abortedTurns: this._abortedTurns },
      event,
    );

    switch (type) {
      case 'turn.started':
      case 'turn.ended':
      case 'prompt.submitted':
      case 'prompt.completed':
      case 'prompt.aborted':
      case 'event.approval.requested':
      case 'event.approval.resolved':
      case 'event.approval.expired':
      case 'event.question.requested':
      case 'event.question.answered':
      case 'event.question.dismissed':
      case 'event.question.expired': {
        this.emitStatusChanged(sessionId);
        break;
      }
    }
  }

  async getStatus(id: string): Promise<SessionStatusResponse> {
    const all = await this.coreApi().listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }

    const [config, context, permission, plan] = await Promise.all([
      this.coreApi().getConfig({ sessionId: id, agentId: 'main' }),
      this.coreApi().getContext({ sessionId: id, agentId: 'main' }),
      this.coreApi().getPermission({ sessionId: id, agentId: 'main' }),
      this.coreApi().getPlan({ sessionId: id, agentId: 'main' }),
    ]);

    const maxContextTokens = config.modelCapabilities?.max_context_tokens ?? 0;
    const contextTokens = context.tokenCount;
    const contextUsage = maxContextTokens > 0 ? contextTokens / maxContextTokens : 0;

    const agentState = this.promptService.getAgentStateSnapshot(id);

    return {
      status: this.computeStatus(id),
      model: config.modelAlias ?? config.provider?.model,
      thinking_level: config.thinkingLevel,
      permission: permission.mode,
      plan_mode: plan !== null,
      swarm_mode: agentState?.swarmMode ?? false,
      context_tokens: contextTokens,
      max_context_tokens: maxContextTokens,
      context_usage: contextUsage,
    };
  }

  async getLiveState(id: string): Promise<SessionLiveState> {
    const snapshot = this.promptService.getAgentStateSnapshot(id);
    if (snapshot === undefined) {
      return { live: false };
    }
    return { live: true, agentState: snapshot };
  }
}

registerSingleton(ISessionRuntimeService, SessionRuntimeService, InstantiationType.Delayed);
