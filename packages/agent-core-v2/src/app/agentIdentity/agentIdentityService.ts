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
 *
 * Blank and whitespace-only values read as unset on both sides, matching what
 * the env bindings already do: without that a stray `name = ""` in the file
 * would claim an identity, rendering an empty display name into the prompt and
 * falling through slug normalization to the neutral token — silently rewriting
 * the User-Agent sent to third parties. The slug follows the explicit `slug`
 * when set and the declared name otherwise; both are normalized, since a
 * hand-written slug may still carry spaces or non-ASCII characters.
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
    return declared(this.section().name) ?? this.bootstrap.args.displayName;
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
