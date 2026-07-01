import { inputTotal } from '@moonshot-ai/kosong';
import { describe, expect, it, vi } from 'vitest';

import { ErrorCodes, KimiError } from '#/errors';

import {
  CollectingSink,
  EchoTool,
  makeEndTurnResponse,
  makeMaxTokensResponse,
  makeResponse,
  makeTextParts,
  makeThinkingParts,
  makeToolCall,
  makeToolUseResponse,
  runTurn,
  runTurnExpectingThrow,
} from './fixtures';

describe('runTurn turn lifecycle', () => {
  it('returns max_tokens when the LLM signals it', async () => {
    const { result, sink } = await runTurn({
      responses: [makeMaxTokensResponse('partial...', { inputOther: 10, output: 20 })],
    });

    expect(result.stopReason).toBe('max_tokens');
    expect(result.steps).toBe(1);
    expect(result.usage).toEqual({
      inputOther: 10,
      output: 20,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
    expect(sink.count('turn.interrupted')).toBe(0);
  });

  it('treats provider tool_calls without tool call structure as unknown', async () => {
    const { result } = await runTurn({
      responses: [makeResponse(makeTextParts('done'), [], 'tool_use')],
    });

    expect(result.stopReason).toBe('unknown');
  });

  it('derives tool_use from tool call structure when provider reports completed', async () => {
    const echo = new EchoTool();
    const { result, llm } = await runTurn({
      tools: [echo],
      responses: [
        makeResponse([], [makeToolCall('echo', { text: 'hi' }, 'tc-completed')], 'end_turn'),
        makeEndTurnResponse('done'),
      ],
    });

    expect(result.stopReason).toBe('end_turn');
    expect(llm.callCount).toBe(2);
    expect(echo.calls.map((call) => call.id)).toEqual(['tc-completed']);
  });

  it('does not execute tool calls when provider reports a terminal diagnostic', async () => {
    const echo = new EchoTool();
    const { result, sink } = await runTurn({
      tools: [echo],
      responses: [
        makeResponse(
          makeTextParts('blocked'),
          [makeToolCall('echo', { text: 'should-not-run' }, 'tc-filtered')],
          'filtered',
        ),
      ],
    });

    expect(result.stopReason).toBe('filtered');
    expect(echo.calls).toEqual([]);
    expect(sink.count('tool.call')).toBe(0);
    expect(sink.count('tool.result')).toBe(0);
  });

  it('does not enforce a max step limit when maxSteps is 0', async () => {
    const echo = new EchoTool();
    const { result } = await runTurn({
      maxSteps: 0,
      tools: [echo],
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: '1' }, 'a')]),
        makeToolUseResponse([makeToolCall('echo', { text: '2' }, 'b')]),
        makeEndTurnResponse('done'),
      ],
    });

    expect(result.stopReason).toBe('end_turn');
    expect(result.steps).toBe(3);
    expect(echo.calls).toEqual([
      { id: 'a', turnId: 'turn-1', args: { text: '1' } },
      { id: 'b', turnId: 'turn-1', args: { text: '2' } },
    ]);
  });

  it('does not enforce a max step limit when maxSteps is omitted', async () => {
    const echo = new EchoTool();
    const { result } = await runTurn({
      tools: [echo],
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: '1' }, 'a')]),
        makeToolUseResponse([makeToolCall('echo', { text: '2' }, 'b')]),
        makeToolUseResponse([makeToolCall('echo', { text: '3' }, 'c')]),
        makeToolUseResponse([makeToolCall('echo', { text: '4' }, 'd')]),
        makeEndTurnResponse('done'),
      ],
    });

    expect(result.stopReason).toBe('end_turn');
    expect(result.steps).toBe(5);
    expect(echo.calls).toEqual([
      { id: 'a', turnId: 'turn-1', args: { text: '1' } },
      { id: 'b', turnId: 'turn-1', args: { text: '2' } },
      { id: 'c', turnId: 'turn-1', args: { text: '3' } },
      { id: 'd', turnId: 'turn-1', args: { text: '4' } },
    ]);
  });

  it('aggregates usage across steps including cache fields', async () => {
    const echo = new EchoTool();
    const { result } = await runTurn({
      tools: [echo],
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'a' })], {
          inputOther: 70,
          output: 50,
          inputCacheRead: 10,
          inputCacheCreation: 20,
        }),
        makeEndTurnResponse('done', {
          inputOther: 4,
          output: 3,
          inputCacheRead: 1,
          inputCacheCreation: 2,
        }),
      ],
    });

    expect(inputTotal(result.usage)).toBe(107);
    expect(result.usage.output).toBe(53);
    expect(result.usage.inputCacheRead).toBe(11);
    expect(result.usage.inputCacheCreation).toBe(22);
  });
});

