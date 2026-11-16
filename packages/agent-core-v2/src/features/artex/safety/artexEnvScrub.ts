import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { IFlagService } from '#/app/flag/flag';
import { IAgentProfileService } from '#/agent/profile/profile';
import { AgentSubprocessEnvContributions } from '#/agent/subprocessEnv/subprocessEnv';

import { ARTEX_FLAG_ID } from '#/features/artex/artex';
import { IArtexModeService } from '#/features/artex/agent/artexMode';
import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';

import { artexSafetyActive } from './artexSafetyScope';

export const ARTEX_SCRUB_SECRETS_ENV = 'ARTEX_SCRUB_SECRETS';

export const ARTEX_SECRET_ENV_KEYS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'KIMI_API_KEY',
  'MOONSHOT_API_KEY',
  'ARTEX_PG_DSN',
  'ARTEX_SECRET_KEY',
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',
];

export interface IArtexEnvScrubContributor {
  readonly _serviceBrand: undefined;
}

export const IArtexEnvScrubContributor: ServiceIdentifier<IArtexEnvScrubContributor> =
  createDecorator<IArtexEnvScrubContributor>('artexEnvScrubContributor');

export class ArtexEnvScrubContributor extends Service implements IArtexEnvScrubContributor {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IFlagService private readonly flags: IFlagService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IArtexModeService private readonly mode: IArtexModeService,
    @IArtexSessionContext private readonly session: IArtexSessionContext,
  ) {
    super();
    this.provide(AgentSubprocessEnvContributions, { overlay: () => this.overlay() });
  }

  private overlay(): Record<string, string> | undefined {
    if (!this.flags.enabled(ARTEX_FLAG_ID)) return undefined;
    if (
      !artexSafetyActive(this.profile.data().profileName, this.mode, this.session)
    ) {
      return undefined;
    }
    return { [ARTEX_SCRUB_SECRETS_ENV]: '1' };
  }
}