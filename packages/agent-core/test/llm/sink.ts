import type { DecodeSink } from '#/llm/protocol/protocol';

export function sinkOf(handlers: Partial<DecodeSink>): DecodeSink {
  return {
    onDelta: () => {},
    onFinish: () => {},
    onMessageId: () => {},
    onUsage: () => {},
    onError: () => {},
    onToolCallEnd: () => {},
    ...handlers,
  };
}
