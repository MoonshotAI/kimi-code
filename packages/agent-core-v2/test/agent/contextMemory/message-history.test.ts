import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { HistoryMessage } from '#human/agent/turn';
import { AgentContextMemoryService } from '#/agent/contextMemory/contextMemoryService';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';

import { registerTestAgentWire, registerTestEventDispatcher } from '../../wire/stubs';

function textMessage(role: 'user' | 'assistant', text: string): HistoryMessage {
  return role === 'user'
    ? { message: { role, content: [{ type: 'text', text }] } }
    : { message: { role, content: [{ type: 'text', text }], toolCalls: [] } };
}

function textOf(entry: HistoryMessage): string {
  return entry.message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

const noopTokenCounting: ISessionTokenCountingService = {
  _serviceBrand: undefined,
  strategy: 'measured+estimated',
  get: () => ({ size: 0, measured: 0, estimated: 0 }),
  measured: () => {},
  latestMeasured: () => 0,
  statusSize: () => 0,
  recordTruncation: () => {},
  rebase: () => {},
  requestSize: () => 0,
  estimateText: () => 0,
  estimateMessage: () => 0,
  estimateMessages: () => 0,
  estimateTools: () => 0,
};


describe('message history (IAgentContextMemoryService)', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    registerTestAgentWire(ix, 'wire/message-history', { eventBus: ix.get(IEventBus) });
    ix.set(ISessionTokenCountingService, noopTokenCounting);
    registerTestEventDispatcher(ix);
    ix.set(IAgentContextMemoryService, new SyncDescriptor(AgentContextMemoryService));
  });
  afterEach(() => disposables.dispose());

  it('round-trips user/assistant messages with their text content', () => {
    const ctx = ix.get(IAgentContextMemoryService);
    ctx.append(textMessage('user', 'a'));
    ctx.append(textMessage('assistant', 'b'));

    const history = ctx.get();
    expect(history.map((entry) => entry.message.role)).toEqual(['user', 'assistant']);
    expect(history.map(textOf)).toEqual(['a', 'b']);
  });

  it('returns a defensive copy from getHistory', () => {
    const ctx = ix.get(IAgentContextMemoryService);
    ctx.append(textMessage('user', 'keep'));

    const view = ctx.get();
    expect(() => (view as HistoryMessage[]).splice(0, view.length)).toThrow();

    expect(ctx.get().map(textOf)).toEqual(['keep']);
  });

  it('does not stamp local ids on appended messages (ids are not persisted)', () => {
    const ctx = ix.get(IAgentContextMemoryService);
    ctx.append(textMessage('user', 'hello'));

    const [entry] = ctx.get();
    expect(entry).toMatchObject({ message: { role: 'user' } });
    expect(entry).not.toHaveProperty('meta.promptId');
  });

  it('preserves an existing message id (idempotent)', () => {
    const ctx = ix.get(IAgentContextMemoryService);
    const existing: HistoryMessage = {
      message: { role: 'user', content: [{ type: 'text', text: 'keep' }] },
      meta: { promptId: 'msg_01HXQM8K7Z3V9N2P5R6T8W0Y1B' },
    };
    ctx.append(existing);

    const [entry] = ctx.get();
    expect(entry).toMatchObject({ meta: { promptId: 'msg_01HXQM8K7Z3V9N2P5R6T8W0Y1B' } });
  });
});
