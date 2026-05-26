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
    // The assistant message is reconstructed from step.begin/content.part/step.end,
    // not from a separate `context.append_message` (agent-core never emits one).
    expect(proj.messages[1]!.message.role).toBe('assistant');
    expect(proj.messages[1]!.message.content).toEqual([{ type: 'text', text: 'hello' }]);

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

  it('reconstructs assistant tool-call messages and separates tool results', async () => {
    const entries = [
      {
        lineNo: 2,
        data: {
          type: 'context.append_message' as const,
          message: {
            role: 'user' as const,
            content: [{ type: 'text' as const, text: 'list files' }],
            toolCalls: [],
          },
        },
        raw: {},
      },
      {
        lineNo: 3,
        data: {
          type: 'context.append_loop_event' as const,
          event: { type: 'step.begin' as const, uuid: 's1', turnId: 't1', step: 0 },
        },
        raw: {},
      },
      {
        lineNo: 4,
        data: {
          type: 'context.append_loop_event' as const,
          event: {
            type: 'content.part' as const,
            uuid: 'c1', turnId: 't1', step: 0, stepUuid: 's1',
            part: { type: 'text' as const, text: 'Let me check' },
          },
        },
        raw: {},
      },
      {
        lineNo: 5,
        data: {
          type: 'context.append_loop_event' as const,
          event: {
            type: 'tool.call' as const,
            uuid: 'tc1', turnId: 't1', step: 0, stepUuid: 's1',
            toolCallId: 'call_1', name: 'LS', args: '{"path":"/"}',
          },
        },
        raw: {},
      },
      {
        lineNo: 6,
        data: {
          type: 'context.append_loop_event' as const,
          event: { type: 'step.end' as const, uuid: 's1', turnId: 't1', step: 0 },
        },
        raw: {},
      },
      {
        lineNo: 7,
        data: {
          type: 'context.append_loop_event' as const,
          event: {
            type: 'tool.result' as const,
            parentUuid: 'tc1',
            toolCallId: 'call_1',
            result: { output: 'file1.txt\nfile2.txt' },
          },
        },
        raw: {},
      },
    ];

    const proj = projectContext(entries as any);
    expect(proj.messages).toHaveLength(3);

    expect(proj.messages[0]!.message.role).toBe('user');

    expect(proj.messages[1]!.message.role).toBe('assistant');
    expect(proj.messages[1]!.message.content).toEqual([{ type: 'text', text: 'Let me check' }]);
    expect(proj.messages[1]!.message.toolCalls).toEqual([
      { type: 'function', id: 'call_1', name: 'LS', arguments: '{"path":"/"}' },
    ]);
    // The assistant message was opened by step.begin (line 3), so its
    // anchor lineNo is that of step.begin even though content/toolCalls
    // were appended later.
    expect(proj.messages[1]!.lineNo).toBe(3);
    expect(proj.messages[1]!.toolStepUuids).toEqual(['s1']);

    expect(proj.messages[2]!.message.role).toBe('tool');
    expect(proj.messages[2]!.message.toolCallId).toBe('call_1');
    expect(proj.messages[2]!.message.content).toEqual([
      { type: 'text', text: 'file1.txt\nfile2.txt' },
    ]);
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
    // Compaction summary is an assistant message (agent-core's own
    // representation), not a synthetic system message.
    expect(proj.messages[0]!.message.role).toBe('assistant');
    expect(proj.messages[0]!.message.origin).toEqual({ kind: 'compaction_summary' });
    expect(proj.messages[0]!.message.content[0]).toMatchObject({ text: 'old stuff' });
    expect(proj.messages[1]!.message.content[0]).toMatchObject({ text: 'new' });
  });
});
