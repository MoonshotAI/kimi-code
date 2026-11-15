import { ScopeActivation } from '#/_base/di/instantiation';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { ARTEX_FLAG_ID } from './artex';
import { ArtexGraphStoreProvider, IArtexGraphStoreProvider } from './store/artexGraphStoreProvider';
import { ARTEX_CONFIG_DEFAULTS, ARTEX_SECTION, ArtexConfigSchema, artexEnvBindings, stripArtexEnv } from './config/configSection';
import { ArtexOrchestrator, IArtexOrchestrator } from './engine/artexOrchestrator';
import { ArtexModeService } from './agent/artexModeService';
import { IArtexModeService } from './agent/artexMode';
import { ARTEX_PROFILES } from './profiles/artexProfiles';

export class ArtexFeature extends Feature {
  static override readonly name = 'artex';

  constructor(@IFlagService flags: IFlagService) {
    super();
    if (!flags.enabled(ARTEX_FLAG_ID)) return;
    assembledFlagServices.add(flags);
    this.onDispose(() => {
      assembledFlagServices.delete(flags);
    });
    this.contributeConfig(ARTEX_SECTION, ArtexConfigSchema, {
      defaultValue: ARTEX_CONFIG_DEFAULTS,
      env: artexEnvBindings,
      stripEnv: stripArtexEnv,
    });
    this.contributeService(LifecycleScope.App, IArtexGraphStoreProvider, ArtexGraphStoreProvider, {
      activation: ScopeActivation.OnDemand,
    });
    this.contributeService(LifecycleScope.Session, IArtexOrchestrator, ArtexOrchestrator, {
      activation: ScopeActivation.OnDemand,
    });
    this.contributeAgentService(IArtexModeService, ArtexModeService, {
      activation: ScopeActivation.OnScopeCreated,
    });
    this.contributeProfiles(ARTEX_PROFILES);
  }
}

const assembledFlagServices = new WeakSet<IFlagService>();
let assembledOverrideForTests: boolean | undefined;

export function isArtexFeatureAssembled(flags: IFlagService): boolean {
  return assembledOverrideForTests ?? assembledFlagServices.has(flags);
}

export function _setArtexFeatureAssembledForTests(value: boolean | undefined): void {
  assembledOverrideForTests = value;
}

registerFeature(ArtexFeature);
