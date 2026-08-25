import type { ContentPart } from '#/kosong/contract/message';
import type { PartsTransformer, WireRecord } from '#/wire/record';

import type { LoopRecordedEvent } from '../loopEventFold';
import type { ContextMessage } from '../types';

export async function dehydrateContextMemoryMessages(
  messages: readonly ContextMessage[],
  transform: PartsTransformer,
): Promise<{ changed: boolean; result: ContextMessage[] }> {
  let changed = false;
  const result: ContextMessage[] = [];
  for (const msg of messages) {
    const parts = await transform(msg.content);
    if (parts !== msg.content) {
      changed = true;
      result.push({ ...msg, content: [...parts] as ContentPart[] });
    } else {
      result.push(msg);
    }
  }
  return { changed, result };
}

export async function dehydrateContextMemoryRecord(
  record: WireRecord,
  transform: PartsTransformer,
): Promise<WireRecord> {
  if (record.type === 'context.append_message') {
    const message = record['message'] as ContextMessage | undefined;
    if (message === undefined) return record;
    const parts = await transform(message.content);
    if (parts === message.content) return record;
    return { ...record, message: { ...message, content: [...parts] } };
  }
  if (record.type === 'context.append_loop_event') {
    const event = record['event'] as LoopRecordedEvent | undefined;
    if (event === undefined) return record;
    if (event.type === 'content.part') {
      const parts = await transform([event.part]);
      if (parts[0] === event.part) return record;
      return { ...record, event: { ...event, part: parts[0] } };
    }
    if (event.type === 'tool.result') {
      const output = event.result.output;
      if (!Array.isArray(output)) return record;
      const parts = await transform(output);
      if (parts === output) return record;
      return { ...record, event: { ...event, result: { ...event.result, output: [...parts] } } };
    }
    return record;
  }
  return record;
}