describe('runTurn abort and error paths', () => {
  it('returns aborted without throwing when signal is already aborted on entry', async () => {
    const controller = new AbortController();
    controller.abort();

    const { result, llm, sink } = await runTurn({
      signal: controller.signal,
      responses: [makeEndTurnResponse('should not run')],
    });

    expect(result).toMatchObject({ stopReason: 'aborted', steps: 0 });
    expect(llm.callCount).toBe(0);
    expect(sink.byType('turn.interrupted')).toEqual([
      expect.objectContaining({ reason: 'aborted', attemptedSteps: 0 }),
    ]);
  });

  it('preserves usage already recorded by an earlier step when later steps abort', async () => {
    const controller = new AbortController();
    const echo = new EchoTool();

    const { result } = await runTurn({
      signal: controller.signal,
      tools: [echo],
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'first' }, 'tc-1')], {
          inputOther: 3,
          output: 5,
        }),
        makeEndTurnResponse('should abort'),
      ],
      llmAbortOnIndex: { index: 1, controller },
    });

    expect(result.stopReason).toBe('aborted');
    expect(result.steps).toBe(2);
    expect(result.usage).toEqual({
      inputOther: 3,
      output: 5,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
  });

  it('throws KimiError(loop.max_steps_exceeded) with turn.interrupted before the throw', async () => {
    const echo = new EchoTool();
    const { error, sink } = await runTurnExpectingThrow({
      maxSteps: 2,
      tools: [echo],
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: '1' }, 'a')]),
        makeToolUseResponse([makeToolCall('echo', { text: '2' }, 'b')]),
      ],
    });

    expect(error).toBeInstanceOf(KimiError);
    expect((error as KimiError).code).toBe(ErrorCodes.LOOP_MAX_STEPS_EXCEEDED);
    expect((error as KimiError).details).toEqual({ maxSteps: 2 });
    expect(sink.byType('turn.interrupted')).toEqual([
      expect.objectContaining({ reason: 'max_steps', attemptedSteps: 2 }),
    ]);
  });

  it('rethrows non-abort LLM errors with turn.interrupted{reason:"error"}', async () => {
    const error = new Error('llm failed');
    const result = await runTurnExpectingThrow({
      responses: [makeEndTurnResponse('unused')],
      llmThrowOnIndex: { index: 0, error },
    });

    expect(result.error).toBe(error);
    expect(result.sink.byType('turn.interrupted')).toEqual([
      expect.objectContaining({
        reason: 'error',
        attemptedSteps: 1,
        activeStep: 1,
        message: 'llm failed',
      }),
    ]);
    expect(result.context.stepEnds()).toEqual([]);
  });

  it('AbortError thrown by a hook converges to stopReason="aborted"', async () => {
    const abortError = new Error('aborted from hook');
    abortError.name = 'AbortError';

    const { result, llm, sink } = await runTurn({
      responses: [makeEndTurnResponse('unused')],
      hooks: {
        beforeStep: async () => {
          throw abortError;
        },
      },
    });

    expect(result.stopReason).toBe('aborted');
    expect(llm.callCount).toBe(0);
    expect(sink.byType('turn.interrupted')).toEqual([
      expect.objectContaining({ reason: 'aborted', attemptedSteps: 1, activeStep: 1 }),
    ]);
  });

  it('logs non-abort LLM request failures without request payloads or stacks', async () => {
    const entries: unknown[] = [];
    const log = {
      warn: (_message: string, payload?: unknown) => entries.push(payload),
    };

    await runTurnExpectingThrow({
      responses: [makeEndTurnResponse('unused')],
      llmThrowOnIndex: { index: 0, error: new Error('temporary provider failure') },
      log: log as never,
    });

    expect(entries).toEqual([
      expect.objectContaining({
        turnStep: 'turn-1.1',
        attempt: '1/3',
        model: 'fake-model',
        errorName: 'Error',
        errorMessage: 'temporary provider failure',
      }),
    ]);
    expect(JSON.stringify(entries)).not.toContain('messages');
    expect(JSON.stringify(entries)).not.toContain('stack');
  });
});

