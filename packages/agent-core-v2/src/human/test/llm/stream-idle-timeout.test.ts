import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assign, createActor, emit, setup } from '#/xstate2';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import { createUserMessage } from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import { createRequestActor, type LlmEvent } from '#/llm/requester/actor';
import type { LlmRequester } from '#/llm/requester/requester';
import {
  DEFAULT_LLM_STREAM_IDLE_TIMEOUT_MS,
  LLM_STREAM_IDLE_TIMEOUT_ENV,
  resolveLlmStreamIdleTimeoutMs,
} from '#/llm/requester/timeout';
import {
  createTurnMachine,
  type CreateTurnMachineOptions,
  type TurnEvent,
  type TurnInput,
  type TurnLlmEvent,
  type TurnOutput,
} from '#/agent/turn';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

const IDLE = DEFAULT_LLM_STREAM_IDLE_TIMEOUT_MS;

type FailedRemoteEvent = Extract<LlmEvent, { type: 'llm.failed.remote' }>;
type RetryingEvent = Extract<LlmEvent, { type: 'llm.retrying' }>;

interface CapturedGenerate {
  signal: AbortSignal;
}

function createHangingRequester(options?: {
  emitSent?: boolean;
  onAbortEmit?: LlmEvent;
  captured?: CapturedGenerate[];
}) {
  let calls = 0;
  const requester: LlmRequester = {
    generate: (_config, _content, control) => {
      calls += 1;
      options?.captured?.push({ signal: control.signal });
      if (options?.emitSent === true) control.onEvent?.({ type: 'llm.sent' });
      return new Promise<void>((resolve) => {
        control.signal.addEventListener(
          'abort',
          () => {
            if (options?.onAbortEmit !== undefined) control.onEvent?.(options.onAbortEmit);
            resolve();
          },
          { once: true },
        );
      });
    },
  };
  return { requester, calls: () => calls };
}

function startRequestActor(requester: LlmRequester, signal: AbortSignal) {
  const harness = setup({
    types: {
      input: {} as { signal: AbortSignal },
      context: {} as { signal: AbortSignal },
      events: {} as LlmEvent,
      emitted: {} as LlmEvent,
    },
    actors: { request: createRequestActor(requester) },
  }).createMachine({
    id: 'request-harness',
    initial: 'running',
    context: ({ input }) => input,
    states: {
      running: {
        invoke: {
          src: 'request',
          input: ({ context }) => ({
            config: { model },
            content: { messages: [createUserMessage('hi')] },
            signal: context.signal,
          }),
        },
        on: {
          '*': {
            actions: emit(({ event }) => event),
          },
        },
      },
    },
  });
  const events: LlmEvent[] = [];
  const failed: FailedRemoteEvent[] = [];
  const actor = createActor(harness, { input: { signal } });
  actor.on('llm.failed.remote', (event) => {
    events.push(event);
    failed.push(event);
  });
  actor.on('llm.done', (event) => events.push(event));
  actor.on('llm.streaming.part', (event) => events.push(event));
  actor.start();
  return { actor, events, failed };
}

interface HarnessContext {
  turnInput: TurnInput;
  turnOutput?: TurnOutput;
}

