/**
 * `kosong/provider` domain (L2) — Kimi tool conversion trait.
 *
 * `kimiToolSchemaTrait.convertTool`: tool names with a `$` prefix are emitted
 * as `builtin_function` declarations; every other tool goes through the base
 * OpenAI conversion with its parameters normalized into the Kimi schema
 * dialect (`normalizeKimiToolSchema`).
 */

import type { Tool } from '#/kosong/contract/tool';
import type { ProtocolTrait } from '#/kosong/protocol/protocolTrait';

import { type OpenAIToolParam, toolToOpenAI } from '../../bases/openai-common';
import { normalizeKimiToolSchema } from './kimi-schema';

export function convertKimiTool(tool: Tool): OpenAIToolParam {
  if (tool.name.startsWith('$')) {
    return {
      type: 'builtin_function',
      function: { name: tool.name },
    };
  }
  const converted = toolToOpenAI(tool);
  return {
    ...converted,
    function: {
      ...converted.function,
      parameters: normalizeKimiToolSchema(tool.parameters),
    },
  };
}

export const kimiToolSchemaTrait: ProtocolTrait = {
  convertTool: (tool) => convertKimiTool(tool),
};
