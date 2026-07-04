import { createControlledPromise } from '@antfu/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory';
import { AgentLoopService, IAgentLoopService } from '#/agent/loop';
import { IAgentLLMRequesterService } from '#/agent/llmRequester';
import { IAgentRecordService } from '#/agent/record';
import { IAgentToolExecutorService } from '#/agent/toolExecutor';
import { AgentTurnService, IAgentTurnService } from '#/agent/turn';
import { IConfigService } from '#/app/config';
import { emptyUsage } from '#/app/llmProtocol';
import { ILogService } from '#/app/log';
import { IAgentTelemetryContextService, ITelemetryService } from '#/app/telemetry';
import { ErrorCodes, KimiError } from '#/errors';

import { stubContextMemory, stubRecord } from '../contextMemory/stubs';
import { stubLog } from '../log/stubs';
import { recordingTelemetry } from '../telemetry/stubs';
import { stubLoopWithHooks, stubToolExecutor } from './stubs';

describe('AgentTurnService ready', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let loop: IAgentLoopService;

  beforeEach(() => {
    disposables = new DisposableStore();
    loop = stubLoopWithHooks();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IAgentLoopService, loop);
        reg.defineInstance(IAgentRecordService, stubRecord());
        reg.defineInstance(IAgentContextMemoryService, stubContextMemory());
        reg.defineInstance(ITelemetryService, recordingTelemetry([]));
        reg.defineInstance(IAgentTelemetryContextService, {
          _serviceBrand: undefined,
          get: () => ({ mode: 'agent' }),
          set: () => {},
        });
        reg.define(IAgentTurnService, AgentTurnService);
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('resolves after the first step response event and before the turn ends', async () => {
    const events: string[] = [];
    const beforeStepDone = createControlledPromise<void>();
    const responseEvent = createControlledPromise<void>();
    const release = createControlledPromise<void>();
    let readySettled = false;
    loop.hooks.beforeStep.register('test-before-step', async (_ctx, next) => {
      events.push('before');
      await next();
      events.push('after');
      beforeStepDone.resolve();
    });
    loop.run = async (options) => {
      events.push('loop');
      const { turnId, signal = new AbortController().signal } = options;
      await loop.hooks.beforeStep.run({ turnId, step: 1, signal });
      await responseEvent;
      events.push('response');
      options.onStarted?.(1);
      await release;
      events.push('done');
      return { reason: 'completed', steps: 1 };
    };

    const turn = ix.get(IAgentTurnService).launch();
    void turn.ready.then(
      () => {
        readySettled = true;
      },
      () => {
        readySettled = true;
      },
    );

    await beforeStepDone;
    await Promise.resolve();
    expect(readySettled).toBe(false);

    responseEvent.resolve();
    await turn.ready;

    expect(events).toEqual(['loop', 'before', 'after', 'response']);

    release.resolve();
    await expect(turn.result).resolves.toMatchObject({ reason: 'completed', steps: 1 });
    expect(events).toEqual(['loop', 'before', 'after', 'response', 'done']);
  });

  it('rejects with an Error when the turn ends before the first step starts', async () => {
    const cause = new Error('loop failed before first step');
    loop.run = async () => ({ reason: 'failed', error: cause, steps: 0 });

    const turn = ix.get(IAgentTurnService).launch();
    let readyError: unknown;
    await turn.ready.catch((error: unknown) => {
      readyError = error;
    });

    expect(readyError).toBeInstanceOf(Error);
    expect((readyError as Error).message).toBe('Turn ended before first step');
    expect((readyError as Error).cause).toBe(cause);
    await expect(turn.result).resolves.toMatchObject({ reason: 'failed', error: cause });
  });

  it('throws a KimiError when launching while a turn is active', async () => {
    const release = createControlledPromise<void>();
    loop.run = async () => {
      await release;
      return { reason: 'completed', steps: 1 };
    };

    const turnService = ix.get(IAgentTurnService);
    const turn = turnService.launch();
    let error: unknown;
    try {
      turnService.launch();
    } catch (caught) {
      error = caught;
    } finally {
      release.resolve();
    }

    expect(error).toBeInstanceOf(KimiError);
    expect(error).toMatchObject({
      code: ErrorCodes.TURN_AGENT_BUSY,
      details: { turnId: turn.id },
    });
    await expect(turn.result).resolves.toMatchObject({ reason: 'completed', steps: 1 });
  });
});

describe('AgentLoopService onStarted', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IAgentContextMemoryService, stubContextMemory());
        reg.defineInstance(IAgentRecordService, stubRecord());
        reg.defineInstance(IAgentToolExecutorService, stubToolExecutor());
        reg.definePartialInstance(IConfigService, {
          get: <T>() => undefined as T,
        });
        reg.defineInstance(ILogService, stubLog());
        reg.define(IAgentLoopService, AgentLoopService);
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('fires on the first streamed response event', async () => {
    const requestStarted = createControlledPromise<void>();
    const responseEvent = createControlledPromise<void>();
    const release = createControlledPromise<void>();
    const stepStarted = createControlledPromise<void>();
    let started = false;

    ix.set(IAgentLLMRequesterService, {
      _serviceBrand: undefined,
      async request(_overrides, onPart) {
        requestStarted.resolve();
        await responseEvent;
        await onPart?.({ type: 'text', text: 'streamed' });
        await release;
        return {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            toolCalls: [],
          },
          usage: emptyUsage(),
          model: 'mock-model',
        };
      },
    });

    const result = ix.get(IAgentLoopService).run({
      turnId: 1,
      onStarted: (step) => {
        expect(step).toBe(1);
        started = true;
        stepStarted.resolve();
      },
    });

    await requestStarted;
    await Promise.resolve();
    expect(started).toBe(false);

    responseEvent.resolve();
    await stepStarted;
    expect(started).toBe(true);

    release.resolve();
    await expect(result).resolves.toMatchObject({ reason: 'completed', steps: 1 });
  });

  it('fires at step completion when no response event is streamed', async () => {
    const requestStarted = createControlledPromise<void>();
    const release = createControlledPromise<void>();
    const stepStarted = createControlledPromise<void>();
    let started = false;

    ix.set(IAgentLLMRequesterService, {
      _serviceBrand: undefined,
      async request() {
        requestStarted.resolve();
        await release;
        return {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            toolCalls: [],
          },
          usage: emptyUsage(),
          model: 'mock-model',
        };
      },
    });

    const result = ix.get(IAgentLoopService).run({
      turnId: 1,
      onStarted: (step) => {
        expect(step).toBe(1);
        started = true;
        stepStarted.resolve();
      },
    });

    await requestStarted;
    await Promise.resolve();
    expect(started).toBe(false);

    release.resolve();
    await stepStarted;
    expect(started).toBe(true);
    await expect(result).resolves.toMatchObject({ reason: 'completed', steps: 1 });
  });

  it('does not fire when the requester fails before the first response event', async () => {
    const cause = new Error('429');
    let started = false;

    ix.set(IAgentLLMRequesterService, {
      _serviceBrand: undefined,
      request: async () => {
        throw cause;
      },
    });

    await expect(
      ix.get(IAgentLoopService).run({
        turnId: 1,
        onStarted: () => {
          started = true;
        },
      }),
    ).resolves.toMatchObject({ reason: 'failed', error: cause, steps: 1 });
    expect(started).toBe(false);
  });
});
