import { Disposable, IInstantiationService, InstantiationType, registerSingleton } from '../../di';
import { Emitter } from '../../base/common/event';
import type { Event, SessionStatus, SessionStatusResponse } from '@moonshot-ai/protocol';

import { IApprovalService } from '../approval/approval';
import { ICoreProcessService } from '../coreProcess/coreProcess';
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
    @ICoreProcessService private readonly core: ICoreProcessService,
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
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }

    const [config, context, permission, plan] = await Promise.all([
      this.core.rpc.getConfig({ sessionId: id, agentId: 'main' }),
      this.core.rpc.getContext({ sessionId: id, agentId: 'main' }),
      this.core.rpc.getPermission({ sessionId: id, agentId: 'main' }),
      this.core.rpc.getPlan({ sessionId: id, agentId: 'main' }),
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
