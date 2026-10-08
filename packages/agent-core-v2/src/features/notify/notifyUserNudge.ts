import type { ContextMessage } from '#/agent/contextMemory/types';

import { NOTIFY_USER_TOOL_NAME } from './tools/notify-user/notify-user';

export const NOTIFY_USER_NUDGE_VARIANT = 'notify_user_nudge';
export const NOTIFY_USER_NUDGE_THRESHOLD = 8;

function startsNewTurn(message: ContextMessage): boolean {
  const origin = message.origin;
  if (origin === undefined) return false;
  switch (origin.kind) {
    case 'user':
    case 'cron_job':
    case 'cron_missed':
    case 'task':
    case 'retry':
      return true;
    case 'system_trigger':
      return origin.name !== 'stop_hook';
    case 'skill_activation':
      return origin.trigger === 'user-slash';
    case 'plugin_command':
      return true;
    default:
      return false;
  }
}

export function toolCallsSinceLastNotify(history: readonly ContextMessage[]): number {
  let count = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    if (startsNewTurn(message)) break;
    if (message.role !== 'assistant') continue;
    if (message.toolCalls.some((call) => call.name === NOTIFY_USER_TOOL_NAME)) break;
    count += message.toolCalls.length;
  }
  return count;
}

export function toolCallsSincePosition(
  history: readonly ContextMessage[],
  position: number,
): number {
  let count = 0;
  for (const message of history.slice(position + 1)) {
    if (message.role !== 'assistant') continue;
    count += message.toolCalls.length;
  }
  return count;
}

export function lastMidResponsePosition(history: readonly ContextMessage[]): number {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    if (startsNewTurn(message)) break;
    if (message.role !== 'assistant') continue;
    if (message.toolCalls.some((call) => call.name === NOTIFY_USER_TOOL_NAME)) break;
    const hasVisibleText = message.content.some(
      (part) => part.type === 'text' && part.text.trim().length > 0,
    );
    if (hasVisibleText) return index;
  }
  return -1;
}

export function shouldNudgeNotifyUser(
  streak: number,
  callsSinceLastNudge: number | null,
): boolean {
  if (streak < NOTIFY_USER_NUDGE_THRESHOLD) return false;
  return callsSinceLastNudge === null || callsSinceLastNudge >= NOTIFY_USER_NUDGE_THRESHOLD;
}

export function shouldNudgeMidResponse(
  midResponsePosition: number,
  lastInjectedAt: number | null,
): boolean {
  if (midResponsePosition < 0) return false;
  return lastInjectedAt === null || lastInjectedAt < midResponsePosition;
}

export function renderNotifyUserNudge(count: number): string {
  return `You have gone ${String(count)} tool calls without a NotifyUser update — the user has seen nothing in the meantime. Send one now: a structured, chat-style update (a well structured paragraph with a few bullet points, under ~1000 characters) covering what you have concluded so far and what you will do next, batched with your next tool calls.`;
}

export function renderMidResponseHint(): string {
  return 'You just sent a mid-turn text reply — easy for the user to miss between tool calls. Repost its substance as a NotifyUser update (a short intro plus a few bullet points), batched with your next tool calls, then continue.';
}
