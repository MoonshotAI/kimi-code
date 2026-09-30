import type { Message } from '#/llm/message';

import type { DecodeSink } from '../protocol';

export function uniqueToolCallIds<TSink extends DecodeSink>(
  history: readonly Message[],
  sink: TSink,
): TSink {
  const taken = new Set<string>();
  for (const message of history) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) taken.add(call.id);
    }
    if (message.role === 'tool') taken.add(message.toolCallId);
  }
  const assignedByIndex = new Map<number | string, string>();
  const occurrencesByRawId = new Map<string, number>();
  const assign = (rawId: string, streamIndex: number | string | undefined): string => {
    const existing = streamIndex === undefined ? undefined : assignedByIndex.get(streamIndex);
    if (existing !== undefined) return existing;
    const occurrence = occurrencesByRawId.get(rawId) ?? 0;
    occurrencesByRawId.set(rawId, occurrence + 1);
    let assigned = rawId;
    if (occurrence > 0 || taken.has(rawId)) {
      let n = Math.max(occurrence + 1, 2);
      while (taken.has(`${rawId}__${n}`)) n += 1;
      assigned = `${rawId}__${n}`;
    }
    taken.add(assigned);
    if (streamIndex !== undefined) assignedByIndex.set(streamIndex, assigned);
    return assigned;
  };
  return {
    ...sink,
    onDelta: (part) => {
      if (part.type !== 'function') return sink.onDelta(part);
      const id = assign(part.id, part._streamIndex);
      sink.onDelta(id === part.id ? part : { ...part, id, rawId: part.rawId ?? part.id });
    },
  };
}
