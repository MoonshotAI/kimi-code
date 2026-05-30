/**
 * Locks the "main agent / regular subagent unaffected" invariant: when
 * `agent.subagentLoopHooks` is UNDEFINED (every path except a swarm worker),
 * `TurnFlow.runTurn` composes ONLY the built-in `prepareToolExecution` (the
 * tool-call deduplicator). This test replicates that composition exactly and
 * proves the built-in same-step dedup still short-circuits identical calls,
 * so non-swarm turns run with unchanged behavior.
 */

import { describe, expect, it } from 'vitest';

import { ToolCallDeduplicator } from '../../../src/agent/turn/tool-dedup';
import type {
  LoopHooks,
  PrepareToolExecutionHook,
} from '../../../src/loop/index';
import { makeToolCall, makeToolUseResponse, makeEndTurnResponse } from '../../loop/fixtures/fake-llm';
import { runTurn } from '../../loop/fixtures/helpers';
import { EchoTool } from '../../loop/fixtures/tools';

/**
 * Build the same `prepareToolExecution` hook `TurnFlow.runTurn` builds: run the
 * subagent-scoped hook first (when present), then fall through to the built-in
 * dedup. With `subagentPrepareToolExecution` undefined this is exactly the
 * non-swarm composition.
 */
function buildHooks(
  deduper: ToolCallDeduplicator,
  subagentPrepareToolExecution: PrepareToolExecutionHook | undefined,
): LoopHooks {
  return {
    beforeStep: async () => {
      deduper.beginStep();
      return;
    },
    afterStep: async () => {
      deduper.endStep();
    },
    prepareToolExecution: async (ctx) => {
      if (subagentPrepareToolExecution !== undefined) {
        const subagentResult = await subagentPrepareToolExecution(ctx);
        if (subagentResult !== undefined) return subagentResult;
      }
      const cached = deduper.checkSameStep(ctx.toolCall.id, ctx.toolCall.name, ctx.args);
      if (cached !== null) return { syntheticResult: cached };
      return undefined;
    },
    finalizeToolResult: async (ctx) => {
      return deduper.finalizeResult(ctx.toolCall.id, ctx.toolCall.name, ctx.args, ctx.result);
    },
  };
}

describe('subagentLoopHooks undefined — non-swarm turn unaffected', () => {
  it('built-in same-step dedup still short-circuits identical calls (no subagent hook)', async () => {
    const deduper = new ToolCallDeduplicator();
    // subagentLoopHooks UNDEFINED — the non-swarm / regular-subagent case.
    const hooks = buildHooks(deduper, undefined);

    const echo = new EchoTool();
    // One step emits the identical tool call twice; the built-in dedup must
    // execute the tool only once and serve the second from the placeholder.
    const responses = [
      makeToolUseResponse([
        makeToolCall('echo', { text: 'same' }, 'c1'),
        makeToolCall('echo', { text: 'same' }, 'c2'),
      ]),
      makeEndTurnResponse('done'),
    ];

    const { result } = await runTurn({ hooks, tools: [echo], responses });

    expect(result.stopReason).toBe('end_turn');
    // Dedup short-circuits the duplicate: the tool ran exactly once.
    expect(echo.calls.length).toBe(1);
  });

  it('distinct same-step calls all execute (dedup does not over-collapse)', async () => {
    const deduper = new ToolCallDeduplicator();
    const hooks = buildHooks(deduper, undefined);

    const echo = new EchoTool();
    const responses = [
      makeToolUseResponse([
        makeToolCall('echo', { text: 'a' }, 'c1'),
        makeToolCall('echo', { text: 'b' }, 'c2'),
      ]),
      makeEndTurnResponse('done'),
    ];

    const { result } = await runTurn({ hooks, tools: [echo], responses });

    expect(result.stopReason).toBe('end_turn');
    expect(echo.calls.length).toBe(2);
  });
});
