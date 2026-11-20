import { describe, expect, it } from 'vitest';

import { createAssistantMessage, createUserMessage } from '@moonshot-ai/core/llm/message';
import { createPolicyRegistry } from '@moonshot-ai/core/llm/policy/registry';
import type { LlmOutcome } from '@moonshot-ai/core/llm/response';
import {
  createTurn,
  type LoopEmitted,
  type LoopLlmRequester,
  type TurnEmitted,
  type TurnRuntime,
} from '@moonshot-ai/core/loop/index';
import { createMockProviderRequester } from '../../../harness/scripted-generate';
import { createTestLoop as createLoop } from './factory';
import { successfulExecutor } from './executor';

function echoRequester() {
  return createMockProviderRequester(() => ({ parts: [{ type: 'text', text: 'done' }] }));
}

const prompt = (text: string) => createUserMessage(text);

const noopExecutor = successfulExecutor(['noop']);

describe('loop.wait', () => {
  it('resolves with the first emitted event of the type passing match', async () => {
    const loop = createLoop({ requester: echoRequester(), executor: noopExecutor });
    const lifecycleEvents: LoopEmitted['type'][] = [];
    const lifecycleGenerations: number[] = [];
    loop.subscribe((event) => {
      if (event.type === 'turn.ended' || event.type === 'loop.drained' || event.type === 'loop.idle') {
        lifecycleEvents.push(event.type);
      }
      if (event.type === 'loop.drained' || event.type === 'loop.idle') lifecycleGenerations.push(event.generation);
    });
    const pending = loop.wait('turn.ended', { match: (event) => event.turnId === 1 });
    await loop.runTurn(prompt('one'));
    await loop.runTurn(prompt('two'));
    const event = await pending;
    expect(event.turnId).toBe(1);
    expect(event.outcome.type).toBe('done');
    expect(lifecycleEvents).toEqual([
      'turn.ended',
      'loop.drained',
      'loop.idle',
      'turn.ended',
      'loop.drained',
      'loop.idle',
    ]);

    let submissionState: unknown;
    const stopSubmission = loop.subscribe((event) => {
      if (event.type !== 'prompt.submitted') return;
      submissionState = {
        status: loop.state.status,
        turnId: loop.state.turn?.id,
        normal: loop.state.inbox.normal.length,
      };
    });
    expect(loop.submit(prompt('three'))).toMatchObject({ type: 'prompt.submitted' });
    stopSubmission();
    expect(submissionState).toEqual({
      status: 'running',
      turnId: 2,
      normal: 0,
    });
    expect(loop.state.status).toBe('running');
    await loop.waitForIdle();
    const active = loop.runTurn(prompt('four'));
    loop.submit(createUserMessage('cancelled', { promptId: 'cancelled' }));
    expect(loop.cancel('cancelled')).toMatchObject({ type: 'prompt.canceled', canceled: true });
    await active;
    await loop.waitForIdle();
    expect(loop.state.nextTurnId).toBe(4);

    lifecycleEvents.length = 0;
    loop.remind(prompt('passive reminder'));
    await loop.waitForIdle();
    expect(loop.state.inbox.remind).toEqual([]);
    expect(lifecycleEvents).not.toContain('llm.started');
    expect(lifecycleEvents).toEqual(['loop.drained', 'loop.idle']);

    lifecycleEvents.length = 0;
    const stopDrained = loop.subscribe((event) => {
      if (event.type !== 'loop.drained') return;
      stopDrained();
      loop.submit(prompt('submitted from drained'));
    });
    const followUpTurnId = loop.state.nextTurnId + 1;
    const followUpTurn = loop.wait('turn.ended', { match: (event) => event.turnId === followUpTurnId });
    loop.submit(prompt('start macro'));
    await followUpTurn;
    await loop.waitForIdle();
    expect(lifecycleEvents).toEqual([
      'turn.ended',
      'loop.drained',
      'turn.ended',
      'loop.drained',
      'loop.idle',
    ]);
    const macroGenerations = lifecycleGenerations.slice(-3);
    expect(macroGenerations[1]).toBe(macroGenerations[0]! + 1);
    expect(macroGenerations[2]).toBe(macroGenerations[1]);
    await loop.close();
  });

  it('does not resolve while match fails and rejects on timeout', async () => {
    const loop = createLoop({ requester: echoRequester(), executor: noopExecutor });
    const missing = loop.wait('turn.ended', { match: (event) => event.turnId === 99, timeoutMs: 50 });
    await loop.runTurn(prompt('one'));
    await expect(missing).rejects.toThrow('wait timed out after 50ms');
    const timedOut = loop.wait('step.started', { timeoutMs: 20 });
    await expect(timedOut).rejects.toThrow('wait timed out after 20ms');
    await loop.close();
  });

  it('handles abort signals without rerunning settled turns', async () => {
    const loop = createLoop({ requester: echoRequester(), executor: noopExecutor });
    const controller = new AbortController();
    const pending = loop.wait('turn.ended', { signal: controller.signal });
    controller.abort(new Error('stop-waiting'));
    await expect(pending).rejects.toThrow('stop-waiting');
    await loop.close();

    const never = createMockProviderRequester((_request, signal) => ({
      parts: [{ type: 'text', text: 'pending' }],
      error: signal.aborted
        ? signal.reason
        : new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
    }));
    const aborting = createLoop({
      requester: never,
      executor: noopExecutor,
      abortGraceMs: 5,
    });
    const firstRequest = aborting.wait('llm.delta.part');
    const graceful = aborting.runTurn(prompt('graceful'));
    await firstRequest;
    aborting.abort('grace');
    expect((await graceful).type).toBe('aborted');

    const secondRequest = aborting.wait('llm.delta.part');
    const forced = aborting.runTurn(prompt('forced'));
    await secondRequest;
    aborting.abort('first');
    aborting.abort('second');
    expect((await forced).type).toBe('aborted');
    await aborting.close();

    const reentrant = createLoop({
      requester: echoRequester(),
      executor: noopExecutor,
    });
    const steps: number[] = [];
    reentrant.subscribe((event) => {
      if (event.type === 'step.started') steps.push(event.step);
      if (event.type === 'step.ended') reentrant.abort('listener');
    });
    expect((await reentrant.runTurn(prompt('reentrant'))).type).toBe('aborted');
    expect(steps).toEqual([1]);
    await reentrant.close();

    let requestCount = 0;
    let startingCount = 0;
    let batchCount = 0;
    let announceRequest!: () => void;
    let resolveRequest!: (outcome: LlmOutcome) => void;
    const requestStarted = new Promise<void>((resolve) => {
      announceRequest = resolve;
    });
    const requester: LoopLlmRequester = {
      generate: () => {
        requestCount += 1;
        announceRequest();
        return new Promise<LlmOutcome>((resolve) => {
          resolveRequest = resolve;
        });
      },
    };
    const events: TurnEmitted[] = [];
    const runtime: TurnRuntime = {
      requester: () => requester,
      policy: createPolicyRegistry(),
      executeBatch: () => {
        batchCount += 1;
        return { outcomes: [] };
      },
      abortBatch: () => ({ outcomes: [] }),
      hooks: {
        starting: () => {
          startingCount += 1;
        },
      },
      extensions: {
        'tool.batch-starting': () => {
          batchCount += 1;
        },
      },
      read: () => ({ messages: [], profile: {} }),
      emit: (event) => {
        events.push(event);
      },
      transition: (run) => run(),
      report: () => undefined,
      committed: () => undefined,
      signal: new AbortController().signal,
    };
    const turn = createTurn({
      id: 90,
      kind: 'continue',
      trigger: 'continue',
      initialPending: [],
      promptOnly: false,
      bypassMaxSteps: false,
      step: 0,
    }, runtime);
    expect(requestCount).toBe(0);
    expect(startingCount).toBe(0);
    expect(events).toEqual([]);
    turn.start();
    turn.start();
    await requestStarted;
    turn.abort('stop');
    turn.abort('force', { force: true });
    await expect(turn.done).resolves.toMatchObject({ type: 'aborted' });
    expect(turn.state.phase).toBe('finished');
    resolveRequest({
      type: 'done',
      message: createAssistantMessage([{ type: 'text', text: 'late' }]),
      usage: undefined,
    });
    await Promise.resolve();
    await Promise.resolve();
    turn.start();
    turn.abort('late');
    expect(requestCount).toBe(1);
    expect(startingCount).toBe(1);
    expect(batchCount).toBe(0);
    expect(events.filter((event) => event.type === 'turn.ended')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'message.appended')).toHaveLength(0);
  });
});

