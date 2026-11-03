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
  const retained = messages.filter((message) => authorizationRole(message) !== undefined);
  let authorizationChars = 0;
  const authorization = retained.flatMap((message) => {
    if (authorizationChars >= MAX_AUTHORIZATION_TOTAL_CHARS) return [];
    const [entry] = authorizationEntry(message);
    if (entry === undefined) return [];
    const remaining = MAX_AUTHORIZATION_TOTAL_CHARS - authorizationChars;
    const content = boundedContent(entry.content, Math.min(MAX_AUTHORIZATION_ENTRY_CHARS, remaining));
    authorizationChars += content.reduce((total, part) => total + (part.type === 'text' ? part.text.length : 0), 0);
    return [{ ...entry, content }];
  });
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

export function authorizationFingerprint(messages: readonly ContextMessage[]): string {
  return JSON.stringify(messages.flatMap(authorizationEntry));
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
  if (message.origin?.kind === 'user' || message.origin?.kind === 'plugin_command') {
    return 'human-instruction';
  }
  if (message.origin?.kind === 'skill_activation' && message.origin.trigger === 'user-slash') {
    return 'human-instruction';
  }
  if (message.name === 'Agent' || message.name === 'Task') return 'direct-parent-instruction';
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
