import { createFeature, useAgent, type LlmModel } from '@moonshot-ai/agent-core';
import { createToken, shallowRef, useExpose, type Ref } from '@moonshot-ai/agent-core/kernel/index';

import { accumulateUsage, emptyUsageSummary, type UsageRecord, type UsageSummary } from './usage';

export interface UsageFace {
  readonly summary: Ref<UsageSummary>;
  readonly records: Ref<readonly UsageRecord[]>;
}

export const UsageRef = createToken<UsageFace>('usage');

export const usage = createFeature('usage', {
  agent() {
    const records = shallowRef<UsageRecord[]>([]);
    const summary = shallowRef(emptyUsageSummary());
    let currentTurnId: number | undefined;
    const agent = useAgent();
    agent.on('turn.started', (event) => {
      currentTurnId = event.turnId;
    });
    agent.on('llm.streaming.usage', (event) => {
      const model = agent.snapshot.value?.context.request.config.model as LlmModel | undefined;
      const record: UsageRecord = {
        usage: event.usage,
        model,
        turnId: currentTurnId,
        at: Date.now(),
      };
      records.value = [...records.value, record];
      summary.value = accumulateUsage(summary.value, record);
    });
    useExpose(UsageRef, { summary, records });
  },
});
