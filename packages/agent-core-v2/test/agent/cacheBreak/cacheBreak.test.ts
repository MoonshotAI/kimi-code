import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { Emitter, type Event } from '#/_base/event';
import { ILogService, type LogPayload } from '#/_base/log/log';
import {
  IAgentCacheBreakService,
  MIN_CACHE_BREAK_DROP_TOKENS,
} from '#/agent/cacheBreak/cacheBreak';
import { AgentCacheBreakService } from '#/agent/cacheBreak/cacheBreakService';
import type { AgentLLMRequestSource } from '#/agent/llmRequester/llmRequester';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import {
  IAgentUsageService,
  type UsageRecordedContext,
  type UsageStatus,
} from '#/agent/usage/usage';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { TokenUsage } from '#/kosong/contract/usage';

import { stubLog } from '../../_base/log/stubs';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';

class FakeAgentUsageService implements IAgentUsageService {
  declare readonly _serviceBrand: undefined;

  private readonly emitter = new Emitter<UsageRecordedContext>();
  readonly onDidRecord: Event<UsageRecordedContext> = this.emitter.event;

  record(model: string, usage: TokenUsage, source?: AgentLLMRequestSource): void {
    this.emitter.fire({ model, usage, source });
  }

  status(): UsageStatus {
    return {};
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function usage(inputCacheRead: number): TokenUsage {
  return { inputOther: 100, output: 50, inputCacheRead, inputCacheCreation: 0 };
}

let disposables: DisposableStore;
let ix: TestInstantiationService;
let usageService: FakeAgentUsageService;
let telemetryEvents: TelemetryRecord[];
let debugLogs: { readonly message: string; readonly payload?: LogPayload }[];

beforeEach(() => {
  disposables = new DisposableStore();
  telemetryEvents = [];
  debugLogs = [];
  usageService = new FakeAgentUsageService();
  const log = {
    ...stubLog(),
    debug(message: string, payload?: LogPayload) {
      debugLogs.push({ message, payload });
    },
  };
  ix = createServices(disposables, {
    additionalServices: (reg) => {
      reg.defineInstance(ILogService, log);
      reg.defineInstance(IAgentUsageService, usageService);
      reg.defineInstance(IAgentStateService, new AgentStateService());
      reg.defineInstance(ITelemetryService, recordingTelemetry(telemetryEvents));
      reg.define(IAgentCacheBreakService, AgentCacheBreakService);
    },
    strict: true,
  });
  ix.get(IAgentCacheBreakService);
});

afterEach(() => {
  vi.useRealTimers();
  disposables.dispose();
});

describe('AgentCacheBreakService', () => {
  it('does not judge the first turn record after the baseline reset', () => {
    usageService.record('model-a', usage(10000), { type: 'turn', turnId: 1 });

    expect(telemetryEvents).toEqual([]);
    expect(debugLogs).toEqual([]);
  });

  it('emits cache_break_detected when the drop passes the ratio and token gates', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    usageService.record(
      'model-a',
      { inputOther: 200, output: 80, inputCacheRead: 10000, inputCacheCreation: 300 },
      { type: 'turn', turnId: 1, step: 0 },
    );
    vi.setSystemTime(1_001_500);
    usageService.record(
      'model-a',
      { inputOther: 500, output: 120, inputCacheRead: 7000, inputCacheCreation: 100 },
      { type: 'turn', turnId: 2, step: 0 },
    );

    expect(telemetryEvents).toEqual([
      {
        event: 'cache_break_detected',
        properties: {
          model: 'model-a',
          prev_input_cache_read: 10000,
          curr_input_cache_read: 7000,
          prev_input_other: 200,
          curr_input_other: 500,
          prev_output: 80,
          curr_output: 120,
          prev_input_cache_creation: 300,
          curr_input_cache_creation: 100,
          cache_read_drop_ratio: 0.3,
          interval_ms: 1500,
        },
      },
    ]);
    expect(debugLogs).toEqual([
      {
        message: 'cache break detected',
        payload: {
          model: 'model-a',
          prevInputCacheRead: 10000,
          currInputCacheRead: 7000,
          dropRatio: 0.3,
        },
      },
    ]);
  });

  it('does not emit when the drop stays within the 5% ratio gate', () => {
    usageService.record('model-a', usage(100000), { type: 'turn', turnId: 1 });
    usageService.record('model-a', usage(96000), { type: 'turn', turnId: 2 });

    expect(telemetryEvents).toEqual([]);
    expect(debugLogs).toEqual([]);
  });

  it('does not emit when the token drop does not exceed the threshold', () => {
    usageService.record('model-a', usage(MIN_CACHE_BREAK_DROP_TOKENS * 2), {
      type: 'turn',
      turnId: 1,
    });
    usageService.record('model-a', usage(MIN_CACHE_BREAK_DROP_TOKENS), {
      type: 'turn',
      turnId: 2,
    });

    expect(telemetryEvents).toEqual([]);
  });

  it('clears the baseline on operation records so the next turn record is not judged', () => {
    usageService.record('model-a', usage(10000), { type: 'turn', turnId: 1 });
    usageService.record('model-a', usage(10000), {
      type: 'operation',
      requestKind: 'full_compaction',
    });
    usageService.record('model-a', usage(9000), { type: 'turn', turnId: 2 });

    expect(telemetryEvents).toEqual([]);

    usageService.record('model-a', usage(100), { type: 'turn', turnId: 3 });

    expect(telemetryEvents).toHaveLength(1);
    expect(telemetryEvents[0]?.properties).toMatchObject({
      prev_input_cache_read: 9000,
      curr_input_cache_read: 100,
    });
  });

  it('ignores records without a source', () => {
    usageService.record('model-a', usage(10000), { type: 'turn', turnId: 1 });
    usageService.record('model-a', usage(100));
    usageService.record('model-a', usage(5000), { type: 'turn', turnId: 2 });

    expect(telemetryEvents).toHaveLength(1);
    expect(telemetryEvents[0]?.properties).toMatchObject({
      prev_input_cache_read: 10000,
      curr_input_cache_read: 5000,
    });
  });

  it('ignores unmeasured all-zero records without touching the baseline', () => {
    usageService.record('model-a', usage(10000), { type: 'turn', turnId: 1 });
    usageService.record(
      'model-a',
      { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
      { type: 'turn', turnId: 2 },
    );

    // Zeros are not a measurement: no break report against the cached baseline.
    expect(telemetryEvents).toEqual([]);

    // The baseline survived the unmeasured record, so a later real drop is
    // still judged against the last measured one.
    usageService.record('model-a', usage(5000), { type: 'turn', turnId: 3 });
    expect(telemetryEvents).toHaveLength(1);
    expect(telemetryEvents[0]?.properties).toMatchObject({
      prev_input_cache_read: 10000,
      curr_input_cache_read: 5000,
    });
  });

  it('resets the baseline when the model changes', () => {
    usageService.record('model-a', usage(10000), { type: 'turn', turnId: 1 });
    // A model switch makes cache reads incomparable — no cross-model report.
    usageService.record('model-b', usage(100), { type: 'turn', turnId: 2 });
    expect(telemetryEvents).toEqual([]);

    usageService.record('model-b', usage(10000), { type: 'turn', turnId: 3 });
    usageService.record('model-b', usage(5000), { type: 'turn', turnId: 4 });
    // The baseline is model-b's own record now, not model-a's.
    expect(telemetryEvents).toHaveLength(1);
    expect(telemetryEvents[0]?.properties).toMatchObject({
      model: 'model-b',
      prev_input_cache_read: 10000,
      curr_input_cache_read: 5000,
    });
  });
});
