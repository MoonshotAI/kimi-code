import {
  createHistoryMessageBuilder,
  extractText,
  systemReminderText,
  type AgentCommands,
  type HistoryMessage,
  type TurnBeforeStep,
} from '@moonshot-ai/agent-core';

import TOWER_MODE_EXIT_REMINDER from './injection/tower-mode-exit-reminder.md?raw';
import TOWER_MODE_FULL_REMINDER from './injection/tower-mode-full-reminder.md?raw';
import TOWER_MODE_SPARSE_REMINDER from './injection/tower-mode-sparse-reminder.md?raw';
import { TOWER_REMIND_KEY } from './ops';

const TOWER_MODE_DEDUP_MIN_TURNS = 2;
const TOWER_MODE_FULL_REFRESH_TURNS = 5;

type TowerReminderKind = 'full' | 'sparse' | 'exit';

function isTowerReminder(entry: HistoryMessage): boolean {
  return entry.meta?.source === 'reminder' && entry.meta?.key === TOWER_REMIND_KEY;
}

function lastTowerReminderIndex(history: readonly HistoryMessage[]): number {
  return history.findLastIndex(isTowerReminder);
}

export function isExitReminder(entry: HistoryMessage): boolean {
  return extractText(entry.message) === systemReminderText(TOWER_MODE_EXIT_REMINDER);
}

export function createTowerInjection(deps: {
  readonly agent: AgentCommands;
  readonly isActive: () => boolean;
  readonly history: readonly HistoryMessage[];
}): TurnBeforeStep {
  const { agent, isActive } = deps;
  const initialIndex = lastTowerReminderIndex(deps.history);
  let injected = initialIndex !== -1;
  let lastWasExit = initialIndex !== -1 && isExitReminder(deps.history[initialIndex]!);
  let inFlightFrom: number | undefined;
  let queued: TowerReminderKind | undefined;

  const send = (kind: TowerReminderKind, atLength: number): void => {
    const text =
      kind === 'exit'
        ? TOWER_MODE_EXIT_REMINDER
        : kind === 'full'
          ? TOWER_MODE_FULL_REMINDER
          : TOWER_MODE_SPARSE_REMINDER;
    agent.remind(createHistoryMessageBuilder().systemReminder(text).userMessage(), {
      key: TOWER_REMIND_KEY,
    });
    inFlightFrom = atLength;
    injected = true;
    lastWasExit = kind === 'exit';
  };

  return ({ messages }) => {
    if (inFlightFrom !== undefined && messages.slice(inFlightFrom).some(isTowerReminder)) {
      inFlightFrom = undefined;
      if (queued !== undefined) {
        const kind = queued;
        queued = undefined;
        send(kind, messages.length);
      }
    }
    const remind = (kind: TowerReminderKind): void => {
      if (inFlightFrom !== undefined) {
        queued = kind;
        return;
      }
      send(kind, messages.length);
    };

    if (!isActive()) {
      if (!injected || lastWasExit) return;
      remind('exit');
      return;
    }
    if (!injected || lastWasExit) {
      remind('full');
      return;
    }
    const landedAt = lastTowerReminderIndex(messages);
    const from = Math.max(landedAt, inFlightFrom ?? -1);
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
