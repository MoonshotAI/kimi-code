import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { toDisposable } from '#/_base/di/lifecycle';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IContextMemory, type ContextMessage } from '#/contextMemory';
import { ContextMemoryService } from '#/contextMemory/contextMemoryService';
import { IContextProjector } from '#/contextProjector';
import { IContextSizeService } from '#/contextSize';
import { IEventBus } from '#/eventBus';
import { IExternalHooksService } from '#/externalHooks';
import { FullCompactionService } from '#/fullCompaction/fullCompactionService';
import type { CompactionStrategy } from '#/fullCompaction/strategy';
import { ILLMRequester, type LLMEvent } from '#/llmRequester';
import { IProfileService } from '#/profile';
import { IReplayBuilderService } from '#/replayBuilder';
import { ITelemetryService } from '#/telemetry';
import { IToolStoreService } from '#/toolStore';
import { ITurnService } from '#/turn';
import { IUsageService } from '#/usage';
import { IWireRecord } from '#/wireRecord';
import { stubReplayBuilder, stubWireRecord } from '../contextMemory/stubs';
import { stubTurnWithHooks } from '../turn/stubs';

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

async function* summaryStream(text: string): AsyncGenerator<LLMEvent> {
  yield { type: 'part', part: { type: 'text', text } };
  yield { type: 'finish' };
}

function forceCompactStrategy(overrides: Partial<CompactionStrategy> = {}): CompactionStrategy {
  return {
    shouldCompact: () => true,
    shouldBlock: () => false,
    computeCompactCount: (messages) => messages.length,
    reduceCompactOnOverflow: (messages) => messages.length,
    checkAfterStep: false,
    maxCompactionPerTurn: Infinity,
    ...overrides,
  };
}

describe('FullCompactionService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());

    // Real context memory so the compaction splice is observable.
    ix.stub(IWireRecord, stubWireRecord());
    ix.stub(IReplayBuilderService, stubReplayBuilder());
    ix.set(IContextMemory, new SyncDescriptor(ContextMemoryService));

    // Collaborators stubbed to drive a deterministic compaction run.
    ix.stub(IContextProjector, { project: (messages) => [...messages] });
    ix.stub(IContextSizeService, {
      getStatus: () => ({ contextTokens: 0, contextTokensWithPending: 0 }),
      measure: () => {},
    });
    ix.stub(ILLMRequester, { request: () => summaryStream('compacted summary') });
    ix.stub(IProfileService, {
      resolveModelContext: () => ({
        provider: {},
        modelAlias: 'test-model',
        modelCapabilities: { max_context_tokens: 100_000 },
        maxOutputSize: undefined,
        alwaysThinking: undefined,
        thinkingLevel: 'medium',
        reservedContextSize: undefined,
        compactionTriggerRatio: undefined,
      }),
      data: () => ({ thinkingLevel: 'medium' }),
    } as unknown as IProfileService);
    ix.stub(IToolStoreService, { data: () => ({}), get: () => undefined, set: () => {} });
    ix.stub(ITelemetryService, { track: () => {} });
    ix.stub(IUsageService, { record: () => {} });
    ix.stub(IEventBus, { emit: () => {}, on: () => toDisposable(() => {}) });
    ix.stub(IExternalHooksService, {
      triggerPreCompact: () => Promise.resolve(),
      triggerPostCompact: () => {},
    });
    ix.stub(ITurnService, stubTurnWithHooks());
  });
  afterEach(() => disposables.dispose());

  // NOTE: FullCompactionService is built via createInstance (not get) because
  // each test injects a different compaction strategy — a static option the
  // container cannot bake into a singleton. See di-testing.md "Exceptions".
  it('replaces history with a compaction summary on overflow', async () => {
    const ctx = ix.get(IContextMemory);
    ctx.spliceHistory(0, 0, [textMessage('user', 'x'.repeat(100)), textMessage('assistant', 'y')]);

    const svc = ix.createInstance(FullCompactionService as any, {
      compactionStrategy: forceCompactStrategy(),
    });

    await svc.handleOverflowError(new AbortController().signal, new Error('context overflow'));

    const history = ctx.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0]?.origin).toEqual({ kind: 'compaction_summary' });
    expect(textOf(history[0]!)).toBe('compacted summary');
  });

  it('refuses to compact when there is no compactable prefix', () => {
    const svc = ix.createInstance(FullCompactionService as any, {
      compactionStrategy: forceCompactStrategy({ computeCompactCount: () => 0 }),
    });

    expect(() => svc.begin({ source: 'manual' })).toThrow(/No prefix/);
  });
});
