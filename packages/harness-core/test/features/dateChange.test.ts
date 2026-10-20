import { describe, expect, it } from 'vitest';

import { createUserEntry, type HistoryMessage } from '@moonshot-ai/agent-core/history/index';
import {
  createAssistantMessage,
  createUserMessage,
  extractText,
  type Message,
} from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';

import {
  DATE_CHANGE_REMIND_KEY,
  createDateChange,
  dateChangeReminder,
  initialDateReminder,
} from '#/features/dateChange/index';
import { createHarness, harnessInternals, memoryHarnessSpace, type Harness } from '#/runtime/harness';

function user(text: string) {
  return createUserEntry(createUserMessage(text), { source: 'input' });
}

function setRequester(
  harness: Harness,
  sessionId: string,
  agentId: string,
  requester: LoopLlmRequester,
): void {
  const session = harness.app.sessions.get(sessionId);
  const runtime =
    session !== undefined ? harnessInternals(harness.app).agents.get(session)?.get(agentId) : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

function capturingRequester(captured: Message[][]): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async (rest) => {
      captured.push([...(rest.content?.messages ?? [])]);
      return { type: 'done', message: createAssistantMessage([{ type: 'text', text: 'ok' }]) };
    },
  };
  return self;
}

function requestAt(requests: readonly Message[][], index: number): readonly Message[] {
  const request = requests[index];
  if (request === undefined) throw new Error(`request ${index} was not captured`);
  return request;
}

function lastText(messages: readonly Message[]): string {
  const last = messages.at(-1);
  if (last === undefined) throw new Error('request carried no messages');
  return extractText(last);
}

function reminderEntries(history: readonly HistoryMessage[]): readonly HistoryMessage[] {
  return history.filter((entry) => entry.meta?.key === DATE_CHANGE_REMIND_KEY);
}

describe('dateChange feature', () => {
  it('injects the initial date reminder into the first request and stays silent while the date is unchanged', async () => {
    const current = new Date('2026-10-19T10:00:00Z');
    const harness = createHarness({ space: memoryHarnessSpace() });
    await harness.app.features.add(createDateChange({ now: () => current, timeZone: 'UTC' }));
    const session = await harness.app.create({ sessionId: 's1' });
    const agent = await harness.ensureAgent(session, 'main');
    const requests: Message[][] = [];
    setRequester(harness, 's1', 'main', capturingRequester(requests));

    const first = await agent.loop.runTurn(user('hello'));
    expect(first.type).toBe('done');
    expect(requests).toHaveLength(1);
    expect(lastText(requestAt(requests, 0))).toContain(initialDateReminder('2026-10-19'));

    await agent.flush();
    const disclosed = reminderEntries(agent.view.getState().messages);
    expect(disclosed).toHaveLength(1);
    expect(disclosed[0]?.meta?.source).toBe('reminder');

    const second = await agent.loop.runTurn(user('still here'));
    expect(second.type).toBe('done');
    expect(requests).toHaveLength(2);
    const carried = requestAt(requests, 1).filter((message) =>
      extractText(message).includes("Today's date is"),
    );
    expect(carried).toHaveLength(1);

    await agent.flush();
    expect(reminderEntries(agent.view.getState().messages)).toHaveLength(1);
    await harness.close();
  });

  it('injects a date-change reminder when the local date has moved on', async () => {
    let current = new Date('2026-10-19T10:00:00Z');
    const harness = createHarness({ space: memoryHarnessSpace() });
    await harness.app.features.add(createDateChange({ now: () => current, timeZone: 'UTC' }));
    const session = await harness.app.create({ sessionId: 's1' });
    const agent = await harness.ensureAgent(session, 'main');
    const requests: Message[][] = [];
    setRequester(harness, 's1', 'main', capturingRequester(requests));

    const first = await agent.loop.runTurn(user('hello'));
    expect(first.type).toBe('done');
    expect(lastText(requestAt(requests, 0))).toContain(initialDateReminder('2026-10-19'));

    current = new Date('2026-10-20T09:00:00Z');
    const second = await agent.loop.runTurn(user('next day'));
    expect(second.type).toBe('done');
    expect(requests).toHaveLength(2);
    expect(lastText(requestAt(requests, 1))).toContain(dateChangeReminder('2026-10-20'));

    await agent.flush();
    const disclosed = reminderEntries(agent.view.getState().messages);
    expect(disclosed).toHaveLength(2);
    const changed = disclosed[1];
    if (changed === undefined) throw new Error('date-change reminder was not recorded');
    expect(extractText(changed.message)).toContain(dateChangeReminder('2026-10-20'));
    await harness.close();
  });
});
