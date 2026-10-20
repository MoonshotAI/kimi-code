import { createHistoryMessageBuilder, systemReminderText, type HistoryMessage } from '@moonshot-ai/agent-core/history/index';
import { extractText } from '@moonshot-ai/agent-core/llm/message';
import type { LoopHooks } from '@moonshot-ai/agent-core/loop/index';
import type { Agent } from '@moonshot-ai/agent-core/session/index';

import PLAN_MODE_EXIT_REMINDER from './injection/plan-mode-exit-reminder.md?raw';
import PLAN_MODE_FULL_REMINDER from './injection/plan-mode-full-reminder.md?raw';
import PLAN_MODE_INLINE_FULL_REMINDER from './injection/plan-mode-inline-full-reminder.md?raw';
import PLAN_MODE_INLINE_REENTRY_REMINDER from './injection/plan-mode-inline-reentry-reminder.md?raw';
import PLAN_MODE_INLINE_SPARSE_REMINDER from './injection/plan-mode-inline-sparse-reminder.md?raw';
import PLAN_MODE_REENTRY_REMINDER from './injection/plan-mode-reentry-reminder.md?raw';
import PLAN_MODE_SPARSE_REMINDER from './injection/plan-mode-sparse-reminder.md?raw';
import { PLAN_REMIND_KEY, type PlanState } from './projection';
import type { PlanData } from './storage';

const PLAN_MODE_DEDUP_MIN_TURNS = 2;
const PLAN_MODE_FULL_REFRESH_TURNS = 5;

const EXIT_REMINDER_TEXT = systemReminderText(PLAN_MODE_EXIT_REMINDER);

export interface PlanInjectionState {
  wasActive?: boolean;
  scanFrom?: number;
  pendingAssistantTurns: number;
  pendingUserMessage: boolean;
  inFlightFrom?: number;
  queued?: string;
}

export function createPlanInjectionState(): PlanInjectionState {
  return { pendingAssistantTurns: 0, pendingUserMessage: false };
}

export function createPlanInjection(deps: {
  readonly ready: Promise<void>;
  readonly planPath: () => string | null;
  readonly status: () => Promise<PlanData | null>;
  readonly planState: () => PlanState;
  readonly agent: Agent;
  readonly state: PlanInjectionState;
}): LoopHooks['step.starting'] {
  const { ready, planPath, status, planState, agent, state } = deps;

  const send = (text: string, atLength: number): void => {
    agent.loop.remind({
      message: createHistoryMessageBuilder().systemReminder(text).userMessage(),
      meta: { source: 'reminder', key: PLAN_REMIND_KEY },
    });
    state.inFlightFrom = atLength;
  };

  return async ({ messages }) => {
    await ready;
    if (state.inFlightFrom !== undefined && messages.slice(state.inFlightFrom).some(isPlanReminder)) {
      state.inFlightFrom = undefined;
      if (state.queued !== undefined) {
        const text = state.queued;
        state.queued = undefined;
        send(text, messages.length);
      }
    }
    const remind = (text: string): void => {
      if (state.inFlightFrom !== undefined) {
        state.queued = text;
        return;
      }
      send(text, messages.length);
    };
    state.wasActive ??= wasActiveFromHistory(messages);
    const current = planState();
    if (!current.active || current.id === undefined) {
      if (state.wasActive !== true) return;
      state.wasActive = false;
      state.pendingAssistantTurns = 0;
      state.pendingUserMessage = false;
      state.scanFrom = messages.length - 1;
      remind(PLAN_MODE_EXIT_REMINDER);
      return;
    }
    const path = planPath();
    if (state.wasActive !== true) {
      const current = await status();
      const content = current?.content ?? '';
      state.wasActive = true;
      state.pendingAssistantTurns = 0;
      state.pendingUserMessage = false;
      state.scanFrom = messages.length - 1;
      remind(content.trim().length > 0 ? reentryReminder(path) : fullReminder(path));
      return;
    }
    const from = state.scanFrom ?? lastPlanReminderIndex(messages);
    for (let i = from + 1; i < messages.length; i++) {
      const entry = messages[i];
      if (entry === undefined) continue;
      if (isPlanReminder(entry)) continue;
      if (entry.message.role === 'assistant') {
        state.pendingAssistantTurns += 1;
        continue;
      }
      if (entry.message.role === 'user') {
        state.pendingUserMessage = true;
      }
    }
    state.scanFrom = messages.length - 1;
    if (state.pendingUserMessage || state.pendingAssistantTurns >= PLAN_MODE_FULL_REFRESH_TURNS) {
      state.pendingAssistantTurns = 0;
      state.pendingUserMessage = false;
      remind(fullReminder(path));
    } else if (state.pendingAssistantTurns >= PLAN_MODE_DEDUP_MIN_TURNS) {
      state.pendingAssistantTurns = 0;
      state.pendingUserMessage = false;
      remind(sparseReminder(path));
    }
  };
}

function isPlanReminder(entry: HistoryMessage): boolean {
  return entry.meta?.source === 'reminder' && entry.meta?.key === PLAN_REMIND_KEY;
}

function wasActiveFromHistory(messages: readonly HistoryMessage[]): boolean {
  const index = lastPlanReminderIndex(messages);
  if (index < 0) return false;
  const entry = messages[index];
  return entry !== undefined && extractText(entry.message) !== EXIT_REMINDER_TEXT;
}

function lastPlanReminderIndex(history: readonly HistoryMessage[]): number {
  return history.findLastIndex(isPlanReminder);
}

function withPlanFileFooter(body: string, planFilePath: string | null): string {
  if (planFilePath === null || planFilePath.length === 0) return body;
  return `${body}\n\nPlan file: ${planFilePath}`;
}

function fullReminder(planFilePath: string | null): string {
  if (planFilePath === null || planFilePath.length === 0) {
    return PLAN_MODE_INLINE_FULL_REMINDER;
  }
  return withPlanFileFooter(PLAN_MODE_FULL_REMINDER, planFilePath);
}

function sparseReminder(planFilePath: string | null): string {
  if (planFilePath === null || planFilePath.length === 0) {
    return PLAN_MODE_INLINE_SPARSE_REMINDER;
  }
  return withPlanFileFooter(PLAN_MODE_SPARSE_REMINDER, planFilePath);
}

function reentryReminder(planFilePath: string | null): string {
  if (planFilePath === null || planFilePath.length === 0) {
    return PLAN_MODE_INLINE_REENTRY_REMINDER;
  }
  return withPlanFileFooter(PLAN_MODE_REENTRY_REMINDER, planFilePath);
}
