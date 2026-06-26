import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IContextMemory, type ContextMessage } from '#/contextMemory';
import { ContextMemoryService } from '#/contextMemory/contextMemoryService';
import { IReplayBuilderService } from '#/replayBuilder';
import { IWireRecord } from '#/wireRecord';
import { stubReplayBuilder, stubWireRecord } from '../contextMemory/stubs';

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
// `IContextMemory`, so these cases exercise that history directly instead of
// the deleted derived-id projection.

describe('message history (IContextMemory)', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IWireRecord, stubWireRecord());
    ix.stub(IReplayBuilderService, stubReplayBuilder());
    ix.set(IContextMemory, new SyncDescriptor(ContextMemoryService));
  });
  afterEach(() => disposables.dispose());

  it('round-trips user/assistant messages with their text content', () => {
    const ctx = ix.get(IContextMemory);
    ctx.spliceHistory(0, 0, [textMessage('user', 'a')]);
    ctx.spliceHistory(1, 0, [textMessage('assistant', 'b')]);

    const history = ctx.getHistory();
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(history.map(textOf)).toEqual(['a', 'b']);
  });

  it('returns a defensive copy from getHistory', () => {
    const ctx = ix.get(IContextMemory);
    ctx.spliceHistory(0, 0, [textMessage('user', 'keep')]);

    const view = ctx.getHistory();
    (view as ContextMessage[]).splice(0, view.length);

    expect(ctx.getHistory().map(textOf)).toEqual(['keep']);
  });
});
