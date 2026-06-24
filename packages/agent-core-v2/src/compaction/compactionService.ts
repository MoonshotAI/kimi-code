/**
 * `compaction` domain (L4) — `ICompactionService` implementation.
 *
 * Subscribes to `ITurnService.onDidEndStep`; when the context's token usage
 * exceeds the threshold, it pushes a `compaction_summary` injection via
 * `IInjectionService` (the actual summarisation is a later step).
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentConfigService } from '#/config/config';
import { IContextService } from '#/context/context';
import { IInjectionService } from '#/injection/injection';
import { IAgentRecords } from '#/records/records';
import { ITelemetryService } from '#/telemetry/telemetry';
import { ITurnService } from '#/turn/turn';

import { ICompactionService } from './compaction';

const DEFAULT_TOKEN_THRESHOLD = 8_000;

export class CompactionService extends Disposable implements ICompactionService {
  declare readonly _serviceBrand: undefined;
  private readonly threshold: number;

  constructor(
    @IContextService private readonly context: IContextService,
    @IAgentConfigService _agentConfig: IAgentConfigService,
    @IAgentRecords _records: IAgentRecords,
    @ITelemetryService _telemetry: ITelemetryService,
    @ITurnService turn: ITurnService,
    @IInjectionService private readonly injection: IInjectionService,
    threshold: number = DEFAULT_TOKEN_THRESHOLD,
  ) {
    super();
    this.threshold = threshold;
    this._register(turn.onDidEndStep(() => this.afterStep()));
  }

  private afterStep(): void {
    if (this.context.tokenUsage() <= this.threshold) return;
    this.injection.push({ kind: 'compaction_summary', content: 'context overflow — compact pending' });
  }

  compact(_reason: string): Promise<void> {
    throw new Error('TODO: CompactionService.compact');
  }
}

registerScopedService(LifecycleScope.Agent, ICompactionService, CompactionService, InstantiationType.Delayed, 'compaction');
