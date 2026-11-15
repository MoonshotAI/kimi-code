import { Service } from '#/_base/di/service';
import { IFlagService } from '#/app/flag/flag';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentSwarmService } from '#/features/swarm/agent/swarm';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';

import { ARTEX_FLAG_ID } from '#/features/artex/artex';

import { IArtexModeService } from './artexMode';
import { ArtexPlanningInjection } from './injection/artexInjection';

export class ArtexModeService extends Service implements IArtexModeService {
  declare readonly _serviceBrand: undefined;

  private active = false;

  constructor(
    @IAgentReminderService reminder: IAgentReminderService,
    @IAgentSwarmService private readonly swarmMode: IAgentSwarmService,
    @IAgentScopeContext private readonly agentCtx: IAgentScopeContext,
    @IFlagService private readonly flags: IFlagService,
  ) {
    super();
    this._register(new ArtexPlanningInjection({ isActive: () => this.isActive }, reminder));
  }

  enter(): void {
    if (!this.flags.enabled(ARTEX_FLAG_ID)) return;
    if (this.agentCtx.agentId !== MAIN_AGENT_ID) return;
    this.swarmMode.enter('manual');
    this.active = true;
  }

  exit(): void {
    if (!this.active) return;
    this.active = false;
    this.swarmMode.exit();
  }

  get isActive(): boolean {
    return (
      this.active &&
      this.agentCtx.agentId === MAIN_AGENT_ID &&
      this.flags.enabled(ARTEX_FLAG_ID)
    );
  }
}
