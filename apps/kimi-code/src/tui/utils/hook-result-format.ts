import type { HookResultEvent } from '@moonshot-ai/kimi-code-sdk';

export function formatHookResultMarkdown(event: HookResultEvent): string {
  return `*${formatHookResultTitle(event)}*\n\n${formatHookResultBody(event)}`;
}

export function formatHookResultPlain(event: HookResultEvent): string {
  return `${formatHookResultTitle(event)}\n\n${formatHookResultBody(event)}`;
}

function formatHookResultTitle(event: HookResultEvent): string {
  return `${event.hookEvent} hook${event.blocked === true ? ' blocked' : ''}`;
}

function formatHookResultBody(event: HookResultEvent): string {
  // Malformed/provider-quirk wire records can arrive without content (the
  // provider may omit the hook result payload — JSON serialization then drops
  // the key). Coerce instead of crashing.
  const content = typeof event.content === 'string' ? event.content : '';
  const trimmed = content.trim();
  return trimmed.length === 0 ? '(empty)' : trimmed;
}
