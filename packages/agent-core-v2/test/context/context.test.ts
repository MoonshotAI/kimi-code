import { describe, expect, it } from 'vitest';

import { ContextService } from '#/context/contextService';

describe('ContextService', () => {
  it('appends messages and projects them in order', () => {
    const ctx = new ContextService(undefined as never);
    ctx.appendMessage({ role: 'user', content: 'hi' });
    ctx.appendMessage({ role: 'assistant', content: 'hello' });
    ctx.appendSystemReminder('note');
    expect(ctx.project().map((m) => m.role)).toEqual(['user', 'assistant', 'system']);
  });

  it('tokenUsage estimates from content length', () => {
    const ctx = new ContextService(undefined as never);
    ctx.appendMessage({ role: 'user', content: 'a'.repeat(40) });
    expect(ctx.tokenUsage()).toBe(10);
  });

  it('applyCompaction replaces history with a summary; undo restores', () => {
    const ctx = new ContextService(undefined as never);
    ctx.appendMessage({ role: 'user', content: '1' });
    ctx.appendMessage({ role: 'assistant', content: '2' });
    ctx.applyCompaction('summary');
    expect(ctx.project()).toEqual([{ role: 'system', content: 'summary' }]);
    ctx.undo();
    expect(ctx.project().map((m) => m.content)).toEqual(['1', '2']);
  });

  it('undo without snapshot pops the last message', () => {
    const ctx = new ContextService(undefined as never);
    ctx.appendMessage({ role: 'user', content: '1' });
    ctx.appendMessage({ role: 'user', content: '2' });
    ctx.undo();
    expect(ctx.project().map((m) => m.content)).toEqual(['1']);
  });
});
