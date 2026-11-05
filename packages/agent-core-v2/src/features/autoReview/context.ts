import { createUserMessage, type ContentPart } from '#human/llm/message';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import type { ExecutableTool } from '#/tool/toolContract';

const MAX_AUTHORIZATION_TOTAL_CHARS = 48000;
const MAX_AUTHORIZATION_ENTRY_CHARS = 8000;
const MAX_RECENT_ACTIONS = 20;
const MAX_ACTION_ARGUMENT_CHARS = 8000;

interface ReviewText {
  readonly role: 'human-instruction' | 'direct-parent-instruction' | 'constraint' | 'fact';
  readonly content: readonly ContentPart[];
}

export function buildReviewMessages(
  messages: readonly ContextMessage[],
  instructions: string | undefined,
  instructionPaths: readonly string[] | undefined,
  cwd: string,
  tool: ExecutableTool | undefined,
  context: ResolvedToolExecutionHookContext,
): ReturnType<typeof createUserMessage>[] {
  const recentActions = messages.flatMap((message) => actionEntries(message, context.toolCall.id)).slice(-MAX_RECENT_ACTIONS);
  let authorizationChars = 0;
  const authorization = messages.flatMap(authorizationEntry).toReversed().flatMap((entry) => {
    if (authorizationChars >= MAX_AUTHORIZATION_TOTAL_CHARS) return [];
    const content = boundedContent(entry.content, MAX_AUTHORIZATION_TOTAL_CHARS - authorizationChars);
    authorizationChars += content.reduce((total, part) => total + (part.type === 'text' ? part.text.length : 0), 0);
    return [{ ...entry, content }];
  }).toReversed();
  return [
    `ENVIRONMENT\n${JSON.stringify({ cwd })}`,
    `PROJECT_INSTRUCTIONS\n${JSON.stringify({
      role: 'constraint',
      paths: instructionPaths ?? [],
      content: instructions ?? '',
    })}`,
    `FILTERED_HISTORY\n${JSON.stringify({ authorization, recentActions })}`,
    `PENDING_ACTION\n${JSON.stringify({
      name: context.toolCall.name,
      description: tool?.description ?? '',
      parameters: tool?.parameters ?? {},
      arguments: context.args,
    })}`,
  ].map(createUserMessage);
}

export function authorizationEntries(messages: readonly ContextMessage[]): string[] {
  return messages.flatMap(authorizationEntry).map((entry) => JSON.stringify(entry));
}

function authorizationEntry(message: ContextMessage): ReviewText[] {
  if (message.role !== 'user') return [];
  const role = authorizationRole(message);
  if (role === undefined) return [];
  const content = boundedContent(message.content, MAX_AUTHORIZATION_ENTRY_CHARS);
  return [{ role, content }];
}

function authorizationRole(
  message: ContextMessage,
): 'human-instruction' | 'direct-parent-instruction' | undefined {
  const { origin } = message;
  if (origin === undefined) return 'human-instruction';
  if (origin.kind === 'user' || origin.kind === 'plugin_command') return 'human-instruction';
  if (origin.kind === 'skill_activation' && origin.trigger === 'user-slash') return 'human-instruction';
  if (origin.kind === 'system_trigger' && origin.name === 'subagent') return 'direct-parent-instruction';
  return undefined;
}

function actionEntries(message: ContextMessage, pendingCallId: string): unknown[] {
  if (message.role === 'assistant') {
    return message.toolCalls.filter((call) => call.id !== pendingCallId).map((call) => ({
      kind: 'tool-call',
      role: 'fact',
      id: call.id,
      name: call.name,
      arguments: boundedText(call.arguments ?? '', MAX_ACTION_ARGUMENT_CHARS),
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

function boundedContent(content: readonly ContentPart[], maxChars: number): readonly ContentPart[] {
  const result: ContentPart[] = [];
  let remaining = maxChars;
  for (const part of content) {
    if (part.type !== 'text') {
      result.push({ type: 'text', text: `[${part.type} attachment omitted]` });
      continue;
    }
    const text = boundedText(part.text, remaining);
    remaining -= text.length;
    result.push({ type: 'text', text });
  }
  return result;
}

function boundedText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} characters]`;
}
