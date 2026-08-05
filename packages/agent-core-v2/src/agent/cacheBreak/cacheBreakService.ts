/**
 * `cacheBreak` domain — `IAgentCacheBreakService` implementation.
 *
 * Self-wiring plugin: its constructor subscribes to `usage`'s `onDidRecord`
 * event and keeps the previous turn record's usage and record time as the
 * per-agent baseline. `operation` records (e.g. compaction) clear the
 * baseline because a cache-read drop after them is expected; records without
 * a turn source are ignored entirely. When a turn record's `inputCacheRead`
 * falls below 95% of the baseline by more than `MIN_CACHE_BREAK_DROP_TOKENS`,
 * the service writes a debug entry through `log` and reports
 * `cache_break_detected` through `telemetry`. The baseline is registered into
 * `agentState` (`IAgentStateService`) and read/written through it.
 * Constructed eagerly at Agent scope so the subscription is installed without
 * any other service injecting it. Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { defineState } from '#/_base/state/stateRegistry';
import type { CacheBreakDetectedEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { TokenUsage } from '#/kosong/contract/usage';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentUsageService, type UsageRecordedContext } from '#/agent/usage/usage';

import { IAgentCacheBreakService, MIN_CACHE_BREAK_DROP_TOKENS } from './cacheBreak';

const CACHE_BREAK_DROP_RATIO = 0.95;

export interface CacheBreakBaseline {
  readonly usage: TokenUsage;
  readonly time: number;
}

export const cacheBreakBaselineKey = defineState<CacheBreakBaseline | undefined>(
  'cacheBreak.baseline',
  () => undefined as CacheBreakBaseline | undefined,
);

export class AgentCacheBreakService extends Disposable implements IAgentCacheBreakService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentUsageService usage: IAgentUsageService,
    @IAgentStateService private readonly states: IAgentStateService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.states.register(cacheBreakBaselineKey);
    this._register(
      usage.onDidRecord((ctx) => {
        this.observe(ctx);
      }),
    );
  }

  private get baseline(): CacheBreakBaseline | undefined {
    return this.states.get(cacheBreakBaselineKey);
  }

  private set baseline(value: CacheBreakBaseline | undefined) {
    this.states.set(cacheBreakBaselineKey, value);
  }

  private observe(ctx: UsageRecordedContext): void {
    const source = ctx.source;
    if (source?.type === 'operation') {
      this.baseline = undefined;
      return;
    }
    if (source?.type !== 'turn') return;

    const prev = this.baseline;
    const now = Date.now();
    if (prev !== undefined) {
      const prevCacheRead = prev.usage.inputCacheRead;
      const currCacheRead = ctx.usage.inputCacheRead;
      if (
        currCacheRead < prevCacheRead * CACHE_BREAK_DROP_RATIO &&
        prevCacheRead - currCacheRead > MIN_CACHE_BREAK_DROP_TOKENS
      ) {
        this.report(ctx, prev, now);
      }
    }
    this.baseline = { usage: { ...ctx.usage }, time: now };
  }

  private report(ctx: UsageRecordedContext, prev: CacheBreakBaseline, now: number): void {
    const dropRatio =
      (prev.usage.inputCacheRead - ctx.usage.inputCacheRead) / prev.usage.inputCacheRead;
    this.log.debug('cache break detected', {
      model: ctx.model,
      prevInputCacheRead: prev.usage.inputCacheRead,
      currInputCacheRead: ctx.usage.inputCacheRead,
      dropRatio,
    });
    const properties: CacheBreakDetectedEvent = {
      model: ctx.model,
      prev_input_cache_read: prev.usage.inputCacheRead,
      curr_input_cache_read: ctx.usage.inputCacheRead,
      prev_input_other: prev.usage.inputOther,
      curr_input_other: ctx.usage.inputOther,
      prev_output: prev.usage.output,
      curr_output: ctx.usage.output,
      prev_input_cache_creation: prev.usage.inputCacheCreation,
      curr_input_cache_creation: ctx.usage.inputCacheCreation,
      cache_read_drop_ratio: dropRatio,
      interval_ms: now - prev.time,
    };
    this.telemetry.track2('cache_break_detected', properties);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentCacheBreakService,
  AgentCacheBreakService,
  ScopeActivation.OnScopeCreated,
  'cacheBreak',
);
