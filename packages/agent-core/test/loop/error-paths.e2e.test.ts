/**
 * Error propagation contract.
 *
 * The loop never returns `'error'` or `'max_steps'` as a stopReason — those
 * states surface only by throwing. AbortError-shaped exceptions converge
 * to `stopReason='aborted'` and never throw to the caller. Every throw
 * is preceded by exactly one `turn.interrupted` event whose `reason`
 * names the cause.
 */

import { describe, expect, it } from 'vitest';

import { ErrorCodes, KimiError } from '../../src/errors';
import type { Logger, LogPayload } from '../../src/logging';
import type { LoopHooks } from '../../src/loop/index';
import { makeEndTurnResponse, makeToolCall, makeToolUseResponse } from './fixtures/fake-llm';
import { runTurn, runTurnExpectingThrow } from './fixtures/helpers';
import { EchoTool } from './fixtures/tools';

interface CapturedLogEntry {
  readonly level: 'error' | 'warn' | 'info' | 'debug';
  readonly message: string;
  readonly payload?: LogPayload;
}

describe('runTurn — error paths', () => {
  it('rethrows non-abort LLM errors with turn.interrupted{reason:"error"}', async () => {
    const llmError = new Error('upstream blew up');
    const { error, sink, context } = await runTurnExpectingThrow({
      responses: [makeEndTurnResponse('never')], // ignored: throw fires first
      llmThrowOnIndex: { index: 0, error: llmError },
    });

    expect(error).toBe(llmError);
    const interrupted = sink.byType('turn.interrupted');
    expect(interrupted.length).toBe(1);
    expect(interrupted[0]?.reason).toBe('error');
    expect(interrupted[0]?.attemptedSteps).toBe(1);
    expect(interrupted[0]?.activeStep).toBe(1);
    // step.begin was opened but step.end was NOT
    expect(context.stepBegins().length).toBe(1);
    expect(context.stepEnds().length).toBe(0);
  });

  it('logs non-abort LLM request failures without request payloads or stacks', async () => {
    const llmError = new Error('upstream blew up');
    const { logger, entries } = captureLogs();
    const { error } = await runTurnExpectingThrow({
      responses: [makeEndTurnResponse('never')],
      llmThrowOnIndex: { index: 0, error: llmError },
      log: logger,
    });

    expect(error).toBe(llmError);
    expect(entries).toEqual([
      {
        level: 'warn',
        message: 'llm request failed',
        payload: {
          turnStep: 'turn-1.1',
          attempt: '1/3',
          model: 'fake-model',
          errorName: 'Error',
          errorMessage: 'upstream blew up',
        },
      },
    ]);
  });

  it('does not log aborted LLM requests as failures', async () => {
    const controller = new AbortController();
    const { logger, entries } = captureLogs();
    const { result } = await runTurn({
      responses: [makeEndTurnResponse('never')],
      llmAbortOnIndex: { index: 0, controller },
      signal: controller.signal,
      log: logger,
    });

    expect(result.stopReason).toBe('aborted');
    expect(entries).toEqual([]);
  });

  it('throws KimiError(loop.max_steps_exceeded) with turn.interrupted{reason:"max_steps"} before the throw', async () => {
    const echo = new EchoTool();
    const { error, sink } = await runTurnExpectingThrow({
      maxSteps: 2,
      tools: [echo],
      responses: [
        makeToolUseResponse([makeToolCall('echo', { text: '1' }, 'a')]),
        makeToolUseResponse([makeToolCall('echo', { text: '2' }, 'b')]),
        // never reached
      ],
    });

    expect(error).toBeInstanceOf(KimiError);
    expect((error as KimiError).code).toBe(ErrorCodes.LOOP_MAX_STEPS_EXCEEDED);
    const interrupted = sink.byType('turn.interrupted');
    expect(interrupted.map((e) => e.reason)).toEqual(['max_steps']);
    expect(interrupted[0]?.attemptedSteps).toBe(2);
    expect(interrupted[0]?.activeStep).toBeUndefined();
  });

  it('rethrows non-abort hook errors via the same path', async () => {
    const hookError = new Error('hook crashed');
    const hooks: LoopHooks = {
      beforeStep: async () => {
        throw hookError;
      },
    };
    const { error, sink } = await runTurnExpectingThrow({
      hooks,
      responses: [makeEndTurnResponse('never')],
    });

    expect(error).toBe(hookError);
    const interrupted = sink.byType('turn.interrupted');
    expect(interrupted.length).toBe(1);
    expect(interrupted[0]?.reason).toBe('error');
  });

  it('AbortError thrown by a hook converges to stopReason="aborted" (no throw)', async () => {
    const controller = new AbortController();
    const hooks: LoopHooks = {
      beforeStep: async () => {
        controller.abort();
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
    };
    const { result, sink } = await runTurn({
      hooks,
      responses: [makeEndTurnResponse('never')],
      signal: controller.signal,
    });
    expect(result.stopReason).toBe('aborted');
    const interrupted = sink.byType('turn.interrupted');
    expect(interrupted.length).toBe(1);
    expect(interrupted[0]?.reason).toBe('aborted');
  });

  it('emits turn.interrupted exactly once per failure (no duplicate emits)', async () => {
    const { sink } = await runTurnExpectingThrow({
      responses: [makeEndTurnResponse('never')],
      llmThrowOnIndex: { index: 0, error: new Error('once') },
    });
    expect(sink.byType('turn.interrupted').length).toBe(1);
  });

  it('does NOT emit step.end when a step throws before sealing', async () => {
    const { sink } = await runTurnExpectingThrow({
      responses: [makeEndTurnResponse('never')],
      llmThrowOnIndex: { index: 0, error: new Error('boom') },
    });
    // step.begin fires, step.end does not, turn.interrupted takes its place
    expect(sink.count('step.begin')).toBe(1);
    expect(sink.count('step.end')).toBe(0);
    expect(sink.count('turn.interrupted')).toBe(1);
  });
});

function captureLogs(): { readonly logger: Logger; readonly entries: CapturedLogEntry[] } {
  const entries: CapturedLogEntry[] = [];
  const logger: Logger = {
    error: (message, payload) => {
      entries.push({ level: 'error', message, payload });
    },
    warn: (message, payload) => {
      entries.push({ level: 'warn', message, payload });
    },
    info: (message, payload) => {
      entries.push({ level: 'info', message, payload });
    },
    debug: (message, payload) => {
      entries.push({ level: 'debug', message, payload });
    },
    createChild: () => logger,
  };
  return { logger, entries };
}
