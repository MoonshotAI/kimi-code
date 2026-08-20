import { Service } from '#/_base/di/service';
import { Emitter, type Event } from '#/_base/event';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { agentSpaceOf } from '#/agent/agentContext/agentSpace';
import type { AgentLLMRequestSource } from '#/agent/llmRequester/llmRequester';
import type { UsageRecordedContext, UsageStatus } from '#/agent/usage/usage';
import { copyUsage } from '#/agent/usage/usageOps';
import type { TokenUsage } from '#/kosong/contract/usage';

import { ISessionUsageService } from './sessionUsage';
import { UsageAgentModelDefinition } from './usageAgentModel';

export class SessionUsageService extends Service implements ISessionUsageService {
  declare readonly _serviceBrand: undefined;

  private readonly onDidRecordEmitter = this._register(new Emitter<UsageRecordedContext>());
  readonly onDidRecord: Event<UsageRecordedContext> = this.onDidRecordEmitter.event;

  async record(
    agent: AgentContext,
    model: string,
    usage: TokenUsage,
    source?: AgentLLMRequestSource,
  ): Promise<void> {
    const firstRecord = await agentSpaceOf(agent).use(UsageAgentModelDefinition, (m) =>
      m.record({ model, usage, source }),
    );
    this.onDidRecordEmitter.fire({ agent, model, usage: copyUsage(usage), source, firstRecord });
  }

  status(agent: AgentContext): UsageStatus {
    return agentSpaceOf(agent).use(UsageAgentModelDefinition, (m) => m.status());
  }
}
