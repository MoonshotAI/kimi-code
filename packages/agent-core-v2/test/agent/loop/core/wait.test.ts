import { describe, expect, it } from 'vitest';

import { createUserEntry } from '@moonshot-ai/core/history/history';
import { createUserMessage } from '@moonshot-ai/core/llm/message';
import { createMockProviderRequester } from '../../../harness/scripted-generate';
import { createTestLoop as createLoop } from './factory';
import { successfulExecutor } from './executor';

function echoRequester() {
  return createMockProviderRequester(() => ({ parts: [{ type: 'text', text: 'done' }] }));
}

const prompt = (text: string) => createUserEntry(createUserMessage(text));

const noopExecutor = successfulExecutor(['noop']);

describe('loop.wait', () => {
  it('resolves with the first emitted event of the type passing match', async () => {
    const loop = createLoop({ requester: echoRequester(), executor: noopExecutor });
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
    loop.submit(createUserEntry(createUserMessage('cancelled'), { promptId: 'cancelled' }));
    expect(loop.cancel('cancelled')).toMatchObject({ type: 'prompt.canceled', canceled: true });
    await active;
    await loop.waitForIdle();
    expect(loop.state.nextTurnId).toBe(4);
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

  it('rejects when the external signal aborts and honors abort grace', async () => {
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
  });
});
