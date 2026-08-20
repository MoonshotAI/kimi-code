import { Service } from '#/_base/di/service';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { inputTotal } from '#/kosong/contract/usage';
import { IModelCatalog } from '#/kosong/model/catalog';

import { IAgentCacheProbeService } from './cacheProbe';
import { IAgentUsageService, type UsageRecordedContext } from './usage';

export class AgentCacheProbeService extends Service implements IAgentCacheProbeService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentUsageService usage: IAgentUsageService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IModelCatalog private readonly models: IModelCatalog,
  ) {
    super();
    if (scopeContext.forkedFrom === undefined) return;
    this._register(usage.onDidRecord((e) => this.probe(e)));
  }

  private probe(e: UsageRecordedContext): void {
    if (!e.firstRecord || e.source?.type !== 'turn') return;
    let providerType: string | undefined;
    let protocol: string | undefined;
    try {
      const model = this.models.get(e.model);
      providerType = model.providerType ?? model.protocol;
      protocol = model.protocol;
    } catch { }
    this.telemetry.track2('prompt_cache_probe', {
      source: 'fork',
      turn_id: e.source.turnId,
      provider_type: providerType,
      protocol,
      input_tokens: inputTotal(e.usage),
      input_cache_read: e.usage.inputCacheRead,
      input_cache_creation: e.usage.inputCacheCreation,
      output_tokens: e.usage.output,
    });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentCacheProbeService,
  AgentCacheProbeService,
  ScopeActivation.OnScopeCreated,
  'cacheProbe',
);
