// Tests the facade transcript fold (wire records → rendering entries) as a
// pure reduce: no DI, no engine bootstrap. Records are shaped like the
// persisted wire log (`{ type, ...payload, time }`); fixtures mirror
// agent-core-v2's contextTranscript tests but assert the rendering
// projection (full history, compaction cards, replay records) instead of
// the model-facing context view.
import { describe, expect, it } from 'vitest';

import { COMPACTION_SUMMARY_PREFIX } from '#/core/index';
import {
  reduceTranscript,
  rehydrateTranscript,
  type TranscriptEntry,
} from '../../src/core/transcript';

function appendMessage(
  message: Record<string, unknown>,
  time = 1,
): Record<string, unknown> {
  return { type: 'context.append_message', message, time };
}

function userMessage(text: string, origin?: Record<string, unknown>): Record<string, unknown> {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    ...(origin !== undefined ? { origin } : {}),
  };
}

function loopEvent(event: Record<string, unknown>, time = 1): Record<string, unknown> {
  return { type: 'context.append_loop_event', event, time };
}

function entriesOf(records: readonly Record<string, unknown>[]): readonly TranscriptEntry[] {
  return reduceTranscript(records).entries;
}

describe('reduceTranscript context append', () => {
  it('maps append_message records into message entries verbatim', () => {
    const entries = entriesOf([
      appendMessage(userMessage('hello')),
      appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'hi there' }],
        toolCalls: [],
      }),
    ]);

    expect(entries).toEqual([
      { type: 'message', message: userMessage('hello') },
      {
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }], toolCalls: [] },
      },
    ]);
  });

  it('ignores envelope fields and unknown record types', () => {
    const entries = entriesOf([
      { type: 'turn.prompt', input: [{ type: 'text', text: 'hello' }], origin: { kind: 'user' }, time: 5 },
      { type: 'metadata', protocol_version: '1.0' },
      { nope: true },
      appendMessage(userMessage('hello')),
    ]);

    expect(entries).toEqual([{ type: 'message', message: userMessage('hello') }]);
  });
});

describe('reduceTranscript loop fold', () => {
  it('folds loop events into assistant and tool entries', () => {
    const entries = entriesOf([
      appendMessage(userMessage('run ls')),
      loopEvent({ type: 'step.begin', uuid: 's1' }),
      loopEvent({ type: 'content.part', stepUuid: 's1', part: { type: 'text', text: 'Running ' } }),
      loopEvent({ type: 'content.part', stepUuid: 's1', part: { type: 'text', text: 'ls.' } }),
      loopEvent({ type: 'tool.call', stepUuid: 's1', toolCallId: 'tc1', name: 'Bash', args: { command: 'ls' } }),
      loopEvent({ type: 'step.end', uuid: 's1' }),
      loopEvent({ type: 'tool.result', toolCallId: 'tc1', result: { output: 'file.ts' } }),
    ]);

    expect(entries).toEqual([
      { type: 'message', message: userMessage('run ls') },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Running ' },
            { type: 'text', text: 'ls.' },
          ],
          toolCalls: [
            { type: 'function', id: 'tc1', name: 'Bash', arguments: JSON.stringify({ command: 'ls' }) },
          ],
        },
      },
      {
        type: 'message',
        message: {
          role: 'tool',
          content: [{ type: 'text', text: 'file.ts' }],
          toolCalls: [],
          toolCallId: 'tc1',
          isError: undefined,
        },
      },
    ]);
  });

  it('closes an interrupted tool exchange with a placeholder result on the next step', () => {
    const entries = entriesOf([
      loopEvent({ type: 'step.begin', uuid: 's1' }),
      loopEvent({ type: 'tool.call', stepUuid: 's1', toolCallId: 'tc1', name: 'Bash', args: {} }),
      loopEvent({ type: 'step.end', uuid: 's1' }),
      loopEvent({ type: 'step.begin', uuid: 's2' }),
    ]);

    const toolEntry = entries[1];
    expect(toolEntry).toMatchObject({
      type: 'message',
      message: {
        role: 'tool',
        toolCallId: 'tc1',
        isError: true,
      },
    });
    const content = toolEntry?.type === 'message' ? toolEntry.message.content : [];
    expect(content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('interrupted') });
  });

  it('defers messages appended while a tool exchange is open', () => {
    const entries = entriesOf([
      loopEvent({ type: 'step.begin', uuid: 's1' }),
      loopEvent({ type: 'tool.call', stepUuid: 's1', toolCallId: 'tc1', name: 'Bash', args: {} }),
      appendMessage(userMessage('meanwhile')),
      loopEvent({ type: 'tool.result', toolCallId: 'tc1', result: { output: 'ok' } }),
    ]);

    expect(entries.map((e) => e.type)).toEqual(['message', 'message', 'message']);
    const roles = entries.map((e) => (e.type === 'message' ? e.message.role : e.type));
    expect(roles).toEqual(['assistant', 'tool', 'user']);
  });
});

