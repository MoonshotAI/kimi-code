import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { IFlagService } from '#/app/flag/flag';
import { IAgentProfileService } from '#/agent/profile/profile';
import { AgentSubprocessEnvContributions } from '#/agent/subprocessEnv/subprocessEnv';

import { ARTEX_FLAG_ID } from '#/features/artex/artex';
import { IArtexModeService } from '#/features/artex/agent/artexMode';
import { artexSafetyActive } from '#/features/artex/safety/artexSafetyScope';
import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';

import { IArtexTrafficRecorder } from './artexTrafficRecorder';

export interface IArtexProxyEnvContributor {
  readonly _serviceBrand: undefined;
}

export const IArtexProxyEnvContributor: ServiceIdentifier<IArtexProxyEnvContributor> =
  createDecorator<IArtexProxyEnvContributor>('artexProxyEnvContributor');

/**
 * Per-agent seam that routes an ARTEX agent's Bash subprocesses through the
 * session recording proxy. It contributes a subprocess-env overlay that only
 * yields proxy vars for ARTEX agents while recording is active; for every other
 * agent (and whenever recording is off or unavailable) it yields nothing, so the
 * subprocess env is untouched and nothing is ever silently treated as recorded.
 */
export class ArtexProxyEnvContributor extends Service implements IArtexProxyEnvContributor {
  declare readonly _serviceBrand: undefined;

  private cachedOverlay: Record<string, string> | undefined;

  constructor(
    @IFlagService private readonly flags: IFlagService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IArtexModeService private readonly mode: IArtexModeService,
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexTrafficRecorder private readonly recorder: IArtexTrafficRecorder,
  ) {
    super();
    void this.recorder.ensureStarted().then((state) => {
      if (state.status === 'recording') {
        this.cachedOverlay = this.recorder.proxyEnvOverlay();
      }
    });
    this.provide(AgentSubprocessEnvContributions, { overlay: () => this.overlay() });
  }

  private overlay(): Record<string, string> | undefined {
    if (!this.isArtexAgent()) return undefined;
    if (this.recorder.isRecording) {
      this.cachedOverlay = this.recorder.proxyEnvOverlay();
    } else {
      void this.recorder.ensureStarted().then((state) => {
        if (state.status === 'recording') {
          this.cachedOverlay = this.recorder.proxyEnvOverlay();
        }
      });
    }
    return this.cachedOverlay ?? this.recorder.proxyEnvOverlay();
  }

  private isArtexAgent(): boolean {
    if (!this.flags.enabled(ARTEX_FLAG_ID)) return false;
    return artexSafetyActive(this.profile.data().profileName, this.mode, this.session);
  }
}
