/**
 * `kosong/provider` domain (L2) — Kimi message-shape trait.
 *
 * `kimiMessageShapeTrait.convertMessage` post-processes each base-converted
 * wire message:
 *
 *  - assistant tool-call messages whose content is effectively empty drop the
 *    `content` field entirely;
 *  - `tool_calls[].extras` round-trips from the contract message into the
 *    wire shape (the base conversion never emits `extras`);
 *  - message-level `tools` declarations are embedded into the message.
 */

import type { ContentPart } from '#/kosong/contract/message';
import type { ProtocolTrait } from '#/kosong/protocol/protocolTrait';

import { convertKimiTool } from './kimi-tool-schema';

function isEffectivelyEmptyContent(parts: ContentPart[]): boolean {
  for (const part of parts) {
    if (part.type !== 'text') return false;
    if (part.text.trim() !== '') return false;
  }
  return true;
}

export const kimiMessageShapeTrait: ProtocolTrait = {
  convertMessage: (message, converted) => {
    if (message.role === 'assistant' && message.toolCalls.length > 0) {
      const nonThinkParts = message.content.filter((part) => part.type !== 'think');
      if (isEffectivelyEmptyContent(nonThinkParts)) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete converted['content'];
      }
    }

    const convertedToolCalls = converted['tool_calls'];
    if (Array.isArray(convertedToolCalls)) {
      message.toolCalls.forEach((toolCall, index) => {
        if (toolCall.extras === undefined) return;
        const out = convertedToolCalls[index] as Record<string, unknown> | undefined;
        if (out !== undefined) {
          out['extras'] = toolCall.extras;
        }
      });
    }

    if (message.tools !== undefined && message.tools.length > 0) {
      converted['tools'] = message.tools.map((tool) => convertKimiTool(tool));
    }

    return converted;
  },
};
