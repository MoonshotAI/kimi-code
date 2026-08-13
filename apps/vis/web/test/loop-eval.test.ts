import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REPETITION_WINDOW_CALLS,
  DEFAULT_STEER_COMPARISON_CALLS,
  evaluateLoopTrace,
} from '../src/lib/loop-eval';
import type { WireEntry } from '../src/types';

let line = 0;

function record(data: Record<string, unknown>): WireEntry {
  line += 1;
  return { lineNo: line, data, raw: data } as unknown as WireEntry;
}

function prompt(text = 'prompt'): WireEntry {
  return record({
    type: 'turn.prompt',
    input: [{ type: 'text', text }],
    origin: { kind: 'user' },
  });
}

function steer(text = 'steer'): WireEntry {
  return record({
    type: 'turn.steer',
    input: [{ type: 'text', text }],
    origin: { kind: 'user' },
  });
}

function call(name: string, args: unknown): WireEntry {
  return record({
    type: 'context.append_loop_event',
    event: {
      type: 'tool.call',
      uuid: `uuid-${String(line + 1)}`,
      stepUuid: 'step',
      toolCallId: `call-${String(line + 1)}`,
      name,
      args,
    },
  });
}

describe('evaluateLoopTrace', () => {
  it('segments prompt phases and canonicalizes argument object keys', () => {
    line = 0;
    const entries = [
      prompt('first'),
      call('Read', { path: '/tmp/a', offset: 1 }),
      call('Read', { offset: 1, path: '/tmp/a' }),
      call('Read', { path: '/tmp/a', offset: 1 }),
      call('Read', { offset: 1, path: '/tmp/a' }),
      call('Read', { path: '/tmp/a', offset: 1 }),
      prompt('second'),
      call('Read', { offset: 1, path: '/tmp/a' }),
    ];

    const evaluation = evaluateLoopTrace(entries, {
      repetitionWindowCalls: 4,
    });

    expect(evaluation.phases).toHaveLength(3);
    expect(evaluation.phases[0]).toMatchObject({
      index: 0,
      promptLineNo: null,
      nextPromptLineNo: 1,
      toolCallCount: 0,
    });
    expect(evaluation.phases[1]).toMatchObject({
      index: 1,
      promptLineNo: 1,
      nextPromptLineNo: 7,
      toolCallCount: 5,
      distinctCallCount: 1,
      repeatedCallCount: 4,
      repeatedCallRate: 0.8,
      longestExactRun: {
        length: 5,
        toolName: 'Read',
        startLineNo: 2,
        endLineNo: 6,
      },
      peakRepetitionWindow: {
        callCount: 4,
        repeatedCallCount: 3,
        repeatedCallRate: 0.75,
        startLineNo: 2,
        endLineNo: 5,
      },
    });
    expect(evaluation.phases[2]).toMatchObject({
      toolCallCount: 1,
      distinctCallCount: 1,
      repeatedCallCount: 0,
    });
    expect(evaluation.summary).toMatchObject({
      phaseCount: 3,
      toolCallCount: 6,
      repeatedCallCount: 4,
      longestExactRun: { phaseIndex: 1, length: 5 },
      peakRepetitionWindow: { phaseIndex: 1, repeatedCallRate: 0.75 },
    });
  });

  it('detects a rotating small alphabet without relying on consecutive runs', () => {
    line = 0;
    const pattern = ['true', 'true', 'echo standby', 'echo .'];
    const entries: WireEntry[] = [prompt()];
    for (let index = 0; index < 20; index += 1) {
      entries.push(call('Bash', { cmd: pattern[index % pattern.length] }));
    }

    const evaluation = evaluateLoopTrace(entries);
    const phase = evaluation.phases[1];

    expect(phase.toolCallCount).toBe(20);
    expect(phase.distinctCallCount).toBe(3);
    expect(phase.repeatedCallCount).toBe(17);
    expect(phase.repeatedCallRate).toBe(0.85);
    expect(phase.longestExactRun?.length).toBe(2);
    expect(phase.peakRepetitionWindow).toMatchObject({
      callCount: 20,
      repeatedCallCount: 17,
      repeatedCallRate: 0.85,
    });
  });

  it('keeps unique argument drift at zero repetition', () => {
    line = 0;
    const entries: WireEntry[] = [prompt()];
    for (let index = 0; index < 20; index += 1) {
      entries.push(call('Bash', { cmd: `echo ${String(index)}` }));
    }

    const phase = evaluateLoopTrace(entries).phases[1];

    expect(phase.distinctCallCount).toBe(20);
    expect(phase.repeatedCallCount).toBe(0);
    expect(phase.repeatedCallRate).toBe(0);
    expect(phase.longestExactRun?.length).toBe(1);
    expect(phase.peakRepetitionWindow?.repeatedCallRate).toBe(0);
  });

  it('compares exact-call histograms before and after steers', () => {
    line = 0;
    const entries = [
      prompt('same distribution'),
      call('Bash', { cmd: 'a' }),
      call('Bash', { cmd: 'b' }),
      call('Bash', { cmd: 'a' }),
      call('Bash', { cmd: 'b' }),
      steer('change course'),
      call('Bash', { cmd: 'b' }),
      call('Bash', { cmd: 'a' }),
      call('Bash', { cmd: 'b' }),
      call('Bash', { cmd: 'a' }),
      prompt('disjoint distribution'),
      call('Read', { path: 'a' }),
      call('Read', { path: 'b' }),
      call('Read', { path: 'c' }),
      call('Read', { path: 'd' }),
      steer('look elsewhere'),
      call('Bash', { cmd: 'e' }),
      call('Bash', { cmd: 'f' }),
      call('Bash', { cmd: 'g' }),
      call('Bash', { cmd: 'h' }),
    ];

    const evaluation = evaluateLoopTrace(entries, { steerComparisonCalls: 4 });

    expect(evaluation.steerComparisons).toHaveLength(2);
    expect(evaluation.steerComparisons[0]).toMatchObject({
      phaseIndex: 1,
      steerLineNo: 6,
      beforeCallCount: 4,
      afterCallCount: 4,
      beforeDistinctCallCount: 2,
      afterDistinctCallCount: 2,
      complete: true,
      histogramOverlap: 1,
      beforeStartLineNo: 2,
      beforeEndLineNo: 5,
      afterStartLineNo: 7,
      afterEndLineNo: 10,
    });
    expect(evaluation.steerComparisons[1]).toMatchObject({
      phaseIndex: 2,
      steerLineNo: 16,
      complete: true,
      histogramOverlap: 0,
    });
    expect(evaluation.summary.completeSteerComparisonCount).toBe(2);
    expect(evaluation.summary.meanCompleteSteerHistogramOverlap).toBe(0.5);
  });

  it('marks incomplete steer windows without inventing an overlap', () => {
    line = 0;
    const evaluation = evaluateLoopTrace([
      prompt(),
      call('Read', { path: 'a' }),
      steer(),
    ], { steerComparisonCalls: 4 });

    expect(evaluation.steerComparisons[0]).toMatchObject({
      beforeCallCount: 1,
      afterCallCount: 0,
      complete: false,
      histogramOverlap: null,
    });
    expect(evaluation.summary.completeSteerComparisonCount).toBe(0);
    expect(evaluation.summary.meanCompleteSteerHistogramOverlap).toBeNull();
  });

  it('returns marker metadata without prompts, arguments, outputs, or fingerprints', () => {
    line = 0;
    const secret = 'do-not-export-this-value';
    const entries = [
      prompt(secret),
      call('Bash', { cmd: secret }),
      record({
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          toolCallId: 'call-2',
          parentUuid: 'uuid-2',
          result: { output: secret },
        },
      }),
      steer(secret),
      record({ type: 'turn.cancel', turnId: 1 }),
      record({ type: 'full_compaction.begin', source: 'auto' }),
      record({
        type: 'context.apply_compaction',
        summary: secret,
        compactedCount: 2,
        tokensBefore: 100,
        tokensAfter: 20,
      }),
      record({ type: 'full_compaction.complete' }),
    ];

    const evaluation = evaluateLoopTrace(entries);
    const serialized = JSON.stringify(evaluation);

    expect(serialized).not.toContain(secret);
    expect(evaluation.phases[1]?.markers).toEqual([
      { kind: 'steer', lineNo: 4, recordType: 'turn.steer' },
      { kind: 'cancel', lineNo: 5, recordType: 'turn.cancel' },
      {
        kind: 'compaction',
        lineNo: 6,
        recordType: 'full_compaction.begin',
      },
      {
        kind: 'compaction',
        lineNo: 7,
        recordType: 'context.apply_compaction',
      },
      {
        kind: 'compaction',
        lineNo: 8,
        recordType: 'full_compaction.complete',
      },
    ]);
    expect(evaluation.summary).toMatchObject({
      steerCount: 1,
      cancelCount: 1,
      compactionApplyCount: 1,
    });
  });

  it('uses stable defaults and returns an empty report for an empty wire', () => {
    const evaluation = evaluateLoopTrace([], {
      repetitionWindowCalls: 0,
      steerComparisonCalls: Number.NaN,
    });

    expect(evaluation.settings).toEqual({
      repetitionWindowCalls: DEFAULT_REPETITION_WINDOW_CALLS,
      steerComparisonCalls: DEFAULT_STEER_COMPARISON_CALLS,
    });
    expect(evaluation.phases).toEqual([]);
    expect(evaluation.steerComparisons).toEqual([]);
    expect(evaluation.summary).toMatchObject({
      phaseCount: 0,
      toolCallCount: 0,
      repeatedCallCount: 0,
      repeatedCallRate: 0,
    });
  });
});
