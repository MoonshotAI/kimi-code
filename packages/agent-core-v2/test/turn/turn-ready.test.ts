import { createControlledPromise } from '@antfu/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentLoopService } from '#/agent/loop/loop';
import { AgentLoopService } from '#/agent/loop/loopService';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentTurnService } from '#/agent/turn/turn';
import { AgentTurnService } from '#/agent/turn/turnService';
import { TurnModel } from '#/agent/turn/turnOps';
import { IAgentUsageService } from '#/agent/usage/usage';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { emptyUsage } from '#/app/llmProtocol/usage';
import { ILogService } from '#/_base/log/log';
import { IAgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContext';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ErrorCodes, KimiError } from '#/errors';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentWireService } from '#/wire/tokens';
import type { PersistedRecord } from '#/wire/wireService';
import { WireService } from '#/wire/wireServiceImpl';

import { stubContextMemory } from '../contextMemory/stubs';
import { stubLog } from '../log/stubs';
import { recordingTelemetry } from '../telemetry/stubs';
import { stubLoopWithHooks, stubToolExecutor } from './stubs';

const noopEventBus: IEventBus = {
  _serviceBrand: undefined,
  publish: () => {},
  subscribe: () => ({ dispose: () => {} }),
};

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
        reg.defineInstance(IAgentContextMemoryService, stubContextMemory());
        reg.defineInstance(ITelemetryService, recordingTelemetry([]));
        reg.defineInstance(IAgentTelemetryContextService, {
          _serviceBrand: undefined,
          get: () => ({ mode: 'agent' }),
          set: () => {},
        });
        reg.defineInstance(
          IAgentWireService,
          disposables.add(new WireService({ logScope: 'wire', logKey: 'turn-ready' })),
        );
        reg.defineInstance(IEventBus, noopEventBus);
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

  it('records turn.cancel when cancelling the active turn', async () => {
    const records: PersistedRecord[] = [];
    disposables.add(
      ix.get(IAgentWireService).onEmission((emission) => {
        records.push(emission.record);
      }),
    );
    loop.run = async ({ signal }) => {
      await new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { reason: 'cancelled', steps: 0 };
    };

    const turnService = ix.get(IAgentTurnService);
    const turn = turnService.launch({
      input: [{ type: 'text', text: 'cancel me' }],
      origin: { kind: 'user' },
    });

    expect(turnService.cancel(turn.id)).toBe(true);
    await expect(turn.result).resolves.toMatchObject({ reason: 'cancelled', steps: 0 });
    expect(records.map((record) => record.type)).toEqual(['turn.prompt', 'turn.cancel']);
    expect(records[1]).toEqual({ type: 'turn.cancel', turnId: turn.id });
  });

  it('records turn.cancel for an idle no-op cancellation', () => {
    const records: PersistedRecord[] = [];
    disposables.add(
      ix.get(IAgentWireService).onEmission((emission) => {
        records.push(emission.record);
      }),
    );

    const turnService = ix.get(IAgentTurnService);

    expect(turnService.cancel(99)).toBe(false);
    expect(records).toEqual([{ type: 'turn.cancel', turnId: 99 }]);
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
        reg.defineInstance(IAgentToolExecutorService, stubToolExecutor());
        reg.defineInstance(IAgentUsageService, {
          _serviceBrand: undefined,
          record: () => {},
          status: () => ({}),
        });
        reg.definePartialInstance(IConfigService, {
          get: <T>() => undefined as T,
        });
        reg.defineInstance(ILogService, stubLog());
        reg.defineInstance(
          IAgentWireService,
          disposables.add(new WireService({ logScope: 'wire', logKey: 'turn-ready-onstarted' })),
        );
        reg.defineInstance(IEventBus, noopEventBus);
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


const WIRE_SCOPE = 'wire';
const WIRE_KEY = 'turn-state-test';

describe('AgentTurnService wire state', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let log: IAppendLogStore;
  let turnService: IAgentTurnService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IAgentWireService, new SyncDescriptor(WireService, [{ logScope: WIRE_SCOPE, logKey: WIRE_KEY }]));
    ix.stub(IAgentLoopService, stubLoopWithHooks());
    ix.stub(ITelemetryService, recordingTelemetry([]));
    ix.stub(IAgentTelemetryContextService, {
      _serviceBrand: undefined,
      get: () => ({ mode: 'agent' }),
      set: () => {},
    });
    ix.stub(IEventBus, noopEventBus);
    ix.set(IAgentTurnService, new SyncDescriptor(AgentTurnService));
    log = ix.get(IAppendLogStore);
    turnService = ix.get(IAgentTurnService);
  });

  afterEach(() => disposables.dispose());

  async function readRecords(): Promise<PersistedRecord[]> {
    const out: PersistedRecord[] = [];
    for await (const record of log.read<PersistedRecord>(WIRE_SCOPE, WIRE_KEY)) {
      out.push(record);
    }
    return out;
  }

  it('launch allocates sequential ids from the wire model', () => {
    const first = turnService.launch();
    expect(first.id).toBe(0);
    expect(ix.get(IAgentWireService).getModel(TurnModel)).toEqual({ nextTurnId: 1 });
  });

  it('dispatch persists a flat { type, turnId } record (no payload key)', async () => {
    turnService.launch();

    const records = await readRecords();
    expect(records).toEqual([{ type: 'turn.prompt', turnId: 0 }]);
    expect('payload' in records[0]!).toBe(false);
  });

  it('replay rebuilds nextTurnId from a persisted record on a fresh WireService (silent)', async () => {
    turnService.launch();
    const records = await readRecords();

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix2.set(
      IAgentWireService,
      new SyncDescriptor(WireService, [{ logScope: WIRE_SCOPE, logKey: 'turn-state-replay' }]),
    );
    const log2 = ix2.get(IAppendLogStore);
    const fresh = ix2.get(IAgentWireService);

    void fresh.replay(...records);

    // nextTurnId advances past the replayed turnId (0 -> 1).
    expect(fresh.getModel(TurnModel)).toEqual({ nextTurnId: 1 });

    // Replay is silent: nothing is written back to the wire log.
    const written: PersistedRecord[] = [];
    for await (const record of log2.read<PersistedRecord>(WIRE_SCOPE, 'turn-state-replay')) {
      written.push(record);
    }
    expect(written).toEqual([]);
  });
});
