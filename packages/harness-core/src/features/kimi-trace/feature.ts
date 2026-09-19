import { createFeature, llmStatusErrorMessage, useAgent } from '@moonshot-ai/agent-core';
import { createToken, shallowRef, useExpose, type Ref } from '@moonshot-ai/agent-core/kernel/index';

export interface KimiTraceFace {
  readonly traceId: Ref<string | undefined>;
}

export const KimiTraceRef = createToken<KimiTraceFace>('kimi-trace');

export const kimiTrace = createFeature('kimi-trace', {
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
    agent.on('llm.failed.remote', (event) => {
      capture(llmStatusErrorMessage(event.error)?.headers);
    });
    useExpose(KimiTraceRef, { traceId: current });
  },
});
