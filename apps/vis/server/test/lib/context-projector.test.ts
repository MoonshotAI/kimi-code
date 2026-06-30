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

  it('does not reset contextTokens on a zero-usage step.end', () => {
    const entries = [
      { lineNo: 1, data: { type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 's1', turnId: 'T', step: 0 } }, raw: {} },
      { lineNo: 2, data: { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 's1', turnId: 'T', step: 0, usage: { inputOther: 100, output: 20, inputCacheRead: 80, inputCacheCreation: 0 } } }, raw: {} },
      { lineNo: 3, data: { type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 's2', turnId: 'T', step: 1 } }, raw: {} },
      // content-filtered response: usage all zero — must NOT reset the fill to 0.
      { lineNo: 4, data: { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 's2', turnId: 'T', step: 1, finishReason: 'filtered', usage: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } } }, raw: {} },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proj = projectContext(entries as any);
    expect(proj.contextTokens).toBe(200); // step1 fill 200, kept across the zero step
  });

  // ---- Fix G: tool.result content must match what the model saw ---------------
  // agent-core's `ContextMemory.appendLoopEvent` (`tool.result` case) stores
  // `createToolMessage(toolCallId, toolResultOutputForModel(event.result))`, NOT
  // the raw `event.result.output`. `toolResultOutputForModel`
  // (`packages/agent-core/src/agent/context/index.ts` ~line 350) normalizes
  // error / empty outputs with sentinel strings. The projector must replicate
  // that normalization so the model-view shows the content the model actually
  // received for failed / empty tool calls.

  const TOOL_ERROR_STATUS = '<system>ERROR: Tool execution failed.</system>';
  const TOOL_EMPTY_STATUS = '<system>Tool output is empty.</system>';
  const TOOL_EMPTY_ERROR_STATUS =
    '<system>ERROR: Tool execution failed. Tool output is empty.</system>';

  /** Build a minimal wire fixture: one assistant step with a tool call, then a
   *  `tool.result` loop event carrying `result`. Returns the projected tool
   *  message (last entry). */
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
          event: { type: 'step.end' as const, uuid: 's1', turnId: 't1', step: 0 },
        },
        raw: {},
      },
      {
        lineNo: 4,
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
    ];
    const proj = projectContext(entries as any);
    return proj.messages.at(-1)!.message;
  };

  it('tool.result: error string output is prefixed with the error sentinel', () => {
    const msg = projectToolResult({ output: 'boom: file not found', isError: true });
    expect(msg.role).toBe('tool');
    expect(msg.toolCallId).toBe('call_1');
    expect(msg.isError).toBe(true);
    expect(msg.content).toEqual([
      { type: 'text', text: `${TOOL_ERROR_STATUS}\nboom: file not found` },
    ]);
  });

  it('tool.result: error string already starting with <system>ERROR: is passed through (no double prefix)', () => {
    const text = '<system>ERROR: already wrapped</system>\ndetails here';
    const msg = projectToolResult({ output: text, isError: true });
    expect(msg.content).toEqual([{ type: 'text', text }]);
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
    // Model view: the kept user prompt + user-role summary + the new prompt.
    expect(proj.messages.map((m) => m.source)).toEqual([
      'append_message', 'compaction_summary', 'append_message',
    ]);
    expect(proj.messages[0]!.message.content[0]).toMatchObject({ text: 'old' });
    // The compaction summary is a user message (agent-core's own
    // representation), not a synthetic system message.
    expect(proj.messages[1]!.message.role).toBe('user');
    expect(proj.messages[1]!.message.origin).toEqual({ kind: 'compaction_summary' });
    expect(proj.messages[1]!.message.content[0]).toMatchObject({ text: 'old stuff' });
    expect(proj.messages[2]!.message.content[0]).toMatchObject({ text: 'new' });
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
      { text: 'old' },
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
          summary: 'sum', compactedCount: 3, tokensBefore: 100, tokensAfter: 10 }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    // [m0, m1, summary] — real user prompts are kept verbatim, the assistant
    // tail is dropped.
    expect(proj.messages).toHaveLength(3);
    expect(proj.messages.map((m) => m.source)).toEqual([
      'append_message', 'append_message', 'compaction_summary',
    ]);
    expect(proj.messages[0]!.message.content[0]).toMatchObject({ text: 'm0' });
    expect(proj.messages[1]!.message.content[0]).toMatchObject({ text: 'm1' });
    expect(proj.messages[2]!.compaction).toEqual({ compactedCount: 3, tokensBefore: 100, tokensAfter: 10 });
    expect(proj.messages[2]!.message.content[0]).toMatchObject({ text: 'sum' });
  });

  it('apply_compaction mirrors the legacy verbatim tail for records without keptUserMessageCount (model)', () => {
    // A pre-rework record has no keptUserMessageCount. agent-core's restore keeps
    // the old `[summary, ...history.slice(compactedCount)]` tail (assistant/tool
    // included), so the model view must do the same instead of applying the new
    // kept-user selection — otherwise it would hide the assistant tail the resumed
    // agent still has, and surface a pre-compaction user message the agent dropped.
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'u0 (compacted away)' }], toolCalls: [], origin: { kind: 'user' as const } } }, raw: {} },
      { lineNo: 2, data: { type: 'context.append_message' as const,
          message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'a1' }], toolCalls: [] } }, raw: {} },
      { lineNo: 3, data: { type: 'context.append_message' as const,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'u2 (tail)' }], toolCalls: [], origin: { kind: 'user' as const } } }, raw: {} },
      { lineNo: 4, data: { type: 'context.append_message' as const,
          message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'a3 (tail)' }], toolCalls: [] } }, raw: {} },
      // Legacy record: no keptUserMessageCount, compactedCount(2) < history(4).
      { lineNo: 5, data: { type: 'context.apply_compaction' as const,
          summary: 'sum', compactedCount: 2, tokensBefore: 100, tokensAfter: 10 }, raw: {} },
    ];

    const model = projectContext(entries as any);
    // [summary, u2, a3] — the verbatim tail beyond compactedCount, summary first.
    expect(model.messages.map((m) => m.source)).toEqual([
      'compaction_summary', 'append_message', 'append_message',
    ]);
    expect(model.messages.map((m) => m.message.content[0])).toMatchObject([
      { text: 'sum' }, { text: 'u2 (tail)' }, { text: 'a3 (tail)' },
    ]);
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
          summary: 'sum', compactedCount: 5, tokensBefore: 100, tokensAfter: 10 }, raw: {} },
      { lineNo: 7, data: { type: 'context.append_message' as const,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'new' }], toolCalls: [], origin: { kind: 'user' as const } } }, raw: {} },
    ];

    const model = projectContext(entries as any);
    expect(model.messages.map((m) => m.source)).toEqual([
      'append_message', 'compaction_summary', 'append_message',
    ]);
    expect(model.messages.map((m) => m.message.content[0])).toMatchObject([
      { text: 'real user' }, { text: 'sum' }, { text: 'new' },
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

  // ---- Fix ④: UI-only markers must not offset agent-core history indices ------
  // agent-core computes compactedCount (and the micro-compaction cutoff) as
  // indices into _history, which NEVER contains the synthetic 'undo'/'clear'
  // markers we push into our messages array. So index-based ops must count ONLY
  // real history entries (append_message + compaction_summary), skipping
  // 'undo'/'clear' markers.

  it('apply_compaction keeps user messages across a preceding undo marker (model)', () => {
    const userMsg = (text: string) => ({
      role: 'user' as const, content: [{ type: 'text' as const, text }], toolCalls: [],
      origin: { kind: 'user' as const },
    });
    // Step 1: append u1, u2 then undo(1) → removes u2, leaves [u1, <undo marker>].
    // Step 2: append u3, u4 → array is [u1, <undo marker>, u3, u4].
    // History entries (agent-core _history, which has NO marker) are the three
    // real user prompts [u1, u3, u4]. Compaction keeps all of them (they fit the
    // budget) and appends the summary, dropping only the synthetic undo marker.
    // This pins that the marker does not offset the kept-user selection — a naive
    // array-slice would have retained the wrong prompts.
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const, message: userMsg('u1') }, raw: {} },
      { lineNo: 2, data: { type: 'context.append_message' as const, message: userMsg('u2') }, raw: {} },
      { lineNo: 3, data: { type: 'context.undo' as const, count: 1 }, raw: {} },
      { lineNo: 4, data: { type: 'context.append_message' as const, message: userMsg('u3') }, raw: {} },
      { lineNo: 5, data: { type: 'context.append_message' as const, message: userMsg('u4') }, raw: {} },
      { lineNo: 6, data: { type: 'context.apply_compaction' as const,
          summary: 'sum', compactedCount: 3, tokensBefore: 100, tokensAfter: 10 }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    // Correct: [u1, u3, u4, summary]. The marker is gone, all real prompts kept.
    expect(proj.messages.map((m) => m.source)).toEqual([
      'append_message', 'append_message', 'append_message', 'compaction_summary',
    ]);
    expect(proj.messages.map((m) => m.message.content[0])).toMatchObject([
      { text: 'u1' }, { text: 'u3' }, { text: 'u4' }, { text: 'sum' },
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
    // Step 1: append tool c0, user u1 then undo(1) → removes u1, leaves
    //   [c0, <undo marker>].
    // Step 2: append tool c1 → array is [c0, <undo marker>, c1].
    // History entries (no marker) are [c0, c1]. A micro cutoff=2 means "blank the
    // first 2 HISTORY entries" → both c0 AND c1 must be blanked.
    //
    // The naive array-index pass (i < cutoff=2 over the messages array) would
    // blank array index 0 (c0) and index 1 (the undo marker — a no-op since it is
    // not a tool message), then STOP before reaching c1 at array index 2, leaving
    // c1 WRONGLY un-blanked. This pins the history-aware behaviour and FAILS
    // against the naive array-index pass.
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const, message: toolMsg('c0', bigText) }, raw: {} },
      { lineNo: 2, data: { type: 'context.append_message' as const, message: userMsg('u1') }, raw: {} },
      { lineNo: 3, data: { type: 'context.undo' as const, count: 1 }, raw: {} },
      { lineNo: 4, data: { type: 'context.append_message' as const, message: toolMsg('c1', bigText) }, raw: {} },
      { lineNo: 5, data: { type: 'micro_compaction.apply' as const, cutoff: 2 }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    expect(proj.messages.map((m) => m.source)).toEqual(['append_message', 'undo', 'append_message']);
    // Both real tool results are within the first 2 history entries → both blanked.
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
      { lineNo: 3, data: { type: 'context.append_message' as const, message: userMsg('u2') }, raw: {} },
      { lineNo: 4, data: { type: 'context.undo' as const, count: 1 }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    // count=1 removes u2 (the last real user prompt). u1 + a1 remain, then an undo marker.
    expect(proj.messages.map((m) => m.source)).toEqual(['append_message', 'append_message', 'undo']);
    expect(proj.messages[0]!.message.content[0]).toMatchObject({ text: 'u1' });
    expect(proj.messages[1]!.message.content[0]).toMatchObject({ text: 'a1' });
    expect(proj.messages[2]!.undo).toEqual({ count: 1, removedMessageCount: 1 });
    expect(proj.messages[2]!.lineNo).toBe(4);
  });

  it('context.undo keeps injection messages inside the undo window (skip, not remove)', () => {
    const userMsg = (text: string) => ({
      role: 'user' as const, content: [{ type: 'text' as const, text }], toolCalls: [],
      origin: { kind: 'user' as const },
    });
    const injectionMsg = (text: string) => ({
      role: 'user' as const, content: [{ type: 'text' as const, text }], toolCalls: [],
      origin: { kind: 'injection' as const },
    });
    // Layout: [u1, a1, u2, INJECTION, a2]. undo(1) walks from the end:
    //   a2  → removed (non-injection)
    //   INJECTION → skipped (kept), NOT counted
    //   u2  → removed, real user prompt → count(1) reached → stop.
    // The injection sits INSIDE the undo window (between the trailing real user
    // prompt u2 and the cutoff) and must SURVIVE; u2 and a2 around it are gone.
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const, message: userMsg('u1') }, raw: {} },
      { lineNo: 2, data: { type: 'context.append_message' as const,
          message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'a1' }], toolCalls: [] } }, raw: {} },
      { lineNo: 3, data: { type: 'context.append_message' as const, message: userMsg('u2') }, raw: {} },
      { lineNo: 4, data: { type: 'context.append_message' as const, message: injectionMsg('inj') }, raw: {} },
      { lineNo: 5, data: { type: 'context.append_message' as const,
          message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'a2' }], toolCalls: [] } }, raw: {} },
      { lineNo: 6, data: { type: 'context.undo' as const, count: 1 }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    // u1, a1 remain; the injection survives in place; u2 + a2 removed; undo marker last.
    expect(proj.messages.map((m) => m.source)).toEqual([
      'append_message', 'append_message', 'append_message', 'undo',
    ]);
    expect(proj.messages[0]!.message.content[0]).toMatchObject({ text: 'u1' });
    expect(proj.messages[1]!.message.content[0]).toMatchObject({ text: 'a1' });
    expect(proj.messages[2]!.message.origin).toEqual({ kind: 'injection' });
    expect(proj.messages[2]!.message.content[0]).toMatchObject({ text: 'inj' });
    // removedMessageCount counts only the removed (non-skipped) messages: u2 + a2 = 2.
    expect(proj.messages[3]!.undo).toEqual({ count: 1, removedMessageCount: 2 });
  });

  it('micro_compaction.apply blanks tool-result content before the cutoff', () => {
    const bigText = 'x'.repeat(2000); // comfortably above the 100-token min
    const toolMsg = (id: string, text: string) => ({
      role: 'tool' as const, content: [{ type: 'text' as const, text }], toolCalls: [], toolCallId: id,
    });
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const, message: toolMsg('c0', bigText) }, raw: {} },
      { lineNo: 2, data: { type: 'context.append_message' as const, message: toolMsg('c1', bigText) }, raw: {} },
      { lineNo: 3, data: { type: 'micro_compaction.apply' as const, cutoff: 1 }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    // index 0 < cutoff(1) and is a large tool message → blanked; index 1 kept.
    expect(proj.messages[0]!.message.content).toEqual([{ type: 'text', text: '[Old tool result content cleared]' }]);
    expect(proj.messages[1]!.message.content[0]).toMatchObject({ text: bigText });
  });

  it('micro_compaction.apply counts think parts toward the min-content gate', () => {
    // A tool result dominated by a large `think` part (tiny text) must clear the
    // min-content gate and be blanked — mirroring agent-core's token estimator,
    // which counts both text and think parts.
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
    // ~150 CJK chars. Under a naive chars/4 estimate this is ~38 tokens (< 100
    // gate → NOT blanked, the bug). agent-core counts each non-ASCII char as a
    // full token → ~150 tokens (>= gate → blanked). Assert it IS blanked, so a
    // Chinese-heavy tool result diverges from agent-core no longer.
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
    // clear() ran reset() → cutoff back to 0, so the new tool messages must NOT be blanked.
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
    // applyCompaction() ran reset() → cutoff back to 0. Result: [summary, n0].
    // n0 must NOT be blanked.
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
    // Layout: [tool c0, user u1, tool c2]. cutoff=3 covers all three. undo(1)
    // removes the trailing real user prompt u1 AND the messages after it (c2),
    // walking from the end: c2 (removed, not a user prompt), u1 (removed, user
    // prompt → count reached). Remaining: [c0, undo-marker]. The cutoff must be
    // clamped to min(3, postLen) so a LATER appended tool message is not blanked
    // by the stale large cutoff.
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const, message: toolMsg('c0', bigText) }, raw: {} },
      { lineNo: 2, data: { type: 'context.append_message' as const, message: userMsg('u1') }, raw: {} },
      { lineNo: 3, data: { type: 'context.append_message' as const, message: toolMsg('c2', bigText) }, raw: {} },
      { lineNo: 4, data: { type: 'micro_compaction.apply' as const, cutoff: 3 }, raw: {} },
      { lineNo: 5, data: { type: 'context.undo' as const, count: 1 }, raw: {} },
      // appended AFTER undo: index 2 in the final list ([c0, undo-marker, n0]).
      { lineNo: 6, data: { type: 'context.append_message' as const, message: toolMsg('n0', bigText) }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    // After undo: [c0, undo-marker]; then n0 appended → [c0, undo-marker, n0].
    // Clamp made cutoff = min(3, 2) = 2, so n0 (index 2) is NOT blanked.
    // c0 (index 0 < 2) IS still blanked (the still-valid prefix).
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
    // A PRIOR undo must leave a surviving marker so that, at a LATER undo's clamp,
    // the array length exceeds the history-entry count by that marker. agent-core
    // clamps against `_history.length` (NO markers); clamping against
    // `messages.length` here would be one too high and wrongly blank a later
    // tool result.
    //
    // Trace (model mode):
    //   1. append u1, u2 → [u1, u2]
    //   2. undo(1) removes u2 → [u1] then pushes marker → [u1, <undo#1>]
    //   3. append u3 → [u1, <undo#1>, u3]
    //   4. micro_compaction cutoff=5 (large) → microCutoff=5
    //   5. undo(1) removes u3 (cutoff index 2); the <undo#1> marker at index 1
    //      SURVIVES (1 < 2) → [u1, <undo#1>]. Clamp:
    //        - buggy  min(5, messages.length=2) = 2
    //        - fixed  min(5, historyCount=1)    = 1   (u1 is history; marker is not)
    //      then push <undo#2> → [u1, <undo#1>, <undo#2>]
    //   6. append big tool n0 → [u1, <undo#1>, <undo#2>, n0]
    //
    // Final blanking iterates history entries only (markers skipped). n0 is at
    // history index 1 (only u1 precedes it as a history entry). It is blanked iff
    // historyIndex(1) < microCutoff:
    //   - buggy  microCutoff=2 → 1 < 2 → n0 WRONGLY blanked
    //   - fixed  microCutoff=1 → 1 >= 1 → pass breaks → n0 preserved
    // So this is RED (n0 blanked) under the messages.length clamp and GREEN under
    // the history-count clamp.
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const, message: userMsg('u1') }, raw: {} },
      { lineNo: 2, data: { type: 'context.append_message' as const, message: userMsg('u2') }, raw: {} },
      { lineNo: 3, data: { type: 'context.undo' as const, count: 1 }, raw: {} },
      { lineNo: 4, data: { type: 'context.append_message' as const, message: userMsg('u3') }, raw: {} },
      { lineNo: 5, data: { type: 'micro_compaction.apply' as const, cutoff: 5 }, raw: {} },
      { lineNo: 6, data: { type: 'context.undo' as const, count: 1 }, raw: {} },
      // appended AFTER the second undo, at history index 1.
      { lineNo: 7, data: { type: 'context.append_message' as const, message: toolMsg('n0', bigText) }, raw: {} },
    ];
    const proj = projectContext(entries as any);
    expect(proj.messages.map((m) => m.source)).toEqual([
      'append_message', 'undo', 'undo', 'append_message',
    ]);
    // u1 (history index 0 < cutoff) is blanked-eligible but is a user message, so
    // unchanged. n0 (history index 1) must NOT be blanked: its original content
    // is preserved, not replaced by the cleared marker.
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
    expect(proj.contextTokens).toBe(20); // 10+5+2+3, absolute (not summed across usage.record)
  });

  // ---- Fix ②: contextTokens updates on clear / compaction lifecycle events ---
  // agent-core ContextMemory sets _tokenCount on clear() (→ 0) and
  // applyCompaction(result) (→ result.tokensAfter), not only on step.end. These
  // are derived state, so they apply identically in both projection modes.

  for (const mode of ['model', 'full'] as const) {
    it(`resets contextTokens to 0 after a context.clear (mode=${mode})`, () => {
      const entries = [
        { lineNo: 1, data: { type: 'context.append_loop_event' as const,
            event: { type: 'step.begin' as const, uuid: 's1', turnId: 't1', step: 0 } }, raw: {} },
        { lineNo: 2, data: { type: 'context.append_loop_event' as const,
            event: { type: 'step.end' as const, uuid: 's1', turnId: 't1', step: 0,
              usage: { inputOther: 10, output: 5, inputCacheRead: 2, inputCacheCreation: 3 } } }, raw: {} },
        // clear() is the last token-affecting event → contextTokens must be 0.
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
        // applyCompaction is the last token-affecting event → contextTokens must
        // be tokensAfter (30), not the pre-compaction step.end snapshot (100).
        { lineNo: 3, data: { type: 'context.apply_compaction' as const,
            summary: 'sum', compactedCount: 0, tokensBefore: 100, tokensAfter: 30 }, raw: {} },
      ];
      const proj = projectContext(entries as any, mode);
      expect(proj.contextTokens).toBe(30);
    });
  }

  // ---- Full-history mode (Unit 6) -------------------------------------------
  // In 'full' mode the four destructive lifecycle events insert an inline
  // marker but do NOT mutate/drop the surrounding message list. 'model' mode
  // (the default) keeps the existing model's-eye behaviour byte-identical.

  it("defaults to 'model' mode when no 2nd arg is passed (keeps recent user messages + summary)", () => {
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'm0' }], toolCalls: [] } }, raw: {} },
      { lineNo: 2, data: { type: 'context.append_message' as const,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'm1' }], toolCalls: [] } }, raw: {} },
      { lineNo: 3, data: { type: 'context.apply_compaction' as const,
          summary: 'sum', compactedCount: 2, tokensBefore: 100, tokensAfter: 10 }, raw: {} },
    ];
    // No 2nd arg → 'model' default: the real user prompts are kept verbatim and
    // the summary is appended after them.
    const proj = projectContext(entries as any);
    expect(proj.messages.map((m) => m.source)).toEqual([
      'append_message', 'append_message', 'compaction_summary',
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
    // m0, m1 are KEPT (not dropped), then the summary marker is appended inline,
    // then the post-compaction tail (m3). Contrast the model-mode test above
    // which drops the first compactedCount messages.
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
      { lineNo: 3, data: { type: 'context.append_message' as const, message: userMsg('u2') }, raw: {} },
      { lineNo: 4, data: { type: 'context.undo' as const, count: 1 }, raw: {} },
    ];
    const proj = projectContext(entries as any, 'full');
    // All three messages are KEPT, then an undo marker is appended. The
    // removedMessageCount still reflects what WOULD have been removed (u2 → 1).
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
    // 'a' KEPT, then a 'clear' marker, then 'b' — not emptied.
    expect(proj.messages.map((m) => m.source)).toEqual(['append_message', 'clear', 'append_message']);
    expect(proj.messages[0]!.message.content[0]).toMatchObject({ text: 'a' });
    expect(proj.messages[1]!.source).toBe('clear');
    expect(proj.messages[1]!.lineNo).toBe(3);
    expect(proj.messages[2]!.message.content[0]).toMatchObject({ text: 'b' });
  });

  it("full mode does NOT blank the tool result on micro-compaction (shows original content)", () => {
    const bigText = 'x'.repeat(2000); // comfortably above the 100-token min
    const toolMsg = (id: string, text: string) => ({
      role: 'tool' as const, content: [{ type: 'text' as const, text }], toolCalls: [], toolCallId: id,
    });
    const entries = [
      { lineNo: 1, data: { type: 'context.append_message' as const, message: toolMsg('c0', bigText) }, raw: {} },
      { lineNo: 2, data: { type: 'context.append_message' as const, message: toolMsg('c1', bigText) }, raw: {} },
      { lineNo: 3, data: { type: 'micro_compaction.apply' as const, cutoff: 1 }, raw: {} },
    ];
    const proj = projectContext(entries as any, 'full');
    // In 'model' mode index 0 would be blanked; in 'full' mode the original
    // content is preserved.
    expect(proj.messages[0]!.message.content[0]).toMatchObject({ text: bigText });
    expect(proj.messages[1]!.message.content[0]).toMatchObject({ text: bigText });
  });
});
