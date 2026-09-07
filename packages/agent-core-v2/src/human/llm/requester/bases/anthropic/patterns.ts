import type { ContentPart, Message } from '#/llm/message';
import type { Pattern } from '#/llm/protocol/rewrite';

const OMITTED_AUDIO_PLACEHOLDER = '(audio omitted: not supported by this provider)';

export function stripUnsignedThinking(options: { readonly preserve: boolean }): Pattern<Message> {
  return {
    name: 'stripUnsignedThinking',
    rewrite(items, index) {
      const message = items[index];
      if (message === undefined) return null;
      const content = message.content.filter((part) => {
        if (part.type !== 'think') return true;
        if (part.encrypted !== undefined) return true;
        return options.preserve;
      });
      if (content.length === message.content.length) return null;
      return { consumed: 1, replacement: [{ ...message, content }] };
    },
  };
}

export const audioToPlaceholder: Pattern<Message> = {
  name: 'audioToPlaceholder',
  rewrite(items, index) {
    const message = items[index];
    if (message === undefined || message.role === 'system') return null;
    let changed = false;
    const content: ContentPart[] = [];
    for (const part of message.content) {
      if (part.type === 'audio_url') {
        const last = content.at(-1);
        if (last === undefined || last.type !== 'text' || last.text !== OMITTED_AUDIO_PLACEHOLDER) {
          content.push({ type: 'text', text: OMITTED_AUDIO_PLACEHOLDER });
        }
        changed = true;
      } else if (message.role === 'tool' && part.type === 'text' && part.text === '') {
        changed = true;
      } else {
        content.push(part);
      }
    }
    if (!changed) return null;
    return { consumed: 1, replacement: [{ ...message, content }] };
  },
};
