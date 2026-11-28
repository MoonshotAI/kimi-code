import { createControlledPromise } from '@antfu/utils';
import { describe, expect, it } from 'vitest';

import type { IAgentScopeHandle } from '#/_base/di/scope';
import { userCancellationReason } from '#/_base/utils/abort';
import { IEventBus } from '#/app/event/eventBus';
import type { Event2 } from '#/app/event/event2';
import { LifecycleScope } from '#/app/scopes';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentTaskService, type AgentTaskInfo } from '#/agent/task/task';
import {
  createMaxStepsExceededError,
  IAgentLoopService,
  type Turn,
  type TurnResult,
} from '#/agent/loop/loop';
import { CoreLoopEvent } from '#/agent/loop/coreLoopEvent';
import { Error2, ErrorCodes, isError2 } from '#/errors';
import { runAgentTurn } from '#/session/subagent/runAgentTurn';

function makeTurn(result: TurnResult): Turn {
  const controller = new AbortController();
  return {
    id: 1,
    signal: controller.signal,
    ready: Promise.resolve(),
    result: Promise.resolve(result),
    cancel: () => {
      controller.abort();
      return true;
    },
  };
}

function pendingTurn(id: number): { readonly turn: Turn; finish(result: TurnResult): void } {
  const controller = new AbortController();
  const result = createControlledPromise<TurnResult>();
  return {
    turn: {
      id,
      signal: controller.signal,
      ready: Promise.resolve(),
      result,
      cancel: () => {
        controller.abort();
        return true;
      },
    },
    finish: (value) => {
      result.resolve(value);
    },
  };
}

function assistant(text: string): ContextMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] };
}

class EventBusStub {
  private readonly handlers = new Map<string, Set<(event: Event2<any>) => void>>();

  readonly bus = {
    subscribe: (cls: { readonly type: string }, handler: (event: Event2<any>) => void) => {
      const handlers = this.handlers.get(cls.type) ?? new Set();
      handlers.add(handler);
      this.handlers.set(cls.type, handlers);
      return {
        dispose: () => {
          handlers.delete(handler);
        },
      };
    },
  } as unknown as IEventBus;

  emit(event: Event2<any>): void {
    for (const handler of this.handlers.get(event.type) ?? []) handler(event);
  }

  listenerCount(): number {
    let count = 0;
    for (const handlers of this.handlers.values()) count += handlers.size;
    return count;
  }
}

function stepStarted(turnId: number, stepId: string, step = 1): CoreLoopEvent {
  return new CoreLoopEvent({
    agentId: 'agent-child',
    event: { type: 'step.started', turnId, step, stepId },
  });
}

function delta(turnId: number, text: string): CoreLoopEvent {
  return new CoreLoopEvent({
    agentId: 'agent-child',
    event: { type: 'llm.delta.part', turnId, step: 1, block: 0, part: { type: 'text', text } },
  });
}

function thinking(turnId: number, think: string, hidden?: boolean): CoreLoopEvent {
  return new CoreLoopEvent({
    agentId: 'agent-child',
    event: { type: 'llm.delta.part', turnId, step: 1, block: 0, part: { type: 'think', think, hidden } },
  });
}

function retrying(
  turnId: number,
  reason: 'backoff' | 'invalid_tool_arguments' | 'recovery' = 'backoff',
): CoreLoopEvent {
  const error = { kind: 'connection', message: 'connection reset', retryable: true } as const;
  const event: Extract<CoreLoopEvent['event'], { type: 'llm.retry' }> = reason === 'recovery'
    ? { type: 'llm.retry', turnId, step: 1, reason, strategy: 'strict', action: 'retry', error }
    : {
        type: 'llm.retry',
        turnId,
        step: 1,
        reason,
        failedAttempt: 1,
        nextAttempt: 2,
        maxAttempts: 3,
        delayMs: 0,
        error,
      };
  return new CoreLoopEvent({ agentId: 'agent-child', event });
}

interface TaskFixture {
  readonly info: AgentTaskInfo;
  readonly wait?: Promise<AgentTaskInfo | undefined>;
  readonly stop?: Promise<AgentTaskInfo | undefined>;
}

