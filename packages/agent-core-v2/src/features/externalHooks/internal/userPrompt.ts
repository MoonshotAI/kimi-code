import { userPromptSubmitHookPart } from '#/agent/contextMemory/hookParts';
import type { TextPart } from '#human/llm/message';

import type { HookResult } from './types';

export function renderHookResult(event: string, message: string): string {
  return `<hook_result hook_event="${event}">\n${message}\n</hook_result>`;
}

export interface RenderedHookResult {
  readonly event: string;
  readonly message: string;
  readonly text: string;
}

export interface RenderedUserPromptHookParts {
  readonly event: string;
  readonly messages: readonly string[];
  readonly parts: readonly TextPart[];
}

export function renderUserPromptHookResult(
  results: readonly HookResult[] | undefined,
): RenderedUserPromptHookParts | undefined {
  const messages =
    results
      ?.filter((result) => result.action !== 'block')
      ?.map(userPromptHookMessage)
      .filter(isNonEmptyString) ??
    [];
  if (messages.length === 0) return undefined;
  return {
    event: 'UserPromptSubmit',
    messages,
    parts: messages.map((message) =>
      userPromptSubmitHookPart(renderHookResult('UserPromptSubmit', message)),
    ),
  };
}

export function renderUserPromptHookBlockResult(
  results: readonly HookResult[] | undefined,
): RenderedHookResult | undefined {
  const block = results?.find((result) => result.action === 'block');
  if (block === undefined) return undefined;
  const message = block.message?.trim();
  if (message !== undefined && message.length > 0) {
    return {
      event: 'UserPromptSubmit',
      message,
      text: renderHookResult('UserPromptSubmit', message),
    };
  }
  const reason = block.reason?.trim();
  const result =
    reason === undefined || reason.length === 0 ? 'Blocked by UserPromptSubmit hook' : reason;
  return {
    event: 'UserPromptSubmit',
    message: result,
    text: renderHookResult('UserPromptSubmit', result),
  };
}

function userPromptHookMessage(result: HookResult): string | undefined {
  if (result.timedOut === true || (result.exitCode !== undefined && result.exitCode !== 0)) {
    return undefined;
  }
  const message = result.message?.trim();
  if (message !== undefined && message.length > 0) return message;
  if (result.structuredOutput === true) return undefined;
  const stdout = result.stdout?.trim();
  return stdout === undefined || stdout.length === 0 ? undefined : stdout;
}

function isNonEmptyString(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}
