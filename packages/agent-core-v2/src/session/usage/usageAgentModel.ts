import { z } from 'zod';

import type { AgentLLMRequestSource } from '#/agent/llmRequester/llmRequester';
import type { UsageStatus } from '#/agent/usage/usage';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import {
  copyUsage,
  UsageRecord,
  type UsageModelState,
  type UsageRecordScope,
} from '#/agent/usage/usageOps';
import { addUsage, type TokenUsage } from '#/kosong/contract/usage';
import { AgentModel, defineAgentModel, type AgentModelContext } from '#/state/agentModel';

export interface UsageRecordInput {
  readonly model: string;
  readonly usage: TokenUsage;
  readonly source?: AgentLLMRequestSource;
}

export class UsageAgentModel extends AgentModel<UsageModelState> {
  private currentTurnId: number | undefined;
  private currentTurn: TokenUsage | undefined;

  constructor(context: AgentModelContext) {
    super(context);
    this.on(UsageRecord, (event) => {
      const current = this.state.byModel[event.model];
      this.state.byModel[event.model] =
        current === undefined ? copyUsage(event.usage) : addUsage(current, event.usage);
    });
  }

  record(input: UsageRecordInput): Promise<boolean> {
    const firstRecord = Object.keys(this.state.byModel).length === 0;
    const usageScope: UsageRecordScope = input.source?.type === 'turn' ? 'turn' : 'session';
    const recorded = this.emit(
      new UsageRecord({
        agentId: this.agent.agentId,
        model: input.model,
        usage: input.usage,
        usageScope,
      }),
    );
    const turnId = input.source?.type === 'turn' ? input.source.turnId : undefined;
    if (turnId !== undefined) {
      if (this.currentTurnId !== turnId) {
        this.currentTurnId = turnId;
        this.currentTurn = copyUsage(input.usage);
      } else {
        this.currentTurn =
          this.currentTurn === undefined
            ? copyUsage(input.usage)
            : addUsage(this.currentTurn, input.usage);
      }
    }
    const notified = this.emit(
      new AgentStatusUpdated({ agentId: this.agent.agentId, usage: this.status() }),
    );
    return recorded.then(() => notified).then(() => firstRecord);
  }

  status(): UsageStatus {
    const byModel = Object.fromEntries(
      Object.entries(this.state.byModel).map(([model, usage]) => [model, copyUsage(usage)]),
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
}

export const UsageAgentModelDefinition = defineAgentModel({
  id: 'usage',
  model: UsageAgentModel,
  state: {
    initial: (): UsageModelState => ({ byModel: {} }),
    schema: z.custom<UsageModelState>(),
  },
  events: [UsageRecord],
});
