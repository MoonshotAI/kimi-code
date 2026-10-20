import type { ContentPart } from '#/llm/message';

import type { ToolResult } from './contract';

export function toolError(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function unknownTool(name: string): ToolResult {
  return toolError(`unknown tool: ${name}`);
}

export function unavailableTool(name: string, reason: string): ToolResult {
  return toolError(`tool unavailable: ${name}: ${reason}`);
}

export function truncateResult(result: ToolResult, maxChars: number | undefined): ToolResult {
  if (maxChars === undefined) return result;
  let used = 0;
  let truncated = false;
  const content: ContentPart[] = [];
  for (const part of result.content) {
    if (part.type !== 'text') {
      content.push(part);
      continue;
    }
    if (truncated) continue;
    const remaining = maxChars - used;
    if (part.text.length <= remaining) {
      content.push(part);
      used += part.text.length;
      continue;
    }
    truncated = true;
    if (remaining > 0) content.push({ ...part, text: part.text.slice(0, remaining) });
  }
  if (!truncated) return result;
  content.push({ type: 'text', text: `[truncated to ${String(maxChars)} chars]` });
  return {
    content,
    ...(result.isError === true ? { isError: true as const } : {}),
    ...(result.stopTurn !== undefined ? { stopTurn: result.stopTurn } : {}),
  };
}
