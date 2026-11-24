import { describe, expect, it } from 'vitest';

import { createAssistantMessage, createUserMessage } from '@moonshot-ai/core/llm/message';
import { createPolicyRegistry } from '@moonshot-ai/core/llm/policy/registry';
import type { LlmOutcome } from '@moonshot-ai/core/llm/response';
import { abortedToolOutcome } from '@moonshot-ai/core/loop/tool/outcome';
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

const noopExecutor = successfulExecutor(['noop']);

describe('loop.wait', () => {
  it('resolves with the first emitted event of the type passing match', async () => {
    const loop = createLoop({ requester: echoRequester(), executor: noopExecutor });
    const turnEnds: Extract<LoopEmitted, { type: 'turn.ended' }>[] = [];
    loop.subscribe((event) => {
      if (event.type === 'turn.ended') turnEnds.push(event);
    });
    const pending = loop.wait('turn.ended', { match: (event) => event.turnId === 1 });
    await loop.runTurn(prompt('one'));
    await loop.runTurn(prompt('two'));
    const event = await pending;
    expect(event.turnId).toBe(1);
    expect(event.outcome.type).toBe('done');
    expect(turnEnds.map((ended) => [ended.turnId, ended.loopEnd?.outcome])).toEqual([
      [0, 'idle'],
      [1, 'idle'],
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

    turnEnds.length = 0;
    loop.remind(prompt('passive reminder'));
    await loop.waitForIdle();
    expect(loop.state.inbox.remind).toEqual([]);
    expect(turnEnds).toEqual([]);

    const stopEnded = loop.subscribe((ended) => {
      if (ended.type !== 'turn.ended' || ended.loopEnd === undefined) return;
      stopEnded();
      loop.submit(prompt('submitted from ended'));
    });
    const followUpTurnId = loop.state.nextTurnId + 1;
    const followUpTurn = loop.wait('turn.ended', { match: (ended) => ended.turnId === followUpTurnId });
    loop.submit(prompt('start macro'));
    await followUpTurn;
    await loop.waitForIdle();
    expect(turnEnds.map((ended) => [ended.turnId, ended.loopEnd?.outcome])).toEqual([
      [followUpTurnId - 1, 'idle'],
      [followUpTurnId, 'idle'],
    ]);
    await loop.close();
  });

  it('marks loop end on crash-window settlement only when no work follows', async () => {
    const crashed = createLoop({
      requester: echoRequester(),
      executor: noopExecutor,
      input: {
        nextTurnId: 4,
        unfinished: { turnId: 3, trigger: 'normal', step: 1, stepUnfinished: false, appended: false },
      },
    });
    const crashedEnds: Extract<LoopEmitted, { type: 'turn.ended' }>[] = [];
    crashed.subscribe((event) => {
      if (event.type === 'turn.ended') crashedEnds.push(event);
    });
    await crashed.waitForIdle();
    expect(crashedEnds).toEqual([]);
    await crashed.runTurn(prompt('fresh work after the crash window'));
    expect(crashedEnds.map((ended) => [ended.turnId, ended.loopEnd?.outcome])).toEqual([
      [3, undefined],
      [4, 'idle'],
    ]);
    await crashed.close();

    const parked = createLoop({ requester: echoRequester(), executor: noopExecutor });
    const parkedEnds: Extract<LoopEmitted, { type: 'turn.ended' }>[] = [];
    parked.subscribe((event) => {
      if (event.type === 'turn.ended') parkedEnds.push(event);
    });
    parked.recordNotification(prompt('restored completion'));
    parked.remind(prompt('parked reminder'));
    await parked.waitForIdle();
    expect(parkedEnds).toEqual([]);
    parked.start();
    await parked.waitForIdle();
    expect(parkedEnds.map((ended) => [ended.turnId, ended.loopEnd?.outcome])).toEqual([[0, 'idle']]);
    expect(parked.state.messages.map((entry) => entry.role)).toEqual(['user', 'user']);
    await parked.close();
  });

  it('marks loop end on an aborted turn only when no continuation follows', async () => {
    let call = 0;
    const requester = createMockProviderRequester((_request, signal) => {
      call += 1;
      if (call > 2) return { parts: [{ type: 'text', text: 'done' }] };
      return {
        parts: [{ type: 'text', text: 'pending' }],
        error: signal.aborted
          ? new Error('aborted')
          : new Promise<never>((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            }),
      };
    });
    const loop = createLoop({ requester, executor: noopExecutor, abortGraceMs: 5 });
    const turnEnds: Extract<LoopEmitted, { type: 'turn.ended' }>[] = [];
    loop.subscribe((event) => {
      if (event.type === 'turn.ended') turnEnds.push(event);
    });

    const firstRequest = loop.wait('llm.delta.part');
    const parked = loop.runTurn(prompt('cancel without follow-up'));
    await firstRequest;
    loop.abort('user');
    expect((await parked).type).toBe('aborted');
    await loop.waitForIdle();
    expect(loop.state.held).toBe(true);
    expect(turnEnds.map((ended) => [ended.turnId, ended.loopEnd?.outcome])).toEqual([[0, 'idle']]);

    turnEnds.length = 0;
    const secondRequest = loop.wait('llm.delta.part');
    const continued = loop.runTurn(prompt('cancel with queued follow-up'));
    await secondRequest;
    loop.submit(prompt('queued follow-up'));
    loop.abort('user', { continue: true });
    expect((await continued).type).toBe('aborted');
    await loop.waitForIdle();
    expect(turnEnds.map((ended) => [ended.turnId, ended.loopEnd?.outcome])).toEqual([
      [1, undefined],
      [2, 'idle'],
    ]);
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
        starting: async () => {
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

    let announceLateRequest!: () => void;
    const lateRequestStarted = new Promise<void>((resolve) => { announceLateRequest = resolve; });
    let resolveLateRequest!: (outcome: LlmOutcome) => void;
    const lateRequester: LoopLlmRequester = {
      generate: () => {
        announceLateRequest();
        return new Promise<LlmOutcome>((resolve) => { resolveLateRequest = resolve; });
      },
    };
    let announceStopping!: () => void;
    const stoppingStarted = new Promise<void>((resolve) => { announceStopping = resolve; });
    let releaseStopping!: () => void;
    const stoppingRelease = new Promise<void>((resolve) => { releaseStopping = resolve; });
    let batchStartingCount = 0;
    let continuingCount = 0;
    const order: string[] = [];
    const lateEvents: TurnEmitted[] = [];
    const lateRuntime: TurnRuntime = {
      requester: () => lateRequester,
      policy: createPolicyRegistry(),
      executeBatch: (batch) => {
        order.push('tools.abort');
        return { outcomes: batch.calls.map((call) => abortedToolOutcome(call.toolCall, batch.aborted?.reason)) };
      },
      abortBatch: () => undefined,
      hooks: {
        ending: async (event) => {
          order.push(`owner.ending:${event.at}`);
        },
      },
      extensions: {
        'tool.batch-starting': () => {
          batchStartingCount += 1;
        },
        'step.stopping': () => {
          order.push('step.stopping');
          announceStopping();
          return stoppingRelease.then(() => ({
            type: 'done' as const,
            cause: { by: 'loop' as const, reason: 'prompt_only' as const },
          }));
        },
        'step.continuing': () => {
          continuingCount += 1;
        },
      },
      read: () => ({ messages: [], profile: {} }),
      emit: (event) => {
        if (event.type === 'step.ended' || event.type === 'turn.ended') order.push(event.type);
        lateEvents.push(event);
      },
      transition: (run) => run(),
      report: () => undefined,
      committed: () => undefined,
      signal: new AbortController().signal,
      abortGraceMs: 1_000,
    };
    const lateTurn = createTurn({
      id: 91,
      kind: 'continue',
      trigger: 'continue',
      initialPending: [],
      promptOnly: false,
      bypassMaxSteps: false,
      step: 0,
    }, lateRuntime);
    lateTurn.start();
    await lateRequestStarted;
    lateTurn.abort('late-abort');
    expect(lateTurn.state.phase).toBe('aborting');
    resolveLateRequest({
      type: 'done',
      message: createAssistantMessage(
        [{ type: 'text', text: 'late tools' }],
        [{ type: 'function', id: 'late-call', name: 'noop', arguments: '{}' }],
      ),
      usage: undefined,
    });
    const firstSettlement = await Promise.race([
      stoppingStarted.then(() => 'stopping'),
      lateTurn.done.then(() => 'ended'),
    ]);
    expect(firstSettlement).toBe('stopping');
    expect(batchStartingCount).toBe(0);
    expect(lateEvents.filter((event) => event.type === 'turn.ended')).toHaveLength(0);
    releaseStopping();
    await expect(lateTurn.done).resolves.toMatchObject({ type: 'aborted', reason: 'late-abort' });
    expect(continuingCount).toBe(0);
    expect(order).toEqual(['tools.abort', 'step.stopping', 'step.ended', 'owner.ending:requesting', 'turn.ended']);
    expect(lateEvents.filter((event) => event.type === 'step.ended')).toHaveLength(1);
    expect(lateEvents.filter((event) => event.type === 'turn.ended')).toHaveLength(1);

    let announceEnding!: () => void;
    const endingStarted = new Promise<void>((resolve) => { announceEnding = resolve; });
    let releaseEnding!: () => void;
    const endingRelease = new Promise<void>((resolve) => { releaseEnding = resolve; });
    let announceOwnerEnding!: () => void;
    const ownerEndingStarted = new Promise<void>((resolve) => { announceOwnerEnding = resolve; });
    let releaseOwnerEnding!: () => void;
    const ownerEndingRelease = new Promise<void>((resolve) => { releaseOwnerEnding = resolve; });
    let lateEndingAppend!: () => void;
    let endingStoppingCount = 0;
    let endingContinuingCount = 0;
    const endingOrder: string[] = [];
    const endingRuntime: TurnRuntime = {
      requester: () => echoRequester(),
      policy: createPolicyRegistry(),
      executeBatch: () => ({ outcomes: [] }),
      abortBatch: () => undefined,
      hooks: {
        ending: async (event, ctx) => {
          endingOrder.push(`owner.ending:${event.at}`);
          ctx.append({ kind: 'remind', message: prompt('async ending') });
          lateEndingAppend = () => ctx.append({ kind: 'remind', message: prompt('late ending') });
          announceOwnerEnding();
          await ownerEndingRelease;
        },
      },
      extensions: {
        'step.stopping': () => {
          endingStoppingCount += 1;
          endingOrder.push('step.stopping');
          announceEnding();
          return endingRelease.then(() => ({
            type: 'done' as const,
            cause: { by: 'loop' as const, reason: 'prompt_only' as const },
          }));
        },
        'step.continuing': () => {
          endingContinuingCount += 1;
        },
      },
      read: () => ({ messages: [], profile: {} }),
      emit: (event) => {
        if (event.type === 'step.ended' || event.type === 'turn.ended') endingOrder.push(event.type);
      },
      transition: (run) => run(),
      report: () => undefined,
      committed: () => undefined,
      signal: new AbortController().signal,
    };
    const endingTurn = createTurn({
      id: 92,
      kind: 'continue',
      trigger: 'continue',
      initialPending: [],
      promptOnly: false,
      bypassMaxSteps: false,
      step: 0,
    }, endingRuntime);
    endingTurn.start();
    await endingStarted;
    endingTurn.abort('ending-abort');
    expect(endingTurn.state.phase).toBe('finishing');
    releaseEnding();
    await ownerEndingStarted;
    expect(endingTurn.state.phase).toBe('finished');
    expect(endingOrder).toEqual(['step.stopping', 'step.ended', 'owner.ending:ending']);
    endingTurn.abort('late-ending-abort');
    releaseOwnerEnding();
    await expect(endingTurn.done).resolves.toMatchObject({ type: 'aborted', reason: 'ending-abort' });
    expect(endingStoppingCount).toBe(1);
    expect(endingContinuingCount).toBe(0);
    expect(endingOrder).toEqual(['step.stopping', 'step.ended', 'owner.ending:ending', 'turn.ended']);
    expect(lateEndingAppend).toThrow('turn hook context is no longer active');
  });

  it('forces closing past unsettled ending hooks without duplicating terminal events', async () => {
    const input = (id: number) => ({
      id,
      kind: 'continue' as const,
      trigger: 'continue' as const,
      initialPending: [],
      promptOnly: false,
      bypassMaxSteps: false,
      step: 0,
    });
    const baseRuntime: TurnRuntime = {
      requester: () => echoRequester(),
      policy: createPolicyRegistry(),
      executeBatch: () => ({ outcomes: [] }),
      abortBatch: () => undefined,
      hooks: {},
      extensions: {},
      read: () => ({ messages: [], profile: {} }),
      emit: () => undefined,
      transition: (run) => run(),
      report: () => undefined,
      committed: () => undefined,
      signal: new AbortController().signal,
    };

    const stoppingStarted = deferred();
    const stoppingRelease = deferred();
    const stoppingEvents: TurnEmitted[] = [];
    let stoppingOwnerCount = 0;
    const stoppingTurn = createTurn(input(93), {
      ...baseRuntime,
      hooks: {
        ending: async () => {
          stoppingOwnerCount += 1;
        },
      },
      extensions: {
        'step.stopping': () => {
          stoppingStarted.resolve();
          return stoppingRelease.promise.then(() => ({
            type: 'done' as const,
            cause: { by: 'loop' as const, reason: 'prompt_only' as const },
          }));
        },
      },
      emit: (event) => {
        stoppingEvents.push(event);
      },
    });
    stoppingTurn.start();
    await stoppingStarted.promise;
    stoppingTurn.abort('stopping-abort');
    expect(stoppingTurn.state.phase).toBe('finishing');
    stoppingTurn.abort('stopping-force', { force: true });
    await expect(stoppingTurn.done).resolves.toMatchObject({ type: 'aborted', reason: 'stopping-abort' });
    expect(stoppingOwnerCount).toBe(1);
    expect(stoppingEvents.filter((event) => event.type === 'step.ended')).toHaveLength(1);
    expect(stoppingEvents.filter((event) => event.type === 'turn.ended')).toHaveLength(1);
    stoppingRelease.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(stoppingEvents.filter((event) => event.type === 'step.ended')).toHaveLength(1);
    expect(stoppingEvents.filter((event) => event.type === 'turn.ended')).toHaveLength(1);

    const endingStarted = deferred();
    const endingRelease = deferred();
    const ownerStarted = deferred();
    const ownerRelease = deferred();
    const ownerEvents: TurnEmitted[] = [];
    let lateAppend!: () => void;
    const ownerTurn = createTurn(input(94), {
      ...baseRuntime,
      hooks: {
        ending: async (_event, ctx) => {
          ctx.append({ kind: 'remind', message: prompt('before force') });
          lateAppend = () => ctx.append({ kind: 'remind', message: prompt('after force') });
          ownerStarted.resolve();
          await ownerRelease.promise;
        },
      },
      extensions: {
        'step.stopping': () => {
          endingStarted.resolve();
          return endingRelease.promise.then(() => ({
            type: 'done' as const,
            cause: { by: 'loop' as const, reason: 'prompt_only' as const },
          }));
        },
      },
      emit: (event) => {
        ownerEvents.push(event);
      },
    });
    ownerTurn.start();
    await endingStarted.promise;
    ownerTurn.abort('owner-abort');
    endingRelease.resolve();
    await ownerStarted.promise;
    expect(ownerTurn.state.phase).toBe('finished');
    ownerTurn.abort('owner-force', { force: true });
    await expect(ownerTurn.done).resolves.toMatchObject({ type: 'aborted', reason: 'owner-abort' });
    expect(lateAppend).toThrow('turn hook context is no longer active');
    expect(ownerEvents.filter((event) => event.type === 'message.appended')).toHaveLength(2);
    expect(ownerEvents.filter((event) => event.type === 'step.ended')).toHaveLength(1);
    expect(ownerEvents.filter((event) => event.type === 'turn.ended')).toHaveLength(1);
    ownerRelease.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(ownerEvents.filter((event) => event.type === 'step.ended')).toHaveLength(1);
    expect(ownerEvents.filter((event) => event.type === 'turn.ended')).toHaveLength(1);
  });
});

