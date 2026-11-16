import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { IFlagService } from '#/app/flag/flag';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';

import { ARTEX_FLAG_ID } from '#/features/artex/artex';
import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';

import { IArtexTrafficRecorder } from './artexTrafficRecorder';

export interface IArtexTrafficWarmup {
  readonly _serviceBrand: undefined;
}

export const IArtexTrafficWarmup: ServiceIdentifier<IArtexTrafficWarmup> =
  createDecorator<IArtexTrafficWarmup>('artexTrafficWarmup');

/**
 * Pre-starts the session recording proxy whenever an exploration is active so the
 * first Bash subprocess never races ahead of ensureStarted().
 */
export class ArtexTrafficWarmup extends Disposable implements IArtexTrafficWarmup {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IFlagService private readonly flags: IFlagService,
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexTrafficRecorder private readonly recorder: IArtexTrafficRecorder,
  ) {
    super();
    if (!this.flags.enabled(ARTEX_FLAG_ID)) return;
    if (this.session.getActiveExplorationId() !== undefined) {
      void this.recorder.ensureStarted();
    }
    if (this.session.onDidChangeActiveExplorationId !== undefined) {
      this._register(
        this.session.onDidChangeActiveExplorationId((explorationId) => {
          if (explorationId === undefined) return;
          void this.recorder.ensureStarted();
        }),
      );
    }
  }
}

registerScopedService(
  LifecycleScope.Session,
  IArtexTrafficWarmup,
  ArtexTrafficWarmup,
  ScopeActivation.OnScopeCreated,
  'artexTrafficWarmup',
);