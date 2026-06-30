import { describe, it, expect } from 'vitest';

import { analyzeWire } from '../src/lib/analysis';
import type { WireEntry } from '../src/types';

let line = 0;
function e(data: Record<string, unknown>, time?: number): WireEntry {
  line += 1;
  return { lineNo: line, data: { ...data, time }, raw: data } as unknown as WireEntry;
}
function loop(event: Record<string, unknown>, time?: number): WireEntry {
  return e({ type: 'context.append_loop_event', event }, time);
}

describe('analyzeWire', () => {
  it('folds a session into turns/steps/tools with derived metrics', () => {
    line = 0;
    const entries: WireEntry[] = [
      e({ type: 'turn.prompt', input: [{ type: 'text', text: 'hello' }], origin: { kind: 'user' } }, 1000),
      loop({ type: 'step.begin', uuid: 's1', turnId: 'T1', step: 0 }, 1100),
      loop({ type: 'tool.call', uuid: 'tc1', turnId: 'T1', step: 0, stepUuid: 's1', toolCallId: 'c1', name: 'Read' }, 1200),
      loop({ type: 'tool.result', parentUuid: 'tc1', toolCallId: 'c1', result: { output: 'x'.repeat(50), truncated: true } }, 1500),
      loop({ type: 'step.end', uuid: 's1', turnId: 'T1', step: 0, finishReason: 'tool_use', llmFirstTokenLatencyMs: 40, usage: { inputOther: 100, output: 20, inputCacheRead: 80, inputCacheCreation: 10 } }, 1600),
      loop({ type: 'step.begin', uuid: 's2', turnId: 'T1', step: 1 }, 1700),
      loop({ type: 'step.end', uuid: 's2', turnId: 'T1', step: 1, finishReason: 'end_turn', usage: { inputOther: 200, output: 50, inputCacheRead: 150, inputCacheCreation: 0 } }, 2000),
      // Big idle gap → waiting for the user, then a second turn that errors.
      e({ type: 'turn.prompt', input: [{ type: 'text', text: 'again' }], origin: { kind: 'user' } }, 10000),
      loop({ type: 'step.begin', uuid: 's3', turnId: 'T2', step: 0 }, 10100),
      loop({ type: 'tool.call', uuid: 'tc2', turnId: 'T2', step: 0, stepUuid: 's3', toolCallId: 'c2', name: 'Read' }, 10200),
      loop({ type: 'tool.result', parentUuid: 'tc2', toolCallId: 'c2', result: { output: 'y'.repeat(10), isError: true } }, 10250),
      loop({ type: 'step.end', uuid: 's3', turnId: 'T2', step: 0, finishReason: 'filtered', usage: { inputOther: 300, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } }, 10300),
    ];

    const a = analyzeWire(entries);

    // Turn grouping
    expect(a.turns).toHaveLength(2);
    expect(a.turns[0]!.promptText).toBe('hello');
    expect(a.turns[0]!.trigger).toBe('prompt');
    expect(a.turns[0]!.steps).toHaveLength(2);
    expect(a.turns[1]!.steps).toHaveLength(1);

    // Tool duration + truncation + size
    const tc = a.turns[0]!.steps[0]!.toolCalls[0]!;
    expect(tc.durationMs).toBe(300);
    expect(tc.truncated).toBe(true);
    expect(tc.outputBytes).toBe(50);
    expect(tc.isError).toBe(false);

    // Context-window fill snapshots (agent-core formula)
    expect(a.turns[0]!.steps[0]!.contextTokens).toBe(210); // 100+20+80+10
    expect(a.turns[0]!.steps[1]!.contextTokens).toBe(400); // 200+50+150+0
    expect(a.summary.peakContextTokens).toBe(400);
    expect(a.contextSeries.map((p) => p.contextTokens)).toEqual([210, 400, 300]);

    // Per-turn token cost = sum of step usages
    expect(a.turns[0]!.tokens).toEqual({ inputOther: 300, output: 70, inputCacheRead: 230, inputCacheCreation: 10 });

    // Idle / wait
    expect(a.turns[1]!.waitBeforeMs).toBe(8000);
    expect(a.idleGaps).toHaveLength(1);
    expect(a.idleGaps[0]).toMatchObject({ gapMs: 8000, kind: 'between_turns', afterLineNo: 7, beforeLineNo: 8 });

    // Errors
    expect(a.turns[1]!.steps[0]!.isError).toBe(true); // finishReason 'filtered'
    expect(a.turns[1]!.toolErrorCount).toBe(1);

    // Summary
    expect(a.summary.turnCount).toBe(2);
    expect(a.summary.stepCount).toBe(3);
    expect(a.summary.toolCallCount).toBe(2);
    expect(a.summary.toolErrorCount).toBe(1);
    expect(a.summary.truncatedToolCount).toBe(1);

    // Tool stats
    const read = a.toolStats.find((s) => s.name === 'Read')!;
    expect(read.count).toBe(2);
    expect(read.errorCount).toBe(1);
    expect(read.truncatedCount).toBe(1);
    expect(read.timedCount).toBe(2);
    expect(read.totalMs).toBe(350); // 300 + 50
    expect(read.avgMs).toBe(175);
    expect(read.maxMs).toBe(300);
  });

  it('handles an empty wire', () => {
    const a = analyzeWire([]);
    expect(a.turns).toEqual([]);
    expect(a.summary.turnCount).toBe(0);
    expect(a.cache.hitRate).toBeNull();
  });

  it('computes cache hit rate from summed input usage', () => {
    line = 0;
    const a = analyzeWire([
      e({ type: 'turn.prompt', input: [{ type: 'text', text: 'q' }], origin: { kind: 'user' } }, 0),
      loop({ type: 'step.begin', uuid: 'x', turnId: 'A', step: 0 }, 1),
      loop({ type: 'step.end', uuid: 'x', turnId: 'A', step: 0, finishReason: 'end_turn', usage: { inputOther: 25, output: 5, inputCacheRead: 75, inputCacheCreation: 0 } }, 2),
    ]);
    // hitRate = 75 / (75 + 0 + 25) = 0.75
    expect(a.cache.hitRate).toBeCloseTo(0.75, 5);
  });

  it('collects config.update changes', () => {
    line = 0;
    const a = analyzeWire([
      e({ type: 'config.update', modelAlias: 'opus', thinkingEffort: 'high', systemPrompt: 'x'.repeat(120) }, 0),
      e({ type: 'config.update', modelAlias: 'sonnet' }, 10),
    ]);
    expect(a.configChanges).toHaveLength(2);
    expect(a.configChanges[0]!.changed).toEqual([
      { field: 'model', value: 'opus' },
      { field: 'thinking', value: 'high' },
      { field: 'systemPrompt', value: '120 chars' },
    ]);
    expect(a.configChanges[1]!.changed).toEqual([{ field: 'model', value: 'sonnet' }]);
  });

  it('does not reset context-window fill on a zero-usage step.end', () => {
    line = 0;
    const a = analyzeWire([
      e({ type: 'turn.prompt', input: [{ type: 'text', text: 'q' }], origin: { kind: 'user' } }, 0),
      loop({ type: 'step.begin', uuid: 's1', turnId: 'T', step: 0 }, 1),
      loop({ type: 'step.end', uuid: 's1', turnId: 'T', step: 0, finishReason: 'tool_use', usage: { inputOther: 100, output: 20, inputCacheRead: 80, inputCacheCreation: 0 } }, 2),
      loop({ type: 'step.begin', uuid: 's2', turnId: 'T', step: 1 }, 3),
      // content-filtered: usage all zero — must keep the prior 200, not drop to 0.
      loop({ type: 'step.end', uuid: 's2', turnId: 'T', step: 1, finishReason: 'filtered', usage: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } }, 4),
    ]);
    expect(a.turns[0]!.steps[0]!.contextTokens).toBe(200);
    expect(a.turns[0]!.steps[1]!.contextTokens).toBe(200); // carried, not 0
    expect(a.contextSeries.map((p) => p.contextTokens)).toEqual([200, 200]);
    expect(a.summary.peakContextTokens).toBe(200);
  });
});
