import { describe, it, expect, afterEach } from 'vitest';
import { estimateTokensForMessages } from '@moonshot-ai/agent-core-v2/session/tokenCounting/tokens';
import { buildCompactionContinuationText } from '@moonshot-ai/agent-core-v2/agent/contextMemory/compactionHandoff';
import { buildSessionFixture } from '../fixtures/build';
import { projectContext } from '../../src/lib/context-projector';
import { readAgentWire } from '../../src/lib/wire-reader';
import { join } from 'node:path';

function turnPrompt(text: string, promptId = text) {
  return {
    type: 'turn.prompt' as const,
    input: [{ type: 'text' as const, text }],
    origin: { kind: 'user' as const },
    promptId,
    trigger: 'normal' as const,
  };
}

describe('context-projector', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('projects messages and aggregates usage', async () => {
    const { sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const wire = await readAgentWire(join(sessionDir, 'agents', 'main', 'wire.jsonl'));
    const proj = projectContext([
      ...wire.records,
      {
        lineNo: wire.records.length + 1,
        data: {
          type: 'usage.record',
          agentId: 'main',
          model: 'kimi-k2',
          usage: { inputOther: 7, output: 2, inputCacheRead: 1, inputCacheCreation: 3 },
          usageScope: 'prediction',
        },
        raw: {},
      },
    ]);

    expect(proj.messages).toHaveLength(2);
    expect(proj.messages[0]!.message.role).toBe('user');
    expect(proj.messages[1]!.message.role).toBe('assistant');
    expect(proj.messages[1]!.message.content).toEqual([{ type: 'text', text: 'hello' }]);

    expect(proj.usage.byScope.turn).toEqual({
      inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0,
    });
    expect(proj.usage.byScope.prediction).toEqual({
      inputOther: 7, output: 2, inputCacheRead: 1, inputCacheCreation: 3,
    });
    expect(proj.usage.byModel['kimi-k2']).toEqual({
      inputOther: 17, output: 7, inputCacheRead: 1, inputCacheCreation: 3,
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
        lineNo: 4.5,
        data: {
          type: 'context.append_loop_event' as const,
          event: {
            type: 'content.part' as const,
            uuid: 'c2', turnId: 't1', step: 0, stepUuid: 's1',
            part: {
              type: 'image_url' as const,
              imageUrl: { url: 'data:image/png;base64,AAA' },
            },
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
            toolCallId: 'call_1', name: 'LS', args: { path: '/' },
          },
        },
        raw: {},
      },
      {
        lineNo: 6,
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
      {
        lineNo: 7,
        data: {
          type: 'context.append_loop_event' as const,
          event: { type: 'step.end' as const, uuid: 's1', turnId: 't1', step: 0 },
        },
        raw: {},
      },
    ];

    const proj = projectContext(entries as any);
    expect(proj.messages).toHaveLength(3);

    expect(proj.messages[0]!.message.role).toBe('user');

    const assistant = proj.messages[1]!.message;
    if (assistant.role !== 'assistant') throw new Error('expected assistant message');
    expect(assistant.content).toEqual([
      { type: 'text', text: 'Let me check' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAA' } },
    ]);
    expect(assistant.toolCalls).toEqual([
      { type: 'function', id: 'call_1', name: 'LS', arguments: '{"path":"/"}' },
    ]);
    expect(proj.messages[1]!.lineNo).toBe(3);
    expect(proj.messages[1]!.toolStepUuids).toEqual(['s1']);

    const tool = proj.messages[2]!.message;
    if (tool.role !== 'tool') throw new Error('expected tool message');
    expect(tool.toolCallId).toBe('call_1');
    expect(tool.content).toEqual([
      { type: 'text', text: 'file1.txt\nfile2.txt' },
    ]);
  });

  it('drops a vacuous assistant when a step ends without output', () => {
    const entries = [
      { lineNo: 1, data: { type: 'context.append_loop_event' as const,
          event: { type: 'step.begin' as const, uuid: 's1' } }, raw: {} },
      { lineNo: 2, data: { type: 'context.append_loop_event' as const,
          event: { type: 'step.end' as const, uuid: 's1' } }, raw: {} },
    ];

    expect(projectContext(entries as any).messages).toEqual([]);
  });

  it.each(['interrupted', 'error'] as const)(
    'seals a %s step immediately and keeps it beside the next attempt',
    (finishReason) => {
      const entries: Array<{ lineNo: number; data: Record<string, unknown>; raw: object }> = [
        { lineNo: 1, data: { type: 'context.append_loop_event' as const,
            event: { type: 'step.begin' as const, uuid: 's1' } }, raw: {} },
        { lineNo: 2, data: { type: 'context.append_loop_event' as const,
            event: { type: 'content.part' as const, stepUuid: 's1',
              part: { type: 'text' as const, text: 'partial' } } }, raw: {} },
        { lineNo: 3, data: { type: 'context.append_loop_event' as const,
            event: { type: 'step.end' as const, uuid: 's1', finishReason } }, raw: {} },
      ];

      const interrupted = projectContext(entries as any);
      expect(interrupted.messages).toHaveLength(1);
      expect(interrupted.messages[0]!.message.partial).toBeUndefined();

      entries.push(
        { lineNo: 4, data: { type: 'context.append_loop_event' as const,
            event: { type: 'step.begin' as const, uuid: 's2' } }, raw: {} },
        { lineNo: 5, data: { type: 'context.append_loop_event' as const,
            event: { type: 'content.part' as const, stepUuid: 's2',
              part: { type: 'text' as const, text: 'recovered' } } }, raw: {} },
        { lineNo: 6, data: { type: 'context.append_loop_event' as const,
            event: { type: 'step.end' as const, uuid: 's2' } }, raw: {} },
      );
      const recovered = projectContext(entries as any);
      expect(recovered.messages.map((message) => message.message.partial)).toEqual([
        undefined,
        undefined,
      ]);
      expect(recovered.messages.map((message) => message.message.content[0])).toMatchObject([
        { text: 'partial' },
        { text: 'recovered' },
      ]);
    },
  );

  it('closes a pending tool call with an interrupted result at step end', () => {
    const entries = [
      { lineNo: 1, data: { type: 'context.append_loop_event' as const,
          event: { type: 'step.begin' as const, uuid: 's1' } }, raw: {} },
      { lineNo: 2, data: { type: 'context.append_loop_event' as const,
          event: { type: 'tool.call' as const, stepUuid: 's1', toolCallId: 'c1',
            name: 'Bash', args: {} } }, raw: {} },
      { lineNo: 3, data: { type: 'context.append_loop_event' as const,
          event: { type: 'step.end' as const, uuid: 's1' } }, raw: {} },
    ];

    const proj = projectContext(entries as any);
    expect(proj.messages.map((message) => message.message.role)).toEqual(['assistant', 'tool']);
    expect(proj.messages[1]!.message).toMatchObject({ toolCallId: 'c1', isError: true });
    expect(proj.messages[1]!.message.content[0]).toMatchObject({
      text: expect.stringContaining('interrupted before its result was recorded'),
    });
    expect(proj.messages[1]!.lineNo).toBeLessThan(3);
  });

  it('defers appended messages until a pending tool result arrives while preserving line metadata', () => {
    const entries = [
      { lineNo: 1, data: { type: 'context.append_loop_event' as const,
          event: { type: 'step.begin' as const, uuid: 's1' } }, raw: {} },
      { lineNo: 2, data: { type: 'context.append_loop_event' as const,
          event: { type: 'tool.call' as const, stepUuid: 's1', toolCallId: 'c1',
            name: 'Read', args: { path: '/tmp/a' } } }, raw: {} },
      { lineNo: 3, data: { type: 'context.append_message' as const,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'reminder' }],
            toolCalls: [], origin: { kind: 'injection' as const, variant: 'test' } } }, raw: {} },
      { lineNo: 4, data: { type: 'context.append_loop_event' as const,
          event: { type: 'tool.result' as const, toolCallId: 'c1', result: { output: 'ok' } } }, raw: {} },
      { lineNo: 5, data: { type: 'context.append_loop_event' as const,
          event: { type: 'step.end' as const, uuid: 's1' } }, raw: {} },
    ];

    const proj = projectContext(entries as any);
    expect(proj.messages.map((message) => message.message.role)).toEqual([
      'assistant',
      'tool',
      'user',
    ]);
    expect(proj.messages[2]!.message.content[0]).toMatchObject({ text: 'reminder' });
    expect(proj.messages[2]!.lineNo).toBe(3);
  });

  it('does not reset contextTokens on a zero-usage step.end', () => {
    const entries = [
      { lineNo: 1, data: { type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 's1', turnId: 'T', step: 0 } }, raw: {} },
      { lineNo: 2, data: { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 's1', turnId: 'T', step: 0, usage: { inputOther: 100, output: 20, inputCacheRead: 80, inputCacheCreation: 0 } } }, raw: {} },
      { lineNo: 3, data: { type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 's2', turnId: 'T', step: 1 } }, raw: {} },
      { lineNo: 4, data: { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 's2', turnId: 'T', step: 1, finishReason: 'filtered', usage: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } } }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    expect(proj.contextTokens).toBe(200);
  });

  const TOOL_ERROR_STATUS = '<system>ERROR: Tool execution failed.</system>';
  const TOOL_EMPTY_STATUS = '<system>Tool output is empty.</system>';
  const TOOL_EMPTY_ERROR_STATUS =
    '<system>ERROR: Tool execution failed. Tool output is empty.</system>';

  const projectToolResult = (result: unknown) => {
    const entries = [
      {
        lineNo: 1,
        data: {
          type: 'context.append_loop_event' as const,
          event: { type: 'step.begin' as const, uuid: 's1', turnId: 't1', step: 0 },
        },
        raw: {},
      },
      {
        lineNo: 2,
        data: {
          type: 'context.append_loop_event' as const,
          event: {
            type: 'tool.call' as const,
            uuid: 'tc1', turnId: 't1', step: 0, stepUuid: 's1',
            toolCallId: 'call_1', name: 'Bash', args: '{}',
          },
        },
        raw: {},
      },
      {
        lineNo: 3,
        data: {
          type: 'context.append_loop_event' as const,
          event: {
            type: 'tool.result' as const,
            parentUuid: 'tc1',
            toolCallId: 'call_1',
            result,
          },
        },
        raw: {},
      },
      {
        lineNo: 4,
        data: {
          type: 'context.append_loop_event' as const,
          event: { type: 'step.end' as const, uuid: 's1', turnId: 't1', step: 0 },
        },
        raw: {},
      },
    ];
    const proj = projectContext(entries as any);
    return proj.messages.at(-1)!.message;
  };

  it('tool.result: error string output is prefixed with the error sentinel', () => {
    const msg = projectToolResult({ output: 'boom: file not found', isError: true });
    if (msg.role !== 'tool') throw new Error('expected tool message');
    expect(msg.toolCallId).toBe('call_1');
    expect(msg.isError).toBe(true);
    expect(msg.content).toEqual([
      { type: 'text', text: `${TOOL_ERROR_STATUS}\nboom: file not found` },
    ]);
  });

  it('tool.result: error string starting with ERROR: still gets the wrapped status', () => {
    const text = 'ERROR: already wrapped\ndetails here';
    const msg = projectToolResult({ output: text, isError: true });
    expect(msg.content).toEqual([{ type: 'text', text: `${TOOL_ERROR_STATUS}\n${text}` }]);
  });

  it('tool.result: empty string output (non-error) becomes the empty sentinel', () => {
    const msg = projectToolResult({ output: '' });
    expect(msg.content).toEqual([{ type: 'text', text: TOOL_EMPTY_STATUS }]);
  });

  it('tool.result: empty string output with error becomes the empty-error sentinel', () => {
    const msg = projectToolResult({ output: '', isError: true });
    expect(msg.isError).toBe(true);
    expect(msg.content).toEqual([{ type: 'text', text: TOOL_EMPTY_ERROR_STATUS }]);
  });

  it('tool.result: normal non-empty non-error string is unchanged', () => {
    const msg = projectToolResult({ output: 'file1.txt\nfile2.txt' });
    expect(msg.content).toEqual([{ type: 'text', text: 'file1.txt\nfile2.txt' }]);
  });

  it('tool.result: array output with error is prefixed with an error-sentinel part', () => {
    const parts = [
      { type: 'text' as const, text: 'partial output' },
      { type: 'image_url' as const, imageUrl: { url: 'data:image/png;base64,AAAA' } },
    ];
    const msg = projectToolResult({ output: parts, isError: true });
    expect(msg.content).toEqual([{ type: 'text', text: TOOL_ERROR_STATUS }, ...parts]);
  });

  it('tool.result: empty array output (non-error) becomes a single empty-sentinel part', () => {
    const msg = projectToolResult({ output: [] });
    expect(msg.content).toEqual([{ type: 'text', text: TOOL_EMPTY_STATUS }]);
  });

  it('tool.result: non-error array output is passed through as-is', () => {
    const parts = [{ type: 'text' as const, text: 'a' }, { type: 'text' as const, text: 'b' }];
    const msg = projectToolResult({ output: parts });
    expect(msg.content).toEqual(parts);
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
    expect(proj.messages.map((m) => m.source)).toEqual([
      'compaction_summary', 'append_message',
    ]);
    expect(proj.messages[0]!.message.role).toBe('user');
    expect(proj.messages[0]!.message.origin).toEqual({ kind: 'compaction_summary' });
    expect(proj.messages[0]!.message.content[0]).toMatchObject({ text: 'old stuff' });
    expect(proj.messages[1]!.message.content[0]).toMatchObject({ text: 'new' });
  });

  it('ignores a malformed compaction record like core-v2 restore', () => {
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'before' }], toolCalls: [] } }, raw: {} },
      { lineNo: 2, data: { type: 'context.apply_compaction' as const,
          summary: 'missing compactedCount' }, raw: {} },
      { lineNo: 3, data: { type: 'context.append_message' as const,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'after' }], toolCalls: [] } }, raw: {} },
    ];

    const projection = projectContext(entries as any);

    expect(projection.messages.map((message) => message.message.content[0])).toMatchObject([
      { text: 'before' },
      { text: 'after' },
    ]);
  });

  it('uses contextSummary only for the model view and raw summary for full history', () => {
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'old' }], toolCalls: [] } }, raw: {} },
      { lineNo: 2, data: { type: 'context.apply_compaction' as const,
          summary: 'raw summary', contextSummary: 'prefixed summary', compactedCount: 1, tokensBefore: 100, tokensAfter: 10 }, raw: {} },
    ];

    const model = projectContext(entries as any);
    expect(model.messages.map((m) => m.message.content[0])).toMatchObject([
      { text: 'prefixed summary' },
    ]);

    const full = projectContext(entries as any, 'full');
    expect(full.messages.map((m) => m.message.content[0])).toMatchObject([
      { text: 'old' },
      { text: 'raw summary' },
    ]);
  });

  it('apply_compaction keeps the most recent user messages and drops the assistant/tool tail', () => {
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'm0' }], toolCalls: [] } }, raw: {} },
      { lineNo: 2, data: { type: 'context.append_message' as const,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'm1' }], toolCalls: [] } }, raw: {} },
      { lineNo: 3, data: { type: 'context.append_message' as const,
          message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'm2 (dropped)' }], toolCalls: [] } }, raw: {} },
      { lineNo: 4, data: { type: 'context.apply_compaction' as const,
          summary: 'sum', compactedCount: 3, tokensBefore: 100, tokensAfter: 10,
          keptUserMessageCount: 2 }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    expect(proj.messages).toHaveLength(4);
    expect(proj.messages.map((m) => m.source)).toEqual([
      'append_message', 'append_message', 'compaction_summary', 'append_message',
    ]);
    expect(proj.messages[0]!.message.content[0]).toMatchObject({ text: 'm0' });
    expect(proj.messages[1]!.message.content[0]).toMatchObject({ text: 'm1' });
    expect(proj.messages[2]!.compaction).toEqual({ compactedCount: 3, tokensBefore: 100, tokensAfter: 10 });
    expect(proj.messages[2]!.message.content[0]).toMatchObject({ text: 'sum' });
    expect(proj.messages[3]!.message.origin).toEqual({
      kind: 'injection',
      variant: 'compaction_continuation',
    });
    expect(proj.messages[3]!.message.content[0]).toMatchObject({
      text: buildCompactionContinuationText(),
    });
  });

  it('apply_compaction mirrors the legacy verbatim tail for records without keptUserMessageCount (model)', () => {
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'u0 (compacted away)' }], toolCalls: [], origin: { kind: 'user' as const } } }, raw: {} },
      { lineNo: 2, data: { type: 'context.append_message' as const,
          message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'a1' }], toolCalls: [] } }, raw: {} },
      { lineNo: 3, data: { type: 'context.append_message' as const,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'u2 (tail)' }], toolCalls: [], origin: { kind: 'user' as const } } }, raw: {} },
      { lineNo: 4, data: { type: 'context.append_message' as const,
          message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'a3 (tail)' }], toolCalls: [] } }, raw: {} },
      { lineNo: 5, data: { type: 'context.apply_compaction' as const,
          summary: 'sum', compactedCount: 2, tokensBefore: 100, tokensAfter: 10 }, raw: {} },
    ];

    const model = projectContext(entries as any);
    expect(model.messages.map((m) => m.source)).toEqual([
      'compaction_summary', 'append_message', 'append_message',
    ]);
    expect(model.messages.map((m) => m.message.content[0])).toMatchObject([
      { text: 'sum' }, { text: 'u2 (tail)' }, { text: 'a3 (tail)' },
    ]);
  });

  it('apply_compaction splits an oversized user pool into head + elision marker + tail (model)', () => {
    const first = `FIRST ${'a'.repeat(4_000)}`;
    const middle = 'b'.repeat(88_000);
    const last = `LAST ${'c'.repeat(4_000)}`;
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: first }], toolCalls: [], origin: { kind: 'user' as const } } }, raw: {} },
      { lineNo: 2, data: { type: 'context.append_message' as const,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: middle }], toolCalls: [], origin: { kind: 'user' as const } } }, raw: {} },
      { lineNo: 3, data: { type: 'context.append_message' as const,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: last }], toolCalls: [], origin: { kind: 'user' as const } } }, raw: {} },
      { lineNo: 4, data: { type: 'context.apply_compaction' as const,
          summary: 'sum', compactedCount: 3, tokensBefore: 24_000, tokensAfter: 20_000,
          keptUserMessageCount: 4, keptHeadUserMessageCount: 2 }, raw: {} },
    ];

    const proj = projectContext(entries as any);
    expect(proj.messages).toHaveLength(7);
    const texts = proj.messages.map((m) =>
      m.message.content.map((p: any) => (p.type === 'text' ? p.text : '')).join(''),
    );
    expect(texts[0]).toBe(first);
    expect(/^b+$/.test(texts[1]!)).toBe(true);
    expect(middle.startsWith(texts[1]!)).toBe(true);
    expect(proj.messages[2]!.message.origin).toEqual({
      kind: 'injection',
      variant: 'compaction_elision',
    });
    expect(texts[2]).toContain('<system-reminder>');
    expect(/^b+$/.test(texts[3]!)).toBe(true);
    expect(middle.endsWith(texts[3]!)).toBe(true);
    expect(texts[4]).toBe(last);
    expect(proj.messages[5]!.source).toBe('compaction_summary');
    expect(proj.messages[6]!.message.origin).toEqual({
      kind: 'injection',
      variant: 'compaction_continuation',
    });
    expect(texts[6]).toBe(buildCompactionContinuationText());
    expect(new Set(proj.messages.map((m) => m.lineNo)).size).toBe(7);
  });

  it('apply_compaction drops shell/local-command/background messages in model mode only', () => {
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'real user' }], toolCalls: [], origin: { kind: 'user' as const } } }, raw: {} },
      { lineNo: 2, data: { type: 'context.append_message' as const,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: '! pwd' }], toolCalls: [], origin: { kind: 'shell_command' as const, phase: 'input' as const } } }, raw: {} },
      { lineNo: 3, data: { type: 'context.append_message' as const,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'local output' }], toolCalls: [], origin: { kind: 'injection' as const, variant: 'local-command-stdout' } } }, raw: {} },
      { lineNo: 4, data: { type: 'context.append_message' as const,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'background done' }], toolCalls: [], origin: { kind: 'background_task' as const, taskId: 'task', status: 'completed' as const, notificationId: 'notification' } } }, raw: {} },
      { lineNo: 5, data: { type: 'context.append_message' as const,
          message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'assistant reply' }], toolCalls: [] } }, raw: {} },
      { lineNo: 6, data: { type: 'context.apply_compaction' as const,
          summary: 'sum', compactedCount: 5, tokensBefore: 100, tokensAfter: 10,
          keptUserMessageCount: 1 }, raw: {} },
      { lineNo: 7, data: { type: 'context.append_message' as const,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'new' }], toolCalls: [], origin: { kind: 'user' as const } } }, raw: {} },
    ];

    const model = projectContext(entries as any);
    expect(model.messages.map((m) => m.source)).toEqual([
      'append_message', 'compaction_summary', 'append_message', 'append_message',
    ]);
    expect(model.messages.map((m) => m.message.content[0])).toMatchObject([
      { text: 'real user' }, { text: 'sum' }, { text: buildCompactionContinuationText() }, { text: 'new' },
    ]);

    const full = projectContext(entries as any, 'full');
    expect(full.messages.map((m) => m.source)).toEqual([
      'append_message', 'append_message', 'append_message', 'append_message',
      'append_message', 'compaction_summary', 'append_message',
    ]);
    expect(full.messages.map((m) => m.message.content[0])).toMatchObject([
      { text: 'real user' }, { text: '! pwd' }, { text: 'local output' },
      { text: 'background done' }, { text: 'assistant reply' }, { text: 'sum' },
      { text: 'new' },
    ]);
  });

  it('apply_compaction keeps user messages across a preceding undo marker (model)', () => {
    const userMsg = (text: string) => ({
      role: 'user' as const, content: [{ type: 'text' as const, text }], toolCalls: [],
      origin: { kind: 'user' as const },
    });
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const, message: userMsg('u1') }, raw: {} },
      { lineNo: 2, data: turnPrompt('u2'), raw: {} },
      { lineNo: 2, data: { type: 'context.append_message' as const, message: userMsg('u2') }, raw: {} },
      { lineNo: 3, data: { type: 'context.undo' as const, count: 1 }, raw: {} },
      { lineNo: 4, data: { type: 'context.append_message' as const, message: userMsg('u3') }, raw: {} },
      { lineNo: 5, data: { type: 'context.append_message' as const, message: userMsg('u4') }, raw: {} },
      { lineNo: 6, data: { type: 'context.apply_compaction' as const,
          summary: 'sum', compactedCount: 3, tokensBefore: 100, tokensAfter: 10,
          keptUserMessageCount: 3 }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    expect(proj.messages.map((m) => m.source)).toEqual([
      'append_message', 'append_message', 'append_message', 'compaction_summary', 'append_message',
    ]);
    expect(proj.messages.map((m) => m.message.content[0])).toMatchObject([
      { text: 'u1' }, { text: 'u3' }, { text: 'u4' }, { text: 'sum' },
      { text: buildCompactionContinuationText() },
    ]);
  });

  it('micro-blanking uses the history index, skipping a preceding undo marker (model)', () => {
    const bigText = 'x'.repeat(2000);
    const toolMsg = (id: string, text: string) => ({
      role: 'tool' as const, content: [{ type: 'text' as const, text }], toolCalls: [], toolCallId: id,
    });
    const userMsg = (text: string) => ({
      role: 'user' as const, content: [{ type: 'text' as const, text }], toolCalls: [],
      origin: { kind: 'user' as const },
    });
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const, message: toolMsg('c0', bigText) }, raw: {} },
      { lineNo: 2, data: turnPrompt('u1'), raw: {} },
      { lineNo: 2, data: { type: 'context.append_message' as const, message: userMsg('u1') }, raw: {} },
      { lineNo: 3, data: { type: 'context.undo' as const, count: 1 }, raw: {} },
      { lineNo: 4, data: { type: 'context.append_message' as const, message: toolMsg('c1', bigText) }, raw: {} },
      { lineNo: 5, data: { type: 'micro_compaction.apply' as const, cutoff: 2 }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    expect(proj.messages.map((m) => m.source)).toEqual(['append_message', 'undo', 'append_message']);
    expect(proj.messages[0]!.message.content).toEqual([{ type: 'text', text: '[Old tool result content cleared]' }]);
    expect(proj.messages[2]!.message.content).toEqual([{ type: 'text', text: '[Old tool result content cleared]' }]);
  });

  it('context.undo removes back to the Nth real user prompt and leaves an undo marker', () => {
    const userMsg = (text: string) => ({
      role: 'user' as const, content: [{ type: 'text' as const, text }], toolCalls: [],
      origin: { kind: 'user' as const },
    });
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const, message: userMsg('u1') }, raw: {} },
      { lineNo: 2, data: { type: 'context.append_message' as const,
          message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'a1' }], toolCalls: [] } }, raw: {} },
      { lineNo: 3, data: turnPrompt('u2'), raw: {} },
      { lineNo: 3, data: { type: 'context.append_message' as const, message: userMsg('u2') }, raw: {} },
      { lineNo: 4, data: { type: 'context.undo' as const, count: 1 }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    expect(proj.messages.map((m) => m.source)).toEqual(['append_message', 'append_message', 'undo']);
    expect(proj.messages[0]!.message.content[0]).toMatchObject({ text: 'u1' });
    expect(proj.messages[1]!.message.content[0]).toMatchObject({ text: 'a1' });
    expect(proj.messages[2]!.undo).toEqual({ count: 1, removedMessageCount: 1 });
    expect(proj.messages[2]!.lineNo).toBe(4);
  });

  it('context.undo removes injection messages inside the undo window', () => {
    const userMsg = (text: string) => ({
      role: 'user' as const, content: [{ type: 'text' as const, text }], toolCalls: [],
      origin: { kind: 'user' as const },
    });
    const injectionMsg = (text: string) => ({
      role: 'user' as const, content: [{ type: 'text' as const, text }], toolCalls: [],
      origin: { kind: 'injection' as const },
    });
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const, message: userMsg('u1') }, raw: {} },
      { lineNo: 2, data: { type: 'context.append_message' as const,
          message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'a1' }], toolCalls: [] } }, raw: {} },
      { lineNo: 3, data: turnPrompt('u2'), raw: {} },
      { lineNo: 3, data: { type: 'context.append_message' as const, message: userMsg('u2') }, raw: {} },
      { lineNo: 4, data: { type: 'context.append_message' as const, message: injectionMsg('inj') }, raw: {} },
      { lineNo: 5, data: { type: 'context.append_message' as const,
          message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'a2' }], toolCalls: [] } }, raw: {} },
      { lineNo: 6, data: { type: 'context.undo' as const, count: 1 }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    expect(proj.messages.map((m) => m.source)).toEqual([
      'append_message', 'append_message', 'undo',
    ]);
    expect(proj.messages[0]!.message.content[0]).toMatchObject({ text: 'u1' });
    expect(proj.messages[1]!.message.content[0]).toMatchObject({ text: 'a1' });
    expect(proj.messages[2]!.undo).toEqual({ count: 1, removedMessageCount: 3 });
  });

  it('context.undo includes a prompt-owned injection immediately before its prompt', () => {
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const, message: {
          id: 'p1', role: 'user' as const,
          content: [{ type: 'text' as const, text: 'u1' }], toolCalls: [],
          origin: { kind: 'user' as const },
        } }, raw: {} },
      { lineNo: 2, data: { type: 'context.append_message' as const, message: {
          role: 'user' as const,
          content: [{ type: 'text' as const, text: 'owned reminder' }], toolCalls: [],
          origin: { kind: 'injection' as const, variant: 'prompt-context', ownerPromptId: 'p2' },
        } }, raw: {} },
      { lineNo: 2.5, data: turnPrompt('u2', 'p2'), raw: {} },
      { lineNo: 3, data: { type: 'context.append_message' as const, message: {
          id: 'p2', role: 'user' as const,
          content: [{ type: 'text' as const, text: 'u2' }], toolCalls: [],
          origin: { kind: 'user' as const },
        } }, raw: {} },
      { lineNo: 4, data: { type: 'context.append_message' as const, message: {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'a2' }], toolCalls: [],
        } }, raw: {} },
      { lineNo: 5, data: { type: 'context.undo' as const, count: 1 }, raw: {} },
    ];

    const proj = projectContext(entries as any);
    expect(proj.messages.map((message) => message.source)).toEqual(['append_message', 'undo']);
    expect(proj.messages[0]!.message.content[0]).toMatchObject({ text: 'u1' });
    expect(proj.messages[1]!.undo).toEqual({ count: 1, removedMessageCount: 3 });
  });

  it('micro_compaction.apply blanks tool-result content before the cutoff', () => {
    const bigText = 'x'.repeat(2000);
    const toolMsg = (id: string, text: string) => ({
      role: 'tool' as const, content: [{ type: 'text' as const, text }], toolCalls: [], toolCallId: id,
    });
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const, message: toolMsg('c0', bigText) }, raw: {} },
      { lineNo: 2, data: { type: 'context.append_message' as const, message: toolMsg('c1', bigText) }, raw: {} },
      { lineNo: 3, data: { type: 'micro_compaction.apply' as const, cutoff: 1 }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    expect(proj.messages[0]!.message.content).toEqual([{ type: 'text', text: '[Old tool result content cleared]' }]);
    expect(proj.messages[1]!.message.content[0]).toMatchObject({ text: bigText });
  });

  it('micro_compaction.apply counts think parts toward the min-content gate', () => {
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const, message: {
          role: 'tool' as const, toolCallId: 'c0', toolCalls: [],
          content: [
            { type: 'text' as const, text: 'ok' },
            { type: 'think' as const, think: 'y'.repeat(2000) },
          ],
        } }, raw: {} },
      { lineNo: 2, data: { type: 'micro_compaction.apply' as const, cutoff: 1 }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    expect(proj.messages[0]!.message.content).toEqual([{ type: 'text', text: '[Old tool result content cleared]' }]);
  });

  it('micro_compaction.apply weights non-ASCII (CJK) chars as full tokens', () => {
    const cjk = '中'.repeat(150);
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const, message: {
          role: 'tool' as const, toolCallId: 'c0', toolCalls: [],
          content: [{ type: 'text' as const, text: cjk }],
        } }, raw: {} },
      { lineNo: 2, data: { type: 'micro_compaction.apply' as const, cutoff: 1 }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    expect(proj.messages[0]!.message.content).toEqual([{ type: 'text', text: '[Old tool result content cleared]' }]);
  });

  it('context.clear resets the micro-compaction cutoff (no stale blanking)', () => {
    const bigText = 'x'.repeat(2000);
    const toolMsg = (id: string, text: string) => ({
      role: 'tool' as const, content: [{ type: 'text' as const, text }], toolCalls: [], toolCallId: id,
    });
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const, message: toolMsg('c0', bigText) }, raw: {} },
      { lineNo: 2, data: { type: 'micro_compaction.apply' as const, cutoff: 1 }, raw: {} },
      { lineNo: 3, data: { type: 'context.clear' as const }, raw: {} },
      { lineNo: 4, data: { type: 'context.append_message' as const, message: toolMsg('n0', bigText) }, raw: {} },
      { lineNo: 5, data: { type: 'context.append_message' as const, message: toolMsg('n1', bigText) }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    expect(proj.messages).toHaveLength(2);
    expect(proj.messages[0]!.message.content[0]).toMatchObject({ text: bigText });
    expect(proj.messages[1]!.message.content[0]).toMatchObject({ text: bigText });
  });

  it('context.apply_compaction resets the micro-compaction cutoff', () => {
    const bigText = 'x'.repeat(2000);
    const toolMsg = (id: string, text: string) => ({
      role: 'tool' as const, content: [{ type: 'text' as const, text }], toolCalls: [], toolCallId: id,
    });
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const, message: toolMsg('c0', bigText) }, raw: {} },
      { lineNo: 2, data: { type: 'micro_compaction.apply' as const, cutoff: 1 }, raw: {} },
      { lineNo: 3, data: { type: 'context.apply_compaction' as const,
          summary: 'sum', compactedCount: 1, tokensBefore: 100, tokensAfter: 10 }, raw: {} },
      { lineNo: 4, data: { type: 'context.append_message' as const, message: toolMsg('n0', bigText) }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    expect(proj.messages).toHaveLength(2);
    expect(proj.messages[0]!.source).toBe('compaction_summary');
    expect(proj.messages[1]!.message.content[0]).toMatchObject({ text: bigText });
  });

  it('context.undo clamps the micro-compaction cutoff to the post-undo length', () => {
    const bigText = 'x'.repeat(2000);
    const toolMsg = (id: string, text: string) => ({
      role: 'tool' as const, content: [{ type: 'text' as const, text }], toolCalls: [], toolCallId: id,
    });
    const userMsg = (text: string) => ({
      role: 'user' as const, content: [{ type: 'text' as const, text }], toolCalls: [],
      origin: { kind: 'user' as const },
    });
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const, message: toolMsg('c0', bigText) }, raw: {} },
      { lineNo: 2, data: turnPrompt('u1'), raw: {} },
      { lineNo: 2, data: { type: 'context.append_message' as const, message: userMsg('u1') }, raw: {} },
      { lineNo: 3, data: { type: 'context.append_message' as const, message: toolMsg('c2', bigText) }, raw: {} },
      { lineNo: 4, data: { type: 'micro_compaction.apply' as const, cutoff: 3 }, raw: {} },
      { lineNo: 5, data: { type: 'context.undo' as const, count: 1 }, raw: {} },
      { lineNo: 6, data: { type: 'context.append_message' as const, message: toolMsg('n0', bigText) }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    expect(proj.messages.map((m) => m.source)).toEqual(['append_message', 'undo', 'append_message']);
    expect(proj.messages[0]!.message.content).toEqual([{ type: 'text', text: '[Old tool result content cleared]' }]);
    expect(proj.messages[2]!.message.content[0]).toMatchObject({ text: bigText });
  });

  it('context.undo clamps the micro-compaction cutoff by history-entry count, not array length (surviving marker)', () => {
    const bigText = 'x'.repeat(2000);
    const toolMsg = (id: string, text: string) => ({
      role: 'tool' as const, content: [{ type: 'text' as const, text }], toolCalls: [], toolCallId: id,
    });
    const userMsg = (text: string) => ({
      role: 'user' as const, content: [{ type: 'text' as const, text }], toolCalls: [],
      origin: { kind: 'user' as const },
    });
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const, message: userMsg('u1') }, raw: {} },
      { lineNo: 2, data: turnPrompt('u2'), raw: {} },
      { lineNo: 2, data: { type: 'context.append_message' as const, message: userMsg('u2') }, raw: {} },
      { lineNo: 3, data: { type: 'context.undo' as const, count: 1 }, raw: {} },
      { lineNo: 4, data: turnPrompt('u3'), raw: {} },
      { lineNo: 4, data: { type: 'context.append_message' as const, message: userMsg('u3') }, raw: {} },
      { lineNo: 5, data: { type: 'micro_compaction.apply' as const, cutoff: 5 }, raw: {} },
      { lineNo: 6, data: { type: 'context.undo' as const, count: 1 }, raw: {} },
      { lineNo: 7, data: { type: 'context.append_message' as const, message: toolMsg('n0', bigText) }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    expect(proj.messages.map((m) => m.source)).toEqual([
      'append_message', 'undo', 'undo', 'append_message',
    ]);
    expect(proj.messages[3]!.message.content).toEqual([{ type: 'text', text: bigText }]);
  });

  it('accumulates goal state from goal.create/update and clears on goal.clear', () => {
    const base = [
      { lineNo: 1, data: { type: 'goal.create' as const, goalId: 'g1', objective: 'ship it', completionCriterion: 'tests green' }, raw: {} },
      { lineNo: 2, data: { type: 'goal.update' as const, status: 'active', turnsUsed: 3, actor: 'model' }, raw: {} },
    ];
    const proj = projectContext(base as any);
    expect(proj.goal).toMatchObject({ goalId: 'g1', objective: 'ship it', status: 'active', turnsUsed: 3, actor: 'model' });

    const cleared = projectContext([...base, { lineNo: 3, data: { type: 'goal.clear' as const }, raw: {} }] as any);
    expect(cleared.goal).toBeNull();
  });

  it('tracks swarm mode enter/exit', () => {
    const enter = projectContext([{ lineNo: 1, data: { type: 'swarm_mode.enter' as const, trigger: 'task' }, raw: {} }] as any);
    expect(enter.swarm).toEqual({ active: true, trigger: 'task' });
    const exit = projectContext([
      { lineNo: 1, data: { type: 'swarm_mode.enter' as const, trigger: 'task' }, raw: {} },
      { lineNo: 2, data: { type: 'swarm_mode.exit' as const }, raw: {} },
    ] as any);
    expect(exit.swarm.active).toBe(false);
  });

  it('uses the latest step.end usage as the absolute context-token snapshot', () => {
    const entries = [
      { lineNo: 1, data: { type: 'context.append_loop_event' as const,
          event: { type: 'step.begin' as const, uuid: 's1', turnId: 't1', step: 0 } }, raw: {} },
      { lineNo: 2, data: { type: 'context.append_loop_event' as const,
          event: { type: 'step.end' as const, uuid: 's1', turnId: 't1', step: 0,
            usage: { inputOther: 10, output: 5, inputCacheRead: 2, inputCacheCreation: 3 } } }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    expect(proj.contextTokens).toBe(20);
  });

  it('uses context.update_token_count as the latest absolute context-token snapshot', () => {
    const entries = [
      { lineNo: 1, data: { type: 'context.update_token_count' as const, tokenCount: 42 }, raw: {} },
    ];

    const proj = projectContext(entries as any);

    expect(proj.contextTokens).toBe(42);
  });

  for (const mode of ['model', 'full'] as const) {
    it(`resets contextTokens to 0 after a context.clear (mode=${mode})`, () => {
      const entries = [
        { lineNo: 1, data: { type: 'context.append_loop_event' as const,
            event: { type: 'step.begin' as const, uuid: 's1', turnId: 't1', step: 0 } }, raw: {} },
        { lineNo: 2, data: { type: 'context.append_loop_event' as const,
            event: { type: 'step.end' as const, uuid: 's1', turnId: 't1', step: 0,
              usage: { inputOther: 10, output: 5, inputCacheRead: 2, inputCacheCreation: 3 } } }, raw: {} },
        { lineNo: 3, data: { type: 'context.clear' as const }, raw: {} },
      ];
      const proj = projectContext(entries as any, mode);
      expect(proj.contextTokens).toBe(0);
    });

    it(`sets contextTokens to tokensAfter after a context.apply_compaction (mode=${mode})`, () => {
      const entries = [
        { lineNo: 1, data: { type: 'context.append_loop_event' as const,
            event: { type: 'step.begin' as const, uuid: 's1', turnId: 't1', step: 0 } }, raw: {} },
        { lineNo: 2, data: { type: 'context.append_loop_event' as const,
            event: { type: 'step.end' as const, uuid: 's1', turnId: 't1', step: 0,
              usage: { inputOther: 100, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } } }, raw: {} },
        { lineNo: 3, data: { type: 'context.apply_compaction' as const,
            summary: 'sum', compactedCount: 0, tokensBefore: 100, tokensAfter: 30 }, raw: {} },
      ];
      const proj = projectContext(entries as any, mode);
      expect(proj.contextTokens).toBe(30);
    });
  }

  it("defaults to 'model' mode when no 2nd arg is passed (keeps recent user messages + summary)", () => {
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'm0' }], toolCalls: [] } }, raw: {} },
      { lineNo: 2, data: { type: 'context.append_message' as const,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'm1' }], toolCalls: [] } }, raw: {} },
      { lineNo: 3, data: { type: 'context.apply_compaction' as const,
          summary: 'sum', compactedCount: 2, tokensBefore: 100, tokensAfter: 10,
          keptUserMessageCount: 2 }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    expect(proj.messages.map((m) => m.source)).toEqual([
      'append_message', 'append_message', 'compaction_summary', 'append_message',
    ]);
    expect(proj.messages[0]!.message.content[0]).toMatchObject({ text: 'm0' });
    expect(proj.messages[1]!.message.content[0]).toMatchObject({ text: 'm1' });
  });

  it("full mode keeps the pre-compaction messages plus the summary marker plus the tail", () => {
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'm0' }], toolCalls: [] } }, raw: {} },
      { lineNo: 2, data: { type: 'context.append_message' as const,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'm1' }], toolCalls: [] } }, raw: {} },
      { lineNo: 3, data: { type: 'context.apply_compaction' as const,
          summary: 'sum', compactedCount: 2, tokensBefore: 100, tokensAfter: 10 }, raw: {} },
      { lineNo: 4, data: { type: 'context.append_message' as const,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'm3' }], toolCalls: [] } }, raw: {} },
    ];
    const proj = projectContext(entries as any, 'full');
    expect(proj.messages.map((m) => m.source)).toEqual([
      'append_message', 'append_message', 'compaction_summary', 'append_message',
    ]);
    expect(proj.messages[0]!.message.content[0]).toMatchObject({ text: 'm0' });
    expect(proj.messages[1]!.message.content[0]).toMatchObject({ text: 'm1' });
    expect(proj.messages[2]!.compaction).toEqual({ compactedCount: 2, tokensBefore: 100, tokensAfter: 10 });
    expect(proj.messages[2]!.message.origin).toEqual({ kind: 'compaction_summary' });
    expect(proj.messages[3]!.message.content[0]).toMatchObject({ text: 'm3' });
  });

  it("full mode keeps the undone messages and only appends an undo marker (no splice)", () => {
    const userMsg = (text: string) => ({
      role: 'user' as const, content: [{ type: 'text' as const, text }], toolCalls: [],
      origin: { kind: 'user' as const },
    });
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const, message: userMsg('u1') }, raw: {} },
      { lineNo: 2, data: { type: 'context.append_message' as const,
          message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'a1' }], toolCalls: [] } }, raw: {} },
      { lineNo: 3, data: turnPrompt('u2'), raw: {} },
      { lineNo: 3, data: { type: 'context.append_message' as const, message: userMsg('u2') }, raw: {} },
      { lineNo: 4, data: { type: 'context.undo' as const, count: 1 }, raw: {} },
    ];
    const proj = projectContext(entries as any, 'full');
    expect(proj.messages.map((m) => m.source)).toEqual([
      'append_message', 'append_message', 'append_message', 'undo',
    ]);
    expect(proj.messages[0]!.message.content[0]).toMatchObject({ text: 'u1' });
    expect(proj.messages[1]!.message.content[0]).toMatchObject({ text: 'a1' });
    expect(proj.messages[2]!.message.content[0]).toMatchObject({ text: 'u2' });
    expect(proj.messages[3]!.undo).toEqual({ count: 1, removedMessageCount: 1 });
    expect(proj.messages[3]!.lineNo).toBe(4);
  });

  it("full mode keeps pre-clear messages and inserts a 'clear' marker (not emptied)", () => {
    const entries = [
      { lineNo: 2, data: { type: 'context.append_message' as const,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'a' }], toolCalls: [] } }, raw: {} },
      { lineNo: 3, data: { type: 'context.clear' as const }, raw: {} },
      { lineNo: 4, data: { type: 'context.append_message' as const,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'b' }], toolCalls: [] } }, raw: {} },
    ];
    const proj = projectContext(entries as any, 'full');
    expect(proj.messages.map((m) => m.source)).toEqual(['append_message', 'clear', 'append_message']);
    expect(proj.messages[0]!.message.content[0]).toMatchObject({ text: 'a' });
    expect(proj.messages[1]!.source).toBe('clear');
    expect(proj.messages[1]!.lineNo).toBe(3);
    expect(proj.messages[2]!.message.content[0]).toMatchObject({ text: 'b' });
  });

  it("full mode does NOT blank the tool result on micro-compaction (shows original content)", () => {
    const bigText = 'x'.repeat(2000);
    const toolMsg = (id: string, text: string) => ({
      role: 'tool' as const, content: [{ type: 'text' as const, text }], toolCalls: [], toolCallId: id,
    });
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const, message: toolMsg('c0', bigText) }, raw: {} },
      { lineNo: 2, data: { type: 'context.append_message' as const, message: toolMsg('c1', bigText) }, raw: {} },
      { lineNo: 3, data: { type: 'micro_compaction.apply' as const, cutoff: 1 }, raw: {} },
    ];
    const proj = projectContext(entries as any, 'full');
    expect(proj.messages[0]!.message.content[0]).toMatchObject({ text: bigText });
    expect(proj.messages[1]!.message.content[0]).toMatchObject({ text: bigText });
  });

  it('folds v2 token_counting records into the context-window fill', () => {
    const entries = [
      { lineNo: 1, data: { type: 'token_counting.measured' as const, agentId: 'main', length: 10, tokens: 12345 }, raw: {} },
      { lineNo: 2, data: { type: 'token_counting.turn_recorded' as const, agentId: 'main', turnId: 1, length: 12, tokens: 13000 }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    expect(proj.contextTokens).toBe(13000);
  });

  it('resets the context-window fill on context.clear after token_counting', () => {
    const entries = [
      { lineNo: 1, data: { type: 'token_counting.rebased' as const, agentId: 'main', length: 3, tokens: 5000, measured: true }, raw: {} },
      { lineNo: 2, data: { type: 'context.clear' as const, agentId: 'main' }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    expect(proj.contextTokens).toBe(0);
  });

  it('reads the config snapshot from v2 profile.bind', () => {
    const entries = [
      { lineNo: 1, data: { type: 'profile.bind' as const, agentId: 'main',
          modelAlias: 'k2', profileName: 'agent', thinkingEffort: 'high', systemPrompt: 'You are Kimi.',
          environmentDisclosure: { cwd: '/repo' }, disallowedTools: [] }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    expect(proj.config).toEqual({
      cwd: '/repo', modelAlias: 'k2', profileName: 'agent',
      thinkingEffort: 'high', systemPrompt: 'You are Kimi.',
    });
  });

  it('accepts v2 config.update with environmentDisclosure cwd and thinkingLevel', () => {
    const entries = [
      { lineNo: 1, data: { type: 'config.update' as const, agentId: 'main',
          environmentDisclosure: { cwd: '/other' }, thinkingLevel: 'medium' }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    expect(proj.config.cwd).toBe('/other');
    expect(proj.config.thinkingEffort).toBe('medium');
  });

  it('derives the fill from the reconstructed shape when the legacy compaction omits tokens', () => {
    const summaryMessage = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'compacted so far' }],
      toolCalls: [],
    };
    const entries = [
      { lineNo: 1, data: { type: 'token_counting.measured' as const, agentId: 'main', length: 5, tokens: 7777 }, raw: {} },
      { lineNo: 2, data: { type: 'context.apply_compaction' as const, agentId: 'main',
          summary: summaryMessage, count: 2 }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    const bubble = proj.messages.at(-1)!;
    expect(bubble.source).toBe('compaction_summary');
    expect(bubble.message.content[0]).toMatchObject({ text: 'compacted so far' });
    const expected = estimateTokensForMessages([bubble.message]);
    expect(proj.contextTokens).toBe(expected);
    expect(proj.contextTokens).not.toBe(7777);
    expect(bubble.compaction).toEqual({
      compactedCount: 2, tokensBefore: undefined, tokensAfter: expected,
    });
  });

  it('apply_compaction replays a legacy tail even when compactedCount covers the whole history', () => {
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'u1' }], toolCalls: [], origin: { kind: 'user' as const } } }, raw: {} },
      { lineNo: 2, data: { type: 'context.append_message' as const,
          message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'a1' }], toolCalls: [] } }, raw: {} },
      { lineNo: 3, data: { type: 'context.apply_compaction' as const,
          summary: 'sum', compactedCount: 99, tokensAfter: 50 }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    expect(proj.messages.map((m) => m.source)).toEqual(['compaction_summary']);
    expect(proj.messages[0]!.message.content[0]).toMatchObject({ text: 'sum' });
    expect(proj.contextTokens).toBe(50);
  });

  it('honors an explicit legacyTail flag even when keptUserMessageCount is present', () => {
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'u1' }], toolCalls: [], origin: { kind: 'user' as const } } }, raw: {} },
      { lineNo: 2, data: { type: 'context.append_message' as const,
          message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'a2 (tail)' }], toolCalls: [] } }, raw: {} },
      { lineNo: 3, data: { type: 'context.apply_compaction' as const,
          summary: 'sum', compactedCount: 1, tokensAfter: 5,
          keptUserMessageCount: 1, legacyTail: true }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    expect(proj.messages.map((m) => m.source)).toEqual(['compaction_summary', 'append_message']);
    expect(proj.messages[1]!.message.content[0]).toMatchObject({ text: 'a2 (tail)' });
    expect(proj.contextTokens).toBe(5);
  });

  it('normalizes the legacy background_task origin to task', () => {
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const, agentId: 'main',
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'bg done' }], toolCalls: [],
            origin: { kind: 'background_task', status: 'completed' } } }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    expect(proj.messages[0]!.message.origin).toMatchObject({ kind: 'task', status: 'completed' });
  });

  it('ignores v2 lifecycle/task bookkeeping records for context state', () => {
    const entries = [
      { lineNo: 1, data: { type: 'turn.prompt' as const, agentId: 'main', input: [{ type: 'text' as const, text: 'hi' }], origin: { kind: 'user' as const } }, raw: {} },
      { lineNo: 2, data: { type: 'turn.ended' as const, agentId: 'main', turnId: 1, reason: 'completed' as const }, raw: {} },
      { lineNo: 3, data: { type: 'prompt.completed' as const, agentId: 'main', promptId: 'p1', finishedAt: '2026-09-01T00:00:00Z', reason: 'completed' as const }, raw: {} },
      { lineNo: 4, data: { type: 'interaction.request' as const, agentId: 'main', id: 'i1', kind: 'approval' as const, request: {} }, raw: {} },
      { lineNo: 5, data: { type: 'task.started' as const, agentId: 'main', info: { taskId: 'bash-abc12345', description: 'x', status: 'running' as const, startedAt: 1, endedAt: null } }, raw: {} },
      { lineNo: 6, data: { type: 'cron.add' as const, agentId: 'main', task: { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', cron: '* * * * *', prompt: 'p', createdAt: 1 } }, raw: {} },
      { lineNo: 7, data: { type: 'plan.revision' as const, agentId: 'main', id: 'plan1', version: 2, key: 'k', sha256: 's', bytes: 10 }, raw: {} },
      { lineNo: 8, data: { type: 'environment.set_binding' as const, agentId: 'main', workspaceId: 'w', environmentId: 'r' }, raw: {} },
      { lineNo: 9, data: { type: 'staleGuard.recorded' as const, path: '/x', mtimeMs: 1 }, raw: {} },
      { lineNo: 10, data: { type: 'interruptionReminder.recorded' as const, agentId: 'main', turnId: 1 }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    expect(proj.messages).toEqual([]);
    expect(proj.contextTokens).toBe(0);
    expect(proj.usage.byScope.session).toEqual({
      inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0,
    });
  });
});
