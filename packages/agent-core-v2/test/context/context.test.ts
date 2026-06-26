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

describe('ContextMemoryService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    // Real collaborators the service depends on, supplied as test doubles.
    ix.stub(IWireRecord, stubWireRecord());
    ix.stub(IReplayBuilderService, stubReplayBuilder());
    // System under test, registered by interface so the binding is exercised.
    ix.set(IContextMemory, new SyncDescriptor(ContextMemoryService));
  });
  afterEach(() => disposables.dispose());

  it('returns spliced messages in insertion order', () => {
    const ctx = ix.get(IContextMemory);
    ctx.spliceHistory(0, 0, [textMessage('user', 'hi')]);
    ctx.spliceHistory(1, 0, [textMessage('assistant', 'hello')]);

    expect(ctx.getHistory().map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(ctx.getHistory().map(textOf)).toEqual(['hi', 'hello']);
  });

  // NOTE: the legacy `ContextService.tokenUsage()` helper has no equivalent on
  // `IContextMemory`; token estimation moved to the `contextSize` domain and
  // the `estimateTokensForMessages` utility, so that case is intentionally not
  // migrated.

  it('replaces the whole history with a compaction summary', () => {
    const ctx = ix.get(IContextMemory);
    ctx.spliceHistory(0, 0, [textMessage('user', '1'), textMessage('assistant', '2')]);

    const summary: ContextMessage = {
      ...textMessage('assistant', 'summary'),
      origin: { kind: 'compaction_summary' },
    };
    ctx.spliceHistory(0, 2, [summary]);

    expect(ctx.getHistory().map(textOf)).toEqual(['summary']);
  });

  // NOTE: the legacy `ContextService.undo()` snapshot/restore behavior has no
  // equivalent on `IContextMemory`; history is now mutated only through
  // `spliceHistory`, so the "undo restores the pre-compaction history" case is
  // intentionally not migrated.

  it('removes the last message with a deleting splice', () => {
    const ctx = ix.get(IContextMemory);
    ctx.spliceHistory(0, 0, [textMessage('user', '1'), textMessage('user', '2')]);

    ctx.spliceHistory(1, 1, []);

    expect(ctx.getHistory().map(textOf)).toEqual(['1']);
  });
});
