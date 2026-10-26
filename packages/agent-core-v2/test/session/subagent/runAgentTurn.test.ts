import { createControlledPromise } from '@antfu/utils';
import { describe, expect, it } from 'vitest';

import type { IAgentScopeHandle } from '#/_base/di/scope';
import { userCancellationReason } from '#/_base/utils/abort';
import { IEventBus } from '#/app/event/eventBus';
import type { Event2 } from '#/app/event/event2';
import { LifecycleScope } from '#/app/scopes';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import {
  createMaxStepsExceededError,
  IAgentLoopService,
  type Turn,
  type TurnResult,
} from '#/agent/loop/loop';
import {
  AssistantDelta,
  ThinkingDelta,
  TurnStepRetrying,
  TurnStepStarted,
} from '#/agent/loop/turnEvents';
import { ErrorCodes, isError2 } from '#/errors';
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

function stepStarted(turnId: number, stepId: string): TurnStepStarted {
  return new TurnStepStarted({ agentId: 'agent-child', turnId, step: 1, stepId });
}

function delta(turnId: number, text: string): AssistantDelta {
  return new AssistantDelta({ agentId: 'agent-child', turnId, delta: text });
}

function retrying(turnId: number, stepId: string): TurnStepRetrying {
  return new TurnStepRetrying({
    agentId: 'agent-child',
    turnId,
    step: 1,
    stepId,
    failedAttempt: 1,
    nextAttempt: 2,
    maxAttempts: 3,
    delayMs: 0,
    errorName: 'APIConnectionError',
    errorMessage: 'connection reset',
  });
}

function handleWith(
  turn: Turn | Promise<Turn>,
  messages: readonly ContextMessage[],
  events = new EventBusStub(),
): { readonly handle: IAgentScopeHandle; readonly prompts: unknown[] } {
  const prompts: unknown[] = [];
  const services = new Map<unknown, unknown>([
    [
      IAgentLoopService,
      {
        submit: (input: unknown) => {
          prompts.push(input);
          return { id: 'p' };
        },
        promptHandle: () => ({ launched: Promise.resolve(turn) }),
        cancel: () => true,
      },
    ],
    [IAgentContextMemoryService, { get: () => messages }],
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
  return { handle, prompts };
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

  it('returns a short final message as is without a continuation prompt', async () => {
    const { handle, prompts } = handleWith(
      makeTurn({ type: 'completed', steps: 1, truncated: false }),
      [assistant('src/a.ts:12')],
    );
    const run = await runAgentTurn(handle, { kind: 'prompt', prompt: 'find it' }, { signal });
    await expect(run.completion).resolves.toMatchObject({ summary: 'src/a.ts:12' });
    expect(prompts).toHaveLength(1);
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
    events.emit(new ThinkingDelta({ agentId: 'agent-child', turnId: 7, delta: 'hidden reasoning' }));
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
    events.emit(stepStarted(1, 'step-2'));
    events.emit(delta(1, 'The report starts'));
    events.emit(retrying(1, 'step-2'));
    events.emit(stepStarted(1, 'step-3'));
    events.emit(delta(1, 'The report, retried'));
    finish({ type: 'failed', steps: 3, error: new Error('provider down') });
    await rejection(run.completion);

    expect(run.partialOutput()).toBe('Checked the parser.\n\nThe report, retried');
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

  it('stops listening once the run settles', async () => {
    const events = new EventBusStub();
    const { turn, finish } = pendingTurn(1);
    const run = await runAgentTurn(
      handleWith(turn, [assistant('Done.')], events).handle,
      { kind: 'prompt', prompt: 'find it' },
      { signal },
    );
    expect(events.listenerCount()).toBe(3);

    events.emit(delta(1, 'Done.'));
    finish({ type: 'completed', steps: 1, truncated: false });
    await run.completion;
    events.emit(delta(1, ' late text'));

    expect(events.listenerCount()).toBe(0);
    expect(run.partialOutput()).toBe('Done.');
  });
});
