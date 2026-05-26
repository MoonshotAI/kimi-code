// apps/vis/server/test/lib/context-projector.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { buildSessionFixture } from '../fixtures/build';
import { projectContext } from '../../src/lib/context-projector';
import { readAgentWire } from '../../src/lib/wire-reader';
import { join } from 'node:path';

describe('context-projector', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('projects messages and aggregates usage', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const wire = await readAgentWire(join(sessionDir, 'agents', 'main', 'wire.jsonl'));
    const proj = projectContext(wire.records);

    expect(proj.messages).toHaveLength(2);
    expect(proj.messages[0]!.message.role).toBe('user');
    expect(proj.messages[1]!.message.role).toBe('assistant');

    expect(proj.usage.byScope.turn).toEqual({
      inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0,
    });
    expect(proj.usage.byModel['kimi-k2']).toEqual({
      inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0,
    });

    expect(proj.config.systemPrompt).toBe('You are Kimi.');
    expect(proj.config.profileName).toBe('agent');
    expect(proj.permission.mode).toBe('manual');
    expect(proj.planMode.active).toBe(false);
  });

  it('clears messages on context.clear', async () => {
    const entries = [
      { lineNo: 2, data: { type: 'context.append_message' as const, message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'a' }], toolCalls: [] } }, raw: {} },
      { lineNo: 3, data: { type: 'context.clear' as const }, raw: {} },
      { lineNo: 4, data: { type: 'context.append_message' as const, message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'b' }], toolCalls: [] } }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    expect(proj.messages).toHaveLength(1);
    expect(proj.messages[0]!.message.content[0]).toMatchObject({ text: 'b' });
  });

  it('applies compaction summary as a synthetic message', async () => {
    const entries = [
      { lineNo: 2, data: { type: 'context.append_message' as const, message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'old' }], toolCalls: [] } }, raw: {} },
      { lineNo: 3, data: { type: 'context.apply_compaction' as const, summary: 'old stuff', compactedCount: 1, tokensBefore: 100, tokensAfter: 30 }, raw: {} },
      { lineNo: 4, data: { type: 'context.append_message' as const, message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'new' }], toolCalls: [] } }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    expect(proj.messages[0]!.source).toBe('compaction_summary');
    expect(proj.messages[0]!.message.content[0]).toMatchObject({ text: 'old stuff' });
    expect(proj.messages[1]!.message.content[0]).toMatchObject({ text: 'new' });
  });
});