class TaskServiceStub {
  private readonly fixtures = new Map<string, TaskFixture>();
  readonly waits: string[] = [];
  readonly stops: Array<{ readonly taskId: string; readonly reason: string | undefined }> = [];
  readonly service = {
    list: (activeOnly = false) => activeOnly ? [...this.fixtures.values()].map((fixture) => fixture.info) : [],
    wait: (taskId: string) => {
      this.waits.push(taskId);
      const fixture = this.fixtures.get(taskId);
      return fixture?.wait ?? Promise.resolve(fixture?.info);
    },
    stop: async (taskId: string, reason?: string) => {
      this.stops.push({ taskId, reason });
      const fixture = this.fixtures.get(taskId);
      if (fixture?.stop !== undefined) await fixture.stop;
      this.fixtures.delete(taskId);
      return fixture?.info;
    },
  } as unknown as IAgentTaskService;

  add(taskId: string, fixture: Partial<Omit<TaskFixture, 'info'>> = {}): void {
    this.fixtures.set(taskId, {
      info: { taskId, status: 'running' } as AgentTaskInfo,
      ...fixture,
    });
  }

  finish(taskId: string): void {
    this.fixtures.delete(taskId);
  }
}

function handleWith(
  turn: Turn | Promise<Turn>,
  messages: readonly ContextMessage[],
  events = new EventBusStub(),
  retry?: () => Promise<TurnResult>,
  settled?: () => Promise<TurnResult | undefined>,
  tasks = new TaskServiceStub(),
): {
  readonly handle: IAgentScopeHandle;
  readonly prompts: unknown[];
  readonly cancellations: Array<{ readonly target: unknown; readonly reason: unknown }>;
  readonly suppressions: readonly string[][];
} {
  const prompts: unknown[] = [];
  const cancellations: Array<{ readonly target: unknown; readonly reason: unknown }> = [];
  const suppressions: string[][] = [];
  const services = new Map<unknown, unknown>([
    [
      IAgentLoopService,
      {
        submit: (input: unknown) => {
          prompts.push(input);
          return { id: 'p' };
        },
        promptHandle: () => ({ launched: Promise.resolve(turn) }),
        retry,
        settled: settled ?? (async () => (await turn).result),
        cancel: (target?: unknown, reason?: unknown) => {
          cancellations.push({ target, reason });
          return true;
        },
        suppressTaskNotifications: (taskIds: readonly string[]) => {
          suppressions.push([...taskIds]);
        },
        get: () => messages,
        history: () => messages,
      },
    ],
    [IAgentTaskService, tasks.service],
    [IEventBus, events.bus],
  ]);
  const handle: IAgentScopeHandle = {
    id: 'agent-child',
    kind: LifecycleScope.Agent,
    accessor: {
      get: ((id: unknown) => services.get(id)) as IAgentScopeHandle['accessor']['get'],
    },
    dispose: () => {},
  };
  return { handle, prompts, cancellations, suppressions };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected rejection');
}

