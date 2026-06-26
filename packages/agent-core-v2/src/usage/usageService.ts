/**
 * `usage` domain (L4) — `IUsageService` implementation.
 *
 * Accumulates per-agent token totals; records usage through `records` and
 * reports through `telemetry`. Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentRecords } from '#/records/records';
import { ITelemetryService } from '#/telemetry/telemetry';

import { type UsageTotals, IUsageService } from './usage';

export class UsageService extends Disposable implements IUsageService {
  declare readonly _serviceBrand: undefined;
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(
    @IAgentRecords _records: IAgentRecords,
    @ITelemetryService _telemetry: ITelemetryService,
  ) {
    super();
  }

  get totals(): UsageTotals {
    return { inputTokens: this.inputTokens, outputTokens: this.outputTokens };
  }

  record(inputTokens: number, outputTokens: number): void {
    this.inputTokens += inputTokens;
    this.outputTokens += outputTokens;
  }
}

registerScopedService(LifecycleScope.Agent, IUsageService, UsageService, InstantiationType.Delayed, 'usage');
