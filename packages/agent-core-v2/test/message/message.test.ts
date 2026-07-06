import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService, type ContextMessage } from '#/agent/contextMemory';
import { AgentContextMemoryService } from '#/agent/contextMemory/contextMemoryService';
import { IAgentWireRecordService } from '#/agent/wireRecord';
import { stubWireRecord } from '../contextMemory/stubs';

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

// NOTE: the legacy `IMessageService` (which projected context history into
// `ProtocolMessage`s with derived `msg-N` ids) was removed
// (see commit `chore: remove IMessageService`). Message history now lives on
// `IAgentContextMemoryService`, so these cases exercise that history directly instead of
// the deleted derived-id projection.

describe('message history (IAgentContextMemoryService)', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IAgentWireRecordService, stubWireRecord());
    ix.set(IAgentContextMemoryService, new SyncDescriptor(AgentContextMemoryService));
  });
  afterEach(() => disposables.dispose());

  it('round-trips user/assistant messages with their text content', () => {
    const ctx = ix.get(IAgentContextMemoryService);
    ctx.splice(0, 0, [textMessage('user', 'a')]);
    ctx.splice(1, 0, [textMessage('assistant', 'b')]);

    const history = ctx.get();
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(history.map(textOf)).toEqual(['a', 'b']);
  });

  it('returns a defensive copy from getHistory', () => {
    const ctx = ix.get(IAgentContextMemoryService);
    ctx.splice(0, 0, [textMessage('user', 'keep')]);

    const view = ctx.get();
    (view as ContextMessage[]).splice(0, view.length);

    expect(ctx.get().map(textOf)).toEqual(['keep']);
  });

  it('stamps a msg_<ulid> id on messages that lack one', () => {
    const ctx = ix.get(IAgentContextMemoryService);
    ctx.splice(0, 0, [textMessage('user', 'hello')]);

    const [message] = ctx.get();
    expect(message?.id).toMatch(/^msg_[0-9A-Z]{26}$/);
  });

  it('preserves an existing message id (idempotent)', () => {
    const ctx = ix.get(IAgentContextMemoryService);
    const existing: ContextMessage = {
      ...textMessage('user', 'keep'),
      id: 'msg_01HXQM8K7Z3V9N2P5R6T8W0Y1B',
    };
    ctx.splice(0, 0, [existing]);

    const [message] = ctx.get();
    expect(message?.id).toBe('msg_01HXQM8K7Z3V9N2P5R6T8W0Y1B');
  });
});
