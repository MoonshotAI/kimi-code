import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import {
  AgentContextMemory,
  type ContextMemoryRuntime,
} from '#/actor/contextMemory/contextMemoryAgentRuntime';
import type { ContextMessage } from '#/actor/contextMemory/types';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import { IEventBus } from '#/app/event/eventBus';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { EventBusService } from '#/app/event/eventBusService';

import {
  attachContextMemoryRuntime,
  registerTestAgentWire,
  registerTestEventDispatcher,
  stubAgentScopeContext,
} from '../../wire/stubs';

function textMessage(role: ContextMessage['role'], text: string): ContextMessage {
  return {
    role,
    content: [{ type: 'text', text }],
    toolCalls: [],
  };
}

function textOf(message: ContextMessage): string {
  return message.content
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

describe('message history (AgentContextMemory)', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let ctx: ContextMemoryRuntime;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    const agentScope = stubAgentScopeContext('wire/message-history');
    registerTestAgentWire(ix, agentScope, { eventBus: ix.get(IEventBus) });
    ix.set(ISessionTokenCountingService, noopTokenCounting);
    registerTestEventDispatcher(ix, agentScope);
    const runtimes = attachContextMemoryRuntime(ix, ix.get(IEventDispatcher), agentScope.agentContext);
    disposables.add({ dispose: () => { void runtimes.close(); } });
    ctx = runtimes.resolve(AgentContextMemory);
  });
  afterEach(() => disposables.dispose());

  it('round-trips user/assistant messages with their text content', () => {
    void ctx.append(textMessage('user', 'a'));
    void ctx.append(textMessage('assistant', 'b'));

    const history = ctx.get();
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(history.map(textOf)).toEqual(['a', 'b']);
  });

  it('returns a defensive copy from getHistory', () => {
    void ctx.append(textMessage('user', 'keep'));

    const view = ctx.get();
    expect(() => (view as ContextMessage[]).splice(0, view.length)).toThrow();

    expect(ctx.get().map(textOf)).toEqual(['keep']);
  });

  it('does not stamp local ids on appended messages (ids are not persisted)', () => {
    void ctx.append(textMessage('user', 'hello'));

    const [message] = ctx.get();
    expect(message?.id).toBeUndefined();
  });

  it('preserves an existing message id (idempotent)', () => {
    const existing: ContextMessage = {
      ...textMessage('user', 'keep'),
      id: 'msg_01HXQM8K7Z3V9N2P5R6T8W0Y1B',
    };
    void ctx.append(existing);

    const [message] = ctx.get();
    expect(message?.id).toBe('msg_01HXQM8K7Z3V9N2P5R6T8W0Y1B');
  });
});
