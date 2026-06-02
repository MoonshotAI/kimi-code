/**
 * Abort behaviour at each safe point.
 *
 * The loop's contract is that an externally-aborted turn never throws to the
 * caller and never loses already-recorded usage. The matrix here covers
 * abort triggered at every observable boundary: before the loop, during
 * the LLM call, during tool execution, between steps, and during a hook.
 */

import { inputTotal } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import type { LLMChatResponse, LoopHooks } from '../../src/loop/index';
import { userCancellationReason } from '../../src/utils/abort';
import { makeEndTurnResponse, makeToolCall, makeToolUseResponse } from './fixtures/fake-llm';
import { runTurn } from './fixtures/helpers';
import { EchoTool, GatedTool, markReadFileAccesses, SlowTool } from './fixtures/tools';

function waitOneMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('runTurn — abort handling', () => {
  it('returns aborted without throwing when signal is already aborted on entry', async () => {
    const controller = new AbortController();
    controller.abort();

    const { result, llm, sink, context } = await runTurn({
      responses: [makeEndTurnResponse('never executed')],
      signal: controller.signal,
    });

    expect(result.stopReason).toBe('aborted');
    expect(result.steps).toBe(0);
    // LLM was never called and no transcript envelope opened
    expect(llm.callCount).toBe(0);
    expect(context.stepBegins().length).toBe(0);
    // turn.interrupted{aborted} is emitted
    const interrupted = sink.byType('turn.interrupted');
    expect(interrupted.length).toBe(1);
    expect(interrupted[0]?.reason).toBe('aborted');
    expect(interrupted[0]?.attemptedSteps).toBe(0);
    expect(interrupted[0]?.activeStep).toBeUndefined();
    // No step.begin / step.end ever fired
    expect(sink.count('step.begin')).toBe(0);
    expect(sink.count('step.end')).toBe(0);
  });

  it('returns aborted when the LLM call itself observes the signal', async () => {
    const controller = new AbortController();
    const { result, sink, llm } = await runTurn({
      responses: [makeEndTurnResponse('not returned')],
      signal: controller.signal,
      llmAbortOnIndex: { index: 0, controller },
    });

    expect(result.stopReason).toBe('aborted');
    expect(llm.callCount).toBe(1);
    expect(sink.byType('turn.interrupted')[0]?.reason).toBe('aborted');
  });

  it('preserves usage already recorded by an earlier step when later steps abort', async () => {
    const slow = new SlowTool();
    const controller = new AbortController();

    // Scenario: step 1 records usage for an end-of-step we never reach (the
    // LLM returns first), step 2 hangs in the slow tool until we abort.
    const responses: LLMChatResponse[] = [
      makeToolUseResponse([makeToolCall('echo', { text: 'first' }, 'tc-1')], {
        inputOther: 100,
        output: 50,
      }),
      makeToolUseResponse([makeToolCall('slow', {}, 'tc-2')], {
        inputOther: 7,
        output: 11,
      }),
      // Never reached
      makeEndTurnResponse('unreachable'),
    ];

    const echo = new EchoTool();
    const turnPromise = runTurn({
      tools: [echo, slow],
      responses,
      signal: controller.signal,
    });

    // Wait for the slow tool to start, then abort.
    await slow.started.promise;
    controller.abort();

    const { result, sink } = await turnPromise;
    expect(result.stopReason).toBe('aborted');
    // Step 1 fully recorded its usage; step 2 also recorded its LLM
    // usage immediately after the chat call, before the tool aborted.
    expect(inputTotal(result.usage)).toBe(100 + 7);
    expect(result.usage.output).toBe(50 + 11);
    expect(sink.byType('turn.interrupted').map((e) => e.reason)).toContain('aborted');
  });

  it('aborts cleanly when triggered inside a beforeStep hook', async () => {
    const controller = new AbortController();
    const hooks: LoopHooks = {
      beforeStep: async () => {
        controller.abort();
        const err = new Error('aborted from hook');
        err.name = 'AbortError';
        throw err;
      },
    };

    const { result, sink, llm, context } = await runTurn({
      hooks,
      responses: [makeEndTurnResponse('never')],
      signal: controller.signal,
    });

    expect(result.stopReason).toBe('aborted');
    expect(llm.callCount).toBe(0);
    expect(context.stepBegins().length).toBe(0);
    expect(sink.byType('turn.interrupted')[0]?.reason).toBe('aborted');
  });

  it('aborts cleanly when triggered inside a prepareToolExecution hook', async () => {
    const controller = new AbortController();
    const echo = new EchoTool();
    const hooks: LoopHooks = {
      prepareToolExecution: async () => {
        controller.abort();
        const err = new Error('aborted from prepareToolExecution');
        err.name = 'AbortError';
        throw err;
      },
    };

    const { result, sink } = await runTurn({
      hooks,
      tools: [echo],
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'hi' }, 'tc-1')]),
        makeEndTurnResponse('never'),
      ],
      signal: controller.signal,
    });

    expect(result.stopReason).toBe('aborted');
    // tool.execute must not have been invoked
    expect(echo.calls.length).toBe(0);
    expect(sink.byType('turn.interrupted')[0]?.reason).toBe('aborted');
  });

  it('does NOT crash when an aborted turn still has work to drain', async () => {
    // A SlowTool waits forever; we abort while it's running. The loop must
    // settle gracefully and emit a single turn.interrupted.
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
    const { result, sink } = await turnPromise;

    expect(result.stopReason).toBe('aborted');
    // Exactly one turn.interrupted record
    expect(sink.byType('turn.interrupted').length).toBe(1);
  });

  it('does not start a queued conflicting tool after abort', async () => {
    const gated = new GatedTool('gated');
    const echo = new EchoTool();
    const controller = new AbortController();

    const turnPromise = runTurn({
      tools: [gated, echo],
      responses: [
        makeToolUseResponse([
          makeToolCall('gated', {}, 'tc-gated'),
          makeToolCall('echo', { text: 'late mutation' }, 'tc-echo'),
        ]),
        makeEndTurnResponse('unreachable'),
      ],
      signal: controller.signal,
    });

    await gated.started;
    await waitOneMacrotask();
    expect(echo.calls.length).toBe(0);

    controller.abort();
    gated.release();
    const { result, sink } = await turnPromise;

    expect(result.stopReason).toBe('aborted');
    expect(echo.calls.length).toBe(0);
    expect(sink.byType('tool.call').map((e) => e.toolCallId)).toEqual(['tc-gated', 'tc-echo']);
    const results = sink.byType('tool.result');
    expect(results.map((e) => e.toolCallId)).toEqual(['tc-gated', 'tc-echo']);
    const echoResult = results.find((event) => event.toolCallId === 'tc-echo');
    expect(echoResult?.result).toEqual({
      output: 'Tool "echo" was aborted',
      isError: true,
    });
  });

  it('tells the model a running tool was interrupted by the user, not by a system fault', async () => {
    // When the user presses stop, the tool_result fed back to the model must
    // convey "the user deliberately interrupted this" — not the neutral
    // `Tool "X" was aborted`, which the model mistakes for a system problem
    // (e.g. "too many parallel agents") and then theorises about / retries.
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
    controller.abort(userCancellationReason());
    const { result, sink } = await turnPromise;

    expect(result.stopReason).toBe('aborted');
    const toolResult = sink.byType('tool.result').find((e) => e.toolCallId === 'tc-1');
    const output = toolResult?.result.output;
    expect(typeof output).toBe('string');
    expect(output).not.toBe('Tool "slow" was aborted');
    expect(output).toContain('not a system error');
    expect(output).toContain("wait for the user");
  });

  it('every tool.call still has a matching tool.result when aborted mid-batch', async () => {
    // Transcript-balance contract: even when the turn is aborted while
    // multiple tool tasks are running, every dispatched tool.call must be
    // followed by a tool.result for the same toolCallId. Without this,
    // the next turn's messages would carry orphan tool.calls and the
    // provider API would reject the conversation.
    const slow = markReadFileAccesses(new SlowTool());
    const controller = new AbortController();

    const turnPromise = runTurn({
      tools: [slow],
      responses: [
        makeToolUseResponse([
          makeToolCall('slow', {}, 'tc-1'),
          makeToolCall('slow', {}, 'tc-2'),
          makeToolCall('slow', {}, 'tc-3'),
        ]),
        makeEndTurnResponse('unreachable'),
      ],
      signal: controller.signal,
    });

    await slow.started.promise;
    controller.abort();
    const { result, sink } = await turnPromise;

    expect(result.stopReason).toBe('aborted');

    const callIds = sink
      .byType('tool.call')
      .map((e) => e.toolCallId)
      .toSorted();
    const resultIds = sink
      .byType('tool.result')
      .map((e) => e.toolCallId)
      .toSorted();
    expect(callIds).toEqual(['tc-1', 'tc-2', 'tc-3']);
    expect(resultIds).toEqual(callIds);
  });
});
