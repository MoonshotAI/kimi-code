import { Service } from '#/_base/di/service';
import { Emitter, type Event } from '#/_base/event';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { AgentLLMRequestSource } from '#/features/llmRequester/llmRequester';
import type { UsageRecordedContext, UsageStatus } from '#/agent/usage/usage';
import {
  AgentUsage,
  type UsageRuntime,
} from '#/features/usage/usageAgentRuntime';
import { copyUsage } from '#/features/usage/usageOps';
import type { TokenUsage } from '#/kosong/contract/usage';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import { ISessionUsageService } from './sessionUsage';

export class SessionUsageService extends Service implements ISessionUsageService {
  declare readonly _serviceBrand: undefined;

  private readonly onDidRecordEmitter = this._register(new Emitter<UsageRecordedContext>());
  readonly onDidRecord: Event<UsageRecordedContext> = this.onDidRecordEmitter.event;

  constructor(
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
  ) {
    super();
  }

  async record(
    agent: AgentContext,
    model: string,
    usage: TokenUsage,
    source?: AgentLLMRequestSource,
  ): Promise<void> {
    const firstRecord = await this.runtime(agent).recordTurn({ model, usage, source });
    this.onDidRecordEmitter.fire({ agent, model, usage: copyUsage(usage), source, firstRecord });
  }

  status(agent: AgentContext): UsageStatus {
    return this.runtime(agent).status();
  }

  private runtime(agent: AgentContext): UsageRuntime {
    return this.agentLifecycle.resolve(agent, AgentUsage);
  }
}
