/**
 * `agentIdentity` domain — `IAgentIdentity` implementation.
 *
 * Resolves the identity from the `[identity]` config section (which already
 * layers `env > config.toml`) over the host's declared display name in
 * `IBootstrapService.args`. Bound at App scope.
 *
 * Reads on every access rather than snapshotting: config loads asynchronously,
 * and a value frozen in the constructor would silently ignore a configured
 * identity under some startup orderings. Blank values from any source read as
 * unset, so a stray `name = ""` cannot claim an identity.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';

import { IAgentIdentity, normalizeIdentitySlug } from './agentIdentity';
import { IDENTITY_SECTION, type IdentityConfig } from './configSection';

function declared(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export class AgentIdentityService implements IAgentIdentity {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {}

  get displayName(): string | undefined {
    return declared(this.section().name) ?? declared(this.bootstrap.args.displayName);
  }

  get slug(): string | undefined {
    const section = this.section();
    const raw = declared(section.slug) ?? declared(section.name);
    return raw === undefined ? undefined : normalizeIdentitySlug(raw);
  }

  private section(): IdentityConfig {
    return this.config.get<IdentityConfig | undefined>(IDENTITY_SECTION) ?? {};
  }
}

registerScopedService(
  LifecycleScope.App,
  IAgentIdentity,
  AgentIdentityService,
  ScopeActivation.OnDemand,
  'agentIdentity',
);
