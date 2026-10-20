import { createFeature, type Feature, type FeatureUnits } from '@moonshot-ai/agent-core/app/index';
import {
  createFacadeToken,
  shallowRef,
  useExpose,
  type Ref,
} from '@moonshot-ai/agent-core/kernel/index';
import { llmStatusErrorMessage } from '@moonshot-ai/agent-core/llm/response';

import { useLoopEvent } from '#/runtime/index';

export interface TraceFace {
  readonly traceId: Ref<string | undefined>;
}

export const TraceRef = createFacadeToken<TraceFace>('trace');

export const traceSlots: FeatureUnits<void> = {
  agent() {
    const current = shallowRef<string | undefined>(undefined);
    const capture = (headers: Record<string, string> | null | undefined): void => {
      const value = headers?.['x-trace-id'];
      if (value !== undefined && value.length > 0) {
        current.value = value;
      }
    };
    useLoopEvent('llm.streaming.headers', (event) => {
      capture(event.headers);
    });
    useLoopEvent('llm.ended', (event) => {
      if (event.outcome.type !== 'failed') return;
      capture(llmStatusErrorMessage(event.outcome.error)?.headers);
    });
    useExpose(TraceRef, { traceId: current });
  },
};

export const trace: Feature<void> = createFeature('trace', traceSlots);
