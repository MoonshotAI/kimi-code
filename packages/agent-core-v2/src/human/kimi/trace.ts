import { llmStatusErrorMessage } from '#/llm/errors';
import type { Plugin } from '#/plugin';

export interface TracePlugin extends Plugin {
  readonly name: 'trace';
  traceId(): string | undefined;
}

export function createTracePlugin(): TracePlugin {
  let current: string | undefined;
  const capture = (headers: Record<string, string> | null | undefined): void => {
    const value = headers?.['x-trace-id'];
    if (value !== undefined && value.length > 0) {
      current = value;
    }
  };
  return {
    name: 'trace',
    traceId: () => current,
    connect(target) {
      if (target.kind !== 'agent') return;
      target.on('llm.headers', (event) => {
        if (event.type === 'llm.headers') {
          capture(event.headers);
        }
      });
      target.on('llm.failed.remote', (event) => {
        if (event.type === 'llm.failed.remote') {
          capture(llmStatusErrorMessage(event.error)?.headers);
        }
      });
    },
  };
}