function startTurnActor(requester: LlmRequester, options?: CreateTurnMachineOptions) {
  const harness = setup({
    types: {
      input: {} as TurnInput,
      context: {} as HarnessContext,
      events: {} as TurnEvent,
      emitted: {} as TurnLlmEvent,
    },
    actors: { turn: createTurnMachine(requester, options) },
  }).createMachine({
    id: 'harness',
    initial: 'running',
    context: ({ input }) => ({ turnInput: input }),
    states: {
      running: {
        invoke: {
          src: 'turn',
          input: ({ context }) => context.turnInput,
          onDone: {
            target: 'completed',
            actions: assign({ turnOutput: ({ event }) => event.output }),
          },
        },
        on: {
          '*': {
            actions: emit(({ event }) => event as TurnLlmEvent),
          },
        },
      },
      completed: { type: 'final' },
    },
  });
  const retrying: RetryingEvent[] = [];
  const failed: unknown[] = [];
  const actor = createActor(harness, {
    input: { request: { model }, history: [] },
  });
  actor.on('llm.retrying', (event) => retrying.push(event));
  actor.on('llm.failed.remote', (event) => failed.push(event.error));
  actor.start();
  return { actor, retrying, failed };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('resolveLlmStreamIdleTimeoutMs', () => {
  it('defaults to 90s when the env var is unset or empty', () => {
    expect(resolveLlmStreamIdleTimeoutMs({})).toBe(90_000);
    expect(resolveLlmStreamIdleTimeoutMs({ [LLM_STREAM_IDLE_TIMEOUT_ENV]: '  ' })).toBe(90_000);
  });

  it('honors a millisecond override', () => {
    expect(resolveLlmStreamIdleTimeoutMs({ [LLM_STREAM_IDLE_TIMEOUT_ENV]: '5000' })).toBe(5_000);
  });

  it('treats 0 as disabled', () => {
    expect(resolveLlmStreamIdleTimeoutMs({ [LLM_STREAM_IDLE_TIMEOUT_ENV]: '0' })).toBeUndefined();
  });

  it('rejects invalid values naming the env var', () => {
    for (const raw of ['abc', '-1', '1.5', '3000000000']) {
      expect(() =>
        resolveLlmStreamIdleTimeoutMs({ [LLM_STREAM_IDLE_TIMEOUT_ENV]: raw }),
      ).toThrowError(LLM_STREAM_IDLE_TIMEOUT_ENV);
    }
  });
});

describe('request actor stream idle watchdog', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    savedEnv = process.env[LLM_STREAM_IDLE_TIMEOUT_ENV];
    delete process.env[LLM_STREAM_IDLE_TIMEOUT_ENV];
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedEnv === undefined) delete process.env[LLM_STREAM_IDLE_TIMEOUT_ENV];
    else process.env[LLM_STREAM_IDLE_TIMEOUT_ENV] = savedEnv;
  });

  it('aborts a stalled stream and reports a retryable timeout failure', async () => {
    const captured: CapturedGenerate[] = [];
    const { requester, calls } = createHangingRequester({ emitSent: true, captured });
    const { failed } = startRequestActor(requester, new AbortController().signal);

    await vi.advanceTimersByTimeAsync(IDLE - 1);
    expect(failed).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(calls()).toBe(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).toMatchObject({ kind: 'timeout' });
    expect(failed[0]?.error.message).toContain(`${IDLE}ms`);
    expect(captured[0]?.signal.aborted).toBe(true);
  });

  it('does not fire while stream events keep arriving', async () => {
    const requester: LlmRequester = {
      generate: (_config, _content, { onEvent }) =>
        new Promise<void>((resolve) => {
          let chunks = 0;
          const emitNext = () => {
            chunks += 1;
            onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: `#${chunks}` } });
            if (chunks < 4) {
              setTimeout(emitNext, IDLE / 3);
              return;
            }
            onEvent?.({ type: 'llm.done' });
            resolve();
          };
          setTimeout(emitNext, IDLE / 3);
        }),
    };
    const { events, failed } = startRequestActor(requester, new AbortController().signal);

    await vi.advanceTimersByTimeAsync((IDLE / 3) * 4 + 1);
    expect(failed).toHaveLength(0);
    expect(events.filter((event) => event.type === 'llm.streaming.part')).toHaveLength(4);
    expect(events.at(-1)).toMatchObject({ type: 'llm.done' });

    await vi.advanceTimersByTimeAsync(IDLE * 3);
    expect(failed).toHaveLength(0);
  });

  it('stays silent when the caller aborts a stalled stream', async () => {
    const controller = new AbortController();
    const { requester } = createHangingRequester();
    const { failed } = startRequestActor(requester, controller.signal);

    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(IDLE * 3);
    expect(failed).toHaveLength(0);
  });

  it('keeps the timeout failure when the provider reports an abort right after', async () => {
    const { requester } = createHangingRequester({
      onAbortEmit: {
        type: 'llm.failed.remote',
        error: { kind: 'abort', message: 'The operation was aborted.' },
      },
    });
    const { failed } = startRequestActor(requester, new AbortController().signal);

    await vi.advanceTimersByTimeAsync(IDLE);
    await flush();
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).toMatchObject({ kind: 'timeout' });
  });

  it('honors the env var override', async () => {
    process.env[LLM_STREAM_IDLE_TIMEOUT_ENV] = '1000';
    const { requester } = createHangingRequester();
    const { failed } = startRequestActor(requester, new AbortController().signal);

    await vi.advanceTimersByTimeAsync(999);
    expect(failed).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).toMatchObject({ kind: 'timeout' });
  });

  it('never fires when the env var disables the watchdog', async () => {
    process.env[LLM_STREAM_IDLE_TIMEOUT_ENV] = '0';
    const { requester } = createHangingRequester();
    const controller = new AbortController();
    const { failed } = startRequestActor(requester, controller.signal);

    await vi.advanceTimersByTimeAsync(IDLE * 10);
    expect(failed).toHaveLength(0);
    controller.abort();
  });

  it('fails the request loudly when the env var is invalid', async () => {
    process.env[LLM_STREAM_IDLE_TIMEOUT_ENV] = 'abc';
    const { requester } = createHangingRequester();
    const { failed } = startRequestActor(requester, new AbortController().signal);

    await flush();
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error.message).toContain(LLM_STREAM_IDLE_TIMEOUT_ENV);
  });

  it('retries a stalled request through the turn machine and succeeds', async () => {
    let calls = 0;
    const requester: LlmRequester = {
      generate: (_config, _content, control) => {
        calls += 1;
        if (calls === 1) {
          return new Promise<void>((resolve) => {
            control.signal.addEventListener(
              'abort',
              () => {
                resolve();
              },
              { once: true },
            );
          });
        }
        control.onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'recovered' } });
        control.onEvent?.({ type: 'llm.done' });
        return Promise.resolve();
      },
    };
    const { actor, retrying, failed } = startTurnActor(requester);

    await vi.advanceTimersByTimeAsync(IDLE);
    await flush();
    expect(calls).toBe(1);
    expect(retrying).toHaveLength(1);
    expect(retrying[0]).toMatchObject({
      failedAttempt: 1,
      nextAttempt: 2,
      errorName: 'timeout',
    });

    await vi.advanceTimersByTimeAsync((retrying[0] as RetryingEvent).delayMs + 1);
    await flush();
    expect(calls).toBe(2);
    expect(actor.getSnapshot().context.turnOutput).toMatchObject({ type: 'done' });
    expect(failed).toHaveLength(0);
  });
});
