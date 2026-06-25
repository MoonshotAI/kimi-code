import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ContextService } from '#/context/contextService';
import { IAgentRecords } from '#/records/records';

describe('ContextService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IAgentRecords, { _serviceBrand: undefined });
  });
  afterEach(() => disposables.dispose());

  it('appends messages and projects them in order', () => {
    const ctx = ix.createInstance(ContextService);
    ctx.appendMessage({ role: 'user', content: 'hi' });
    ctx.appendMessage({ role: 'assistant', content: 'hello' });
    ctx.appendSystemReminder('note');
    expect(ctx.project().map((m) => m.role)).toEqual(['user', 'assistant', 'system']);
  });

  it('tokenUsage estimates from content length', () => {
    const ctx = ix.createInstance(ContextService);
    ctx.appendMessage({ role: 'user', content: 'a'.repeat(40) });
    expect(ctx.tokenUsage()).toBe(10);
  });

  it('applyCompaction replaces history with a summary; undo restores', () => {
    const ctx = ix.createInstance(ContextService);
    ctx.appendMessage({ role: 'user', content: '1' });
    ctx.appendMessage({ role: 'assistant', content: '2' });
    ctx.applyCompaction('summary');
    expect(ctx.project()).toEqual([{ role: 'system', content: 'summary' }]);
    ctx.undo();
    expect(ctx.project().map((m) => m.content)).toEqual(['1', '2']);
  });

  it('undo without snapshot pops the last message', () => {
    const ctx = ix.createInstance(ContextService);
    ctx.appendMessage({ role: 'user', content: '1' });
    ctx.appendMessage({ role: 'user', content: '2' });
    ctx.undo();
    expect(ctx.project().map((m) => m.content)).toEqual(['1']);
  });
});
