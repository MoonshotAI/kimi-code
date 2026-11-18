import type { NormalizedMessage } from './translator.js';

const PLACEHOLDER_TEXT = '[tool result unavailable — session imported from kimi-cli]';

export function closeDanglingToolCalls(
  messages: readonly NormalizedMessage[],
): NormalizedMessage[] {
  const satisfied = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.toolCallId !== undefined && msg.toolCallId !== '') {
      satisfied.add(msg.toolCallId);
    }
  }

  const out: NormalizedMessage[] = [];
  for (const msg of messages) {
    out.push(msg);
    if (msg.role !== 'assistant') continue;
    for (const call of msg.toolCalls) {
      if (call.id === '' || satisfied.has(call.id)) continue;
      out.push({
        role: 'tool',
        toolCallId: call.id,
        content: [{ type: 'text', text: PLACEHOLDER_TEXT }],
        toolCalls: [],
      });
      satisfied.add(call.id);
    }
  }
  return out;
}
