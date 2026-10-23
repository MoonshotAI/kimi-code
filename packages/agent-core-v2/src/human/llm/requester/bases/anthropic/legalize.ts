import type { ContentPart, Message } from '#/llm/message';
import type { ModelLegality } from '#/llm/protocol/rules/model';
import type { Pattern } from '#/llm/protocol/rewrite';
import type { LlmModelSpec } from '#/llm/request';
import { SyntaxRequestFormatError } from '#/llm/syntax-errors';

import { resolveDefaultMaxTokens, shouldPreserveUnsignedThinking } from './profile';

const OMITTED_AUDIO_PLACEHOLDER = '(audio omitted: not supported by this provider)';

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

export function anthropicPatterns(): readonly Pattern<Message>[] {
  return [audioToPlaceholder];
}

function stripUnsignedThinking(options: { readonly preserve: boolean }): Pattern<Message> {
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

export function anthropicThinkingHistoryPatterns(
  model: LlmModelSpec,
): readonly Pattern<Message>[] {
  return [stripUnsignedThinking({ preserve: shouldPreserveUnsignedThinking(model.name) })];
}

export const anthropicModelLegality: ModelLegality = {
  sampling: ['temperature', 'topP', 'topK', 'stop'],
  clampMaxOutputTokens: (maxOutputTokens, model) =>
    resolveDefaultMaxTokens(model.name, maxOutputTokens),
  verify: (model, ctx) => {
    if (model.responseFormat?.type === 'json_object') {
      throw new SyntaxRequestFormatError(
        'Anthropic requires a JSON schema for structured response output.',
      );
    }
    const effort = model.thinking?.effort;
    const known = model.spec.thinking?.supportEfforts?.filter((value) => value.length > 0) ?? [];
    if (effort === undefined || effort === 'on' || effort === 'off' || known.length === 0) return;
    if (known.includes(effort)) return;
    ctx.report({
      code: 'anthropic-thinking-effort-not-listed',
      message: `Thinking effort "${effort}" is not listed for model "${model.spec.name}" (known: ${known.join(', ')}). The configured value will be sent unchanged to the Anthropic-compatible backend.`,
      data: { effort, knownEfforts: known },
    });
  },
};
