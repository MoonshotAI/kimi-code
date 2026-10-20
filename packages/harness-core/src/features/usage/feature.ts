import { createFeature, useAgent } from '@moonshot-ai/agent-core/app/index';
import {
  addUsage,
  emptyUsage,
  grandTotal,
  type AssistantEntry,
  type HistoryMessage,
} from '@moonshot-ai/agent-core/history/index';
import {
  computed,
  createFacadeToken,
  shallowRef,
  useCleanup,
  useExpose,
  type ComputedRef,
  type ShallowRef,
} from '@moonshot-ai/agent-core/kernel/index';
import type { TokenUsage } from '@moonshot-ai/agent-core/llm/response';

export interface UsageFace {
  readonly usage: ShallowRef<TokenUsage>;
  readonly total: ComputedRef<number>;
}

export const UsageRef = createFacadeToken<UsageFace>('usage');

function foldUsage(messages: readonly HistoryMessage[]): TokenUsage {
  let total = emptyUsage();
  for (const entry of messages) {
    if (entry.message.role !== 'assistant') continue;
    const usage = (entry as AssistantEntry).meta?.usage;
    if (usage !== undefined) total = addUsage(total, usage);
  }
  return total;
}

export const usage = createFeature('usage', {
  agent() {
    const agent = useAgent();
    const accumulated = shallowRef(foldUsage(agent.view.getState().messages));
    useCleanup(
      agent.view.subscribe((state) => {
        accumulated.value = foldUsage(state.messages);
      }),
    );
    useExpose(UsageRef, { usage: accumulated, total: computed(() => grandTotal(accumulated.value)) });
  },
});