describe('runTurn hooks', () => {
  it('beforeStep passes through when the hook returns undefined', async () => {
    const beforeStep = vi.fn(async () => undefined);
    const { result, llm } = await runTurn({
      responses: [makeEndTurnResponse('ok')],
      hooks: { beforeStep },
    });

    expect(result.stopReason).toBe('end_turn');
    expect(llm.callCount).toBe(1);
    expect(beforeStep).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: 'turn-1', stepNumber: 1, llm: expect.any(Object) }),
    );
  });

  it('beforeStep block prevents the LLM call and rethrows through the loop error path', async () => {
    const { error, llm, sink } = await runTurnExpectingThrow({
      responses: [makeEndTurnResponse('unused')],
      hooks: {
        beforeStep: async () => ({ block: true, reason: 'policy says no' }),
      },
    });

    expect(error).toMatchObject({ message: 'policy says no' });
    expect(llm.callCount).toBe(0);
    expect(sink.byType('turn.interrupted')).toEqual([
      expect.objectContaining({ reason: 'error', activeStep: 1, message: 'policy says no' }),
    ]);
  });

  it('afterStep runs after step.end and observes the step result', async () => {
    const seen: unknown[] = [];
    const { context } = await runTurn({
      responses: [makeEndTurnResponse('ok', { inputOther: 2, output: 3 })],
      hooks: {
        afterStep: async (ctx) => {
          seen.push({
            stopReason: ctx.stopReason,
            usage: ctx.usage,
          });
        },
      },
    });

    expect(seen).toEqual([
      {
        stopReason: 'end_turn',
        usage: {
          inputOther: 2,
          output: 3,
          inputCacheRead: 0,
          inputCacheCreation: 0,
        },
      },
    ]);
    expect(context.kinds()).toEqual(['appendStepBegin', 'appendContentPart', 'appendStepEnd']);
  });

  it('errors thrown by afterStep are swallowed after the step is sealed', async () => {
    const afterStep = vi.fn(async () => {
      throw new Error('observer failed');
    });

    const { result, sink } = await runTurn({
      responses: [makeEndTurnResponse('ok')],
      hooks: { afterStep },
    });

    expect(result.stopReason).toBe('end_turn');
    expect(afterStep).toHaveBeenCalledTimes(1);
    expect(sink.count('turn.interrupted')).toBe(0);
  });

  it('shouldContinueAfterStop can request another step after a non-tool stop', async () => {
    const shouldContinueAfterStop = vi
      .fn()
      .mockResolvedValueOnce({ continue: true })
      .mockResolvedValueOnce({ continue: false });

    const { result, llm } = await runTurn({
      responses: [makeEndTurnResponse('first'), makeEndTurnResponse('second')],
      hooks: { shouldContinueAfterStop },
    });

    expect(result.stopReason).toBe('end_turn');
    expect(llm.callCount).toBe(2);
    expect(shouldContinueAfterStop).toHaveBeenCalledTimes(2);
  });

  it('shouldContinueAfterStop is not consulted between tool_use steps', async () => {
    const echo = new EchoTool();
    const shouldContinueAfterStop = vi.fn(async () => ({ continue: false }));

    await runTurn({
      tools: [echo],
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: 'hi' }, 'tc-1')]),
        makeEndTurnResponse('done'),
      ],
      hooks: { shouldContinueAfterStop },
    });

    expect(shouldContinueAfterStop).toHaveBeenCalledTimes(1);
    expect(shouldContinueAfterStop).toHaveBeenCalledWith(
      expect.objectContaining({ stopReason: 'end_turn', stepNumber: 2 }),
    );
  });
});

