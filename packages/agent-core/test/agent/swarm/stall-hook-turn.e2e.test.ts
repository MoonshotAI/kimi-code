/**
 * Turn-level proof that the swarm stall hook + per-worker abort wiring stops a
 * worker that repeats the same tool call, while distinct calls run to
 * completion. This mirrors how the swarm spawnSubagent adapter wires the hook:
 * a per-worker AbortController linked to the parent signal, and an onStall
 * callback that aborts that controller with a distinguishable reason.
 */

import { describe, expect, it } from 'vitest';

import { createStallDetectionHook } from '../../../src/agent/swarm/stall-hook';
import type { LoopHooks } from '../../../src/loop/index';
import { linkAbortSignal } from '../../../src/utils/abort';
import { makeToolCall, makeToolUseResponse, makeEndTurnResponse } from '../../loop/fixtures/fake-llm';
import { runTurn } from '../../loop/fixtures/helpers';
import { EchoTool } from '../../loop/fixtures/tools';

describe('swarm stall hook — turn level', () => {
  it('stops a worker that repeats the same tool call and aborts its per-worker controller', async () => {
    // Parent (coordinator) signal stays unaborted; per-worker controller is
    // linked to it so coordinator cancel still propagates down.
    const parent = new AbortController();
    const worker = new AbortController();
    const unlink = linkAbortSignal(parent.signal, worker);

    let stallReason: string | undefined;
    const hook: Partial<LoopHooks> = createStallDetectionHook({
      repeatThreshold: 3,
      onStall: (reason) => {
        stallReason = reason;
        worker.abort(new Error(reason));
      },
    });

    const echo = new EchoTool();
    // LLM keeps emitting the identical tool call; without a stop the loop would
    // run forever. The hook must block on the 3rd repeat and the abort must end
    // the turn.
    const sameCall = () => makeToolUseResponse([makeToolCall('echo', { text: 'spin' })]);
    const responses = [sameCall(), sameCall(), sameCall(), sameCall(), sameCall()];

    const { result } = await runTurn({
      hooks: hook as LoopHooks,
      tools: [echo],
      responses,
      signal: worker.signal,
    });

    unlink();

    // Worker turn ended as aborted; the per-worker controller fired.
    expect(result.stopReason).toBe('aborted');
    expect(worker.signal.aborted).toBe(true);
    expect(stallReason).toMatch(/stalled/i);
    expect(stallReason).toContain('echo');
    // The reason carries the repeated call's args so a reviser sees WHAT spun.
    expect(stallReason).toContain('spin');
    // Crucially the coordinator's signal is NOT aborted — a single worker
    // failure, not a whole-swarm cancel.
    expect(parent.signal.aborted).toBe(false);
    // The blocked call never executed the tool.
    expect(echo.calls.length).toBeLessThan(3);
  });

  it('lets distinct progressing tool calls run to completion without stalling', async () => {
    const worker = new AbortController();
    let stalled = false;
    const hook: Partial<LoopHooks> = createStallDetectionHook({
      repeatThreshold: 3,
      onStall: () => {
        stalled = true;
        worker.abort();
      },
    });

    const echo = new EchoTool();
    const responses = [
      makeToolUseResponse([makeToolCall('echo', { text: 'a' })]),
      makeToolUseResponse([makeToolCall('echo', { text: 'b' })]),
      makeToolUseResponse([makeToolCall('echo', { text: 'c' })]),
      makeToolUseResponse([makeToolCall('echo', { text: 'd' })]),
      makeEndTurnResponse('done'),
    ];

    const { result } = await runTurn({
      hooks: hook as LoopHooks,
      tools: [echo],
      responses,
      signal: worker.signal,
    });

    expect(stalled).toBe(false);
    expect(worker.signal.aborted).toBe(false);
    expect(result.stopReason).toBe('end_turn');
    expect(echo.calls.length).toBe(4);
  });
});
