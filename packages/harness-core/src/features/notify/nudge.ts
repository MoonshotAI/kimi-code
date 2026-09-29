import type { HistoryMessage } from '@moonshot-ai/agent-core';

import { NOTIFY_USER_TOOL_NAME } from './tool';

export const NOTIFY_USER_NUDGE_THRESHOLD = 8;

function startsNewTurn(entry: HistoryMessage): boolean {
  const source = entry.meta?.source;
  return source === 'input' || source === 'notify';
}

export function toolCallsSinceLastNotify(history: readonly HistoryMessage[]): number {
  let count = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index]!;
    if (startsNewTurn(entry)) break;
    const message = entry.message;
    if (message.role !== 'assistant') continue;
    if (message.toolCalls.some((call) => call.name === NOTIFY_USER_TOOL_NAME)) break;
    count += message.toolCalls.length;
  }
  return count;
}

export function toolCallsSincePosition(
  history: readonly HistoryMessage[],
  position: number,
): number {
  let count = 0;
  for (const entry of history.slice(position + 1)) {
    if (entry.message.role !== 'assistant') continue;
    count += entry.message.toolCalls.length;
  }
  return count;
}

export function lastMidResponsePosition(history: readonly HistoryMessage[]): number {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index]!;
    if (startsNewTurn(entry)) break;
    const message = entry.message;
    if (message.role !== 'assistant') continue;
    if (message.toolCalls.some((call) => call.name === NOTIFY_USER_TOOL_NAME)) break;
    const hasVisibleText = message.content.some(
      (part) => part.type === 'text' && part.text.trim().length > 0,
    );
    if (hasVisibleText) return index;
  }
  return -1;
}

export function lastReminderPosition(
  history: readonly HistoryMessage[],
  key: string,
): number | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index]!;
    if (entry.meta?.source === 'reminder' && entry.meta?.key === key) return index;
  }
  return null;
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