describe('runTurn streaming callbacks', () => {
  it('routes streaming deltas into live events', async () => {
    const { sink } = await runTurn({
      responses: [
        {
          ...makeEndTurnResponse('done'),
          textDeltas: ['hel', 'lo'],
          thinkDeltas: ['thinking'],
          toolCallDeltas: [
            { toolCallId: 'call_1', name: 'Lookup', argumentsPart: '{"q":' },
            { toolCallId: 'call_1', argumentsPart: '"moon"}' },
          ],
        },
      ],
    });

    expect(sink.byType('text.delta').map((event) => event.delta)).toEqual(['hel', 'lo']);
    expect(sink.byType('thinking.delta').map((event) => event.delta)).toEqual(['thinking']);
    expect(sink.byType('tool.call.delta')).toEqual([
      expect.objectContaining({
        toolCallId: 'call_1',
        name: 'Lookup',
        argumentsPart: '{"q":',
      }),
      expect.objectContaining({
        toolCallId: 'call_1',
        argumentsPart: '"moon"}',
      }),
    ]);
  });

  it('persists completed text and thinking parts before step.end', async () => {
    const { context } = await runTurn({
      responses: [
        {
          ...makeEndTurnResponse('done'),
          contentParts: [
            ...makeThinkingParts('private thought', '', 'encrypted-signature'),
            ...makeTextParts('visible text'),
          ],
        },
      ],
    });

    expect(context.kinds()).toEqual([
      'appendStepBegin',
      'appendContentPart',
      'appendContentPart',
      'appendStepEnd',
    ]);
    expect(context.contentParts().map((event) => event.part)).toEqual([
      { type: 'think', think: 'private thought', encrypted: 'encrypted-signature' },
      { type: 'text', text: 'visible text' },
    ]);
  });
});

describe('LoopEventDispatcher live event containment', () => {
  it('contains synchronous emit throws', async () => {
    const { result, sink } = await runTurn({
      responses: [makeEndTurnResponse('ok')],
      sinkErrorMode: { kind: 'sync-throw', onlyAt: 0 },
    });

    expect(result.stopReason).toBe('end_turn');
    expect(sink.count('step.end')).toBe(1);
  });

  it('contains async-rejected emit returns', async () => {
    const { result, sink } = await runTurn({
      responses: [makeEndTurnResponse('ok')],
      sinkErrorMode: { kind: 'async-reject', onlyAt: 0 },
    });

    expect(result.stopReason).toBe('end_turn');
    expect(sink.events.length).toBeGreaterThan(0);
  });

  it('a misbehaving sink does not starve host-owned fan-out', async () => {
    const bad = new CollectingSink({ kind: 'every-call-throws' });
    const good = new CollectingSink();

    const { result } = await runTurn({
      responses: [makeEndTurnResponse('ok')],
      emitLiveEvent: (event) => {
        try {
          bad.emit(event);
        } catch {
          // Host-owned fan-out isolates each sink before forwarding to the next.
        }
        good.emit(event);
      },
    });

    expect(result.stopReason).toBe('end_turn');
    expect(bad.events.length).toBeGreaterThan(0);
    expect(good.events.length).toBeGreaterThan(0);
  });
});
