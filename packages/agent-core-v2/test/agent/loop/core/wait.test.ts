import { describe, expect, it } from 'vitest';

import { createUserEntry } from '#human/agent/turn';
import { createAssistantMessage, createUserMessage } from '#human/llm/message';
import type { LlmRequest } from '#human/llm/request';
import type { LlmOutcome } from '#human/llm/response';
import type { LoopLlmRequester } from '#/agent/loop/core/index';
import { createTestLoop as createLoop } from './factory';
import { successfulExecutor } from './executor';

function echoRequester(): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async (): Promise<LlmOutcome> => ({
      type: 'done',
      message: createAssistantMessage([{ type: 'text', text: 'done' }]),
    }),
  };
  return self;
}

const prompt = (text: string) => createUserEntry(createUserMessage(text));

const noopExecutor = successfulExecutor(['noop']);

describe('loop.wait', () => {
  it('resolves with the first emitted event of the type passing match', async () => {
    const loop = createLoop({ createTurnExecution: ({ profile }) => ({ profile, requester: echoRequester() }), executor: noopExecutor });
    const pending = loop.wait('turn.ended', { match: (event) => event.turnId === 1 });
    await loop.runTurn(prompt('one'));
    await loop.runTurn(prompt('two'));
    const event = await pending;
    expect(event.turnId).toBe(1);
    expect(event.outcome.type).toBe('done');

    let submissionState: unknown;
    const stopSubmission = loop.subscribe((event) => {
      if (event.type !== 'prompt.submitted') return;
      submissionState = {
        status: loop.state.status,
        turnId: loop.state.turn?.id,
        turnExecution: loop.turnExecution,
        normal: loop.state.inbox.normal.length,
      };
    });
    expect(loop.submit(prompt('three'))).toMatchObject({ type: 'prompt.submitted' });
    stopSubmission();
    expect(submissionState).toEqual({
      status: 'running',
      turnId: 2,
      turnExecution: undefined,
      normal: 0,
    });
    expect(loop.state.status).toBe('running');
    expect(loop.turnExecution).toBeDefined();
    await loop.waitForIdle();
    const active = loop.runTurn(prompt('four'));
    loop.submit(createUserEntry(createUserMessage('cancelled'), { promptId: 'cancelled' }));
    expect(loop.cancel('cancelled')).toMatchObject({ type: 'prompt.canceled', canceled: true });
    await active;
    await loop.waitForIdle();
    expect(loop.state.nextTurnId).toBe(4);
    await loop.close();
  });

  it('does not resolve while match fails and rejects on timeout', async () => {
    const loop = createLoop({ createTurnExecution: ({ profile }) => ({ profile, requester: echoRequester() }), executor: noopExecutor });
    const missing = loop.wait('turn.ended', { match: (event) => event.turnId === 99, timeoutMs: 50 });
    await loop.runTurn(prompt('one'));
    await expect(missing).rejects.toThrow('wait timed out after 50ms');
    const timedOut = loop.wait('step.started', { timeoutMs: 20 });
    await expect(timedOut).rejects.toThrow('wait timed out after 20ms');
    await loop.close();
  });

  it('rejects when the external signal aborts and honors abort grace', async () => {
    const loop = createLoop({ createTurnExecution: ({ profile }) => ({ profile, requester: echoRequester() }), executor: noopExecutor });
    const controller = new AbortController();
    const pending = loop.wait('turn.ended', { signal: controller.signal });
    controller.abort(new Error('stop-waiting'));
    await expect(pending).rejects.toThrow('stop-waiting');
    await loop.close();

    const never: LoopLlmRequester = {
      with: () => never,
      request: (part) => part as unknown as LlmRequest,
      generate: (_rest, control) => {
        control.onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'pending' } });
        return new Promise<LlmOutcome>(() => {});
      },
    };
    const aborting = createLoop({
      createTurnExecution: ({ profile }) => ({ profile, requester: never }),
      executor: noopExecutor,
      abortGraceMs: 5,
    });
    const firstRequest = aborting.wait('llm.streaming.part');
    const graceful = aborting.runTurn(prompt('graceful'));
    await firstRequest;
    aborting.abort('grace');
    expect((await graceful).type).toBe('aborted');

    const secondRequest = aborting.wait('llm.streaming.part');
    const forced = aborting.runTurn(prompt('forced'));
    await secondRequest;
    aborting.abort('first');
    aborting.abort('second');
    expect((await forced).type).toBe('aborted');
    await aborting.close();

    const reentrant = createLoop({
      createTurnExecution: ({ profile }) => ({ profile, requester: echoRequester() }),
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
  });
});
