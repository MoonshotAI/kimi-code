import { ScopeActivation } from '#/_base/di/instantiation';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { ARTEX_FLAG_ID, markArtexFeatureAssembled } from './artex';
import { ArtexGraphStoreProvider, IArtexGraphStoreProvider } from './store/artexGraphStoreProvider';
import { ArtexWorkStoreProvider, IArtexWorkStoreProvider } from './store/artexWorkStoreProvider';
import { ArtexTrafficStoreProvider, IArtexTrafficStoreProvider } from './store/artexTrafficStoreProvider';
import { ArtexTrafficRecorder, IArtexTrafficRecorder } from './traffic/artexTrafficRecorder';
import { ArtexProxyEnvContributor, IArtexProxyEnvContributor } from './traffic/artexProxyEnvContributor';
import './traffic/artexTrafficWarmup';
import { ArtexEnvScrubContributor, IArtexEnvScrubContributor } from './safety/artexEnvScrub';
import './safety/artexTargetPinCache';
import './config/configSection';
import { ArtexOrchestrator, IArtexOrchestrator } from './engine/artexOrchestrator';
import './agent/artexModeService';
import { ARTEX_PROFILES } from './profiles/artexProfiles';
import { ArtexNotificationHub, IArtexNotificationHub } from './session/artexNotificationHub';
import { ArtexSessionContext, IArtexSessionContext } from './session/artexSessionContext';
import { ArtexSessionService, IArtexSessionService } from './session/artexSessionService';
import { ArtexEgressPacer, IArtexEgressPacer } from './safety/egressPacer';
import { ArtexToolHooksService, IArtexToolHooksService } from './safety/artexToolHooks';
import { IArtexTargetResolver, SystemArtexTargetResolver } from './safety/targetResolver';
import { ARTEX_TOOL_DOMAIN, ARTEX_TOOLS } from './tools/index';

export class ArtexFeature extends Feature {
  static override readonly name = 'artex';

  constructor(@IFlagService flags: IFlagService) {
    super();
    if (!flags.enabled(ARTEX_FLAG_ID)) return;
    this.onDispose(markArtexFeatureAssembled(flags));
    this.contributeService(LifecycleScope.App, IArtexGraphStoreProvider, ArtexGraphStoreProvider, {
      activation: ScopeActivation.OnDemand,
    });
    this.contributeService(LifecycleScope.App, IArtexWorkStoreProvider, ArtexWorkStoreProvider, {
      activation: ScopeActivation.OnDemand,
    });
    this.contributeService(LifecycleScope.App, IArtexTrafficStoreProvider, ArtexTrafficStoreProvider, {
      activation: ScopeActivation.OnDemand,
    });
    this.contributeService(LifecycleScope.App, IArtexTargetResolver, SystemArtexTargetResolver, {
      activation: ScopeActivation.OnDemand,
    });
    this.contributeService(LifecycleScope.Session, IArtexSessionContext, ArtexSessionContext, {
      activation: ScopeActivation.OnScopeCreated,
    });
    this.contributeService(LifecycleScope.Session, IArtexOrchestrator, ArtexOrchestrator, {
      activation: ScopeActivation.OnDemand,
    });
    this.contributeService(LifecycleScope.Session, IArtexSessionService, ArtexSessionService, {
      activation: ScopeActivation.OnDemand,
    });
    this.contributeService(LifecycleScope.Session, IArtexNotificationHub, ArtexNotificationHub, {
      activation: ScopeActivation.OnScopeCreated,
    });
    this.contributeService(LifecycleScope.Session, IArtexEgressPacer, ArtexEgressPacer, {
      activation: ScopeActivation.OnDemand,
    });
    this.contributeService(LifecycleScope.Session, IArtexTrafficRecorder, ArtexTrafficRecorder, {
      activation: ScopeActivation.OnDemand,
    });
    this.contributeAgentService(IArtexToolHooksService, ArtexToolHooksService, {
      activation: ScopeActivation.OnScopeCreated,
    });
    this.contributeAgentService(IArtexProxyEnvContributor, ArtexProxyEnvContributor, {
      activation: ScopeActivation.OnScopeCreated,
    });
    this.contributeAgentService(IArtexEnvScrubContributor, ArtexEnvScrubContributor, {
      activation: ScopeActivation.OnScopeCreated,
    });
    this.contributeProfiles(ARTEX_PROFILES);
    for (const tool of ARTEX_TOOLS) {
      this.contributeTool(tool.id, tool.ctor, { name: tool.name, domain: ARTEX_TOOL_DOMAIN });
    }
  }
}

registerFeature(ArtexFeature);
