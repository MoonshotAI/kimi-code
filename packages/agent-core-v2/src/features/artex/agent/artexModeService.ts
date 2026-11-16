import { ref, type LiveRef } from '#/_base/di/instantiation';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { Service } from '#/_base/di/service';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { IEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { ARTEX_FLAG_ID, isArtexFeatureAssembled } from '#/features/artex/artex';
import { ARTEX_MAIN_AGENT_TOOL_NAMES } from '#/features/artex/profiles/artexProfiles';
import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';

import { type ArtexExitReason, IArtexModeService } from './artexMode';
import {
  ArtexExplorationUpdated,
  ArtexModeEnter,
  ArtexModeExit,
  artexKey,
} from './artexOps';
import { ArtexPlanningInjection } from './injection/artexInjection';

export class ArtexModeService extends Service implements IArtexModeService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentReminderService reminder: IAgentReminderService,
    @IAgentScopeContext private readonly agentCtx: IAgentScopeContext,
    @IFlagService private readonly flags: IFlagService,
    @IAgentStateService private readonly agentState: IAgentStateService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IEventBus eventBus: IEventBus,
    @ref(IArtexSessionContext) private readonly artexSession: LiveRef<IArtexSessionContext>,
  ) {
    super();
    this.agentState.contributeState(artexKey);
    this._register(new ArtexPlanningInjection({ isActive: () => this.isActive }, reminder));
    this._register(
      this.dispatcher.hooks.onDidRestore.register('artex', async (_ctx, next) => {
        this.restoreState();
        await next();
      }),
    );
    this._register(
      eventBus.subscribe(AgentStatusUpdated, () => {
        if (this.agentCtx.agentId !== MAIN_AGENT_ID || !this.isActive) return;
        this.ensureMainToolsActive();
      }),
    );
    const bindSessionSync = (): void => {
      const session = this.artexSession.current;
      if (session?.onDidChangeActiveExplorationId === undefined) return;
      this._register(
        session.onDidChangeActiveExplorationId((explorationId) => {
          if (!this.isActive) return;
          if (this.agentState.get(artexKey).explorationId === explorationId) return;
          void this.dispatcher.dispatch(
            new ArtexExplorationUpdated({ agentId: this.agentCtx.agentId, explorationId }),
          );
        }),
      );
    };
    bindSessionSync();
    this._register(this.artexSession.onDidChange(() => bindSessionSync()));
  }

  enter(explorationId?: number): void {
    if (!this.flags.enabled(ARTEX_FLAG_ID)) return;
    if (!isArtexFeatureAssembled(this.flags)) return;
    if (this.agentCtx.agentId !== MAIN_AGENT_ID) return;
    const session = this.artexSession.current;
    const resolvedId = explorationId ?? session?.getActiveExplorationId();
    if (explorationId !== undefined) {
      session?.setActiveExplorationId(explorationId);
    }
    this.activateMainTools();
    const state = this.agentState.get(artexKey);
    if (state.active && state.explorationId === resolvedId) return;
    if (state.active) {
      void this.dispatcher.dispatch(
        new ArtexExplorationUpdated({
          agentId: this.agentCtx.agentId,
          explorationId: resolvedId,
        }),
      );
      return;
    }
    void this.dispatcher.dispatch(
      new ArtexModeEnter({
        agentId: this.agentCtx.agentId,
        explorationId: resolvedId,
      }),
    );
  }

  exit(reason: ArtexExitReason = 'user'): void {
    if (!this.agentState.get(artexKey).active) return;
    this.deactivateMainTools();
    void this.dispatcher.dispatch(
      new ArtexModeExit({ agentId: this.agentCtx.agentId, reason }),
    );
  }

  get isActive(): boolean {
    return (
      this.agentCtx.agentId === MAIN_AGENT_ID &&
      this.flags.enabled(ARTEX_FLAG_ID) &&
      isArtexFeatureAssembled(this.flags) &&
      this.agentState.get(artexKey).active
    );
  }

  private restoreState(): void {
    if (this.agentCtx.agentId !== MAIN_AGENT_ID) return;
    if (!this.flags.enabled(ARTEX_FLAG_ID) || !isArtexFeatureAssembled(this.flags)) return;
    const state = this.agentState.get(artexKey);
    if (!state.active) return;
    if (state.explorationId !== undefined) {
      this.artexSession.current?.setActiveExplorationId(state.explorationId);
    }
    this.activateMainTools();
    void this.dispatcher.dispatch(
      new AgentStatusUpdated({
        agentId: this.agentCtx.agentId,
        artexMode: true,
        artexExplorationId: state.explorationId,
      }),
    );
  }

  private ensureMainToolsActive(): void {
    const active = this.loop.getActiveToolNames();
    if (active === undefined) return;
    if (ARTEX_MAIN_AGENT_TOOL_NAMES.every((name) => active.includes(name))) return;
    this.activateMainTools();
    void this.dispatcher.dispatch(
      new AgentStatusUpdated({
        agentId: this.agentCtx.agentId,
        artexMode: true,
        artexExplorationId: this.agentState.get(artexKey).explorationId,
      }),
    );
  }

  private activateMainTools(): void {
    for (const name of ARTEX_MAIN_AGENT_TOOL_NAMES) {
      this.loop.addActiveTool(name);
    }
  }

  private deactivateMainTools(): void {
    for (const name of ARTEX_MAIN_AGENT_TOOL_NAMES) {
      this.loop.removeActiveTool(name);
    }
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IArtexModeService,
  ArtexModeService,
  ScopeActivation.OnScopeCreated,
  'artexMode',
);
