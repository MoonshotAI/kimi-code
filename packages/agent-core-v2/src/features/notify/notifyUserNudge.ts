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

function isToolCallRound(message: ContextMessage): boolean {
  return message.role === 'assistant' && message.toolCalls.length > 0;
}

function isNudge(message: ContextMessage): boolean {
  return message.origin?.kind === 'injection' && message.origin.variant === NOTIFY_USER_NUDGE_VARIANT;
}

export interface NotifyStreak {
  readonly rounds: number;
  readonly nudges: number;
}

export function notifyStreak(history: readonly ContextMessage[]): NotifyStreak {
  let rounds = 0;
  let nudges = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    if (startsNewTurn(message)) break;
    if (isNudge(message)) nudges += 1;
    if (!isToolCallRound(message)) continue;
    if (message.toolCalls.some((call) => call.name === NOTIFY_USER_TOOL_NAME)) break;
    rounds += 1;
  }
  return { rounds, nudges };
}

export function notifyStreakBefore(
  history: readonly ContextMessage[],
  toolCallId: string,
): NotifyStreak {
  const index = history.findLastIndex(
    (message) =>
      message.role === 'assistant' && message.toolCalls.some((call) => call.id === toolCallId),
  );
  return notifyStreak(index === -1 ? history : history.slice(0, index));
}

export function toolCallRoundsSincePosition(
  history: readonly ContextMessage[],
  position: number,
): number {
  return history.slice(position + 1).filter(isToolCallRound).length;
}

export function shouldNudgeNotifyUser(
  streak: number,
  roundsSinceLastNudge: number | null,
): boolean {
  if (streak < NOTIFY_USER_NUDGE_THRESHOLD) return false;
  return roundsSinceLastNudge === null || roundsSinceLastNudge >= NOTIFY_USER_NUDGE_THRESHOLD;
}

export function renderNotifyUserNudge(count: number): string {
  return `You have gone through ${String(count)} rounds of tool calls without a NotifyUser update — the Updates panel has shown nothing new since. Send one now: a structured, chat-style update (a well structured paragraph with a few bullet points, under ~1000 characters) covering what you have concluded so far and what you will do next, batched with your next tool calls.`;
}
