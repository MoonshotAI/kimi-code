import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { createDecorator } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IntervalTimer } from '#/_base/utils/timer';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';

const SAMPLE_INTERVAL_MS = 1_000;
const SUMMARY_EVERY_TICKS = 60;
const STALL_WARN_MS = 250;
const ENABLE_ENV = 'KIMI_CODE_EVENT_LOOP_MONITOR';

export const IEventLoopMonitorService =
  createDecorator<EventLoopMonitorService>('eventLoopMonitor');

export class EventLoopMonitorService extends Disposable {
  declare readonly _serviceBrand: undefined;

  private readonly timer = this._register(new IntervalTimer({ unref: true }));
  private readonly histogram: IntervalHistogram | undefined;
  private ticks = 0;

  constructor(
    @IBootstrapService bootstrap: IBootstrapService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    if (bootstrap.getEnv(ENABLE_ENV) === undefined) return;
    this.histogram = monitorEventLoopDelay({ resolution: 20 });
    this.histogram.enable();
    this.timer.cancelAndSet(() => this.sample(), SAMPLE_INTERVAL_MS);
  }

  private sample(): void {
    const histogram = this.histogram;
    if (histogram === undefined) return;
    this.ticks += 1;
    const maxMs = histogram.max / 1e6;
    if (maxMs >= STALL_WARN_MS) {
      this.log.warn('event loop stall detected', {
        maxMs: Math.round(maxMs),
        p99Ms: Math.round(histogram.percentile(99) / 1e6),
        p50Ms: Math.round(histogram.percentile(50) / 1e6),
      });
    }
    if (this.ticks % SUMMARY_EVERY_TICKS === 0) {
      this.log.info('event loop delay summary', {
        p50Ms: Math.round(histogram.percentile(50) / 1e6),
        p90Ms: Math.round(histogram.percentile(90) / 1e6),
        p99Ms: Math.round(histogram.percentile(99) / 1e6),
        maxMs: Math.round(histogram.max / 1e6),
      });
    }
    histogram.reset();
  }
}

registerScopedService(
  LifecycleScope.App,
  IEventLoopMonitorService,
  EventLoopMonitorService,
  ScopeActivation.OnScopeCreated,
  'diagnostics',
);
