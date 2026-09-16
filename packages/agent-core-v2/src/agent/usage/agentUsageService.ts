import { Service } from '#/_base/di/service';
import { Emitter, type Event } from '#/_base/event';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { AgentLLMRequestSource } from '#/agent/llmRequester/llmRequester';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import type { UsageRecordedContext, UsageStatus } from '#/agent/usage/usage';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import {
  copyUsage,
  UsageRecord,
  usageKey,
  type UsageRecordScope,
} from '#/agent/usage/usageOps';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { addUsage, type TokenUsage } from '#human/llm/usage';

export class AgentUsageService extends Service implements ISessionUsageService {
  declare readonly _serviceBrand: undefined;

  private readonly onDidRecordEmitter = this._register(new Emitter<UsageRecordedContext>());
  readonly onDidRecord: Event<UsageRecordedContext> = this.onDidRecordEmitter.event;

  private currentTurnId: number | undefined;
  private currentTurn: TokenUsage | undefined;

  constructor(
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentStateService private readonly states: IAgentStateService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
  ) {
    super();
    this.states.contributeState(usageKey);
  }

  async record(
    agent: AgentContext,
    model: string,
    usage: TokenUsage,
    source?: AgentLLMRequestSource,
  ): Promise<void> {
    this.assertIssued(agent);
    const firstRecord = Object.keys(this.states.get(usageKey).byModel).length === 0;
    const usageScope: UsageRecordScope = source?.type === 'turn' ? 'turn' : 'session';
    const recorded = this.dispatcher.dispatch(
      new UsageRecord({ agentId: agent.agentId, model, usage, usageScope }),
    );
    const turnId = source?.type === 'turn' ? source.turnId : undefined;
    if (turnId !== undefined) {
      if (this.currentTurnId !== turnId) {
        this.currentTurnId = turnId;
        this.currentTurn = copyUsage(usage);
      } else {
        this.currentTurn =
          this.currentTurn === undefined ? copyUsage(usage) : addUsage(this.currentTurn, usage);
      }
    }
    const notified = this.dispatcher.dispatch(
      new AgentStatusUpdated({ agentId: agent.agentId, usage: this.statusOf() }),
    );
    await Promise.all([recorded, notified]);
    this.onDidRecordEmitter.fire({ agent, model, usage: copyUsage(usage), source, firstRecord });
  }

  status(agent: AgentContext): UsageStatus {
    this.assertIssued(agent);
    return this.statusOf();
  }

  private statusOf(): UsageStatus {
    const recorded = this.states.get(usageKey).byModel;
    const byModel = Object.fromEntries(
      Object.entries(recorded).map(([model, usage]) => [model, copyUsage(usage)]),
    );
    const hasByModel = Object.keys(byModel).length > 0;
    let total: TokenUsage | undefined;
    if (hasByModel) {
      for (const usage of Object.values(byModel)) {
        total = total === undefined ? copyUsage(usage) : addUsage(total, usage);
      }
    }
    return {
      byModel: hasByModel ? byModel : undefined,
      total,
      currentTurn: this.currentTurn === undefined ? undefined : copyUsage(this.currentTurn),
    };
  }

  private assertIssued(agent: AgentContext): void {
    if (agent !== this.scopeContext.agentContext) {
      throw new Error(
        `Agent ${agent.agentId}:${String(agent.generation)} is not a lifecycle-issued context`,
      );
    }
  }
}