describe('runAgentTurn', () => {
  const signal = new AbortController().signal;

  it('returns the final message only after the loop and background tasks are quiescent', async () => {
    const events = new EventBusStub();
    const messages = [assistant('')];
    const continuation = createControlledPromise<TurnResult | undefined>();
    const taskWait = createControlledPromise<AgentTaskInfo | undefined>();
    const tasks = new TaskServiceStub();
    tasks.add('bash-background', { wait: taskWait });
    const { handle, prompts } = handleWith(
      makeTurn({ type: 'completed', steps: 1, truncated: false }),
      messages,
      events,
      undefined,
      () => continuation,
      tasks,
    );
    const run = await runAgentTurn(handle, { kind: 'prompt', prompt: 'find it' }, { signal });
    let didSettle = false;
    void run.completion.then(
      () => { didSettle = true; },
      () => { didSettle = true; },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(didSettle).toBe(false);

    messages.push(assistant('src/a.ts:12'));
    continuation.resolve({ type: 'completed', steps: 1, truncated: false });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(didSettle).toBe(false);
    expect(tasks.waits).toEqual(['bash-background']);

    tasks.finish('bash-background');
    taskWait.resolve(undefined);
    await expect(run.completion).resolves.toMatchObject({ summary: 'src/a.ts:12' });
    expect(prompts).toHaveLength(1);

    events.emit(delta(1, ' late text'));
    expect(events.listenerCount()).toBe(0);
  });

  it('carries the loop stop reason alongside the handoff text', async () => {
    const { handle } = handleWith(
      makeTurn({ type: 'completed', steps: 13, truncated: false, stopReason: 'repeat_breaker' }),
      [assistant('Stuck: the same grep keeps returning nothing.')],
    );
    const run = await runAgentTurn(handle, { kind: 'prompt', prompt: 'find it' }, { signal });
    await expect(run.completion).resolves.toMatchObject({
      summary: 'Stuck: the same grep keeps returning nothing.',
      stopReason: 'repeat_breaker',
    });
  });

  it('fails with agent.no_final_message when the turn ends without text', async () => {
    const { handle } = handleWith(
      makeTurn({ type: 'completed', steps: 13, truncated: false, stopReason: 'repeat_breaker' }),
      [assistant('')],
    );
    const run = await runAgentTurn(handle, { kind: 'prompt', prompt: 'find it' }, { signal });
    const error = await rejection(run.completion);
    expect(isError2(error) && error.code).toBe(ErrorCodes.AGENT_NO_FINAL_MESSAGE);
    expect((error as Error).message).toContain('stop reason: repeat_breaker');
  });

  it('rewrites the step-cap failure into a model-facing message', async () => {
    const { handle } = handleWith(
      makeTurn({ type: 'failed', steps: 5, error: createMaxStepsExceededError(5) }),
      [assistant('partial work')],
    );
    const run = await runAgentTurn(handle, { kind: 'prompt', prompt: 'find it' }, { signal });
    const error = await rejection(run.completion);
    expect(isError2(error) && error.code).toBe(ErrorCodes.LOOP_MAX_STEPS_EXCEEDED);
    expect((error as Error).message).toContain('maxSteps=5');
    expect((error as Error).message).not.toContain('config.toml');
  });

  it('still reports max tokens as a failure', async () => {
    const { handle } = handleWith(
      makeTurn({ type: 'completed', steps: 1, truncated: true }),
      [assistant('cut off')],
    );
    const run = await runAgentTurn(handle, { kind: 'prompt', prompt: 'find it' }, { signal });
    const error = await rejection(run.completion);
    expect(isError2(error) && error.code).toBe(ErrorCodes.AGENT_MAX_TOKENS_EXCEEDED);
  });

  it('does not invent HTTP 429 when rebuilding a stream rate-limit failure', async () => {
    const failure = new Error2(ErrorCodes.PROVIDER_RATE_LIMIT, 'backend stream failure', {
      details: { requestId: 'req-stream' },
    });
    const { handle } = handleWith(makeTurn({ type: 'failed', steps: 1, error: failure }), [
      assistant('partial work'),
    ]);

    const run = await runAgentTurn(handle, { kind: 'prompt', prompt: 'find it' }, { signal });
    const error = await rejection(run.completion);

    expect(error).toMatchObject({
      name: 'APIProviderRateLimitError',
      message: 'backend stream failure',
      statusCode: undefined,
      requestId: 'req-stream',
    });
  });

  it('passes through a real HTTP 429 rate-limit error unchanged', async () => {
    const failure = Object.assign(
      new Error2(ErrorCodes.PROVIDER_RATE_LIMIT, 'backend HTTP failure', {
        details: { statusCode: 429, requestId: 'req-http' },
      }),
      { statusCode: 429 },
    );
    const events = new EventBusStub();
    const { handle, prompts } = handleWith(
      makeTurn({ type: 'completed', steps: 1, truncated: false }),
      [assistant('partial work')],
      events,
      async () => ({ type: 'failed', steps: 1, error: failure }),
    );
    let ready = false;
    const run = await runAgentTurn(handle, { kind: 'retry' }, {
      signal,
      onReady: () => {
        ready = true;
      },
    });
    events.emit(stepStarted(1, 'step-retry'));
    events.emit(delta(1, 'partial work'));
    const error = await rejection(run.completion);

    expect(error).toBe(failure);
    expect(error).toMatchObject({ statusCode: 429 });
    expect(prompts).toHaveLength(0);
    expect(run.turn).toBeUndefined();
    expect(ready).toBe(true);
    expect(run.partialOutput()).toBe('partial work');
  });
});

describe('runAgentTurn partial output', () => {
  const signal = new AbortController().signal;
  const cancelled: TurnResult = { type: 'cancelled', steps: 1, reason: userCancellationReason() };

  it('collects only the public text its own turn streamed, without reading the compactable context', async () => {
    const events = new EventBusStub();
    const { turn, finish } = pendingTurn(7);
    const launched = createControlledPromise<Turn>();
    const runPromise = runAgentTurn(
      handleWith(launched, [], events).handle,
      { kind: 'prompt', prompt: 'find it' },
      { signal },
    );
    events.emit(delta(6, 'text from another turn'));
    launched.resolve(turn);
    const run = await runPromise;

    events.emit(stepStarted(7, 'step-1'));
    events.emit(thinking(7, 'hidden reasoning'));
    events.emit(thinking(7, 'redacted reasoning', true));
    events.emit(delta(7, 'Found the loop '));
    events.emit(delta(7, 'at src/parser.ts:42.'));
    events.emit(stepStarted(7, 'step-2'));
    events.emit(delta(7, 'Drafting the report'));
    events.emit(delta(8, 'text from a later turn'));
    finish(cancelled);
    await rejection(run.completion);

    expect(run.partialOutput()).toBe('Found the loop at src/parser.ts:42.\n\nDrafting the report');
  });

  it('drops the text of a step attempt that is retried', async () => {
    const events = new EventBusStub();
    const { turn, finish } = pendingTurn(1);
    const run = await runAgentTurn(
      handleWith(turn, [], events).handle,
      { kind: 'prompt', prompt: 'find it' },
      { signal },
    );

    events.emit(stepStarted(1, 'step-1'));
    events.emit(delta(1, 'Checked the parser.'));
    events.emit(stepStarted(1, 'step-2', 2));
    events.emit(delta(1, 'The report starts'));
    events.emit(retrying(1));
    events.emit(stepStarted(1, 'step-3', 3));
    events.emit(delta(1, 'The report, retried'));
    finish({ type: 'failed', steps: 3, error: new Error('provider down') });
    await rejection(run.completion);

    expect(run.partialOutput()).toBe('Checked the parser.\n\nThe report, retried');
  });

  it('discards partial text on backoff and invalid-argument retries but keeps it on recovery retries', async () => {
    const events = new EventBusStub();
    const { turn, finish } = pendingTurn(1);
    const run = await runAgentTurn(
      handleWith(turn, [], events).handle,
      { kind: 'prompt', prompt: 'find it' },
      { signal },
    );

    events.emit(stepStarted(1, 'step-1'));
    events.emit(delta(1, 'Dropped on backoff.'));
    events.emit(retrying(1, 'backoff'));
    expect(run.partialOutput()).toBe('');

    events.emit(delta(1, 'Dropped on invalid arguments.'));
    events.emit(retrying(1, 'invalid_tool_arguments'));
    expect(run.partialOutput()).toBe('');

    events.emit(delta(1, 'Kept before recovery.'));
    events.emit(retrying(1, 'recovery'));
    expect(run.partialOutput()).toBe('Kept before recovery.');

    events.emit(delta(1, ' Final answer.'));
    finish(cancelled);
    await rejection(run.completion);

    expect(run.partialOutput()).toBe('Kept before recovery. Final answer.');
  });

  it('applies the same retry discard rules to retry-mode loop output', async () => {
    const events = new EventBusStub();
    const failure = new Error('retry exhausted');
    const { handle } = handleWith(
      makeTurn({ type: 'completed', steps: 1, truncated: false }),
      [assistant('done')],
      events,
      async () => ({ type: 'failed', steps: 1, error: failure }),
    );
    const run = await runAgentTurn(handle, { kind: 'retry' }, { signal });

    events.emit(stepStarted(1, 'step-1'));
    events.emit(delta(1, 'Dropped.'));
    events.emit(retrying(1, 'backoff'));
    expect(run.partialOutput()).toBe('');

    events.emit(delta(1, 'Kept on recovery.'));
    events.emit(retrying(1, 'recovery'));
    await rejection(run.completion);

    expect(run.partialOutput()).toBe('Kept on recovery.');
  });

  it('does not hand back text from an earlier run of the same agent', async () => {
    const events = new EventBusStub();
    const first = pendingTurn(1);
    const firstRun = await runAgentTurn(
      handleWith(first.turn, [assistant('Earlier answer.')], events).handle,
      { kind: 'prompt', prompt: 'find it' },
      { signal },
    );
    events.emit(stepStarted(1, 'step-1'));
    events.emit(delta(1, 'Earlier answer.'));
    first.finish({ type: 'completed', steps: 1, truncated: false });
    await expect(firstRun.completion).resolves.toMatchObject({ summary: 'Earlier answer.' });

    const second = pendingTurn(2);
    const secondRun = await runAgentTurn(
      handleWith(second.turn, [assistant('Earlier answer.')], events).handle,
      { kind: 'prompt', prompt: 'continue' },
      { signal },
    );
    events.emit(delta(1, 'late text from the earlier turn'));
    second.finish(cancelled);
    await rejection(secondRun.completion);

    expect(firstRun.partialOutput()).toBe('Earlier answer.');
    expect(secondRun.partialOutput()).toBe('');
  });

  it('keeps only the most recent text and never splits a code point', async () => {
    const events = new EventBusStub();
    const { turn, finish } = pendingTurn(1);
    const run = await runAgentTurn(
      handleWith(turn, [], events).handle,
      { kind: 'prompt', prompt: 'find it' },
      { signal },
    );

    events.emit(stepStarted(1, 'step-1'));
    events.emit(delta(1, 'oldest finding '));
    for (let index = 0; index < 50; index += 1) {
      events.emit(delta(1, '中文🔁'.repeat(500)));
    }
    events.emit(delta(1, ' newest finding'));
    finish(cancelled);
    await rejection(run.completion);

    const [marker, ...rest] = run.partialOutput().split('\n');
    const kept = rest.join('\n');
    expect(marker).toBe('[earlier text truncated]');
    expect(kept.length).toBeLessThanOrEqual(32 * 1024);
    expect(kept.endsWith(' newest finding')).toBe(true);
    expect(kept).not.toContain('oldest finding');
    expect(kept).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it('waits for task cleanup and loop unwinding before completing a cancellation', async () => {
    const continuation = createControlledPromise<TurnResult | undefined>();
    const taskStop = createControlledPromise<AgentTaskInfo | undefined>();
    const controller = new AbortController();
    const reason = userCancellationReason();
    const tasks = new TaskServiceStub();
    tasks.add('bash-background', { stop: taskStop });
    const { handle, cancellations, suppressions } = handleWith(
      makeTurn({ type: 'completed', steps: 1, truncated: false }),
      [assistant('')],
      new EventBusStub(),
      undefined,
      () => continuation,
      tasks,
    );
    const run = await runAgentTurn(handle, { kind: 'prompt', prompt: 'find it' }, {
      signal: controller.signal,
    });
    let didSettle = false;
    void run.completion.then(
      () => { didSettle = true; },
      () => { didSettle = true; },
    );

    controller.abort(reason);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(didSettle).toBe(false);
    expect(cancellations).toContainEqual({ target: undefined, reason });
    expect(suppressions).toContainEqual(['bash-background']);
    expect(tasks.stops).toEqual([{ taskId: 'bash-background', reason: reason.message }]);

    tasks.finish('bash-background');
    taskStop.resolve(undefined);
    continuation.resolve({ type: 'cancelled', steps: 1, reason });
    const error = await rejection(run.completion);
    expect(error).toBe(reason);
  });
});