describe('reduceTranscript compaction', () => {
  const compactionRecord = {
    type: 'context.apply_compaction',
    summary: 'Compacted history summary.',
    contextSummary: `${COMPACTION_SUMMARY_PREFIX}\nCompacted history summary.`,
    compactedCount: 2,
    tokensBefore: 1000,
    tokensAfter: 250,
    time: 3,
  };

  it('keeps the full history and appends a compaction card with token counts', () => {
    const entries = entriesOf([
      appendMessage(userMessage('before')),
      appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'answer' }], toolCalls: [] }),
      compactionRecord,
      appendMessage(userMessage('after')),
    ]);

    expect(entries).toEqual([
      { type: 'message', message: userMessage('before') },
      {
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }], toolCalls: [] },
      },
      {
        type: 'compaction',
        summary: 'Compacted history summary.',
        tokensBefore: 1000,
        tokensAfter: 250,
        compactedCount: 2,
      },
      { type: 'message', message: userMessage('after') },
    ]);
  });

  it('strips the summary prefix from legacy contextSummary-only records', () => {
    const entries = entriesOf([
      {
        type: 'context.apply_compaction',
        contextSummary: `${COMPACTION_SUMMARY_PREFIX}\nLegacy summary.`,
        compactedCount: 1,
        tokensBefore: 10,
        tokensAfter: 5,
      },
    ]);

    expect(entries).toEqual([
      {
        type: 'compaction',
        summary: 'Legacy summary.',
        tokensBefore: 10,
        tokensAfter: 5,
        compactedCount: 1,
      },
    ]);
  });

  it('does not render full_compaction lifecycle ops (the card comes from apply_compaction)', () => {
    const entries = entriesOf([
      { type: 'full_compaction.begin', instruction: undefined },
      { type: 'full_compaction.complete', summary: 'done', tokensBefore: 10, tokensAfter: 5 },
      { type: 'full_compaction.cancel' },
    ]);

    expect(entries).toEqual([]);
  });
});

describe('reduceTranscript undo and clear', () => {
  it('removes trailing messages up to N real user prompts, skipping injections', () => {
    const entries = entriesOf([
      appendMessage(userMessage('one')),
      appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'a1' }], toolCalls: [] }),
      appendMessage(userMessage('injected', { kind: 'injection', variant: 'x' })),
      appendMessage(userMessage('two')),
      appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'a2' }], toolCalls: [] }),
      { type: 'context.undo', count: 1, time: 9 },
    ]);

    expect(entries).toEqual([
      { type: 'message', message: userMessage('one') },
      {
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'a1' }], toolCalls: [] },
      },
      { type: 'message', message: userMessage('injected', { kind: 'injection', variant: 'x' }) },
    ]);
  });

  it('keeps non-message entries across an undo', () => {
    const entries = entriesOf([
      { type: 'permission.set_mode', mode: 'yolo', time: 2 },
      appendMessage(userMessage('one')),
      { type: 'context.undo', count: 1, time: 3 },
    ]);

    expect(entries).toEqual([{ type: 'permission_updated', mode: 'yolo' }]);
  });

  it('stops the undo at a compaction boundary', () => {
    const entries = entriesOf([
      appendMessage(userMessage('before')),
      {
        type: 'context.apply_compaction',
        summary: 's',
        compactedCount: 1,
        tokensBefore: 10,
        tokensAfter: 5,
      },
      appendMessage(userMessage('after')),
      { type: 'context.undo', count: 2, time: 9 },
    ]);

    // Only one real user prompt exists after the boundary; the compaction
    // card and everything before it survive.
    expect(entries).toEqual([
      { type: 'message', message: userMessage('before') },
      {
        type: 'compaction',
        summary: 's',
        tokensBefore: 10,
        tokensAfter: 5,
        compactedCount: 1,
      },
    ]);
  });

  it('clear keeps prior entries but fences off later undos', () => {
    const entries = entriesOf([
      appendMessage(userMessage('old')),
      { type: 'context.clear', time: 2 },
      appendMessage(userMessage('new')),
      { type: 'context.undo', count: 2, time: 3 },
    ]);

    // The undo may not cross the clear floor, so only the post-clear prompt
    // is removed.
    expect(entries).toEqual([{ type: 'message', message: userMessage('old') }]);
  });
});

