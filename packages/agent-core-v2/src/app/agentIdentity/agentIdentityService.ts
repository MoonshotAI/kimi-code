/**
 * `agentIdentity` domain — `IAgentIdentity` implementation.
 *
 * Resolves the identity from the `[identity]` config section (which already
 * layers `env > config.toml`) over the host's declared display name in
 * `IBootstrapService.args`. Bound at App scope.
 *
 * Every value is resolved **lazily, on each read** rather than snapshotted in
 * the constructor: config loads asynchronously, so a service constructed early
 * in boot would otherwise freeze the pre-load defaults and silently ignore a
 * configured identity — a race that only shows up under particular startup
 * orderings and is near-impossible to reproduce.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';

import { IAgentIdentity, normalizeIdentitySlug } from './agentIdentity';
import { IDENTITY_SECTION, type IdentityConfig } from './configSection';

/**
 * Blank / whitespace-only values read as unset, matching what the env bindings
 * already do for `KIMI_CODE_IDENTITY_*`. Without this a stray `name = ""` in
 * `config.toml` would claim an identity: the display name would render empty
 * and the slug would fall back to the neutral token, silently rewriting the
 * User-Agent sent to third-party providers.
 */
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
    return declared(this.section().name) ?? this.bootstrap.args.displayName;
  }

  get slug(): string | undefined {
    const section = this.section();
    // A slug is claimed only when the user declared an identity at all. The
    // explicit slug wins; otherwise it derives from the declared name. Both go
    // through normalization — a user-written slug may still carry spaces or
    // non-ASCII characters.
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
