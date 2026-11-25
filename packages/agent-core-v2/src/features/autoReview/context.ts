import { createUserMessage, type ContentPart, type TextPart } from '@moonshot-ai/core/llm/message';
import { isUserPromptSubmitHookPart } from '#/agent/contextMemory/hookParts';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { renderPrompt } from '#/_base/utils/render-prompt';

import REVIEW_REQUEST from './auto-review-request.md?raw';

const SECTION_TAG = /<(\/?(?:environment|project_instructions|history|pending_action)\b)/gi;

export interface ReviewText {
  readonly role: 'human-instruction' | 'direct-parent-instruction' | 'constraint' | 'fact';
  readonly content: readonly TextPart[];
}

export interface ReviewGitStatus {
  readonly branch: string;
  readonly clean: boolean;
  readonly entries?: Readonly<Record<string, string>>;
}

export function buildReviewMessages(
  messages: readonly ContextMessage[],
  inherited: readonly ReviewText[],
  instructions: string | undefined,
  instructionPaths: readonly string[] | undefined,
  cwd: string,
  context: ResolvedToolExecutionHookContext,
  approvedToolCallIds?: ReadonlySet<string>,
  gitStatus?: ReviewGitStatus,
): ReturnType<typeof createUserMessage>[] {
  const completedIds = new Set(
    messages.flatMap((message) => (message.role === 'tool' ? [message.toolCallId] : [])),
  );
  return [createUserMessage(renderPrompt(REVIEW_REQUEST, {
    environment: sectionJson({ cwd }),
    project_instructions: sectionJson({
      role: 'constraint',
      paths: instructionPaths ?? [],
      content: instructions ?? '',
    }),
    history: sectionJson([
      ...inherited.map((entry) => ({ kind: 'instruction', ...entry })),
      ...messages.flatMap((message) => [
        ...authorizationEntry(message).map((entry) => ({ kind: 'instruction', ...entry })),
        ...actionEntries(message, completedIds, approvedToolCallIds),
      ]),
    ]),
    pending_action: sectionJson({
      name: context.toolCall.name,
      arguments: context.args,
      gitStatus,
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
      && entry.content.every((part, partIndex) => part.text === other.content[partIndex]!.text);
  });
}

export type AuthorizationDrift = 'unchanged' | 'appended' | 'changed';

export function detectAuthorizationDrift(
  previous: readonly ReviewText[],
  current: readonly ReviewText[],
): AuthorizationDrift {
  if (sameAuthorization(previous, current)) return 'unchanged';
  return sameAuthorization(previous, current.slice(0, previous.length)) ? 'appended' : 'changed';
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
  if (origin === undefined) return undefined;
  if (origin.kind === 'user' || origin.kind === 'plugin_command') return 'human-instruction';
  if (origin.kind === 'skill_activation' && origin.trigger === 'user-slash') return 'human-instruction';
  if (origin.kind === 'system_trigger' && origin.name === 'subagent') return 'direct-parent-instruction';
  return undefined;
}

function actionEntries(
  message: ContextMessage,
  completedIds: ReadonlySet<string>,
  approvedToolCallIds: ReadonlySet<string> | undefined,
): unknown[] {
  if (message.role !== 'assistant') return [];
  return message.toolCalls
    .filter((call) => completedIds.has(call.id))
    .map((call) => ({
      kind: 'tool-call',
      role: 'fact',
      id: call.id,
      name: call.name,
      arguments: call.arguments ?? '',
      approved: approvedToolCallIds?.has(call.id) ? true : undefined,
    }));
}

function reviewPart(part: ContentPart): TextPart[] {
  if (isUserPromptSubmitHookPart(part)) return [];
  if (part.type === 'text') return [part];
  return [{ type: 'text', text: `[${part.type} attachment omitted]` }];
}
