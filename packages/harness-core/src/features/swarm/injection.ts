import {
  createHistoryMessageBuilder,
  extractText,
  systemReminderText,
  type AgentCommands,
  type HistoryMessage,
  type TurnBeforeStep,
} from '@moonshot-ai/agent-core';
import type { ShallowRef } from '@moonshot-ai/agent-core/kernel/index';

import SWARM_MODE_ENTER_REMINDER from './enter-reminder.md?raw';
import SWARM_MODE_EXIT_REMINDER from './exit-reminder.md?raw';
import { SWARM_REMIND_KEY, type SwarmModeState } from './ops';

export function createSwarmInjection(deps: {
  readonly agent: AgentCommands;
  readonly state: ShallowRef<SwarmModeState>;
  readonly history: readonly HistoryMessage[];
}): TurnBeforeStep {
  const { agent, state } = deps;
  let rendered = lastRenderedSwarmState(deps.history);
  return () => {
    const trigger = state.value.trigger;
    const active = trigger !== null && trigger !== 'tool';
    if (active) {
      if (rendered === 'active') return;
      rendered = 'active';
      agent.remind(
        createHistoryMessageBuilder().systemReminder(SWARM_MODE_ENTER_REMINDER).userMessage(),
        { key: SWARM_REMIND_KEY },
      );
      return;
    }
    if (rendered !== 'active') return;
    rendered = 'inactive';
    agent.remind(
      createHistoryMessageBuilder().systemReminder(SWARM_MODE_EXIT_REMINDER).userMessage(),
      { key: SWARM_REMIND_KEY },
    );
  };
}

function lastRenderedSwarmState(
  history: readonly HistoryMessage[],
): 'active' | 'inactive' | undefined {
  const entry = history.findLast(
    (candidate) =>
      candidate.meta?.source === 'reminder' && candidate.meta?.key === SWARM_REMIND_KEY,
  );
  if (entry === undefined) return undefined;
  return extractText(entry.message) === systemReminderText(SWARM_MODE_EXIT_REMINDER)
    ? 'inactive'
    : 'active';
}
