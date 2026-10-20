import {
  createHistoryMessageBuilder,
  systemReminderText,
  type HistoryMessage,
} from '@moonshot-ai/agent-core/history/index';
import { extractText } from '@moonshot-ai/agent-core/llm/message';
import type { LoopHooks } from '@moonshot-ai/agent-core/loop/index';
import type { Agent } from '@moonshot-ai/agent-core/session/index';

import TOWER_MODE_EXIT_REMINDER from './injection/tower-mode-exit-reminder.md?raw';
import TOWER_MODE_FULL_REMINDER from './injection/tower-mode-full-reminder.md?raw';
import TOWER_MODE_SPARSE_REMINDER from './injection/tower-mode-sparse-reminder.md?raw';
import { TOWER_REMIND_KEY } from './ops';

const TOWER_MODE_DEDUP_MIN_TURNS = 2;
const TOWER_MODE_FULL_REFRESH_TURNS = 5;

const EXIT_REMINDER_TEXT = systemReminderText(TOWER_MODE_EXIT_REMINDER);

type TowerReminderKind = 'full' | 'sparse' | 'exit';

export interface TowerInjectionState {
  injected?: boolean;
  lastWasExit?: boolean;
  inFlightFrom?: number;
  queued?: TowerReminderKind;
}

export function createTowerInjectionState(): TowerInjectionState {
  return {};
}

function isTowerReminder(entry: HistoryMessage): boolean {
  return entry.meta?.source === 'reminder' && entry.meta?.key === TOWER_REMIND_KEY;
}

function lastTowerReminderIndex(history: readonly HistoryMessage[]): number {
  return history.findLastIndex(isTowerReminder);
}

export function isExitReminder(entry: HistoryMessage): boolean {
  return extractText(entry.message) === EXIT_REMINDER_TEXT;
}

export function createTowerInjection(deps: {
  readonly ready: Promise<void>;
  readonly agent: Agent;
  readonly isActive: () => boolean;
  readonly state: TowerInjectionState;
}): LoopHooks['step.starting'] {
  const { ready, agent, isActive, state } = deps;

  const send = (kind: TowerReminderKind, atLength: number): void => {
    const text =
      kind === 'exit'
        ? TOWER_MODE_EXIT_REMINDER
        : kind === 'full'
          ? TOWER_MODE_FULL_REMINDER
          : TOWER_MODE_SPARSE_REMINDER;
    agent.loop.remind({
      message: createHistoryMessageBuilder().systemReminder(text).userMessage(),
      meta: { source: 'reminder', key: TOWER_REMIND_KEY },
    });
    state.inFlightFrom = atLength;
    state.injected = true;
    state.lastWasExit = kind === 'exit';
  };

  return async ({ messages }) => {
    await ready;
    if (state.injected === undefined) {
      const initialIndex = lastTowerReminderIndex(messages);
      state.injected = initialIndex !== -1;
      state.lastWasExit = initialIndex !== -1 && isExitReminder(messages[initialIndex]!);
    }
    if (state.inFlightFrom !== undefined && messages.slice(state.inFlightFrom).some(isTowerReminder)) {
      state.inFlightFrom = undefined;
      if (state.queued !== undefined) {
        const kind = state.queued;
        state.queued = undefined;
        send(kind, messages.length);
      }
    }
    const remind = (kind: TowerReminderKind): void => {
      if (state.inFlightFrom !== undefined) {
        state.queued = kind;
        return;
      }
      send(kind, messages.length);
    };

    if (!isActive()) {
      if (!state.injected || state.lastWasExit === true) return;
      remind('exit');
      return;
    }
    if (!state.injected || state.lastWasExit === true) {
      remind('full');
      return;
    }
    const landedAt = lastTowerReminderIndex(messages);
    const from = Math.max(landedAt, state.inFlightFrom ?? -1);
    let assistantTurns = 0;
    let userSeen = false;
    for (let i = from + 1; i < messages.length; i++) {
      const entry = messages[i];
      if (entry === undefined || isTowerReminder(entry)) continue;
      if (entry.message.role === 'assistant') {
        assistantTurns += 1;
        continue;
      }
      if (entry.message.role === 'user' && assistantTurns >= 1) {
        userSeen = true;
      }
    }
    if (userSeen || assistantTurns >= TOWER_MODE_FULL_REFRESH_TURNS) {
      remind('full');
    } else if (assistantTurns >= TOWER_MODE_DEDUP_MIN_TURNS) {
      remind('sparse');
    }
  };
}
