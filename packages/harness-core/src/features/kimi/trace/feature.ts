import {
  createFacadeToken,
  createFeature,
  llmStatusErrorMessage,
  useAgent,
  type FeatureSlots,
  type FeatureSpec,
} from '@moonshot-ai/agent-core';
import { shallowRef, useExpose, type Ref } from '@moonshot-ai/agent-core/kernel/index';

export interface TraceFace {
  readonly traceId: Ref<string | undefined>;
}

export const TraceRef = createFacadeToken<TraceFace>('trace');

export const traceSlots: FeatureSlots = {
  agent() {
    const current = shallowRef<string | undefined>(undefined);
    const capture = (headers: Record<string, string> | null | undefined): void => {
      const value = headers?.['x-trace-id'];
      if (value !== undefined && value.length > 0) {
        current.value = value;
      }
    };
    const agent = useAgent();
    agent.on('llm.streaming.headers', (event) => {
      capture(event.headers);
    });
    agent.on('llm.ended', (event) => {
      if (event.outcome.type !== 'failed') return;
      capture(llmStatusErrorMessage(event.outcome.error)?.headers);
    });
    useExpose(TraceRef, { traceId: current });
  },
};

export const trace: FeatureSpec = createFeature('trace', traceSlots);
