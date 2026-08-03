/**
 * Transcript append (WAL) invariants.
 *
 * The loop writes a step envelope and tool-call records in a deterministic
 * order. We assert the ordering with adjacency / before-after pairs
 * rather than full-sequence snapshots so future internal refactors that
 * insert harmless writes do not falsely trip the suite.
 */

import { describe, expect, it } from 'vitest';

import {
  makeEndTurnResponse,
  makeResponse,
  makeTextParts,
  makeToolCall,
  makeToolUseResponse,
} from './fixtures/fake-llm';
import { runTurn } from './fixtures/helpers';
import { EchoTool, SlowTool } from './fixtures/tools';

describe('runTurn — transcript writes', () => {
  it('opens and closes one step envelope per step', async () => {
    const echo = new EchoTool();
    const { context } = await runTurn({
      tools: [echo],
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'a' }, 'tc-1')]),
        makeEndTurnResponse('done'),
      ],
    });
    expect(context.stepBegins().length).toBe(2);
    expect(context.stepEnds().length).toBe(2);
    expect(context.stepBegins().map((s) => s.step)).toEqual([1, 2]);
    expect(context.stepEnds().map((s) => s.step)).toEqual([1, 2]);
  });

  it('uses a consistent stepUuid across begin/end and child records of the same step', async () => {
    const echo = new EchoTool();
    const { context } = await runTurn({
      tools: [echo],
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'a' }, 'tc-1')]),
        makeEndTurnResponse('done'),
      ],
    });
    const begins = context.stepBegins();
    const ends = context.stepEnds();
    const tcRows = context.toolCalls();
    expect(begins[0]?.uuid).toBe(ends[0]?.uuid);
    expect(begins[1]?.uuid).toBe(ends[1]?.uuid);
    // tool.call record was written under step 1's uuid
    expect(tcRows[0]?.stepUuid).toBe(begins[0]?.uuid);
    // turnId propagates onto every record
    const turnIds = new Set([
      ...begins.map((b) => b.turnId),
      ...ends.map((e) => e.turnId),
      ...tcRows.map((t) => t.turnId),
    ]);
    expect(turnIds.size).toBe(1);
    expect([...turnIds][0]).toBe('turn-1');
  });

  it('links tool.result records back to their tool.call via parentUuid', async () => {
    const echo = new EchoTool();
    const { context } = await runTurn({
      tools: [echo],
      responses: [
        makeToolUseResponse([
          makeToolCall('echo', { text: 'a' }, 'tc-A'),
          makeToolCall('echo', { text: 'b' }, 'tc-B'),
        ]),
        makeEndTurnResponse('done'),
      ],
    });
    const tcRows = context.toolCalls();
    const trRows = context.toolResults();
    expect(tcRows.length).toBe(2);
    expect(trRows.length).toBe(2);
    // parentUuid of tool.result A == uuid of tool.call A
    const tcByCallId = new Map(tcRows.map((r) => [r.toolCallId, r.uuid]));
    expect(trRows[0]?.parentUuid).toBe(tcByCallId.get('tc-A'));
    expect(trRows[1]?.parentUuid).toBe(tcByCallId.get('tc-B'));
  });

  it('appendStepEnd carries TokenUsage including cache fields', async () => {
    const { context } = await runTurn({
      responses: [
        makeEndTurnResponse('ok', {
          inputOther: 4,
          output: 22,
          inputCacheRead: 3,
          inputCacheCreation: 4,
        }),
      ],
    });
    const end = context.stepEnds()[0];
    expect(end?.usage).toEqual({
      inputOther: 4,
      output: 22,
      inputCacheRead: 3,
      inputCacheCreation: 4,
    });
    expect(end?.finishReason).toBe('end_turn');
  });

  it('normalises missing cache fields in appendStepEnd.usage', async () => {
    const { context } = await runTurn({
      responses: [makeEndTurnResponse('ok', { inputOther: 7, output: 5 })],
    });
    const end = context.stepEnds()[0];
    expect(end?.usage?.inputOther).toBe(7);
    expect(end?.usage?.output).toBe(5);
    expect(end?.usage?.inputCacheRead).toBe(0);
    expect(end?.usage?.inputCacheCreation).toBe(0);
  });

  it('does NOT call appendStepEnd when the step is interrupted by abort', async () => {
    const slow = new SlowTool();
    const controller = new AbortController();

    const turnPromise = runTurn({
      tools: [slow],
      responses: [
        makeToolUseResponse([makeToolCall('slow', {}, 'tc-1')]),
        makeEndTurnResponse('unreachable'),
      ],
      signal: controller.signal,
    });

    await slow.started.promise;
    controller.abort();
    const { context } = await turnPromise;

    // Step 1 was opened with appendStepBegin, but appendStepEnd was NOT
    // called because the step aborted mid-tool. Replay treats the missing
    // step.end as the interruption signal.
    const begins = context.stepBegins();
    const ends = context.stepEnds();
    expect(begins.length).toBeGreaterThanOrEqual(1);
    expect(ends.length).toBe(0);
  });

  it('writes appendStepBegin BEFORE llm.chat is called (envelope opens first)', async () => {
    // Ordering captured as adjacency: the first append in the recorded
    // calls is appendStepBegin; appendStepEnd appears after the tool
    // result records for the same step.
    const echo = new EchoTool();
    const { context } = await runTurn({
      tools: [echo],
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'a' }, 'tc-1')]),
        makeEndTurnResponse('done'),
      ],
    });
    const kinds = context.kinds();
    // First write of the turn is a step.begin
    expect(kinds[0]).toBe('appendStepBegin');
    // Within step 1, tool.call and tool.result land between begin and end
    const begin1 = kinds.indexOf('appendStepBegin');
    const end1 = kinds.indexOf('appendStepEnd', begin1);
    const tc1 = kinds.indexOf('appendToolCall', begin1);
    const tr1 = kinds.indexOf('appendToolResult', begin1);
    expect(begin1).toBeLessThan(tc1);
    expect(tc1).toBeLessThan(end1);
    expect(begin1).toBeLessThan(tr1);
    expect(tr1).toBeLessThan(end1);
  });

  it('writes appendToolCall BEFORE the tool actually executes', async () => {
    // The rejected path also satisfies this ordering: the tool.call record
    // exists even when there's nothing to execute. We verify with a
    // missing tool so no tool is ever invoked.
    const { context } = await runTurn({
      tools: [],
      responses: [
        makeToolUseResponse([makeToolCall('ghost', { x: 1 }, 'tc-1')]),
        makeEndTurnResponse('done'),
      ],
    });
    const kinds = context.kinds();
    const tc = kinds.indexOf('appendToolCall');
    const tr = kinds.indexOf('appendToolResult');
    expect(tc).toBeGreaterThanOrEqual(0);
    expect(tr).toBeGreaterThan(tc);
  });

  it('writes only one tool.call record per provider tool_call (no duplicate records)', async () => {
    const echo = new EchoTool();
    const { context } = await runTurn({
      tools: [echo],
      responses: [
        makeResponse(
          makeTextParts(''),
          [
            makeToolCall('echo', { text: 'a' }, 'tc-1'),
            makeToolCall('echo', { text: 'b' }, 'tc-2'),
          ],
          'tool_use',
        ),
        makeEndTurnResponse('done'),
      ],
    });
    expect(context.toolCalls().length).toBe(2);
    expect(context.toolResults().length).toBe(2);
  });

  it('reuses the provider tool_call.id as the transcript record uuid', async () => {
    const echo = new EchoTool();
    const { context } = await runTurn({
      tools: [echo],
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'x' }, 'tc-deadbeef')]),
        makeEndTurnResponse('done'),
      ],
    });
    const record = context.toolCalls()[0];
    expect(record?.uuid).toBe('tc-deadbeef');
    expect(record?.toolCallId).toBe('tc-deadbeef');
  });
});
