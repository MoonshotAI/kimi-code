import type { HookResult } from './types';

export function renderHookResult(event: string, message: string): string {
  return `<hook_result hook_event="${event}">\n${message}\n</hook_result>`;
}

export interface RenderedHookResult {
  readonly event: string;
  readonly message: string;
  readonly text: string;
  readonly suppressTuiDisplay?: boolean;
}

export interface RenderUserPromptHookResultOptions {
  readonly suppressTuiDisplay?: boolean;
}

export function renderUserPromptHookResult(
  results: readonly HookResult[] | undefined,
  options: RenderUserPromptHookResultOptions = {},
): RenderedHookResult | undefined {
  const messages =
    results
      ?.filter((result) => result.action !== 'block')
      ?.filter((result) => matchesDisplayFilter(result, options.suppressTuiDisplay))
      ?.map(userPromptHookMessage)
      .filter(isNonEmptyString) ??
    [];
  if (messages.length === 0) return undefined;
  const displayMessage = messages.join('\n\n');
  return {
    event: 'UserPromptSubmit',
    message: displayMessage,
    text: messages.map((message) => renderHookResult('UserPromptSubmit', message)).join('\n'),
  };
}

export function renderUserPromptHookResultChunks(
  results: readonly HookResult[] | undefined,
): readonly RenderedHookResult[] {
  const rendered: RenderedHookResult[] = [];
  let current: { suppressTuiDisplay: boolean; messages: string[] } | undefined;

  for (const result of results ?? []) {
    if (result.action === 'block') continue;
    const message = userPromptHookMessage(result);
    if (message === undefined) continue;
    const suppressTuiDisplay = result.suppressTuiDisplay === true;

    if (current === undefined || current.suppressTuiDisplay !== suppressTuiDisplay) {
      if (current !== undefined) {
        rendered.push(renderMessages(current.messages, current.suppressTuiDisplay));
      }
      current = { suppressTuiDisplay, messages: [] };
    }
    current.messages.push(message);
  }

  if (current !== undefined) {
    rendered.push(renderMessages(current.messages, current.suppressTuiDisplay));
  }
  return rendered;
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
  const stdout = result.stdout?.trim();
  return stdout === undefined || stdout.length === 0 ? undefined : stdout;
}

function isNonEmptyString(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function renderMessages(messages: readonly string[], suppressTuiDisplay = false): RenderedHookResult {
  const displayMessage = messages.join('\n\n');
  return {
    event: 'UserPromptSubmit',
    message: displayMessage,
    text: messages.map((message) => renderHookResult('UserPromptSubmit', message)).join('\n'),
    suppressTuiDisplay: suppressTuiDisplay ? true : undefined,
  };
}

function matchesDisplayFilter(
  result: HookResult,
  suppressTuiDisplay: boolean | undefined,
): boolean {
  if (suppressTuiDisplay === undefined) return true;
  return (result.suppressTuiDisplay === true) === suppressTuiDisplay;
}
