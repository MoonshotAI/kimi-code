/**
 * Google GenAI legality rules: supported sampling parameters and the pattern that reorders tool
 * results to match call order, rejecting missing, duplicate, or unexpected results.
 */
import type { Message, ToolMessage } from '#/llm/message';
import type { ModelLegality } from '#/llm/protocol/rules/model';
import type { Pattern } from '#/llm/protocol/pattern';
import { SyntaxRequestFormatError } from '#/llm/protocol/errors';

export const googleGenAIModelLegality: ModelLegality = {
  sampling: ['temperature', 'topP', 'topK', 'stop', 'seed', 'presencePenalty', 'frequencyPenalty'],
};

/**
 * Reorders the consecutive tool messages after an assistant message to match its tool-call order,
 * preserving the assistant message and rejecting duplicate, missing, or unexpected tool-call ids.
 *
 * @example
 * const assistant = {
 *   role: 'assistant',
 *   content: [],
 *   toolCalls: [
 *     { type: 'function', id: 'call-1', name: 'read', arguments: '{}' },
 *     { type: 'function', id: 'call-2', name: 'write', arguments: '{}' },
 *   ],
 * };
 * const read = {
 *   role: 'tool',
 *   toolCallId: 'call-1',
 *   content: [{ type: 'text', text: 'read' }],
 * };
 * const write = {
 *   role: 'tool',
 *   toolCallId: 'call-2',
 *   content: [{ type: 'text', text: 'written' }],
 * };
 * // Input:
 * [assistant, write, read] // ←
 * // Output:
 * [assistant, read, write] // ←
 */
export const sortToolRunByCallOrder: Pattern<Message> = {
  name: 'sortToolRunByCallOrder',
  rewrite(items, index) {
    const message = items[index];
    if (message === undefined || message.role !== 'assistant' || message.toolCalls.length === 0) {
      return null;
    }
    let end = index + 1;
    while (end < items.length && items[end]?.role === 'tool') {
      end += 1;
    }
    if (end === index + 1) return null;
    const run = items.slice(index + 1, end) as ToolMessage[];
    const toolMsgById = new Map<string, ToolMessage>();
    const seenToolCallIds = new Set<string>();
    for (const toolMsg of run) {
      if (seenToolCallIds.has(toolMsg.toolCallId)) {
        throw new SyntaxRequestFormatError(`Duplicate tool response for id: ${toolMsg.toolCallId}`);
      }
      seenToolCallIds.add(toolMsg.toolCallId);
      toolMsgById.set(toolMsg.toolCallId, toolMsg);
    }
    const sorted: ToolMessage[] = [];
    for (const toolCall of message.toolCalls) {
      const msg = toolMsgById.get(toolCall.id);
      if (msg === undefined) {
        throw new SyntaxRequestFormatError(`Missing tool responses for ids: ${toolCall.id}`);
      }
      sorted.push(msg);
      toolMsgById.delete(toolCall.id);
    }
    if (toolMsgById.size > 0) {
      throw new SyntaxRequestFormatError(
        `Unexpected tool responses for ids: ${JSON.stringify([...toolMsgById.keys()])}`,
      );
    }
    if (run.every((msg, i) => msg === sorted[i])) return null;
    return { consumed: 1 + run.length, replacement: [message, ...sorted] };
  },
};
