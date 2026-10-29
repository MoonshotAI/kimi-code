import { Service } from '#/_base/di/service';
import { Emitter, type Event } from '#/_base/event';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { agentSpaceOf } from '#/agent/agentContext/agentSpace';
import type { AgentLLMRequestSource } from '#/agent/loop/requesterContract';
import type { UsageRecordedContext, UsageStatus } from '#/agent/usage/usage';
import { copyUsage } from '#/agent/usage/usageOps';
import { emptyUsage, type TokenUsage } from '#human/llm-requester/usage';

import { ISessionUsageService } from './sessionUsage';
import { UsageAgentModelDefinition } from './usageAgentModel';

export class SessionUsageService extends Service implements ISessionUsageService {
  declare readonly _serviceBrand: undefined;

  private readonly onDidRecordEmitter = this._register(new Emitter<UsageRecordedContext>());
  readonly onDidRecord: Event<UsageRecordedContext> = this.onDidRecordEmitter.event;

  async record(
    agent: AgentContext,
    model: string,
    usage: TokenUsage | undefined,
    source?: AgentLLMRequestSource,
  ): Promise<void> {
    const recordedUsage = usage ?? emptyUsage();
    const firstRecord = await agentSpaceOf(agent).use(UsageAgentModelDefinition, (m) =>
      m.record({ model, usage: recordedUsage, source }),
    );
    this.onDidRecordEmitter.fire({
      agent,
      model,
      usage: copyUsage(recordedUsage),
      usageReported: usage !== undefined,
      source,
      firstRecord,
    });
  }

  status(agent: AgentContext): UsageStatus {
    return agentSpaceOf(agent).use(UsageAgentModelDefinition, (m) => m.status());
  }
}
