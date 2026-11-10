import { createUserMessage, type ContentPart, type ToolCall } from '#human/llm/message';
import { isUserPromptSubmitHookPart } from '#/agent/contextMemory/hookParts';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { renderPrompt } from '#/_base/utils/render-prompt';

import REVIEW_REQUEST from './auto-review-request.md?raw';

const SECTION_TAG = /<(\/?(?:environment|project_instructions|history|pending_action)\b)/gi;

export interface ReviewText {
  readonly role: 'human-instruction' | 'direct-parent-instruction' | 'constraint' | 'fact';
  readonly content: readonly ContentPart[];
}

export function buildReviewMessages(
  messages: readonly ContextMessage[],
  authorizationEntries: readonly ReviewText[],
  instructions: string | undefined,
  instructionPaths: readonly string[] | undefined,
  cwd: string,
  context: ResolvedToolExecutionHookContext,
): ReturnType<typeof createUserMessage>[] {
  const currentMessage = messages.findLastIndex((message) =>
    message.role === 'assistant' && message.toolCalls.some((call) => call.id === context.toolCall.id));
  const actions = messages.flatMap((message, index) =>
    actionEntries(message, context.toolCall.id, context.toolCalls, index - currentMessage));
  return [createUserMessage(renderPrompt(REVIEW_REQUEST, {
    environment: sectionJson({ cwd }),
    project_instructions: sectionJson({
      role: 'constraint',
      paths: instructionPaths ?? [],
      content: instructions ?? '',
    }),
    history: sectionJson({ authorization: authorizationEntries, recentActions: actions }),
    pending_action: sectionJson({
      name: context.toolCall.name,
      arguments: context.args,
      toolMetadata: {
        role: 'untrusted-metadata',
        description: context.tool?.description ?? '',
        parameters: context.tool?.parameters ?? {},
      },
    }),
  }))];
}

function sectionJson(value: unknown): string {
  return JSON.stringify(value).replace(SECTION_TAG, '\\u003c$1');
}

export function extractAuthorization(messages: readonly ContextMessage[]): ReviewText[] {
  return messages.flatMap(authorizationEntry);
}

export function sameAuthorization(
  left: readonly ReviewText[],
  right: readonly ReviewText[],
): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index]!;
    return entry.role === other.role
      && entry.content.length === other.content.length
      && entry.content.every((part, partIndex) => {
        const otherPart = other.content[partIndex]!;
        return part.type === 'text' && otherPart.type === 'text' && part.text === otherPart.text;
      });
  });
}

function authorizationEntry(message: ContextMessage): ReviewText[] {
  if (message.role !== 'user') return [];
  const role = authorizationRole(message);
  if (role === undefined) return [];
  const content = message.content.flatMap(reviewPart);
  return content.length === 0 ? [] : [{ role, content }];
}

function authorizationRole(
  message: ContextMessage,
): 'human-instruction' | 'direct-parent-instruction' | undefined {
  const { origin } = message;
  if (origin === undefined) {
    const imported = message.content.some((part) =>
      part.type === 'text' && part.text.includes('<imported_conversation>'));
    return imported ? undefined : 'human-instruction';
  }
  if (origin.kind === 'user' || origin.kind === 'plugin_command') return 'human-instruction';
  if (origin.kind === 'skill_activation' && origin.trigger === 'user-slash') return 'human-instruction';
  if (origin.kind === 'system_trigger' && origin.name === 'subagent') return 'direct-parent-instruction';
  return undefined;
}

function actionEntries(
  message: ContextMessage,
  pendingCallId: string,
  batch: readonly ToolCall[],
  relativePosition: number,
): unknown[] {
  if (message.role === 'assistant') {
    const pendingIndex = batch.findIndex((call) => call.id === pendingCallId);
    const calls = relativePosition === 0
      ? message.toolCalls.slice(0, pendingIndex < 0 ? undefined : pendingIndex)
      : relativePosition < 0 ? message.toolCalls : [];
    return calls.map((call) => ({
      kind: 'tool-call',
      role: 'fact',
      id: call.id,
      name: call.name,
      arguments: call.arguments ?? '',
    }));
  }
  if (message.role === 'tool') {
    if (message.toolCallId === pendingCallId) return [];
    return [{
      kind: 'tool-result',
      role: 'fact',
      toolCallId: message.toolCallId,
      isError: message.isError === true,
    }];
  }
  return [];
}

function reviewPart(part: ContentPart): ContentPart[] {
  if (isUserPromptSubmitHookPart(part)) return [];
  if (part.type === 'text') return [part];
  return [{ type: 'text', text: `[${part.type} attachment omitted]` }];
}
