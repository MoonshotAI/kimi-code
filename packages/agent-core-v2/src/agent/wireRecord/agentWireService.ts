/**
 * `wireRecord` domain (L2), Agent scope — the `IAgentWireService` binding.
 *
 * Thin Agent-scope adapter over the scope-agnostic `WireService`: derives the
 * persistence addressing (`logScope` / `logKey`) from `IAgentScopeContext`
 * instead of receiving it as constructor options, so no per-agent scope seed
 * is required. `WireService` itself stays scope-agnostic; a future
 * Session-scope wire binds the same way.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IEventBus } from '#/app/event/eventBus';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAgentWireService } from '#/wire/tokens';
import { WireService } from '#/wire/wireServiceImpl';

import { WIRE_RECORD_FILENAME } from './wireRecordService';

export class AgentWireService extends WireService {
  constructor(
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAppendLogStore log?: IAppendLogStore,
    @IAgentBlobService blobService?: IAgentBlobService,
    @IEventBus eventBus?: IEventBus,
  ) {
    super(
      { logScope: scopeContext.scope(), logKey: WIRE_RECORD_FILENAME },
      log,
      blobService,
      eventBus,
    );
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentWireService,
  AgentWireService,
  InstantiationType.Delayed,
  'wireRecord',
);
