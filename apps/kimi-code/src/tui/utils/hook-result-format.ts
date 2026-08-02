import type { EngineHookResultEvent } from '@moonshot-ai/kimi-code-sdk';

export function formatHookResultMarkdown(event: EngineHookResultEvent): string {
  return `*${formatHookResultTitle(event)}*\n\n${formatHookResultBody(event)}`;
}

export function formatHookResultPlain(event: EngineHookResultEvent): string {
  return `${formatHookResultTitle(event)}\n\n${formatHookResultBody(event)}`;
}

function formatHookResultTitle(event: EngineHookResultEvent): string {
  return `${event.hook_event} hook${event.blocked === true ? ' blocked' : ''}`;
}

function formatHookResultBody(event: EngineHookResultEvent): string {
  const content = event.content.trim();
  return content.length === 0 ? '(empty)' : content;
}
