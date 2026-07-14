import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { AgentContextMemoryService } from '#/agent/contextMemory/contextMemoryService';
import { IAgentWireRecordService } from '#/agent/wireRecord/wireRecord';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { IAgentWireService } from '#/wire/tokens';
import { WireService } from '#/wire/wireServiceImpl';
import { stubWireRecord } from './stubs';

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


describe('message history (IAgentContextMemoryService)', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IAgentWireRecordService, stubWireRecord());
    ix.set(IAgentWireService, new SyncDescriptor(WireService, [{ logScope: 'wire', logKey: 'message' }]));
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    ix.set(IAgentContextMemoryService, new SyncDescriptor(AgentContextMemoryService));
  });
  afterEach(() => disposables.dispose());

  it('round-trips user/assistant messages with their text content', () => {
    const ctx = ix.get(IAgentContextMemoryService);
    ctx.append(textMessage('user', 'a'));
    ctx.append(textMessage('assistant', 'b'));

    const history = ctx.get();
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(history.map(textOf)).toEqual(['a', 'b']);
  });

  it('returns a defensive copy from getHistory', () => {
    const ctx = ix.get(IAgentContextMemoryService);
    ctx.append(textMessage('user', 'keep'));

    const view = ctx.get();
    expect(() => (view as ContextMessage[]).splice(0, view.length)).toThrow();

    expect(ctx.get().map(textOf)).toEqual(['keep']);
  });

  it('does not stamp local ids on appended messages (ids are not persisted)', () => {
    const ctx = ix.get(IAgentContextMemoryService);
    ctx.append(textMessage('user', 'hello'));

    const [message] = ctx.get();
    expect(message?.id).toBeUndefined();
  });

  it('preserves an existing message id (idempotent)', () => {
    const ctx = ix.get(IAgentContextMemoryService);
    const existing: ContextMessage = {
      ...textMessage('user', 'keep'),
      id: 'msg_01HXQM8K7Z3V9N2P5R6T8W0Y1B',
    };
    ctx.append(existing);

    const [message] = ctx.get();
    expect(message?.id).toBe('msg_01HXQM8K7Z3V9N2P5R6T8W0Y1B');
  });
});