describe('reduceTranscript domain ops', () => {
  it('maps goal lifecycle ops to goal_updated entries', () => {
    const entries = entriesOf([
      { type: 'goal.create', goalId: 'g1', objective: 'Ship it', completionCriterion: 'tests pass' },
      { type: 'goal.update', status: 'paused', reason: 'needs input', turnsUsed: 2, tokensUsed: 100, wallClockMs: 5000, actor: 'model' },
      { type: 'goal.update', status: 'complete', reason: 'done', turnsUsed: 3, tokensUsed: 150, wallClockMs: 7000, actor: 'model' },
      { type: 'goal.clear' },
    ]);

    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      type: 'goal_updated',
      change: { kind: 'created' },
      snapshot: { goalId: 'g1', objective: 'Ship it', status: 'active' },
    });
    expect(entries[1]).toMatchObject({
      type: 'goal_updated',
      change: { kind: 'lifecycle', status: 'paused', reason: 'needs input', actor: 'model' },
      snapshot: { status: 'paused', turnsUsed: 2 },
    });
    expect(entries[2]).toMatchObject({
      type: 'goal_updated',
      change: { kind: 'completion', status: 'complete', actor: 'model' },
      snapshot: { status: 'complete', turnsUsed: 3 },
    });
    // goal.clear produces no entry (no card UI for it).
  });

  it('maps plan, permission, approval and config ops', () => {
    const approval = {
      request: { toolName: 'Bash' },
      result: { decision: 'approved', scope: 'session' },
    };
    const entries = entriesOf([
      { type: 'plan_mode.enter', planId: 'p1' },
      { type: 'plan_mode.exit', planId: 'p1' },
      { type: 'plan_mode.enter', planId: 'p2' },
      { type: 'plan_mode.cancel', planId: 'p2' },
      { type: 'permission.set_mode', mode: 'yolo' },
      { type: 'permission.record_approval_result', ...approval },
      { type: 'config.update', modelAlias: 'kimi-latest', thinkingEffort: 'high' },
    ]);

    expect(entries).toEqual([
      { type: 'plan_updated', enabled: true },
      { type: 'plan_updated', enabled: false },
      { type: 'plan_updated', enabled: true },
      { type: 'plan_updated', enabled: false },
      { type: 'permission_updated', mode: 'yolo' },
      { type: 'approval_result', record: approval },
      {
        type: 'config_updated',
        config: { modelAlias: 'kimi-latest', thinkingEffort: 'high' },
      },
    ]);
  });
});

describe('rehydrateTranscript', () => {
  it('loads blob-referenced parts back to inline content', async () => {
    const blobRef = { type: 'text', text: 'blobref:abc123' };
    const entries = entriesOf([
      appendMessage({ role: 'user', content: [blobRef], toolCalls: [] }),
      { type: 'permission.set_mode', mode: 'yolo' },
    ]);

    const loader = {
      async loadParts(parts: readonly unknown[]) {
        return parts.map((part) =>
          part === blobRef ? { type: 'text', text: 'inline-content' } : part,
        );
      },
    };
    const rehydrated = await rehydrateTranscript(entries, loader as never);

    expect(rehydrated).toHaveLength(2);
    const first = rehydrated[0];
    expect(first?.type).toBe('message');
    expect(first?.type === 'message' && first.message.content[0]).toEqual({
      type: 'text',
      text: 'inline-content',
    });
    // Non-message entries pass through untouched.
    expect(rehydrated[1]).toBe(entries[1]);
  });
});
