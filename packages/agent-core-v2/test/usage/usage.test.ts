import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toDisposable } from '#/_base/di';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { OrderedHookSlot } from '#/hooks';
import { IAgentEventSinkService } from '#/agent/eventSink';
import { IAgentReplayBuilderService } from '#/agent/replayBuilder';
import { AgentRecordService, IAgentRecordService } from '#/agent/record';
import { IAgentUsageService, type UsageStatus } from '#/agent/usage';
import { AgentUsageService } from '#/agent/usage/usageService';
import { IAgentWireRecordService, type WireRecord } from '#/agent/wireRecord';
import type { WireRecordRestoredContext } from '#/agent/wireRecord';

let disposables: DisposableStore;

beforeEach(() => {
  disposables = new DisposableStore();
});

afterEach(() => {
  disposables.dispose();
});

describe('AgentUsageService', () => {
  it('resolves by interface and accumulates usage by model', () => {
    const { usage, records } = createUsageHarness();

    usage.record('model-a', {
      inputOther: 1,
      output: 2,
      inputCacheRead: 3,
      inputCacheCreation: 4,
    });
    usage.record('model-a', {
      inputOther: 10,
      output: 20,
      inputCacheRead: 30,
      inputCacheCreation: 40,
    });
    usage.record('model-b', {
      inputOther: 100,
      output: 200,
      inputCacheRead: 300,
      inputCacheCreation: 400,
    });

    expect(usage.status()).toEqual({
      byModel: {
        'model-a': {
          inputOther: 11,
          output: 22,
          inputCacheRead: 33,
          inputCacheCreation: 44,
        },
        'model-b': {
          inputOther: 100,
          output: 200,
          inputCacheRead: 300,
          inputCacheCreation: 400,
        },
      },
      total: {
        inputOther: 111,
        output: 222,
        inputCacheRead: 333,
        inputCacheCreation: 444,
      },
      currentTurn: undefined,
    });
    expect(records.map((record) => record.type)).toEqual([
      'usage.record',
      'usage.record',
      'usage.record',
    ]);
  });

  it('tracks current turn usage by turn id', () => {
    const { usage } = createUsageHarness();

    usage.record('model-a', {
      inputOther: 1,
      output: 2,
      inputCacheRead: 3,
      inputCacheCreation: 4,
    });
    usage.record(
      'model-a',
      {
        inputOther: 10,
        output: 20,
        inputCacheRead: 30,
        inputCacheCreation: 40,
      },
      { type: 'turn', turnId: 1 },
    );
    usage.record(
      'model-b',
      {
        inputOther: 100,
        output: 200,
        inputCacheRead: 300,
        inputCacheCreation: 400,
      },
      { type: 'turn', turnId: 1 },
    );

    expect(usage.status()).toMatchObject({
      total: {
        inputOther: 111,
        output: 222,
        inputCacheRead: 333,
        inputCacheCreation: 444,
      },
      currentTurn: {
        inputOther: 110,
        output: 220,
        inputCacheRead: 330,
        inputCacheCreation: 440,
      },
    });

    usage.record(
      'model-a',
      {
        inputOther: 5,
        output: 6,
        inputCacheRead: 7,
        inputCacheCreation: 8,
      },
      { type: 'turn', turnId: 2 },
    );

    expect(usage.status().currentTurn).toEqual({
      inputOther: 5,
      output: 6,
      inputCacheRead: 7,
      inputCacheCreation: 8,
    });
  });

  it('returns immutable status snapshots', () => {
    const { usage } = createUsageHarness();

    usage.record('model-a', {
      inputOther: 1,
      output: 2,
      inputCacheRead: 3,
      inputCacheCreation: 4,
    });
    const snapshot = usage.status();

    usage.record('model-a', {
      inputOther: 10,
      output: 20,
      inputCacheRead: 30,
      inputCacheCreation: 40,
    });

    expect(snapshot).toEqual({
      byModel: {
        'model-a': {
          inputOther: 1,
          output: 2,
          inputCacheRead: 3,
          inputCacheCreation: 4,
        },
      },
      total: {
        inputOther: 1,
        output: 2,
        inputCacheRead: 3,
        inputCacheCreation: 4,
      },
      currentTurn: undefined,
    });
  });

  it('publishes usage status changes through the event sink', () => {
    const { usage, events } = createUsageHarness();

    usage.record('model-a', {
      inputOther: 1,
      output: 2,
      inputCacheRead: 3,
      inputCacheCreation: 4,
    });

    expect(events).toEqual([
      {
        type: 'agent.status.updated',
        usage: {
          byModel: {
            'model-a': {
              inputOther: 1,
              output: 2,
              inputCacheRead: 3,
              inputCacheCreation: 4,
            },
          },
          total: {
            inputOther: 1,
            output: 2,
            inputCacheRead: 3,
            inputCacheCreation: 4,
          },
          currentTurn: undefined,
        } satisfies UsageStatus,
      },
    ]);
  });
});

function createUsageHarness(): {
  readonly ix: TestInstantiationService;
  readonly usage: IAgentUsageService;
  readonly records: WireRecord[];
  readonly events: unknown[];
} {
  const records: WireRecord[] = [];
  const events: unknown[] = [];
  const ix = createServices(disposables, {
    strict: true,
    additionalServices: (reg) => {
      reg.definePartialInstance(IAgentWireRecordService, {
        restoring: null,
        postRestoring: false,
        hooks: {
          onRestoredRecord: new OrderedHookSlot<WireRecordRestoredContext>(),
          onResumeEnded: new OrderedHookSlot<{}>(),
        },
        append: (record) => {
          records.push(record);
        },
        register: () => toDisposable(() => {}),
        restore: async () => ({}),
        flush: async () => {},
        close: async () => {},
      });
      reg.definePartialInstance(IAgentEventSinkService, {
        emit: (event) => {
          events.push(event);
        },
        on: () => toDisposable(() => {}),
      });
      reg.definePartialInstance(IAgentReplayBuilderService, {
        push: () => {},
        buildResult: () => [],
        captureLiveRecords: false,
        postRestoring: false,
      });
      reg.define(IAgentRecordService, AgentRecordService);
      reg.define(IAgentUsageService, AgentUsageService);
    },
  });

  return {
    ix,
    usage: ix.get(IAgentUsageService),
    records,
    events,
  };
}
