import {
  createHistoryMessageBuilder,
  type AgentCommands,
  type HistoryMessage,
  type TurnBeforeStep,
} from '@moonshot-ai/agent-core';
import type { ShallowRef } from '@moonshot-ai/agent-core/kernel/index';

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

export function createPlanInjection(deps: {
  readonly planPath: () => string | null;
  readonly status: () => Promise<PlanData | null>;
  readonly agent: AgentCommands;
  readonly state: ShallowRef<PlanState>;
}): TurnBeforeStep {
  const { planPath, status, agent, state } = deps;
  let wasActive = state.value.wasActive;
  let scanFrom: number | undefined;
  let pendingAssistantTurns = 0;
  let pendingUserMessage = false;
  let inFlightFrom: number | undefined;
  let queued: string | undefined;

  const send = (text: string, atLength: number): void => {
    agent.remind(
      createHistoryMessageBuilder().systemReminder(text).userMessage(),
      { key: PLAN_REMIND_KEY },
    );
    inFlightFrom = atLength;
  };

  return async ({ messages }) => {
    if (inFlightFrom !== undefined && messages.slice(inFlightFrom).some(isPlanReminder)) {
      inFlightFrom = undefined;
      if (queued !== undefined) {
        const text = queued;
        queued = undefined;
        send(text, messages.length);
      }
    }
    const remind = (text: string): void => {
      if (inFlightFrom !== undefined) {
        queued = text;
        return;
      }
      send(text, messages.length);
    };
    const current = state.value;
    if (!current.active || current.id === undefined) {
      if (!wasActive) return;
      wasActive = false;
      pendingAssistantTurns = 0;
      pendingUserMessage = false;
      scanFrom = messages.length - 1;
      remind(PLAN_MODE_EXIT_REMINDER);
      return;
    }
    const path = planPath();
    if (!wasActive) {
      const current = await status();
      const content = current?.content ?? '';
      wasActive = true;
      pendingAssistantTurns = 0;
      pendingUserMessage = false;
      scanFrom = messages.length - 1;
      remind(content.trim().length > 0 ? reentryReminder(path) : fullReminder(path));
      return;
    }
    const from = scanFrom ?? lastPlanReminderIndex(messages);
    for (let i = from + 1; i < messages.length; i++) {
      const entry = messages[i];
      if (entry === undefined) continue;
      if (isPlanReminder(entry)) continue;
      if (entry.message.role === 'assistant') {
        pendingAssistantTurns += 1;
        continue;
      }
      if (entry.message.role === 'user') {
        pendingUserMessage = true;
      }
    }
    scanFrom = messages.length - 1;
    if (pendingUserMessage || pendingAssistantTurns >= PLAN_MODE_FULL_REFRESH_TURNS) {
      pendingAssistantTurns = 0;
      pendingUserMessage = false;
      remind(fullReminder(path));
    } else if (pendingAssistantTurns >= PLAN_MODE_DEDUP_MIN_TURNS) {
      pendingAssistantTurns = 0;
      pendingUserMessage = false;
      remind(sparseReminder(path));
    }
  };
}

function isPlanReminder(entry: HistoryMessage): boolean {
  return entry.meta?.source === 'reminder' && entry.meta?.key === PLAN_REMIND_KEY;
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
