import { ScopeActivation } from '#/_base/di/instantiation';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { ARTEX_FLAG_ID } from './artex';
import { ArtexGraphStoreProvider, IArtexGraphStoreProvider } from './store/artexGraphStoreProvider';

export class ArtexFeature extends Feature {
  static override readonly name = 'artex';

  constructor(@IFlagService flags: IFlagService) {
    super();
    if (!flags.enabled(ARTEX_FLAG_ID)) return;
    assembledFlagServices.add(flags);
    this.onDispose(() => {
      assembledFlagServices.delete(flags);
    });
    this.contributeService(LifecycleScope.App, IArtexGraphStoreProvider, ArtexGraphStoreProvider, {
      activation: ScopeActivation.OnDemand,
    });
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
